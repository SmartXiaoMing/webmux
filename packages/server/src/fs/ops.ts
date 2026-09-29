import { chmod, chown, lstat, mkdir, open, opendir, rename, rm, unlink } from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import type { Dirent } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { FsEntry, FsEntryKind, FsListing, FsSort, FsStat } from '@webmux/shared'
import { FsError, toFsError, type Jail, type ResolvedPath } from './jail'
import { PREVIEW_TEXT_LIMIT_BYTES, previewPolicy } from './stream'

/**
 * Directory operations, on paths the jail has already vouched for.
 *
 * Every function here takes a `ResolvedPath` rather than a string, which makes
 * it impossible to reach an fs call without having gone through containment
 * first — the type is the reminder.
 */

/**
 * Locale-aware but numeric, so `file10` sorts after `file2` rather than
 * before it. A plain code-unit comparison gets this wrong often enough to be
 * worth the collator.
 */
const collator = new Intl.Collator('en', { numeric: true })

function compareName(a: string, b: string): number {
  const primary = collator.compare(a, b)
  if (primary !== 0) return primary
  // Code-unit tie-break keeps the order total, which the cursor relies on:
  // two entries the collator considers equal must still have a stable
  // relative order across requests, or paging could repeat or skip one.
  return a < b ? -1 : a > b ? 1 : 0
}

function kindOf(entry: Dirent): FsEntryKind {
  if (entry.isDirectory()) return 'dir'
  if (entry.isFile()) return 'file'
  if (entry.isSymbolicLink()) return 'symlink'
  return 'other'
}

interface Candidate {
  name: string
  kind: FsEntryKind
  size: number
  mtimeMs: number
  /** False until a stat has filled in size and mtimeMs. */
  measured: boolean
}

function compareCandidates(a: Candidate, b: Candidate, sort: FsSort, order: 'asc' | 'desc'): number {
  // Directories lead regardless of the sort key. Every file manager does this,
  // and it is what makes a listing navigable.
  const groupA = a.kind === 'dir' ? 0 : 1
  const groupB = b.kind === 'dir' ? 0 : 1
  if (groupA !== groupB) return groupA - groupB

  let cmp = 0
  switch (sort) {
    case 'name':
      cmp = compareName(a.name, b.name)
      break
    case 'size':
      cmp = a.size - b.size
      break
    case 'mtime':
      cmp = a.mtimeMs - b.mtimeMs
      break
    case 'kind':
      cmp = a.kind === b.kind ? 0 : a.kind < b.kind ? -1 : 1
      break
  }
  if (cmp === 0) cmp = compareName(a.name, b.name)
  return order === 'desc' ? -cmp : cmp
}

function encodeCursor(entry: Candidate): string {
  const state = { n: entry.name, k: entry.kind, s: entry.size, m: entry.mtimeMs }
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url')
}

/**
 * The cursor carries the sort key of the last entry on the previous page, not
 * an offset.
 *
 * An offset would have to be re-derived by re-reading and re-sorting the whole
 * directory on every page anyway, and would silently repeat or skip entries if
 * anything changed in between. This needs no server-side cache, so it survives
 * a restart and costs no memory — the right trade for a single-user tool.
 */
function decodeCursor(raw: string): Candidate {
  const invalid = (): never => {
    throw new FsError('invalid_request', 'cursor is not valid', 400)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return invalid()
  }
  const c = parsed as Partial<{ n: unknown; k: unknown; s: unknown; m: unknown }>
  if (typeof c?.n !== 'string' || typeof c?.k !== 'string' || typeof c?.s !== 'number' || typeof c?.m !== 'number') {
    return invalid()
  }
  return { name: c.n, kind: c.k as FsEntryKind, size: c.s, mtimeMs: c.m, measured: true }
}

export interface ListOptions {
  sort: FsSort
  order: 'asc' | 'desc'
  cursor?: string | undefined
  limit: number
  showHidden: boolean
}

/**
 * Lists a directory.
 *
 * `opendir` yields `Dirent`s, which carry the entry type without a `stat` —
 * that is what makes large directories survivable. The default name sort needs
 * no metadata at all, so only the returned page is measured; a 50 000-entry
 * directory costs one readdir plus `limit` stats rather than 50 000.
 */
