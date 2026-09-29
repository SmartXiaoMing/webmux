/**
 * Unit tests for the ZIP writer and reader.
 *
 * Pure: no server, no tmux, no fixtures beyond a temporary directory. The
 * reader is exercised against in-memory buffers, which is what makes the attack
 * cases cheap enough to write all of — the API-level suite cannot construct a
 * name with a backslash in it, let alone an archive whose two name fields
 * disagree.
 *
 * What this file deliberately does NOT prove: that the archives we produce are
 * readable by anything other than us. Round-trip tests are nearly worthless as
 * interop evidence, because a writer and reader that share a misunderstanding
 * agree with each other perfectly. That job belongs to `zip-interop.test.mjs`,
 * which puts `unzip`, Python's `zipfile` and `zip(1)` in the loop.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { crc32 as zlibCrc32, deflateRawSync } from 'node:zlib'
import { createJail, loadRoots } from '../src/fs/jail.ts'
import { CRC32_SEED, crc32, crc32Final, crc32Update } from '../src/fs/zip/crc32.ts'
import { toDosDateTime } from '../src/fs/zip/dos-time.ts'
import { extractArchive } from '../src/fs/zip/extract.ts'
import { validateEntryName } from '../src/fs/zip/name.ts'
import { DEFAULT_LIMITS, bufferSource, parseArchive } from '../src/fs/zip/read.ts'
import { archiveStream, walkForArchive } from '../src/fs/zip/write.ts'
import { buildZip, zip64Extra } from './zip.helpers.mjs'

let tmp
let tree

/** Runs the async generator to completion. */
async function collect(generator) {
  const chunks = []
  for await (const chunk of generator) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/** A ResolvedPath, which is all `walkForArchive` needs from the jail. */
function resolved(abs) {
  return {
    abs,
    literal: abs,
    exists: true,
    root: { name: 'root', path: abs, readonly: false, available: true },
  }
}

/** Reads the central directory's names straight out of the bytes. */
function centralNames(archive) {
  const eocdAt = archive.length - 22
  const count = archive.readUInt16LE(eocdAt + 10)
  const cdAt = archive.readUInt32LE(eocdAt + 16)
  const names = []
  let at = cdAt
  for (let i = 0; i < count; i += 1) {
    const nameLength = archive.readUInt16LE(at + 28)
    const extraLength = archive.readUInt16LE(at + 30)
    const commentLength = archive.readUInt16LE(at + 32)
    names.push(archive.subarray(at + 46, at + 46 + nameLength).toString('utf8'))
    at += 46 + nameLength + extraLength + commentLength
  }
  return names
}

/** The flags field of each central directory entry. */
function centralFlags(archive) {
  const eocdAt = archive.length - 22
  const count = archive.readUInt16LE(eocdAt + 10)
  const cdAt = archive.readUInt32LE(eocdAt + 16)
  const flags = []
  let at = cdAt
  for (let i = 0; i < count; i += 1) {
    const nameLength = archive.readUInt16LE(at + 28)
    const extraLength = archive.readUInt16LE(at + 30)
    const commentLength = archive.readUInt16LE(at + 32)
    flags.push(archive.readUInt16LE(at + 8))
    at += 46 + nameLength + extraLength + commentLength
  }
  return flags
}

async function expectCode(fn, code) {
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

before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'webmux-zip-'))
  tree = path.join(tmp, 'tree')
  mkdirSync(path.join(tree, 'nested', 'deep'), { recursive: true })
  mkdirSync(path.join(tree, 'empty'), { recursive: true })
  writeFileSync(path.join(tree, 'hello.txt'), 'hello world')
  writeFileSync(path.join(tree, 'zero.txt'), '')
  writeFileSync(path.join(tree, '中文 文件.txt'), 'chinese')
  writeFileSync(path.join(tree, 'nested', 'deep', 'leaf.txt'), 'leaf')
  writeFileSync(path.join(tree, 'big.bin'), Buffer.alloc(200_000, 7))
  // Must be skipped rather than followed or stored.
  symlinkSync('hello.txt', path.join(tree, 'link.txt'))
})

