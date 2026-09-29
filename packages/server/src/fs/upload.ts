import { createHash, randomBytes } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  statfs,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { FS_UPLOAD_CHUNK_SIZE, type FsByteRange, type FsUploadStatus } from '@webmux/shared'
import { FsError, errnoOf, toFsError, type Jail } from './jail'
import { logger } from '../logger'

const log = logger.child('fs:upload')

/**
 * The staging area's only guard.
 *
 * An upload id is the one piece of client input that becomes a path component
 * here, so it is checked before every single use rather than once at the door —
 * a regex that runs on the way in is worth nothing if a later call site
 * forgets. 22 base64url characters is exactly 16 random bytes.
 */
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

const META_VERSION = 1

interface UploadMeta {
  version: number
  uploadId: string
  /** Destination, as the client gave it. Re-resolved at install time. */
  target: string
  size: number
  chunkSize: number
  createdAt: number
  updatedAt: number
  /** Base64 of one bit per chunk, LSB-first within each byte. */
  bitmap: string
}

function chunkCount(size: number, chunkSize: number): number {
  return Math.ceil(size / chunkSize)
}

function isSet(bitmap: Buffer, index: number): boolean {
  return ((bitmap[index >> 3] ?? 0) & (1 << (index & 7))) !== 0
}

function setBit(bitmap: Buffer, index: number): void {
  bitmap[index >> 3] = (bitmap[index >> 3] ?? 0) | (1 << (index & 7))
}

/**
 * Merged half-open ranges, rather than the raw bitmap.
 *
 * A client can act on these directly — "send me everything not in this list" —
 * and the merged form stays small: 16 GiB at 4 MiB chunks is 4096 bits, and in
 * practice a handful of ranges rather than 4096 entries.
 */
function rangesFromBitmap(bitmap: Buffer, chunks: number, size: number, chunkSize: number): FsByteRange[] {
  const ranges: FsByteRange[] = []
  let open = -1

  for (let i = 0; i < chunks; i += 1) {
    if (isSet(bitmap, i)) {
      if (open === -1) open = i
      continue
    }
    if (open !== -1) {
      ranges.push([open * chunkSize, i * chunkSize])
      open = -1
    }
  }
  // The final range ends at `size`, not at the chunk boundary: the last chunk
  // is normally short.
  if (open !== -1) ranges.push([open * chunkSize, size])

  return ranges
}

function missingRanges(bitmap: Buffer, chunks: number, size: number, chunkSize: number): FsByteRange[] {
  const inverted = Buffer.alloc(bitmap.length)
  for (let i = 0; i < chunks; i += 1) {
    if (!isSet(bitmap, i)) setBit(inverted, i)
  }
  return rangesFromBitmap(inverted, chunks, size, chunkSize)
}

export interface UploadInitInput {
  path: string
  size: number
}

export class UploadStore {
  /** One pending promise per upload, so two tabs cannot interleave a read-modify-write of meta.json. */
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(
    private readonly jail: Jail,
    private readonly dataDir: string,
    private readonly ttlMs: number,
    private readonly maxUploadBytes: number | null,
  ) {}

  private get root(): string {
    return path.join(this.dataDir, 'uploads')
  }

  /**
   * Resolves an upload id to its staging directory.
   *
   * The format check comes first, always: this is the only thing standing
   * between a client-supplied string and a path join.
   */
  private dirFor(id: string): string {
    if (!UPLOAD_ID_PATTERN.test(id)) {
      throw new FsError('invalid_request', 'malformed upload id', 400)
    }
    return path.join(this.root, id)
  }

