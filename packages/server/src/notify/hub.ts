import type { NotificationRecord, NotifyLevel, NotifyServerMessage } from '@webmux/shared'
import type { NotifyConfig } from '../config'
import { logger } from '../logger'
import { cleanBody, cleanTitle } from './text'
import type { NewSubscription, NotificationStore } from './store'

const log = logger.child('notify')

/** How often expired notifications are swept. */
const SWEEP_INTERVAL_MS = 3_600_000

/**
 * How long a graceful shutdown waits for deliveries already in flight.
 *
 * Bounded on purpose: an unresponsive push service must not be able to hold
 * the shutdown open, and the alternative — the database closing underneath a
 * delivery that then tries to write to it — is worse than dropping the last
 * message of the session.
 */
const SHUTDOWN_GRACE_MS = 5_000

export interface PublishInput {
  title: string
  body?: string | undefined
  level: NotifyLevel
  sessionId?: string | undefined
  source?: string | undefined
  tag?: string | undefined
}

export type PublishOutcome =
  | { ok: true; notification: NotificationRecord }
  | { ok: false; reason: 'rate_limited' | 'internal' }

/** What the hub needs from a push transport; implemented in `webpush.ts`. */
export interface PushSender {
  send(notification: NotificationRecord, unread: number, tag: string | undefined): Promise<void>
}

/**
 * What the HTTP layer needs from the same transport, plus the parts the hub
 * never touches. Declared here so the routes can be written and exercised
 * before the encryption exists, and so the two consumers of a push service
 * agree on one shape.
 */
export interface PushService extends PushSender {
  /** base64url of the uncompressed P-256 point, for `applicationServerKey`. */
  readonly publicKey: string
  count(): number
  /**
   * Validates and stores a subscription, or throws with a message fit to
   * return to the caller — a malformed key or an endpoint that is not https is
   * the client's mistake, not an internal error.
   */
  subscribe(input: Omit<NewSubscription, 'vapidPublic'>): void
  unsubscribe(endpoint: string): number
}

/** Receives every message the hub would put on the event channel. */
export type NotifySubscriber = (message: NotifyServerMessage) => void

/**
 * The one place a notification goes in and every delivery path comes out.
 *
 * Its contract with callers is that `publish` does not throw and does not
 * wait on the network. Both matter because the caller is an HTTP request from
 * a shell script: it should fail for exactly one reason — the rate limit — and
 * it should return as soon as the notification is durable, not when Google's
 * push service has acknowledged it.
 */
export class NotificationHub {
  private readonly subscribers = new Set<NotifySubscriber>()
  /**
   * Recent publish timestamps, newest last. A sliding window rather than a
   * counter reset on a timer, so a burst cannot land entirely on one side of a
   * boundary and get through at twice the configured rate.
   */
  private recent: number[] = []
  private readonly inFlight = new Set<Promise<void>>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(
    private readonly store: NotificationStore,
    private readonly config: NotifyConfig,
    private readonly push: PushSender | null,
    /** Injectable so tests can exercise the give-up path without waiting it out. */
    private readonly shutdownGraceMs: number = SHUTDOWN_GRACE_MS,
  ) {}

  /**
   * Records a hit, or reports that the window is full.
   *
   * A refused call is deliberately *not* counted: a caller retrying after a
   * `429` would otherwise extend its own ban, and the window would never
   * drain as long as it kept trying.
   */
  private tryConsume(now: number): boolean {
    if (this.config.perMinute <= 0) return true

    const cutoff = now - 60_000
    this.recent = this.recent.filter((at) => at > cutoff)
    if (this.recent.length >= this.config.perMinute) return false

    this.recent.push(now)
    return true
  }

  publish(input: PublishInput): PublishOutcome {
    if (this.closed) return { ok: false, reason: 'internal' }
    if (!this.tryConsume(Date.now())) return { ok: false, reason: 'rate_limited' }

    let notification: NotificationRecord
    try {
      notification = this.store.insert({
        title: cleanTitle(input.title),
        body: cleanBody(input.body),
        level: input.level,
        sessionId: input.sessionId ?? null,
        source: input.source ?? null,
      })
    } catch (err) {
      log.error('failed to record notification', err)
      return { ok: false, reason: 'internal' }
    }

    // Counted once and shared by both deliveries, so the badge a browser shows
    // and the number in the push payload cannot disagree.
    const unread = this.store.unreadCount()
    this.fanOut({ t: 'notify', items: [notification], unread })
    this.queuePush(notification, input.tag, unread)
    return { ok: true, notification }
  }

  addSubscriber(subscriber: NotifySubscriber): () => void {
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  /** Read-state moved (possibly in another tab); tell everyone else. */
  broadcastRead(upTo: number, unread: number): void {
    this.fanOut({ t: 'read', upTo, unread })
  }

  /**
   * A subscriber that throws must not take the fan-out — or the request that
   * triggered it — down with it. A dead socket is ordinary here: the browser
   * may have gone away between the event and the write.
   */
  private fanOut(message: NotifyServerMessage): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(message)
      } catch (err) {
        log.debug(`subscriber threw: ${(err as Error).message}`)
      }
    }
  }

  /**
   * Hands a delivery to the push transport, tracked so shutdown can wait for
   * it. Nothing here may reject: an unhandled rejection is fatal to the
   * process on Node 22, and a push service being unreachable is routine.
   */
  private queuePush(notification: NotificationRecord, tag: string | undefined, unread: number): void {
    if (this.push === null) return

    const task = this.push
      .send(notification, unread, tag)
      .catch((err: unknown) => {
        log.warn(`push delivery failed: ${(err as Error).message}`)
      })
      .finally(() => {
        this.inFlight.delete(task)
      })
    this.inFlight.add(task)
  }

  /** Sweeps once now, then hourly. Idempotent, so boot can call it directly. */
  startMaintenance(): void {
    this.sweep()
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    this.sweepTimer.unref?.()
  }

  private sweep(): void {
    try {
      const removed = this.store.sweep(this.config.retentionDays, this.config.maxStored)
      if (removed > 0) log.debug(`swept ${removed} expired notification(s)`)
    } catch (err) {
      log.warn(`notification sweep failed: ${(err as Error).message}`)
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer)
    this.subscribers.clear()
    if (this.inFlight.size === 0) return

    let timer: ReturnType<typeof setTimeout> | null = null
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.shutdownGraceMs)
      timer.unref?.()
    })
    await Promise.race([Promise.allSettled([...this.inFlight]), grace])
    if (timer !== null) clearTimeout(timer)
  }
}
