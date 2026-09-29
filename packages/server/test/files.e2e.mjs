/**
 * End-to-end verification of the file subsystem, against a real server and a
 * real filesystem.
 *
 * The jail has its own suite (`jail.test.mjs`) for the resolver in isolation.
 * This one covers what only a live server can: that every route is actually
 * behind `requireAuth`, that the URL and query parsers do not open a way past
 * the jail, that a download's headers and bytes agree, and that a resumable
 * upload reconstructs a file byte for byte.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { deflateRawSync } from 'node:zlib'
import { buildZip } from './zip.helpers.mjs'

const PORT = 8200
const BASE = `http://127.0.0.1:${PORT}`
const PASSWORD = 'files-e2e-password'
const TMUX_SOCKET = 'webmux-files-e2e'

let tmp
let dataDir
let HOME_ROOT
let RO_ROOT
let OUTSIDE
let server
let cookie

const CHUNK_GUESS = 4 * 1024 * 1024

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

async function stopServer() {
  if (!server) return
  server.kill('SIGTERM')
  await new Promise((resolve) => {
    server.once('exit', resolve)
    setTimeout(resolve, 5000)
  })
  server = null
}

function headers(extra = {}) {
  return {
    'content-type': 'application/json',
    ...(cookie ? { cookie } : {}),
    ...extra,
  }
}

async function api(pathname, init = {}) {
  const res = await fetch(`${BASE}${pathname}`, { ...init, headers: headers(init.headers) })
  const setCookie = res.headers.getSetCookie?.() ?? []
  for (const c of setCookie) {
    if (c.startsWith('webmux_session=')) cookie = c.split(';')[0]
  }
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

/** Unauthenticated, for the per-route auth regression. */
async function anon(pathname, init = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  return res.status
}

function url(p) {
  return encodeURIComponent(p)
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('base64')
}

async function putChunk(id, offset, buf, { checksum } = {}) {
  const res = await fetch(`${BASE}/api/fs/upload/${id}/chunk?offset=${offset}`, {
    method: 'PUT',
    headers: headers({
      'content-type': 'application/octet-stream',
      'x-chunk-sha256': checksum ?? sha256(buf),
    }),
    body: buf,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

// ---------------------------------------------------------------------------

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'webmux-files-e2e-'))
  HOME_ROOT = path.join(tmp, 'home')
  RO_ROOT = path.join(tmp, 'ro')
  OUTSIDE = path.join(tmp, 'outside')
  // Inside the writable root, exactly as the default `$HOME` configuration has
  // it. That is what makes the reserved-path refusal load-bearing rather than
  // theoretical: containment alone would happily serve the database holding
  // the token signing secret.
  dataDir = path.join(HOME_ROOT, '.webmux-data')

  mkdirSync(path.join(HOME_ROOT, 'sub'), { recursive: true })
  mkdirSync(path.join(HOME_ROOT, 'many'), { recursive: true })
  mkdirSync(RO_ROOT, { recursive: true })
  mkdirSync(path.join(OUTSIDE, 'precious'), { recursive: true })
  mkdirSync(dataDir, { recursive: true })

  writeFileSync(path.join(HOME_ROOT, 'hello.txt'), 'hello world')
  writeFileSync(path.join(HOME_ROOT, 'sub', 'inner.txt'), 'inner')
  writeFileSync(path.join(HOME_ROOT, '中文 文件.txt'), 'chinese')
  writeFileSync(path.join(RO_ROOT, 'sealed.txt'), 'sealed')
  writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'secret')
  writeFileSync(path.join(OUTSIDE, 'precious', 'keep.txt'), 'do-not-delete')
  for (let i = 1; i <= 25; i += 1) {
    writeFileSync(path.join(HOME_ROOT, 'many', `f${String(i).padStart(2, '0')}.txt`), 'x')
  }

  // A link out of the jail, and a link to a directory that must not be
  // descended into by a recursive delete.
  symlinkSync(OUTSIDE, path.join(HOME_ROOT, 'link-out'))
  symlinkSync(path.join(OUTSIDE, 'secret.txt'), path.join(HOME_ROOT, 'link-secret'))

  chmodSync(RO_ROOT, 0o555)

  // `readConfigFile` looks in the data directory first, so the roots can be
  // configured per test run without environment variables.
  writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      files: {
        roots: [
          { name: 'home', path: HOME_ROOT },
          { name: 'ro', path: RO_ROOT, readonly: true },
          { name: 'gone', path: path.join(tmp, 'not-mounted') },
        ],
      },
    }),
  )

  server = startServer()
  await waitForServer()

  const res = await api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) })
  assert.equal(res.status, 200, 'setup should succeed')
})

