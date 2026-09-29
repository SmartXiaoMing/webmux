import { constants as FS } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  FS_UPLOAD_CHUNK_SIZE,
  fsArchiveQuery,
  fsDeleteQuery,
  fsDownloadQuery,
  fsExtractRequest,
  fsListQuery,
  fsMkdirRequest,
  fsPreviewQuery,
  fsRenameRequest,
  fsStatQuery,
  fsTouchRequest,
  fsUploadChunkQuery,
  fsUploadCompleteRequest,
  fsUploadInitRequest,
  fsWriteRequest,
  type FsListing,
  type FsRoot,
  type FsStat,
} from '@webmux/shared'
import { audit } from '../audit'
import { requireAuth, type AuthContext } from '../auth/routes'
import { applyArchiveHeaders, archiveRootName } from './archive'
import { sendFileFromJail } from './send-file'
import { FsError, toFsError, type Jail, type ResolvedPath } from '../fs/jail'
import {
  createEmptyFile,
  deletePath,
  listDirectory,
  makeDirectory,
  renamePath,
  saveTextFile,
  statPath,
} from '../fs/ops'
import {
  PREVIEW_TEXT_LIMIT_BYTES,
  contentDisposition,
  inlineDisposition,
  mimeFor,
  parseRange,
  previewPolicy,
  type RangeResult,
} from '../fs/stream'
import type { UploadStore } from '../fs/upload'
import { extractArchive } from '../fs/zip/extract'
import { fileSource, parseArchive, type ByteSource } from '../fs/zip/read'
import { archiveStream, walkForArchive } from '../fs/zip/write'
import { logger } from '../logger'

const log = logger.child('http:files')

/** How often abandoned staging areas are reclaimed. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000

export interface FileRoutesContext {
  jail: Jail
  uploads: UploadStore
  auth: AuthContext
}

function firstIssue(error: { issues: Array<{ message?: string }> }): string {
  return error.issues[0]?.message ?? 'invalid request'
}

function sendInvalid(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: { code: 'invalid_request', message } })
}

/**
 * One translation point from the fs layer's error vocabulary to HTTP. Every
 * failure there already knows its own status, so this only has to decide what
 * is worth logging.
 */
function sendFsError(reply: FastifyReply, err: unknown, context: string): FastifyReply {
  const fsError = toFsError(err)
  if (fsError.status >= 500) log.error(`${context}: ${fsError.message}`, err)
  return reply.code(fsError.status).send({
    error: { code: fsError.code, message: fsError.message, ...(fsError.details ?? {}) },
  })
}

/** An open archive, and the way to let go of it. */
interface OpenArchive {
  source: ByteSource
  close: () => Promise<void>
}

/** Opens an archive that already lives inside the jail. */
async function openJailedArchive(jail: Jail, target: string): Promise<OpenArchive> {
  const resolved = await jail.resolve(target)
  const handle = await open(resolved.abs, FS.O_RDONLY | FS.O_NOFOLLOW)
  try {
    // From the descriptor, so a FIFO cannot hang the request and the size
    // cannot disagree with what is read.
    const info = await handle.stat()
    if (!info.isFile()) throw new FsError('not_a_file', 'not a regular file', 400)
    return { source: fileSource(handle, info.size), close: () => handle.close() }
  } catch (err) {
    await handle.close().catch(() => {})
    throw err
  }
}

/**
 * Opens an archive that is sitting in the upload staging area.
 *
 * No jail check here on purpose: the path is built from an upload id that has
 * already been validated against its format and its metadata, and it is inside
 * our own 0700 directory rather than inside a user-configured root.
 */
async function openStagedArchive(uploads: UploadStore, uploadId: string): Promise<OpenArchive> {
  const staged = await uploads.stagedDataFile(uploadId)
  const handle = await open(staged, FS.O_RDONLY)
  try {
    const info = await handle.stat()
    return { source: fileSource(handle, info.size), close: () => handle.close() }
  } catch (err) {
    await handle.close().catch(() => {})
    throw err
  }
}