  /**
   * Chains operations per upload.
   *
   * Chunks arrive concurrently and each one rewrites `meta.json`; without this
   * two of them could read the same bitmap and the later write would silently
   * discard the earlier chunk's bit.
   */
  private serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.inFlight.get(id) ?? Promise.resolve()
    // Chained on both settle paths, so one failed chunk cannot wedge the queue.
    const run = previous.then(fn, fn)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.inFlight.set(id, tail)
    void tail.then(() => {
      if (this.inFlight.get(id) === tail) this.inFlight.delete(id)
    })
    return run
  }

  private async writeMeta(dir: string, meta: UploadMeta): Promise<void> {
    // Written to a temporary name and renamed, so a crash can never leave a
    // half-written meta.json that reads as a corrupt upload.
    const tmp = path.join(dir, 'meta.json.tmp')
    await writeFile(tmp, JSON.stringify(meta), { mode: 0o600 })
    await rename(tmp, path.join(dir, 'meta.json'))
  }

  /** Returns null for anything unreadable, rather than throwing: used by the sweeper. */
  private async readMetaAt(dir: string): Promise<UploadMeta | null> {
    let raw: string
    try {
      raw = await readFile(path.join(dir, 'meta.json'), 'utf8')
    } catch {
      return null
    }
    try {
      const parsed = JSON.parse(raw) as Partial<UploadMeta>
      if (
        parsed?.version !== META_VERSION ||
        typeof parsed.uploadId !== 'string' ||
        typeof parsed.target !== 'string' ||
        typeof parsed.size !== 'number' ||
        typeof parsed.chunkSize !== 'number' ||
        typeof parsed.updatedAt !== 'number' ||
        typeof parsed.bitmap !== 'string'
      ) {
        return null
      }
      return parsed as UploadMeta
    } catch {
      return null
    }
  }

  private async readMeta(id: string): Promise<{ dir: string; meta: UploadMeta; bitmap: Buffer }> {
    const dir = this.dirFor(id)
    const meta = await this.readMetaAt(dir)
    // Nothing here is trusted: an unparseable or wrong-version meta reads as
    // "no such upload" and the sweeper will clear the directory out.
    if (meta === null) throw new FsError('upload_not_found', 'no such upload', 404)
    return { dir, meta, bitmap: Buffer.from(meta.bitmap, 'base64') }
  }

  private toStatus(meta: UploadMeta, bitmap: Buffer): FsUploadStatus {
    const chunks = chunkCount(meta.size, meta.chunkSize)
    const received = rangesFromBitmap(bitmap, chunks, meta.size, meta.chunkSize)

    let complete = true
    for (let i = 0; i < chunks; i += 1) {
      if (!isSet(bitmap, i)) {
        complete = false
        break
      }
    }

    return {
      uploadId: meta.uploadId,
      path: meta.target,
      size: meta.size,
      chunkSize: meta.chunkSize,
      received,
      bytesReceived: received.reduce((total, [start, end]) => total + (end - start), 0),
      expiresAt: meta.updatedAt + this.ttlMs,
      complete,
    }
  }

  /**
   * Opens an upload session.
   *
   * Not optional, and not lazy: it is the only place that can answer "is this
   * root writable, and is there room on the disk" *before* the client commits
   * bandwidth. Deferring it means discovering a 403 after uploading 2 GB.
   */
  async init(input: UploadInitInput): Promise<FsUploadStatus> {
    if (this.maxUploadBytes !== null && input.size > this.maxUploadBytes) {
      throw new FsError('too_large', `uploads are limited to ${this.maxUploadBytes} bytes`, 413)
    }

    // Validates the target, that its root is writable, and that it is not the
    // reserved data directory.
    await this.jail.resolveForCreate(input.path)

    const stats = await statfs(this.dataDir).catch(() => null)
    if (stats !== null && stats.bavail * stats.bsize < input.size) {
      // Refused up front rather than discovered as a truncated file at the end.
      throw new FsError('insufficient_storage', 'not enough free space for this upload', 507)
    }

    const id = randomBytes(16).toString('base64url')
    const dir = path.join(this.root, id)
    await mkdir(dir, { recursive: true, mode: 0o700 })

    const now = Date.now()
    const meta: UploadMeta = {
      version: META_VERSION,
      uploadId: id,
      target: input.path,
      size: input.size,
      chunkSize: FS_UPLOAD_CHUNK_SIZE,
      createdAt: now,
      updatedAt: now,
      bitmap: Buffer.alloc(Math.ceil(chunkCount(input.size, FS_UPLOAD_CHUNK_SIZE) / 8)).toString('base64'),
    }

    // Created eagerly so the positional writes below never have to special-case
    // a missing file, and so the staged size is meaningful from the start.
    await writeFile(path.join(dir, 'data'), Buffer.alloc(0), { mode: 0o600 })
    await this.writeMeta(dir, meta)

    log.info(`upload ${id} opened for ${input.path} (${input.size} bytes)`)
    return this.toStatus(meta, Buffer.from(meta.bitmap, 'base64'))
  }

  async status(id: string): Promise<FsUploadStatus> {
    const { meta, bitmap } = await this.readMeta(id)
    return this.toStatus(meta, bitmap)
  }

  /**
   * Writes one chunk at an absolute offset.
   *
   * Offsets are absolute, so chunks are order-independent and a re-send of the
   * same range is a no-op — resumption needs no special case.
   */
  async writeChunk(id: string, offset: number, body: Buffer, checksum: string | undefined): Promise<FsUploadStatus> {
    return this.serialize(id, async () => {
      const { dir, meta, bitmap } = await this.readMeta(id)
      const length = body.length

      if (length === 0) throw new FsError('invalid_request', 'chunk is empty', 400)
      if (length > meta.chunkSize) {
        throw new FsError('too_large', `chunk exceeds ${meta.chunkSize} bytes`, 413)
      }
      // Alignment keeps one chunk equal to one bit; an unaligned write could
      // span two bits and leave the bitmap lying about what is on disk. That
      // only holds if a non-final chunk is *exactly* one chunk long: a short
      // write at an aligned offset would set the bit for a range it did not
      // fill, and the hole it leaves is NUL-filled — which the size check in
      // `complete` cannot see, so the corruption lands in an installed file.
      // The last chunk is the one exception; it is short by construction.
      if (offset % meta.chunkSize !== 0) {
        throw new FsError('offset_out_of_range', 'chunk offset is not chunk-aligned', 416)
      }
      if (length !== meta.chunkSize && offset + length !== meta.size) {
        throw new FsError(
          'invalid_request',
          `non-final chunk must be exactly ${meta.chunkSize} bytes, got ${length}`,
          400,
        )
      }
      if (offset + length > meta.size) {
        throw new FsError(
          'offset_out_of_range',
          `chunk ends at ${offset + length}, past the declared size ${meta.size}`,
          416,
        )
      }

      // Required rather than optional: a resumable upload whose whole purpose
      // is to survive a flaky link must not silently persist a corrupted
      // range, and the client already has the bytes in hand to hash.
      if (checksum === undefined || checksum === '') {
        throw new FsError('invalid_request', 'x-chunk-sha256 header is required', 400)
      }
      const digest = createHash('sha256').update(body).digest('base64')
      if (digest !== checksum) {
        // The bit is deliberately not set, so the client's next status call
        // still reports this range as missing and it gets re-sent.
        throw new FsError('checksum_mismatch', 'chunk checksum does not match', 400)
      }

      const handle = await open(path.join(dir, 'data'), 'r+')
      try {
        const { bytesWritten } = await handle.write(body, 0, length, offset)
        if (bytesWritten !== length) {
          throw new FsError('internal', `short write: ${bytesWritten} of ${length} bytes`, 500)
        }
        // Flushed before the bit is set. The other order would let a crash
        // leave a range marked present whose bytes never reached the disk.
        await handle.sync()
      } finally {
        await handle.close()
      }

      setBit(bitmap, offset / meta.chunkSize)
      meta.bitmap = bitmap.toString('base64')
      meta.updatedAt = Date.now()
      await this.writeMeta(dir, meta)

      return this.toStatus(meta, bitmap)
    })
  }

  /** Finishes an upload: verify, assemble, install. Returns the installed path. */
  async complete(id: string, opts: { overwrite: boolean }): Promise<string> {
    return this.serialize(id, async () => {
      const { dir, meta, bitmap } = await this.readMeta(id)
      const chunks = chunkCount(meta.size, meta.chunkSize)

      const missing = missingRanges(bitmap, chunks, meta.size, meta.chunkSize)
      if (missing.length > 0) {
        throw new FsError('upload_incomplete', 'some chunks have not been received', 409, { missing })
      }

      // The staged length is an invariant of the writes above, so a mismatch
      // means something is wrong rather than merely incomplete — never a
      // silently truncated file.
      const staged = path.join(dir, 'data')
      const info = await lstat(staged)
      if (info.size !== meta.size) {
        throw new FsError(
          'upload_incomplete',
          `staged file is ${info.size} bytes but ${meta.size} were declared`,
          409,
        )
      }

      // Re-resolved rather than trusted from the meta: a root can change under
      // a long upload, and the path may have appeared in the meantime.
      const target = await this.jail.resolveForCreate(meta.target)
      if (target.exists && !opts.overwrite) {
        // The existing file is left untouched and the upload is preserved, so
        // the client can simply re-send with overwrite: true.
        throw new FsError('already_exists', 'destination already exists', 409)
      }

      await this.install(staged, target.abs)
      await rm(dir, { recursive: true, force: true })

      log.info(`upload ${id} installed at ${target.abs} (${meta.size} bytes)`)
      return target.abs
    })
  }

  /**
   * Moves the staged file into place.
   *
   * `rename` is atomic, but only within a filesystem — and the staging area
   * lives under `dataDir`, which is very often on a different one from the
   * destination (an external drive, NFS, a Docker bind mount). The fallback
   * copies to a temporary name *inside the destination directory* and renames
   * that, which keeps the install atomic; copying straight to the target would
   * leave a truncated file behind on any failure.
   */
  private async install(staged: string, target: string): Promise<void> {
    try {
      await rename(staged, target)
      return
    } catch (err) {
      if (errnoOf(err) !== 'EXDEV') throw toFsError(err)
    }

    const temp = path.join(path.dirname(target), `.webmux-partial-${randomBytes(6).toString('hex')}`)
    try {
      await copyFile(staged, temp)
      await rename(temp, target)
    } catch (err) {
      await rm(temp, { force: true }).catch(() => {})
      throw toFsError(err)
    }
    await rm(staged, { force: true }).catch(() => {})
  }

  /**
   * The staged bytes for a finished upload, for a caller that wants to read
   * them — extraction being the one that does.
   *
   * Completeness is checked here rather than left to the reader: an unfinished
   * upload would otherwise surface as "this is not a zip", which is both
   * confusing and wrong.
   */
  async stagedDataFile(id: string): Promise<string> {
    const { dir, meta, bitmap } = await this.readMeta(id)
    const chunks = chunkCount(meta.size, meta.chunkSize)
    for (let i = 0; i < chunks; i += 1) {
      if (!isSet(bitmap, i)) throw new FsError('upload_incomplete', 'upload has not finished', 409)
    }
    return path.join(dir, 'data')
  }

  /**
   * Aborts an upload. Idempotent, so a client can clean up without racing.
   *
   * Serialized like every other mutator, and that is not cosmetic: the client
   * uploads chunks concurrently and can cancel with PUTs still in flight, so an
   * unserialized `rm` lands mid-`writeChunk` — the open handle keeps writing
   * into an unlinked inode while the bitmap write recreates `meta.json` in the
   * directory that was just removed, leaving a resurrected staging area behind.
   */
  async abort(id: string): Promise<void> {
    return this.serialize(id, async () => {
      const dir = this.dirFor(id)
      await rm(dir, { recursive: true, force: true })
    })
  }

  /**
   * Removes abandoned staging areas.
   *
   * Two triggers, both needed. The boot sweep is the one that actually
   * prevents leaks — a crash, a SIGKILL or a container restart leaves orphans
   * that only a pass over the directory can find. The interval sweep handles
   * uploads abandoned by a client that simply went away.
   *
   * Expiry is by `updatedAt` rather than "delete everything on boot", which is
   * deliberate: a restart in the middle of a large upload must not destroy the
   * progress that makes 断点续传 worth having.
   */
  async sweep(now = Date.now()): Promise<number> {
    let removed = 0

    let entries
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch {
      return 0 // No staging area yet.
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // Never touch an upload with work in flight against it.
      if (this.inFlight.has(entry.name)) continue

      const dir = path.join(this.root, entry.name)
      const meta = await this.readMetaAt(dir)
      const stale = meta === null || now - meta.updatedAt > this.ttlMs
      if (!stale) continue

      await rm(dir, { recursive: true, force: true }).catch(() => {})
      removed += 1
      if (meta !== null) {
        log.info(`swept abandoned upload ${entry.name} (idle since ${new Date(meta.updatedAt).toISOString()})`)
      } else {
        log.warn(`swept unreadable upload directory ${entry.name}`)
      }
    }

    return removed
  }
}
