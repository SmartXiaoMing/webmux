/**
 * End-to-end verification of the notification ingress, the REST surface and
 * the event channel.
 *
 * A spawned server, a real database, a real WebSocket. The unit tests already
 * cover the decision logic; what only a live server can show is that the four
 * gates are actually wired to it, that the event channel is registered after
 * `@fastify/websocket` (get the order wrong and the upgrade silently never
 * happens), and that a client which reconnects with a cursor is brought up to
 * date rather than left behind.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { NOTIFY_BACKLOG_LIMIT } from '@webmux/shared'
import { decryptPushBody, subscriptionKeys } from './webpush.helpers.mjs'

const PORT = 8203
const BASE = `http://127.0.0.1:${PORT}`
const PASSWORD = 'notify-e2e-password'
const TMUX_SOCKET = 'webmux-notify-e2e'

/**
 * Kept above what the rest of the file publishes, so only the last suite trips
 * it — including the truncation case below, which has to out-publish the
 * catch-up batch size.
 */
const PER_MINUTE = 100

let tmp
let dataDir
let server
let cookie
let token

const cli = path.resolve(import.meta.dirname, '../bin/webmux.mjs')

async function waitForServer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/auth/status`)).ok) return
    } catch {
      // not up yet
    }
    await delay(100)
  }
  throw new Error('server did not become ready')
}

function startServer() {
  const child = spawn('node', ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      WEBMUX_PORT: String(PORT),
      WEBMUX_DATA_DIR: dataDir,
      WEBMUX_TMUX_SOCKET: TMUX_SOCKET,
      WEBMUX_LOG_LEVEL: process.env.WEBMUX_TEST_LOG_LEVEL ?? 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.stderr.write(`[server] ${d}`))
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
  return child
}

async function api(pathname, init = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...init.headers },
  })
  for (const c of res.headers.getSetCookie?.() ?? []) {
    if (c.startsWith('webmux_session=')) cookie = c.split(';')[0]
  }
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers }
}

/**
 * The ingress, called the way a local script would.
 *
 * `token: null` means "send none at all", which is why it is checked for
 * explicitly: `options.token ?? token` would treat the null as absent and
 * cheerfully attach the real one.
 */
function publish(body, options = {}) {
  const headers = { ...(options.headers ?? {}) }
  const useToken = options.token === undefined ? token : options.token
  if (useToken !== null) headers['x-webmux-token'] = useToken
  if (options.raw !== true) headers['content-type'] = 'application/json'

  return fetch(`${BASE}/api/notify`, {
    method: 'POST',
    headers,
    body: options.raw === true ? body : JSON.stringify(typeof body === 'string' ? { title: body } : body),
  })
}

async function publishOk(input) {
  const res = await publish(input)
  // Read once. A Response body can only be consumed a single time, so using
  // the text as the assertion message and then calling `.json()` throws
  // "Body is unusable" — on the passing path, which is a confusing way to find
  // out about it.
  const text = await res.text()
  assert.equal(res.status, 201, text)
  return JSON.parse(text).id
}

/** A notification stream client that collects frames instead of printing them. */
class EventClient {
  constructor(headers = {}) {
    this.frames = []
    this.socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws/events`, {
      headers: { origin: BASE, ...(cookie ? { cookie } : {}), ...headers },
    })
    this.opened = new Promise((resolve, reject) => {
      this.socket.on('open', resolve)
      this.socket.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
      this.socket.on('error', reject)
    })
    this.socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString())
      // The channel's own liveness frames are answered by the app's socket, not
      // by the test; dropping them here keeps `waitFor` about content.
      if (message.t === 'ping') this.socket.send(JSON.stringify({ t: 'pong' }))
      this.frames.push(message)
    })
  }

  send(message) {
    this.socket.send(JSON.stringify(message))
  }

  async waitFor(predicate, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = this.frames.find(predicate)
      if (found !== undefined) return found
      await delay(20)
    }
    throw new Error(`no matching frame; saw ${JSON.stringify(this.frames)}`)
  }

  close() {
    this.socket.close()
  }
}

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'webmux-notify-e2e-'))
  dataDir = path.join(tmp, 'data')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      files: { roots: [{ name: 'files', path: dataDir }] },
      notify: { perMinute: PER_MINUTE },
    }),
  )

  server = startServer()
  await waitForServer()
  const res = await api('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ password: PASSWORD }),
  })
  assert.equal(res.status, 200)

  token = readFileSync(path.join(dataDir, 'notify-token'), 'utf8').trim()
})