export async function listDirectory(target: ResolvedPath, opts: ListOptions): Promise<FsListing> {
  const candidates: Candidate[] = []

  let handle
  try {
    handle = await opendir(target.abs)
  } catch (err) {
    throw toFsError(err)
  }

  try {
    for await (const entry of handle) {
      // Never filtered by default: this is a shell-adjacent tool, and `ls -a`
      // is the expectation.
      if (!opts.showHidden && entry.name.startsWith('.')) continue
      candidates.push({ name: entry.name, kind: kindOf(entry), size: 0, mtimeMs: 0, measured: false })
    }
  } catch (err) {
    throw toFsError(err)
  }

  if (opts.sort !== 'name') {
    await measure(target.abs, candidates)
  }

  candidates.sort((a, b) => compareCandidates(a, b, opts.sort, opts.order))

  // Filtering against the cursor with the same comparator keeps paging exact
  // without tracking positions.
  const after = opts.cursor
    ? candidates.filter((c) => compareCandidates(c, decodeCursor(opts.cursor as string), opts.sort, opts.order) > 0)
    : candidates

  const page = after.slice(0, opts.limit)
  await measure(target.abs, page)

  const entries: FsEntry[] = page.map((c) => ({
    name: c.name,
    path: path.join(target.abs, c.name),
    kind: c.kind,
    size: c.kind === 'dir' ? 0 : c.size,
    mtimeMs: c.mtimeMs,
    hidden: c.name.startsWith('.'),
    // Decided here rather than in the client, so the allowlist that guards
    // inline rendering exists in exactly one place.
    preview: c.kind === 'file' ? (previewPolicy(c.name)?.kind ?? null) : null,
    root: target.root.name,
  }))

  const last = page[page.length - 1]
  return {
    path: target.abs,
    root: target.root.name,
    readonly: target.root.readonly,
    entries,
    nextCursor: last && after.length > page.length ? encodeCursor(last) : null,
    total: candidates.length,
  }
}

/**
 * Fills in size and mtime for entries that do not have them yet.
 *
 * `lstat` throughout: for a symlink the listing reports the link's own size and
 * timestamp, matching the fact that every other operation acts on the link
 * rather than its target.
 */
async function measure(base: string, entries: Candidate[]): Promise<void> {
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.measured) return
      const info = await lstat(path.join(base, entry.name)).catch(() => null)
      if (info === null) return // Vanished between readdir and stat; report what we know.
      entry.size = info.size
      entry.mtimeMs = info.mtimeMs
      entry.measured = true
    }),
  )
}

export async function statPath(jail: Jail, target: ResolvedPath): Promise<FsStat> {
  const info = await lstat(target.abs).catch((err: unknown) => {
    throw toFsError(err)
  })

  const name = path.basename(target.abs)
  const kind: FsEntryKind = info.isDirectory()
    ? 'dir'
    : info.isFile()
      ? 'file'
      : info.isSymbolicLink()
        ? 'symlink'
        : 'other'

  const result: FsStat = {
    name,
    path: target.abs,
    kind,
    size: kind === 'dir' ? 0 : info.size,
    mtimeMs: info.mtimeMs,
    hidden: name.startsWith('.'),
    preview: kind === 'file' ? (previewPolicy(name)?.kind ?? null) : null,
    root: target.root.name,
    readonly: target.root.readonly,
  }

  if (kind === 'symlink') {
    // Only offered when the link still resolves inside the jail; a target
    // outside it is not something this API should be describing.
    const inner = await jail.resolve(target.abs).catch(() => null)
    if (inner !== null) result.linkTarget = inner.abs
  }

  return result
}

export async function makeDirectory(target: ResolvedPath, recursive: boolean): Promise<void> {
  if (target.exists && !recursive) {
    throw new FsError('already_exists', 'already exists', 409)
  }
  try {
    await mkdir(target.abs, { recursive })
  } catch (err) {
    throw toFsError(err)
  }
}

/**
 * Creates an empty file.
 *
 * Create-only, deliberately. Real `touch` semantics would also bump the mtime
 * of an existing file, and doing that from a button labelled "new file" is a
 * surprising, faintly destructive action. An existing path is a 409 instead.
 */
export async function createEmptyFile(target: ResolvedPath): Promise<void> {
  if (target.exists) {
    throw new FsError('already_exists', 'already exists', 409)
  }
  try {
    // 'wx' rather than a plain create: it fails instead of truncating if the
    // path appeared between the resolver's check and this open — the one
    // window the jail cannot close for us.
    const handle = await open(target.abs, 'wx', 0o644)
    await handle.close()
  } catch (err) {
    throw toFsError(err)
  }
}

