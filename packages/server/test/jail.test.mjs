/**
 * The path jail's own suite.
 *
 * DESIGN §5.2 asks for this to be independent of the server, and it is: no
 * tmux, no HTTP, no Fastify — fixtures on disk and the resolver, nothing else.
 * That independence is the point. The jail is the one module where a mistake is
 * a file-disclosure or arbitrary-write bug reachable from the network, and the
 * API-level suite cannot even express the interesting cases: a NUL byte and a
 * symlink loop cannot be constructed through a URL and a query parser.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createJail, isInside, loadRoots } from '../src/fs/jail.ts'

let tmp
/** Canonical, because that is what the jail works in. */
let ROOT
let OUTSIDE
let DATA
let jail

/**
 * Asserts that `fn` rejects with an FsError carrying `code`.
 *
 * Matching on the code rather than just "it threw" is deliberate: a path that
 * is refused because the resolver crashed with ENAMETOOLONG is not the same
 * outcome as one that is refused because it left the root, and a test that
 * accepted either would hide exactly the bug it exists to catch.
 */
async function expectError(fn, code) {
  let thrown
  try {
    await fn()
  } catch (err) {
    thrown = err
  }
  assert.ok(thrown, `expected ${code}, but the call succeeded`)
  assert.equal(thrown.name, 'FsError', `expected an FsError, got ${thrown.name}: ${thrown.message}`)
  assert.equal(thrown.code, code, `expected ${code}, got ${thrown.code}: ${thrown.message}`)
  return thrown
}

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'webmux-jail-'))

  const rawRoot = path.join(tmp, 'home')
  const rawOutside = path.join(tmp, 'outside')
  const rawData = path.join(rawRoot, '.webmux-data')

  mkdirSync(path.join(rawRoot, 'sub'), { recursive: true })
  mkdirSync(path.join(rawRoot, 'ro'), { recursive: true })
  mkdirSync(rawOutside, { recursive: true })
  mkdirSync(rawData, { recursive: true })

  writeFileSync(path.join(rawRoot, 'file.txt'), 'inside')
  writeFileSync(path.join(rawRoot, 'sub', 'inner.txt'), 'inner')
  writeFileSync(path.join(rawRoot, 'ro', 'sealed.txt'), 'sealed')
  writeFileSync(path.join(rawOutside, 'secret.txt'), 'secret')
  // Stands in for webmux.db, which holds the token signing secret.
  writeFileSync(path.join(rawData, 'webmux.db'), 'sqlite')

  // Relative target: exercises the same code path a hand-made link takes.
  symlinkSync('sub', path.join(rawRoot, 'link-inside'))
  symlinkSync(rawOutside, path.join(rawRoot, 'link-outside'))
  symlinkSync(path.join(rawOutside, 'secret.txt'), path.join(rawRoot, 'link-outside-file'))
  // Dangling: points at something that does not exist. This is the case the
  // naive `existsSync`-based resolver gets wrong.
  symlinkSync(path.join(rawOutside, 'nope'), path.join(rawRoot, 'dangling'))
  symlinkSync('loop-b', path.join(rawRoot, 'loop-a'))
  symlinkSync('loop-a', path.join(rawRoot, 'loop-b'))
  // A link to a link that leaves the root: resolving only one hop would pass.
  symlinkSync('link-outside', path.join(rawRoot, 'link-chain'))

  const roots = await loadRoots(
    [
      { name: 'home', path: rawRoot, readonly: false },
      // Nested inside `home` on purpose: the inner root must win by longest
      // prefix, and it must be the one whose `readonly` is honoured.
      { name: 'ro', path: path.join(rawRoot, 'ro'), readonly: true },
      { name: 'missing', path: path.join(tmp, 'not-mounted'), readonly: false },
    ],
    rawData,
  )
  jail = await createJail(roots, rawData)

  ROOT = realpathSync(rawRoot)
  OUTSIDE = realpathSync(rawOutside)
  DATA = realpathSync(rawData)
})

after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('containment predicate', () => {
  it('accepts the root itself and its children', () => {
    assert.equal(isInside('/a/b', '/a/b'), true)
    assert.equal(isInside('/a/b', '/a/b/c'), true)
  })

  it('rejects siblings that merely share a prefix', () => {
    // The reason this is a segment-boundary check and not a bare startsWith.
    assert.equal(isInside('/a/b', '/a/bc'), false)
    assert.equal(isInside('/a/b', '/a'), false)
  })

  it('treats the filesystem root as owning everything absolute', () => {
    assert.equal(isInside('/', '/anything'), true)
    assert.equal(isInside('/', '/'), true)
  })
})

