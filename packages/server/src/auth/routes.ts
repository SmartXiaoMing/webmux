import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { loginRequest, setupRequest, type AuthStatus } from '@webmux/shared'
import type { Config } from '../config'
import type { DB } from '../db/index'
import { getSetting, setSetting } from '../db/index'
import { audit } from '../audit'
import { logger } from '../logger'
import { hashPassword, verifyPassword } from './password'
import { FailureLimiter } from './ratelimit'
import {
  SESSION_COOKIE,
  bumpTokenVersion,
  getTokenVersion,
  issueToken,
  sessionCookieOptions,
  verifyToken,
} from './tokens'

const PASSWORD_HASH_KEY = 'auth.password_hash'

/** 5 failures per 15 minutes per IP, then a cooldown. */
const LOGIN_LIMITER = new FailureLimiter(5, 15 * 60 * 1000)

export interface AuthContext {
  db: DB
  config: Config
  secret: Uint8Array
}

export function isInitialized(db: DB): boolean {
  return getSetting(db, PASSWORD_HASH_KEY) !== null
}

export async function isAuthenticated(req: FastifyRequest, ctx: AuthContext): Promise<boolean> {
  const token = req.cookies[SESSION_COOKIE]
  if (!token) return false
  return verifyToken(ctx.secret, token, getTokenVersion(ctx.db))
}

/** preHandler for routes that require a valid session. */
export function requireAuth(ctx: AuthContext) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (await isAuthenticated(req, ctx)) return
    await reply.code(401).send({ error: { code: 'unauthorized', message: 'authentication required' } })
  }
}

function clientIp(req: FastifyRequest): string {
  return req.ip ?? 'unknown'
}

/**
 * Detects the proxy setup that quietly weakens the session cookie.
 *
 * `req.protocol` reports 'https' only when Fastify has been told to trust the
 * proxy's `X-Forwarded-Proto`. With `trustProxy` off, an instance sitting behind
 * a TLS-terminating proxy issues its session cookie **without** `Secure` — so a
 * plaintext request to the same host would carry it — and every client shares
 * one login-rate-limit bucket, because `req.ip` is the proxy's address. Both
 * consequences are invisible from the outside, which is why this is worth
 * saying out loud.
 *
 * Pure, so the condition can be tested without a server; the caller owns the
 * once-per-process latch.
 */
export function insecureCookieWarning(
  forwardedProto: string | string[] | undefined,
  trustProxy: boolean,
): string | null {
  if (trustProxy || forwardedProto === undefined) return null
  return (
    'a proxy is forwarding requests (X-Forwarded-Proto is present) but ' +
    'trustProxy is off: the session cookie is being issued without Secure, and ' +
    'every client shares one login rate-limit bucket. Set WEBMUX_TRUST_PROXY=true ' +
    'when running behind a reverse proxy.'
  )
}

/**
 * Latched per process. This is reachable on every login, and a wall of
 * identical lines is how a real warning gets scrolled past.
 */
let proxyWarningEmitted = false

function warnIfProxyMisconfigured(req: FastifyRequest, config: Config): void {
  if (proxyWarningEmitted) return
  const warning = insecureCookieWarning(req.headers['x-forwarded-proto'], config.trustProxy)
  if (warning === null) return
  proxyWarningEmitted = true
  logger.warn(warning)
}

async function grantSession(req: FastifyRequest, reply: FastifyReply, ctx: AuthContext): Promise<void> {
  // At the point the cookie is actually built, which is where the
  // misconfiguration has its effect.
  warnIfProxyMisconfigured(req, ctx.config)

  const token = await issueToken(ctx.secret, getTokenVersion(ctx.db), ctx.config.sessionTtlHours)
  const secure = req.protocol === 'https'
  reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(secure, ctx.config.sessionTtlHours))
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AuthContext): void {
  // Keeps the failure map from growing without bound on a long-lived process.
  const sweeper = setInterval(() => LOGIN_LIMITER.sweep(), 5 * 60 * 1000)
  sweeper.unref?.()
  app.addHook('onClose', async () => clearInterval(sweeper))

  app.get('/api/auth/status', async (req): Promise<AuthStatus> => {
    return {
      initialized: isInitialized(ctx.db),
      authenticated: await isAuthenticated(req, ctx),
    }
  })

  /**
   * First-run credential creation. Refuses once a password exists — otherwise
   * anyone who can reach the port could claim the instance.
   */
  app.post('/api/auth/setup', async (req, reply) => {
    if (isInitialized(ctx.db)) {
      return reply.code(409).send({ error: { code: 'already_initialized', message: 'setup already completed' } })
    }

    const parsed = setupRequest.safeParse(req.body)
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: parsed.error.issues[0]?.message ?? 'invalid body' } })
    }

    setSetting(ctx.db, PASSWORD_HASH_KEY, await hashPassword(parsed.data.password))
    audit(ctx.db, 'auth.setup', null, clientIp(req))
    logger.info(`initial password set from ${clientIp(req)}`)

    await grantSession(req, reply, ctx)
    return { ok: true }
  })

  app.post('/api/auth/login', async (req, reply) => {
    if (!isInitialized(ctx.db)) {
      return reply.code(409).send({ error: { code: 'not_initialized', message: 'no password configured' } })
    }

    const ip = clientIp(req)
    const retryAfter = LOGIN_LIMITER.retryAfter(ip)
    if (retryAfter > 0) {
      reply.header('Retry-After', String(retryAfter))
      audit(ctx.db, 'auth.ratelimited', null, ip)
      return reply
        .code(429)
        .send({ error: { code: 'rate_limited', message: `too many attempts, retry in ${retryAfter}s` } })
    }

    const parsed = loginRequest.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'invalid body' } })
    }

    const stored = getSetting(ctx.db, PASSWORD_HASH_KEY) ?? ''
    const ok = await verifyPassword(parsed.data.password, stored)

    if (!ok) {
      LOGIN_LIMITER.recordFailure(ip)
      audit(ctx.db, 'auth.login_failed', null, ip)
      return reply.code(401).send({ error: { code: 'invalid_credentials', message: 'incorrect password' } })
    }

    LOGIN_LIMITER.reset(ip)
    audit(ctx.db, 'auth.login', null, ip)
    await grantSession(req, reply, ctx)
    return { ok: true }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.post('/api/auth/password', { preHandler: requireAuth(ctx) }, async (req, reply) => {
    const body = req.body as { current?: string; next?: string } | undefined
    const stored = getSetting(ctx.db, PASSWORD_HASH_KEY) ?? ''

    if (typeof body?.current !== 'string' || !(await verifyPassword(body.current, stored))) {
      audit(ctx.db, 'auth.password_change_failed', null, clientIp(req))
      return reply.code(401).send({ error: { code: 'invalid_credentials', message: 'current password is wrong' } })
    }
    if (typeof body.next !== 'string' || body.next.length < 8) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: 'new password must be at least 8 characters' } })
    }

    setSetting(ctx.db, PASSWORD_HASH_KEY, await hashPassword(body.next))
    // Every existing token — including the one making this request — is now stale,
    // so a fresh one is issued to keep this browser signed in.
    bumpTokenVersion(ctx.db)
    audit(ctx.db, 'auth.password_changed', null, clientIp(req))

    await grantSession(req, reply, ctx)
    return { ok: true }
  })
}