after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('crc32', () => {
  it('matches the published vectors', () => {
    assert.equal(crc32(Buffer.from('')), 0)
    assert.equal(crc32(Buffer.from('a')), 0xe8b7be43)
    assert.equal(crc32(Buffer.from('abc')), 0x352441c2)
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
  })

  it('agrees with zlib on random input', () => {
    // An independent implementation, which is the only kind of check that
    // catches a table built from the wrong polynomial.
    for (let i = 0; i < 200; i += 1) {
      const length = Math.floor(Math.random() * 2000)
      const data = Buffer.alloc(length)
      for (let j = 0; j < length; j += 1) data[j] = Math.floor(Math.random() * 256)
      assert.equal(crc32(data), zlibCrc32(data) >>> 0, `length ${length}`)
    }
  })

  it('agrees with zlib when folded in chunks', () => {
    // A rolling register has to be independent of where the boundaries fall.
    // A single off-by-one shows up at one chunk size and nowhere else.
    const data = Buffer.alloc(70_000)
    for (let i = 0; i < data.length; i += 1) data[i] = (i * 31) & 0xff
    const expected = crc32(data)

    for (const chunkSize of [1, 2, 3, 7, 8, 63, 64, 65, 4095, 4096, 65535, 65536]) {
      let register = CRC32_SEED
      for (let at = 0; at < data.length; at += chunkSize) {
        register = crc32Update(register, data.subarray(at, at + chunkSize))
      }
      assert.equal(crc32Final(register), expected, `chunk size ${chunkSize}`)
    }
  })

  it('distinguishes the seed from the empty-input CRC', () => {
    assert.equal(crc32Final(CRC32_SEED), 0)
    assert.notEqual(CRC32_SEED, 0)
  })
})

describe('dos time', () => {
  const decode = (value) => ({
    year: ((value.date >> 9) & 0x7f) + 1980,
    month: (value.date >> 5) & 0x0f,
    day: value.date & 0x1f,
  })

  it('encodes a normal timestamp', () => {
    const when = new Date(2026, 8, 28, 16, 30, 44)
    const encoded = toDosDateTime(when.getTime())
    assert.deepEqual(decode(encoded), { year: 2026, month: 9, day: 28 })
    assert.equal((encoded.time >> 11) & 0x1f, 16)
    assert.equal((encoded.time >> 5) & 0x3f, 30)
    // Two-second resolution: 44 seconds is stored as 22.
    assert.equal((encoded.time & 0x1f) * 2, 44)
  })

  it('clamps below the DOS epoch instead of writing a zero date', () => {
    // Zero decodes as "1980-00-00" and some Windows paths reject it outright.
    const encoded = toDosDateTime(new Date(1970, 0, 1).getTime())
    const { year, month, day } = decode(encoded)
    assert.equal(year, 1980)
    assert.ok(month >= 1 && day >= 1, `month/day must be valid, got ${month}/${day}`)
    assert.notEqual(encoded.date, 0)
  })

  it('clamps above the representable range', () => {
    const encoded = toDosDateTime(new Date(2200, 0, 1).getTime())
    assert.equal(decode(encoded).year, 2107)
  })

  it('never writes a zero date for a nonsense mtime', () => {
    for (const value of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const encoded = toDosDateTime(value)
      assert.notEqual(encoded.date, 0, `mtime ${value}`)
      assert.ok(decode(encoded).month >= 1)
    }
  })
})

