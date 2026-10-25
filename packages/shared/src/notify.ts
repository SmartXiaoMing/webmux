import { z } from 'zod'
import { pingMessage, pongMessage } from './protocol'

/**
 * Notification DTOs and the event-channel protocol.
 *
 * Two transports carry the same record:
 *   - `POST /api/notify` is the local-only ingress a script calls when a
 *     command finishes. Its body is either JSON or plain text.
 *   - `/ws/events` is the app-wide live channel the browser listens on. It is
 *     deliberately separate from `/ws/terminal`, which is bound to one session
 *     and carries a whole replay/snapshot protocol of its own.
 *
 * As with `api.ts` and `protocol.ts`, everything here is shared verbatim
 * between server and client so a drift becomes a compile error.
 */

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

export const notifyLevels = ['info', 'warn', 'error'] as const
export type NotifyLevel = (typeof notifyLevels)[number]

/**
 * What is displayed. Both bounds are enforced by the server's sanitiser, not
 * by the request schema: a title one character too long should arrive
 * truncated, not as a 400 that breaks whatever script was reporting success.
 */
export const NOTIFY_TITLE_MAX = 200
export const NOTIFY_BODY_MAX = 4000

export interface NotificationRecord {
  /**
   * Monotonic, and assigned by SQLite (`AUTOINCREMENT`). It doubles as the
   * catch-up cursor a reconnecting client sends back, so ids must never be
   * reused after a prune — which is exactly what AUTOINCREMENT guarantees and
   * a bare `INTEGER PRIMARY KEY` does not.
   */
  id: number
  createdAt: number
  title: string
  body: string | null
  level: NotifyLevel
  /** The terminal this came from, when the caller knew. Enables click-to-jump. */
  sessionId: string | null
  /** Which script or host sent it. Free-form, for display only. */
  source: string | null
  read: boolean
}

export interface NotifyAccepted {
  ok: true
  id: number
  createdAt: number
}

// ---------------------------------------------------------------------------
// Ingress: POST /api/notify
// ---------------------------------------------------------------------------

/**
 * The ceiling here is deliberately looser than `NOTIFY_TITLE_MAX`: zod bounds
 * what a hostile caller can make the server hold in memory, the sanitiser
 * bounds what is displayed. Anything between the two is truncated rather than
 * refused — a title one character too long should not be a 400 that breaks
 * whatever script was reporting success.
 *
 * The relationship to the route's body limit is not arbitrary:
 * `NOTIFY_BODY_LIMIT` in `http/notify.ts` is sized so that the largest body
 * these bounds allow still fits, JSON escaping and all. Raising one without
 * the other trades a truncation for a 413 that arrives from a different layer
 * with a different error shape.
 */
export const notifyRequest = z.object({
  title: z.string().min(1).max(1000),
  body: z.string().max(5000).optional(),
  level: z.enum(notifyLevels).default('info'),
  sessionId: z.string().min(1).max(128).optional(),
  source: z.string().max(64).optional(),
  /** Groups deliveries at the push service, so a burst of the same kind collapses. */
  tag: z.string().max(64).optional(),
})

export type NotifyRequest = z.infer<typeof notifyRequest>

// ---------------------------------------------------------------------------
// Event channel: /ws/events
// ---------------------------------------------------------------------------

export const EVENTS_WS_PATH = '/ws/events'

/**
 * How many notifications a reconnecting client is brought up to date with.
 *
 * A client that was away for three days must not return to 200 toasts. The
 * authoritative count still arrives in `ready.unread`, so the badge is right
 * even when the list is truncated; the UI collapses anything past a couple of
 * items into one summary.
 */
export const NOTIFY_BACKLOG_LIMIT = 50

export const notifyHelloMessage = z.object({
  t: z.literal('hello'),
  /**
   * The highest id the client has already seen. Omitted on a first visit.
   * A value above the server's `latestId` means the database was replaced
   * (restored from backup, different data directory) and is treated as a
   * reset — otherwise the client would ignore every future notification.
   */
  since: z.number().int().nonnegative().optional(),
})

export const notifyClientMessage = z.discriminatedUnion('t', [
  notifyHelloMessage,
  pingMessage,
  pongMessage,
])

export type NotifyClientMessage = z.infer<typeof notifyClientMessage>

/** Sent once per connection, after the socket is already on the fan-out list. */
export interface NotifyReadyMessage {
  t: 'ready'
  latestId: number
  unread: number
  /** True when `since` was older than what has been retained. */
  truncated: boolean
}