after(async () => {
  await stopServer()
  if (RO_ROOT) chmodSync(RO_ROOT, 0o755)
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('roots', () => {
  it('reports every configured root, including unusable ones', async () => {
    const { status, body } = await api('/api/fs/roots')
    assert.equal(status, 200)

    const byName = Object.fromEntries(body.roots.map((r) => [r.name, r]))
    assert.equal(byName.home.available, true)
    assert.equal(byName.home.readonly, false)
    assert.equal(byName.ro.available, true)
    assert.equal(byName.ro.readonly, true)
    // A root that cannot be resolved stays visible with a reason, rather than
    // vanishing from the UI with no explanation.
    assert.equal(byName.gone.available, false)
    assert.ok(byName.gone.unavailableReason)
  })

  it('reports canonical paths', async () => {
    const { body } = await api('/api/fs/roots')
    const home = body.roots.find((r) => r.name === 'home')
    assert.equal(home.path, realpathSync(HOME_ROOT))
  })

  it('requires authentication', async () => {
    assert.equal(await anon('/api/fs/roots'), 401)
  })
})

describe('authentication is required on every fs route', () => {
  // Per-route `preHandler` is easy to forget on a new route, and the
  // consequence is an unauthenticated file API. This is the cheapest guard.
  const routes = [
    ['GET', '/api/fs/roots'],
    ['GET', `/api/fs/list?path=${url('/')}`],
    ['GET', `/api/fs/stat?path=${url('/')}`],
    ['GET', `/api/fs/download?path=${url('/')}`],
    ['POST', '/api/fs/mkdir'],
    ['POST', '/api/fs/rename'],
    ['DELETE', `/api/fs?path=${url('/')}`],
    ['GET', `/api/fs/preview?path=${url('/')}`],
    ['GET', `/api/fs/archive?path=${url('/')}`],
    ['POST', '/api/fs/touch'],
    ['PUT', '/api/fs/content'],
    ['POST', '/api/fs/extract'],
    ['POST', '/api/fs/upload/init'],
    ['GET', '/api/fs/upload/aaaaaaaaaaaaaaaaaaaaaa'],
    ['PUT', '/api/fs/upload/aaaaaaaaaaaaaaaaaaaaaa/chunk?offset=0'],
    ['POST', '/api/fs/upload/aaaaaaaaaaaaaaaaaaaaaa/complete'],
    ['DELETE', '/api/fs/upload/aaaaaaaaaaaaaaaaaaaaaa'],
  ]

  for (const [method, route] of routes) {
    it(`${method} ${route.split('?')[0]} -> 401`, async () => {
      assert.equal(await anon(route, { method }), 401)
    })
  }
})

describe('listing', () => {
  it('lists a directory with directories first', async () => {
    const { status, body } = await api(`/api/fs/list?path=${url(HOME_ROOT)}`)
    assert.equal(status, 200)
    assert.equal(body.readonly, false)
    assert.equal(body.root, 'home')

    const names = body.entries.map((e) => e.name)
    assert.ok(names.includes('hello.txt'))
    assert.ok(names.includes('中文 文件.txt'))

    // Directories lead regardless of the sort key.
    const kinds = body.entries.map((e) => e.kind)
    const lastDir = kinds.lastIndexOf('dir')
    const firstNonDir = kinds.findIndex((k) => k !== 'dir')
    if (lastDir !== -1 && firstNonDir !== -1) {
      assert.ok(lastDir < firstNonDir, 'directories should sort before files')
    }
  })

  it('reports size and kind', async () => {
    const { body } = await api(`/api/fs/list?path=${url(HOME_ROOT)}`)
    const hello = body.entries.find((e) => e.name === 'hello.txt')
    assert.equal(hello.kind, 'file')
    assert.equal(hello.size, 'hello world'.length)
    assert.equal(hello.path, path.join(realpathSync(HOME_ROOT), 'hello.txt'))

    const sub = body.entries.find((e) => e.name === 'sub')
    assert.equal(sub.kind, 'dir')
  })

  it('marks hidden entries and filters them on request', async () => {
    writeFileSync(path.join(HOME_ROOT, '.hidden.txt'), 'shh')

    const all = await api(`/api/fs/list?path=${url(HOME_ROOT)}`)
    const hidden = all.body.entries.find((e) => e.name === '.hidden.txt')
    assert.ok(hidden, 'hidden files are listed by default — this is a shell-adjacent tool')
    assert.equal(hidden.hidden, true)

    const filtered = await api(`/api/fs/list?path=${url(HOME_ROOT)}&showHidden=0`)
    assert.equal(filtered.body.entries.some((e) => e.name === '.hidden.txt'), false)

    rmSync(path.join(HOME_ROOT, '.hidden.txt'))
  })

  it('sorts by size', async () => {
    const { body } = await api(`/api/fs/list?path=${url(HOME_ROOT)}&sort=size`)
    assert.equal(body.nextCursor, null)
    const files = body.entries.filter((e) => e.kind === 'file')
    const sizes = files.map((e) => e.size)
    assert.deepEqual(sizes, [...sizes].sort((a, b) => a - b))
  })

  it('rejects an unknown sort key', async () => {
    const { status } = await api(`/api/fs/list?path=${url(HOME_ROOT)}&sort=colour`)
    assert.equal(status, 400)
  })

  it('pages through a directory without repeating or dropping entries', async () => {
    const seen = []
    let cursor = null
    let pages = 0

    do {
      const query = `/api/fs/list?path=${url(path.join(HOME_ROOT, 'many'))}&limit=10${
        cursor ? `&cursor=${url(cursor)}` : ''
      }`
      const { status, body } = await api(query)
      assert.equal(status, 200)
      assert.equal(body.total, 25)
      seen.push(...body.entries.map((e) => e.name))
      cursor = body.nextCursor
      pages += 1
      assert.ok(pages < 10, 'pagination should terminate')
    } while (cursor)

    assert.equal(seen.length, 25)
    assert.equal(new Set(seen).size, 25, 'no entry may appear twice')
    assert.deepEqual(seen, [...seen].sort(), 'name order should hold across pages')
  })

  it('rejects a forged cursor', async () => {
    const { status } = await api(
      `/api/fs/list?path=${url(HOME_ROOT)}&cursor=${url(Buffer.from('{"n":1}').toString('base64url'))}`,
    )
    assert.equal(status, 400)
  })

  it('reports a file as not a directory and a missing path as 404', async () => {
    const asFile = await api(`/api/fs/list?path=${url(path.join(HOME_ROOT, 'hello.txt'))}`)
    assert.equal(asFile.status, 400)
    assert.equal(asFile.body.error.code, 'not_a_directory')

    const missing = await api(`/api/fs/list?path=${url(path.join(HOME_ROOT, 'nope'))}`)
    assert.equal(missing.status, 404)
  })
})

describe('path attacks over HTTP', () => {
  // The URL and query parsers sit in front of the jail, so these are the
  // vectors that never reach the resolver in a unit test.
  const attacks = [
    '/etc/passwd',
    '/etc',
    '../../../etc/passwd',
    '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    `${HOME_ROOT}/../outside/secret.txt`,
    `${HOME_ROOT}/link-out/secret.txt`,
    `${HOME_ROOT}/link-secret`,
  ]

  for (const attack of attacks) {
    it(`refuses list of ${attack}`, async () => {
      const { status } = await api(`/api/fs/list?path=${url(attack)}`)
      assert.ok(status === 403 || status === 400, `expected refusal, got ${status}`)
    })

    it(`refuses download of ${attack}`, async () => {
      const { status } = await api(`/api/fs/download?path=${url(attack)}`)
      assert.ok(status === 403 || status === 400, `expected refusal, got ${status}`)
    })
  }

  it('refuses a NUL byte', async () => {
    const { status } = await api(`/api/fs/list?path=${url(`${HOME_ROOT}/hello.txt\0.png`)}`)
    assert.ok(status === 400 || status === 404, `expected refusal, got ${status}`)
  })

  it('refuses the reserved data directory even though the root contains it', async () => {
    // dataDir sits inside the `home` root here, just as it does under the
    // default $HOME configuration, so containment alone would allow this.
    for (const name of ['webmux.db', 'config.json']) {
      const res = await api(`/api/fs/download?path=${url(path.join(dataDir, name))}`)
      assert.equal(res.status, 403, `${name} must not be downloadable`)
      assert.equal(res.body.error.code, 'forbidden_path')
    }

    const listing = await api(`/api/fs/list?path=${url(dataDir)}`)
    assert.equal(listing.status, 403)

    const mkdir = await api('/api/fs/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path: path.join(dataDir, 'planted') }),
    })
    assert.equal(mkdir.status, 403)
  })

  it('does not answer 404 for a non-existent path outside every root', async () => {
    // 404 here would distinguish "absent" from "present" for arbitrary
    // filesystem paths, which is an existence oracle.
    const { status, body } = await api(`/api/fs/list?path=${url('/etc/definitely-not-here-12345')}`)
    assert.equal(status, 403)
    assert.equal(body.error.code, 'path_escape')
  })
})

describe('stat', () => {
  it('describes a file', async () => {
    const { status, body } = await api(`/api/fs/stat?path=${url(path.join(HOME_ROOT, 'hello.txt'))}`)
    assert.equal(status, 200)
    assert.equal(body.kind, 'file')
    assert.equal(body.size, 11)
    assert.equal(body.readonly, false)
  })

  it('reports a symlink as a symlink, with its target when it stays inside', async () => {
    symlinkSync('hello.txt', path.join(HOME_ROOT, 'link-in'))

    const { body } = await api(`/api/fs/stat?path=${url(path.join(HOME_ROOT, 'link-in'))}`)
    assert.equal(body.kind, 'symlink')
    assert.equal(body.linkTarget, path.join(realpathSync(HOME_ROOT), 'hello.txt'))

    rmSync(path.join(HOME_ROOT, 'link-in'))
  })

  it('reports a readonly root', async () => {
    const { body } = await api(`/api/fs/stat?path=${url(path.join(RO_ROOT, 'sealed.txt'))}`)
    assert.equal(body.readonly, true)
  })
})

describe('download', () => {
  it('serves the whole file with safe headers', async () => {
    const res = await fetch(`${BASE}/api/fs/download?path=${url(path.join(HOME_ROOT, 'hello.txt'))}`, {
      headers: headers(),
    })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'hello world')
    assert.equal(res.headers.get('accept-ranges'), 'bytes')
    assert.equal(res.headers.get('content-length'), '11')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    // Always an attachment: the SPA shares this origin, so an inline HTML
    // upload would be same-origin script execution.
    assert.match(res.headers.get('content-disposition'), /^attachment;/)
  })

  it('honours a byte range', async () => {
    const res = await fetch(`${BASE}/api/fs/download?path=${url(path.join(HOME_ROOT, 'hello.txt'))}`, {
      headers: headers({ range: 'bytes=6-10' }),
    })
    assert.equal(res.status, 206)
    assert.equal(await res.text(), 'world')
    assert.equal(res.headers.get('content-range'), 'bytes 6-10/11')
    assert.equal(res.headers.get('content-length'), '5')
  })

  it('honours a suffix range', async () => {
    const res = await fetch(`${BASE}/api/fs/download?path=${url(path.join(HOME_ROOT, 'hello.txt'))}`, {
      headers: headers({ range: 'bytes=-5' }),
    })
    assert.equal(res.status, 206)
    assert.equal(await res.text(), 'world')
  })

  it('answers 416 for an unsatisfiable range, not 500', async () => {
    const res = await fetch(`${BASE}/api/fs/download?path=${url(path.join(HOME_ROOT, 'hello.txt'))}`, {
      headers: headers({ range: 'bytes=999-1000' }),
    })
    assert.equal(res.status, 416)
    assert.equal(res.headers.get('content-range'), 'bytes */11')
    // The JSON error must not go out under the file's content type.
    assert.match(res.headers.get('content-type'), /application\/json/)
  })

  it('ignores a malformed range and sends the whole entity', async () => {
    const res = await fetch(`${BASE}/api/fs/download?path=${url(path.join(HOME_ROOT, 'hello.txt'))}`, {
      headers: headers({ range: 'bytes=abc' }),
    })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'hello world')
  })

  it('encodes a non-ASCII filename for both filename and filename*', async () => {
    const res = await fetch(`${BASE}/api/fs/download?path=${url(path.join(HOME_ROOT, '中文 文件.txt'))}`, {
      headers: headers(),
    })
    const disposition = res.headers.get('content-disposition')
    // An ASCII-only client needs something usable; the stripped stem of a
    // Chinese name is empty, so the extension alone would be a useless name.
    assert.match(disposition, /filename="download\.txt"/)
    assert.match(disposition, /filename\*=UTF-8''%E4%B8%AD%E6%96%87/)
  })

  it('refuses a directory with a clear code', async () => {
    const res = await fetch(`${BASE}/api/fs/download?path=${url(HOME_ROOT)}`, { headers: headers() })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error.code, 'is_a_directory')
  })

  it('refuses a symlink that points outside the jail', async () => {
    const res = await fetch(`${BASE}/api/fs/download?path=${url(path.join(HOME_ROOT, 'link-secret'))}`, {
      headers: headers(),
    })
    assert.equal(res.status, 403)
  })
})

