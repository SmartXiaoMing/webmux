import {
  createCipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto'
import { SignJWT, importJWK, type JWK } from 'jose'
import type { NotificationRecord, NotifyLevel, PushPayload } from '@webmux/shared'
import { getSetting, setSetting, type DB } from '../db/index'
import { logger } from '../logger'
import type { PushService } from './hub'
import type { NewSubscription, PushSubscriptionRow, PushSubscriptionStore } from './store'

const log = logger.child('push')

/** Where the sender key pair lives. One per installation, like every other secret. */
const VAPID_SETTING_KEY = 'notify.vapid_private'

/**
 * The `sub` claim's fallback, and the reason the RFC requires one at all:
 * a push service with a misbehaving sender needs someone to contact. It is
 * never used for mail, and it is configurable because some services reject
 * addresses they consider implausible.
 */
const DEFAULT_SUBJECT = 'mailto:webmux@localhost'

/** How long a signed VAPID token is valid. The RFC caps the window at 24h. */
const VAPID_TOKEN_TTL_SECONDS = 12 * 60 * 60

/** Push services are allowed to hold a message this long when the device is away. */
const TTL_SECONDS = 24 * 60 * 60

/** Bounded and short: an unreachable push service must not hold a publish open. */
const REQUEST_TIMEOUT_MS = 10_000

/** How many deliveries are in flight at once. */
const DELIVERY_CONCURRENCY = 4

/**
 * How much of a notification body a push message carries.
 *
 * The record is 4096 bytes, and the encrypted payload has to fit inside it
 * along with the JSON envelope and the 16-byte tag — roughly 4079 bytes, with
 * a CJK character costing three.
 *
 * A body is allowed to be 4000 *code points*, which is up to 12 KB, so a long
 * build log would make the encryption throw. That failure is not the
 * subscription's fault, but it happens in the delivery path — and five of them
 * would retire a perfectly healthy device, silently, with the browser given no
 * reason to re-subscribe. So the body is trimmed here instead of being allowed
 * to fail: 600 code points is far more than a lock screen shows.
 */
const PUSH_BODY_MAX = 600

function truncateForPush(body: string | null): string | null {
  if (body === null) return null
  const points = Array.from(body)
  return points.length <= PUSH_BODY_MAX ? body : `${points.slice(0, PUSH_BODY_MAX).join('')}…`
}

// ---------------------------------------------------------------------------
// Key formats
// ---------------------------------------------------------------------------

/*
 * DER prefixes for a P-256 key in the two shapes Node will not build for us.
 *
 * A web push subscription hands over a bare uncompressed point (65 bytes,
 * `0x04 || x || y`) and an ephemeral key is most naturally handled as a bare
 * scalar, so both directions need wrapping into — or unwrapping out of — the
 * DER that `createPublicKey`/`createPrivateKey` insist on. Writing the
 * prefixes out is less clever than reaching for an ASN.1 library and much
 * easier to check by eye.
 */
const SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex')
const PKCS8_PREFIX = Buffer.from(
  '3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420',
  'hex',
)

const UNCOMPRESSED_POINT_BYTES = 65
const PUBLIC_KEY_BYTES = 65
const PRIVATE_KEY_BYTES = 32
const AUTH_SECRET_BYTES = 16
const SALT_BYTES = 16

export function publicKeyFromPoint(point: Buffer): KeyObject {
  if (point.length !== UNCOMPRESSED_POINT_BYTES || point[0] !== 0x04) {
    throw new Error('expected a 65-byte uncompressed P-256 point')
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, point]),
    format: 'der',
    type: 'spki',
  })
}

function privateKeyFromScalar(scalar: Buffer): KeyObject {
  if (scalar.length !== PRIVATE_KEY_BYTES) throw new Error('expected a 32-byte P-256 scalar')
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, scalar]),
    format: 'der',
    type: 'pkcs8',
  })
}

/** The uncompressed point out of an SPKI DER, which is always its last 65 bytes. */
function pointFromPublicKey(key: KeyObject): Buffer {
  const der = key.export({ format: 'der', type: 'spki' })
  return der.subarray(der.length - PUBLIC_KEY_BYTES)
}

// ---------------------------------------------------------------------------
// RFC 8291: aes128gcm payload encryption
// ---------------------------------------------------------------------------

