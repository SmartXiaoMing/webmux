import path from 'node:path'
import type { FastifyReply } from 'fastify'
import type { ResolvedPath } from '../fs/jail'
import { contentDisposition } from '../fs/stream'
import type { WalkResult } from '../fs/zip/write'

/**
 * The archive response headers, in one place.
 *
 * Shared by `/api/fs/archive` and `/s/:token/raw` so the reasoning below cannot
 * drift: a change to it in one route must not miss the other, and the reasoning
 * is the kind that gets "fixed" by someone who has not met the failure it
 * prevents.
 */

/**
 * The name the archive's top-level entry gets.
 *
 * From the *literal* path rather than the canonical one: archiving
 * `photos-link` should produce `photos-link/`, not the name of whatever the
 * link resolves to. A root has no basename, so it falls back to its root name.
 */
export function archiveRootName(target: ResolvedPath): string {
  const base = path.basename(target.literal)
  return base === '' || base === path.sep ? target.root.name : base
}

export function applyArchiveHeaders(reply: FastifyReply, stem: string, walk: WalkResult): void {
  reply
    .header('content-type', 'application/zip')
    // Reuses the RFC 5987 helper the download route already depends on, so a
    // Chinese directory name survives.
    .header('content-disposition', contentDisposition(`${stem}.zip`))
    .header('x-content-type-options', 'nosniff')
    // Deliberately no Content-Length, no Accept-Ranges and no ETag.
    //
    // The length would require compressing the whole tree first — exactly the
    // temporary file this avoids. And a validator here would be worse than
    // none: a strong ETag means hashing the archive, which streaming cannot do,
    // while a weak one derived from a directory stat goes stale the moment a
    // file changes, after which a client re-issuing a Range gets a *silently
    // spliced, corrupt zip* with a plausible Content-Range. A directory has no
    // stable revision identity, so we offer no identity.
    .header('cache-control', 'no-store')
    // From the pre-flight, so a client's progress bar has a denominator even
    // without a Content-Length.
    .header('x-webmux-entries', String(walk.entries.length))
    .header('x-webmux-uncompressed', String(walk.totalUncompressed))

  if (walk.skipped.length > 0) reply.header('x-webmux-skipped', String(walk.skipped.length))
  if (walk.renamed.length > 0) reply.header('x-webmux-renamed', String(walk.renamed.length))
}