describe('mkdir', () => {
  it('creates a directory', async () => {
    const target = path.join(HOME_ROOT, 'created')
    const { status, body } = await api('/api/fs/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path: target }),
    })
    assert.equal(status, 201)
    assert.equal(body.kind, 'dir')
    assert.ok(statSync(target).isDirectory())
  })

  it('refuses to clobber an existing directory without recursive', async () => {
    const { status, body } = await api('/api/fs/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path: path.join(HOME_ROOT, 'created') }),
    })
    assert.equal(status, 409)
    assert.equal(body.error.code, 'already_exists')
  })

  it('treats a recursive mkdir of an existing directory as a no-op', async () => {
    const { status } = await api('/api/fs/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path: path.join(HOME_ROOT, 'created'), recursive: true }),
    })
    assert.equal(status, 200)
  })

  it('creates missing intermediate directories recursively', async () => {
    const target = path.join(HOME_ROOT, 'deep', 'a', 'b')
    const { status } = await api('/api/fs/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path: target, recursive: true }),
    })
    assert.equal(status, 201)
    assert.ok(statSync(target).isDirectory())
  })

  it('refuses a non-recursive mkdir whose parent is missing', async () => {
    const { status } = await api('/api/fs/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path: path.join(HOME_ROOT, 'x', 'y', 'z') }),
    })
    assert.equal(status, 404)
  })

  it('refuses a readonly root', async () => {
    const { status, body } = await api('/api/fs/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path: path.join(RO_ROOT, 'nope') }),
    })
    assert.equal(status, 403)
    assert.equal(body.error.code, 'readonly_root')
  })

  it('refuses to escape the jail', async () => {
    const { status } = await api('/api/fs/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path: path.join(OUTSIDE, 'evil'), recursive: true }),
    })
    assert.equal(status, 403)
  })
})

