import { createReadStream } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { constants as FS } from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { constants as ZLIB, createDeflateRaw } from 'node:zlib'
import { FsError, toFsError, type ResolvedPath } from '../jail'
import { CRC32_SEED, crc32Final, crc32Update } from './crc32'
import { toDosDateTime } from './dos-time'

/**
 * Streaming ZIP writer.
 *
 * Two invariants hold everywhere in this file, and both are invisible to a
 * round-trip test against our own reader:
 *
 *   1. **The UTF-8 flag (bit 11) is set on the local header *and* the central
 *      directory header.** Most tools read only one of them. With the bit
 *      clear, macOS Archive Utility decodes the name as CP437 and produces a
 *      *different filename* — `中文 文件.txt` becomes box-drawing characters,
 *      and the user cannot tell which file is which. That is not mojibake, it
 *      is the wrong name.
 *   2. **The DOS date is never zero.** Zero decodes as "1980-00-00", which some
 *      Windows paths reject outright.
 *
 * Both are only ever caught by a *foreign* reader, which is why
 * `zip-interop.test.mjs` exists and why it is the acceptance criterion rather
 * than a bonus.
 */

const SIG_LOCAL = 0x04034b50
const SIG_DESCRIPTOR = 0x08074b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_ZIP64_LOCATOR = 0x07064b50

/** Sizes and CRC live in the trailing descriptor instead of the header. */
const FLAG_DATA_DESCRIPTOR = 0x0008
/** Names are UTF-8. */
const FLAG_UTF8 = 0x0800

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

const VERSION_NEEDED = 20
const VERSION_NEEDED_ZIP64 = 45
/** Host 3 = Unix, spec 2.0 — what makes the external attributes mean a mode. */
const VERSION_MADE_BY_UNIX = 0x0314

/** The largest value the classic header fields can hold. */
const MAX_UINT32 = 0xffffffff
const MAX_CLASSIC_ENTRIES = 0xffff

/** Beyond this the pre-flight refuses, rather than emitting a partial archive. */
export const ARCHIVE_MAX_ENTRIES = 200_000
/**
 * Sizes stay under the 4 GiB point where per-entry Zip64 would be required.
 *
 * The entry *count* case of Zip64 is implemented below (it is 76 bytes and
 * 65535 is low enough that a `node_modules` tree exceeds it); the *size* case
 * is refused, because getting a Zip64 extra field subtly wrong yields an
 * archive that some tools open and others reject — the worst failure mode
 * available, for a case nobody hits through a browser.
 */
export const ARCHIVE_MAX_BYTES = MAX_UINT32 - 16 * 1024 * 1024

export interface ArchiveEntry {
  /** Name as it appears in the archive, `/`-separated, directories with a trailing slash. */
  name: string
  kind: 'file' | 'dir'
  abs: string
  size: number
  mtimeMs: number
}

export interface WalkResult {
  entries: ArchiveEntry[]
  /** Symlinks, FIFOs and anything else that is not a regular file or a directory. */
  skipped: string[]
  /** Files that exist but could not be opened; the caller refuses the whole archive. */
  unreadable: string[]
  /** Names whose backslashes were rewritten. Reported, never silent. */
  renamed: string[]
  totalUncompressed: number
}

/**
 * Rewrites a backslash, because `read.ts` refuses any name containing one.
 *
 * The writer must never emit a name its own reader would reject. The
 * asymmetry is deliberate — see the comment in `name.ts` — and its cost is
 * that an archive of a file genuinely named `a\b` contains `a_b` instead. That
 * rename is counted so it can be surfaced rather than discovered.
 */
function archiveSegment(segment: string, renamed: string[], rel: string): string {
  if (!segment.includes('\\')) return segment
  renamed.push(rel)
  return segment.replace(/\\/g, '_')
}

export interface WalkOptions {
  maxEntries?: number
}

