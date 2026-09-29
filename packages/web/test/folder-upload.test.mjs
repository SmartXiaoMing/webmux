/**
 * Folder upload: paths, traversal, and the batch orchestration.
 *
 * Two things make this worth its own suite. The path rules are the security-
 * adjacent part — a flattened `a/b` is a silent overwrite of `a_b` — and the
 * traversal cannot be covered from a browser test at all: a synthetic
 * `DataTransfer` cannot carry a real `FileSystemEntry`, and Playwright's
 * directory upload exercises `webkitRelativePath`, not the entry API. The
 * entry shapes are therefore structural interfaces, and these fakes are the
 * only thing that walks them.
 *
 * No DOM, no server: fake entries, fake deps, and the clock-free parts of the
 * batch runner.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BATCH_CONCURRENCY,
  batchLabel,
  collectEntry,
  manifestFromFileList,
  manifestFromSnapshot,
  planDirectories,
  runManifest,
  safeSegments,
} from '../src/lib/folder-upload.ts'
import { taskKey } from '../src/lib/upload.ts'
import { ApiError } from '../src/lib/api.ts'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A File with a `webkitRelativePath`, which cannot be set in a constructor. */
function fakeFile(name, relPath) {
  const file = new File(['contents'], name)
  if (relPath !== undefined) Object.defineProperty(file, 'webkitRelativePath', { value: relPath })
  return file
}

function fileEntry(name, file = fakeFile(name)) {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (ok) => ok(file),
  }
}

function throwingFileEntry(name, error) {
  return { name, isFile: true, isDirectory: false, file: (_ok, err) => err(error) }
}

/**
 * A directory whose reader answers one batch per call, then an empty batch.
 *
 * `batches` is a list of arrays so a test can prove the read loop drains a
 * directory in more than one call — a single-call implementation truncates
 * every real directory past ~100 entries.
 */
function dirEntry(name, batches, { readError = null } = {}) {
  let call = 0
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => ({
      readEntries: (ok, err) => {
        if (readError !== null && call >= batches.length) {
          err(readError)
          return
        }
        const batch = batches[call] ?? []
        call += 1
        ok(batch)
      },
    }),
  }
}

function emptyManifest() {
  return { dirs: [], files: [], errors: [] }
}

/** Records everything the orchestration does, so ordering can be asserted. */
function fakeDeps(overrides = {}) {
  const calls = { mkdir: [], uploaded: [], failed: [], reserved: [] }
  const deps = {
    calls,
    reserve: (entry, target) => calls.reserved.push({ rel: entry.relPath, target }),
    upload: async (entry) => calls.uploaded.push(entry.relPath),
    fail: (entry, target, opts, message) => calls.failed.push({ rel: entry.relPath, message }),
    mkdir: async (path) => calls.mkdir.push(path),
    stateOf: () => 'queued',
    ...overrides,
  }
  return deps
}

// ---------------------------------------------------------------------------

describe('safeSegments', () => {
  it('keeps separators as separators', () => {
    assert.deepEqual(safeSegments('tree/sub/a.txt'), ['tree', 'sub', 'a.txt'])
    assert.deepEqual(safeSegments('a.txt'), ['a.txt'])
  })

  it('keeps dotfiles, which are ordinary names', () => {
    assert.deepEqual(safeSegments('.git/config'), ['.git', 'config'])
    assert.deepEqual(safeSegments('..x/y'), ['..x', 'y'])
  })

  it('treats a backslash as an ordinary character', () => {
    // POSIX filenames may contain one, and the server's jail deliberately
    // leaves it alone. A Windows *path* never reaches here: browser-supplied
    // paths are always '/'-separated.
    assert.deepEqual(safeSegments('a\\b'), ['a\\b'])
  })

  it('refuses anything that is not a plain relative path', () => {
    for (const rel of ['', '/abs', 'a//b', 'a/', 'a/./b', 'a/../b', '..', '.', 'a/\0b']) {
      assert.equal(safeSegments(rel), null, `should refuse ${JSON.stringify(rel)}`)
    }
  })

  it('refuses rather than rewriting, so nothing is silently retargeted', () => {
    // `safeName` would turn this into `_`-joined text and write somewhere the
    // user never pointed at. Null means the entry is skipped and reported.
    assert.equal(safeSegments('../outside'), null)
  })
})