describe('entry name validation', () => {
  const accepted = [
    ['plain.txt', 'plain.txt'],
    ['dir/file.txt', 'dir/file.txt'],
    ['dir/', 'dir'],
    // Harmless normalisation, not traversal.
    ['./a/./b', 'a/b'],
    ['a//b', 'a/b'],
    ['中文 文件.txt', '中文 文件.txt'],
    ['a:b', 'a:b'],
    ['-', '-'],
  ]

  for (const [input, expected] of accepted) {
    it(`accepts ${JSON.stringify(input)}`, () => {
      assert.equal(validateEntryName(input).path, expected)
    })
  }

  const rejected = [
    '../etc/passwd',
    'a/../../etc/passwd',
    'a/..',
    '/etc/passwd',
    '//etc/passwd',
    'C:/Windows/system32',
    'C:\\Windows',
    // The deliberate asymmetry with the jail: on POSIX this is one legal
    // filename, but it is also a four-level traversal for a Windows reader.
    '..\\..\\etc\\passwd',
    'a\\b',
    '\\\\server\\share',
    'has\0null',
    '',
    '.',
    './',
    '..',
  ]

  for (const input of rejected) {
    it(`rejects ${JSON.stringify(input)}`, async () => {
      await expectCode(async () => validateEntryName(input), 'unsafe_archive')
    })
  }

  it('rejects an over-long name and an over-long segment', async () => {
    await expectCode(async () => validateEntryName('x'.repeat(5000)), 'unsafe_archive')
    await expectCode(async () => validateEntryName(`${'y'.repeat(300)}/f`), 'unsafe_archive')
  })
})

describe('writer and reader round trip', () => {
  let archive
  let entries

  before(async () => {
    const walk = await walkForArchive(resolved(tree), 'tree')
    archive = await collect(archiveStream(walk))
    entries = await parseArchive(bufferSource(archive))
    globalThis.__walk = walk
  })

  it('skips the symlink and says so', () => {
    assert.equal(globalThis.__walk.skipped.length, 1)
    assert.match(globalThis.__walk.skipped[0], /link\.txt$/)
  })

  it('reads back every entry', () => {
    const names = entries.map((entry) => entry.path).sort()
    assert.deepEqual(names, [
      'tree',
      'tree/big.bin',
      'tree/empty',
      'tree/hello.txt',
      'tree/nested',
      'tree/nested/deep',
      'tree/nested/deep/leaf.txt',
      'tree/zero.txt',
      'tree/中文 文件.txt',
    ])
  })

  it('registers the empty directory, which nothing else can imply', () => {
    // Losing this is silent data loss: no file path can imply an empty folder.
    assert.ok(entries.some((entry) => entry.isDirectory && entry.path === 'tree/empty'))
  })

  it('gives every central name its full relative path', () => {
    // The "unzips flat" regression: names must carry their parent prefix.
    const names = centralNames(archive)
    assert.ok(names.includes('tree/nested/deep/leaf.txt'))
    assert.ok(names.every((name) => name === 'tree/' || name.startsWith('tree/')))
    assert.ok(names.every((name) => !name.includes('\\')), 'every separator must be 0x2f')
  })

  it('sets the UTF-8 flag on both header forms', () => {
    // Most tools read only one of them, so if they disagree the same archive
    // has two different names depending on who opens it.
    const flags = centralFlags(archive)
    assert.ok(flags.length > 0)
    for (const value of flags) {
      assert.ok((value & 0x0800) !== 0, 'central header must set bit 11')
    }

    // Walked via the central directory's recorded offsets, never by advancing
    // through local headers: a streaming entry's local header carries zero
    // sizes with the real ones trailing in a data descriptor, so advancing by
    // them lands in the middle of the entry's data.
    const eocdAt = archive.length - 22
    const count = archive.readUInt16LE(eocdAt + 10)
    let at = archive.readUInt32LE(eocdAt + 16)

    for (let i = 0; i < count; i += 1) {
      const localOffset = archive.readUInt32LE(at + 42)
      assert.equal(archive.readUInt32LE(localOffset), 0x04034b50, `local header ${i} signature`)
      assert.ok(
        (archive.readUInt16LE(localOffset + 6) & 0x0800) !== 0,
        `local header ${i} must set bit 11`,
      )

      const nameLength = archive.readUInt16LE(at + 28)
      const extraLength = archive.readUInt16LE(at + 30)
      const commentLength = archive.readUInt16LE(at + 32)
      at += 46 + nameLength + extraLength + commentLength
    }
  })

  it('points every central local-header offset at a real local header', () => {
    const eocdAt = archive.length - 22
    const count = archive.readUInt16LE(eocdAt + 10)
    let at = archive.readUInt32LE(eocdAt + 16)
    for (let i = 0; i < count; i += 1) {
      const localOffset = archive.readUInt32LE(at + 42)
      assert.equal(archive.readUInt32LE(localOffset), 0x04034b50, `entry ${i}`)
      const nameLength = archive.readUInt16LE(at + 28)
      const extraLength = archive.readUInt16LE(at + 30)
      const commentLength = archive.readUInt16LE(at + 32)
      at += 46 + nameLength + extraLength + commentLength
    }
  })

  it('does not claim to need zip64 for an ordinary archive', () => {
    const eocdAt = archive.length - 22
    const count = archive.readUInt16LE(eocdAt + 10)
    let at = archive.readUInt32LE(eocdAt + 16)
    for (let i = 0; i < count; i += 1) {
      // Version 45 makes some validators declare the archive unreadable.
      assert.equal(archive.readUInt16LE(at + 6), 20, `entry ${i} version needed`)
      const nameLength = archive.readUInt16LE(at + 28)
      const extraLength = archive.readUInt16LE(at + 30)
      const commentLength = archive.readUInt16LE(at + 32)
      at += 46 + nameLength + extraLength + commentLength
    }
  })

  it('preserves file contents byte for byte', async () => {
    const source = await import('node:fs/promises')
    const expected = await source.readFile(path.join(tree, 'big.bin'))
    const entry = entries.find((candidate) => candidate.path === 'tree/big.bin')
    assert.equal(entry.uncompressedSize, expected.length)
    assert.equal(entry.compressedSize, archive.readUInt32LE(0) === 0 ? 0 : entry.compressedSize)
    assert.ok(entry.compressedSize > 0)
  })

  it('stores a zero-length file without a data descriptor', () => {
    const zero = entries.find((entry) => entry.path === 'tree/zero.txt')
    assert.equal(zero.method, 0, 'nothing to deflate')
    assert.equal(zero.uncompressedSize, 0)
  })
})

