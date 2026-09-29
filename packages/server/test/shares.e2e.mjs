/**
 * End-to-end verification of the public share links.
 *
 * The share surface is the only part of webmux a visitor reaches without a
 * cookie, so these tests are written the opposite way round from every other
 * suite here: the interesting cases are the ones with **no** session, and the
 * owner routes are the ones that should be locked.
 *
 * Note what the 401 array below deliberately does NOT contain: `/s/*`. Those
 * routes must answer an anonymous visitor, and adding them to that array would
 * teach the next person exactly the wrong rule.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { bufferSource, parseArchive } from '../src/fs/zip/read.ts'

const PORT = 8201
const BASE = `http://127.0.0.1:${PORT}`
const PASSWORD = 'shares-e2e-password'
const TMUX_SOCKET = 'webmux-shares-e2e'

let tmp
let dataDir
let root
let outside
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

function ownerHeaders(extra = {}) {
  return { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra }
}

async function api(pathname, init = {}) {
  const res = await fetch(`${BASE}${pathname}`, { ...init, headers: ownerHeaders(init.headers) })
  for (const c of res.headers.getSetCookie?.() ?? []) {
    if (c.startsWith('webmux_session=')) cookie = c.split(';')[0]
  }
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers }
}

/** No cookie, ever. This is the visitor. */
function anon(pathname, init = {}) {
  return fetch(`${BASE}${pathname}`, init)
}

async function createShare(input) {
  const { status, body } = await api('/api/shares', { method: 'POST', body: JSON.stringify(input) })
  assert.equal(status, 201, JSON.stringify(body))
  return body
}

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'webmux-shares-e2e-'))
  dataDir = path.join(tmp, 'data')
  root = path.join(tmp, 'root')
  outside = path.join(tmp, 'outside')
  mkdirSync(path.join(root, 'folder'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  mkdirSync(dataDir, { recursive: true })

  writeFileSync(path.join(root, 'hello.txt'), 'hello from a share')
  writeFileSync(path.join(root, 'folder', 'inner.txt'), 'inner')
  writeFileSync(path.join(root, 'folder', '中文 文件.txt'), 'chinese')
  writeFileSync(path.join(outside, 'canary.txt'), 'CANARY')
  writeFileSync(
    path.join(dataDir, 'config.json'),
    // A distinctive root name on purpose: the assertion below checks it never
    // reaches the page, and a fixture called "root" would collide with the
    // `:root` selector in the page's own stylesheet.
    JSON.stringify({ files: { roots: [{ name: 'myfiles', path: root }] } }),
  )

  server = startServer()
  await waitForServer()
  const res = await api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) })
  assert.equal(res.status, 200)
})

/**
 * Waits for the child to actually exit.
 *
 * A fixed sleep is not enough: the server can outlive the test run and keep
 * holding the port, so the *next* run fails to bind — which surfaces as a file
 * reporting "0 tests, 0 failures" rather than as anything that names the cause.
 */
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

describe('owner routes require authentication', () => {
  // `/s/*` is deliberately absent: those are the public routes, and listing them
  // here would assert the opposite of what P3 is for.
  for (const [method, route] of [
    ['GET', '/api/shares'],
    ['POST', '/api/shares'],
    ['DELETE', '/api/shares/00000000-0000-0000-0000-000000000000'],
    ['POST', '/api/shares/00000000-0000-0000-0000-000000000000/regenerate'],
  ]) {
    it(`${method} ${route} -> 401`, async () => {
      const res = await anon(route, { method, headers: { 'content-type': 'application/json' } })
      assert.equal(res.status, 401)
    })
  }
})

