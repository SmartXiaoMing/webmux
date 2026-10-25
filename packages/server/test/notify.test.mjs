/**
 * Unit tests for the notification subsystem.
 *
 * Real database, no server. The parts worth pinning here are the ones with no
 * visible symptom when they go wrong: a sweep that quietly deletes unread
 * notifications, a rate limiter that counts the requests it refuses, a fan-out
 * that a single dead socket can take down. The HTTP surface, including the
 * local-only gates, is covered against a live server in notify.e2e.mjs.
 */
import { after, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildNotifyAllowList, parseCidr } from '../src/config.ts'
import { openDatabase } from '../src/db/index.ts'
import { NotificationHub } from '../src/notify/hub.ts'
import { localOnlyRejection, tokenMatches } from '../src/notify/local-only.ts'
import { NotificationStore, PUSH_FAILURE_LIMIT, PushSubscriptionStore } from '../src/notify/store.ts'
import { cleanBody, cleanTitle } from '../src/notify/text.ts'
import {
  WebPushService,
  derivePushKeys,
  encryptPushPayload,
  getOrCreateVapidKeys,
  publicKeyFromPoint,
} from '../src/notify/webpush.ts'
import { decryptPushBody, subscriptionKeys } from './webpush.helpers.mjs'

const dir = mkdtempSync(path.join(tmpdir(), 'webmux-notify-'))
const db = openDatabase(dir)

after(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  db.exec('DELETE FROM notifications')
  db.exec('DELETE FROM push_subscriptions')
  // Not something the application ever does: sqlite_sequence is what
  // AUTOINCREMENT counts from, and it deliberately survives a DELETE. Resetting
  // it here only makes ids predictable per test.
  db.exec("DELETE FROM sqlite_sequence WHERE name = 'notifications'")
})

function notifyConfig(overrides = {}) {
  return {
    enabled: true,
    retentionDays: 30,
    maxStored: 5,
    perMinute: 3,
    allowFrom: [],
    push: { enabled: false, subject: 'mailto:webmux@localhost' },
    ...overrides,
  }
}

/**
 * Builds a string from code points.
 *
 * The characters this file is about are invisible, and writing them literally
 * would make the tests as unreviewable as the condition they exist to
 * describe: in a diff, and in a terminal, a lone U+202E is indistinguishable
 * from a typo. Spelled as numbers, every case states which code point it
 * means, and a reader can look it up.
 */
const cp = (...codes) => String.fromCodePoint(...codes)

/** Only the fields the guard reads; the rest of Fastify is not its business. */
function fakeRequest({ remoteAddress, headers = {} }) {
  return { headers, socket: { remoteAddress } }
}

describe('notification text cleaning', () => {
  it('strips terminal escapes and control characters', () => {
    assert.equal(cleanTitle('a\u0007b\u001bc'), 'abc')
    assert.equal(cleanTitle('\u001b[31mfailed\u001b[0m'), '[31mfailed[0m')
  })

  it('strips the characters that let text lie about itself', () => {
    // The bidi override is the one that matters: it can display "gnp.exe" where
    // the bytes say "exe.png", which is a phishing primitive anywhere the text
    // is rendered as a filename or a link.
    assert.equal(cleanTitle(`invoice${cp(0x202e)}gnp.exe`), 'invoicegnp.exe')
    assert.equal(cleanTitle(`he${cp(0x200b)}llo`), 'hello')
    assert.equal(cleanTitle(`he${cp(0xfeff)}llo`), 'hello')
    // Line and paragraph separators are not newlines, but they break the
    // single-line assumption in every renderer that does not know them.
    assert.equal(cleanTitle(`a${cp(0x2028)}b${cp(0x2029)}c`), 'abc')
  })

  it('collapses a title to one line but keeps newlines in a body', () => {
    assert.equal(cleanTitle('line one\nline two'), 'line one line two')
    assert.equal(cleanBody('l1\r\nl2\n\n\n\nl3'), 'l1\nl2\n\nl3')
  })

  it('treats a body of nothing but whitespace as absent', () => {
    assert.equal(cleanBody('   \u0000 '), null)
    assert.equal(cleanBody(undefined), null)
  })

  it('truncates by code point, so no surrogate pair is cut in half', () => {
    // 300 emoji, each one a surrogate pair. Slicing by UTF-16 unit would leave
    // a lone surrogate on the end — a replacement character in every renderer.
    const cleaned = cleanTitle('\u{1F600}'.repeat(300))
    const points = Array.from(cleaned)
    assert.equal(points.length, 201)
    assert.equal(points.at(-1), '…')
    assert.equal(cleaned.includes('�'), false)
  })
})

