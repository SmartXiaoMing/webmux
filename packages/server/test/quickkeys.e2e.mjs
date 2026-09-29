/**
 * End-to-end verification of the quick-key routes.
 *
 * A spawned server and a real database, because the interesting parts are the
 * HTTP contract — status codes, validation, and the cap — none of which the
 * store's own unit tests can see.
 *
 * The 401 table is the most valuable case here: auth is applied per route via
 * `preHandler`, so a new route added without it is silently public, and nothing
 * else in the suite would notice.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const PORT = 8202
const BASE = `http://127.0.0.1:${PORT}`
const PASSWORD = 'quickkeys-e2e-password'
const TMUX_SOCKET = 'webmux-quickkeys-e2e'
/** Must match MAX_QUICK_KEYS on the server. */
const MAX_KEYS = 12

let tmp
let dataDir
let server
let cookie

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
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

/** No cookie, ever. */
function anon(pathname, init = {}) {
  return fetch(`${BASE}${pathname}`, init)
}

async function createKey(input) {
  const { status, body } = await api('/api/quickkeys', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  assert.equal(status, 201, JSON.stringify(body))
  return body
}

/** Empties the table through the API, so no case inherits another's keys. */
async function clearKeys() {
  const { body } = await api('/api/quickkeys')
  for (const key of body.keys) await api(`/api/quickkeys/${key.id}`, { method: 'DELETE' })
}

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'webmux-quickkeys-e2e-'))
  dataDir = path.join(tmp, 'data')
  mkdirSync(dataDir, { recursive: true })
  // No tmux session is needed for any of this, but the server still wants a
  // configured root to start with.
  writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ files: { roots: [{ name: 'files', path: dataDir }] } }),
  )

  server = startServer()
  await waitForServer()
  const res = await api('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ password: PASSWORD }),
  })
  assert.equal(res.status, 200)
})

async function stopServer() {
  if (!server) return
  server.kill('SIGTERM')
  await new Promise((resolve) => {
    server.once('exit', resolve)
    setTimeout(resolve, 5000)
  })
  server = null
}

