import { lstat } from 'node:fs/promises'
import { FsError, type Jail, type ResolvedPath } from '../fs/jail'
import type { ShareRow } from './store'

/**
 * Decides whether a share still points at what it pointed at when it was made.
 *
 * Extracted as a separate step because it is the branch most likely to be
 * subtly wrong and the least reachable from an end-to-end test: every one of
 * these conditions needs a config change or a restart to reproduce, which a
 * live server test cannot do.
 *
 * The snapshots on the row (`root_name`, `root_path`, `kind`) exist for this.
 * Storing a bare absolute path and opening it would turn a share into a jail
 * bypass the day an unrelated config edit re-pointed the root.
 */

export type ShareTarget =
  | { ok: true; resolved: ResolvedPath }
  | { ok: false; reason: 'source_unavailable' }

const UNAVAILABLE: ShareTarget = { ok: false, reason: 'source_unavailable' }

export async function resolveShareTarget(jail: Jail, row: ShareRow): Promise<ShareTarget> {
  const root = jail.roots().find((candidate) => candidate.name === row.root_name)
  // Removed from the config, or configured but currently unmountable.
  if (root === undefined || !root.available) return UNAVAILABLE

  // Still there, but now pointing somewhere else entirely.
  if (root.path !== row.root_path) return UNAVAILABLE

  let resolved
  try {
    resolved = row.kind === 'dir' ? await jail.resolveDir(row.path) : await jail.resolve(row.path)
  } catch (err) {
    // Gone, escaped, or no longer resolvable — the share outlives its payload.
    if (err instanceof FsError) return UNAVAILABLE
    throw err
  }

  // A nested root can appear and shadow the outer one, changing which root owns
  // this path without the path itself moving.
  if (resolved.root.name !== row.root_name) return UNAVAILABLE

  // A file that has become a directory (or the reverse) is a different thing.
  const info = await lstat(resolved.abs).catch(() => null)
  if (info === null) return UNAVAILABLE
  const kind = info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null
  if (kind !== row.kind) return UNAVAILABLE

  return { ok: true, resolved }
}