describe('notification store', () => {
  it('applies migration 5', () => {
    // `>=`, for the same reason as the quick-key store's: this asserts that
    // the migration creating these tables ran, not that no later one exists.
    assert.ok(db.pragma('user_version', { simple: true }) >= 5)
  })

  it('assigns ids that keep increasing, and reports the cursor', () => {
    const store = new NotificationStore(db)
    assert.equal(store.latestId(), 0)
    assert.equal(store.oldestId(), null)

    const first = store.insert({ title: 'a', body: null, level: 'info', sessionId: null, source: null })
    const second = store.insert({ title: 'b', body: null, level: 'warn', sessionId: null, source: null })

    assert.ok(second.id > first.id)
    assert.equal(store.latestId(), second.id)
    assert.equal(store.oldestId(), first.id)
    assert.equal(store.unreadCount(), 2)
  })

  it('lists newest first, and can filter by cursor or unread state', () => {
    const store = new NotificationStore(db)
    const a = store.insert({ title: 'a', body: null, level: 'info', sessionId: null, source: null })
    const b = store.insert({ title: 'b', body: null, level: 'info', sessionId: null, source: null })
    const c = store.insert({ title: 'c', body: null, level: 'info', sessionId: null, source: null })

    assert.deepEqual(
      store.list(10).map((n) => n.title),
      ['c', 'b', 'a'],
    )
    assert.deepEqual(
      store.list(10, { since: a.id }).map((n) => n.title),
      ['c', 'b'],
    )

    store.markRead({ ids: [b.id] })
    assert.deepEqual(
      store.list(10, { unreadOnly: true }).map((n) => n.title),
      ['c', 'a'],
    )
    assert.equal(store.list(10).find((n) => n.id === c.id).read, false)
  })

  it('marks read by id, by cursor, or entirely', () => {
    const store = new NotificationStore(db)
    const ids = ['a', 'b', 'c', 'd'].map(
      (title) =>
        store.insert({ title, body: null, level: 'info', sessionId: null, source: null }).id,
    )

    // `upTo` is the cursor that gets broadcast, and marking specific ids
    // produces no cursor at all — reporting the highest id marked would have
    // every other tab mark everything below it read too.
    let result = store.markRead({ ids: [ids[0]] })
    assert.deepEqual(result, { unread: 3, upTo: 0 })
    assert.equal(store.list(10).filter((n) => n.read).length, 1)

    result = store.markRead({ upTo: ids[2] })
    assert.deepEqual(result, { unread: 1, upTo: ids[2] })

    result = store.markRead({ all: true })
    assert.equal(result.unread, 0)
    assert.equal(result.upTo, ids[3])

    // Idempotent: marking read twice does not move the count.
    assert.equal(store.markRead({ all: true }).unread, 0)
  })

  it('marks read only, never unread', () => {
    const store = new NotificationStore(db)
    const a = store.insert({ title: 'a', body: null, level: 'info', sessionId: null, source: null })
    store.markRead({ all: true })
    store.insert({ title: 'b', body: null, level: 'info', sessionId: null, source: null })

    // The route only ever sets read_at, so a notification cannot come back
    // unread once seen — but a client that never read `a` must not have it
    // silently flipped by a later request either.
    assert.equal(store.list(10).find((n) => n.id === a.id).read, true)
  })

  it('sweeps by age, but keeps unread notifications', () => {
    const store = new NotificationStore(db)
    const old = db.prepare(
      'INSERT INTO notifications (created_at, title, level) VALUES (?, ?, ?)',
    )
    const ancient = Date.now() - 90 * 86_400_000
    old.run(ancient, 'ancient read', 'info')
    old.run(ancient, 'ancient unread', 'info')
    const rows = store.list(10)
    store.markRead({ ids: [rows.find((r) => r.title === 'ancient read').id] })

    store.sweep(30, 500)

    // The failed build you were away for is the whole point of the feature;
    // expiring it because you were away for longer would defeat it.
    assert.deepEqual(
      store.list(10).map((n) => n.title),
      ['ancient unread'],
    )
  })

  it('sweeps down to maxStored, least recently seen first', () => {
    const store = new NotificationStore(db)
    for (let i = 0; i < 8; i += 1) {
      store.insert({ title: `n${i}`, body: null, level: 'info', sessionId: null, source: null })
    }
    store.sweep(3650, 5)

    const kept = store.list(10)
    assert.equal(kept.length, 5)
    assert.deepEqual(
      kept.map((n) => n.title),
      ['n7', 'n6', 'n5', 'n4', 'n3'],
    )
  })

  it('never reuses an id, even after everything before it is pruned', () => {
    const store = new NotificationStore(db)
    for (let i = 0; i < 4; i += 1) {
      store.insert({ title: `n${i}`, body: null, level: 'info', sessionId: null, source: null })
    }
    const highest = store.latestId()
    store.markRead({ all: true })
    store.sweep(3650, 1)

    // This is what the cursor protocol rests on. A client that has seen id 4
    // reports it back on reconnect; if a later notification could take id 5
    // after the row that held it was deleted, the client would treat the new
    // one as already seen and skip it. AUTOINCREMENT is the difference between
    // the two behaviours, which is why the column says so explicitly.
    const fresh = store.insert({ title: 'after the prune', body: null, level: 'info', sessionId: null, source: null })
    assert.ok(fresh.id > highest, `${fresh.id} should be above ${highest}`)
  })

  it('still bounds unread rows, so an instance nobody opens cannot grow forever', () => {
    const store = new NotificationStore(db)
    for (let i = 0; i < 8; i += 1) {
      store.insert({ title: `n${i}`, body: null, level: 'info', sessionId: null, source: null })
    }
    store.sweep(3650, 5)

    assert.equal(store.unreadCount(), 5)
  })
})

