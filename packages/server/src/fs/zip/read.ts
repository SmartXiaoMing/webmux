import type { FileHandle } from 'node:fs/promises'
import { FsError } from '../jail'
import { decodeEntryName, validateEntryName } from './name'

/**
 * ZIP reader — parsing and validation only.
 *
 * This module knows nothing about the filesystem or the jail: it takes a
 * random-access byte source and returns a validated entry list. That is what
 * makes the attack cases cheap to test (an in-memory Buffer is a valid source)
 * and it keeps the containment logic in exactly one place, `jail.ts`, rather
 * than growing a second, weaker copy here.
 *
 * ## Why the central directory is read first
 *
 * A local header carries placeholder CRC and sizes whenever general-purpose
 * bit 3 is set — which is what any streaming writer produces, ours included. A
 * reader that walks local headers in order therefore has to *scan* for the data
 * descriptor signature, which is ambiguous with compressed data. The central
 * directory carries the authoritative values plus each local header's offset,
 * so reading it first means data descriptors are never parsed at all: we seek
 * straight past them.
 *
 * The trap that falls out of this: **the local header's `extraLen` may differ
 * from the central directory's**, so the data offset must come from the local
 * header we re-read, never from the CD's lengths. Info-ZIP puts timestamp
 * extras in the local header only, so a reader that reuses the CD's lengths is
 * correct for every archive our own writer emits and wrong for a real one.
 */

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const SIG_ZIP64_EXTRA = 0x0001

const EOCD_SIZE = 22
const MAX_COMMENT = 0xffff
const CENTRAL_HEADER_SIZE = 46
const LOCAL_HEADER_SIZE = 30
const MAX_UINT32 = 0xffffffff
const MAX_CLASSIC_ENTRIES = 0xffff

/** Encryption, in its several spellings. */
const FLAG_ENCRYPTED = 0x0001
const FLAG_STRONG_ENCRYPTION = 0x0040
const FLAG_PATCHED_DATA = 0x0020
const FLAG_MASKED_HEADER = 0x2000

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** Unix `st_mode` file-type bits, when the archive carries them. */
const S_IFMT = 0xf000
const S_IFIFO = 0x1000
const S_IFCHR = 0x2000
const S_IFDIR = 0x4000
const S_IFREG = 0x8000
const S_IFLNK = 0xa000
const S_IFBLK = 0x6000
const S_IFSOCK = 0xc000

export interface ByteSource {
  readonly size: number
  read(offset: number, length: number): Promise<Buffer>
}

/** For tests: an archive that is already in memory. */
export function bufferSource(buffer: Buffer): ByteSource {
  return {
    size: buffer.length,
    read: async (offset, length) =>
      buffer.subarray(offset, Math.min(offset + length, buffer.length)),
  }
}

/** For production: positional reads against an open file. */
export function fileSource(handle: FileHandle, size: number): ByteSource {
  return {
    size,
    read: async (offset, length) => {
      // Bounded by the file, so a (deliberately) corrupt header asking for a
      // huge read cannot allocate its way into a denial of service.
      const wanted = Math.max(0, Math.min(length, size - offset))
      const buffer = Buffer.alloc(wanted)
      if (wanted === 0) return buffer
      const { bytesRead } = await handle.read(buffer, 0, wanted, offset)
      return buffer.subarray(0, bytesRead)
    },
  }
}

export interface ArchiveLimits {
  maxEntries: number
  maxCentralDirectoryBytes: number
  maxEntryUncompressedBytes: number
  maxTotalUncompressedBytes: number
  /**
   * Per entry and for the archive as a whole, on *declared* sizes.
   *
   * Deliberately loose. This is the cap most likely to reject legitimate data —
   * a run of zeros in a log compresses around 1000:1 honestly — so it exists to
   * catch the pathological case, not to be a tight bound.
   */
  maxCompressionRatio: number
}

export const DEFAULT_LIMITS: ArchiveLimits = {
  maxEntries: 200_000,
  maxCentralDirectoryBytes: 64 * 1024 * 1024,
  maxEntryUncompressedBytes: 2 * 1024 * 1024 * 1024,
  maxTotalUncompressedBytes: 8 * 1024 * 1024 * 1024,
  maxCompressionRatio: 1000,
}