describe('path validation', () => {
  it('rejects a relative path', async () => {
    await expectError(() => jail.resolve('sub/file.txt'), 'invalid_path')
  })

  it('rejects an empty path', async () => {
    await expectError(() => jail.resolve(''), 'invalid_path')
  })

  it('rejects a NUL byte before touching the filesystem', async () => {
    // Node throws ERR_INVALID_ARG_VALUE on a NUL, which without this check
    // would surface as a 500 rather than a clean 400.
    await expectError(() => jail.resolve(`${ROOT}/file.txt\0.png`), 'invalid_path')
    await expectError(() => jail.resolve(`${ROOT}/\0`), 'invalid_path')
  })

  it('rejects an over-long path instead of leaking ENAMETOOLONG as a 500', async () => {
    await expectError(() => jail.resolve(`${ROOT}/${'x'.repeat(5000)}`), 'invalid_path')
  })
})

describe('traversal', () => {
  it('refuses to climb out with ..', async () => {
    await expectError(() => jail.resolve(`${ROOT}/../outside/secret.txt`), 'path_escape')
    await expectError(() => jail.resolve(`${ROOT}/sub/../../outside/secret.txt`), 'path_escape')
  })

  it('refuses a deep .. climb', async () => {
    // Three levels up from ROOT/a/b lands exactly on the directory holding
    // both the root and the outside tree, so the result must be refused for
    // leaving the root rather than for being missing.
    await expectError(() => jail.resolve(`${ROOT}/a/b/../../../outside/secret.txt`), 'path_escape')
  })

  it('refuses repeated separators that point outside', async () => {
    await expectError(() => jail.resolve(`//${OUTSIDE.replace(/^\//, '')}/secret.txt`), 'path_escape')
  })

  it('refuses an absolute path outside every root', async () => {
    await expectError(() => jail.resolve('/etc/passwd'), 'path_escape')
  })

  it('allows .. that lands back inside the root', async () => {
    // The mirror image of the test above. Without it, a resolver that simply
    // rejected every path containing '..' would look correct.
    const resolved = await jail.resolve(`${ROOT}/sub/../file.txt`)
    assert.equal(resolved.abs, path.join(ROOT, 'file.txt'))
  })

  it('resolves sub/.. to the root itself', async () => {
    const resolved = await jail.resolve(`${ROOT}/sub/..`)
    assert.equal(resolved.abs, ROOT)
  })
})

describe('symlinks', () => {
  it('refuses to escape through a symlinked directory', async () => {
    await expectError(() => jail.resolve(`${ROOT}/link-outside/secret.txt`), 'path_escape')
  })

  it('refuses to escape through a symlinked file', async () => {
    await expectError(() => jail.resolve(`${ROOT}/link-outside-file`), 'path_escape')
  })

  it('refuses a chain that ends outside', async () => {
    await expectError(() => jail.resolve(`${ROOT}/link-chain/secret.txt`), 'path_escape')
  })

  it('cancels .. lexically, so a link cannot be used to reach its target', async () => {
    // `path.resolve` is purely lexical and does not know `link-outside` is a
    // link, so `link-outside/..` is ROOT rather than the link's parent. Worth
    // pinning down: it is both safe and surprising.
    const resolved = await jail.resolve(`${ROOT}/link-outside/..`)
    assert.equal(resolved.abs, ROOT)
  })

  it('reports a symlink loop as a bad path, not a crash', async () => {
    await expectError(() => jail.resolve(`${ROOT}/loop-a`), 'invalid_path')
  })

  it('rejects a dangling symlink on read', async () => {
    await expectError(() => jail.resolve(`${ROOT}/dangling`), 'invalid_path')
  })

  it('rejects a dangling symlink as a create target', async () => {
    // The DESIGN §5.2 hole. `existsSync` follows the link, finds nothing, and
    // takes the "new path" branch — validating only the parent, which is
    // legitimately inside the root — and then hands back a path whose final
    // component points outside. Writing through it creates the file out there.
    await expectError(() => jail.resolveForCreate(`${ROOT}/dangling`), 'invalid_path')
  })

  it('refuses to create at any symlink, dangling or not', async () => {
    await expectError(() => jail.resolveForCreate(`${ROOT}/link-outside-file`), 'invalid_path')
    await expectError(() => jail.resolveForCreate(`${ROOT}/link-inside`), 'invalid_path')
  })

  it('refuses to resolve through a dangling symlink ancestor', async () => {
    // The intermediate-component form of the same bug: "the target may not
    // exist yet" must not stretch to "a parent may be a dangling link".
    await expectError(
      () => jail.resolveForCreate(`${ROOT}/dangling/missing.txt`, { recursive: true }),
      'invalid_path',
    )
  })

  it('follows a symlink that stays inside, and returns the canonical path', async () => {
    const resolved = await jail.resolve(`${ROOT}/link-inside/inner.txt`)
    assert.equal(resolved.abs, path.join(ROOT, 'sub', 'inner.txt'))
  })

  it('lets a symlink itself be deleted, reporting the literal path', async () => {
    // `rm ~/link` removes the link. Reporting the dereferenced path here would
    // make the delete endpoint destroy the link's target instead.
    const resolved = await jail.resolveTarget(`${ROOT}/link-outside-file`)
    assert.equal(resolved.abs, path.join(ROOT, 'link-outside-file'))
    assert.equal(resolved.exists, true)
  })
})