describe('push subscription store', () => {
  const base = { endpoint: 'https://push.example/1', p256dh: 'a', auth: 'b', ua: 'test', vapidPublic: 'k1' }

  it('refreshes an existing endpoint instead of failing on it', () => {
    const store = new PushSubscriptionStore(db)
    store.save(base)
    store.save({ ...base, p256dh: 'updated' })

    const live = store.listLive()
    assert.equal(live.length, 1)
    assert.equal(live[0].p256dh, 'updated')
  })

  it('revives a subscription that earlier failures had disabled', () => {
    const store = new PushSubscriptionStore(db)
    store.save(base)
    for (let i = 0; i < 5; i += 1) store.recordFailure(base.endpoint)
    assert.equal(store.countLive(), 0)

    // The same browser re-subscribing is the fix for a disabled endpoint, so
    // it has to be able to clear the flag.
    store.save(base)
    assert.equal(store.countLive(), 1)
    assert.equal(store.listLive()[0].failures, 0)
  })

  it('retires a subscription only after repeated failures', () => {
    const store = new PushSubscriptionStore(db)
    store.save(base)
    store.recordFailure(base.endpoint)
    assert.equal(store.countLive(), 1, 'one failure is not a dead endpoint')

    store.recordSuccess(base.endpoint)
    assert.equal(store.listLive()[0].failures, 0)
  })

  it('drops subscriptions belonging to a rotated VAPID key', () => {
    const store = new PushSubscriptionStore(db)
    store.save(base)
    store.save({ ...base, endpoint: 'https://push.example/2', vapidPublic: 'k2' })

    assert.equal(store.removeForOtherKey('k2'), 1)
    assert.deepEqual(
      store.listLive().map((s) => s.endpoint),
      ['https://push.example/2'],
    )
  })
})

