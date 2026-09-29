/**
 * Cross-checks our ZIP implementation against three other ones.
 *
 * This is the acceptance criterion for the archive feature, not a bonus suite.
 * `zip.test.mjs` round-trips our writer through our reader, which proves almost
 * nothing: a writer and a reader that share a misunderstanding agree with each
 * other perfectly. The failures that actually matter — the UTF-8 flag missing
 * from one of the two header forms, a zero DOS date, external attributes
 * written as zero, version-needed claiming 45 without zip64 — are invisible to
 * a self-round-trip and immediately visible to `unzip`, to Python's `zipfile`,
 * or to both.
 *
 * Tools are optional so the suite runs anywhere, but a silent skip looks
 * exactly like a pass, so the gap is announced and `WEBMUX_REQUIRE_TOOLS=1`
 * turns it into a hard failure.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { bufferSource, parseArchive } from '../src/fs/zip/read.ts'
import { archiveStream, walkForArchive } from '../src/fs/zip/write.ts'

function has(command) {
  const result = spawnSync(command, ['-v'], { stdio: 'ignore' })
  // A missing binary sets `error` (ENOENT) and leaves `status` null, so
  // checking the status alone would treat "not installed" as success.
  return result.error === undefined && result.status === 0
}

const UNZIP = has('unzip')
const ZIP = has('zip')
const PYTHON = has('python3')

const missing = [!UNZIP && 'unzip', !ZIP && 'zip', !PYTHON && 'python3'].filter(Boolean)

if (missing.length > 0) {
  console.error(
    `\n[zip-interop] MISSING TOOLS: ${missing.join(', ')} — the checks that need them will be SKIPPED.`,
  )
  console.error('[zip-interop] Set WEBMUX_REQUIRE_TOOLS=1 to make this a hard failure instead.\n')
  if (process.env.WEBMUX_REQUIRE_TOOLS === '1') {
    throw new Error(`WEBMUX_REQUIRE_TOOLS=1 but these tools are missing: ${missing.join(', ')}`)
  }
}

const skipUnzip = UNZIP ? false : 'unzip is not installed'
const skipZip = ZIP ? false : 'zip is not installed'
const skipPython = PYTHON ? false : 'python3 is not installed'

let tmp
let tree
let cleanTree

/** Relative path -> contents, or null for a directory. Symlinks are ignored. */
function snapshot(dir) {
  const out = new Map()
  const walk = (current, prefix) => {
    for (const name of readdirSync(current).sort()) {
      const abs = path.join(current, name)
      const rel = prefix === '' ? name : `${prefix}/${name}`
      const info = lstatSync(abs)
      if (info.isDirectory()) {
        out.set(`${rel}/`, null)
        walk(abs, rel)
      } else if (info.isFile()) {
        out.set(rel, readFileSync(abs))
      }
    }
  }
  walk(dir, '')
  return out
}

async function ourArchive(dir, name) {
  const walk = await walkForArchive(
    {
      abs: dir,
      literal: dir,
      exists: true,
      root: { name: 'root', path: dir, readonly: false, available: true },
    },
    name,
  )
  const chunks = []
  for await (const chunk of archiveStream(walk)) chunks.push(chunk)
  return Buffer.concat(chunks)
}

before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'webmux-zip-interop-'))

  tree = path.join(tmp, 'tree')
  mkdirSync(path.join(tree, 'nested', 'deep'), { recursive: true })
  mkdirSync(path.join(tree, 'empty'), { recursive: true })
  writeFileSync(path.join(tree, 'hello.txt'), 'hello world\n')
  writeFileSync(path.join(tree, 'zero.txt'), '')
  // The case that catches a missing UTF-8 flag: with the bit clear, a reader
  // does not produce mojibake, it produces a *different name*.
  writeFileSync(path.join(tree, '中文 文件.txt'), 'chinese payload\n')
  writeFileSync(path.join(tree, 'emoji 🎉.txt'), 'party\n')
  writeFileSync(path.join(tree, 'nested', 'deep', 'leaf.txt'), 'leaf\n')
  writeFileSync(path.join(tree, 'compressible.txt'), 'a'.repeat(100_000))
  writeFileSync(path.join(tree, 'random.bin'), Buffer.from(
    Array.from({ length: 100_000 }, (_, i) => (i * 2654435761) % 256),
  ))

  // No symlinks here. `zip -r` would store one as a symlink entry, and our
  // reader refuses symlink entries outright — so for the zip → us direction the
  // fixture has to be something we would actually accept.
  cleanTree = path.join(tmp, 'clean')
  mkdirSync(path.join(cleanTree, 'sub'), { recursive: true })
  writeFileSync(path.join(cleanTree, 'a.txt'), 'from zip\n')
  writeFileSync(path.join(cleanTree, '中文.txt'), 'zip chinese\n')
  writeFileSync(path.join(cleanTree, 'sub', 'b.txt'), 'nested\n')
})

