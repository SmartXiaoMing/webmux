import type net from 'node:net'
import type { FastifyInstance } from 'fastify'
import {
  notificationListQuery,
  notifyReadRequest,
  notifyRequest,
  pushSubscribeRequest,
  pushUnsubscribeRequest,
  type NotificationListResponse,
  type NotificationStatusResponse,
  type NotifyAccepted,
  type NotifyReadResponse,
  type NotifyRequest,
  type PushSubscribeResponse,
} from '@webmux/shared'
import { audit } from '../audit'
import { requireAuth, type AuthContext } from '../auth/routes'
import type { NotifyConfig } from '../config'
import { logger } from '../logger'
import type { NotificationHub, PushService } from '../notify/hub'
import { localOnlyRejection, type LocalOnlyRejection } from '../notify/local-only'
import type { NotificationStore, PushSubscriptionStore } from '../notify/store'

const log = logger.child('notify')

export interface NotifyRouteContext {
  hub: NotificationHub
  store: NotificationStore
  subscriptions: PushSubscriptionStore
  auth: AuthContext
  notify: NotifyConfig
  /** Source addresses the ingress accepts. See `buildNotifyAllowList`. */
  allow: net.BlockList
  /** The bearer token the ingress requires. See `notify/token.ts`. */
  token: string
  /** Null when push is off, or when this deployment cannot support it. */
  push: PushService | null
}

/**
 * How the refusal is explained to whoever is holding the terminal.
 *
 * These messages are read by an operator debugging a script, so they name the
 * check that failed rather than saying "forbidden" — the four causes are
 * indistinguishable from the outside and have completely different fixes.
 */
const REJECTION_MESSAGE: Record<LocalOnlyRejection, string> = {
  origin: 'this endpoint is not callable from a browser',
  peer: 'caller is not on this machine',
  forwarded: 'request arrived through a proxy from a non-local address',
  token: 'missing or invalid notify token',
}

/** The window the hub enforces, used as the `Retry-After` hint. */
const RATE_LIMIT_RETRY_SECONDS = 60

/**
 * The request-body ceiling.
 *
 * Sized against the shared schema rather than picked for feel: `notifyRequest`
 * caps the title and body at 1000 and 5000 characters, and a JSON-escaped
 * character can cost four bytes plus six for a surrogate pair — so the worst
 * schema-legal body is about 24 KB. Anything below that turns input the schema
 * accepts into a Fastify 413 with a different error shape, which is a
 * confusing way to learn that the two limits disagree.
 */
const NOTIFY_BODY_LIMIT = 32 * 1024

/**
 * At most one rejection row per minute.
 *
 * The peer check is the one a port scanner trips, and the audit table is a
 * security record that nothing prunes — auditing every rejection turns a scan
 * into unbounded growth that buries the events the table exists to hold. One
 * row a minute keeps the signal ("someone is knocking") without the volume.
 */
const REJECT_AUDIT_INTERVAL_MS = 60_000

/**
 * The plain-text form of a notification: first line is the title, the rest is
 * the body.
 *
 * Worth the six lines it costs, because it makes the whole feature reachable
 * from a shell without quoting JSON:
 *
 *   curl -H 'Content-Type: text/plain' -d '构建完成' ...
 */
function fromPlainText(raw: string): NotifyRequest | null {
  const [first, ...rest] = raw.split('\n')
  if (first === undefined || first.trim() === '') return null

  const body = rest.join('\n').trim()
  return { title: first, level: 'info', ...(body === '' ? {} : { body }) }
}

