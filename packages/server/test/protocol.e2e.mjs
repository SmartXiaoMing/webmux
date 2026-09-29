/**
 * End-to-end verification of the P0+P1 contract: a shell that survives the
 * browser, and a reconnect path that loses no output.
 *
 * These assertions are the whole reason the seq/ring/snapshot machinery
 * exists, so they are checked against a real server, a real tmux and a real
 * PTY rather than against mocks.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'

const PORT = 8199
const BASE = `http://127.0.0.1:${PORT}`
const PASSWORD = 'correct-horse-battery'
const PREFIX = 'webmux-'

let dataDir
let server
let cookie

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function waitForServer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/auth/status`)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await delay(100)
  }
  throw new Error('server did not become ready')
}

async function api(pathname, init = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  })
  const setCookie = res.headers.getSetCookie?.() ?? []
  for (const c of setCookie) {
    if (c.startsWith('webmux_session=')) cookie = c.split(';')[0]
  }
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

/**
 * A scriptable terminal client. Records raw output bytes so tests can assert on
 * exact stream contents rather than on rendered text.
 */
class Client {
  constructor(sessionId, { lastSeq } = {}) {
    this.sessionId = sessionId
    this.lastSeq = lastSeq
    this.control = []
    this.chunks = []
    this.bytes = 0
    this.closeCode = null
    this.closeReason = null
    /** Offset the server last confirmed for us... */
    this.syncedSeq = 0
    /** ...plus bytes received since, which is exactly what `lastSeq` must report. */
    this.bytesSinceSync = 0
    this.hasSynced = false
    this.exited = new Promise((resolve) => {
      this._resolveExit = resolve
    })
  }

  /** The offset to hand back as `lastSeq` on a reconnect. */
  get consumedSeq() {
    return this.syncedSeq + this.bytesSinceSync
  }

