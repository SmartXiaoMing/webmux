import { ApiError, api } from './api'
import { uploads, type BatchInfo, type UploadOptions, type UploadState } from './upload'

/**
 * Folder upload, arranged from the client.
 *
 * There is no batch endpoint, and deliberately so. The server already has the
 * two primitives this needs — `mkdir -p` for the tree, and a resumable chunked
 * upload per file — and a batch endpoint would have to re-implement the
 * per-file progress, cancel and resume that the client already does, while
 * losing per-file retry. So a folder is expanded here into a manifest, the
 * directories are created first (an upload cannot be initialised into a
 * directory that does not exist), and the files then go up through the
 * ordinary upload path.
 */

/** Files in flight at once. Each one holds three chunk requests of its own. */
export const BATCH_CONCURRENCY = 4

/** A folder nobody meant to upload: node_modules dropped by accident. */
const MAX_ENTRIES = 20_000
const MAX_DEPTH = 32

export interface ManifestFile {
  file: File
  /** '/'-separated, relative to the picked or dropped root. */
  relPath: string
}

export interface ManifestError {
  relPath: string
  message: string
}

export interface UploadManifest {
  /** Every directory seen. Empty ones only survive on the drop path. */
  dirs: string[]
  files: ManifestFile[]
  errors: ManifestError[]
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Splits a browser-supplied relative path into segments, or null to refuse it.
 *
 * Deliberately stricter than `safeName`, which flattens separators: that is
 * right for a single name typed into a box, and catastrophic for a path. If
 * `a/b.txt` and `a_b.txt` both become `a_b.txt`, one silently overwrites the
 * other. Here a separator stays a separator and anything suspicious is
 * refused outright — `..` is *not* rewritten to `_`, because quietly aiming a
 * write somewhere other than where the user pointed is worse than skipping it
 * and saying so.
 *
 * This is UX, not security. The server's jail is the boundary, and it does not
 * trust any of this.
 */
export function safeSegments(rel: string): string[] | null {
  if (rel === '' || rel.includes('\0')) return null
  // Never produced by a browser; if it appears, something is very wrong.
  if (rel.startsWith('/')) return null

  const segments = rel.split('/')
  for (const segment of segments) {
    // '' covers a leading, doubled or trailing slash. `.` and `..` name no
    // real entry. None of these are normalised: each means a bug upstream.
    if (segment === '' || segment === '.' || segment === '..') return null
  }
  return segments
}

/** Server paths are POSIX and the root has no trailing slash to lean on. */
function join(dir: string, rel: string): string {
  return dir.endsWith('/') ? `${dir}${rel}` : `${dir}/${rel}`
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** `webkitRelativePath` is empty for a plain pick, and absent on some engines. */
function relativePathOf(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath
  return rel !== undefined && rel !== '' ? rel : file.name
}

/**
 * The manifest for a `<input type="file">` selection.
 *
 * A directory pick through `webkitdirectory` is the only way to get here, and
 * it cannot tell us about a directory holding no files — nothing in the
 * FileList names it. Empty directories therefore exist only on the drop path.
 */
export function manifestFromFileList(files: readonly File[]): UploadManifest {
  const manifest: UploadManifest = { dirs: [], files: [], errors: [] }
  const dirs = new Set<string>()

  for (const file of files) {
    const rel = relativePathOf(file)
    const segments = safeSegments(rel)
    if (segments === null) {
      manifest.errors.push({ relPath: rel, message: '路径不安全，已跳过' })
      continue
    }
    for (let i = 1; i < segments.length; i += 1) dirs.add(segments.slice(0, i).join('/'))
    manifest.files.push({ file, relPath: segments.join('/') })
  }

  manifest.dirs = [...dirs]
  return manifest
}

/**
 * The file-system shapes the drop traversal walks.
 *
 * Structural rather than the real DOM classes: `FileSystemEntry` does not
 * expose `file()` or `createReader()` on its own type, and faking these in a
 * test is how the recursion — including the readEntries loop and the error
 * paths — gets covered at all. A synthetic `DataTransfer` cannot hold a real
 * entry, so nothing else can reach that code.
 */
export interface EntryLike {
  name: string
  isFile: boolean
  isDirectory: boolean
}
export interface FileEntryLike extends EntryLike {
  file(ok: (file: File) => void, err: (error: unknown) => void): void
}
export interface ReaderLike {
  /** Ends with an empty array; see `readAllEntries`. */
  readEntries(ok: (entries: EntryLike[]) => void, err: (error: unknown) => void): void
}
export interface DirectoryEntryLike extends EntryLike {
  createReader(): ReaderLike
}

export interface DropSnapshot {
  entries: EntryLike[]
  loose: File[]
}

/**
 * Captures the drop payload *before* anything is awaited.
 *
 * `DataTransferItem`s are neutered the moment the event dispatch returns:
 * `webkitGetAsEntry()` answers null afterwards, so the folders silently become
 * nothing. An async function runs synchronously up to its first `await`, which
 * would make it work by accident — the kind of accident an innocuous edit
 * breaks. Hence a separate, synchronously-called function that says so.
 */
export function snapshotDrop(dt: DataTransfer): DropSnapshot {
  const snapshot: DropSnapshot = { entries: [], loose: [] }
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
    if (entry !== null) {
      // The real classes do not structurally expose file()/createReader().
      snapshot.entries.push(entry as unknown as EntryLike)
      continue
    }
    const file = item.getAsFile()
    if (file !== null) snapshot.loose.push(file)
  }
  return snapshot
}

export async function manifestFromSnapshot(snapshot: DropSnapshot): Promise<UploadManifest> {
  const manifest: UploadManifest = {
    dirs: [],
    files: [],
    // Loose files keep the plain-file semantics: no tree, no path to sanitise.
    errors: [],
  }
  const loose = manifestFromFileList(snapshot.loose)
  manifest.files.push(...loose.files)
  manifest.errors.push(...loose.errors)
  manifest.dirs.push(...loose.dirs)

  for (const entry of snapshot.entries) {
    if (await collectEntry(entry, '', manifest)) break
  }

  return manifest
}

/**
 * Reads a directory, all of it.
 *
 * `readEntries` returns at most ~100 entries per call and signals the end with
 * an empty array. Calling it once is the classic bug: every directory with
 * more than a hundred entries is silently truncated. The error callback ends
 * the walk but keeps what was read, so one unreadable subdirectory does not
 * cost the rest of the drop.
 */
function readAllEntries(reader: ReaderLike): Promise<{ entries: EntryLike[]; error: unknown }> {
  return new Promise((resolve) => {
    const all: EntryLike[] = []
    const step = (): void => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve({ entries: all, error: null })
            return
          }
          all.push(...batch)
          step()
        },
        (error) => resolve({ entries: all, error }),
      )
    }
    step()
  })
}

