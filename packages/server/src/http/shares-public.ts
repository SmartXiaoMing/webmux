import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { audit } from '../audit'
import { FailureLimiter } from '../auth/ratelimit'
import type { AuthContext } from '../auth/routes'
import type { Config } from '../config'
import type { Jail, ResolvedPath } from '../fs/jail'
import { mimeFor, previewPolicy } from '../fs/stream'
import { archiveStream, walkForArchive } from '../fs/zip/write'
import { logger } from '../logger'
import { readTopLevel } from '../shares/listing'
import {
  MAX_LISTED_ENTRIES,
  MESSAGES,
  renderDirectoryPage,
  renderFilePage,
  renderNotFoundPage,
  renderPasswordPage,
  renderUnavailablePage,
} from '../shares/page'
import { resolveShareTarget } from '../shares/resolve'
import type { ShareRow, ShareStore } from '../shares/store'
import {
  SHARE_COOKIE,
  SHARE_TOKEN_PATTERN,
  issueShareCookie,
  verifyShareCookie,
} from '../shares/tokens'
import { VerifyGate, verifySharePassword } from '../shares/verify'
import { archiveRootName, applyArchiveHeaders } from './archive'
import { sendFile } from './send-file'
import { paced } from './throttle'

const log = logger.child('http:share')

/**
 * The public share surface.
 *
 * This is the only part of webmux a visitor reaches without a cookie, and the
 * only part whose *inputs* are attacker-influenced — a filename is whatever
 * someone put on the disk. Everything here is written with that in mind, and the
 * page renderer in `shares/page.ts` carries the escaping rules.
 *
 * Two routes, and deliberately no path parameter: a directory share is a zip,
 * not a browsable tree, so the path jail never has to be re-implemented in a
 * context where nobody is authenticated.
 */

/** Never let the page be framed, scripted, or leak the token through a referrer. */
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

type RefusalCode = 'revoked' | 'expired' | 'exhausted' | 'source_unavailable'

const REFUSAL_MESSAGE: Record<RefusalCode, string> = {
  revoked: MESSAGES.revoked,
  expired: MESSAGES.expired,
  exhausted: MESSAGES.exhausted,
  source_unavailable: MESSAGES.sourceUnavailable,
}

export interface PublicShareRoutesContext {
  jail: Jail
  shares: ShareStore
  auth: AuthContext
  config: Config
  gate: VerifyGate
  limiter: FailureLimiter
}