describe('manifestFromFileList', () => {
  it('derives the directory tree from the relative paths', () => {
    const manifest = manifestFromFileList([
      fakeFile('a.txt', 'tree/sub/a.txt'),
      fakeFile('top.txt', 'tree/top.txt'),
    ])
    assert.deepEqual(manifest.files.map((f) => f.relPath), ['tree/sub/a.txt', 'tree/top.txt'])
    assert.deepEqual(new Set(manifest.dirs), new Set(['tree', 'tree/sub']))
    assert.deepEqual(manifest.errors, [])
  })

  it('treats a file with no relative path as a loose file', () => {
    const manifest = manifestFromFileList([fakeFile('loose.txt')])
    assert.deepEqual(manifest.files.map((f) => f.relPath), ['loose.txt'])
    assert.deepEqual(manifest.dirs, [])
  })

  it('reports an unsafe path instead of uploading it', () => {
    const manifest = manifestFromFileList([fakeFile('evil.txt', '../evil.txt')])
    assert.deepEqual(manifest.files, [])
    assert.equal(manifest.errors.length, 1)
  })
})

describe('planDirectories', () => {
  it('unions explicit directories with the ancestors of every file', () => {
    const manifest = {
      dirs: ['tree/empty'],
      files: [{ file: fakeFile('a.txt', 'tree/sub/a.txt'), relPath: 'tree/sub/a.txt' }],
      errors: [],
    }
    assert.deepEqual(planDirectories(manifest), ['tree', 'tree/empty', 'tree/sub'])
  })

  it('deduplicates', () => {
    const manifest = {
      dirs: ['tree', 'tree'],
      files: [
        { file: fakeFile('a.txt', 'tree/a.txt'), relPath: 'tree/a.txt' },
        { file: fakeFile('b.txt', 'tree/b.txt'), relPath: 'tree/b.txt' },
      ],
      errors: [],
    }
    assert.deepEqual(planDirectories(manifest), ['tree'])
  })
})

describe('batchLabel', () => {
  it('names the batch after the picked root', () => {
    const manifest = {
      dirs: [],
      files: [{ file: fakeFile('a.txt', 'photos/a.txt'), relPath: 'photos/a.txt' }],
      errors: [],
    }
    assert.equal(batchLabel(manifest), 'photos')
  })
})