describe('the notification hub', () => {
  it('stores, fans out, and reports the id', () => {
    const store = new NotificationStore(db)
    const hub = new NotificationHub(store, notifyConfig(), null)
    const seen = []
    hub.addSubscriber((message) => seen.push(message))

    const outcome = hub.publish({ title: 'build done', level: 'info' })

    assert.equal(outcome.ok, true)
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0].items.map((n) => n.title), ['build done'])
    assert.equal(store.latestId(), outcome.notification.id)
  })

  it('stops a subscriber that throws from taking the request down with it', () => {
    const store = new NotificationStore(db)
    const hub = new NotificationHub(store, notifyConfig(), null)
    const seen = []
    hub.addSubscriber(() => {
      throw new Error('socket died mid-write')
    })
    hub.addSubscriber((message) => seen.push(message))

    const outcome = hub.publish({ title: 'still delivered', level: 'info' })

    assert.equal(outcome.ok, true)
    assert.equal(seen.length, 1)
  })

  it('unsubscribes cleanly', () => {
    const store = new NotificationStore(db)
    const hub = new NotificationHub(store, notifyConfig(), null)
    const seen = []
    const unsubscribe = hub.addSubscriber((message) => seen.push(message))

    unsubscribe()
    hub.publish({ title: 'nobody listening', level: 'info' })

    assert.equal(seen.length, 0)
    assert.equal(store.latestId(), 1)
  })

  it('refuses past the rate limit, and does not count what it refused', () => {
    const store = new NotificationStore(db)
    const hub = new NotificationHub(store, notifyConfig({ perMinute: 3 }), null)

    for (let i = 0; i < 3; i += 1) {
      assert.equal(hub.publish({ title: `n${i}`, level: 'info' }).ok, true)
    }

    for (let i = 0; i < 20; i += 1) {
      const outcome = hub.publish({ title: 'over', level: 'info' })
      assert.deepEqual(outcome, { ok: false, reason: 'rate_limited' })
    }

    // The refused attempts must not have extended the window: a caller that
    // retries in a loop would otherwise ban itself forever.
    assert.equal(store.latestId(), 3)
  })

  it('delivers to push without waiting for it, and settles on shutdown', async () => {
    const store = new NotificationStore(db)
    let resolveSend
    const sent = []
    const push = {
      send(notification) {
        sent.push(notification.title)
        return new Promise((resolve) => {
          resolveSend = resolve
        })
      },
    }
    const hub = new NotificationHub(store, notifyConfig(), push)

    const outcome = hub.publish({ title: 'to the phone', level: 'info' })
    // Published before the delivery finished: the caller is a shell script and
    // has no business waiting on a push service.
    assert.equal(outcome.ok, true)
    assert.deepEqual(sent, ['to the phone'])

    const shutdown = hub.shutdown()
    resolveSend()
    await shutdown
  })

  it('gives up on a delivery that never settles', async () => {
    const store = new NotificationStore(db)
    const push = { send: () => new Promise(() => {}) }
    // A short grace period rather than the real five seconds: the behaviour
    // under test is that shutdown returns at all, not how long it waits.
    const hub = new NotificationHub(store, notifyConfig(), push, 20)

    hub.publish({ title: 'never delivered', level: 'info' })
    // Resolves anyway. An unresponsive push service must not be able to hold
    // the shutdown open — the database closes after this.
    await hub.shutdown()
  })
})