function describeError(err: unknown): string {
  return err instanceof Error && err.message !== '' ? err.message : '无法读取'
}

/**
 * Walks one dropped entry into the manifest.
 *
 * Returns true when the walk should stop altogether, which only the entry cap
 * causes: reporting it per remaining entry would turn one oversized drop into
 * one error row per file. Exported for its own tests.
 */
export async function collectEntry(
  entry: EntryLike,
  prefix: string,
  out: UploadManifest,
  depth = 0,
): Promise<boolean> {
  const raw = prefix === '' ? entry.name : `${prefix}/${entry.name}`
  const segments = safeSegments(raw)
  if (segments === null) {
    out.errors.push({ relPath: raw, message: '路径不安全，已跳过' })
    return false
  }
  const relPath = segments.join('/')

  if (out.files.length + out.dirs.length >= MAX_ENTRIES) {
    out.errors.push({ relPath, message: `条目超过 ${MAX_ENTRIES} 个，未继续展开` })
    return true
  }
  if (depth > MAX_DEPTH) {
    // Prunes this branch only: a deep corner of an otherwise fine drop.
    out.errors.push({ relPath, message: `目录超过 ${MAX_DEPTH} 层，未继续展开` })
    return false
  }

  if (entry.isFile) {
    const fileEntry = entry as FileEntryLike
    try {
      const file = await new Promise<File>((resolve, reject) => {
        fileEntry.file(resolve, reject)
      })
      out.files.push({ file, relPath })
    } catch (err) {
      out.errors.push({ relPath, message: describeError(err) })
    }
    return false
  }

  if (entry.isDirectory) {
    // Recorded before descending, and that is the only reason an empty
    // directory survives at all: nothing inside it will ever name it.
    out.dirs.push(relPath)
    const { entries, error } = await readAllEntries((entry as DirectoryEntryLike).createReader())
    if (error !== null) out.errors.push({ relPath, message: describeError(error) })
    for (const child of entries) {
      if (await collectEntry(child, relPath, out, depth + 1)) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Running a manifest
// ---------------------------------------------------------------------------

/**
 * Every directory that must exist, deduplicated.
 *
 * Ancestors covered by a deeper directory are deliberately *not* pruned. It
 * would save requests, but a mkdir failure would then be attributed to a
 * directory nobody asked for, and the files under it would fail with a
 * puzzling 404 from `upload/init` instead of the real reason.
 */
export function planDirectories(manifest: UploadManifest): string[] {
  const dirs = new Set<string>(manifest.dirs)
  for (const { relPath } of manifest.files) {
    const segments = relPath.split('/')
    for (let i = 1; i < segments.length; i += 1) dirs.add(segments.slice(0, i).join('/'))
  }
  return [...dirs].sort()
}

/** What the batch's row in the tray is called: the folder that was picked. */
export function batchLabel(manifest: UploadManifest): string {
  const first = manifest.files[0]?.relPath ?? manifest.dirs[0]
  return first?.split('/')[0] ?? '上传'
}

export interface BatchResult {
  uploaded: number
  failed: number
  /** Entries the traversal refused; the caller surfaces the count. */
  skipped: number
}

/**
 * Everything `runManifest` touches outside itself.
 *
 * Injected so the orchestration — the ordering, the failure attribution, the
 * concurrency bound — can be tested without a server, a DOM or a real drop.
 */
export interface BatchDeps {
  reserve(entry: ManifestFile, target: string, opts: UploadOptions): void
  upload(entry: ManifestFile, target: string, opts: UploadOptions): Promise<void>
  fail(entry: ManifestFile, target: string, opts: UploadOptions, message: string): void
  mkdir(path: string): Promise<void>
  stateOf(entry: ManifestFile, target: string): UploadState | null
}

let batchCounter = 0

function nextBatchId(): string {
  batchCounter += 1
  // Not `crypto.randomUUID`: a self-hosted webmux is very plausibly reached
  // over plain HTTP on a LAN, where that is undefined — the same
  // secure-context trap already documented for `crypto.subtle`.
  return `batch-${Date.now()}-${batchCounter}`
}

/**
 * Runs `worker` over `items` with bounded parallelism, ignoring failures.
 *
 * A sibling of the uploader's `runPool` rather than a reuse of it: that one is
 * fail-fast, which is right for the chunks of a single file and exactly wrong
 * here — the failure of one file in a batch of a thousand must not cancel the
 * other 999. Workers are expected to record their own failures; anything they
 * throw is swallowed because this must never reject into a drop handler.
 */
async function runPoolSettled<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = index
      index += 1
      if (i >= items.length) return
      try {
        await worker(items[i]!)
      } catch {
        // The worker reports its own failures; see the contract above.
      }
    }
  })
  await Promise.all(runners)
}