describe('rename', () => {
  it('renames a file', async () => {
    writeFileSync(path.join(HOME_ROOT, 'before.txt'), 'x')
    const { status, body } = await api('/api/fs/rename', {
      method: 'POST',
      body: JSON.stringify({
        from: path.join(HOME_ROOT, 'before.txt'),
        to: path.join(HOME_ROOT, 'after.txt'),
      }),
    })
    assert.equal(status, 200)
    assert.equal(body.name, 'after.txt')
  })

  it('refuses to overwrite without the flag', async () => {
    const { status, body } = await api('/api/fs/rename', {
      method: 'POST',
      body: JSON.stringify({
        from: path.join(HOME_ROOT, 'after.txt'),
        to: path.join(HOME_ROOT, 'hello.txt'),
      }),
    })
    assert.equal(status, 409)
    assert.equal(body.error.code, 'already_exists')
  })

  it('refuses a destination outside the jail', async () => {
    const { status } = await api('/api/fs/rename', {
      method: 'POST',
      body: JSON.stringify({
        from: path.join(HOME_ROOT, 'after.txt'),
        to: path.join(OUTSIDE, 'stolen.txt'),
      }),
    })
    assert.equal(status, 403)
  })

  it('renames a symlink itself rather than its target', async () => {
    symlinkSync(path.join(OUTSIDE, 'secret.txt'), path.join(HOME_ROOT, 'link-to-move'))
    const { status } = await api('/api/fs/rename', {
      method: 'POST',
      body: JSON.stringify({
        from: path.join(HOME_ROOT, 'link-to-move'),
        to: path.join(HOME_ROOT, 'link-moved'),
      }),
    })
    assert.equal(status, 200)
    // The link moved; the file it pointed at did not.
    assert.ok(lstatSync(path.join(HOME_ROOT, 'link-moved')).isSymbolicLink())
    assert.equal(readFileSync(path.join(OUTSIDE, 'secret.txt'), 'utf8'), 'secret')
  })
})

describe('delete', () => {
  it('deletes a file', async () => {
    writeFileSync(path.join(HOME_ROOT, 'doomed.txt'), 'x')
    const { status } = await api(`/api/fs?path=${url(path.join(HOME_ROOT, 'doomed.txt'))}`, {
      method: 'DELETE',
    })
    assert.equal(status, 204)
  })

  it('refuses a directory without recursive, and says so distinctly', async () => {
    mkdirSync(path.join(HOME_ROOT, 'tree', 'nested'), { recursive: true })
    writeFileSync(path.join(HOME_ROOT, 'tree', 'nested', 'file.txt'), 'x')

    const { status, body } = await api(`/api/fs?path=${url(path.join(HOME_ROOT, 'tree'))}`, {
      method: 'DELETE',
    })
    assert.equal(status, 409)
    assert.equal(body.error.code, 'requires_recursive')
  })

  it('deletes a directory recursively when asked', async () => {
    const { status } = await api(`/api/fs?path=${url(path.join(HOME_ROOT, 'tree'))}&recursive=true`, {
      method: 'DELETE',
    })
    assert.equal(status, 204)
  })

  it('can never delete a configured root', async () => {
    for (const target of [HOME_ROOT, RO_ROOT]) {
      const { status, body } = await api(`/api/fs?path=${url(target)}&recursive=true`, { method: 'DELETE' })
      assert.equal(status, 409)
      assert.equal(body.error.code, 'root_protected')
    }
    assert.ok(existsSync(HOME_ROOT) && existsSync(RO_ROOT))
  })

  it('refuses to delete inside a readonly root', async () => {
    const { status, body } = await api(`/api/fs?path=${url(path.join(RO_ROOT, 'sealed.txt'))}`, {
      method: 'DELETE',
    })
    assert.equal(status, 403)
    assert.equal(body.error.code, 'readonly_root')
  })

  it('does not follow a symlink out of the jail when deleting recursively', async () => {
    // The assumption worth pinning down: `rm -r` must unlink a symlink rather
    // than descend through it. If it descended, this would erase the outside
    // directory and the damage would be silent.
    mkdirSync(path.join(HOME_ROOT, 'victim'), { recursive: true })
    symlinkSync(OUTSIDE, path.join(HOME_ROOT, 'victim', 'escape'))

    const { status } = await api(`/api/fs?path=${url(path.join(HOME_ROOT, 'victim'))}&recursive=true`, {
      method: 'DELETE',
    })
    assert.equal(status, 204)

    const kept = readFileSync(path.join(OUTSIDE, 'precious', 'keep.txt'), 'utf8')
    assert.equal(kept, 'do-not-delete', 'recursive delete must not follow a symlink out of the root')
  })

  it('removes a symlink itself, leaving its target alone', async () => {
    symlinkSync(path.join(OUTSIDE, 'secret.txt'), path.join(HOME_ROOT, 'link-to-delete'))
    const { status } = await api(`/api/fs?path=${url(path.join(HOME_ROOT, 'link-to-delete'))}`, {
      method: 'DELETE',
    })
    assert.equal(status, 204)
    assert.equal(readFileSync(path.join(OUTSIDE, 'secret.txt'), 'utf8'), 'secret')
  })
})