describe('a public link needs no cookie', () => {
  let share

  before(async () => {
    share = await createShare({ path: path.join(root, 'hello.txt'), expiresInHours: 1 })
  })

  it('is the whole point: the page loads anonymously', async () => {
    const res = await anon(`/s/${share.token}`)
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.ok(html.includes('hello.txt'))
    // Nothing above the shared basename leaks.
    assert.equal(html.includes(root), false, 'the absolute path must not appear')
    assert.equal(html.includes('myfiles'), false, 'the root name must not appear')
  })

  it('serves the bytes anonymously, byte for byte', async () => {
    const res = await anon(`/s/${share.token}/raw`)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'hello from a share')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    // A `.txt` is on the preview allowlist, so it renders inline as text/plain —
    // the same policy the internal preview route uses, and `nosniff` plus
    // `text/plain` is what makes it safe. See the `.bin` case below for the
    // other side of that decision.
    assert.match(res.headers.get('content-disposition'), /^inline/)
    assert.match(res.headers.get('content-type'), /^text\/plain/)
  })

  it('falls back to an attachment for a type it will not render', async () => {
    const binary = path.join(root, 'blob.bin')
    writeFileSync(binary, Buffer.from([0, 1, 2, 3]))
    const share = await createShare({ path: binary, expiresInHours: 1 })

    const res = await anon(`/s/${share.token}/raw`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-disposition'), /^attachment/)
    assert.equal((await res.arrayBuffer()).byteLength, 4)

    rmSync(binary)
  })

  it('never exposes the token through the owner list', async () => {
    const res = await anon('/api/shares', { headers: ownerHeaders() })
    const raw = await res.text()
    assert.equal(res.status, 200)
    // The entire reason the column is a hash.
    assert.equal(raw.includes(share.token), false, 'GET /api/shares must not contain the token')
    assert.equal(JSON.parse(raw).shares.length >= 1, true)
  })

  it('sends security headers on the page', async () => {
    const res = await anon(`/s/${share.token}`)
    const csp = res.headers.get('content-security-policy') ?? ''
    assert.match(csp, /default-src 'none'/)
    assert.match(csp, /form-action 'self'/)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(res.headers.get('cache-control'), 'no-store')
  })

  it('answers unknown, malformed and traversing tokens identically', async () => {
    const unknown = await anon(`/s/${'a'.repeat(43)}`)
    const malformed = await anon('/s/short')
    const traversal = await anon('/s/..%2f..%2fetc%2fpasswd')
    // A 400 for the wrong shape and a 404 for the right one would be a
    // bulk-validity oracle for free.
    assert.equal(unknown.status, 404)
    assert.equal(malformed.status, 404)
    assert.equal(traversal.status, 404)
  })

  it('does not expose the SPA for a share URL', async () => {
    // Proves the parametric route wins over the static wildcard and the SPA
    // fallback, rather than index.html being served with a 200.
    const res = await anon(`/s/${'a'.repeat(43)}`)
    const html = await res.text()
    assert.equal(html.includes('<div id="root">'), false)
    assert.ok(html.includes('<!doctype html>'))
  })
})

describe('revocation and expiry', () => {
  it('revoking kills both the page and the raw route', async () => {
    const share = await createShare({ path: path.join(root, 'hello.txt'), expiresInHours: 1 })
    assert.equal((await anon(`/s/${share.token}/raw`)).status, 200)

    const revoked = await api(`/api/shares/${share.id}`, { method: 'DELETE' })
    assert.equal(revoked.status, 204)

    const page = await anon(`/s/${share.token}`)
    assert.equal(page.status, 410)
    const raw = await anon(`/s/${share.token}/raw`)
    assert.equal(raw.status, 410)
    assert.equal(raw.headers.get('x-webmux-error'), 'revoked')
  })

  it('reports a share whose file is gone as source_unavailable, not 404', async () => {
    const doomed = path.join(root, 'doomed.txt')
    writeFileSync(doomed, 'temporary')
    const share = await createShare({ path: doomed, expiresInHours: 1 })

    rmSync(doomed)
    const raw = await anon(`/s/${share.token}/raw`)
    assert.equal(raw.status, 410)
    assert.equal(raw.headers.get('x-webmux-error'), 'source_unavailable')

    // The owner learns before the visitor does.
    const list = await api('/api/shares')
    assert.equal(list.body.shares.find((s) => s.id === share.id).available, false)
  })

  it('reports an expired share as 410', async () => {
    const share = await createShare({ path: path.join(root, 'hello.txt'), expiresInHours: 1 })
    // Backdate it through a second connection; WAL allows it.
    const { default: Database } = await import('better-sqlite3')
    const db = new Database(path.join(dataDir, 'webmux.db'))
    db.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, share.id)
    db.close()

    const raw = await anon(`/s/${share.token}/raw`)
    assert.equal(raw.status, 410)
    assert.equal(raw.headers.get('x-webmux-error'), 'expired')
  })
})