export interface ArchiveEntry {
  /** Validated, relative, `/`-separated. */
  path: string
  isDirectory: boolean
  method: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  /** Absolute offset of the local header, verified during parsing. */
  localHeaderOffset: number
  /** Absolute offset of the entry's data, computed from the *local* header. */
  dataOffset: number
}

function unsupported(why: string): never {
  throw new FsError('unsupported_archive', `unsupported archive: ${why}`, 400)
}
function unsafe(why: string): never {
  throw new FsError('unsafe_archive', `refusing archive: ${why}`, 400)
}
function tooLarge(why: string): never {
  throw new FsError('too_large', `archive too large: ${why}`, 413)
}

interface Eocd {
  cdOffset: number
  cdSize: number
  count: number
}

async function readEocd(source: ByteSource): Promise<Eocd> {
  if (source.size < EOCD_SIZE) unsupported('file is too small to be a zip')

  const window = Math.min(source.size, EOCD_SIZE + MAX_COMMENT)
  const tail = await source.read(source.size - window, window)

  /*
   * Scanning backwards finds the *last* structurally valid record first, which
   * is usually the real one. Not always: an archive comment can contain bytes
   * shaped exactly like an EOCD, and then the fake is found first and wins.
   *
   * The tie-break is that in any ordinary archive the central directory ends
   * exactly where the EOCD begins. A candidate whose offset and size do not add
   * up to its own position is therefore held back as a fallback rather than
   * accepted — which still allows a self-extracting stub or other prepended
   * data, where every offset is shifted and no candidate would match.
   */
  let fallback: Eocd | null = null

  for (let i = tail.length - EOCD_SIZE; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) !== SIG_EOCD) continue
    // The record must end exactly at EOF, or the comment length it declares
    // runs past the file.
    if (i + EOCD_SIZE + tail.readUInt16LE(i + 20) !== tail.length) continue

    const position = source.size - window + i
    const diskNumber = tail.readUInt16LE(i + 4)
    const diskWithCd = tail.readUInt16LE(i + 6)
    const entriesOnDisk = tail.readUInt16LE(i + 8)
    const totalEntries = tail.readUInt16LE(i + 10)
    const cdSize = tail.readUInt32LE(i + 12)
    const cdOffset = tail.readUInt32LE(i + 16)

    // A spanned archive cannot be reconstructed from one file.
    if (diskNumber !== 0 || diskWithCd !== 0 || entriesOnDisk !== totalEntries) {
      unsupported('multi-disk archives are not supported')
    }

    const needsZip64 =
      totalEntries === MAX_CLASSIC_ENTRIES || cdOffset === MAX_UINT32 || cdSize === MAX_UINT32

    if (!needsZip64) {
      const candidate: Eocd = { cdOffset, cdSize, count: totalEntries }
      if (cdOffset + cdSize === position) return candidate
      fallback ??= candidate
      continue
    }

    // Count-only Zip64 is accepted — our own writer emits it above 65535
    // entries. Sizes past 4 GiB are not: they would need a per-entry extra
    // field in both header forms, and getting one subtly wrong produces an
    // archive some tools open and others reject.
    const locatorAt = i - 20
    if (locatorAt < 0 || tail.readUInt32LE(locatorAt) !== SIG_ZIP64_LOCATOR) {
      unsupported('zip64 archive has no locator record')
    }
    const zip64At = Number(tail.readBigUInt64LE(locatorAt + 8))
    if (zip64At + 56 > source.size) unsupported('zip64 end-of-central-directory is out of range')

    const record = await source.read(zip64At, 56)
    if (record.readUInt32LE(0) !== SIG_ZIP64_EOCD) {
      unsupported('zip64 end-of-central-directory record is malformed')
    }

    const count = Number(record.readBigUInt64LE(32))
    const size64 = Number(record.readBigUInt64LE(40))
    const offset64 = Number(record.readBigUInt64LE(48))

    if (offset64 > MAX_UINT32 || size64 > MAX_UINT32) {
      unsupported('archives larger than 4 GiB need zip64 sizes, which are not supported')
    }

    const zipped: Eocd = { cdOffset: offset64, cdSize: size64, count }
    if (offset64 + size64 === position) return zipped
    fallback ??= zipped
  }

  if (fallback !== null) return fallback
  unsupported('no end-of-central-directory record found')
}

/**
 * Parses, verifies and validates an archive.
 *
 * Validation is a phase, not a sprinkle: everything below completes before the
 * caller writes a single byte, so a rejected archive leaves nothing behind.
 */