/**
 * Replaces the contents of a text file.
 *
 * Written to a temporary file beside the target and renamed into place, so a
 * concurrent reader — or a crash — never sees a half-written file. The rename
 * also makes the two failure modes that matter impossible: a full disk leaves
 * the original untouched rather than truncated, and there is no window in
 * which the file exists but is empty. The temp is in the same directory, which
 * is what keeps the rename atomic and removes the cross-device case entirely.
 *
 * Mode and ownership are carried over explicitly. The temp file is created
 * fresh, so without this a 0664 file would come back 0600 (and, for a file
 * owned by someone else, owned by the server's user instead) — which is
 * exactly the trap that made the upload path unusable for this.
 *
 * The mtime token is what stops a stale editor from clobbering a file that
 * changed underneath it; callers that pass no token get an unconditional write.
 */
export async function saveTextFile(
  target: ResolvedPath,
  text: string,
  opts: { baseMtimeMs?: number } = {},
): Promise<void> {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length > PREVIEW_TEXT_LIMIT_BYTES) {
    throw new FsError('too_large', 'text is larger than the edit limit', 413)
  }

  let info
  let handle
  try {
    // Canonical path, so O_NOFOLLOW cannot reject a legitimate request; it
    // fires only if the final component was swapped for a link after the jail
    // checked it.
    handle = await open(target.abs, FS.O_RDONLY | FS.O_NOFOLLOW)
    // From the descriptor, never a second path-based stat: the size and mtime
    // below are what the guards act on, and a path name can be pointed
    // somewhere else between two calls.
    info = await handle.stat()
  } catch (err) {
    await handle?.close().catch(() => {})
    throw toFsError(err)
  }
  await handle.close()

  if (!info.isFile()) {
    throw new FsError('not_a_file', 'that is not a regular file', 400)
  }
  // A truncated preview is exactly the limit in size, so checking only the
  // text being written would let the prefix overwrite a larger file with
  // itself. This is the check that makes "what you saw is what you save" true.
  if (info.size > PREVIEW_TEXT_LIMIT_BYTES) {
    throw new FsError('too_large', 'the file is larger than the edit limit', 413)
  }
  if (opts.baseMtimeMs !== undefined && info.mtimeMs !== opts.baseMtimeMs) {
    throw new FsError('conflict', 'the file changed on disk since it was loaded', 409)
  }

  const mode = info.mode & 0o7777
  const temp = path.join(path.dirname(target.abs), `.webmux-save-${randomBytes(6).toString('hex')}`)
  try {
    const out = await open(temp, 'wx', mode)
    try {
      await out.writeFile(bytes)
      // Durable before it is visible: the rename below is only atomic with
      // respect to other processes, not to a power cut.
      await out.sync()
    } finally {
      await out.close()
    }
    // Best-effort: without CAP_CHOWN this fails whenever the file belongs to
    // someone else, and the write is still worth carrying out — the new file
    // is then owned by the service user, which is a smaller surprise than
    // refusing to save.
    await chown(temp, info.uid, info.gid).catch(() => {})
    // Not redundant with the mode passed to open: the umask has already been
    // applied to that one.
    await chmod(temp, mode)
    await rename(temp, target.abs)
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {})
    throw toFsError(err)
  }
}

export async function renamePath(
  from: ResolvedPath,
  to: ResolvedPath,
  overwrite: boolean,
): Promise<void> {
  if (to.exists && !overwrite) {
    throw new FsError('already_exists', 'destination already exists', 409)
  }
  try {
    await rename(from.abs, to.abs)
  } catch (err) {
    // A cross-device move is refused rather than emulated: a copy-then-delete
    // that fails halfway is strictly worse than a clear error, and moving is
    // not something P2 claims to do.
    throw toFsError(err)
  }
}

export async function deletePath(target: ResolvedPath, recursive: boolean): Promise<void> {
  const info = await lstat(target.abs).catch((err: unknown) => {
    throw toFsError(err)
  })

  if (info.isDirectory() && !recursive) {
    // Recursion is opt-in so that a mistyped path can never take a whole tree
    // with it. Emptiness is left to the kernel rather than pre-scanned: a
    // pre-scan is a second check-then-use window and O(n) work for nothing.
    throw new FsError('requires_recursive', 'refusing to delete a directory without recursive=true', 409)
  }

  try {
    if (info.isDirectory()) {
      // `rm -r` lstats each entry instead of descending into links, so a
      // symlink inside the tree is unlinked rather than followed. files.e2e
      // asserts this rather than trusting it.
      await rm(target.abs, { recursive: true, force: false })
      return
    }
    // `unlink` removes a symlink itself, never what it points at.
    await unlink(target.abs)
  } catch (err) {
    throw toFsError(err)
  }
}
