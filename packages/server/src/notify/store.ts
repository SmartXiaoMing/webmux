import type { NotificationRecord, NotifyLevel, NotifyReadRequest } from '@webmux/shared'
import type { DB } from '../db/index'

/**
 * Rows deleted per statement during a sweep.
 *
 * The sweep runs on the same thread that streams PTY output, so one DELETE
 * over everything that has expired would stall every open terminal for as long
 * as it takes. Batches keep each statement short; the loop runs to completion
 * either way.
 */
const SWEEP_BATCH = 200

/**
 * How many consecutive *unreachable* attempts retire a subscription.
 *
 * Deliberately narrow. Only a delivery that could not be attempted at all
 * counts (see `WebPushService.deliver`): an HTTP error means the push service
 * answered, which makes it a problem with the message or with our credentials,
 * not with the device. Counting those would let a burst of 429s — or an
 * afternoon of fixing a VAPID misconfiguration — permanently disable a phone
 * that was working perfectly.
 */
export const PUSH_FAILURE_LIMIT = 5

interface NotificationRow {
  id: number
  created_at: number
  title: string
  body: string | null
  level: string
  session_id: string | null
  source: string | null
  read_at: number | null
}

export interface NewNotification {
  title: string
  body: string | null
  level: NotifyLevel
  sessionId: string | null
  source: string | null
}

function toRecord(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    title: row.title,
    body: row.body,
    // The CHECK constraint in migration 5 is what makes this cast safe; the
    // column cannot hold anything else.
    level: row.level as NotifyLevel,
    sessionId: row.session_id,
    source: row.source,
    read: row.read_at !== null,
  }
}

export class NotificationStore {
  constructor(private readonly db: DB) {}