describe('roots', () => {
  it('honours the innermost root for a nested path', async () => {
    const resolved = await jail.resolve(`${ROOT}/ro/sealed.txt`)
    assert.equal(resolved.root.name, 'ro')
  })

  it('enforces readonly on the nested root only', async () => {
    await expectError(() => jail.resolveForCreate(`${ROOT}/ro/new.txt`), 'readonly_root')
    // The enclosing root is writable, so the same operation one level up is fine.
    const ok = await jail.resolveForCreate(`${ROOT}/new.txt`)
    assert.equal(ok.exists, false)
  })

  it('allows reading from a readonly root', async () => {
    const resolved = await jail.resolve(`${ROOT}/ro/sealed.txt`)
    assert.equal(resolved.exists, true)
  })

  it('protects the root itself from mutation but allows reading it', async () => {
    await expectError(() => jail.resolveTarget(ROOT), 'root_protected')
    const asRead = await jail.resolve(ROOT)
    assert.equal(asRead.abs, ROOT)
  })

  it('excludes an unavailable root from resolution', async () => {
    const roots = jail.roots()
    const missing = roots.find((r) => r.name === 'missing')
    assert.equal(missing.available, false)
    assert.ok(missing.unavailableReason, 'an unusable root should say why')
    await expectError(() => jail.resolve(path.join(tmp, 'not-mounted', 'x')), 'path_escape')
  })

  it('refuses duplicate root names at load time', async () => {
    await assert.rejects(
      () => loadRoots([{ name: 'dup', path: tmp, readonly: false }, { name: 'dup', path: tmp, readonly: false }], DATA),
      /duplicate file root name/,
    )
  })
})

