import { mkdir, open, rm, statfs } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createInflateRaw } from 'node:zlib'
import { FsError, toFsError, type Jail, type ResolvedPath } from '../jail'
import { CRC32_SEED, crc32Final, crc32Update } from './crc32'
import { DEFAULT_LIMITS, type ArchiveEntry, type ArchiveLimits, type ByteSource } from './read'

/**
 * Writes a validated archive to disk.
 *
 * Split from `read.ts` on purpose: parsing is pure and testable on a Buffer,
 * and this half is the one that touches the filesystem, so it is the half that
 * has to go through the jail.
 *
 * The destination is always a directory *this call creates*. That single
 * decision removes a whole class of problems — no merging, no overwrite
 * policy, no collision resolution — and it makes rollback trivial and safe:
 * `rm -rf` on a path we made ourselves and nothing else can be inside.
 *
 * The containment primitive is `jail.resolveForCreate` on **every** entry.
 * Validating the name is not enough. A destination that already contains
 * `a -> /etc` turns a perfectly clean entry named `a/passwd` into a write to
 * `/etc/passwd`, and neither a `..` filter nor a string containment check
 * notices. `resolveForCreate` is the primitive that already closes that: it
 * canonicalises the deepest existing ancestor, checks containment, and refuses
 * a symlink sitting at the target.
 */

const METHOD_DEFLATE = 8
const READ_CHUNK = 64 * 1024

export interface ExtractResult {
  files: number
  directories: number
  bytes: number
}

/** Streams a byte range without materialising it. */
async function* readRange(source: ByteSource, offset: number, length: number): AsyncGenerator<Buffer> {
  let at = offset
  let remaining = length
  while (remaining > 0) {
    const take = Math.min(READ_CHUNK, remaining)
    yield await source.read(at, take)
    at += take
    remaining -= take
  }
}

export async function extractArchive(
  source: ByteSource,
  entries: ArchiveEntry[],
  destination: ResolvedPath,
  jail: Jail,
  limits: ArchiveLimits = DEFAULT_LIMITS,
): Promise<ExtractResult> {
  if (destination.exists) {
    throw new FsError('already_exists', 'destination already exists', 409)
  }

  // The damage a bomb does is filling the disk, and the declared sizes are
  // enough to refuse that before anything is created. The running counters
  // below are the authoritative check, because the declared sizes can lie.
  const stats = await statfs(path.dirname(destination.abs)).catch(() => null)
  if (stats !== null) {
    const declared = entries.reduce((total, entry) => total + entry.uncompressedSize, 0)
    if (declared > stats.bavail * stats.bsize * 0.9) {
      throw new FsError('insufficient_storage', 'not enough free space to extract this archive', 507)
    }
  }

  try {
    // Non-recursive: the destination must be new, so an existing path is a 409
    // rather than a merge.
    await mkdir(destination.abs, { recursive: false, mode: 0o755 })
  } catch (err) {
    throw toFsError(err)
  }

  const result: ExtractResult = { files: 0, directories: 0, bytes: 0 }
  let producedTotal = 0

  try {
    for (const entry of entries) {
      const target = path.join(destination.abs, entry.path)

      // Through the jail, every time. `recursive: true` because an archive need
      // not carry explicit entries for its parent directories.
      const resolved = await jail.resolveForCreate(target, { recursive: true })

      if (entry.isDirectory) {
        await mkdir(resolved.abs, { recursive: true, mode: 0o755 })
        result.directories += 1
        continue
      }

      // Implicit parents, for archives that omit directory entries.
      await mkdir(path.dirname(resolved.abs), { recursive: true, mode: 0o755 })

      const handle = await open(resolved.abs, 'w', 0o644)
      try {
        let register = CRC32_SEED
        let produced = 0

        const write = async (chunk: Buffer): Promise<void> => {
          register = crc32Update(register, chunk)
          produced += chunk.length
          producedTotal += chunk.length

          // The authoritative size checks. Everything in `read.ts` compared
          // *declared* sizes; these compare what is actually coming out.
          if (produced > limits.maxEntryUncompressedBytes) {
            throw new FsError('too_large', `entry "${entry.path}" exceeded the per-file limit`, 413)
          }
          if (producedTotal > limits.maxTotalUncompressedBytes) {
            throw new FsError('too_large', 'archive exceeded the total uncompressed limit', 413)
          }

          await handle.write(chunk)
        }

        const raw = Readable.from(readRange(source, entry.dataOffset, entry.compressedSize))
        const stream = entry.method === METHOD_DEFLATE ? raw.pipe(createInflateRaw()) : raw

        for await (const chunk of stream) {
          await write(chunk as Buffer)
        }

        if (crc32Final(register) !== entry.crc) {
          throw new FsError('checksum_mismatch', `entry "${entry.path}" failed its CRC check`, 409)
        }
        if (produced !== entry.uncompressedSize) {
          throw new FsError(
            'checksum_mismatch',
            `entry "${entry.path}" produced ${produced} bytes, expected ${entry.uncompressedSize}`,
            409,
          )
        }

        await handle.sync()
      } finally {
        await handle.close()
      }

      result.files += 1
      result.bytes += entry.uncompressedSize
    }
  } catch (err) {
    // Safe because the destination is ours end to end: it did not exist before
    // this call and nothing else can have written into it.
    await rm(destination.abs, { recursive: true, force: true }).catch(() => {})
    throw toFsError(err)
  }

  return result
}