export function registerFileRoutes(app: FastifyInstance, ctx: FileRoutesContext): void {
  const auth = requireAuth(ctx.auth)

  /**
   * Re-reads a path for a response body, without dereferencing it.
   *
   * Must not use `resolve` here. A write can legitimately produce a path that
   * `resolve` refuses — renaming a symlink that points outside the jail leaves
   * exactly that behind — and dereferencing would then turn a mutation that
   * already succeeded into an error response, which a client would reasonably
   * retry.
   */
  const describe = async (abs: string): Promise<FsStat> => statPath(ctx.jail, await ctx.jail.resolveEntry(abs))

  // Reclaims staging areas abandoned by a client that simply went away. The
  // one for crashes and restarts runs at boot, in index.ts — a restart is what
  // actually strands an upload, and only a pass over the directory finds it.
  const sweeper = setInterval(() => {
    void ctx.uploads
      .sweep()
      .catch((err: unknown) => log.warn(`upload sweep failed: ${(err as Error).message}`))
  }, SWEEP_INTERVAL_MS)
  sweeper.unref?.()
  app.addHook('onClose', async () => clearInterval(sweeper))

  app.get('/api/fs/roots', { preHandler: auth }, async (): Promise<{ roots: FsRoot[] }> => {
    // Unavailable roots are included on purpose, so the UI can say why a
    // configured root is missing instead of silently dropping it.
    return { roots: ctx.jail.roots() }
  })

  app.get('/api/fs/list', { preHandler: auth }, async (req, reply) => {
    const parsed = fsListQuery.safeParse(req.query ?? {})
    if (!parsed.success) return sendInvalid(reply, firstIssue(parsed.error))

    try {
      const target = await ctx.jail.resolveDir(parsed.data.path)
      const listing: FsListing = await listDirectory(target, {
        sort: parsed.data.sort,
        order: parsed.data.order,
        cursor: parsed.data.cursor,
        limit: parsed.data.limit,
        showHidden: parsed.data.showHidden,
      })
      return listing
    } catch (err) {
      return sendFsError(reply, err, 'list')
    }
  })

  app.get('/api/fs/stat', { preHandler: auth }, async (req, reply) => {
    const parsed = fsStatQuery.safeParse(req.query ?? {})
    if (!parsed.success) return sendInvalid(reply, firstIssue(parsed.error))

    try {
      // Not dereferenced: a symlink must describe itself, and match what the
      // directory listing says about it.
      const target = await ctx.jail.resolveEntry(parsed.data.path)
      const info: FsStat = await statPath(ctx.jail, target)
      return info
    } catch (err) {
      return sendFsError(reply, err, 'stat')
    }
  })

  app.get('/api/fs/download', { preHandler: auth }, async (req, reply) => {
    const parsed = fsDownloadQuery.safeParse(req.query ?? {})
    if (!parsed.success) return sendInvalid(reply, firstIssue(parsed.error))

    // Resolution follows symlinks, because what is being downloaded is the
    // content — `sendFileFromJail` does that and then streams it.
    return sendFileFromJail(req, reply, ctx.jail, parsed.data.path, (name) => ({
      contentType: mimeFor(name),
      disposition: 'attachment',
    }))
  })

  /**
   * The same bytes as `download`, but `inline` — and only for a strict
   * allowlist of types.
   *
   * This deliberately loosens the "always an attachment" rule that `download`
   * enforces, and the loosening is confined to `previewPolicy`: raster images,
   * plain text, PDF and media. Anything else falls through to an attachment, so
   * a client can point at one URL and let the browser decide rather than having
   * to know the allowlist itself.
   */
  app.get('/api/fs/preview', { preHandler: auth }, async (req, reply) => {
    const parsed = fsPreviewQuery.safeParse(req.query ?? {})
    if (!parsed.success) return sendInvalid(reply, firstIssue(parsed.error))

    return sendFileFromJail(
      req,
      reply,
      ctx.jail,
      parsed.data.path,
      (name, size) => {
        const policy = previewPolicy(name)
        if (policy === null) {
          return { contentType: mimeFor(name), disposition: 'attachment' }
        }

        const truncated = policy.byteLimit !== undefined && size > policy.byteLimit
        return {
          contentType: policy.contentType,
          disposition: 'inline',
          ...(policy.byteLimit !== undefined ? { byteLimit: policy.byteLimit } : {}),
          headers: {
            // Defence in depth, and only meaningful for the inline case: it
            // applies when this response *is* the document, which is exactly
            // when a rendered payload would execute in this origin.
            'content-security-policy': "script-src 'none'; object-src 'none'",
            ...(truncated ? { 'x-webmux-truncated': 'true' } : {}),
          },
        }
      },
    )
  })

  app.post('/api/fs/mkdir', { preHandler: auth }, async (req, reply) => {
    const parsed = fsMkdirRequest.safeParse(req.body ?? {})
    if (!parsed.success) return sendInvalid(reply, firstIssue(parsed.error))

    try {
      // `mkdir -p` may need to create intermediate directories, so recursion
      // has to reach the resolver too — otherwise a legitimate deep path is
      // refused with not_found before mkdir is ever called.
      const target = await ctx.jail.resolveForCreate(parsed.data.path, {
        recursive: parsed.data.recursive,
      })
      const existed = target.exists
      await makeDirectory(target, parsed.data.recursive)
      audit(ctx.auth.db, 'fs.mkdir', parsed.data.path, req.ip)

      // Re-read so the response describes what is actually on disk.
      const entry = await describe(target.abs)
      // `mkdir -p` on an existing directory is a no-op, not a creation.
      return reply.code(existed ? 200 : 201).send(entry)
    } catch (err) {
      return sendFsError(reply, err, 'mkdir')
    }
  })

  app.post('/api/fs/touch', { preHandler: auth }, async (req, reply) => {
    const parsed = fsTouchRequest.safeParse(req.body ?? {})
    if (!parsed.success) return sendInvalid(reply, firstIssue(parsed.error))

    try {
      const target = await ctx.jail.resolveForCreate(parsed.data.path)
      await createEmptyFile(target)
      audit(ctx.auth.db, 'fs.touch', parsed.data.path, req.ip)
      return reply.code(201).send(await describe(target.abs))
    } catch (err) {
      return sendFsError(reply, err, 'touch')
    }
  })

  /**
   * Saves an edited text file.
   *
   * Only replaces an existing file: creating one is `touch`'s job, and a path
   * that was deleted while it sat open in the editor should say so rather than
   * come back to life.
   *
   * The body limit is set explicitly because the default 1 MiB is *smaller*
   * than a legal payload: JSON escaping a control character costs six bytes,
   * so a 512 KiB file of them would be refused before the handler ran.
   */
  app.put(
    '/api/fs/content',
    { preHandler: auth, bodyLimit: 6 * PREVIEW_TEXT_LIMIT_BYTES + 64 * 1024 },
    async (req, reply) => {
      const parsed = fsWriteRequest.safeParse(req.body ?? {})
      if (!parsed.success) return sendInvalid(reply, firstIssue(parsed.error))

      try {
        const target = await ctx.jail.resolveForWrite(parsed.data.path)
        await saveTextFile(target, parsed.data.text, {
          ...(parsed.data.baseMtimeMs !== undefined ? { baseMtimeMs: parsed.data.baseMtimeMs } : {}),
        })
        audit(ctx.auth.db, 'fs.write', parsed.data.path, req.ip)
        return await describe(target.abs)
      } catch (err) {
        return sendFsError(reply, err, 'write')
      }
    },
  )

  app.post('/api/fs/rename', { preHandler: auth }, async (req, reply) => {
    const parsed = fsRenameRequest.safeParse(req.body ?? {})
    if (!parsed.success) return sendInvalid(reply, firstIssue(parsed.error))

    try {
      // The source is not dereferenced: renaming a symlink renames the link.
      const from = await ctx.jail.resolveTarget(parsed.data.from)
      const to = await ctx.jail.resolveForCreate(parsed.data.to)
      await renamePath(from, to, parsed.data.overwrite)
      audit(ctx.auth.db, 'fs.rename', `${parsed.data.from} -> ${parsed.data.to}`, req.ip)

      return await describe(to.abs)
    } catch (err) {
      return sendFsError(reply, err, 'rename')
    }
  })

  app.delete('/api/fs', { preHandler: auth }, async (req, reply) => {
    const parsed = fsDeleteQuery.safeParse(req.query ?? {})
    if (!parsed.success) return sendInvalid(reply, firstIssue(parsed.error))

    try {
      // Not dereferenced: deleting a symlink deletes the link. The jail also
      // refuses a configured root here, so no root can be removed at all.
      const target = await ctx.jail.resolveTarget(parsed.data.path)
      await deletePath(target, parsed.data.recursive)
      audit(ctx.auth.db, 'fs.delete', parsed.data.path, req.ip)
      return reply.code(204).send()
    } catch (err) {
      return sendFsError(reply, err, 'delete')
    }
  })

  // -------------------------------------------------------------------------
  // Resumable upload
  //
  // Four steps rather than one request, because the point is to survive a link
  // that drops halfway through a multi-gigabyte file. `init` validates the
  // destination before any bytes move; the client then sends fixed-size chunks
  // at absolute offsets and can ask which ranges are still outstanding.
  // -------------------------------------------------------------------------

  app.post('/api/fs/upload/init', { preHandler: auth }, async (req, reply) => {
    const parsed = fsUploadInitRequest.safeParse(req.body ?? {})
    if (!parsed.success) return sendInvalid(reply, firstIssue(parsed.error))

    try {
      const status = await ctx.uploads.init({ path: parsed.data.path, size: parsed.data.size })
      audit(ctx.auth.db, 'fs.upload_init', `${parsed.data.path} (${parsed.data.size} bytes)`, req.ip)
      return reply.code(201).send(status)
    } catch (err) {
      return sendFsError(reply, err, 'upload:init')
    }
  })

  app.get<{ Params: { id: string } }>(
    '/api/fs/upload/:id',
    { preHandler: auth },
    async (req, reply) => {
      try {
        // How a client resumes after a reload: it asks what the server already
        // holds instead of assuming it has to start over.
        return await ctx.uploads.status(req.params.id)
      } catch (err) {
        return sendFsError(reply, err, 'upload:status')
      }
    },
  )

  app.put<{ Params: { id: string } }>(
    '/api/fs/upload/:id/chunk',
    {
      preHandler: auth,
      // Bounds a single chunk in memory and turns an over-long body into a 413
      // from the parser rather than an allocation we would have to survive.
      bodyLimit: FS_UPLOAD_CHUNK_SIZE + 64 * 1024,
    },
    async (req, reply) => {
      const parsed = fsUploadChunkQuery.safeParse(req.query ?? {})
      if (!parsed.success) return sendInvalid(reply, firstIssue(parsed.error))

      if (!Buffer.isBuffer(req.body)) {
        return sendInvalid(reply, 'chunk body must be raw bytes (content-type: application/octet-stream)')
      }

      const header = req.headers['x-chunk-sha256']
      try {
        return await ctx.uploads.writeChunk(
          req.params.id,
          parsed.data.offset,
          req.body,
          Array.isArray(header) ? header[0] : header,
        )
      } catch (err) {
        return sendFsError(reply, err, 'upload:chunk')
      }
    },
  )

  app.post<{ Params: { id: string } }>(
    '/api/fs/upload/:id/complete',
    { preHandler: auth },
    async (req, reply) => {
      const parsed = fsUploadCompleteRequest.safeParse(req.body ?? {})
      if (!parsed.success) return sendInvalid(reply, firstIssue(parsed.error))

      try {
        const installed = await ctx.uploads.complete(req.params.id, { overwrite: parsed.data.overwrite })
        audit(ctx.auth.db, 'fs.upload', installed, req.ip)
        return await describe(installed)
      } catch (err) {
        return sendFsError(reply, err, 'upload:complete')
      }
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/api/fs/upload/:id',
    { preHandler: auth },
    async (req, reply) => {
      try {
        await ctx.uploads.abort(req.params.id)
        return reply.code(204).send()
      } catch (err) {
        return sendFsError(reply, err, 'upload:abort')
      }
    },
  )

  // -------------------------------------------------------------------------
  // Archive
  // -------------------------------------------------------------------------

  app.get('/api/fs/archive', { preHandler: auth }, async (req, reply) => {
    const parsed = fsArchiveQuery.safeParse(req.query ?? {})
    if (!parsed.success) return sendInvalid(reply, firstIssue(parsed.error))

    let target
    let walk
    try {
      // Not dereferenced, so archiving a symlink names the archive after the
      // link rather than after its target.
      target = await ctx.jail.resolveEntry(parsed.data.path)
      walk = await walkForArchive(target, archiveRootName(target))
    } catch (err) {
      return sendFsError(reply, err, 'archive')
    }

    // Shared with the public share route, so the reasoning behind the absent
    // headers lives in one place.
    applyArchiveHeaders(reply, archiveRootName(target), walk)

    audit(ctx.auth.db, 'fs.archive', parsed.data.path, req.ip)
    // Readable.from pulls from the generator only as fast as the socket
    // accepts, so backpressure is end-to-end with no manual drain handling.
    return reply.send(Readable.from(archiveStream(walk)))
  })

  app.post('/api/fs/extract', { preHandler: auth }, async (req, reply) => {
    const parsed = fsExtractRequest.safeParse(req.body ?? {})
    if (!parsed.success) return sendInvalid(reply, firstIssue(parsed.error))

    let destination
    try {
      // Resolved before the archive is even opened, so an unwritable or
      // reserved destination is refused first.
      destination = await ctx.jail.resolveForCreate(parsed.data.dest)
    } catch (err) {
      return sendFsError(reply, err, 'extract')
    }

    let archive: OpenArchive
    try {
      archive =
        parsed.data.uploadId !== undefined
          ? await openStagedArchive(ctx.uploads, parsed.data.uploadId)
          : await openJailedArchive(ctx.jail, parsed.data.path as string)
    } catch (err) {
      return sendFsError(reply, err, 'extract')
    }

    try {
      // Parsing validates every entry before a single byte is written, so a
      // rejected archive leaves the destination untouched.
      const entries = await parseArchive(archive.source)
      const result = await extractArchive(archive.source, entries, destination, ctx.jail)

      audit(
        ctx.auth.db,
        'fs.extract',
        `${parsed.data.path ?? parsed.data.uploadId} -> ${parsed.data.dest}`,
        req.ip,
      )
      return reply.code(201).send({ ...(await describe(destination.abs)), ...result })
    } catch (err) {
      return sendFsError(reply, err, 'extract')
    } finally {
      await archive.close().catch(() => {})
    }
  })
}