describe('prefix collisions across roots', () => {
  it('does not let /x/home own /x/home2', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'webmux-jail-collide-'))
    try {
      mkdirSync(path.join(base, 'home'))
      mkdirSync(path.join(base, 'home2'))
      writeFileSync(path.join(base, 'home2', 'other.txt'), 'other')
      const roots = await loadRoots([{ name: 'home', path: path.join(base, 'home'), readonly: false }], DATA)
      const scoped = await createJail(roots, DATA)
      const canonical = realpathSync(path.join(base, 'home2', 'other.txt'))
      // `home2` is not inside `home`, so it must not resolve — the trap a bare
      // `startsWith(root)` falls into.
      await expectError(() => scoped.resolve(canonical), 'path_escape')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('recursive creation', () => {
  it('allows missing intermediate directories', async () => {
    const target = await jail.resolveForCreate(`${ROOT}/deep/a/b/c`, { recursive: true })
    assert.equal(target.abs, path.join(ROOT, 'deep', 'a', 'b', 'c'))
    assert.equal(target.exists, false)
  })

  it('still refuses a path outside every root', async () => {
    await expectError(() => jail.resolveForCreate(`${OUTSIDE}/a/b`, { recursive: true }), 'path_escape')
  })

  it('still refuses a path that climbs out', async () => {
    await expectError(
      () => jail.resolveForCreate(`${ROOT}/deep/../../outside/x`, { recursive: true }),
      'path_escape',
    )
  })

  it('still refuses the reserved data directory', async () => {
    await expectError(() => jail.resolveForCreate(`${DATA}/a/b`, { recursive: true }), 'forbidden_path')
  })

  it('still refuses a readonly root', async () => {
    await expectError(() => jail.resolveForCreate(`${ROOT}/ro/a/b`, { recursive: true }), 'readonly_root')
  })

  it('reports an existing target rather than pretending to create it', async () => {
    const target = await jail.resolveForCreate(`${ROOT}/sub`, { recursive: true })
    assert.equal(target.exists, true)
  })
})

describe('reserved paths', () => {
  it('refuses the data directory even though a root contains it', async () => {
    // The default root is $HOME, and the data directory lives inside it, so
    // containment alone would happily serve the database holding the token
    // signing secret.
    await expectError(() => jail.resolve(DATA), 'forbidden_path')
    await expectError(() => jail.resolve(path.join(DATA, 'webmux.db')), 'forbidden_path')
    await expectError(() => jail.resolveForCreate(path.join(DATA, 'new.db')), 'forbidden_path')
  })
})

describe('platform behaviour', () => {
  it('treats a backslash as an ordinary character, not a separator', async () => {
    // POSIX allows a backslash in a filename, so translating it would break
    // real files. The safety property is the same either way: it cannot climb.
    const name = '..\\..\\outside\\secret.txt'
    const resolved = await jail.resolveForCreate(path.join(ROOT, name))
    assert.equal(resolved.abs, path.join(ROOT, name))
    assert.ok(resolved.abs.startsWith(ROOT + path.sep))
  })

  it('resolves a case-variant path consistently where the filesystem folds case', async () => {
    writeFileSync(path.join(ROOT, 'probe.txt'), 'probe')
    const folded = path.join(ROOT, 'PROBE.TXT')
    const sameFile = await jail.resolve(folded).then(
      (r) => r.abs,
      () => null,
    )
    if (sameFile === null) {
      // Case-sensitive filesystem — nothing to assert beyond "it did not escape".
      return
    }
    assert.equal(sameFile, path.join(ROOT, 'probe.txt'))
  })

  it('handles a non-ASCII filename', async () => {
    const name = '中文 文件.txt'
    writeFileSync(path.join(ROOT, name), 'content')
    const resolved = await jail.resolve(path.join(ROOT, name))
    assert.equal(resolved.abs, path.join(ROOT, name))
    assert.equal(resolved.exists, true)
  })

  it('reports a non-directory ancestor rather than a 500', async () => {
    await expectError(() => jail.resolve(`${ROOT}/file.txt/nested`), 'not_a_directory')
  })

  it('requires a directory for resolveDir', async () => {
    await expectError(() => jail.resolveDir(`${ROOT}/file.txt`), 'not_a_directory')
    const dir = await jail.resolveDir(`${ROOT}/sub`)
    assert.equal(dir.abs, path.join(ROOT, 'sub'))
  })

  it('reports a missing path as not_found', async () => {
    await expectError(() => jail.resolve(`${ROOT}/nope.txt`), 'not_found')
    await expectError(() => jail.resolveTarget(`${ROOT}/nope.txt`), 'not_found')
  })
})

describe('resolveForWrite', () => {
  it('accepts a regular file and canonicalises it', async () => {
    const resolved = await jail.resolveForWrite(`${ROOT}/file.txt`)
    assert.equal(resolved.abs, path.join(ROOT, 'file.txt'))
    assert.equal(resolved.root.name, 'home')
    assert.equal(resolved.exists, true)
  })

  it('follows an in-jail symlink to the file it points at', async () => {
    // The preview followed it, so the save has to as well — otherwise what was
    // edited on screen and what was written would be different files.
    symlinkSync(path.join(ROOT, 'file.txt'), path.join(ROOT, 'link-to-file'))
    const resolved = await jail.resolveForWrite(`${ROOT}/link-to-file`)
    assert.equal(resolved.abs, path.join(ROOT, 'file.txt'))
  })

  it('refuses anything that is not a regular file', async () => {
    await expectError(() => jail.resolveForWrite(`${ROOT}/sub`), 'is_a_directory')
    await expectError(() => jail.resolveForWrite(ROOT), 'is_a_directory')
    await expectError(() => jail.resolveForWrite(`${ROOT}/link-inside`), 'is_a_directory')
  })

  it('refuses a path that is not there, including a dangling link', async () => {
    await expectError(() => jail.resolveForWrite(`${ROOT}/nope.txt`), 'not_found')
    // `invalid_path`, not `not_found`: a dangling link is refused as a link
    // rather than reported as an absent file, which is what stops a caller
    // from believing it can create something there.
    await expectError(() => jail.resolveForWrite(`${ROOT}/dangling`), 'invalid_path')
  })

  it('refuses a read-only root before it looks at the path', async () => {
    await expectError(() => jail.resolveForWrite(`${ROOT}/ro/sealed.txt`), 'readonly_root')
    // Also for a path that is not there: the answer must not reveal whether a
    // read-only root contains something.
    await expectError(() => jail.resolveForWrite(`${ROOT}/ro/nope.txt`), 'readonly_root')
  })

  it('refuses the reserved data directory and anything leaving the root', async () => {
    await expectError(() => jail.resolveForWrite(`${DATA}/webmux.db`), 'forbidden_path')
    await expectError(() => jail.resolveForWrite(`${ROOT}/link-outside-file`), 'path_escape')
    await expectError(() => jail.resolveForWrite(`${ROOT}/link-chain/secret.txt`), 'path_escape')
    await expectError(() => jail.resolveForWrite(`${OUTSIDE}/secret.txt`), 'path_escape')
  })

  it('rejects a malformed path before touching the filesystem', async () => {
    await expectError(() => jail.resolveForWrite('sub/file.txt'), 'invalid_path')
    await expectError(() => jail.resolveForWrite(''), 'invalid_path')
    await expectError(() => jail.resolveForWrite(`${ROOT}/file.txt\0`), 'invalid_path')
  })
})