describe('resumable upload', () => {
  /** Opens an upload and returns the id and the server's chosen chunk size. */
  async function init(target, size) {
    const { status, body } = await api('/api/fs/upload/init', {
      method: 'POST',
      body: JSON.stringify({ path: target, size }),
    })
    assert.equal(status, 201, `init failed: ${JSON.stringify(body)}`)
    return body
  }

  it('reconstructs a multi-chunk file byte for byte', async () => {
    // The single most important assertion in this suite: resumption is only
    // worth anything if the assembled bytes are exactly the original.
    const target = path.join(HOME_ROOT, 'uploaded.bin')
    const size = CHUNK_GUESS + 5000
    const source = randomBytes(size)

    const session = await init(target, size)
    const { chunkSize } = session
    assert.ok(chunkSize > 0)

    for (let offset = 0; offset < size; offset += chunkSize) {
      const slice = source.subarray(offset, Math.min(offset + chunkSize, size))
      const res = await putChunk(session.uploadId, offset, slice)
      assert.equal(res.status, 200, `chunk at ${offset} failed: ${JSON.stringify(res.body)}`)
    }

    const done = await api(`/api/fs/upload/${session.uploadId}/complete`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    assert.equal(done.status, 200)

    const written = readFileSync(target)
    assert.equal(written.length, size)
    assert.ok(written.equals(source), 'the assembled file must match the source exactly')
  })

  it('reports which ranges are still missing', async () => {
    const target = path.join(HOME_ROOT, 'resume.bin')
    const size = CHUNK_GUESS * 2 + 123
    const source = randomBytes(size)

    const session = await init(target, size)
    const { chunkSize } = session

    // Send the first and third chunks, leaving the middle one out.
    await putChunk(session.uploadId, 0, source.subarray(0, chunkSize))
    const third = 2 * chunkSize
    await putChunk(session.uploadId, third, source.subarray(third, size))

    const status = await api(`/api/fs/upload/${session.uploadId}`)
    assert.equal(status.status, 200)
    assert.equal(status.body.complete, false)
    assert.equal(status.body.bytesReceived, size - chunkSize)
    assert.deepEqual(status.body.received, [
      [0, chunkSize],
      [third, size],
    ])

    // An incomplete complete is refused, and names the gap.
    const premature = await api(`/api/fs/upload/${session.uploadId}/complete`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    assert.equal(premature.status, 409)
    assert.equal(premature.body.error.code, 'upload_incomplete')
    assert.deepEqual(premature.body.error.missing, [[chunkSize, third]])

    // Sending the gap finishes it.
    await putChunk(session.uploadId, chunkSize, source.subarray(chunkSize, third))
    const done = await api(`/api/fs/upload/${session.uploadId}/complete`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    assert.equal(done.status, 200)
    assert.ok(readFileSync(target).equals(source))
  })

  it('treats re-sending the same chunk as a no-op', async () => {
    const target = path.join(HOME_ROOT, 'idempotent.bin')
    const size = 1000
    const source = randomBytes(size)

    const session = await init(target, size)
    const first = await putChunk(session.uploadId, 0, source)
    assert.equal(first.status, 200)
    const again = await putChunk(session.uploadId, 0, source)
    assert.equal(again.status, 200)
    assert.equal(again.body.bytesReceived, size)

    const done = await api(`/api/fs/upload/${session.uploadId}/complete`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    assert.equal(done.status, 200)
    assert.ok(readFileSync(target).equals(source))
  })

  it('rejects a chunk whose checksum does not match, and does not mark it received', async () => {
    const target = path.join(HOME_ROOT, 'corrupt.bin')
    const size = 500
    const source = randomBytes(size)

    const session = await init(target, size)
    const res = await putChunk(session.uploadId, 0, source, { checksum: sha256(Buffer.from('different')) })
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'checksum_mismatch')

    const status = await api(`/api/fs/upload/${session.uploadId}`)
    assert.equal(status.body.bytesReceived, 0, 'a rejected chunk must not be recorded as received')
  })

  it('requires a checksum', async () => {
    const session = await init(path.join(HOME_ROOT, 'nochecksum.bin'), 500)
    const res = await putChunk(session.uploadId, 0, randomBytes(500), { checksum: '' })
    assert.equal(res.status, 400)
  })

  it('rejects an out-of-range offset', async () => {
    const size = 500
    const session = await init(path.join(HOME_ROOT, 'oor.bin'), size)
    const res = await putChunk(session.uploadId, 4096, randomBytes(100))
    assert.equal(res.status, 416)
  })

  it('rejects an unaligned offset', async () => {
    const session = await init(path.join(HOME_ROOT, 'unaligned.bin'), CHUNK_GUESS * 2)
    const res = await putChunk(session.uploadId, 7, randomBytes(10))
    assert.equal(res.status, 416)
  })

  it('refuses a malformed upload id before it can become a path', async () => {
    for (const id of ['../etc', 'short', 'aaaaaaaaaaaaaaaaaaaaa!', '..%2f..%2fetc']) {
      const status = await api(`/api/fs/upload/${encodeURIComponent(id)}`)
      assert.ok(status.status === 400 || status.status === 404, `${id} should be refused`)
    }
  })

  it('reports an unknown upload as 404', async () => {
    const { status } = await api('/api/fs/upload/aaaaaaaaaaaaaaaaaaaaaa')
    assert.equal(status, 404)
  })

  it('refuses to initialise an upload into a readonly root', async () => {
    const { status, body } = await api('/api/fs/upload/init', {
      method: 'POST',
      body: JSON.stringify({ path: path.join(RO_ROOT, 'nope.bin'), size: 10 }),
    })
    assert.equal(status, 403)
    assert.equal(body.error.code, 'readonly_root')
  })

  it('refuses to initialise an upload outside every root', async () => {
    const { status } = await api('/api/fs/upload/init', {
      method: 'POST',
      body: JSON.stringify({ path: path.join(OUTSIDE, 'evil.bin'), size: 10 }),
    })
    assert.equal(status, 403)
  })

  it('refuses the reserved data directory', async () => {
    const { status } = await api('/api/fs/upload/init', {
      method: 'POST',
      body: JSON.stringify({ path: path.join(dataDir, 'evil.bin'), size: 10 }),
    })
    assert.equal(status, 403)
  })

  it('leaves an existing file untouched until overwrite is given', async () => {
    const target = path.join(HOME_ROOT, 'occupied.txt')
    writeFileSync(target, 'original')

    const session = await init(target, 'replacement'.length)
    await putChunk(session.uploadId, 0, Buffer.from('replacement'))

    const blocked = await api(`/api/fs/upload/${session.uploadId}/complete`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.error.code, 'already_exists')
    assert.equal(readFileSync(target, 'utf8'), 'original', 'the existing file must not be touched')

    // The upload survives the refusal, so the client can simply retry.
    const forced = await api(`/api/fs/upload/${session.uploadId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ overwrite: true }),
    })
    assert.equal(forced.status, 200)
    assert.equal(readFileSync(target, 'utf8'), 'replacement')
  })

  it('aborts an upload and discards its staging area', async () => {
    const session = await init(path.join(HOME_ROOT, 'aborted.bin'), 1000)
    const { status } = await api(`/api/fs/upload/${session.uploadId}`, { method: 'DELETE' })
    assert.equal(status, 204)
    assert.equal((await api(`/api/fs/upload/${session.uploadId}`)).status, 404)
  })

  it('sweeps an abandoned staging area on restart, but keeps a fresh one', async () => {
    const stale = await init(path.join(HOME_ROOT, 'stale.bin'), 1000)
    const fresh = await init(path.join(HOME_ROOT, 'fresh.bin'), 1000)

    // Backdate one upload's last activity beyond the 24h TTL.
    const metaPath = path.join(dataDir, 'uploads', stale.uploadId, 'meta.json')
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    meta.updatedAt = Date.now() - 48 * 3600 * 1000
    writeFileSync(metaPath, JSON.stringify(meta))

    await stopServer()
    server = startServer()
    await waitForServer()

    // Expiry is by idle time, not "clear everything on boot" — which is what
    // lets a restart happen in the middle of a large upload without losing it.
    assert.equal((await api(`/api/fs/upload/${stale.uploadId}`)).status, 404)
    assert.equal((await api(`/api/fs/upload/${fresh.uploadId}`)).status, 200)

    await api(`/api/fs/upload/${fresh.uploadId}`, { method: 'DELETE' })
  })
})

describe('preview', () => {
  it('serves a script-capable file as plain text, never as itself', async () => {
    // This is what makes preview safe to offer at all: `.html` and `.svg` are
    // shown as source, and text/plain under nosniff cannot execute.
    const target = path.join(HOME_ROOT, 'page.html')
    writeFileSync(target, '<script>alert(1)</script>')

    const res = await fetch(`${BASE}/api/fs/preview?path=${url(target)}`, { headers: headers() })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /^text\/plain/)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.ok(res.headers.get('content-disposition')?.startsWith('inline'))
    assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'none'/)
    assert.equal(await res.text(), '<script>alert(1)</script>')

    rmSync(target)
  })

  it('does not render an svg as an image', async () => {
    const target = path.join(HOME_ROOT, 'pic.svg')
    writeFileSync(target, '<svg onload="alert(1)"/>')
    const res = await fetch(`${BASE}/api/fs/preview?path=${url(target)}`, { headers: headers() })
    assert.match(res.headers.get('content-type'), /^text\/plain/)
    rmSync(target)
  })

  it('renders a real image type inline', async () => {
    const target = path.join(HOME_ROOT, 'pic.png')
    writeFileSync(target, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const res = await fetch(`${BASE}/api/fs/preview?path=${url(target)}`, { headers: headers() })
    assert.equal(res.headers.get('content-type'), 'image/png')
    assert.ok(res.headers.get('content-disposition')?.startsWith('inline'))
    rmSync(target)
  })

  it('degrades to an attachment for a type it will not render', async () => {
    const target = path.join(HOME_ROOT, 'bundle.zip')
    writeFileSync(target, 'PK')
    const res = await fetch(`${BASE}/api/fs/preview?path=${url(target)}`, { headers: headers() })
    assert.ok(res.headers.get('content-disposition')?.startsWith('attachment'))
    rmSync(target)
  })

  it('truncates a large text file rather than streaming all of it', async () => {
    const target = path.join(HOME_ROOT, 'big.log')
    writeFileSync(target, 'x'.repeat(600_000))

    const res = await fetch(`${BASE}/api/fs/preview?path=${url(target)}`, { headers: headers() })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-webmux-truncated'), 'true')
    assert.equal((await res.text()).length, 512 * 1024)

    rmSync(target)
  })

  it('reports the preview kind in a listing, so the client need not guess', async () => {
    const target = path.join(HOME_ROOT, 'kind.txt')
    writeFileSync(target, 'text')
    const { body } = await api(`/api/fs/list?path=${url(HOME_ROOT)}`)
    assert.equal(body.entries.find((entry) => entry.name === 'kind.txt').preview, 'text')
    rmSync(target)
  })

  it('refuses an escape exactly as download does', async () => {
    const res = await fetch(`${BASE}/api/fs/preview?path=${url('/etc/passwd')}`, { headers: headers() })
    assert.equal(res.status, 403)
  })
})

describe('touch', () => {
  it('creates an empty file', async () => {
    const target = path.join(HOME_ROOT, 'fresh.txt')
    const { status, body } = await api('/api/fs/touch', {
      method: 'POST',
      body: JSON.stringify({ path: target }),
    })
    assert.equal(status, 201)
    assert.equal(body.kind, 'file')
    assert.equal(readFileSync(target).length, 0)
    rmSync(target)
  })

  it('refuses an existing path rather than bumping its mtime', async () => {
    const target = path.join(HOME_ROOT, 'exists.txt')
    writeFileSync(target, 'original')
    const before = statSync(target).mtimeMs

    const { status, body } = await api('/api/fs/touch', {
      method: 'POST',
      body: JSON.stringify({ path: target }),
    })
    assert.equal(status, 409)
    assert.equal(body.error.code, 'already_exists')
    assert.equal(readFileSync(target, 'utf8'), 'original')
    assert.equal(statSync(target).mtimeMs, before, 'an existing file must not be modified')

    rmSync(target)
  })

  it('refuses a readonly root and an escape', async () => {
    const readonly = await api('/api/fs/touch', {
      method: 'POST',
      body: JSON.stringify({ path: path.join(RO_ROOT, 'nope') }),
    })
    assert.equal(readonly.status, 403)

    const outside = await api('/api/fs/touch', {
      method: 'POST',
      body: JSON.stringify({ path: path.join(OUTSIDE, 'nope') }),
    })
    assert.equal(outside.status, 403)
  })
})

describe('write content', () => {
  const save = (target, text, baseMtimeMs) =>
    api('/api/fs/content', {
      method: 'PUT',
      body: JSON.stringify({ path: target, text, ...(baseMtimeMs !== undefined ? { baseMtimeMs } : {}) }),
    })

  it('replaces the contents and describes the result', async () => {
    const target = path.join(HOME_ROOT, 'edit.txt')
    writeFileSync(target, 'before')

    const { status, body } = await save(target, 'after\nline two')
    assert.equal(status, 200)
    assert.equal(body.kind, 'file')
    assert.equal(body.name, 'edit.txt')
    assert.equal(readFileSync(target, 'utf8'), 'after\nline two')
    // The response is what the editor uses as the base for its next save, so
    // it has to describe what is actually on disk.
    assert.equal(body.mtimeMs, statSync(target).mtimeMs)

    rmSync(target)
  })

  it('accepts a second save built on the first one', async () => {
    const target = path.join(HOME_ROOT, 'twice.txt')
    writeFileSync(target, 'one')

    const first = await save(target, 'two')
    assert.equal(first.status, 200)
    const second = await save(target, 'three', first.body.mtimeMs)
    assert.equal(second.status, 200, 'the mtime from the previous response must be current')
    assert.equal(readFileSync(target, 'utf8'), 'three')

    rmSync(target)
  })

  it('keeps the file mode, which a staging file would not', async () => {
    const target = path.join(HOME_ROOT, 'mode.txt')
    writeFileSync(target, 'x')
    chmodSync(target, 0o640)

    await save(target, 'y')
    assert.equal(statSync(target).mode & 0o777, 0o640)

    rmSync(target)
  })

  it('leaves no temporary file behind', async () => {
    const dir = path.join(HOME_ROOT, 'tidy')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'a.txt'), 'x')

    await save(path.join(dir, 'a.txt'), 'y')
    const leftovers = readdirSync(dir).filter((name) => name.startsWith('.webmux-save-'))
    assert.deepEqual(leftovers, [])

    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a file that does not exist rather than creating it', async () => {
    const target = path.join(HOME_ROOT, 'never-existed.txt')
    const { status, body } = await save(target, 'content')
    assert.equal(status, 404)
    assert.equal(body.error.code, 'not_found')
    assert.equal(existsSync(target), false)
  })

  it('refuses a directory', async () => {
    const { status, body } = await save(path.join(HOME_ROOT, 'sub'), 'content')
    assert.equal(status, 400)
    assert.equal(body.error.code, 'is_a_directory')
  })

  it('refuses a read-only root, an escape, and the reserved data directory', async () => {
    const readonly = await save(path.join(RO_ROOT, 'sealed.txt'), 'gone')
    assert.equal(readonly.status, 403)
    assert.equal(readonly.body.error.code, 'readonly_root')
    assert.equal(readFileSync(path.join(RO_ROOT, 'sealed.txt'), 'utf8'), 'sealed')

    const escape = await save(path.join(OUTSIDE, 'secret.txt'), 'gone')
    assert.equal(escape.status, 403)
    assert.equal(escape.body.error.code, 'path_escape')
    assert.equal(readFileSync(path.join(OUTSIDE, 'secret.txt'), 'utf8'), 'secret')

    const reserved = await save(path.join(dataDir, 'webmux.db'), 'gone')
    assert.equal(reserved.status, 403)
    assert.equal(reserved.body.error.code, 'forbidden_path')
  })

  it('refuses to overwrite a file that changed since it was loaded', async () => {
    const target = path.join(HOME_ROOT, 'racing.txt')
    writeFileSync(target, 'loaded')
    const loadedAt = statSync(target).mtimeMs

    // Someone else — another tab, or a shell — writes in between.
    await delay(20)
    writeFileSync(target, 'changed elsewhere')

    const { status, body } = await save(target, 'from the stale editor', loadedAt)
    assert.equal(status, 409)
    assert.equal(body.error.code, 'conflict')
    assert.equal(readFileSync(target, 'utf8'), 'changed elsewhere')

    // With the current mtime the same save goes through: the refusal is about
    // staleness, not about the write being forbidden.
    const fresh = await save(target, 'from the stale editor', statSync(target).mtimeMs)
    assert.equal(fresh.status, 200)

    rmSync(target)
  })

  it('refuses a file larger than the edit limit', async () => {
    const target = path.join(HOME_ROOT, 'huge.log')
    writeFileSync(target, 'x'.repeat(600_000))

    // A truncated preview is exactly the limit in size, so a save built on one
    // would replace the file with its own first 512 KiB.
    const { status, body } = await save(target, 'small')
    assert.equal(status, 413)
    assert.equal(body.error.code, 'too_large')
    assert.equal(readFileSync(target).length, 600_000)

    rmSync(target)
  })

  it('refuses text larger than the edit limit', async () => {
    const target = path.join(HOME_ROOT, 'grow.txt')
    writeFileSync(target, 'small')

    const { status, body } = await save(target, 'x'.repeat(512 * 1024 + 1))
    assert.equal(status, 413)
    assert.equal(body.error.code, 'too_large')
    assert.equal(readFileSync(target, 'utf8'), 'small')

    rmSync(target)
  })

  it('rejects an oversized body without writing anything', async () => {
    const target = path.join(HOME_ROOT, 'body.txt')
    writeFileSync(target, 'small')

    // Fastify refuses a declared-oversize body before reading it and drops the
    // connection. Whether the client sees the 413 response or a broken pipe
    // first is a race, so both are accepted here — what is not acceptable is a
    // 500, or the file being touched.
    let status = null
    try {
      ;({ status } = await save(target, 'x'.repeat(4 * 1024 * 1024)))
    } catch {
      status = null
    }
    if (status !== null) assert.equal(status, 413, 'a body over the limit is a refusal, not a fault')
    assert.equal(readFileSync(target, 'utf8'), 'small')

    rmSync(target)
  })

  it('writes through an in-jail symlink, keeping the link', async () => {
    const real = path.join(HOME_ROOT, 'real.txt')
    const alias = path.join(HOME_ROOT, 'alias.txt')
    writeFileSync(real, 'original')
    symlinkSync(real, alias)

    // The preview followed the link, so the save has to follow it too —
    // otherwise what is edited on screen and what is written would differ.
    const { status } = await save(alias, 'through the link')
    assert.equal(status, 200)
    assert.equal(readFileSync(real, 'utf8'), 'through the link')
    assert.equal(lstatSync(alias).isSymbolicLink(), true)

    rmSync(alias)
    rmSync(real)
  })

  it('refuses a symlink that leaves the jail', async () => {
    const { status, body } = await save(path.join(HOME_ROOT, 'link-secret'), 'gone')
    assert.equal(status, 403)
    assert.equal(body.error.code, 'path_escape')
    assert.equal(readFileSync(path.join(OUTSIDE, 'secret.txt'), 'utf8'), 'secret')
  })
})

describe('archive and extract', () => {
  let archivePath

  before(() => {
    mkdirSync(path.join(HOME_ROOT, 'archived', 'inner'), { recursive: true })
    writeFileSync(path.join(HOME_ROOT, 'archived', 'a.txt'), 'alpha')
    writeFileSync(path.join(HOME_ROOT, 'archived', 'inner', 'b.txt'), 'beta')
    writeFileSync(path.join(HOME_ROOT, 'archived', '中文.txt'), 'chinese')
    archivePath = path.join(HOME_ROOT, 'archived.zip')
  })

  after(() => {
    rmSync(path.join(HOME_ROOT, 'archived'), { recursive: true, force: true })
    rmSync(path.join(HOME_ROOT, 'archived-out'), { recursive: true, force: true })
    rmSync(archivePath, { force: true })
  })

  it('streams a zip with the headers a client needs', async () => {
    const res = await fetch(`${BASE}/api/fs/archive?path=${url(path.join(HOME_ROOT, 'archived'))}`, {
      headers: headers(),
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/zip')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.ok(res.headers.get('content-disposition')?.startsWith('attachment'))
    // The three deliberately-absent headers. A validator over a directory goes
    // stale the moment a file changes, and a client re-issuing a Range against
    // a stale one gets a silently spliced, corrupt archive.
    assert.equal(res.headers.get('etag'), null)
    assert.equal(res.headers.get('accept-ranges'), null)
    assert.equal(res.headers.get('content-length'), null)
    assert.ok(Number(res.headers.get('x-webmux-entries')) >= 4)

    writeFileSync(archivePath, Buffer.from(await res.arrayBuffer()))
  })

  it('round-trips through extract, Chinese names included', async () => {
    const dest = path.join(HOME_ROOT, 'archived-out')
    const { status, body } = await api('/api/fs/extract', {
      method: 'POST',
      body: JSON.stringify({ path: archivePath, dest }),
    })
    assert.equal(status, 201, JSON.stringify(body))
    assert.equal(readFileSync(path.join(dest, 'archived', 'inner', 'b.txt'), 'utf8'), 'beta')
    assert.equal(readFileSync(path.join(dest, 'archived', '中文.txt'), 'utf8'), 'chinese')
  })

  it('refuses a destination that already exists', async () => {
    const { status, body } = await api('/api/fs/extract', {
      method: 'POST',
      body: JSON.stringify({ path: archivePath, dest: path.join(HOME_ROOT, 'archived-out') }),
    })
    assert.equal(status, 409)
    assert.equal(body.error.code, 'already_exists')
  })

  it('requires exactly one of path and uploadId', async () => {
    const neither = await api('/api/fs/extract', {
      method: 'POST',
      body: JSON.stringify({ dest: path.join(HOME_ROOT, 'x1') }),
    })
    assert.equal(neither.status, 400)

    const both = await api('/api/fs/extract', {
      method: 'POST',
      body: JSON.stringify({ path: archivePath, uploadId: 'a'.repeat(22), dest: path.join(HOME_ROOT, 'x2') }),
    })
    assert.equal(both.status, 400)
  })

  it('refuses a destination outside the jail or in the data directory', async () => {
    const outside = await api('/api/fs/extract', {
      method: 'POST',
      body: JSON.stringify({ path: archivePath, dest: path.join(OUTSIDE, 'pwn') }),
    })
    assert.equal(outside.status, 403)

    const reserved = await api('/api/fs/extract', {
      method: 'POST',
      body: JSON.stringify({ path: archivePath, dest: path.join(dataDir, 'pwn') }),
    })
    assert.equal(reserved.status, 403)
  })

  it('refuses an unsupported format', async () => {
    const { status } = await api(`/api/fs/archive?path=${url(HOME_ROOT)}&format=tar`)
    assert.equal(status, 400)
  })

  it('archives a readonly root, because that is a read', async () => {
    const res = await fetch(`${BASE}/api/fs/archive?path=${url(RO_ROOT)}`, { headers: headers() })
    assert.equal(res.status, 200)
    await res.arrayBuffer()
  })

  it('refuses to archive the reserved data directory', async () => {
    const { status } = await api(`/api/fs/archive?path=${url(dataDir)}`)
    assert.equal(status, 403)
  })

  it('rejects a zip-slip archive and leaves the outside canary untouched', async () => {
    const canary = path.join(OUTSIDE, 'precious', 'keep.txt')
    const before = readFileSync(canary)
    const slip = path.join(HOME_ROOT, 'slip.zip')
    writeFileSync(
      slip,
      buildZip([
        { name: '../../outside/precious/keep.txt', data: Buffer.from('PWNED') },
        { name: 'innocent.txt', data: Buffer.from('hi') },
      ]),
    )
    const dest = path.join(HOME_ROOT, 'slipped')

    const { status, body } = await api('/api/fs/extract', {
      method: 'POST',
      body: JSON.stringify({ path: slip, dest }),
    })
    assert.equal(status, 400)
    assert.equal(body.error.code, 'unsafe_archive')

    // The assertion that would actually catch the bug. A status code alone
    // would still pass if the write happened and something else failed after.
    assert.ok(readFileSync(canary).equals(before), 'the file outside the jail must be untouched')
    assert.equal(existsSync(dest), false, 'a refused extraction must leave nothing behind')

    rmSync(slip, { force: true })
  })

  it('refuses a bomb and rolls the destination back', async () => {
    // Declares three gigabytes in a few hundred bytes. `zip.test.mjs` covers
    // the harder case — a small *declaration* with a large actual inflation,
    // which only the running counter catches — because that needs tuned limits
    // and cannot be reached through the API's defaults.
    const bomb = path.join(HOME_ROOT, 'bomb.zip')
    writeFileSync(
      bomb,
      buildZip([
        {
          name: 'bomb.bin',
          method: 8,
          data: deflateRawSync(Buffer.alloc(64 * 1024)),
          claimedUncompressed: 3 * 1024 * 1024 * 1024,
        },
      ]),
    )
    const dest = path.join(HOME_ROOT, 'bombed')

    const { status } = await api('/api/fs/extract', {
      method: 'POST',
      body: JSON.stringify({ path: bomb, dest }),
    })
    assert.equal(status, 413)
    assert.equal(existsSync(dest), false, 'the destination must be rolled back')

    rmSync(bomb, { force: true })
  })

  it('extracts an archive delivered through the upload staging area', async () => {
    // The `uploadId` path: the archive arrives through the resumable uploader,
    // so it inherits resume and GC, and the staged file is already seekable.
    const bytes = readFileSync(archivePath)
    const init = await api('/api/fs/upload/init', {
      method: 'POST',
      body: JSON.stringify({ path: path.join(HOME_ROOT, 'staged.zip'), size: bytes.length }),
    })
    assert.equal(init.status, 201)

    const chunkSize = init.body.chunkSize
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length))
      const res = await putChunk(init.body.uploadId, offset, slice)
      assert.equal(res.status, 200, JSON.stringify(res.body))
    }

    // Deliberately no `/complete`: extraction reads the staging area directly.
    // Completing first would install the archive as a file and then read it
    // straight back — a full extra copy of the archive for nothing.
    const dest = path.join(HOME_ROOT, 'staged-out')
    const { status, body } = await api('/api/fs/extract', {
      method: 'POST',
      body: JSON.stringify({ uploadId: init.body.uploadId, dest }),
    })
    assert.equal(status, 201, JSON.stringify(body))
    assert.equal(readFileSync(path.join(dest, 'archived', 'a.txt'), 'utf8'), 'alpha')

    // The staging area is never completed, so clean it up explicitly rather
    // than leaving it for the sweeper's TTL.
    await api(`/api/fs/upload/${init.body.uploadId}`, { method: 'DELETE' })
    rmSync(dest, { recursive: true, force: true })
  })
})