after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('our writer, read by other tools', () => {
  it('produces an archive `unzip -t` accepts', { skip: skipUnzip }, async () => {
    const archivePath = path.join(tmp, 'ours.zip')
    writeFileSync(archivePath, await ourArchive(tree, 'tree'))

    const result = spawnSync('unzip', ['-t', archivePath], { encoding: 'utf8' })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /No errors detected/)
  })

  it('extracts with `unzip` to a byte-identical tree', { skip: skipUnzip }, async () => {
    const archivePath = path.join(tmp, 'ours2.zip')
    const outDir = path.join(tmp, 'unzipped')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(archivePath, await ourArchive(tree, 'tree'))

    const result = spawnSync('unzip', ['-q', '-o', archivePath, '-d', outDir], { encoding: 'utf8' })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)

    // Contents and the set of paths, both. Comparing only contents would miss
    // a renamed file, which is precisely the failure a missing UTF-8 flag
    // produces.
    const expected = snapshot(tree)
    const actual = snapshot(path.join(outDir, 'tree'))
    for (const [rel, contents] of expected) {
      assert.ok(actual.has(rel), `unzip did not produce ${rel} — a mangled name would look like this`)
      if (contents !== null) assert.ok(contents.equals(actual.get(rel)), `${rel} differs`)
    }
    assert.equal(actual.size, expected.size)
  })

  it('passes Python zipfile, including its CRC re-check', { skip: skipPython }, async () => {
    const archivePath = path.join(tmp, 'ours3.zip')
    writeFileSync(archivePath, await ourArchive(tree, 'tree'))

    const script = `
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
bad = z.testzip()
if bad is not None:
    print("CRC FAILURE:", bad); sys.exit(2)
# Decoded by Python, an independent implementation of the UTF-8 flag.
assert "tree/中文 文件.txt" in names, names
assert "tree/emoji 🎉.txt" in names, names
print("OK", len(names))
`
    const result = spawnSync('python3', ['-c', script, archivePath], { encoding: 'utf8' })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /^OK/)
  })
})

describe('other tools, read by our reader', () => {
  for (const [label, flags] of [
    ['deflate (-9)', ['-9']],
    ['store (-0)', ['-0']],
  ]) {
    it(`reads an archive written by zip(1) with ${label}`, { skip: skipZip }, async () => {
      const archivePath = path.join(tmp, `theirs-${flags[1]}.zip`)
      rmSync(archivePath, { force: true })

      // LANG matters: Info-ZIP only sets the UTF-8 flag under a UTF-8 locale,
      // so without this the test exercises the other code path and would pass
      // while the flag handling is broken.
      const result = spawnSync('zip', ['-q', '-r', ...flags, archivePath, 'clean'], {
        cwd: tmp,
        encoding: 'utf8',
        env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
      })
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)

      const entries = await parseArchive(bufferSource(readFileSync(archivePath)))
      const names = entries.map((entry) => entry.path).sort()
      assert.deepEqual(names, [
        'clean',
        'clean/a.txt',
        'clean/sub',
        'clean/sub/b.txt',
        'clean/中文.txt',
      ])
    })
  }

  it('reads an archive with an empty directory, written by zip(1)', { skip: skipZip }, async () => {
    const source = path.join(tmp, 'emptydir-source')
    mkdirSync(path.join(source, 'hollow'), { recursive: true })
    writeFileSync(path.join(source, 'f.txt'), 'x')

    const archivePath = path.join(tmp, 'emptydir.zip')
    rmSync(archivePath, { force: true })
    spawnSync('zip', ['-q', '-r', archivePath, 'emptydir-source'], {
      cwd: tmp,
      env: { ...process.env, LANG: 'en_US.UTF-8' },
    })

    const entries = await parseArchive(bufferSource(readFileSync(archivePath)))
    assert.ok(
      entries.some((entry) => entry.isDirectory && entry.path === 'emptydir-source/hollow'),
      'the empty directory must survive as an entry of its own',
    )
  })
})