describe('the download cap', () => {
  it('stops serving once the cap is reached', async () => {
    const share = await createShare({
      path: path.join(root, 'hello.txt'),
      expiresInHours: 1,
      maxDownloads: 2,
    })
    assert.equal((await anon(`/s/${share.token}/raw`)).status, 200)
    assert.equal((await anon(`/s/${share.token}/raw`)).status, 200)
    const third = await anon(`/s/${share.token}/raw`)
    assert.equal(third.status, 410)
    assert.equal(third.headers.get('x-webmux-error'), 'exhausted')
  })

  it('lets exactly one of ten concurrent requests through when the cap is 1', async () => {
    // The test that fails against a read-then-write. Between the SELECT and the
    // UPDATE the route awaits, so every concurrent request would read 0, every
    // one would proceed, and for `maxDownloads: 1` the control would be
    // *entirely* defeated rather than off by one.
    const share = await createShare({
      path: path.join(root, 'hello.txt'),
      expiresInHours: 1,
      maxDownloads: 1,
    })

    const results = await Promise.all(
      Array.from({ length: 10 }, () => anon(`/s/${share.token}/raw`)),
    )
    const ok = results.filter((res) => res.status === 200)
    // Drain the bodies so the sockets are released.
    await Promise.all(results.map((res) => res.text().catch(() => '')))

    assert.equal(ok.length, 1, `expected exactly one 200, got ${ok.length}`)

    const list = await api('/api/shares')
    assert.equal(list.body.shares.find((s) => s.id === share.id).downloads, 1)
  })

  it('does not spend the cap on a Range that skips the start', async () => {
    const share = await createShare({
      path: path.join(root, 'hello.txt'),
      expiresInHours: 1,
      maxDownloads: 1,
    })

    // A resume or a video seek must not consume the allowance.
    const resumed = await anon(`/s/${share.token}/raw`, { headers: { range: 'bytes=4-' } })
    assert.equal(resumed.status, 206)
    await resumed.text()

    const list = await api('/api/shares')
    assert.equal(list.body.shares.find((s) => s.id === share.id).downloads, 0)

    // ...but a fresh download does.
    assert.equal((await anon(`/s/${share.token}/raw`)).status, 200)
    const after = await api('/api/shares')
    assert.equal(after.body.shares.find((s) => s.id === share.id).downloads, 1)
  })
})