describe('crafted archives are refused', () => {
  const cases = [
    ['a traversing name', () => buildZip([{ name: '../evil.txt', data: Buffer.from('x') }]), 'unsafe_archive'],
    ['an absolute name', () => buildZip([{ name: '/etc/passwd', data: Buffer.from('x') }]), 'unsafe_archive'],
    ['a backslash name', () => buildZip([{ name: '..\\evil.txt', data: Buffer.from('x') }]), 'unsafe_archive'],
    ['a NUL in the name', () => buildZip([{ name: 'ok\0.txt', data: Buffer.from('x') }]), 'unsafe_archive'],
    [
      'a symlink entry',
      () => buildZip([{ name: 'link', data: Buffer.from('/etc'), mode: 0o120777 }]),
      'unsafe_archive',
    ],
    ['a FIFO entry', () => buildZip([{ name: 'pipe', mode: 0o010644 }]), 'unsafe_archive'],
    [
      'a name ending in / but typed as a file',
      () => buildZip([{ name: 'dir/', mode: 0o100644 }]),
      'unsafe_archive',
    ],
    [
      'a directory typed entry without a trailing slash',
      () => buildZip([{ name: 'dir', mode: 0o040755 }]),
      'unsafe_archive',
    ],
    [
      'a directory entry carrying data',
      () => buildZip([{ name: 'dir/', data: Buffer.from('payload'), mode: 0o040755 }]),
      'unsafe_archive',
    ],
    [
      'local and central names that disagree',
      () => buildZip([{ name: 'innocent.txt', centralName: '../evil.txt', data: Buffer.from('x') }]),
      'unsafe_archive',
    ],
    ['an encrypted entry', () => buildZip([{ name: 'a.txt', flags: 0x0801 }]), 'unsupported_archive'],
    ['strong encryption', () => buildZip([{ name: 'a.txt', flags: 0x0840 }]), 'unsupported_archive'],
    ['a masked header', () => buildZip([{ name: 'a.txt', flags: 0x2800 }]), 'unsupported_archive'],
    ['bzip2 compression', () => buildZip([{ name: 'a.txt', method: 12 }]), 'unsupported_archive'],
    ['LZMA compression', () => buildZip([{ name: 'a.txt', method: 14 }]), 'unsupported_archive'],
    [
      'a zip64 extra field',
      () => buildZip([{ name: 'a.txt', extra: zip64Extra(10), centralExtra: zip64Extra(10) }]),
      'unsupported_archive',
    ],
    ['a multi-disk archive', () => buildZip([{ name: 'a.txt' }], { diskNumber: 1 }), 'unsupported_archive'],
    ['a file that is not a zip', () => Buffer.from('definitely not a zip file'), 'unsupported_archive'],
    ['an empty file', () => Buffer.alloc(0), 'unsupported_archive'],
    [
      'a truncated archive',
      () => buildZip([{ name: 'a.txt', data: Buffer.from('x') }]).subarray(0, 40),
      'unsupported_archive',
    ],
  ]

  for (const [label, build, code] of cases) {
    it(`refuses ${label}`, async () => {
      await expectCode(async () => parseArchive(bufferSource(build())), code)
    })
  }

  it('finds the real EOCD when the comment contains a fake signature', () => {
    const real = buildZip([{ name: 'a.txt', data: Buffer.from('hello') }])
    const fake = Buffer.alloc(22)
    fake.writeUInt32LE(0x06054b50, 0)
    const archive = buildZip([{ name: 'a.txt', data: Buffer.from('hello') }], { comment: fake })
    assert.ok(archive.length > real.length, 'the comment must actually be appended')
    // Without the "ends exactly at EOF" check, the fake wins the backwards scan.
    return parseArchive(bufferSource(archive)).then((entries) => {
      assert.deepEqual(entries.map((entry) => entry.path), ['a.txt'])
    })
  })

  it('refuses overlapping entries', async () => {
    const archive = buildZip([
      { name: 'one.txt', data: Buffer.from('aaaaaaaaaa') },
      { name: 'two.txt', data: Buffer.from('bb'), localOffset: 0 },
    ])
    await expectCode(async () => parseArchive(bufferSource(archive)), 'unsafe_archive')
  })

  it('refuses a declared compression ratio that cannot be honest', async () => {
    // 50 compressed bytes claiming 100 000 uncompressed: 2000:1.
    const archive = buildZip([
      { name: 'bomb.txt', method: 8, claimedUncompressed: 100_000, data: Buffer.alloc(50) },
    ])
    await expectCode(async () => parseArchive(bufferSource(archive)), 'too_large')
  })

  it('refuses more entries than the limit allows', async () => {
    const archive = buildZip([{ name: 'a.txt' }, { name: 'b.txt' }])
    await expectCode(async () => parseArchive(bufferSource(archive), { maxEntries: 1 }), 'too_large')
  })

  it('refuses a declared size above the per-entry limit', async () => {
    const archive = buildZip([{ name: 'big.txt', data: Buffer.alloc(100) }])
    await expectCode(
      async () => parseArchive(bufferSource(archive), { maxEntryUncompressedBytes: 10 }),
      'too_large',
    )
  })

  it('accepts an archive whose entry count needs a zip64 EOCD', async () => {
    // (below)
    // The writer/reader coupling test. If the writer emits a zip64 EOCD that
    // the reader rejects, the feature is broken for exactly the trees that
    // made it worth implementing.
    const many = path.join(tmp, 'many')
    mkdirSync(many, { recursive: true })
    const walk = await walkForArchive(resolved(many), 'many')
    const archive = await collect(archiveStream(walk))
    const entries = await parseArchive(bufferSource(archive))
    assert.equal(entries.length, 1)
  })
})