describe('the local-only guard', () => {
  const allow = buildNotifyAllowList([])

  it('refuses anything carrying an Origin header, including "null"', () => {
    // A browser attaches Origin to every POST it makes, and `null` is a
    // *present* header (file:// pages, sandboxed iframes), not an absent one.
    // Testing for "an origin that is not null" would be the bug.
    for (const origin of ['https://evil.example', 'null', '']) {
      const claim = localOnlyRejection(fakeRequest({ remoteAddress: '127.0.0.1', headers: { origin } }), allow, 't')
      assert.equal(claim, 'origin')
    }
  })

  it('accepts the loopback forms a dual-stack listener produces', () => {
    for (const remoteAddress of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      const request = fakeRequest({
        remoteAddress,
        headers: { 'x-webmux-token': 'secret' },
      })
      assert.equal(localOnlyRejection(request, allow, 'secret'), null, remoteAddress)
    }
  })

  it('refuses a peer that is not local, and one that cannot be read', () => {
    for (const remoteAddress of ['10.0.0.1', '::ffff:10.0.0.1', undefined, 'nonsense']) {
      const request = fakeRequest({ remoteAddress, headers: { 'x-webmux-token': 'secret' } })
      assert.equal(localOnlyRejection(request, allow, 'secret'), 'peer', String(remoteAddress))
    }
  })

  it('refuses a forwarded chain with a non-local hop anywhere in it', () => {
    // The forgery this exists to stop: nginx appends the real peer, so a
    // request can arrive claiming `127.0.0.1, 203.0.113.9` with the loopback
    // first precisely because the client put it there. Checking only the last
    // entry passes it; checking only the first fails every honest request.
    for (const chain of ['127.0.0.1, 203.0.113.9', '203.0.113.9, 127.0.0.1', 'unknown', '127.0.0.1,']) {
      const request = fakeRequest({
        remoteAddress: '127.0.0.1',
        headers: { 'x-webmux-token': 'secret', 'x-forwarded-for': chain },
      })
      assert.equal(localOnlyRejection(request, allow, 'secret'), 'forwarded', chain)
    }
  })

  it('accepts a forwarded chain that is local all the way down', () => {
    const request = fakeRequest({
      remoteAddress: '::1',
      headers: { 'x-webmux-token': 'secret', 'x-forwarded-for': '127.0.0.1:41234, ::1' },
    })
    assert.equal(localOnlyRejection(request, allow, 'secret'), null)
  })

  it('requires the token, from either header', () => {
    const peer = { remoteAddress: '127.0.0.1' }
    assert.equal(localOnlyRejection(fakeRequest({ ...peer, headers: {} }), allow, 'secret'), 'token')
    assert.equal(
      localOnlyRejection(fakeRequest({ ...peer, headers: { 'x-webmux-token': 'wrong' } }), allow, 'secret'),
      'token',
    )
    // A prefix of the right answer is not the right answer.
    assert.equal(
      localOnlyRejection(fakeRequest({ ...peer, headers: { 'x-webmux-token': 'secre' } }), allow, 'secret'),
      'token',
    )
    assert.equal(
      localOnlyRejection(
        fakeRequest({ ...peer, headers: { authorization: 'bearer secret' } }),
        allow,
        'secret',
      ),
      null,
    )
  })

  it('compares tokens without a length short-circuit on the content', () => {
    assert.equal(tokenMatches('secret', 'secret'), true)
    assert.equal(tokenMatches('secre', 'secret'), false)
    assert.equal(tokenMatches(null, 'secret'), false)
    assert.equal(tokenMatches('', 'secret'), false)
  })

  it('honours allowFrom, which is what makes a container or a bound address work', () => {
    const withBridge = buildNotifyAllowList(['172.17.0.0/16'])
    const request = fakeRequest({
      remoteAddress: '::ffff:172.17.0.1',
      headers: { 'x-webmux-token': 'secret' },
    })
    assert.equal(localOnlyRejection(request, allow, 'secret'), 'peer')
    assert.equal(localOnlyRejection(request, withBridge, 'secret'), null)
  })
})