export interface EncryptOptions {
  plaintext: Buffer
  /** The subscription's `p256dh`: a 65-byte uncompressed point. */
  uaPublic: Buffer
  /** The subscription's `auth`, 16 bytes. */
  authSecret: Buffer
  /**
   * Ephemeral private key as a raw 32-byte scalar. Generated per message when
   * omitted — and required by the test that checks this implementation against
   * the RFC's worked example, which is the only reason it is a parameter at
   * all. Without it there would be no way to assert on the output bytes.
   */
  asPrivate?: Buffer
  /** 16 bytes. Generated per message when omitted. */
  salt?: Buffer
  /** The `rs` field. One record is all a notification ever needs. */
  recordSize?: number
}

/**
 * Encrypts one push message, returning the complete request body: the
 * aes128gcm header followed by a single encrypted record.
 *
 * The construction, from RFC 8291 with the frame format of RFC 8188:
 *
 *   IKM   = HKDF(auth_secret, ECDH(as_private, ua_public),
 *                "WebPush: info\0" || ua_public || as_public)
 *   CEK   = HKDF(salt, IKM, "Content-Encoding: aes128gcm\0", 16)
 *   NONCE = HKDF(salt, IKM, "Content-Encoding: nonce\0", 12)
 *   body  = salt || rs || 65 || as_public || AES128GCM(CEK, NONCE, plaintext || 0x02)
 *
 * The `0x02` is the padding delimiter that marks the final record; the header
 * is its own associated data.
 *
 * Written here rather than pulled in as a dependency, against a published test
 * vector, and the failure mode if it is ever wrong is loud: the push service
 * answers, and the browser rejects the payload it cannot decrypt. It is not a
 * path that can leak anything — the message is encrypted *to* a key only the
 * subscriber holds.
 */
export interface DerivedKeys {
  /** The ephemeral public key, which travels in the header. */
  asPublic: Buffer
  /** The HKDF output the two encryption keys are drawn from. */
  ikm: Buffer
  cek: Buffer
  nonce: Buffer
}

/**
 * The key schedule, split out so it can be asserted step by step.
 *
 * RFC 8291's worked example publishes the intermediate values as well as the
 * final ciphertext, and checking them in order turns "the bytes do not match"
 * into "the second HKDF is wrong" — which is the difference between a five
 * minute fix and an afternoon.
 */
export function derivePushKeys(input: {
  uaPublic: Buffer
  authSecret: Buffer
  asPrivate?: Buffer
  salt: Buffer
}): DerivedKeys {
  const { uaPublic, authSecret, salt } = input
  if (salt.length !== SALT_BYTES) throw new Error('salt must be 16 bytes')
  if (authSecret.length !== AUTH_SECRET_BYTES) throw new Error('auth secret must be 16 bytes')

  const asPrivateKey =
    input.asPrivate !== undefined
      ? privateKeyFromScalar(input.asPrivate)
      : generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
  const asPublic = pointFromPublicKey(createPublicKey(asPrivateKey))

  const ecdhSecret = diffieHellman({ privateKey: asPrivateKey, publicKey: publicKeyFromPoint(uaPublic) })

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32))
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16),
  )
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12),
  )

  return { asPublic, ikm, cek, nonce }
}

export function encryptPushPayload(options: EncryptOptions): Buffer {
  const { plaintext, uaPublic, authSecret } = options
  const recordSize = options.recordSize ?? 4096
  const salt = options.salt ?? randomBytes(SALT_BYTES)

  const { asPublic, cek, nonce } = derivePushKeys({
    uaPublic,
    authSecret,
    salt,
    ...(options.asPrivate !== undefined ? { asPrivate: options.asPrivate } : {}),
  })

  const header = Buffer.concat([
    salt,
    (() => {
      const size = Buffer.alloc(4)
      size.writeUInt32BE(recordSize)
      return size
    })(),
    Buffer.from([asPublic.length]),
    asPublic,
  ])

  // The padding delimiter terminates the record and is part of the plaintext,
  // so it is authenticated along with everything else.
  const record = Buffer.concat([plaintext, Buffer.from([0x02])])
  if (record.length + 16 > recordSize) {
    throw new Error(`payload exceeds the record size (${record.length} bytes)`)
  }

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  cipher.setAAD(header)
  const body = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()])

  return Buffer.concat([header, body])
}

// ---------------------------------------------------------------------------
// RFC 8292: VAPID
// ---------------------------------------------------------------------------

export interface VapidKeys {
  /** Raw 32-byte scalar. */
  privateKey: Buffer
  /** Uncompressed point, 65 bytes. */
  publicKey: Buffer
  /** The same point, base64url — what the browser needs as `applicationServerKey`. */
  publicKeyBase64: string
}