/**
 * A jail over a fresh temporary root, with the data directory kept *outside*
 * it — putting it inside would make the root itself reserved, which is the
 * guard doing its job but not what these tests are about.
 */
async function makeJail(prefix) {
  const base = mkdtempSync(path.join(tmpdir(), prefix))
  const root = path.join(base, 'root')
  const data = path.join(base, 'data')
  mkdirSync(root, { recursive: true })
  mkdirSync(data, { recursive: true })
  const jail = await createJail(
    await loadRoots([{ name: 'r', path: root, readonly: false }], data),
    data,
  )
  return { base, root, jail }
}

describe('extraction limits', () => {
  it('stops on the running byte count, not only on the declared size', async () => {
    // Declares 4 000 bytes and actually inflates ten megabytes. Every
    // declared-size check in read.ts passes — the ratio is unremarkable and the
    // size is under any sane cap — so the only thing that can catch this is the
    // counter watching bytes as they are actually produced. Without this test
    // that counter is entirely unverified.
    const { base, root, jail } = await makeJail('webmux-zip-bomb-')
    try {
      const archive = buildZip([
        {
          name: 'bomb.bin',
          method: 8,
          data: deflateRawSync(Buffer.alloc(10 * 1024 * 1024)),
          claimedUncompressed: 4000,
        },
      ])
      const entries = await parseArchive(bufferSource(archive))
      const destination = await jail.resolveForCreate(path.join(root, 'out'))

      await expectCode(
        () =>
          extractArchive(bufferSource(archive), entries, destination, jail, {
            ...DEFAULT_LIMITS,
            maxEntryUncompressedBytes: 5000,
          }),
        'too_large',
      )
      assert.equal(existsSync(path.join(root, 'out')), false, 'the destination must be rolled back')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('rolls back the destination when an entry fails its CRC', async () => {
    const { base, root, jail } = await makeJail('webmux-zip-crc-')
    try {
      // The stored CRC is of different bytes than the entry contains.
      const archive = buildZip([
        { name: 'good.txt', data: Buffer.from('fine') },
        { name: 'bad.txt', data: Buffer.from('corrupt'), crc: 0xdeadbeef },
      ])
      const entries = await parseArchive(bufferSource(archive))
      const destination = await jail.resolveForCreate(path.join(root, 'out'))

      await expectCode(
        () => extractArchive(bufferSource(archive), entries, destination, jail),
        'checksum_mismatch',
      )
      // The first entry extracted fine; the whole thing still rolls back,
      // because a half-extracted tree the user cannot distinguish from a
      // complete one is worse than no tree at all.
      assert.equal(existsSync(path.join(root, 'out')), false, 'a corrupt archive must leave nothing')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

/**
 * Descriptors currently open in this process.
 *
 * Counted from the kernel rather than inferred, because the failure this guards
 * against is invisible from inside the program: nothing throws, nothing logs,
 * and the only symptom is a later `EMFILE` that takes down every file operation
 * in the process at once.
 */
function openFdCount() {
  for (const dir of ['/dev/fd', '/proc/self/fd']) {
    try {
      return readdirSync(dir).length
    } catch {
      // Not this platform's spelling — try the next.
    }
  }
  throw new Error('neither /dev/fd nor /proc/self/fd is available')
}

describe('the archive stream releases its file handles', () => {
  it('closes the source when the consumer walks away mid-download', async () => {
    // A cancelled or dropped download destroys the deflater while the read
    // stream is still mid-file. `pipe` propagates nothing upstream, so without
    // an explicit teardown that descriptor stays open on a file nobody is
    // reading. One leak per aborted download; a phone that backgrounds a few
    // large archives is enough to reach the process-wide descriptor limit.
    const dir = path.join(tree, 'aborted')
    mkdirSync(dir, { recursive: true })
    // Random, not repetitive, and that is the whole trick: a buffer of a single
    // repeated byte compresses to almost nothing, so the deflater swallows the
    // entire file immediately and the read stream has already closed by the
    // time the consumer gives up. Incompressible data keeps the deflater behind
    // the reader, which is what leaves the source genuinely mid-file.
    writeFileSync(path.join(dir, 'big.bin'), randomBytes(4 * 1024 * 1024))

    const walk = await walkForArchive(resolved(dir), 'aborted')
    const baseline = openFdCount()

    for (let i = 0; i < 10; i += 1) {
      const iterator = archiveStream(walk)
      // Pull past the header and the name, which are yielded before the file is
      // opened — stopping at the first chunk would abandon the generator before
      // it ever touched the disk, and prove nothing.
      for (let pulled = 0; pulled < 5; pulled += 1) await iterator.next()
      // What an aborted response does to the generator feeding it.
      await iterator.return()
    }

    // Destruction is asynchronous, so poll rather than assume it has landed.
    const deadline = Date.now() + 3000
    while (openFdCount() > baseline && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    assert.ok(
      openFdCount() <= baseline,
      `descriptors grew from ${baseline} to ${openFdCount()} across 10 aborted archives`,
    )
  })
})