describe('parsing the allow list', () => {
  it('accepts addresses, CIDRs and both families', () => {
    assert.deepEqual(parseCidr('172.17.0.0/16'), { address: '172.17.0.0', prefix: 16, type: 'ipv4' })
    assert.deepEqual(parseCidr('127.0.0.1'), { address: '127.0.0.1', prefix: 32, type: 'ipv4' })
    assert.deepEqual(parseCidr('fd00::/8'), { address: 'fd00::', prefix: 8, type: 'ipv6' })
  })

  it('rejects what is not an address, so the config fails at boot', () => {
    for (const entry of ['', 'nonsense', '10.0.0.0/33', '10.0.0.0/-1', '10.0.0.0/8/8', '10.0.0.0/x']) {
      assert.equal(parseCidr(entry), null, entry)
    }
  })

  it('refuses a prefix that would allow everything', () => {
    // The dangerous shape, and the one a typo produces: `Number('')` is 0, so
    // a trailing slash used to become `/0` — a route matching the entire
    // internet, which switches off the peer check and the forwarded-chain
    // check and leaves the token alone in front of the ingress.
    for (const entry of ['172.17.0.0/', '10.0.0.0/', '172.17.0.0/0', '::/0', '0.0.0.0/0']) {
      assert.equal(parseCidr(entry), null, entry)
    }
    // And the other strings `Number` accepts but a prefix is not.
    for (const entry of ['10.0.0.0/1e1', '10.0.0.0/0x10', '10.0.0.0/ 16', '10.0.0.0/+16']) {
      assert.equal(parseCidr(entry), null, entry)
    }
  })
})

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------

/*
 * RFC 8291 §5, the worked example. Every value is from the RFC.
 *
 * This is the whole reason the encryption is written by hand rather than
 * pulled in as a dependency: with a published vector, the implementation can
 * be checked against something other than itself.
 *
 * Note what is *not* here: the example's final encrypted body. The RFC was not
 * reachable from the machine this was written on, and every copy that could be
 * obtained second-hand turned out to be corrupt — decrypting it with the very
 * keys below fails authentication, and neither plausible record framing
 * reproduces it. A mangled constant is worse than an absent one, so it is
 * absent. The key schedule below is checked against the published
 * intermediate values, and the framing by the decoder above; anyone with the
 * RFC to hand can paste the body in and extend the last case.
 */
const RFC_8291 = {
  plaintext: 'You have a new message!',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
}

describe('RFC 8291 payload encryption', () => {
  const b64 = (value) => Buffer.from(value, 'base64url')

  it('derives the published intermediate keys', () => {
    const keys = derivePushKeys({
      uaPublic: b64(RFC_8291.uaPublic),
      authSecret: b64(RFC_8291.authSecret),
      asPrivate: b64(RFC_8291.asPrivate),
      salt: b64(RFC_8291.salt),
    })

    assert.equal(keys.asPublic.toString('base64url'), RFC_8291.asPublic)
    assert.equal(keys.cek.toString('base64url'), RFC_8291.cek)
    assert.equal(keys.nonce.toString('base64url'), RFC_8291.nonce)
  })

  it('lays the body out as RFC 8188 specifies', () => {
    const plaintext = Buffer.from(RFC_8291.plaintext, 'utf8')
    const body = encryptPushPayload({
      plaintext,
      uaPublic: b64(RFC_8291.uaPublic),
      authSecret: b64(RFC_8291.authSecret),
      asPrivate: b64(RFC_8291.asPrivate),
      salt: b64(RFC_8291.salt),
    })

    // header(86) || record || GCM tag(16), where the record is the data
    // followed by the padding delimiter.
    //
    // Only the header and the total length are observable here: the delimiter
    // is inside the ciphertext, so its presence is asserted by the decoder
    // below, not by looking for a 0x02 byte. The length is still worth
    // pinning — it says the framing adds exactly one octet — and it is the
    // part a round trip cannot check, since an encoder and a decoder that
    // agree on the wrong framing agree with each other.
    assert.equal(body.length, 86 + plaintext.length + 1 + 16)
    assert.equal(body.readUInt32BE(16), 4096)
    assert.equal(body[20], 65)
    assert.equal(body.subarray(21, 86).toString('base64url'), RFC_8291.asPublic)
  })

  it('round-trips through a subscriber that decrypts for itself', () => {
    const keys = subscriptionKeys()
    const authSecret = Buffer.from('0123456789abcdef', 'utf8')
    const plaintext = Buffer.from(JSON.stringify({ title: '构建完成', unread: 2 }), 'utf8')

    const body = encryptPushPayload({ plaintext, uaPublic: keys.publicKey, authSecret })
    const decrypted = decryptPushBody(body, { ...keys, authSecret })

    assert.equal(decrypted.toString('utf8'), plaintext.toString('utf8'))
  })

  it('refuses a payload that cannot fit in one record', () => {
    const keys = subscriptionKeys()
    assert.throws(
      () =>
        encryptPushPayload({
          plaintext: Buffer.alloc(4096),
          uaPublic: keys.publicKey,
          authSecret: Buffer.alloc(16),
        }),
      /record size/,
    )
  })
})