describe('collectEntry', () => {
  it('walks a tree, recording directories and files', async () => {
    const out = emptyManifest()
    const tree = dirEntry('root', [
      [dirEntry('sub', [[fileEntry('deep.txt')]]), fileEntry('top.txt')],
      [],
    ])
    await collectEntry(tree, '', out)

    assert.deepEqual(out.dirs, ['root', 'root/sub'])
    assert.deepEqual(out.files.map((f) => f.relPath), ['root/sub/deep.txt', 'root/top.txt'])
    assert.deepEqual(out.errors, [])
  })

  it('keeps an empty directory, which nothing inside it would name', async () => {
    const out = emptyManifest()
    await collectEntry(dirEntry('root', [[dirEntry('empty', [[]])], []]), '', out)
    assert.deepEqual(out.dirs, ['root', 'root/empty'])
    assert.deepEqual(out.files, [])
  })

  it('drains a directory over several readEntries calls', async () => {
    // The real API hands back at most ~100 entries per call and signals the
    // end with an empty array. Reading once truncates silently.
    const out = emptyManifest()
    await collectEntry(
      dirEntry('root', [[fileEntry('a.txt')], [fileEntry('b.txt'), fileEntry('c.txt')], []]),
      '',
      out,
    )
    assert.deepEqual(out.files.map((f) => f.relPath), ['root/a.txt', 'root/b.txt', 'root/c.txt'])
  })

  it('records an unreadable file and carries on with its siblings', async () => {
    const out = emptyManifest()
    await collectEntry(
      dirEntry('root', [[throwingFileEntry('bad.txt', new Error('gone')), fileEntry('ok.txt')], []]),
      '',
      out,
    )
    assert.deepEqual(out.files.map((f) => f.relPath), ['root/ok.txt'])
    assert.deepEqual(out.errors, [{ relPath: 'root/bad.txt', message: 'gone' }])
  })

  it('keeps what it read when a directory errors part-way', async () => {
    const out = emptyManifest()
    await collectEntry(dirEntry('root', [[fileEntry('a.txt')]], { readError: new Error('nope') }), '', out)
    assert.deepEqual(out.files.map((f) => f.relPath), ['root/a.txt'])
    assert.equal(out.errors.length, 1)
    assert.equal(out.errors[0].message, 'nope')
  })

  it('stops descending past the depth cap, visibly', async () => {
    const out = emptyManifest()
    let entry = dirEntry('leaf', [[]])
    for (let i = 0; i < 40; i += 1) entry = dirEntry(`d${i}`, [[entry], []])
    await collectEntry(entry, '', out)

    assert.equal(out.files.length, 0)
    assert.ok(out.errors.some((e) => e.message.includes('层')))
  })

  it('stops at the entry cap rather than eating the browser', async () => {
    const out = emptyManifest()
    const many = Array.from({ length: 20_001 }, (_, i) => fileEntry(`f${i}.txt`))
    await collectEntry(dirEntry('root', [many, []]), '', out)

    // Directories count towards the cap too — `root` itself is one entry, so
    // the files come to one less than the cap.
    assert.equal(out.files.length + out.dirs.length, 20_000)
    assert.equal(out.errors.length, 1)
    assert.ok(out.errors[0].message.includes('条目'))
  })

  it('refuses a dropped entry whose name is unsafe', async () => {
    const out = emptyManifest()
    await collectEntry({ name: '..', isFile: true, isDirectory: false, file: () => {} }, '', out)
    assert.deepEqual(out.files, [])
    assert.equal(out.errors.length, 1)
  })
})

describe('manifestFromSnapshot', () => {
  it('combines loose files and walked entries', async () => {
    const manifest = await manifestFromSnapshot({
      entries: [dirEntry('tree', [[fileEntry('a.txt', 'tree/a.txt')], []])],
      loose: [fakeFile('loose.txt')],
    })
    assert.deepEqual(manifest.files.map((f) => f.relPath).sort(), ['loose.txt', 'tree/a.txt'])
  })
})