describe('password protection', () => {
  let share

  before(async () => {
    share = await createShare({
      path: path.join(root, 'hello.txt'),
      expiresInHours: 1,
      password: 'correct-horse-battery',
    })
  })

  it('shows only the form until the password is given', async () => {
    const res = await anon(`/s/${share.token}`)
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.ok(html.includes('name="password"'))
    // Never the listing, never the size — otherwise the password is theatre.
    assert.equal(html.includes('hello from a share'), false)
    assert.equal(html.includes('下载'), false)
  })

  it('refuses /raw with 401 while locked', async () => {
    const res = await anon(`/s/${share.token}/raw`)
    assert.equal(res.status, 401)
    assert.equal(res.headers.get('x-webmux-error'), 'password_required')
  })

  it('rejects a wrong password without setting a cookie', async () => {
    const res = await anon(`/s/${share.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'not-the-password' }),
      redirect: 'manual',
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.getSetCookie().length, 0)
    assert.ok((await res.text()).includes('密码不正确'))
  })

  it('accepts the right password and scopes the cookie to this share only', async () => {
    const res = await anon(`/s/${share.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'correct-horse-battery' }),
      redirect: 'manual',
    })
    assert.equal(res.status, 303)

    const setCookies = res.headers.getSetCookie()
    assert.equal(setCookies.length, 1)
    const raw = setCookies[0]

    assert.match(raw, /HttpOnly/)
    assert.match(raw, /SameSite=Lax/)
    // The exact token, never "/s" — with "/s" one unlock would open every share
    // on the instance, and that is invisible in a single-share test.
    assert.ok(
      raw.includes(`Path=/s/${share.token}`),
      `cookie path must be the exact token, got: ${raw}`,
    )
    assert.equal(raw.includes('Path=/s;'), false)

    const justTheCookie = raw.split(';')[0]
    const unlocked = await anon(`/s/${share.token}/raw`, { headers: { cookie: justTheCookie } })
    assert.equal(unlocked.status, 200)
    assert.equal(await unlocked.text(), 'hello from a share')
  })

  it("refuses another share's cookie", async () => {
    const other = await createShare({
      path: path.join(root, 'folder', 'inner.txt'),
      expiresInHours: 1,
      password: 'another-password-here',
    })

    // Get a valid cookie for `share`, then present it to `other`.
    const unlock = await anon(`/s/${share.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'correct-horse-battery' }),
      redirect: 'manual',
    })
    const stolen = unlock.headers.getSetCookie()[0].split(';')[0]

    const res = await anon(`/s/${other.token}/raw`, { headers: { cookie: stolen } })
    assert.equal(res.status, 401)
  })

  it('refuses a forged cookie', async () => {
    const res = await anon(`/s/${share.token}/raw`, {
      headers: { cookie: 'webmux_share=not.a.real.jwt' },
    })
    assert.equal(res.status, 401)
  })
})

describe('filenames cannot escape the page', () => {
  it('escapes a hostile filename in the listing', async () => {
    const hostile = path.join(root, 'folder', '<img src=x onerror=alert(1)>.txt')
    writeFileSync(hostile, 'x')
    const share = await createShare({ path: path.join(root, 'folder'), expiresInHours: 1 })

    const res = await anon(`/s/${share.token}`)
    assert.equal(res.status, 200)
    const html = await res.text()

    assert.equal(html.includes('<img src=x'), false, 'raw markup must not reach the page')
    assert.ok(html.includes('&lt;img src=x'), 'it must appear escaped instead')
    // And the absolute path is nowhere near it.
    assert.equal(html.includes(root), false)

    rmSync(hostile)
  })

  it('escapes a hostile name containing quotes and ampersands', async () => {
    const nasty = path.join(root, 'folder', `"&'<b>.txt`)
    writeFileSync(nasty, 'x')
    const share = await createShare({ path: path.join(root, 'folder'), expiresInHours: 1 })

    const html = await (await anon(`/s/${share.token}`)).text()
    assert.equal(html.includes('<b>'), false)
    assert.ok(html.includes('&amp;'))
    assert.ok(html.includes('&quot;') || html.includes('&#39;'))

    rmSync(nasty)
  })
})

describe('directory shares', () => {
  it('lists one level and offers a zip', async () => {
    const share = await createShare({ path: path.join(root, 'folder'), expiresInHours: 1 })

    const page = await anon(`/s/${share.token}`)
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.ok(html.includes('inner.txt'))
    assert.ok(html.includes('中文 文件.txt'))
    assert.ok(html.includes('打包下载'))

    const raw = await anon(`/s/${share.token}/raw`)
    assert.equal(raw.status, 200)
    assert.equal(raw.headers.get('content-type'), 'application/zip')
    assert.equal(raw.headers.get('x-content-type-options'), 'nosniff')
    // No validator, no ranges — the same reasoning as the internal archive route.
    assert.equal(raw.headers.get('etag'), null)
    assert.equal(raw.headers.get('content-length'), null)

    // Readable by our own reader, which the interop suite already proved is
    // readable by unzip and Python's zipfile.
    const archive = Buffer.from(await raw.arrayBuffer())
    const entries = await parseArchive(bufferSource(archive))
    const names = entries.map((entry) => entry.path).sort()
    // Including `folder` itself: the archive keeps the shared directory as its
    // top-level entry, so extracting it reproduces the tree rather than spilling
    // the contents into the destination.
    assert.deepEqual(names, ['folder', 'folder/inner.txt', 'folder/中文 文件.txt'])
  })
})

