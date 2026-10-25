import { api } from './api'

/**
 * Web Push, from the browser's side.
 *
 * Every step here can fail for a reason the user cannot guess at, so the
 * failure modes are enumerated as values rather than thrown: "your phone is on
 * http and this needs https" is the single most likely outcome of pressing the
 * button, and it deserves a sentence, not an error toast.
 */
export type PushAvailability =
  | {
      kind: 'ready'
      /** base64url uncompressed point, straight from the server. */
      publicKey: string
      /** The existing subscription, when this browser already has one. */
      subscription: PushSubscription | null
      /** Live subscriptions across all devices. */
      devices: number
      /** True when the existing subscription is against a different key. */
      staleKey: boolean
    }
  /** Not a secure context. Web Push simply does not exist over plain http. */
  | { kind: 'insecure' }
  /** No service worker, no PushManager, or a development build with no worker. */
  | { kind: 'unsupported' }
  /** Switched off in config, or the server could not produce a key. */
  | { kind: 'server-off' }
  /** The notification feature itself is off, so there is nothing to subscribe to. */
  | { kind: 'disabled' }

/** `serviceWorker.ready` never settles where there is no worker, so bound it. */
const REGISTRATION_TIMEOUT_MS = 5_000

/**
 * `atob` because there is no base64url decoder in the web platform yet —
 * `Uint8Array.fromBase64` is still landing — and the padding has to be put
 * back, since base64url is defined without it.
 *
 * The return type is spelled out: `applicationServerKey` wants a buffer backed
 * by a plain `ArrayBuffer`, and the inferred type is the wider
 * `ArrayBufferLike`, which `SharedArrayBuffer` also satisfies.
 */
function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** The same comparison the server makes, from the other end. */
function sameKey(existing: ArrayBuffer | null, expected: string): boolean {
  if (existing === null) return false
  const bytes = new Uint8Array(existing)
  const wanted = decodeBase64Url(expected)
  if (bytes.length !== wanted.length) return false
  return bytes.every((byte, index) => byte === wanted[index])
}

async function activeRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null

  // `ready` resolves only once a worker is active and controlling. In a
  // development build nothing is ever registered, so it would hang forever —
  // hence the race, which turns "not yet" into "no".
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), REGISTRATION_TIMEOUT_MS)
  })
  const registration = await Promise.race([navigator.serviceWorker.ready, timeout]).catch(() => null)
  if (registration !== null) return registration

  return (await navigator.serviceWorker.getRegistration()) ?? null
}

export async function pushAvailability(): Promise<PushAvailability> {
  let status
  try {
    status = await api.notificationStatus()
  } catch {
    return { kind: 'server-off' }
  }
  if (!status.enabled) return { kind: 'disabled' }
  if (!status.push || status.publicKey === null) return { kind: 'server-off' }

  // Checked before the API checks, and deliberately: `PushManager` is absent
  // in an insecure context, so a browser test would report "unsupported" and
  // send the user looking for a browser problem instead of a certificate one.
  if (!window.isSecureContext) return { kind: 'insecure' }
  if (!('PushManager' in window)) return { kind: 'unsupported' }

  const registration = await activeRegistration()
  if (registration === null) return { kind: 'unsupported' }

  const subscription = await registration.pushManager.getSubscription()
  return {
    kind: 'ready',
    publicKey: status.publicKey,
    subscription,
    devices: status.subscriptions,
    staleKey: subscription !== null && !sameKey(subscription.options.applicationServerKey, status.publicKey),
  }
}

/**
 * Subscribes and registers the result with the server.
 *
 * Must be called from a user gesture: the permission prompt is refused
 * otherwise, and iOS is strict about it.
 */
export async function subscribeToPush(availability: PushAvailability): Promise<number> {
  if (availability.kind !== 'ready') throw new Error('推送在这个环境里不可用')

  const registration = await activeRegistration()
  if (registration === null) throw new Error('Service Worker 还没就绪，刷新页面再试')

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('浏览器拒绝了通知权限')

  // A subscription made against a previous key cannot be delivered to, and
  // subscribing again over the top of it just returns the old one.
  let existing = await registration.pushManager.getSubscription()
  if (existing !== null && !sameKey(existing.options.applicationServerKey, availability.publicKey)) {
    await existing.unsubscribe()
    existing = null
  }

  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      // Chrome refuses anything else, and the spec requires it: every push
      // must result in something the user can see.
      userVisibleOnly: true,
      applicationServerKey: decodeBase64Url(availability.publicKey),
    }))

  const json = subscription.toJSON()
  if (json.endpoint === undefined || json.keys?.p256dh === undefined || json.keys.auth === undefined) {
    throw new Error('浏览器返回的订阅信息不完整')
  }

  const result = await api.subscribePush({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  })
  return result.subscriptions
}

export async function unsubscribeFromPush(): Promise<number> {
  const registration = await activeRegistration()
  const subscription = (await registration?.pushManager.getSubscription()) ?? null

  // Told to the server first: if this throws, the browser keeps its
  // subscription and the UI stays consistent with what the server believes.
  // The other order leaves a server that keeps pushing to a subscription the
  // browser has already dropped.
  if (subscription !== null) {
    const result = await api.unsubscribePush(subscription.endpoint)
    await subscription.unsubscribe()
    return result.subscriptions
  }
  return 0
}