const defaultDeps: BatchDeps = {
  reserve: (entry, target, opts) => uploads.reserve(entry.file, target, opts),
  upload: (entry, target, opts) => uploads.upload(entry.file, target, opts),
  fail: (entry, target, opts, message) => uploads.fail(entry.file, target, opts, message),
  mkdir: async (path) => {
    await api.createDirectory(path, true)
  },
  stateOf: (entry, target) => uploads.stateOf(entry.file, target),
}

/**
 * Creates the tree, then uploads every file into it.
 *
 * Never rejects: a batch that reports its own failures is more useful than one
 * that throws away the counts.
 */
export async function runManifest(
  manifest: UploadManifest,
  dest: string,
  label: string,
  deps: BatchDeps = defaultDeps,
): Promise<BatchResult> {
  const batch: BatchInfo = { id: nextBatchId(), label }
  const optionsFor = (relPath: string): UploadOptions => ({ batch, relPath })

  const targets = new Map<ManifestFile, string>()
  for (const entry of manifest.files) targets.set(entry, join(dest, entry.relPath))

  // Reserved before anything is sent, so the tray shows the whole batch up
  // front rather than filling in as the pool crawls through it.
  for (const entry of manifest.files) {
    deps.reserve(entry, targets.get(entry)!, optionsFor(entry.relPath))
  }

  // Parent first is not required — every call is `mkdir -p` — so there is no
  // ordering to get right here, only the deduplication.
  const mkdirErrors = new Map<string, string>()
  await runPoolSettled(planDirectories(manifest), BATCH_CONCURRENCY, async (dir) => {
    try {
      await deps.mkdir(join(dest, dir))
    } catch (err) {
      mkdirErrors.set(dir, err instanceof ApiError ? err.message : '创建目录失败')
    }
  })

  const uploadable: ManifestFile[] = []
  let failed = 0
  for (const entry of manifest.files) {
    // An upload cannot be initialised into a directory that does not exist, so
    // the files under a failed one are marked failed *here*, with the real
    // reason, instead of being sent to collect a confusing 404.
    const blocked = firstFailedAncestor(entry.relPath, mkdirErrors)
    if (blocked === null) {
      uploadable.push(entry)
      continue
    }
    deps.fail(
      entry,
      targets.get(entry)!,
      optionsFor(entry.relPath),
      `无法创建目录 ${blocked.dir}：${blocked.message}`,
    )
    failed += 1
  }

  let uploaded = 0
  await runPoolSettled(uploadable, BATCH_CONCURRENCY, async (entry) => {
    const target = targets.get(entry)!
    // Cancelled from the tray while queued: starting it now would resurrect a
    // row the user has already dismissed.
    if (deps.stateOf(entry, target) === 'cancelled') return
    try {
      await deps.upload(entry, target, optionsFor(entry.relPath))
      uploaded += 1
    } catch {
      // `upload` has already put the message on the task.
      failed += 1
    }
  })

  return { uploaded, failed, skipped: manifest.errors.length }
}

function firstFailedAncestor(
  relPath: string,
  failures: Map<string, string>,
): { dir: string; message: string } | null {
  if (failures.size === 0) return null

  // Walks the file's own ancestors rather than the failure list: the failure
  // list is the size of the tree, and this is the depth of one path.
  const segments = relPath.split('/')
  for (let i = 1; i < segments.length; i += 1) {
    const prefix = segments.slice(0, i).join('/')
    const message = failures.get(prefix)
    if (message !== undefined) return { dir: prefix, message }
  }
  return null
}
