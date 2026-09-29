import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { shareCreateRequest, type ShareCreated, type ShareSummary, type SharesResponse } from '@webmux/shared'
import { audit } from '../audit'
import { hashPassword } from '../auth/password'
import { requireAuth, type AuthContext } from '../auth/routes'
import type { Config } from '../config'
import { FsError, toFsError, type Jail } from '../fs/jail'
import { logger } from '../logger'
import { resolveShareTarget } from '../shares/resolve'
import type { ShareRow, ShareStore } from '../shares/store'

const log = logger.child('http:shares')

export interface ShareRoutesContext {
  jail: Jail
  shares: ShareStore
  auth: AuthContext
  config: Config
}

function firstIssue(error: { issues: Array<{ message?: string }> }): string {
  return error.issues[0]?.message ?? 'invalid request'
}

export function registerShareRoutes(app: FastifyInstance, ctx: ShareRoutesContext): void {
  const auth = requireAuth(ctx.auth)

  // Dead rows are kept for a while so the list can say "expired 3 days ago"
  // rather than letting a share vanish and leave the owner wondering whether
  // they deleted it. Only the interval trigger is needed here, unlike the upload
  // staging area which also sweeps at boot — a staging directory stranded by a
  // SIGKILL is something nothing else will find, whereas every share is a row.
  const sweeper = setInterval(
    () => {
      const removed = ctx.shares.sweep(Date.now(), ctx.config.shares.retentionDays)
      if (removed > 0) log.info(`swept ${removed} dead share(s)`)
    },
    6 * 60 * 60 * 1000,
  )
  sweeper.unref?.()
  app.addHook('onClose', async () => clearInterval(sweeper))

  /**
   * Describes a row for the owner, probing whether it still resolves.
   *
   * The probe is what lets the owner learn a share is broken before a visitor
   * does, and it comes free alongside the size for a file. Bounded by
   * `maxActive`, so this is at most a few dozen resolves.
   */
  async function summarize(row: ShareRow): Promise<ShareSummary> {
    const now = Date.now()
    const target = await resolveShareTarget(ctx.jail, row)

    let size: number | null = null
    if (target.ok && row.kind === 'file') {
      size = (await lstat(target.resolved.abs).catch(() => null))?.size ?? null
    }

    return {
      id: row.id,
      name: row.name,
      path: row.path,
      root: row.root_name,
      kind: row.kind,
      size,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      maxDownloads: row.max_downloads,
      downloads: row.downloads,
      rateLimitBytesPerSec: row.rate_limit_bps ?? ctx.config.shares.defaultRateLimitBytesPerSec,
      password: row.password_hash !== null,
      revoked: row.revoked_at !== null,
      active:
        row.revoked_at === null &&
        (row.expires_at === null || row.expires_at > now) &&
        (row.max_downloads === null || row.downloads < row.max_downloads),
      available: target.ok,
      lastAccessAt: row.last_access_at,
      lastAccessIp: row.last_access_ip,
    }
  }

  app.get('/api/shares', { preHandler: auth }, async (): Promise<SharesResponse> => {
    const rows = ctx.shares.list()
    return {
      shares: await Promise.all(rows.map(summarize)),
      config: {
        enabled: ctx.config.shares.enabled,
        defaultTtlHours: ctx.config.shares.defaultTtlHours,
        maxActive: ctx.config.shares.maxActive,
        defaultRateLimitBytesPerSec: ctx.config.shares.defaultRateLimitBytesPerSec,
        inlinePreview: ctx.config.shares.inlinePreview,
      },
    }
  })

  app.post('/api/shares', { preHandler: auth }, async (req, reply) => {
    const parsed = shareCreateRequest.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: firstIssue(parsed.error) } })
    }
    const request = parsed.data

    try {
      // Through the jail, so a path outside every root is refused here as well
      // as at access — and the owner gets an honest error while they can still
      // act on it.
      const entry = await ctx.jail.resolveEntry(request.path)
      const info = await lstat(entry.abs).catch(() => null)
      if (info === null) throw new FsError('not_found', 'no such file or directory', 404)

      const kind = info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null
      if (kind === null) {
        throw new FsError('not_a_file', 'only regular files and directories can be shared', 400)
      }

      // Counted before creating so the refusal cannot leave a stray row.
      if (ctx.shares.countActive() >= ctx.config.shares.maxActive) {
        return reply.code(409).send({
          error: {
            code: 'too_many_shares',
            // 409 and not 429: "slow down and retry" would be false. This is a
            // state the owner resolves by deleting something.
            message: `同时有效的分享最多 ${ctx.config.shares.maxActive} 条，请先撤销一些`,
          },
        })
      }

      const created = ctx.shares.create({
        // The literal path, matching how the rest of the API treats symlinks: a
        // link whose target is updated keeps working.
        path: entry.literal,
        rootName: entry.root.name,
        rootPath: entry.root.path,
        name: path.basename(entry.literal) || entry.root.name,
        kind,
        // `undefined` means "not specified, use the default"; `null` means
        // "never expires", which is a different thing.
        ttlHours:
          request.expiresInHours === undefined ? ctx.config.shares.defaultTtlHours : request.expiresInHours,
        maxDownloads:
          request.maxDownloads === undefined
            ? ctx.config.shares.defaultMaxDownloads
            : request.maxDownloads,
        passwordHash: request.password === undefined ? null : await hashPassword(request.password),
        rateLimitBps: request.rateLimitBytesPerSec ?? null,
      })

      audit(ctx.auth.db, 'share.create', `${created.row.id} ${entry.literal}`, req.ip)

      const body: ShareCreated = {
        ...(await summarize(created.row)),
        token: created.token,
        url: `/s/${created.token}`,
      }
      return reply.code(201).send(body)
    } catch (err) {
      return sendFsError(reply, err, 'create')
    }
  })

  app.delete<{ Params: { id: string } }>('/api/shares/:id', { preHandler: auth }, async (req, reply) => {
    // A soft revoke: the row survives so the list can say what happened, the
    // audit trail still resolves, and an in-flight download sees a consistent
    // refusal on its next request.
    if (!ctx.shares.revoke(req.params.id)) {
      return reply.code(404).send({ error: { code: 'share_not_found', message: 'no such share' } })
    }
    audit(ctx.auth.db, 'share.revoke', req.params.id, req.ip)
    return reply.code(204).send()
  })

  /**
   * Issues a fresh token for an existing share.
   *
   * One endpoint and one transaction rather than a client-side delete-then-create:
   * if the create failed after the revoke succeeded, the owner would have lost
   * the share with no replacement — exactly what this feature exists to prevent.
   */
  app.post<{ Params: { id: string } }>(
    '/api/shares/:id/regenerate',
    { preHandler: auth },
    async (req, reply) => {
      const result = ctx.shares.regenerate(req.params.id)
      if (result === null) {
        return reply
          .code(404)
          .send({ error: { code: 'share_not_found', message: 'no such share, or it is revoked' } })
      }

      audit(ctx.auth.db, 'share.regenerate', `${req.params.id} -> ${result.row.id}`, req.ip)
      const body: ShareCreated = {
        ...(await summarize(result.row)),
        token: result.token,
        url: `/s/${result.token}`,
      }
      return reply.code(201).send(body)
    },
  )

  function sendFsError(reply: FastifyReply, err: unknown, context: string): FastifyReply {
    const fsError = toFsError(err)
    if (fsError.status >= 500) log.error(`${context}: ${fsError.message}`, err)
    return reply.code(fsError.status).send({ error: { code: fsError.code, message: fsError.message } })
  }
}