  insert(input: NewNotification): NotificationRecord {
    const createdAt = Date.now()
    const result = this.db
      .prepare(
        `INSERT INTO notifications (created_at, title, body, level, session_id, source)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(createdAt, input.title, input.body, input.level, input.sessionId, input.source)

    // better-sqlite3 types this as number | bigint; it is a rowid here, so the
    // conversion is total, but it has to be explicit.
    return {
      id: Number(result.lastInsertRowid),
      createdAt,
      title: input.title,
      body: input.body,
      level: input.level,
      sessionId: input.sessionId,
      source: input.source,
      read: false,
    }
  }

  /** Newest first. */
  list(limit: number, options: { since?: number; unreadOnly?: boolean } = {}): NotificationRecord[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (options.since !== undefined) {
      clauses.push('id > ?')
      params.push(options.since)
    }
    if (options.unreadOnly === true) clauses.push('read_at IS NULL')

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM notifications ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as NotificationRow[]
    return rows.map(toRecord)
  }

  unreadCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL').get() as
      | { n: number }
      | undefined
    return row?.n ?? 0
  }

  /** Highest id ever issued, or 0 on an empty table. The client's cursor max. */
  latestId(): number {
    const row = this.db.prepare('SELECT MAX(id) AS id FROM notifications').get() as
      | { id: number | null }
      | undefined
    return row?.id ?? 0
  }

  /** Oldest retained id, or null when there is nothing. Bounds a catch-up. */
  oldestId(): number | null {
    const row = this.db.prepare('SELECT MIN(id) AS id FROM notifications').get() as
      | { id: number | null }
      | undefined
    return row?.id ?? null
  }

  /**
   * Marks rows read and reports where that leaves the unread count.
   *
   * `upTo` in the result is what the event channel broadcasts, so every other
   * tab and device can drop the same rows without refetching. `all` resolves
   * to the current maximum, and the three forms are mutually exclusive by
   * precedence rather than by validation: a caller that sends both is asking
   * for the broader of the two, and doing the wider one is the safe reading.
   */
  markRead(request: NotifyReadRequest): { unread: number; upTo: number } {
    const now = Date.now()

    if (request.all === true) {
      this.db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL').run(now)
      return { unread: 0, upTo: this.latestId() }
    }

    if (request.upTo !== undefined) {
      this.db
        .prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND id <= ?')
        .run(now, request.upTo)
      return { unread: this.unreadCount(), upTo: request.upTo }
    }

    const ids = request.ids ?? []
    // Unreachable through the route — the shared schema refuses an empty
    // request — but this method is also called from tests, and an UPDATE with
    // an empty IN list is a syntax error rather than a no-op.
    if (ids.length === 0) return { unread: this.unreadCount(), upTo: 0 }

    const placeholders = ids.map(() => '?').join(', ')
    this.db
      .prepare(`UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND id IN (${placeholders})`)
      .run(now, ...ids)
    // Zero, not the highest id marked. `upTo` is a *cursor* — "everything up
    // to here is read" — and this request was for a set of ids that need not
    // be contiguous. Reporting the maximum would have every other tab mark the
    // rows in between as read as well, which is not what the server did, and
    // the next refresh would flip them back.
    return { unread: this.unreadCount(), upTo: 0 }
  }

  clear(): void {
    this.db.prepare('DELETE FROM notifications').run()
  }

  /**
   * Applies the retention policy and reports how many rows went away.
   *
   * Two rules, in order:
   *   1. Anything past `retentionDays` that has been read. Unread rows survive
   *      this pass on purpose — coming back after a long absence to find the
   *      failure notification silently expired is the exact case the feature
   *      exists to prevent.
   *   2. More than `maxStored` read rows, or more than `maxStored` unread ones.
   *      The second half of that is the backstop for rule 1: an instance
   *      nobody has opened for a year would otherwise grow without bound, and
   *      an unread notification that old has no value left.
   */
  sweep(retentionDays: number, maxStored: number): number {
    const cutoff = Date.now() - retentionDays * 86_400_000
    let removed = this.deleteBatched('created_at < ? AND read_at IS NOT NULL', [cutoff])
    removed += this.trimToNewest('read_at IS NOT NULL', maxStored)
    removed += this.trimToNewest('read_at IS NULL', maxStored)
    return removed
  }

  /** Deletes everything at or below the `maxStored`-th newest matching row. */
  private trimToNewest(condition: string, maxStored: number): number {
    const boundary = this.db
      .prepare(`SELECT id FROM notifications WHERE ${condition} ORDER BY id DESC LIMIT 1 OFFSET ?`)
      .get(maxStored) as { id: number } | undefined
    if (boundary === undefined) return 0
    return this.deleteBatched(`id <= ? AND ${condition}`, [boundary.id])
  }

  private deleteBatched(where: string, params: unknown[]): number {
    let removed = 0
    for (;;) {
      // `DELETE ... LIMIT` is a SQLite compile-time option, so the portable
      // form of "delete a bounded number of rows" is an id subquery.
      const changes = this.db
        .prepare(
          `DELETE FROM notifications WHERE id IN (
             SELECT id FROM notifications WHERE ${where} ORDER BY id LIMIT ?
           )`,
        )
        .run(...params, SWEEP_BATCH).changes
      removed += changes
      if (changes < SWEEP_BATCH) return removed
    }
  }
}

export interface PushSubscriptionRow {
  id: number
  endpoint: string
  p256dh: string
  auth: string
  ua: string | null
  vapidPublic: string
  createdAt: number
  lastOkAt: number | null
  failures: number
  disabledAt: number | null
}

interface PushRow {
  id: number
  endpoint: string
  p256dh: string
  auth: string
  ua: string | null
  vapid_public: string
  created_at: number
  last_ok_at: number | null
  failures: number
  disabled_at: number | null
}

function toSubscription(row: PushRow): PushSubscriptionRow {
  return {
    id: row.id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    ua: row.ua,
    vapidPublic: row.vapid_public,
    createdAt: row.created_at,
    lastOkAt: row.last_ok_at,
    failures: row.failures,
    disabledAt: row.disabled_at,
  }
}

export interface NewSubscription {
  endpoint: string
  p256dh: string
  auth: string
  ua: string | null
  vapidPublic: string
}

export class PushSubscriptionStore {
  constructor(private readonly db: DB) {}

  /**
   * Records a subscription, or refreshes one that already exists.
   *
   * An upsert rather than an insert because the same browser re-subscribes
   * routinely — a service worker update, a cleared cache — and always with the
   * same endpoint. Treating that as a conflict would either fail the request or
   * leave a row disabled by an earlier round of failures permanently dead.
   */
  save(input: NewSubscription): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, ua, vapid_public, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           ua = excluded.ua,
           vapid_public = excluded.vapid_public,
           failures = 0,
           disabled_at = NULL`,
      )
      .run(input.endpoint, input.p256dh, input.auth, input.ua, input.vapidPublic, Date.now())
  }

  /** Deliverable subscriptions only. */
  listLive(): PushSubscriptionRow[] {
    const rows = this.db
      .prepare('SELECT * FROM push_subscriptions WHERE disabled_at IS NULL')
      .all() as PushRow[]
    return rows.map(toSubscription)
  }

  countLive(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE disabled_at IS NULL')
      .get() as { n: number } | undefined
    return row?.n ?? 0
  }

  /** Returns rows removed — 0 means the endpoint was not known. */
  remove(endpoint: string): number {
    return this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes
  }

  /**
   * Drops subscriptions created against a different VAPID key.
   *
   * A push subscription is bound to the sender's key pair; after a rotation
   * every stored row is undeliverable and the push service answers 403 for
   * reasons that look like a bug from the outside. Deleting them makes the
   * client re-subscribe against the current key, which is the only fix.
   */
  removeForOtherKey(vapidPublic: string): number {
    return this.db
      .prepare('DELETE FROM push_subscriptions WHERE vapid_public <> ?')
      .run(vapidPublic).changes
  }

  recordSuccess(endpoint: string): void {
    this.db
      .prepare('UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE endpoint = ?')
      .run(Date.now(), endpoint)
  }

  recordFailure(endpoint: string): void {
    this.db
      .prepare(
        `UPDATE push_subscriptions
            SET failures = failures + 1,
                disabled_at = CASE WHEN failures + 1 >= ? THEN ? ELSE disabled_at END
          WHERE endpoint = ?`,
      )
      .run(PUSH_FAILURE_LIMIT, Date.now(), endpoint)
  }
}