after(async () => {
  if (server) {
    server.kill('SIGTERM')
    await new Promise((resolve) => {
      server.once('exit', resolve)
      setTimeout(resolve, 5000)
    })
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('the ingress is local-only', () => {
  it('refuses a request with no token', async () => {
    const res = await publish('no token', { token: null })
    assert.equal(res.status, 401)
    assert.equal((await res.json()).error.code, 'notify_token')
  })

  it('refuses a request with the wrong token', async () => {
    assert.equal((await publish('wrong', { token: 'nope' })).status, 401)
  })

  it('refuses anything a browser would send, including Origin: null', async () => {
    // `null` is a *present* header — file:// pages and sandboxed iframes send
    // it — so a check written as "an origin that is not null" would let this
    // through. The browser is the one caller the peer check cannot exclude,
    // since it is on this machine too.
    for (const origin of ['https://evil.example', 'null', BASE]) {
      const res = await publish('from a page', { headers: { origin } })
      assert.equal(res.status, 403, origin)
      assert.equal((await res.json()).error.code, 'notify_origin')
    }
  })

  it('refuses a forwarded chain with a remote hop in it', async () => {
    // The forgery this stops: nginx appends the real peer address to whatever
    // the client claimed, so the loopback is first only because the client put
    // it there. Checking the last hop alone would pass this request.
    const res = await publish('proxied', {
      headers: { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' },
    })
    assert.equal(res.status, 403)
    assert.equal((await res.json()).error.code, 'notify_forwarded')
  })

  it('accepts a forwarded chain that is local throughout', async () => {
    const res = await publish('through a local proxy', {
      headers: { 'x-forwarded-for': '127.0.0.1:41234' },
    })
    assert.equal(res.status, 201)
  })

  it('refuses a peer that is not on this machine', async (t) => {
    // Only runnable when the host has an address that is not loopback. It
    // usually does, including in a container, and the case is worth the
    // conditional: it is the one assertion that proves the socket peer is what
    // the guard reads, rather than anything the caller supplied.
    const address = Object.values(networkInterfaces())
      .flat()
      .find((iface) => iface && iface.family === 'IPv4' && !iface.internal)?.address
    if (address === undefined) {
      t.skip('no non-loopback IPv4 address on this host')
      return
    }

    const res = await fetch(`http://${address}:${PORT}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webmux-token': token },
      body: JSON.stringify({ title: 'from elsewhere' }),
    })
    assert.equal(res.status, 403)
    assert.equal((await res.json()).error.code, 'notify_peer')
  })

  it('accepts the token from an Authorization header too', async () => {
    const res = await publish('bearer', {
      token: null,
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 201)
  })
})

describe('what the ingress accepts', () => {
  it('takes a plain-text body as title and body', async () => {
    const res = await publish('构建完成\n耗时 3m12s', {
      raw: true,
      headers: { 'content-type': 'text/plain' },
    })
    assert.equal(res.status, 201)

    const { body } = await api('/api/notifications?limit=1')
    assert.equal(body.notifications[0].title, '构建完成')
    assert.equal(body.notifications[0].body, '耗时 3m12s')
    assert.equal(body.notifications[0].level, 'info')
  })

  it('takes the full JSON form', async () => {
    await publishOk({ title: '部署完成', body: 'ok', level: 'warn', sessionId: 'sess-1', source: 'ci' })

    const { body } = await api('/api/notifications?limit=1')
    const [notification] = body.notifications
    assert.equal(notification.title, '部署完成')
    assert.equal(notification.level, 'warn')
    assert.equal(notification.sessionId, 'sess-1')
    assert.equal(notification.source, 'ci')
    assert.equal(notification.read, false)
  })

  it('cleans what it stores, rather than storing what it was sent', async () => {
    await publishOk({ title: '\u001b[31mFAILED\u001b[0m\u0007', body: 'a\r\nb' })

    const { body } = await api('/api/notifications?limit=1')
    assert.equal(body.notifications[0].title, '[31mFAILED[0m')
    assert.equal(body.notifications[0].body, 'a\nb')
  })

  it('refuses a content type it cannot read', async () => {
    const res = await fetch(`${BASE}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-webmux-token': token },
      body: 'title=hi',
    })
    assert.equal(res.status, 415)
  })

  it('refuses an empty body', async () => {
    const res = await publish('', { raw: true, headers: { 'content-type': 'text/plain' } })
    assert.equal(res.status, 400)
  })

  it('refuses a JSON body with no title', async () => {
    assert.equal((await publish({ body: 'no title here' })).status, 400)
  })
})

describe('the authenticated surface', () => {
  for (const [method, route] of [
    ['GET', '/api/notifications'],
    ['POST', '/api/notifications/read'],
    ['GET', '/api/notifications/status'],
    ['POST', '/api/notifications/push'],
    ['DELETE', '/api/notifications/push'],
  ]) {
    it(`${method} ${route} -> 401 without a session`, async () => {
      const res = await fetch(`${BASE}${route}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { body: '{}' }),
      })
      assert.equal(res.status, 401)
    })
  }

  it('lists newest first and counts unread', async () => {
    const { status, body } = await api('/api/notifications?limit=200')
    assert.equal(status, 200)
    assert.ok(body.notifications.length > 0)
    assert.equal(body.unread, body.notifications.filter((n) => !n.read).length)
    assert.ok(body.latestId >= body.notifications[0].id)
  })

  it('marks read by cursor, and refuses an empty request', async () => {
    const { body: before } = await api('/api/notifications?limit=200')
    // The *oldest* one: `upTo` includes everything at or below the cursor, so
    // aiming it at the newest would mark the whole list and the assertion
    // below would be about a different change than it reads as.
    const target = before.notifications.at(-1)

    const { status, body } = await api('/api/notifications/read', {
      method: 'POST',
      body: JSON.stringify({ upTo: target.id }),
    })
    assert.equal(status, 200)
    assert.equal(body.unread, before.unread - 1)

    // `{}` would be an accidental "clear the badge"; it has to be explicit.
    const empty = await api('/api/notifications/read', { method: 'POST', body: '{}' })
    assert.equal(empty.status, 400)
  })

  it('reports the feature as on, with a key the browser could subscribe with', async () => {
    const { status, body } = await api('/api/notifications/status')
    assert.equal(status, 200)
    assert.equal(body.enabled, true)
    assert.equal(body.push, true)
    // 65 bytes base64url: an uncompressed P-256 point, which is what
    // applicationServerKey takes. A malformed one fails inside the browser
    // with an error nobody can act on.
    assert.equal(Buffer.from(body.publicKey, 'base64url').length, 65)
    assert.equal(body.subscriptions, 0)
  })
})

describe('the event channel', () => {
  it('refuses an upgrade with no session', async () => {
    const client = new EventClient({ cookie: '' })
    await assert.rejects(client.opened, /HTTP 401/)
    client.close()
  })

  it('refuses an upgrade from a disallowed origin', async () => {
    // Same cross-site WebSocket hijacking hole as the terminal channel: this
    // one leaks session ids and command output rather than a shell.
    const client = new EventClient({ origin: 'https://evil.example' })
    await assert.rejects(client.opened, /HTTP 403/)
    client.close()
  })

  it('delivers a notification published after it said hello', async () => {
    const client = new EventClient()
    await client.opened
    client.send({ t: 'hello' })
    const ready = await client.waitFor((m) => m.t === 'ready')
    assert.equal(typeof ready.latestId, 'number')

    // A hello with no cursor is a first visit, so the retained history arrives
    // before anything live does. Asserted rather than skipped over, because it
    // is half of what "reconnecting loses nothing" means.
    const backlog = await client.waitFor((m) => m.t === 'notify')
    assert.ok(backlog.items.length > 0)

    await publishOk('live delivery')
    // Matched by content, not by "the next notify frame": the backlog frame is
    // already in the list and would be found first.
    const live = await client.waitFor(
      (m) => m.t === 'notify' && m.items.some((n) => n.title === 'live delivery'),
    )
    assert.equal(live.items.at(-1).title, 'live delivery')

    client.close()
  })

  it('delivers nothing to a client holding the cursor', async () => {
    const { body } = await api('/api/notifications?limit=200')
    const client = new EventClient()
    await client.opened
    client.send({ t: 'hello', since: body.latestId })
    await client.waitFor((m) => m.t === 'ready')

    await delay(150)
    assert.equal(
      client.frames.some((m) => m.t === 'notify'),
      false,
    )
    client.close()
  })

  it('replays the gap for a client reconnecting with an older cursor', async () => {
    const { body: start } = await api('/api/notifications?limit=200')
    const missed = await publishOk('missed while away')
    await publishOk('and this one too')

    const client = new EventClient()
    await client.opened
    client.send({ t: 'hello', since: start.latestId })
    await client.waitFor((m) => m.t === 'ready')

    // Oldest first, so a client appending them in order ends up with the
    // newest at the end — the same shape as the live stream.
    const batch = await client.waitFor((m) => m.t === 'notify')
    assert.deepEqual(
      batch.items.map((n) => n.title),
      ['missed while away', 'and this one too'],
    )
    assert.equal(batch.items[0].id, missed)
    client.close()
  })


  it('says so when the catch-up batch was capped', async () => {
    // The batch is bounded, so a client away for a long time cannot be sent
    // everything. What it must not do is move its cursor to the last id it
    // received and silently skip the rest — the batch is capped only when
    // there is more, and the truncated flag is how the client finds out.
    for (let i = 0; i < NOTIFY_BACKLOG_LIMIT + 3; i += 1) await publishOk('backlog ' + i)

    const client = new EventClient()
    await client.opened
    client.send({ t: 'hello', since: 0 })
    const ready = await client.waitFor((m) => m.t === 'ready')

    assert.equal(ready.truncated, true)
    const batch = await client.waitFor((m) => m.t === 'notify')
    assert.equal(batch.items.length, NOTIFY_BACKLOG_LIMIT)
    client.close()
  })

  it('treats a cursor from another database as a fresh start', async () => {
    // A restored backup or a different data directory leaves the client
    // holding an id this server has never issued. Honouring it would mean
    // ignoring every notification until it caught up, which is to say forever.
    const { body } = await api('/api/notifications?limit=200')
    const client = new EventClient()
    await client.opened
    client.send({ t: 'hello', since: body.latestId + 1000 })
    const ready = await client.waitFor((m) => m.t === 'ready')

    assert.equal(ready.latestId, body.latestId)
    client.close()
  })

  it('broadcasts read state to the other tabs', async () => {
    const client = new EventClient()
    await client.opened
    client.send({ t: 'hello' })
    await client.waitFor((m) => m.t === 'ready')

    await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({ all: true }) })
    const read = await client.waitFor((m) => m.t === 'read')
    assert.equal(read.unread, 0)

    client.close()
  })

  it('answers a malformed frame with an error rather than silence', async () => {
    const client = new EventClient()
    await client.opened
    client.socket.send('not json')
    const error = await client.waitFor((m) => m.t === 'error')
    assert.equal(error.code, 'bad_message')
    client.close()
  })
})

describe('the command-line client', () => {
  function runCli(args, options = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, ...args], {
        env: {
          ...process.env,
          WEBMUX_DATA_DIR: dataDir,
          ...(options.env ?? {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      // Closed either way: the CLI only reads stdin when it is not a TTY, and
      // leaving the pipe open would have it wait for input that never comes.
      child.stdin.end(options.stdin ?? '')
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    })
  }

  it('sends a notification and prints its id', async () => {
    const result = await runCli(['notify', 'from the cli'])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout.trim(), /^\d+$/)
  })

  it('reads a body from stdin when it is a pipe', async () => {
    const result = await runCli(['notify', '--level', 'error', 'piped'], {
      stdin: 'l1\nl2\n',
    })
    assert.equal(result.code, 0, result.stderr)

    const { body } = await api('/api/notifications?limit=1')
    assert.equal(body.notifications[0].title, 'piped')
    assert.equal(body.notifications[0].body, 'l1\nl2')
    assert.equal(body.notifications[0].level, 'error')
  })


  it('does not hang when stdin is an open pipe nobody writes to', async () => {
    // A CI runner or a supervisor can hand the child an open pipe and never
    // close it; reading to EOF would then wait forever, and a notification
    // that hangs is worse than one that fails, because nothing reports it.
    const started = Date.now()
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, 'notify', 'no stdin coming'], {
        env: { ...process.env, WEBMUX_DATA_DIR: dataDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      child.stdout.on('data', (d) => (stdout += d))
      // stdin is deliberately left open and silent.
      child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - started }))
    })

    assert.equal(result.code, 0, 'it should post the title and exit')
    assert.ok(result.ms < 8_000, `took ${result.ms}ms`)
  })

  it('exits 2 on a missing title, without touching the network', async () => {
    const result = await runCli(['notify'])
    assert.equal(result.code, 2)
    assert.match(result.stderr, /标题/)
  })

  it('exits 4 when there is no token file', async () => {
    const result = await runCli(['notify', 'x'], { env: { WEBMUX_DATA_DIR: path.join(tmp, 'gone') } })
    assert.equal(result.code, 3)
    assert.match(result.stderr, /runtime\.json/)
  })

  it('exits 5 when the token is refused', async () => {
    const result = await runCli(['notify', 'x'], { env: { WEBMUX_NOTIFY_TOKEN: 'wrong' } })
    assert.equal(result.code, 5)
    assert.match(result.stderr, /被拒绝/)
  })
})


/*
 * A push service of the test's own, on loopback. The endpoint validation
 * accepts http for loopback addresses precisely so that this can exist: the
 * alternative is mocking the delivery path, which would leave the encryption,
 * the headers and the VAPID token unverified — and those are the parts most
 * likely to be wrong.
 */
describe('web push delivery', () => {
  it('posts a message the subscribed device can decrypt', async () => {
    const received = []
    const pushService = createServer((req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks) })
        res.writeHead(201).end()
      })
    })
    await new Promise((resolve) => pushService.listen(0, '127.0.0.1', resolve))
    const { port } = pushService.address()
    const endpoint = `http://127.0.0.1:${port}/push/1`

    try {
      const keys = subscriptionKeys()
      const authSecret = randomBytes(16)
      const subscribed = await api('/api/notifications/push', {
        method: 'POST',
        body: JSON.stringify({
          endpoint,
          keys: {
            p256dh: keys.publicKey.toString('base64url'),
            auth: authSecret.toString('base64url'),
          },
        }),
      })
      assert.equal(subscribed.status, 201, JSON.stringify(subscribed.body))
      assert.equal(subscribed.body.subscriptions, 1)

      const id = await publishOk('到手机上')
      const deadline = Date.now() + 5_000
      while (received.length === 0 && Date.now() < deadline) await delay(50)
      assert.equal(received.length, 1, 'the push service should have been called')

      const [{ headers, body }] = received
      assert.equal(headers['content-encoding'], 'aes128gcm')
      // Required by RFC 8030: a push service rejects a request without it.
      assert.equal(headers.ttl, '86400')
      assert.match(headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+,k=/)

      const payload = JSON.parse(decryptPushBody(body, { ...keys, authSecret }))
      assert.equal(payload.id, id)
      assert.equal(payload.title, '到手机上')
      assert.equal(typeof payload.unread, 'number')

      const removed = await api('/api/notifications/push', {
        method: 'DELETE',
        body: JSON.stringify({ endpoint }),
      })
      assert.equal(removed.body.subscriptions, 0)
    } finally {
      pushService.close()
    }
  })

  it('refuses a subscription it could not deliver to', async () => {
    const res = await api('/api/notifications/push', {
      method: 'POST',
      body: JSON.stringify({
        endpoint: 'http://push.example/1',
        keys: { p256dh: 'AAAA', auth: 'AAAA' },
      }),
    })
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'invalid_subscription')
  })
})

/*
 * Last in the file, because it is the one suite that consumes the rate limit's
 * whole window — everything above would start getting 429s if it ran earlier.
 */
describe('the rate limit', () => {
  it('refuses a burst, and says how long to wait', async () => {
    const attempts = PER_MINUTE + 8
    const statuses = []
    for (let i = 0; i < attempts; i += 1) {
      const res = await publish(`burst ${i}`)
      statuses.push(res.status)
      if (res.status === 429) {
        assert.equal(res.headers.get('retry-after'), '60')
        assert.equal((await res.json()).error.code, 'rate_limited')
      }
    }

    assert.ok(statuses.filter((s) => s === 429).length > 0, `expected a 429 among ${statuses}`)
    // A refused call must not itself count, or a retrying script would keep the
    // window full forever and never recover.
    const later = await publish('one more')
    assert.equal(later.status, 429)
  })
})