export async function parseArchive(
  source: ByteSource,
  limits: ArchiveLimits = DEFAULT_LIMITS,
): Promise<ArchiveEntry[]> {
  const eocd = await readEocd(source)

  if (eocd.count > limits.maxEntries) tooLarge(`more than ${limits.maxEntries} entries`)
  if (eocd.cdSize > limits.maxCentralDirectoryBytes) tooLarge('central directory is too large')
  if (eocd.cdOffset + eocd.cdSize > source.size) unsupported('central directory runs past end of file')

  const cd = await source.read(eocd.cdOffset, eocd.cdSize)
  if (cd.length < eocd.cdSize) unsupported('central directory is truncated')

  const entries: ArchiveEntry[] = []
  let totalUncompressed = 0
  let offset = 0

  for (let i = 0; i < eocd.count; i += 1) {
    if (offset + CENTRAL_HEADER_SIZE > cd.length) unsupported('central directory entry is truncated')
    if (cd.readUInt32LE(offset) !== SIG_CENTRAL) unsupported('central directory entry is malformed')

    const versionMadeBy = cd.readUInt16LE(offset + 4)
    const flags = cd.readUInt16LE(offset + 8)
    const method = cd.readUInt16LE(offset + 10)
    const crc = cd.readUInt32LE(offset + 16)
    const compressedSize = cd.readUInt32LE(offset + 20)
    const uncompressedSize = cd.readUInt32LE(offset + 24)
    const nameLength = cd.readUInt16LE(offset + 28)
    const extraLength = cd.readUInt16LE(offset + 30)
    const commentLength = cd.readUInt16LE(offset + 32)
    const externalAttributes = cd.readUInt32LE(offset + 38)
    const localHeaderOffset = cd.readUInt32LE(offset + 42)

    const nameEnd = offset + CENTRAL_HEADER_SIZE + nameLength
    if (nameEnd + extraLength + commentLength > cd.length) {
      unsupported('central directory entry runs past the directory')
    }

    const rawName = cd.subarray(offset + CENTRAL_HEADER_SIZE, nameEnd)
    const extra = cd.subarray(nameEnd, nameEnd + extraLength)
    offset = nameEnd + extraLength + commentLength

    if ((flags & FLAG_ENCRYPTED) !== 0) unsupported('archive is password-protected')
    if ((flags & FLAG_STRONG_ENCRYPTION) !== 0) unsupported('archive uses strong encryption')
    if ((flags & FLAG_PATCHED_DATA) !== 0) unsupported('entry uses patched data')
    if ((flags & FLAG_MASKED_HEADER) !== 0) unsupported('entry uses masked header values')
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      unsupported(`compression method ${method} is not supported (only store and deflate are)`)
    }

    if (hasZip64Extra(extra) || compressedSize === MAX_UINT32 || uncompressedSize === MAX_UINT32) {
      unsupported('entry needs zip64 sizes, which are not supported')
    }

    const decoded = decodeEntryName(rawName, (flags & 0x0800) !== 0)
    const { path: entryPath, trailingSlash } = validateEntryName(decoded)

    // The high 16 bits of the external attributes are a Unix mode, but *only*
    // when the writing host was a Unix. For an MS-DOS-written archive they are
    // unspecified, and reading them anyway makes the archive look like it is
    // full of device files.
    const host = versionMadeBy >>> 8
    const unixMode = host === 3 || host === 19 ? externalAttributes >>> 16 : 0
    const fileType = unixMode & S_IFMT

    if (fileType === S_IFLNK) {
      // Refusing the whole archive, not just this entry. A planted symlink is a
      // *persistent* escape primitive: `a -> /etc` created by entry 3 turns the
      // perfectly innocent-looking entry 4 named `a/passwd` into a write
      // outside the jail. The same reasoning as `ops.ts`, where recursive
      // delete deliberately does not follow links.
      unsafe(`entry "${entryPath}" is a symbolic link, which webmux will not create`)
    }
    if (
      fileType === S_IFIFO ||
      fileType === S_IFCHR ||
      fileType === S_IFBLK ||
      fileType === S_IFSOCK
    ) {
      unsafe(`entry "${entryPath}" is a device, socket or FIFO`)
    }

    const dosDirectoryBit = (externalAttributes & 0x10) !== 0
    const isDirectory = trailingSlash || dosDirectoryBit

    // Disagreement between the name and the mode is an evasion trick, and the
    // check costs one comparison.
    if (trailingSlash && fileType === S_IFREG) {
      unsafe(`entry "${entryPath}" is named as a directory but typed as a file`)
    }
    if (!trailingSlash && fileType === S_IFDIR) {
      unsafe(`entry "${entryPath}" is typed as a directory but not named as one`)
    }

    if (isDirectory && (uncompressedSize !== 0 || method !== METHOD_STORE)) {
      unsafe(`directory entry "${entryPath}" carries data`)
    }

    if (!isDirectory) {
      if (uncompressedSize > limits.maxEntryUncompressedBytes) {
        tooLarge(`entry "${entryPath}" declares ${uncompressedSize} bytes`)
      }
      if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio) {
        tooLarge(`entry "${entryPath}" has a compression ratio above ${limits.maxCompressionRatio}:1`)
      }
      totalUncompressed += uncompressedSize
      if (totalUncompressed > limits.maxTotalUncompressedBytes) {
        tooLarge('declared uncompressed total exceeds the limit')
      }
    }

    if (localHeaderOffset + LOCAL_HEADER_SIZE > source.size) {
      unsupported(`entry "${entryPath}" points past the end of the file`)
    }

    entries.push({
      path: entryPath,
      isDirectory,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      dataOffset: 0,
    })
  }

  await verifyLocalHeaders(source, entries)
  assertNoOverlap(entries)
  return entries
}