  connect() {
    return new Promise((resolve, reject) => {
      // Settles once and stops the timeout either way. Left running, the timer
      // would hold the process open for its full term and reject a promise that
      // has already resolved.
      let timeout
      const settle = (fn, value) => {
        clearTimeout(timeout)
        fn(value)
      }
      timeout = setTimeout(() => settle(reject, new Error('attach timed out')), 10_000)
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/terminal`, {
        headers: { cookie, origin: BASE },
      })
      this.ws.on('open', () => {
        this.send({
          t: 'attach',
          sessionId: this.sessionId,
          cols: 100,
          rows: 30,
          ...(this.lastSeq !== undefined ? { lastSeq: this.lastSeq } : {}),
        })
      })
      this.ws.on('message', (data, isBinary) => {
        if (isBinary) {
          this.chunks.push(Buffer.from(data))
          this.bytes += data.length
          // Snapshot and replay bytes are already accounted for by the seq the
          // server reports in `synced`; only live output advances our offset.
          if (this.hasSynced) this.bytesSinceSync += data.length
          return
        }
        const msg = JSON.parse(data.toString())
        this.control.push(msg)
        if (msg.t === 'synced') {
          this.syncedSeq = msg.seq
          this.bytesSinceSync = 0
          this.hasSynced = true
          settle(resolve, msg)
        }
        if (msg.t === 'error') settle(reject, new Error(`server error: ${msg.code} ${msg.message}`))
        if (msg.t === 'exit') this._resolveExit(msg)
      })
      this.ws.on('close', (code, reason) => {
        this.closeCode = code
        this.closeReason = reason.toString()
      })
      this.ws.on('error', (err) => settle(reject, err))
    })
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg))
  }

  write(data) {
    this.send({ t: 'input', data })
  }

  /** All output received since the last `mark()`. */
  text() {
    return Buffer.concat(this.chunks).toString('utf8')
  }

  mark() {
    this.chunks = []
    this.bytes = 0
  }

  sawControl(t) {
    return this.control.some((m) => m.t === t)
  }

  async waitForControl(t, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = this.control.find((m) => m.t === t)
      if (hit) return hit
      await delay(50)
    }
    throw new Error(`never received control frame "${t}"; got ${this.control.map((m) => m.t).join(',')}`)
  }

  async waitForText(needle, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.text().includes(needle)) return true
      await delay(50)
    }
    throw new Error(`never saw ${JSON.stringify(needle)}; output was:\n${this.text().slice(-2000)}`)
  }

  close() {
    this.ws?.close()
  }
}

/** Runs a command in the session and waits for its sentinel to appear. */
async function run(client, command, sentinel) {
  client.write(`${command}; echo ${sentinel}\r`)
  await client.waitForText(sentinel)
  return client.text()
}

function tmux(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', ['-L', 'webmux-e2e', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))))
  })
}

/**
 * Names of the tmux sessions that currently exist, or [] when the tmux server
 * is not running — which is the normal state once the last session is killed,
 * since tmux exits an empty server.
 */
async function listTmuxSessions() {
  try {
    const out = await tmux('list-sessions', '-F', '#{session_name}')
    return out.split('\n').filter(Boolean)
  } catch (err) {
    if (/no server running|no sessions/i.test(err.message)) return []
    throw err
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'webmux-e2e-'))
  server = spawn('node', ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      WEBMUX_PORT: String(PORT),
      WEBMUX_DATA_DIR: dataDir,
      WEBMUX_TMUX_SOCKET: 'webmux-e2e',
      // Small enough that a test can overflow it in a fraction of a second;
      // the eviction path is otherwise unreachable in a test.
      WEBMUX_RING_BUFFER_BYTES: String(64 * 1024),
      WEBMUX_LOG_LEVEL: process.env.WEBMUX_TEST_LOG_LEVEL ?? 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Both streams matter: info/debug go to stdout, warn/error to stderr.
  server.stdout.on('data', (d) => process.stderr.write(`[server] ${d}`))
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
  await waitForServer()
})

after(async () => {
  try {
    await tmux('kill-server')
  } catch {
    // no server running
  }
  server?.kill('SIGTERM')
  await delay(300)
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

describe('auth', () => {
  it('starts uninitialised and refuses session access', async () => {
    const status = await api('/api/auth/status')
    assert.equal(status.body.initialized, false)
    assert.equal(status.body.authenticated, false)

    const denied = await api('/api/sessions')
    assert.equal(denied.status, 401)
  })

  it('rejects a short password at setup', async () => {
    const res = await api('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ password: 'short' }),
    })
    assert.equal(res.status, 400)
  })

  it('accepts setup and issues a session cookie', async () => {
    const res = await api('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ password: PASSWORD }),
    })
    assert.equal(res.status, 200)
    assert.ok(cookie, 'expected a session cookie')

    const status = await api('/api/auth/status')
    assert.equal(status.body.initialized, true)
    assert.equal(status.body.authenticated, true)
  })

  it('refuses to run setup twice', async () => {
    const res = await api('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ password: 'another-password' }),
    })
    assert.equal(res.status, 409)
  })

  it('rejects a wrong password', async () => {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: 'wrong-password' }),
    })
    assert.equal(res.status, 401)
  })
})

describe('terminal sessions', () => {
  let sessionId

  it('creates a session backed by a real tmux session', async () => {
    const res = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: 'e2e' }) })
    assert.equal(res.status, 201)
    assert.equal(res.body.title, 'e2e')
    sessionId = res.body.id

    const list = await listTmuxSessions()
    assert.ok(list.includes(`${PREFIX}${sessionId}`), `tmux should know about ${sessionId}`)
  })

  it('runs a command and streams its output', async () => {
    const client = new Client(sessionId)
    await client.connect()
    const out = await run(client, 'echo hello-from-webmux', 'SENTINEL_1')
    assert.match(out, /hello-from-webmux/)
    assert.match(out, /SENTINEL_1/)
    client.close()
  })

  it('keeps the shell running after the browser disconnects', async () => {
    const first = new Client(sessionId)
    await first.connect()
    // Background a writer that keeps emitting after we detach.
    first.write('(for i in 1 2 3 4 5; do echo tick-$i; sleep 0.4; done) &\r')
    await first.waitForText('tick-1')
    first.close()

    await delay(2500)

    const second = new Client(sessionId)
    await second.connect()
    const out = second.text()
    assert.match(out, /tick-5/, 'output produced while detached should be in the snapshot')
    second.close()
  })

  it('replays only the missing bytes when the gap is still buffered', async () => {
    const first = new Client(sessionId)
    await first.connect()
    await run(first, 'echo FIRST-MARKER', 'SENTINEL_2')

    // The exact stream offset this client has rendered. Handing this back is
    // what lets the server send only the gap.
    const consumed = first.consumedSeq
    assert.ok(consumed > 0, 'client should have accounted for some stream bytes')
    first.close()

    // Produce more output while nobody is attached.
    await delay(200)
    const writer = new Client(sessionId)
    await writer.connect()
    await run(writer, 'echo WHILE-AWAY', 'SENTINEL_3')
    writer.close()

    // Reattach claiming everything up to `consumed`, and expect a replay
    // rather than a full snapshot.
    const resumed = new Client(sessionId, { lastSeq: consumed })
    await resumed.connect()
    resumed.mark()
    await resumed.waitForText('WHILE-AWAY')

    assert.ok(
      resumed.sawControl('replay'),
      `expected a replay frame, got: ${resumed.control.map((m) => m.t).join(',')}`,
    )
    assert.ok(!resumed.sawControl('resync'), 'a buffered gap must not force a resync')

    const replay = resumed.control.find((m) => m.t === 'replay')
    assert.equal(replay.fromSeq, consumed, 'replay must resume exactly where the client left off')
    resumed.close()
  })

  it('falls back to a snapshot when the client is far behind', async () => {
    const cold = new Client(sessionId)
    await cold.connect()
    assert.ok(cold.sawControl('resync'), 'a cold attach should resync from a snapshot')
    assert.ok(cold.text().length > 0, 'the snapshot should carry terminal content')
    cold.close()
  })

  it('resyncs when the offset has been evicted from the ring', async () => {
    const first = new Client(sessionId)
    await first.connect()
    const staleOffset = first.consumedSeq
    first.close()

    // Overflow the 64 KiB ring the test harness configures. Offsets before
    // this point are no longer recoverable, so a client holding one cannot be
    // served by replay.
    const flood = new Client(sessionId)
    await flood.connect()
    flood.write("head -c 200000 /dev/zero | tr '\\0' 'x'; echo FLOOD_DONE\r")
    await flood.waitForText('FLOOD_DONE', 30_000)
    flood.close()

    const stale = new Client(sessionId, { lastSeq: staleOffset })
    await stale.connect()
    assert.ok(
      stale.sawControl('resync'),
      `an evicted offset must force a snapshot, got: ${stale.control.map((m) => m.t).join(',')}`,
    )
    assert.ok(!stale.sawControl('replay'), 'bytes that no longer exist must not be replayed')
    stale.close()
  })

  it('resyncs an offset ahead of the stream', async () => {
    // A client claiming to have consumed more than the server ever produced is
    // incoherent (stale tab from before a server restart, or a bug); it must
    // be resynced rather than sent a negative-length replay.
    const client = new Client(sessionId, { lastSeq: 999_999_999 })
    await client.connect()
    assert.ok(client.sawControl('resync'), 'a future offset must trigger a resync')
    client.close()
  })

  it('applies a browser resize to the tmux window', async () => {
    const client = new Client(sessionId)
    await client.connect()
    client.send({ t: 'resize', cols: 120, rows: 40 })
    await delay(700)

    const size = await tmux('display-message', '-p', '-t', `${PREFIX}${sessionId}`, '#{window_width}x#{window_height}')
    assert.equal(size.trim(), '120x40')
    client.close()
  })

  it('reports the session through the REST list', async () => {
    const res = await api('/api/sessions')
    assert.equal(res.status, 200)
    const found = res.body.find((s) => s.id === sessionId)
    assert.ok(found)
    assert.equal(found.running, true)
    // Seeded from the creation directory, before anything has moved the shell.
    assert.equal(found.liveCwd, found.cwd)
  })

  it("tracks the shell's own directory, separately from where it was created", async () => {
    const before = (await api('/api/sessions')).body.find((s) => s.id === sessionId)
    // Through realpath: the backend reports the kernel's cwd, so on macOS a
    // temporary directory under /var comes back as /private/var.
    const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'webmux-livecwd-')))

    try {
      const client = new Client(sessionId)
      await client.connect()
      await run(client, `cd ${scratch}`, 'SENTINEL_CWD')
      client.close()
      assert.notEqual(scratch, before.cwd, 'the fixture must differ from the creation directory')

      // The registry refreshes out of band, so this polls rather than assuming
      // a particular interval.
      const deadline = Date.now() + 30_000
      let found = before
      while (Date.now() < deadline) {
        found = (await api('/api/sessions')).body.find((s) => s.id === sessionId)
        if (found.liveCwd === scratch) break
        await delay(500)
      }

      assert.equal(found.liveCwd, scratch, 'liveCwd should follow the shell')
      // And the creation directory is a separate field that must not move.
      assert.equal(found.cwd, before.cwd)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('tells every attached client when the shell exits', async () => {
    // Its own session: exiting the shell ends it, so this cannot share the one
    // the rest of this block uses.
    const created = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'exit-frame' }),
    })
    const id = created.body.id

    // Two clients, because the frame has to reach all of them — a tab left
    // open in another browser should not go on showing a dead prompt.
    const first = new Client(id)
    await first.connect()
    const second = new Client(id)
    await second.connect()

    first.write('exit\r')

    const [a, b] = await Promise.all([first.exited, second.exited])
    assert.equal(a.t, 'exit')
    assert.equal(b.t, 'exit')
    assert.equal(typeof a.code, 'number')

    // And it is gone from the registry, not merely dead. This is also what
    // exercises the disposal on the exit path.
    const list = await api('/api/sessions')
    assert.equal(
      list.body.find((s) => s.id === id),
      undefined,
    )
  })

  it('kills the session and removes the tmux session', async () => {
    const res = await api(`/api/sessions/${sessionId}`, { method: 'DELETE' })
    assert.equal(res.status, 204)

    const list = await listTmuxSessions()
    assert.ok(!list.includes(`${PREFIX}${sessionId}`), 'tmux session should be gone')
  })
})

describe('websocket hardening', () => {
  it('rejects an upgrade from a foreign origin', async () => {
    const res = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: 'origin-test' }) })
    const id = res.body.id

    const rejected = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/terminal`, {
        headers: { cookie, origin: 'https://evil.example.com' },
      })
      ws.on('unexpected-response', (_req, resp) => resolve(resp.statusCode))
      ws.on('open', () => {
        ws.close()
        resolve('opened')
      })
      ws.on('error', () => resolve('error'))
    })
    assert.notEqual(rejected, 'opened', 'a cross-origin upgrade must not succeed')

    // An unknown session id must be reported, not silently ignored.
    const client = new Client('does-not-exist')
    await assert.rejects(() => client.connect(), /session_not_found/)
    client.close()
  })
})