/**
 * Collects everything to be archived, *before* the first byte is written.
 *
 * This is what makes honest errors possible. A streaming walk can only fail
 * mid-response, when the status code is already sent; walking first means an
 * unreadable file is a clean 403 with the paths named, an oversized tree is a
 * clean 413, and the response headers can carry an entry count so the client's
 * progress bar has a denominator.
 *
 * The cost is a full recursive `lstat` (plus one probe `open` per file) before
 * the user sees anything, which is why the UI shows "preparing" rather than a
 * dead download button.
 */
export async function walkForArchive(
  root: ResolvedPath,
  rootName: string,
  opts: WalkOptions = {},
): Promise<WalkResult> {
  const maxEntries = opts.maxEntries ?? ARCHIVE_MAX_ENTRIES

  const result: WalkResult = {
    entries: [],
    skipped: [],
    unreadable: [],
    renamed: [],
    totalUncompressed: 0,
  }

  const info = await lstat(root.abs).catch((err: unknown) => {
    throw toFsError(err)
  })

  if (!info.isDirectory()) {
    if (!info.isFile()) {
      throw new FsError('not_a_file', 'only regular files and directories can be archived', 400)
    }
    // A single file archives as itself, with no enclosing directory entry.
    result.entries.push({
      name: archiveSegment(rootName, result.renamed, rootName),
      kind: 'file',
      abs: root.abs,
      size: info.size,
      mtimeMs: info.mtimeMs,
    })
    result.totalUncompressed = info.size
    assertWithinLimits(result)
    return result
  }

  // The root itself, so the archive extracts back to a directory of the same
  // name rather than spilling its contents into the destination.
  result.entries.push({
    name: `${archiveSegment(rootName, result.renamed, rootName)}/`,
    kind: 'dir',
    abs: root.abs,
    size: 0,
    mtimeMs: info.mtimeMs,
  })

  await walkDirectory(root.abs, archiveSegment(rootName, result.renamed, rootName), result, maxEntries)
  assertWithinLimits(result)
  return result
}

async function walkDirectory(
  absDir: string,
  relDir: string,
  result: WalkResult,
  maxEntries: number,
): Promise<void> {
  let handle
  try {
    handle = await opendir(absDir)
  } catch (err) {
    throw toFsError(err)
  }

  const children: Dirent[] = []
  for await (const dirent of handle) children.push(dirent)
  // Directory order is arbitrary; sorting makes the archive reproducible and
  // the tests stable.
  children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  for (const child of children) {
    if (result.entries.length >= maxEntries) {
      throw new FsError('too_large', `archive would exceed ${maxEntries} entries`, 413)
    }

    const abs = path.join(absDir, child.name)
    const rawRel = `${relDir}/${child.name}`
    const info = await lstat(abs).catch(() => null)

    if (info === null) {
      // Vanished between readdir and lstat. Reported, never silently dropped.
      result.skipped.push(rawRel)
      continue
    }

    // Symlinks are skipped rather than included: following one would archive
    // something outside the tree the user asked for, sometimes something
    // enormous, and storing the link itself is a feature nothing here needs.
    if (info.isSymbolicLink()) {
      result.skipped.push(rawRel)
      continue
    }

    const rel = `${relDir}/${archiveSegment(child.name, result.renamed, rawRel)}`

    if (info.isDirectory()) {
      result.entries.push({ name: `${rel}/`, kind: 'dir', abs, size: 0, mtimeMs: info.mtimeMs })
      await walkDirectory(abs, rel, result, maxEntries)
      continue
    }

    if (!info.isFile()) {
      result.skipped.push(rel)
      continue
    }

    // Probing readability here is the point of walking first: an unreadable
    // file becomes a 403 before any bytes move, instead of a hang or a
    // silently short archive halfway through.
    try {
      const probe = await open(abs, FS.O_RDONLY | FS.O_NOFOLLOW)
      await probe.close()
    } catch {
      result.unreadable.push(rel)
      continue
    }

    result.entries.push({ name: rel, kind: 'file', abs, size: info.size, mtimeMs: info.mtimeMs })
    result.totalUncompressed += info.size
  }
}