export function registerNotifyRoutes(app: FastifyInstance, ctx: NotifyRouteContext): void {
  const auth = requireAuth(ctx.auth)
  /** Per registration rather than module-level, so tests do not share it. */
  let lastRejectAuditAt = 0

  /**
   * The ingress. Local callers only, and deliberately not behind `requireAuth`:
   * a shell script has no session cookie, and giving it one would mean handing
   * out credentials for the whole API to anything that can read a file.
   */
  app.post('/api/notify', { bodyLimit: NOTIFY_BODY_LIMIT }, async (req, reply) => {
    if (!ctx.notify.enabled) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'notifications are disabled' } })
    }

    const rejection = localOnlyRejection(req, ctx.allow, ctx.token)
    if (rejection !== null) {
      // Throttled. A rejection is worth recording — a wrong token is either a
      // broken script or someone probing — but one row per rejected request
      // would let an unauthenticated caller with a port scanner fill a table
      // that is never pruned.
      const now = Date.now()
      if (now - lastRejectAuditAt >= REJECT_AUDIT_INTERVAL_MS) {
        lastRejectAuditAt = now
        audit(ctx.auth.db, `notify.reject_${rejection}`, null, req.ip)
      }
      const status = rejection === 'token' ? 401 : 403
      return reply.code(status).send({
        error: { code: `notify_${rejection}`, message: REJECTION_MESSAGE[rejection] },
      })
    }

    let input: NotifyRequest | null = null
    const contentType = req.headers['content-type'] ?? ''

    if (contentType.startsWith('text/plain')) {
      input = typeof req.body === 'string' ? fromPlainText(req.body) : null
    } else if (req.body !== undefined && typeof req.body === 'object') {
      const parsed = notifyRequest.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: 'invalid_request', message: parsed.error.issues[0]?.message ?? 'invalid body' },
        })
      }
      input = parsed.data
    }

    if (input === null) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: 'a title is required (plain text body, or JSON)' },
      })
    }

    const outcome = ctx.hub.publish({
      title: input.title,
      body: input.body,
      level: input.level,
      sessionId: input.sessionId,
      source: input.source,
      tag: input.tag,
    })

    if (!outcome.ok && outcome.reason === 'rate_limited') {
      // Deliberately a log line and not an audit row. A script stuck in a retry
      // loop produces one of these per attempt, and the audit table is a
      // security record — filling it with a thousand identical rows would bury
      // the events it exists to hold.
      log.warn(`notify rate limit hit (${ctx.notify.perMinute}/minute) — caller backed off`)
      return reply
        .code(429)
        .header('retry-after', String(RATE_LIMIT_RETRY_SECONDS))
        .send({ error: { code: 'rate_limited', message: 'too many notifications, slow down' } })
    }

    if (!outcome.ok) {
      return reply.code(500).send({ error: { code: 'internal', message: 'could not record notification' } })
    }

    const body: NotifyAccepted = {
      ok: true,
      id: outcome.notification.id,
      createdAt: outcome.notification.createdAt,
    }
    return reply.code(201).send(body)
  })

  app.get('/api/notifications', { preHandler: auth }, async (req, reply) => {
    const parsed = notificationListQuery.safeParse(req.query)
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: parsed.error.issues[0]?.message ?? 'invalid query' },
      })
    }

    const { limit, since, unreadOnly } = parsed.data
    const body: NotificationListResponse = {
      notifications: ctx.store.list(limit, {
        ...(since !== undefined ? { since } : {}),
        unreadOnly,
      }),
      unread: ctx.store.unreadCount(),
      latestId: ctx.store.latestId(),
    }
    return reply.send(body)
  })

  app.post('/api/notifications/read', { preHandler: auth }, async (req, reply) => {
    const parsed = notifyReadRequest.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: parsed.error.issues[0]?.message ?? 'invalid body' },
      })
    }

    const result = ctx.store.markRead(parsed.data)
    // Every other tab and device clears the same rows without refetching.
    ctx.hub.broadcastRead(result.upTo, result.unread)

    const body: NotifyReadResponse = { unread: result.unread }
    return reply.send(body)
  })

  app.get('/api/notifications/status', { preHandler: auth }, async () => {
    const body: NotificationStatusResponse = {
      // Both flags, not just push: with the feature off the client must not
      // build the event channel or offer a bell whose empty state suggests a
      // command that now 404s.
      enabled: ctx.notify.enabled,
      push: ctx.push !== null,
      publicKey: ctx.push?.publicKey ?? null,
      subscriptions: ctx.push?.count() ?? 0,
    }
    return body
  })

  app.post('/api/notifications/push', { preHandler: auth }, async (req, reply) => {
    if (ctx.push === null) {
      return reply
        .code(404)
        .send({ error: { code: 'push_disabled', message: 'push notifications are disabled' } })
    }

    const parsed = pushSubscribeRequest.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: parsed.error.issues[0]?.message ?? 'invalid body' },
      })
    }

    try {
      ctx.push.subscribe({
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
        ua: req.headers['user-agent'] ?? null,
      })
    } catch (err) {
      // The message is the point: a subscription rejected for a bad key or a
      // non-https endpoint is the caller's mistake and says so.
      return reply
        .code(400)
        .send({ error: { code: 'invalid_subscription', message: (err as Error).message } })
    }

    const body: PushSubscribeResponse = { ok: true, subscriptions: ctx.push.count() }
    return reply.code(201).send(body)
  })

  app.delete('/api/notifications/push', { preHandler: auth }, async (req, reply) => {
    const parsed = pushUnsubscribeRequest.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: parsed.error.issues[0]?.message ?? 'invalid body' },
      })
    }

    ctx.push?.unsubscribe(parsed.data.endpoint)
    const body: PushSubscribeResponse = { ok: true, subscriptions: ctx.push?.count() ?? 0 }
    return reply.send(body)
  })
}