export interface NotifyItemsMessage {
  t: 'notify'
  items: NotificationRecord[]
  /**
   * Unread count *after* these items, from the server that owns the table.
   *
   * Carried on every batch so a client never has to guess: deriving it locally
   * would mean the badge and the push notification could disagree, and a tab
   * that was away has no way to know what it missed.
   */
  unread: number
  /**
   * History rather than news.
   *
   * Set on the batch a client is sent when it says hello, which is not
   * something to announce: fifty toasts for fifty notifications that arrived
   * while the tab was closed is worse than silence. Marked explicitly rather
   * than inferred from "the first batch after `ready`", which breaks the
   * moment the backlog is empty — a server with nothing to catch up on sends
   * no batch at all, and the flag a client inferred from it would then swallow
   * the next live notification.
   *
   * Absent means live. Every other producer of this frame is delivering news.
   */
  catchUp?: true
}

/** Read-state changed elsewhere (another tab, another device). */
export interface NotifyReadMessage {
  t: 'read'
  upTo: number
  unread: number
}

export interface NotifyPingMessage {
  t: 'ping'
}

export interface NotifyPongMessage {
  t: 'pong'
}

/**
 * A frame the client sent could not be used.
 *
 * There is no `unauthorized` member: authentication is settled at the upgrade,
 * and a rejected upgrade is an HTTP 401 the browser cannot read the status of
 * — it reports every failed handshake as close code 1006 anyway. An expired
 * session therefore surfaces on the next `/api/notifications` fetch, which
 * sees the same 401 and signs the client out.
 */
export type NotifyErrorCode = 'bad_message' | 'internal'

export interface NotifyErrorMessage {
  t: 'error'
  code: NotifyErrorCode
  message: string
}

export type NotifyServerMessage =
  | NotifyReadyMessage
  | NotifyItemsMessage
  | NotifyReadMessage
  | NotifyPingMessage
  | NotifyPongMessage
  | NotifyErrorMessage

// ---------------------------------------------------------------------------
// Authenticated REST
// ---------------------------------------------------------------------------

export interface NotificationListResponse {
  /** Newest first. */
  notifications: NotificationRecord[]
  unread: number
  latestId: number
}

export const notificationListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Only notifications newer than this id. */
  since: z.coerce.number().int().nonnegative().optional(),
  unreadOnly: z
    .enum(['1', 'true', '0', 'false'])
    .transform((v) => v === '1' || v === 'true')
    .default(false),
})

export type NotificationListQuery = z.infer<typeof notificationListQuery>

/**
 * An explicit "mark these read" rather than a toggle: a retried request would
 * flip a toggle back, leaving the user with the opposite of what they asked
 * for. Omitting every field is refused — an accidental `{}` should not clear
 * the badge.
 */
export const notifyReadRequest = z
  .object({
    ids: z.array(z.number().int().positive()).max(500).optional(),
    /** Everything up to and including this id. What "mark all read" sends. */
    upTo: z.number().int().nonnegative().optional(),
    all: z.boolean().optional(),
  })
  .refine((v) => v.ids !== undefined || v.upTo !== undefined || v.all === true, {
    message: 'one of ids, upTo or all is required',
  })

export type NotifyReadRequest = z.infer<typeof notifyReadRequest>

export interface NotifyReadResponse {
  unread: number
}

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------

/**
 * What the client needs to know before it offers notifications at all.
 *
 * Both flags are here because they fail differently: with the feature off there
 * is nothing to show and the bell should not exist; with push off the bell and
 * the panel still work, and only the "will my phone ring" row is unavailable.
 */
export interface NotificationStatusResponse {
  /** The feature itself. Off means the ingress 404s and nothing is streamed. */
  enabled: boolean
  /** Whether this deployment can reach a phone with the page closed. */
  push: boolean
  /**
   * base64url of the uncompressed P-256 point, for `applicationServerKey`.
   *
   * Null when push is unavailable. The client compares it against the key its
   * existing subscription was created with: a mismatch means the old
   * subscription is dead and must be replaced.
   */
  publicKey: string | null
  /** How many live push subscriptions exist across all devices. */
  subscriptions: number
}

export const pushSubscribeRequest = z.object({
  /**
   * Validated more strictly in `notify/webpush.ts` (https, length) rather than
   * here, so the scheme rule lives next to the code that fetches it.
   */
  endpoint: z.string().min(1).max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
})

export type PushSubscribeRequest = z.infer<typeof pushSubscribeRequest>

export const pushUnsubscribeRequest = z.object({
  endpoint: z.string().min(1).max(2048),
})

export type PushUnsubscribeRequest = z.infer<typeof pushUnsubscribeRequest>

export interface PushSubscribeResponse {
  ok: true
  subscriptions: number
}

/**
 * What the service worker receives, encrypted, in a push message.
 *
 * Duplicated by hand in `packages/web/public/sw.js`, which has no build step
 * and cannot import this file. Keep the two in step.
 */
export interface PushPayload {
  id: number
  title: string
  body: string | null
  level: NotifyLevel
  sessionId: string | null
  /** Unread count at send time, so the app badge is right with no page open. */
  unread: number
}
