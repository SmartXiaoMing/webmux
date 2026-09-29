import { lstat, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { FileRootConfig } from '../config'
import { logger } from '../logger'

/**
 * The path cage for the file API.
 *
 * A browser-facing file API is the most directly dangerous surface this project
 * has, so this module is deliberately pure: no Fastify, no `Config`, no I/O
 * beyond `lstat`/`stat`/`realpath`. It takes already-validated roots so it can
 * be exercised on its own, without booting a server or a tmux session.
 *
 * Two rules hold everywhere in here:
 *
 *   1. The value returned in `abs` is canonical (symlinks resolved). It is the
 *      only thing safe to hand to an fs call. Returning an uncanonicalised
 *      path would re-open the very link that was just resolved during the
 *      check.
 *   2. Existence is decided with `lstat`, never `stat` or `existsSync`. Those
 *      follow symlinks, so a *dangling* link reads as "absent" and a caller
 *      would then create a file *through* it — outside the root. `lstat` sees
 *      the link itself and rejects it.
 *
 * ## On the check-then-use window
 *
 * There is a real TOCTOU gap between resolving a path here and the `fs.*` call
 * that follows. Node's standard library has no `openat`/`unlinkat`/`renameat`,
 * so there are no fd-relative operations to close it with. What is done to
 * shrink it, and what is knowingly accepted:
 *
 *   - Reads open the *canonical* path with `O_RDONLY | O_NOFOLLOW`. Because the
 *     path is already resolved, `O_NOFOLLOW` can never reject a legitimate
 *     request; it only fires if the final component was swapped for a link in
 *     the window. Metadata is then taken from the resulting fd, so the reported
 *     size can never disagree with the bytes served.
 *   - Mutations operate on the canonical parent plus a literal final component,
 *     and `rm`/`rename` do not dereference that component.
 *
 * The residual risk is an intermediate directory swapped for a symlink between
 * the resolve and the syscall. Exploiting that requires a second actor with
 * write access *inside* a configured root — who, on a single-user box, already
 * has a shell as this very user. The jail does not defend against them; it
 * defends against a remote attacker holding a session cookie, and a remote
 * attacker cannot create symlinks. Buying the remaining sliver would cost
 * portability (fd introspection is `/proc/self/fd` on Linux, `F_GETPATH` on
 * macOS) for a threat that already implies local access.
 */

/** Refuse anything longer here, rather than letting the kernel answer ENAMETOOLONG (a 500). */
const MAX_PATH_LENGTH = 4096

export type FsErrorCode =
  | 'invalid_path'
  | 'invalid_request'
  | 'path_escape'
  | 'forbidden_path'
  | 'root_protected'
  | 'readonly_root'
  | 'not_found'
  | 'not_a_directory'
  | 'not_a_file'
  | 'is_a_directory'
  | 'requires_recursive'
  | 'already_exists'
  | 'directory_not_empty'
  | 'permission_denied'
  | 'readonly_fs'
  | 'resource_busy'
  | 'cross_device'
  | 'no_space'
  | 'too_large'
  | 'insufficient_storage'
  | 'checksum_mismatch'
  | 'upload_not_found'
  | 'upload_incomplete'
  | 'offset_out_of_range'
  /** An archive entry name that cannot be allowed to reach the filesystem. */
  | 'unsafe_archive'
  /** A well-formed archive using something this build cannot decode. */
  | 'unsupported_archive'
  | 'internal'

/**
 * Every failure in the fs layer, carrying the status it should become so a
 * route can forward it without translating anything.
 */
export class FsError extends Error {
  constructor(
    readonly code: FsErrorCode,
    message: string,
    readonly status: number,
    /**
     * Extra machine-readable context merged into the error body — the missing
     * byte ranges on an incomplete upload, for instance. Kept out of `message`
     * so the message stays a human sentence.
     */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'FsError'
  }
}

const ERRNO: Record<string, { code: FsErrorCode; status: number; message: string }> = {
  ENOENT: { code: 'not_found', status: 404, message: 'no such file or directory' },
  ENOTDIR: { code: 'not_a_directory', status: 400, message: 'a path component is not a directory' },
  EISDIR: { code: 'is_a_directory', status: 400, message: 'that is a directory' },
  EACCES: { code: 'permission_denied', status: 403, message: 'permission denied' },
  EPERM: { code: 'permission_denied', status: 403, message: 'operation not permitted' },
  EROFS: { code: 'readonly_fs', status: 403, message: 'filesystem is read-only' },
  EEXIST: { code: 'already_exists', status: 409, message: 'already exists' },
  ENOTEMPTY: { code: 'directory_not_empty', status: 409, message: 'directory is not empty' },
  EBUSY: { code: 'resource_busy', status: 409, message: 'resource is busy' },
  EXDEV: { code: 'cross_device', status: 409, message: 'cross-device operation is not supported' },
  ELOOP: { code: 'invalid_path', status: 400, message: 'too many levels of symbolic links' },
  ENAMETOOLONG: { code: 'invalid_path', status: 400, message: 'path is too long' },
  ENOSPC: { code: 'no_space', status: 507, message: 'no space left on device' },
}

export function errnoOf(err: unknown): string | undefined {
  return (err as { code?: string } | null | undefined)?.code
}

/** Normalises a raw Node error into an FsError. Unknown errnos become a 500. */
export function toFsError(err: unknown): FsError {
  if (err instanceof FsError) return err
  const mapped = ERRNO[errnoOf(err) ?? '']
  if (mapped) return new FsError(mapped.code, mapped.message, mapped.status)
  return new FsError('internal', (err as Error | null)?.message ?? 'unexpected filesystem error', 500)
}

/**
 * True when `target` is `rootPath` itself or lives beneath it.
 *
 * Compared on segment boundaries, never by bare prefix: `/home/mi2` must not
 * count as being inside `/home/mi`.
 */
export function isInside(rootPath: string, target: string): boolean {
  if (target === rootPath) return true
  // '/' owns every absolute path, and the naive `rootPath + sep` would test
  // against '//'.
  if (rootPath === path.sep) return true
  return target.startsWith(rootPath + path.sep)
}

export interface JailRoot {
  name: string
  /** Canonical absolute path, resolved once at boot. */
  path: string
  readonly: boolean
  /**
   * A configured root can be unusable — an unmounted volume, a drive that has
   * not been attached yet. It stays in the list so the UI can explain itself
   * instead of the root silently vanishing.
   */
  available: boolean
  unavailableReason?: string
}

export interface ResolvedPath {
  /** Canonical. The only value that may be handed to an fs call. */
  abs: string
  root: JailRoot
  /** What the caller asked for: normalised, but not dereferenced. */
  literal: string
  exists: boolean
}

/**
 * How the final component is treated.
 *
 * - `read`   — fully dereferenced; the caller wants the content.
 * - `dir`    — as `read`, and the result must be a directory.
 * - `entry`  — `target` without the write guards: the path is described, not
 *              modified. Not dereferenced either, so a symlink is reported as
 *              a symlink rather than as whatever it points at.
 * - `target` — the path is the thing being operated on (delete, rename source).
 *              Not dereferenced, so `rm ~/link` removes the link, not its
 *              target. A root itself is refused.
 * - `create` — the path may not exist yet. The parent must exist and be inside
 *              a writable root.
 * - `createRecursive` — as `create`, but intermediate directories may be
 *              missing too, which is what `mkdir -p` needs. The deepest
 *              ancestor that *does* exist is still canonicalised and checked,
 *              so containment is as tight as it is everywhere else.
 */
type Mode = 'read' | 'dir' | 'entry' | 'target' | 'create' | 'createRecursive'

export class Jail {
  private readonly active: JailRoot[]

  constructor(
    private readonly all: JailRoot[],
    /** Canonical, so containment comparisons are meaningful. */
    private readonly dataDir: string,
  ) {
    this.active = all.filter((r) => r.available)
  }

  /** Every configured root, including unusable ones, for display. */
  roots(): JailRoot[] {
    return this.all
  }

  resolve(input: string): Promise<ResolvedPath> {
    return this.resolvePath(input, 'read')
  }

  resolveDir(input: string): Promise<ResolvedPath> {
    return this.resolvePath(input, 'dir')
  }

  /**
   * Describes the thing at `input` without dereferencing it.
   *
   * Used by `stat`, where the answer to "what is this?" for a symlink is
   * "a symlink" — resolving it first would make that unanswerable, and would
   * make `stat` disagree with the directory listing about the same entry.
   */
  resolveEntry(input: string): Promise<ResolvedPath> {
    return this.resolvePath(input, 'entry')
  }

  resolveTarget(input: string): Promise<ResolvedPath> {
    return this.resolvePath(input, 'target')
  }

  resolveForCreate(input: string, opts: { recursive?: boolean } = {}): Promise<ResolvedPath> {
    return this.resolvePath(input, opts.recursive === true ? 'createRecursive' : 'create')
  }

  private async resolvePath(input: string, mode: Mode): Promise<ResolvedPath> {
    const literal = this.validate(input)

    if (mode === 'read' || mode === 'dir' || mode === 'createRecursive') {
      const { real, exists } = await this.canonicalise(literal)

      // Ownership is settled before existence, so anything outside every root
      // is always path_escape. Testing existence first would answer 404 for a
      // path that is absent and 403 for one that is present — an oracle for
      // what does and does not exist anywhere on the machine.
      //
      // Matched on the *canonical* path, never the literal one. Roots are
      // canonicalised at boot, so on macOS — where /var is a symlink to
      // /private/var and $TMPDIR lives beneath it — matching the literal would
      // reject a perfectly good path merely because the client spelled it the
      // way the config file does.
      const root = this.locate(real)
      this.assertInsideRoot(root, real)
      this.assertNotReserved(real)

      if (mode === 'createRecursive') {
        this.assertWritable(root)
        const info = await lstat(real).catch(() => null)
        if (info?.isSymbolicLink()) {
          throw new FsError('invalid_path', 'refusing to create at a symbolic link', 400)
        }
        return { abs: real, root, literal, exists: info !== null }
      }

      if (!exists) throw new FsError('not_found', 'no such file or directory', 404)

      if (mode === 'dir') {
        const info = await stat(real).catch((err: unknown) => {
          throw toFsError(err)
        })
        if (!info.isDirectory()) throw new FsError('not_a_directory', 'not a directory', 400)
      }
      return { abs: real, root, literal, exists: true }
    }

    // `target` and `create` canonicalise the parent and keep the final
    // component literal. `rm` and `rename` do not follow that component, and
    // mirroring them exactly is what stops "delete ~/link" from deleting
    // whatever the link points at.
    const parentReal = await this.realpathExisting(path.dirname(literal))
    const abs = path.join(parentReal, path.basename(literal))

    const root = this.locate(abs)
    if (mode === 'target' && abs === root.path) {
      throw new FsError('root_protected', 'a configured root cannot be modified', 409)
    }
    this.assertInsideRoot(root, abs)
    this.assertNotReserved(abs)

    // `lstat`, not `stat`: a symlink sitting at the target counts as present,
    // which is what the overwrite gate wants.
    const info = await lstat(abs).catch(() => null)
    const exists = info !== null

    if (mode === 'entry') {
      if (!exists) throw new FsError('not_found', 'no such file or directory', 404)
      return { abs, root, literal, exists }
    }

    this.assertWritable(root)

    if (mode === 'target') {
      if (!exists) throw new FsError('not_found', 'no such file or directory', 404)
      // A symlink is a perfectly legitimate thing to delete or rename — the
      // point of this mode is that `rm ~/link` removes the link rather than
      // its target — and neither `rm` nor `rename` dereferences the final
      // component, so there is nothing to guard against.
      return { abs, root, literal, exists }
    }

    // create: a symlink here is refused outright.
    //
    // `rename` would replace the link safely, but `open`/`writeFile` would
    // follow it — and a dangling link is precisely how the naive
    // `existsSync(abs) ? realpath(abs) : join(realpath(dirname), name)` form
    // leaks a write outside the jail, because `existsSync` follows the link,
    // sees nothing, and reports the path as absent. Refusing keeps the unsafe
    // outcome unreachable instead of relying on every future caller to pick
    // the right syscall.
    if (info?.isSymbolicLink()) {
      throw new FsError('invalid_path', 'refusing to create at a symbolic link', 400)
    }

    return { abs, root, literal, exists }
  }

  private validate(input: string): string {
    if (typeof input !== 'string' || input.length === 0) {
      throw new FsError('invalid_path', 'path is required', 400)
    }
    if (input.length > MAX_PATH_LENGTH) {
      throw new FsError('invalid_path', `path exceeds ${MAX_PATH_LENGTH} characters`, 400)
    }
    // Checked before anything touches the filesystem: Node throws
    // ERR_INVALID_ARG_VALUE on a NUL, which would surface as a 500.
    if (input.includes('\0')) {
      throw new FsError('invalid_path', 'path contains a null byte', 400)
    }
    if (!path.isAbsolute(input)) {
      throw new FsError('invalid_path', 'path must be absolute', 400)
    }
    // Normalises '.', '..' and repeated separators. Note that on POSIX a
    // backslash is an ordinary filename character, so it is deliberately left
    // alone — translating it would corrupt files that legitimately contain one.
    return path.resolve(input)
  }

  /** Longest matching root, by segment boundary. Inner roots shadow outer ones. */
  private locate(literal: string): JailRoot {
    let best: JailRoot | undefined
    for (const root of this.active) {
      if (isInside(root.path, literal) && (best === undefined || root.path.length > best.path.length)) {
        best = root
      }
    }
    if (best === undefined) {
      throw new FsError('path_escape', 'path is outside every configured root', 403)
    }
    return best
  }

  private assertInsideRoot(root: JailRoot, abs: string): void {
    if (!isInside(root.path, abs)) {
      throw new FsError('path_escape', 'path resolves outside its root', 403)
    }
  }

  /**
   * The data directory holds the signing secret and the audit log. It is
   * normally inside the default `$HOME` root, so it needs an explicit refusal
   * on top of containment — otherwise a stolen session cookie could be turned
   * into a long-lived token by reading `webmux.db`.
   */
  private assertNotReserved(abs: string): void {
    if (isInside(this.dataDir, abs)) {
      throw new FsError('forbidden_path', 'that path is reserved by webmux', 403)
    }
  }

  private assertWritable(root: JailRoot): void {
    if (root.readonly) {
      throw new FsError('readonly_root', `root "${root.name}" is read-only`, 403)
    }
  }

  private async realpathExisting(target: string): Promise<string> {
    try {
      return await realpath(target)
    } catch (err) {
      throw toFsError(err)
    }
  }

  /**
   * Canonicalises a path that may not exist yet.
   *
   * Climbs to the deepest ancestor that does exist, realpaths that, and
   * re-appends the missing tail.
   *
   * The `tail.length === 1` check is the load-bearing one. Every component the
   * climb re-appends was proven absent by an `lstat` that failed, so none of
   * them can be a symlink — except the very first, when it was the *target*
   * itself that was missing. A dangling symlink lands here, and is refused
   * rather than followed. Deciding existence with `stat`/`existsSync` instead
   * is exactly the hole this closes: both follow the link, see nothing, and
   * report "absent", after which the caller writes through it.
   */
  private async canonicalise(literal: string): Promise<{ real: string; exists: boolean }> {
    try {
      return { real: await realpath(literal), exists: true }
    } catch (err) {
      const code = errnoOf(err)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw toFsError(err)
    }

    const tail: string[] = []
    let cursor = literal

    for (;;) {
      const parent = path.dirname(cursor)
      if (parent === cursor) {
        // Walked past '/' without finding anything that exists.
        throw new FsError('invalid_path', 'no existing ancestor for that path', 400)
      }
      tail.unshift(path.basename(cursor))

      let parentInfo: Awaited<ReturnType<typeof stat>>
      try {
        // `stat`, not `lstat`: a symlinked *directory* inside the jail is a
        // perfectly ordinary ancestor, and following it here is safe because
        // the result is realpath'd and containment-checked below.
        parentInfo = await stat(parent)
      } catch (err) {
        const code = errnoOf(err)
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          // `stat` follows links, so ENOENT here also covers a *dangling* one.
          // Such a component has to be refused rather than climbed past:
          // re-appending a name beneath it would hand back a path that follows
          // the link out of the root. Checking only the final component — the
          // obvious reading of "the target may not exist yet" — misses
          // `root/dangling-link/missing-name` entirely.
          const asLink = await lstat(parent).catch(() => null)
          if (asLink?.isSymbolicLink()) {
            throw new FsError('invalid_path', 'refusing to resolve through a symbolic link to a missing target', 400)
          }
          cursor = parent
          continue
        }
        throw toFsError(err)
      }

      if (!parentInfo.isDirectory()) {
        throw new FsError('not_a_directory', 'a path component is not a directory', 400)
      }

      if (tail.length === 1) {
        const self = await lstat(literal).catch(() => null)
        if (self?.isSymbolicLink()) {
          throw new FsError('invalid_path', 'refusing to follow a symbolic link to a missing target', 400)
        }
      }

      return { real: path.join(await realpath(parent), ...tail), exists: false }
    }
  }
}