function assertWithinLimits(result: WalkResult): void {
  if (result.unreadable.length > 0) {
    throw new FsError(
      'permission_denied',
      `${result.unreadable.length} file(s) could not be read`,
      403,
      { paths: result.unreadable.slice(0, 50) },
    )
  }
  // Deflate only ever shrinks output (bar ~0.008% of stored-block overhead on
  // incompressible data), so this is a genuine upper bound rather than a guess.
  const worstCase = result.totalUncompressed + result.entries.length * 128 + 1024 * 1024
  if (worstCase >= ARCHIVE_MAX_BYTES) {
    throw new FsError(
      'too_large',
      'archive would exceed the 4 GiB limit; archive a subdirectory instead',
      413,
    )
  }
}

interface CentralRecord {
  nameBytes: Buffer
  method: number
  time: number
  date: number
  crc: number
  compressed: number
  uncompressed: number
  localOffset: number
  isDirectory: boolean
  streaming: boolean
}

/**
 * Emits the archive.
 *
 * An async generator handed to `Readable.from`, so backpressure is end-to-end
 * with no manual `drain` handling: the consumer pulls, and every `for await`
 * inside suspends on that pull. Nothing is buffered except the central
 * directory, which is bounded by the entry cap.
 */
export async function* archiveStream(walk: WalkResult): AsyncGenerator<Buffer> {
  const central: CentralRecord[] = []
  let offset = 0

  const send = (buf: Buffer): Buffer => {
    if (offset + buf.length >= ARCHIVE_MAX_BYTES) {
      // The pre-flight said this could not happen, but a file that grew since
      // then can still make it so. Throwing here aborts the response *without*
      // an EOCD, leaving an archive that is detectably incomplete — a
      // half-written Zip64 archive would not be.
      throw new FsError('too_large', 'archive grew past the size limit while streaming', 413)
    }
    offset += buf.length
    return buf
  }

  for (const entry of walk.entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const { time, date } = toDosDateTime(entry.mtimeMs)
    const isDirectory = entry.kind === 'dir'
    // Only a file with bytes to stream needs a descriptor. A directory or an
    // empty file knows all three values up front, and deflating nothing
    // produces a two-byte stream for no reason.
    const streaming = !isDirectory && entry.size > 0
    const method = streaming ? METHOD_DEFLATE : METHOD_STORE

    const header = Buffer.alloc(30)
    header.writeUInt32LE(SIG_LOCAL, 0)
    header.writeUInt16LE(VERSION_NEEDED, 4)
    header.writeUInt16LE((streaming ? FLAG_DATA_DESCRIPTOR : 0) | FLAG_UTF8, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(date, 12)
    header.writeUInt32LE(0, 14)
    header.writeUInt32LE(0, 18)
    header.writeUInt32LE(0, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    header.writeUInt16LE(0, 28)

    const localOffset = offset
    yield send(header)
    yield send(nameBytes)

    let crc = 0
    let compressed = 0
    let uncompressed = 0

    if (streaming) {
      const out = createDeflateRaw({ level: ZLIB.Z_DEFAULT_COMPRESSION })
      const source = createReadStream(entry.abs)
      let register = CRC32_SEED

      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          register = crc32Update(register, chunk)
          uncompressed += chunk.length
          done(null, chunk)
        },
      })

      // `pipe` does not forward errors. Without this, a read that fails partway
      // — EACCES after the probe, EIO, the file vanishing — leaves the deflater
      // open forever, so the `for await` below never completes and the response
      // hangs until the client gives up. A silent resource leak rather than a
      // visible failure, which is why it gets a test of its own.
      source.on('error', (err) => out.destroy(err))
      // And the other direction, which `pipe` does not cover: it propagates
      // nothing upstream, so a client that aborts the download destroys the
      // deflater and leaves this read stream open on a file nobody is reading.
      // One descriptor per aborted download — and a process that runs out of
      // descriptors does not fail here, it fails everywhere, all at once.
      out.on('close', () => source.destroy())
      source.pipe(meter).pipe(out)

      for await (const chunk of out) {
        compressed += chunk.length
        yield send(chunk)
      }
      crc = crc32Final(register)

      const descriptor = Buffer.alloc(16)
      descriptor.writeUInt32LE(SIG_DESCRIPTOR, 0)
      descriptor.writeUInt32LE(crc, 4)
      descriptor.writeUInt32LE(compressed, 8)
      descriptor.writeUInt32LE(uncompressed, 12)
      yield send(descriptor)
    }

    central.push({
      nameBytes,
      method,
      time,
      date,
      crc,
      compressed,
      uncompressed,
      localOffset,
      isDirectory,
      streaming,
    })
  }

  const centralStart = offset
  for (const record of central) {
    const buf = Buffer.alloc(46)
    buf.writeUInt32LE(SIG_CENTRAL, 0)
    buf.writeUInt16LE(VERSION_MADE_BY_UNIX, 4)
    buf.writeUInt16LE(VERSION_NEEDED, 6)
    // Must duplicate the local header's flags, bit 11 especially: a reader that
    // trusts only the central directory would otherwise see a different name
    // encoding than one that trusts only the local header.
    buf.writeUInt16LE((record.streaming ? FLAG_DATA_DESCRIPTOR : 0) | FLAG_UTF8, 8)
    buf.writeUInt16LE(record.method, 10)
    buf.writeUInt16LE(record.time, 12)
    buf.writeUInt16LE(record.date, 14)
    buf.writeUInt32LE(record.crc, 16)
    buf.writeUInt32LE(record.compressed, 20)
    buf.writeUInt32LE(record.uncompressed, 24)
    buf.writeUInt16LE(record.nameBytes.length, 28)
    buf.writeUInt16LE(0, 30)
    buf.writeUInt16LE(0, 32)
    buf.writeUInt16LE(0, 34)
    buf.writeUInt16LE(0, 36)
    // Unix mode in the high 16 bits, DOS directory bit in the low. Writing zero
    // here — the usual shortcut — is why hand-rolled archives extract as mode
    // 600 files and mode 000 directories.
    buf.writeUInt32LE(
      record.isDirectory ? (((0o40755 << 16) | 0x10) >>> 0) : (0o100644 << 16) >>> 0,
      38,
    )
    buf.writeUInt32LE(record.localOffset, 42)

    yield send(buf)
    yield send(record.nameBytes)
  }
  const centralSize = offset - centralStart

  // Count-only Zip64. 65535 entries is low enough that an ordinary tree
  // exceeds it, and the record is 56 + 20 bytes with no per-entry changes.
  const needsZip64 = central.length > MAX_CLASSIC_ENTRIES
  if (needsZip64) {
    const zip64Offset = offset
    const record = Buffer.alloc(56)
    record.writeUInt32LE(SIG_ZIP64_EOCD, 0)
    record.writeBigUInt64LE(44n, 4)
    record.writeUInt16LE(VERSION_NEEDED_ZIP64, 12)
    record.writeUInt16LE(VERSION_NEEDED_ZIP64, 14)
    record.writeUInt32LE(0, 16)
    record.writeUInt32LE(0, 20)
    record.writeBigUInt64LE(BigInt(central.length), 24)
    record.writeBigUInt64LE(BigInt(central.length), 32)
    record.writeBigUInt64LE(BigInt(centralSize), 40)
    record.writeBigUInt64LE(BigInt(centralStart), 48)
    yield send(record)

    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(SIG_ZIP64_LOCATOR, 0)
    locator.writeUInt32LE(0, 4)
    locator.writeBigUInt64LE(BigInt(zip64Offset), 8)
    locator.writeUInt32LE(1, 16)
    yield send(locator)
  }

  // Last, always: every reader finds the archive by scanning backwards for this
  // signature, so anything after it is invisible.
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(needsZip64 ? MAX_CLASSIC_ENTRIES : central.length, 8)
  eocd.writeUInt16LE(needsZip64 ? MAX_CLASSIC_ENTRIES : central.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralStart, 16)
  eocd.writeUInt16LE(0, 20)
  yield eocd
}