function keysFromScalar(scalar: Buffer): VapidKeys {
  const privateKeyObject = privateKeyFromScalar(scalar)
  const publicKey = pointFromPublicKey(createPublicKey(privateKeyObject))
  return { privateKey: scalar, publicKey, publicKeyBase64: publicKey.toString('base64url') }
}

/**
 * The sender key pair, generated once and kept.
 *
 * It has to be stable: a subscription is bound to the key it was created
 * against, and a new key makes every existing subscription undeliverable —
 * which is why `removeForOtherKey` exists and why the client is told the
 * public key rather than hard-coding anything.
 */
export function getOrCreateVapidKeys(db: DB): VapidKeys {
  const stored = getSetting(db, VAPID_SETTING_KEY)
  if (stored !== null) {
    try {
      return keysFromScalar(Buffer.from(stored, 'base64url'))
    } catch (err) {
      // Unreadable is worse than lost: everything signed with it would be
      // rejected in ways that look like a client bug. Generate a new one and
      // let the subscriptions be replaced.
      log.warn(`stored VAPID key is unusable (${(err as Error).message}); generating a new one`)
    }
  }

  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' }) as JWK
  if (typeof jwk.d !== 'string') throw new Error('generated key has no private component')

  const keys = keysFromScalar(Buffer.from(jwk.d, 'base64url'))
  setSetting(db, VAPID_SETTING_KEY, keys.privateKey.toString('base64url'))
  return keys
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface WebPushOptions {
  store: PushSubscriptionStore
  keys: VapidKeys
  subject?: string
  /** Injectable transport, so a test can point deliveries at its own server. */
  fetchImpl?: typeof fetch
}

export class WebPushService implements PushService {
  readonly publicKey: string
  private readonly store: PushSubscriptionStore
  private readonly keys: VapidKeys
  private readonly subject: string
  private readonly fetch: typeof fetch
  /** Signed tokens, by push-service origin. They are valid for hours. */
  private readonly tokens = new Map<string, { value: string; expiresAt: number }>()

  constructor(options: WebPushOptions) {
    this.store = options.store
    this.keys = options.keys
    this.subject = options.subject ?? DEFAULT_SUBJECT
    this.fetch = options.fetchImpl ?? fetch
    this.publicKey = options.keys.publicKeyBase64
  }

  count(): number {
    return this.store.countLive()
  }

  /**
   * Stores a subscription after checking it is one we could deliver to.
   *
   * The endpoint is a URL the server will later POST to, which makes it an
   * SSRF surface — and the only party who can supply it is an authenticated
   * one, so this is about not being a confused deputy rather than about
   * attackers. https only, with loopback http allowed so that a test can run a
   * push service of its own.
   */
  subscribe(input: Omit<NewSubscription, 'vapidPublic'>): void {
    const url = new URL(input.endpoint)
    const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw new Error('push endpoint must be an https URL')
    }

    const p256dh = Buffer.from(input.p256dh, 'base64url')
    if (p256dh.length !== UNCOMPRESSED_POINT_BYTES || p256dh[0] !== 0x04) {
      throw new Error('p256dh must be a 65-byte uncompressed P-256 point')
    }
    const auth = Buffer.from(input.auth, 'base64url')
    if (auth.length !== AUTH_SECRET_BYTES) throw new Error('auth must be 16 bytes')

    // Fail here rather than on the first delivery, so a browser that hands
    // over something unusable finds out while it still has a user watching.
    publicKeyFromPoint(p256dh)

    this.store.save({ ...input, vapidPublic: this.publicKey })
  }

  unsubscribe(endpoint: string): number {
    return this.store.remove(endpoint)
  }

  async send(notification: NotificationRecord, unread: number, tag: string | undefined): Promise<void> {
    // Before listing, not after: a subscription created against a previous
    // VAPID key is undeliverable, and clearing it here means the client
    // re-subscribes on its next visit instead of the server retrying forever
    // against a push service that answers 403.
    const stale = this.store.removeForOtherKey(this.publicKey)
    if (stale > 0) log.info(`dropped ${stale} subscription(s) from a previous key`)

    const subscriptions = this.store.listLive()
    if (subscriptions.length === 0) return

    const payload: PushPayload = {
      id: notification.id,
      title: notification.title,
      body: truncateForPush(notification.body),
      level: notification.level,
      sessionId: notification.sessionId,
      unread,
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const topic = sanitizeTopic(tag)

    await runBounded(subscriptions, DELIVERY_CONCURRENCY, async (subscription) => {
      await this.deliver(subscription, body, topic, notification.level)
    })
  }

  private async deliver(
    subscription: PushSubscriptionRow,
    plaintext: Buffer,
    topic: string | null,
    level: NotifyLevel,
  ): Promise<void> {
    const { endpoint } = subscription
    try {
      let encrypted: Buffer
      try {
        encrypted = encryptPushPayload({
          plaintext,
          uaPublic: Buffer.from(subscription.p256dh, 'base64url'),
          authSecret: Buffer.from(subscription.auth, 'base64url'),
        })
      } catch (err) {
        // Never the subscription's fault — the payload is ours. The trim in
        // `send` should make this unreachable; if it is ever reached, dropping
        // this one message is the right answer, because charging it to the row
        // would retire a working device over a message that was too long.
        log.warn(`dropping a payload that would not encrypt: ${(err as Error).message}`)
        return
      }

      const headers: Record<string, string> = {
        authorization: `vapid t=${await this.tokenFor(endpoint)},k=${this.publicKey}`,
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        // Required: without it some push services reject the request outright.
        ttl: String(TTL_SECONDS),
        urgency: level === 'error' ? 'high' : 'normal',
      }
      if (topic !== null) headers.topic = topic

      const response = await this.fetch(endpoint, {
        method: 'POST',
        headers,
        // A copy, typed as what `fetch` accepts. Passing the Buffer's
        // underlying `.buffer` would be faster and wrong: Node pools small
        // allocations, so that ArrayBuffer holds other people's bytes too.
        body: new Uint8Array(encrypted),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })

      if (response.ok) {
        this.store.recordSuccess(endpoint)
        return
      }

      // The only answer that says anything about the subscription itself.
      if (response.status === 404 || response.status === 410) {
        log.debug(`push subscription expired, dropping: ${endpoint.slice(0, 60)}`)
        this.store.remove(endpoint)
        return
      }

      // Everything else is either our problem or a passing one, and neither
      // says the device is gone. Charging these to the row is how a healthy
      // subscription gets retired: five 429s during a burst, or five 403s
      // while a VAPID misconfiguration is being sorted out, would disable it
      // permanently — and the browser has no reason to ever re-subscribe.
      if (response.status === 401 || response.status === 403) {
        log.warn(`push service rejected our credentials (HTTP ${response.status})`)
      } else if (response.status === 413) {
        log.warn('push payload too large; dropping this message only')
      } else {
        log.debug(`push delivery failed: HTTP ${response.status}`)
      }
    } catch (err) {
      // Reachable only when the endpoint cannot be contacted at all — which is
      // the one condition that does suggest the subscription is dead, and the
      // one `failures` counts. A blip costs four of them; the counter resets
      // on the next success.
      this.store.recordFailure(endpoint)
      log.debug(`push delivery threw: ${(err as Error).message}`)
    }
  }

  /**
   * A signed VAPID token for the push service's origin, cached until it is
   * close to expiry. Signing is cheap, but it is per-origin and per-message,
   * and the token is valid for hours.
   */
  private async tokenFor(endpoint: string): Promise<string> {
    const origin = new URL(endpoint).origin
    const cached = this.tokens.get(origin)
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value

    // ES256 over the same key the `k=` parameter advertises. The audience is
    // the push service's origin, which is what stops one service from
    // replaying a token signed for another.
    const key = await importJWK(
      {
        kty: 'EC',
        crv: 'P-256',
        x: this.keys.publicKey.subarray(1, 33).toString('base64url'),
        y: this.keys.publicKey.subarray(33, PUBLIC_KEY_BYTES).toString('base64url'),
        d: this.keys.privateKey.toString('base64url'),
      },
      'ES256',
    )

    const expiresAt = Date.now() + VAPID_TOKEN_TTL_SECONDS * 1000
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
      .setAudience(origin)
      .setSubject(this.subject)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt / 1000))
      .sign(key)

    // Refreshed a minute early: a token that expires in flight is a delivery
    // that fails for a reason nobody will enjoy debugging.
    this.tokens.set(origin, { value: token, expiresAt: expiresAt - 60_000 })
    return token
  }
}

/** RFC 8030 allows 32 characters from the base64url alphabet, and nothing else. */
function sanitizeTopic(tag: string | undefined): string | null {
  if (tag === undefined) return null
  const cleaned = tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
  return cleaned === '' ? null : cleaned
}

/** Runs `task` over `items`, at most `limit` at a time, and never rejects. */
async function runBounded<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      const item = items[index]
      if (item === undefined) return
      try {
        await task(item)
      } catch (err) {
        log.debug(`push worker caught: ${(err as Error).message}`)
      }
    }
  })
  await Promise.all(workers)
}