describe('runManifest', () => {
  function twoFileManifest() {
    return {
      dirs: ['tree', 'tree/sub'],
      files: [
        { file: fakeFile('a.txt', 'tree/a.txt'), relPath: 'tree/a.txt' },
        { file: fakeFile('b.txt', 'tree/sub/b.txt'), relPath: 'tree/sub/b.txt' },
      ],
      errors: [],
    }
  }

  it('creates every directory, then uploads every file', async () => {
    const deps = fakeDeps()
    const result = await runManifest(twoFileManifest(), '/dest', 'tree', deps)

    assert.deepEqual(deps.calls.mkdir.sort(), ['/dest/tree', '/dest/tree/sub'])
    assert.deepEqual(deps.calls.uploaded.sort(), ['tree/a.txt', 'tree/sub/b.txt'])
    assert.deepEqual(deps.calls.reserved.map((r) => r.target).sort(), [
      '/dest/tree/a.txt',
      '/dest/tree/sub/b.txt',
    ])
    assert.deepEqual(result, { uploaded: 2, failed: 0, skipped: 0 })
  })

  it('fails exactly the subtree of a directory that could not be created', async () => {
    const deps = fakeDeps({
      mkdir: async (path) => {
        if (path === '/dest/tree/sub') throw new ApiError(409, 'already_exists', '已经存在')
      },
    })
    const result = await runManifest(twoFileManifest(), '/dest', 'tree', deps)

    // The file outside the failed subtree still goes up...
    assert.deepEqual(deps.calls.uploaded, ['tree/a.txt'])
    // ...and the one inside is reported with the real reason rather than being
    // sent to collect a puzzling 404 from upload/init.
    assert.deepEqual(deps.calls.failed, [
      { rel: 'tree/sub/b.txt', message: '无法创建目录 tree/sub：已经存在' },
    ])
    assert.deepEqual(result, { uploaded: 1, failed: 1, skipped: 0 })
  })

  it('never exceeds the file-level concurrency bound', async () => {
    let inFlight = 0
    let peak = 0
    const deps = fakeDeps({
      upload: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight -= 1
      },
    })
    const manifest = {
      dirs: ['tree'],
      files: Array.from({ length: 20 }, (_, i) => ({
        file: fakeFile(`f${i}.txt`, `tree/f${i}.txt`),
        relPath: `tree/f${i}.txt`,
      })),
      errors: [],
    }
    await runManifest(manifest, '/dest', 'tree', deps)

    assert.equal(peak, BATCH_CONCURRENCY)
  })

  it('does not resurrect a file cancelled while it was queued', async () => {
    const deps = fakeDeps({ stateOf: (entry) => (entry.relPath === 'tree/a.txt' ? 'cancelled' : 'queued') })
    const result = await runManifest(twoFileManifest(), '/dest', 'tree', deps)

    assert.deepEqual(deps.calls.uploaded, ['tree/sub/b.txt'])
    assert.equal(result.uploaded, 1)
  })

  it('counts a failed upload and keeps going', async () => {
    const attempted = []
    const deps = fakeDeps({
      upload: async (entry) => {
        attempted.push(entry.relPath)
        if (entry.relPath === 'tree/a.txt') throw new ApiError(500, 'boom', '炸了')
      },
    })
    const result = await runManifest(twoFileManifest(), '/dest', 'tree', deps)

    // Both were attempted: one file failing must not stop the batch.
    assert.deepEqual(attempted.sort(), ['tree/a.txt', 'tree/sub/b.txt'])
    assert.deepEqual(result, { uploaded: 1, failed: 1, skipped: 0 })
  })

  it('reports traversal errors as skipped', async () => {
    const manifest = twoFileManifest()
    manifest.errors.push({ relPath: '../x', message: '路径不安全，已跳过' })
    const result = await runManifest(manifest, '/dest', 'tree', fakeDeps())
    assert.equal(result.skipped, 1)
  })

  it('creates a directory for a tree that is only directories', async () => {
    const deps = fakeDeps()
    const result = await runManifest(
      { dirs: ['tree', 'tree/empty'], files: [], errors: [] },
      '/dest',
      'tree',
      deps,
    )
    assert.deepEqual(deps.calls.mkdir.sort(), ['/dest/tree', '/dest/tree/empty'])
    assert.deepEqual(result, { uploaded: 0, failed: 0, skipped: 0 })
  })
})

describe('taskKey', () => {
  it('separates files that differ only by destination', () => {
    // Without the target these two collapse into one task: one of them is
    // never uploaded, and a resume could retarget the remembered bytes.
    const a = fakeFile('package.json')
    Object.defineProperty(a, 'lastModified', { value: 1 })
    const b = fakeFile('package.json')
    Object.defineProperty(b, 'lastModified', { value: 1 })

    assert.notEqual(taskKey(a, '/dest/x/package.json'), taskKey(b, '/dest/y/package.json'))
    assert.equal(taskKey(a, '/dest/x/package.json'), taskKey(b, '/dest/x/package.json'))
  })
})