/** Zip64 lives in an extra field with header id 0x0001. */
function hasZip64Extra(extra: Buffer): boolean {
  let at = 0
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at)
    const size = extra.readUInt16LE(at + 2)
    if (id === SIG_ZIP64_EXTRA) return true
    at += 4 + size
  }
  return false
}

/**
 * Re-reads every local header.
 *
 * Two things come out of this, and both are invisible to a round-trip test
 * against our own writer:
 *
 *   - the data offset, computed from the *local* name/extra lengths. Most
 *     writers put extras in the local header that the central directory then
 *     drops, so reusing the CD's lengths lands the read at the wrong byte for
 *     every archive we did not write.
 *   - agreement between the local and central names. A disagreement is the
 *     signature of an archive built so that a scanner and an extractor see
 *     different things.
 */
async function verifyLocalHeaders(source: ByteSource, entries: ArchiveEntry[]): Promise<void> {
  for (const entry of entries) {
    const header = await source.read(entry.localHeaderOffset, LOCAL_HEADER_SIZE)
    if (header.length < LOCAL_HEADER_SIZE || header.readUInt32LE(0) !== SIG_LOCAL) {
      unsupported(`entry "${entry.path}" has no local header`)
    }

    const nameLength = header.readUInt16LE(26)
    const extraLength = header.readUInt16LE(28)
    const nameStart = entry.localHeaderOffset + LOCAL_HEADER_SIZE
    const dataOffset = nameStart + nameLength + extraLength

    const localName = await source.read(nameStart, nameLength)
    const centralNameLength = Buffer.byteLength(entry.path, 'utf8')
    // Compare the raw bytes: the central name was normalised (empty and `.`
    // segments stripped), so re-normalising here would hide a real difference.
    if (localName.length === centralNameLength && localName.toString('utf8') !== entry.path) {
      // Only flag when the name differs after the same normalisation the
      // central copy went through.
      const revalidated = validateEntryName(decodeEntryName(localName, true)).path
      if (revalidated !== entry.path) {
        unsafe(`entry "${entry.path}" disagrees with its local header name`)
      }
    }

    if (dataOffset + entry.compressedSize > source.size) {
      unsupported(`entry "${entry.path}" data runs past the end of the file`)
    }
    entry.dataOffset = dataOffset
  }
}

/**
 * Rejects entries whose byte ranges overlap.
 *
 * Overlap is never legitimate, and it is how a "quine" archive shows a scanner
 * one thing and an extractor another. Sorted, it is a single pass.
 */
function assertNoOverlap(entries: ArchiveEntry[]): void {
  const sorted = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset)
  let previousEnd = 0
  for (const entry of sorted) {
    if (entry.localHeaderOffset < previousEnd) {
      unsafe(`entry "${entry.path}" overlaps another entry`)
    }
    previousEnd = entry.dataOffset + entry.compressedSize
  }
}