/**
 * Canonicalises and validates the configured roots.
 *
 * A root that cannot be resolved is kept but marked unavailable, and the server
 * keeps running. That is a deliberate departure from how a missing tmux is
 * treated: without tmux the product has no reason to exist, whereas without
 * `/var/log` you lose one panel — and exiting would also take down the terminal
 * you would use to fix the mount.
 *
 * Duplicate *names* are a hard error: the name is how the UI identifies a root,
 * so two roots sharing one is a configuration bug worth refusing outright.
 */
export async function loadRoots(configured: FileRootConfig[], dataDir: string): Promise<JailRoot[]> {
  const seenNames = new Set<string>()
  const seenPaths = new Set<string>()
  const roots: JailRoot[] = []

  for (const entry of configured) {
    if (seenNames.has(entry.name)) {
      throw new Error(`duplicate file root name "${entry.name}" — root names identify a root in the UI`)
    }
    seenNames.add(entry.name)

    try {
      const real = await realpath(entry.path)
      const info = await stat(real)
      if (!info.isDirectory()) throw new Error('not a directory')

      if (seenPaths.has(real)) {
        logger.warn(`file root "${entry.name}" points at ${real}, already configured — ignoring the duplicate`)
        continue
      }
      seenPaths.add(real)

      if (real === path.sep) {
        logger.warn(`file root "${entry.name}" is the filesystem root — every file on this machine is browsable`)
      }

      roots.push({ name: entry.name, path: real, readonly: entry.readonly, available: true })
    } catch (err) {
      const reason = (err as Error).message
      logger.error(`file root "${entry.name}" (${entry.path}) is unavailable: ${reason}`)
      roots.push({
        name: entry.name,
        path: entry.path,
        readonly: entry.readonly,
        available: false,
        unavailableReason: reason,
      })
    }
  }

  return roots
}

export async function createJail(roots: JailRoot[], dataDir: string): Promise<Jail> {
  // Both sides of every containment check must be canonical, or a root reached
  // through a symlink (macOS `/tmp`, iCloud Drive, a symlinked `/home`) would
  // never match the resolved path its own entries produce.
  const realDataDir = await realpath(dataDir).catch(() => path.resolve(dataDir))
  return new Jail(roots, realDataDir)
}