function sendPage(
  reply: FastifyReply,
  status: number,
  html: string,
  headers: Record<string, string> = {},
): FastifyReply {
  reply
    .code(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('content-security-policy', PAGE_CSP)
    // Load-bearing, not decoration: without an explicit charset a crafted byte
    // sequence can be decoded under a different encoding and turn escaped text
    // back into markup.
    .header('x-content-type-options', 'nosniff')
    // The token is in the URL path, so any outbound request would leak it in
    // `Referer`. There are none today; this is insurance for the day someone
    // adds a link.
    .header('referrer-policy', 'no-referrer')
    .header('cache-control', 'no-store')
  for (const [key, value] of Object.entries(headers)) reply.header(key, value)
  return reply.send(html)
}

type Lookup =
  | { outcome: 'missing' }
  | { outcome: 'refused'; code: RefusalCode }
  | { outcome: 'ok'; row: ShareRow }

/**
 * Token to row, with the cheapest refusals first.
 *
 * Order matters for cost: a bogus token must not touch the filesystem, run
 * scrypt, or write an audit row, or the endpoint becomes an amplifier for
 * someone with no knowledge at all.
 */
function lookup(ctx: PublicShareRoutesContext, token: string): Lookup {
  // Shape first. A malformed token and an unknown one answer *identically* —
  // a 400 for the wrong shape and a 404 for the right one would hand an
  // attacker a bulk-validity oracle for free.
  if (!SHARE_TOKEN_PATTERN.test(token)) return { outcome: 'missing' }
  if (!ctx.config.shares.enabled) return { outcome: 'missing' }

  const row = ctx.shares.byToken(token)
  if (row === null) return { outcome: 'missing' }

  // The operator's explicit kill is the more informative reason when both apply.
  if (row.revoked_at !== null) return { outcome: 'refused', code: 'revoked' }
  // A field compare before any filesystem work, so an expired link costs nothing.
  if (row.expires_at !== null && row.expires_at <= Date.now()) {
    return { outcome: 'refused', code: 'expired' }
  }

  return { outcome: 'ok', row }
}

async function unlocked(
  ctx: PublicShareRoutesContext,
  row: ShareRow,
  req: FastifyRequest,
): Promise<boolean> {
  if (row.password_hash === null) return true
  const cookie = req.cookies[SHARE_COOKIE]
  if (cookie === undefined) return false
  return verifyShareCookie(ctx.auth.secret, cookie, { sid: row.id, th: row.token_hash })
}

function unlockTtlSeconds(ctx: PublicShareRoutesContext, row: ShareRow, now = Date.now()): number {
  const byConfig = ctx.config.shares.unlockTtlHours * 3600
  if (row.expires_at === null) return byConfig
  return Math.max(1, Math.min(byConfig, Math.floor((row.expires_at - now) / 1000)))
}

/** The visitor is looking at a page, so a refusal is a page — never JSON. */
function refuse(reply: FastifyReply, code: RefusalCode): FastifyReply {
  return sendPage(reply, 410, renderUnavailablePage(REFUSAL_MESSAGE[code]), {
    'x-webmux-error': code,
  })
}

export function registerPublicShareRoutes(app: FastifyInstance, ctx: PublicShareRoutesContext): void {
  const sweeper = setInterval(() => ctx.limiter.sweep(), 5 * 60 * 1000)
  sweeper.unref?.()
  app.addHook('onClose', async () => clearInterval(sweeper))

  // A scoped plugin, not `registerXxxRoutes(app, ctx)` like every other module,
  // because the scoping *is* the point: `prefix: '/s'` confines both the routes
  // and the form-body parser to this surface, so the authenticated API can never
  // grow a urlencoded parser by accident.
  void app.register(
    async (scope) => {
      scope.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string' },
        (_req, body, done) => {
          try {
            done(null, Object.fromEntries(new URLSearchParams(body as string)))
          } catch (err) {
            done(err as Error, undefined)
          }
        },
      )

      scope.get<{ Params: { token: string } }>('/:token', async (req, reply) => {
        const token = req.params.token
        const found = lookup(ctx, token)
        if (found.outcome === 'missing') return sendPage(reply, 404, renderNotFoundPage())
        if (found.outcome === 'refused') return refuse(reply, found.code)

        const row = found.row
        const target = await resolveShareTarget(ctx.jail, row)
        if (!target.ok) return refuse(reply, 'source_unavailable')

        // The page and `/raw` must agree, or the button 410s from a page that
        // looked perfectly fine.
        if (row.max_downloads !== null && row.downloads >= row.max_downloads) {
          return refuse(reply, 'exhausted')
        }

        const page = { token, name: row.name }

        if (!(await unlocked(ctx, row, req))) {
          // Never the listing, never the size, never the mtime — otherwise the
          // password is theatre.
          return sendPage(reply, 200, renderPasswordPage(page))
        }

        ctx.shares.touch(row.id, req.ip)

        if (row.kind === 'dir') {
          try {
            const { entries, capped } = await readTopLevel(target.resolved.abs, MAX_LISTED_ENTRIES)
            return sendPage(reply, 200, renderDirectoryPage(page, entries, capped))
          } catch (err) {
            log.warn(`share ${row.id}: could not list: ${(err as Error).message}`)
            return refuse(reply, 'source_unavailable')
          }
        }

        const info = await stat(target.resolved.abs).catch(() => null)
        if (info === null) return refuse(reply, 'source_unavailable')
        return sendPage(reply, 200, renderFilePage(page, info.size, info.mtimeMs))
      })

      scope.post<{ Params: { token: string } }>('/:token', async (req, reply) => {
        const token = req.params.token
        const found = lookup(ctx, token)
        if (found.outcome === 'missing') return sendPage(reply, 404, renderNotFoundPage())
        if (found.outcome === 'refused') return refuse(reply, found.code)

        const row = found.row
        const page = { token, name: row.name }
        const backTo = { location: `/s/${token}` }

        // Nothing to unlock. Send them on rather than pretending to check.
        if (row.password_hash === null) return reply.code(303).headers(backTo).send()

        const body = req.body as Record<string, unknown> | undefined
        const password = typeof body?.password === 'string' ? body.password : ''
        if (password === '' || password.length > 1024) {
          return sendPage(reply, 200, renderPasswordPage(page, { kind: 'error', text: MESSAGES.wrongPassword }))
        }

        // Keyed on IP *and* share. IP alone would be a one-line denial of the
        // whole feature behind a reverse proxy: with `trustProxy` off — the
        // correct default — every request carries the proxy's address, so five
        // bad guesses by anyone would lock out every share for every visitor.
        // The degenerate case without a proxy is "effectively per-share", which
        // is the right behaviour.
        const key = `${req.ip}|${row.id}`
        const retryAfter = ctx.limiter.retryAfter(key)
        if (retryAfter > 0) {
          audit(ctx.auth.db, 'share.unlock_limited', row.id, req.ip)
          return sendPage(
            reply,
            429,
            renderPasswordPage(page, { kind: 'note', text: `尝试次数过多，请 ${retryAfter} 秒后再试。` }),
            { 'retry-after': String(retryAfter) },
          )
        }

        const outcome = await verifySharePassword(ctx.gate, password, row.password_hash)

        if (typeof outcome === 'number') {
          // The concurrency gate, not the failure limiter: the machine is busy.
          log.warn(`share unlock refused by the verification gate`)
          return sendPage(
            reply,
            429,
            renderPasswordPage(page, { kind: 'note', text: '服务器正忙，请稍后再试。' }),
            { 'retry-after': String(outcome) },
          )
        }

        if (outcome === 'wrong') {
          ctx.limiter.recordFailure(key)
          audit(ctx.auth.db, 'share.unlock_failed', row.id, req.ip)
          return sendPage(reply, 200, renderPasswordPage(page, { kind: 'error', text: MESSAGES.wrongPassword }))
        }

        ctx.limiter.reset(key)
        audit(ctx.auth.db, 'share.unlock', row.id, req.ip)

        const ttl = unlockTtlSeconds(ctx, row)
        const cookie = await issueShareCookie(
          ctx.auth.secret,
          { sid: row.id, th: row.token_hash },
          ttl,
        )

        reply.setCookie(SHARE_COOKIE, cookie, {
          httpOnly: true,
          sameSite: 'lax',
          secure: req.protocol === 'https',
          // The exact token, never "/s". With "/s" a single unlock would open
          // every share on the instance — and that is invisible in any test that
          // only ever exercises one share.
          path: `/s/${token}`,
          maxAge: ttl,
        })
        return reply.code(303).headers(backTo).send()
      })

      scope.get<{ Params: { token: string } }>(
        '/:token/raw',
        // Fastify exposes a HEAD route for every GET by default. A HEAD would
        // run this handler, claim a download and open a descriptor for nothing —
        // the kind of thing that shows up as "the cap decrements by itself".
        { exposeHeadRoute: false },
        async (req, reply) => {
          const token = req.params.token
          const found = lookup(ctx, token)
          if (found.outcome === 'missing') {
            return sendPage(reply, 404, renderNotFoundPage(), { 'x-webmux-error': 'not_found' })
          }
          if (found.outcome === 'refused') return refuse(reply, found.code)

          const row = found.row
          const target = await resolveShareTarget(ctx.jail, row)
          if (!target.ok) return refuse(reply, 'source_unavailable')

          // Password *before* the download cap. The cap is a consumed resource:
          // checking it first would let anyone holding the URL burn every
          // download without knowing the password and permanently deny the
          // legitimate recipient. Authenticate, then consume.
          if (!(await unlocked(ctx, row, req))) {
            return sendPage(
              reply,
              401,
              renderUnavailablePage('这个分享需要密码，请先打开分享页面。'),
              { 'x-webmux-error': 'password_required' },
            )
          }

          // Counting is at request start with no refunds. A refund on a failed
          // transfer needs a compensating decrement, which reintroduces the race
          // and hands an attacker a "download for free" button — abort the
          // connection repeatedly and the counter never moves.
          //
          // A Range that does not begin at byte 0 is exempt, so video seeking
          // and resume-after-disconnect do not consume the cap. Be honest about
          // what that means: a client that starts every range at byte 1 counts
          // once and still gets 99.99% of the file. The cap is a leak-limiting
          // courtesy, not an enforcement boundary.
          const range = req.headers.range
          const startsAtZero = range === undefined || /^bytes=0-/.test(range.trim())
          if (startsAtZero) {
            const claimed = ctx.shares.claimDownload(row.id)
            if (claimed === null) return refuse(reply, 'exhausted')
          }

          // Audited here rather than after the transfer: the cap is consumed at
          // this moment with no refunds, so this is when a download happened,
          // whether or not the bytes then made it to the far end.
          audit(ctx.auth.db, 'share.download', row.id, req.ip)
          ctx.shares.touch(row.id, req.ip)

          if (row.kind === 'dir') {
            await sendArchive(ctx, req, reply, row, target.resolved)
            return
          }

          const rate = row.rate_limit_bps ?? ctx.config.shares.defaultRateLimitBytesPerSec

          // A payload served under a bearer URL must not sit in a proxy cache.
          // If caching is ever wanted, note that the same URL returns a form or
          // a file depending on the cookie, so it would need `Vary: Cookie`.
          reply.header('cache-control', 'no-store')

          await sendFile(
            req,
            reply,
            target.resolved.abs,
            (name, size) => {
              // The same allowlist the internal preview route uses. A second
              // copy would be a copy that drifts, and this one decides whether
              // markup executes in the SPA's origin.
              const policy = ctx.config.shares.inlinePreview ? previewPolicy(name) : null
              if (policy === null) {
                return { contentType: mimeFor(name), disposition: 'attachment' }
              }
              const truncated = policy.byteLimit !== undefined && size > policy.byteLimit
              return {
                contentType: policy.contentType,
                disposition: 'inline',
                ...(policy.byteLimit !== undefined ? { byteLimit: policy.byteLimit } : {}),
                headers: {
                  'content-security-policy': "script-src 'none'; object-src 'none'",
                  ...(truncated ? { 'x-webmux-truncated': 'true' } : {}),
                },
              }
            },
            {
              bytesPerSecond: rate,
              // A file that vanished between the resolve and the open is the
              // share's payload being gone, not a bad request.
              onError: (target, error) => {
                log.warn(`share ${row.id}: ${error.code} ${error.message}`)
                return sendPage(target, 410, renderUnavailablePage(MESSAGES.sourceUnavailable), {
                  'x-webmux-error': 'source_unavailable',
                })
              },
            },
          )
        },
      )
    },
    { prefix: '/s' },
  )
}

async function sendArchive(
  ctx: PublicShareRoutesContext,
  req: FastifyRequest,
  reply: FastifyReply,
  row: ShareRow,
  resolved: ResolvedPath,
): Promise<void> {
  let walk
  try {
    walk = await walkForArchive(resolved, archiveRootName(resolved))
  } catch (err) {
    log.warn(`share ${row.id}: cannot archive: ${(err as Error).message}`)
    sendPage(reply, 410, renderUnavailablePage(MESSAGES.sourceUnavailable), {
      'x-webmux-error': 'source_unavailable',
    })
    return
  }

  // Shared with `/api/fs/archive`, so the absent Content-Length / Range / ETag
  // reasoning lives in one place and cannot drift between the two routes.
  applyArchiveHeaders(reply, archiveRootName(resolved), walk)

  const rate = row.rate_limit_bps ?? ctx.config.shares.defaultRateLimitBytesPerSec
  // `paced` passes through untouched when the rate is zero, so there is one
  // code path rather than two.
  await reply.send(Readable.from(paced(archiveStream(walk), rate)))
}