describe('bandwidth throttling', () => {
  it('actually paces the socket', async () => {
    const target = path.join(root, 'paced.bin')
    writeFileSync(target, Buffer.alloc(16 * 1024, 7))
    const share = await createShare({
      path: target,
      expiresInHours: 1,
      rateLimitBytesPerSec: 16 * 1024,
    })

    const started = Date.now()
    const res = await anon(`/s/${share.token}/raw`)
    const body = Buffer.from(await res.arrayBuffer())
    const elapsed = Date.now() - started

    assert.equal(res.status, 200)
    assert.equal(body.length, 16 * 1024)
    // 16 KiB at 16 KiB/s is one second. A unit test cannot prove the socket is
    // paced; only this can.
    assert.ok(elapsed >= 800, `expected pacing, took ${elapsed}ms`)

    rmSync(target)
  })

  it('does not slow down an unthrottled share', async () => {
    const target = path.join(root, 'fast.bin')
    writeFileSync(target, Buffer.alloc(256 * 1024, 7))
    const share = await createShare({ path: target, expiresInHours: 1 })

    const started = Date.now()
    const res = await anon(`/s/${share.token}/raw`)
    await res.arrayBuffer()
    assert.ok(Date.now() - started < 1000, 'an unthrottled share must not be paced')

    rmSync(target)
  })
})

describe('regenerate', () => {
  it('issues a new token, invalidates the old one, and is one request', async () => {
    const share = await createShare({ path: path.join(root, 'hello.txt'), expiresInHours: 1 })
    assert.equal((await anon(`/s/${share.token}/raw`)).status, 200)

    const regen = await api(`/api/shares/${share.id}/regenerate`, { method: 'POST' })
    assert.equal(regen.status, 201)
    assert.notEqual(regen.body.token, share.token)

    assert.equal((await anon(`/s/${share.token}/raw`)).status, 410, 'the old link must be dead')
    assert.equal((await anon(`/s/${regen.body.token}/raw`)).status, 200, 'the new link must work')

    // Policy carried over.
    assert.equal(regen.body.maxDownloads, share.maxDownloads)
  })

  it('refuses to regenerate a revoked share', async () => {
    const share = await createShare({ path: path.join(root, 'hello.txt'), expiresInHours: 1 })
    await api(`/api/shares/${share.id}`, { method: 'DELETE' })
    const res = await api(`/api/shares/${share.id}/regenerate`, { method: 'POST' })
    assert.equal(res.status, 404)
  })
})

describe('creation guards', () => {
  it('refuses a path outside every root, and the reserved data directory', async () => {
    const escaped = await api('/api/shares', {
      method: 'POST',
      body: JSON.stringify({ path: path.join(outside, 'canary.txt') }),
    })
    assert.equal(escaped.status, 403)

    const reserved = await api('/api/shares', {
      method: 'POST',
      body: JSON.stringify({ path: path.join(dataDir, 'config.json') }),
    })
    assert.equal(reserved.status, 403)
  })

  it('refuses a short password', async () => {
    const res = await api('/api/shares', {
      method: 'POST',
      body: JSON.stringify({ path: path.join(root, 'hello.txt'), password: 'short' }),
    })
    assert.equal(res.status, 400)
  })

  it('treats an absent expiry as the default, and an explicit null as never', async () => {
    const withDefault = await createShare({ path: path.join(root, 'hello.txt') })
    assert.notEqual(withDefault.expiresAt, null)

    const never = await createShare({ path: path.join(root, 'hello.txt'), expiresInHours: null })
    assert.equal(never.expiresAt, null)
  })
})