describe('the VAPID key pair', () => {
  it('is generated once and reused, or every subscription would be dead', () => {
    const first = getOrCreateVapidKeys(db)
    const second = getOrCreateVapidKeys(db)

    assert.equal(first.publicKeyBase64, second.publicKeyBase64)
    assert.equal(first.publicKey.length, 65)
    assert.equal(first.privateKey.length, 32)
  })

  it('hands the browser a key it can actually use', () => {
    const keys = getOrCreateVapidKeys(db)
    // The point has to be importable as a P-256 public key, which is what
    // `applicationServerKey` means; a malformed one fails inside the browser
    // with an error nobody can act on.
    assert.doesNotThrow(() => publicKeyFromPoint(keys.publicKey))
  })
})

describe('the push service', () => {
  const endpoint = 'https://push.example/subscription/1'

  function setup({ fetchImpl } = {}) {
    const store = new PushSubscriptionStore(db)
    const keys = subscriptionKeys()
    const authSecret = Buffer.from('0123456789abcdef', 'utf8')
    const service = new WebPushService({
      store,
      keys: getOrCreateVapidKeys(db),
      subject: 'mailto:test@localhost',
      ...(fetchImpl ? { fetchImpl } : {}),
    })
    return { store, keys, authSecret, service }
  }

  /** Registers a subscription the way the browser would. */
  function register(service, store, keys, authSecret, url = endpoint) {
    service.subscribe({
      endpoint: url,
      p256dh: keys.publicKey.toString('base64url'),
      auth: authSecret.toString('base64url'),
      ua: 'test',
    })
    return store
  }

  function notification() {
    const store = new NotificationStore(db)
    return store.insert({
      title: '部署完成',
      body: 'exit 0',
      level: 'info',
      sessionId: 'sess-1',
      source: null,
    })
  }

  it('rejects an endpoint it should not be asked to fetch', () => {
    const { service, keys, authSecret } = setup()
    for (const url of ['http://push.example/1', 'file:///etc/passwd', 'ftp://push.example/1']) {
      assert.throws(
        () =>
          service.subscribe({
            endpoint: url,
            p256dh: keys.publicKey.toString('base64url'),
            auth: authSecret.toString('base64url'),
            ua: null,
          }),
        /https/,
        url,
      )
    }
  })

  it('rejects keys that could not be delivered to', () => {
    const { service, authSecret } = setup()
    assert.throws(
      () =>
        service.subscribe({
          endpoint,
          p256dh: Buffer.alloc(32).toString('base64url'),
          auth: authSecret.toString('base64url'),
          ua: null,
        }),
      /p256dh/,
    )
    assert.throws(
      () =>
        service.subscribe({
          endpoint,
          p256dh: Buffer.alloc(65).fill(4).toString('base64url'),
          auth: 'tooshort',
          ua: null,
        }),
      /auth/,
    )
  })

  it('posts a message the subscriber can decrypt, with a valid VAPID token', async () => {
    const captured = []
    const { service, store, keys, authSecret } = setup({
      fetchImpl: async (url, init) => {
        captured.push({ url, init })
        return new Response(null, { status: 201 })
      },
    })
    register(service, store, keys, authSecret)

    const item = notification()
    await service.send(item, 3, 'build')

    assert.equal(captured.length, 1)
    const { init } = captured[0]
    assert.equal(init.headers['content-encoding'], 'aes128gcm')
    assert.equal(init.headers.ttl, '86400')
    assert.equal(init.headers.topic, 'build')
    assert.match(init.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+,k=/)

    const decrypted = JSON.parse(
      decryptPushBody(Buffer.from(init.body), { privateKey: keys.privateKey, publicKey: keys.publicKey, authSecret }),
    )
    assert.deepEqual(decrypted, {
      id: item.id,
      title: '部署完成',
      body: 'exit 0',
      level: 'info',
      sessionId: 'sess-1',
      unread: 3,
    })
    assert.equal(store.listLive()[0].failures, 0)
  })

  it('drops a subscription the push service says is gone', async () => {
    const { service, store, keys, authSecret } = setup({
      fetchImpl: async () => new Response(null, { status: 410 }),
    })
    register(service, store, keys, authSecret)

    await service.send(notification(), 0, undefined)

    // 410 is final: retrying forever would be a slow leak of dead rows, and
    // the browser re-subscribes on its next visit anyway.
    assert.equal(store.countLive(), 0)
  })

  it('does not blame the device for the push service having a bad day', async () => {
    // 429 from a burst, or 403 while a VAPID misconfiguration is being fixed:
    // the push service answered, so the subscription is fine. Counting these
    // would retire a working phone five notifications into the outage, and the
    // browser would never know to re-subscribe.
    for (const status of [429, 500, 503, 401, 403, 413]) {
      const { service, store, keys, authSecret } = setup({
        fetchImpl: async () => new Response(null, { status }),
      })
      register(service, store, keys, authSecret)

      for (let i = 0; i < PUSH_FAILURE_LIMIT + 2; i += 1) {
        await service.send(notification(), 0, undefined)
      }

      assert.equal(store.countLive(), 1, `HTTP ${status} should not retire the subscription`)
      assert.equal(store.listLive()[0].failures, 0, `HTTP ${status} should not count`)
    }
  })

  it('counts an endpoint it cannot reach at all', async () => {
    const { service, store, keys, authSecret } = setup({
      fetchImpl: async () => {
        throw new Error('ENOTFOUND')
      },
    })
    register(service, store, keys, authSecret)

    // The one condition that does suggest the subscription is dead.
    await service.send(notification(), 0, undefined)
    assert.equal(store.listLive()[0].failures, 1)
    assert.equal(store.countLive(), 1)
  })

  it('trims a long body rather than failing to encrypt it', async () => {
    // The sanitiser allows 4000 code points, which is up to 12 KB — far more
    // than the 4096-byte record can hold. Failing to encrypt is not the
    // subscription's fault, and the delivery path must not treat it as one.
    const captured = []
    const { service, store, keys, authSecret } = setup({
      fetchImpl: async (url, init) => {
        captured.push(init)
        return new Response(null, { status: 201 })
      },
    })
    register(service, store, keys, authSecret)

    const store2 = new NotificationStore(db)
    const long = store2.insert({
      title: '构建完成',
      body: '日'.repeat(4000),
      level: 'info',
      sessionId: null,
      source: null,
    })
    await service.send(long, 1, undefined)

    assert.equal(captured.length, 1, 'the delivery should have been attempted')
    const payload = JSON.parse(
      decryptPushBody(Buffer.from(captured[0].body), {
        privateKey: keys.privateKey,
        publicKey: keys.publicKey,
        authSecret,
      }),
    )
    assert.ok(Array.from(payload.body).length <= 601, 'trimmed to the push budget')
    assert.equal(store.listLive()[0].failures, 0)
  })

  it('survives a transport that throws', async () => {
    const { service, store, keys, authSecret } = setup({
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    register(service, store, keys, authSecret)

    // Must not reject: the hub calls this from a publish, and an unhandled
    // rejection is fatal to the process.
    await service.send(notification(), 0, undefined)
    assert.equal(store.listLive()[0].failures, 1)
  })

  it('does nothing at all when nobody is subscribed', async () => {
    let called = false
    const { service } = setup({
      fetchImpl: async () => {
        called = true
        return new Response(null, { status: 201 })
      },
    })

    await service.send(notification(), 0, undefined)
    assert.equal(called, false)
  })
})