after(async () => {
  await stopServer()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('quick key routes require authentication', () => {
  for (const [method, route] of [
    ['GET', '/api/quickkeys'],
    ['POST', '/api/quickkeys'],
    ['PUT', '/api/quickkeys/0000000000'],
    ['DELETE', '/api/quickkeys/0000000000'],
  ]) {
    it(`${method} ${route} -> 401`, async () => {
      const res = await anon(route, { method, headers: { 'content-type': 'application/json' } })
      assert.equal(res.status, 401)
    })
  }
})

describe('creating and listing', () => {
  before(clearKeys)

  it('starts empty', async () => {
    const { status, body } = await api('/api/quickkeys')
    assert.equal(status, 200)
    assert.deepEqual(body.keys, [])
    assert.equal(body.limits.maxKeys, MAX_KEYS)
  })

  it('creates a key and returns the whole list', async () => {
    const body = await createKey({ label: 'git', text: 'git status', sendEnter: true })

    assert.equal(body.keys.length, 1)
    assert.match(body.keys[0].id, /^[0-9a-f]{10}$/)
    assert.deepEqual(
      { label: body.keys[0].label, text: body.keys[0].text, sendEnter: body.keys[0].sendEnter },
      { label: 'git', text: 'git status', sendEnter: true },
    )
  })

  it('defaults sendEnter to true when the field is absent', async () => {
    const { status, body } = await api('/api/quickkeys', {
      method: 'POST',
      body: JSON.stringify({ label: 'ls', text: 'ls -la' }),
    })
    assert.equal(status, 201)
    assert.equal(body.keys.find((k) => k.label === 'ls').sendEnter, true)
  })

  it('keeps keys in creation order across a round trip', async () => {
    await clearKeys()
    await createKey({ label: 'one', text: 'echo 1' })
    await createKey({ label: 'two', text: 'echo 2' })
    await createKey({ label: 'three', text: 'echo 3' })

    const { body } = await api('/api/quickkeys')
    assert.deepEqual(
      body.keys.map((k) => k.label),
      ['one', 'two', 'three'],
    )
  })

  it('trims the label', async () => {
    await clearKeys()
    const body = await createKey({ label: '  spaced  ', text: 'echo hi' })
    assert.equal(body.keys[0].label, 'spaced')
  })
})

describe('updating', () => {
  let id

  before(async () => {
    await clearKeys()
    const body = await createKey({ label: 'before', text: 'echo before', sendEnter: false })
    id = body.keys[0].id
  })

  it('replaces every field', async () => {
    const { status, body } = await api(`/api/quickkeys/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ label: 'after', text: 'echo after', sendEnter: true }),
    })

    assert.equal(status, 200)
    assert.equal(body.keys.length, 1)
    assert.deepEqual(
      { label: body.keys[0].label, text: body.keys[0].text, sendEnter: body.keys[0].sendEnter },
      { label: 'after', text: 'echo after', sendEnter: true },
    )
  })

  it('404s for an unknown id', async () => {
    const { status, body } = await api('/api/quickkeys/deadbeef00', {
      method: 'PUT',
      body: JSON.stringify({ label: 'x', text: 'y', sendEnter: true }),
    })
    assert.equal(status, 404)
    assert.equal(body.error.code, 'quick_key_not_found')
  })

  it('validates the body before looking the id up', async () => {
    const { status, body } = await api('/api/quickkeys/deadbeef00', {
      method: 'PUT',
      body: JSON.stringify({ label: '', text: '' }),
    })
    assert.equal(status, 400)
    assert.equal(body.error.code, 'invalid_request')
  })
})

describe('deleting', () => {
  it('removes the key and answers with the remaining list', async () => {
    await clearKeys()
    await createKey({ label: 'keep', text: 'echo keep' })
    const { keys } = await createKey({ label: 'drop', text: 'echo drop' })
    const drop = keys.find((k) => k.label === 'drop')

    const { status, body } = await api(`/api/quickkeys/${drop.id}`, { method: 'DELETE' })
    assert.equal(status, 200)
    assert.deepEqual(
      body.keys.map((k) => k.label),
      ['keep'],
    )
  })

  it('404s for an unknown id', async () => {
    const { status, body } = await api('/api/quickkeys/deadbeef00', { method: 'DELETE' })
    assert.equal(status, 404)
    assert.equal(body.error.code, 'quick_key_not_found')
  })
})

describe('validation', () => {
  const bad = [
    ['missing label', { text: 'echo hi' }],
    ['empty label', { label: '', text: 'echo hi' }],
    ['whitespace-only label', { label: '   ', text: 'echo hi' }],
    ['label over 12 characters', { label: 'x'.repeat(13), text: 'echo hi' }],
    ['missing text', { label: 'x' }],
    ['empty text', { label: 'x', text: '' }],
    ['text over 256 characters', { label: 'x', text: 'y'.repeat(257) }],
    ['sendEnter of the wrong type', { label: 'x', text: 'y', sendEnter: 'yes' }],
    ['a non-object body', ['not', 'an', 'object']],
  ]

  for (const [name, payload] of bad) {
    it(`rejects ${name}`, async () => {
      const { status, body } = await api('/api/quickkeys', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      assert.equal(status, 400, JSON.stringify(body))
      assert.equal(body.error.code, 'invalid_request')
    })
  }

  it('accepts a label exactly at the limit', async () => {
    await clearKeys()
    const body = await createKey({ label: 'x'.repeat(12), text: 'echo hi' })
    assert.equal(body.keys[0].label.length, 12)
  })

  it('accepts text exactly at the limit', async () => {
    await clearKeys()
    const body = await createKey({ label: 'x', text: 'y'.repeat(256) })
    assert.equal(body.keys[0].text.length, 256)
  })
})

describe('the cap', () => {
  before(clearKeys)

  it(`refuses the ${MAX_KEYS + 1}th key, and allows one again after a delete`, async () => {
    const created = []
    for (let i = 0; i < MAX_KEYS; i += 1) {
      const body = await createKey({ label: `k${i}`, text: `echo ${i}` })
      created.push(body.keys.find((k) => k.label === `k${i}`))
    }

    const overflow = await api('/api/quickkeys', {
      method: 'POST',
      body: JSON.stringify({ label: 'one-too-many', text: 'echo nope' }),
    })
    assert.equal(overflow.status, 409)
    assert.equal(overflow.body.error.code, 'quick_key_limit')

    // Refused, not silently dropped: the list is still exactly at the cap.
    const { body: after } = await api('/api/quickkeys')
    assert.equal(after.keys.length, MAX_KEYS)

    await api(`/api/quickkeys/${created[0].id}`, { method: 'DELETE' })
    const retry = await api('/api/quickkeys', {
      method: 'POST',
      body: JSON.stringify({ label: 'fits', text: 'echo ok' }),
    })
    assert.equal(retry.status, 201)
    assert.equal(retry.body.keys.length, MAX_KEYS)
  })
})
