import { useSyncExternalStore } from 'react'
import type { NotificationRecord, NotifyServerMessage } from '@webmux/shared'
import { api } from './api'
import { EventSocket, type EventSocketStatus } from './event-socket'

/**
 * Where the reconnect cursor lives.
 *
 * Per browser, not per user: it describes what this tab has *rendered*, and a
 * different browser legitimately starts from scratch. localStorage rather than
 * memory so that a reload does not replay the last fifty notifications as if
 * they were new.
 */
const CURSOR_KEY = 'webmux.notify.cursor'

/** How long an on-screen toast stays before it fades on its own. */
const TOAST_TTL_MS = 6_000

/** Past three at once, they stop being information and become a wall. */
const MAX_TOASTS = 3

/** How many notifications the panel keeps in memory. */
const MAX_ITEMS = 100

export interface NotificationsSnapshot {
  items: NotificationRecord[]
  /** Currently on screen, newest last. */
  toasts: NotificationRecord[]
  unread: number
  status: EventSocketStatus
  /** Highest id this browser has seen — what it reports back on reconnect. */
  latestId: number
  /**
   * Whether this deployment offers notifications at all. False hides the bell
   * rather than showing one whose panel suggests a command that now 404s.
   */
  available: boolean
}

function readCursor(): number | undefined {
  try {
    const raw = window.localStorage.getItem(CURSOR_KEY)
    if (raw === null) return undefined
    const value = Number(raw)
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  } catch {
    // Storage can be unavailable (private mode, a locked-down policy). Not
    // being able to remember the cursor costs a replay, not correctness.
    return undefined
  }
}

function writeCursor(id: number): void {
  try {
    window.localStorage.setItem(CURSOR_KEY, String(id))
  } catch {
    // As above.
  }
}

class NotificationsStore {
  private items: NotificationRecord[] = []
  private toasts: NotificationRecord[] = []
  private unread = 0
  private status: EventSocketStatus = 'connecting'
  private latestId = 0

  private available = true

  private snapshot: NotificationsSnapshot = {
    items: [],
    toasts: [],
    unread: 0,
    status: 'connecting',
    latestId: 0,
    available: true,
  }

  private readonly listeners = new Set<() => void>()
  private socket: EventSocket | null = null
  /** Guards `start` while its status request is in flight. */
  private started = false
  private readonly toastTimers = new Map<number, number>()

  /**
   * How to select a session on request from outside — the service worker, on a
   * notification click. Registered by the workspace, because selecting a
   * session means changing view state that only the workspace owns.
   */
  private sessionOpener: ((sessionId: string) => void) | null = null

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): NotificationsSnapshot => this.snapshot

  private emit(): void {
    this.snapshot = {
      items: this.items,
      toasts: this.toasts,
      unread: this.unread,
      status: this.status,
      latestId: this.latestId,
      available: this.available,
    }
    for (const listener of this.listeners) listener()
    this.applyBadge()
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Opens the stream. Called from the authenticated workspace, never from the
   * app root: before sign-in every connection is refused, and a socket that
   * reconnects forever against a 401 is a console full of noise and a server
   * full of pointless upgrades.
   */
  async start(): Promise<void> {
    if (this.socket !== null || this.started) return
    this.started = true

    // Asked before connecting, because with the feature switched off the
    // server registers no ingress and streams nothing: the client would
    // otherwise hold open a channel for an empty feed, and offer a bell whose
    // empty state tells the user to run a command that 404s.
    try {
      const status = await api.notificationStatus()
      if (!status.enabled) {
        this.available = false
        this.emit()
        return
      }
    } catch {
      // An unreachable server is not evidence that the feature is off. Carry
      // on and let the socket's own retry handle it.
    }

    this.socket = new EventSocket(
      {
        onMessage: (message) => this.receive(message),
        onStatus: (status) => {
          this.status = status
          this.emit()
        },
      },
      () => (this.latestId > 0 ? this.latestId : readCursor()),
    )
    this.socket.connect()

    window.addEventListener('online', this.onOnline)
    document.addEventListener('visibilitychange', this.onVisibility)
    navigator.serviceWorker?.addEventListener('message', this.onServiceWorkerMessage)

    // Explicit test hook, in the same spirit as `window.__webmuxStatus` in
    // TerminalView. A function rather than a value, because a snapshot copied
    // at mount would be stale by the time anything looked at it. The suite
    // needs this to wait for the channel to be ready before publishing: a
    // notification that arrives before the handshake is completed is filed as
    // history, so an assertion that raced it would fail for the right reason
    // and look like the wrong one.
    ;(window as unknown as Record<string, unknown>).__webmuxNotifications = (): unknown => this.getSnapshot()
  }

  /** Registered by the workspace; see `sessionOpener`. */
  setSessionOpener(opener: ((sessionId: string) => void) | null): void {
    this.sessionOpener = opener
  }

  private readonly onServiceWorkerMessage = (event: MessageEvent): void => {
    const data = event.data as { t?: string; sessionId?: string | null } | null
    // Only ever from our own worker — this listener is on the page's own
    // ServiceWorkerContainer, so there is no cross-origin path to it.
    if (data?.t === 'open-session' && typeof data.sessionId === 'string') {
      this.sessionOpener?.(data.sessionId)
    }
  }

  stop(): void {
    this.socket?.dispose()
    this.socket = null
    this.started = false
    window.removeEventListener('online', this.onOnline)
    document.removeEventListener('visibilitychange', this.onVisibility)
    navigator.serviceWorker?.removeEventListener('message', this.onServiceWorkerMessage)
    for (const timer of this.toastTimers.values()) window.clearTimeout(timer)
    this.toastTimers.clear()
  }

  /** Signing out must not leave the next visitor holding a badge for it. */
  reset(): void {
    this.stop()
    this.items = []
    this.toasts = []
    this.unread = 0
    this.latestId = 0
    this.status = 'connecting'
    try {
      window.localStorage.removeItem(CURSOR_KEY)
    } catch {
      // As above.
    }
    this.emit()
  }

  private readonly onOnline = (): void => {
    this.socket?.retryNow()
  }

  private readonly onVisibility = (): void => {
    // Nothing is replayed on becoming visible: a notification that arrived
    // while the tab was hidden has either been shown by the service worker or
    // is waiting in the panel. Popping it now would announce it twice.
    this.applyBadge()
  }

  // -------------------------------------------------------------------------
  // Incoming
  // -------------------------------------------------------------------------

  private receive(message: NotifyServerMessage): void {
    switch (message.t) {
      case 'ready': {
        this.status = 'ready'
        this.unread = message.unread
        // The batch was capped (or history was pruned), so the channel will
        // never carry the notifications in between: the cursor has to move
        // past them or every reconnect would re-fetch the same window. The
        // list is completed from REST instead, which is the path that has no
        // such limit.
        if (message.truncated) void this.refresh().catch(() => undefined)
        // A cursor above the newest id means this browser's history does not
        // belong to this database — restored from a backup, a rebuilt data
        // directory. Adopt the server's, or every notification from here on
        // would look like one we had already seen.
        if (message.latestId < this.latestId) {
          this.latestId = message.latestId
          writeCursor(this.latestId)
        }
        this.emit()
        return
      }

      case 'notify': {
        this.unread = message.unread
        this.merge(message.items, message.catchUp === true)
        return
      }

      case 'read': {
        this.unread = message.unread
        this.items = this.items.map((item) => (item.id <= message.upTo ? { ...item, read: true } : item))
        this.emit()
        return
      }

      default:
        // ping/pong are handled by the socket itself; an error frame is a
        // protocol mistake on our side and not worth a user-visible message.
        return
    }
  }

  private merge(incoming: NotificationRecord[], catchUp: boolean): void {
    const known = new Set(this.items.map((item) => item.id))
    const fresh = incoming.filter((item) => !known.has(item.id))
    if (fresh.length === 0) return

    const highest = fresh.reduce((max, item) => Math.max(max, item.id), this.latestId)
    if (highest > this.latestId) {
      this.latestId = highest
      writeCursor(highest)
    }

    this.items = [...fresh, ...this.items]
      .sort((a, b) => b.id - a.id)
      .slice(0, MAX_ITEMS)

    if (!catchUp) {
      // Only what arrives live is announced. The catch-up batch updates the
      // list and the badge, which is the honest summary of "you were away".
      for (const item of fresh) this.announce(item)
    }
    this.emit()
  }

  // -------------------------------------------------------------------------
  // Announcing
  // -------------------------------------------------------------------------

  private announce(item: NotificationRecord): void {
    if (document.visibilityState === 'visible') {
      this.toasts = [...this.toasts, item].slice(-MAX_TOASTS)
      const timer = window.setTimeout(() => this.dismissToast(item.id), TOAST_TTL_MS)
      this.toastTimers.set(item.id, timer)
      return
    }
    void this.showSystemNotification(item)
  }

  /**
   * The OS-level notification, raised from the page.
   *
   * `registration.showNotification` rather than `new Notification`: the
   * constructor form does not exist on Android Chrome at all, and elsewhere it
   * is tied to the page's lifetime, which is the opposite of what a
   * notification for "your build finished" needs.
   *
   * The tag is shared with the service worker's push handler, so a page-raised
   * notification and the push of the same event replace one another instead of
   * arriving twice — which is exactly what would happen otherwise, since both
   * paths fire for a hidden tab with push enabled.
   *
   * That tag is also what keeps several tabs from stacking up: they all raise
   * the same one, and a replacement with the default `renotify: false` does not
   * alert again. An earlier version elected a single tab with a Web Lock
   * instead, which was worse in a specific way — the elected tab could be the
   * visible one, showing a toast and nothing else, while every hidden tab
   * deferred to it and the user, looking at another application, was told
   * nothing at all.
   */
  private async showSystemNotification(item: NotificationRecord): Promise<void> {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return

    try {
      const registration = await navigator.serviceWorker?.getRegistration()
      if (registration === undefined || registration === null) return
      await registration.showNotification(item.title, {
        body: item.body ?? undefined,
        tag: `webmux-${item.id}`,
        data: { id: item.id, sessionId: item.sessionId, level: item.level },
      })
    } catch {
      // A refused or unsupported notification is not worth surfacing: the
      // panel and the badge still carry the information.
    }
  }

  dismissToast(id: number): void {
    const timer = this.toastTimers.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      this.toastTimers.delete(id)
    }
    const next = this.toasts.filter((toast) => toast.id !== id)
    if (next.length === this.toasts.length) return
    this.toasts = next
    this.emit()
  }

  /**
   * Unread count onto the tab title, and onto the installed app's icon where
   * the browser supports it.
   *
   * `setAppBadge` is reached through a cast because it is not in every version
   * of the DOM lib; feature-detecting the property is more honest than
   * declaring a type for something the runtime may not have.
   */
  private applyBadge(): void {
    document.title = this.unread > 0 ? `(${this.unread}) webmux` : 'webmux'

    const nav = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>
      clearAppBadge?: () => Promise<void>
    }
    try {
      if (this.unread > 0) void nav.setAppBadge?.(this.unread).catch(() => undefined)
      else void nav.clearAppBadge?.().catch(() => undefined)
    } catch {
      // Non-secure contexts and unsupported browsers throw on property access
      // in some versions; the title badge is the fallback.
    }
  }

  // -------------------------------------------------------------------------
  // Outgoing
  // -------------------------------------------------------------------------

  /** Marks everything read, everywhere. */
  async markAllRead(): Promise<void> {
    const result = await api.markNotificationsRead({ all: true })
    this.unread = result.unread
    this.items = this.items.map((item) => ({ ...item, read: true }))
    this.emit()
  }

  /** Marks one notification read — what opening it from the panel does. */
  async markRead(id: number): Promise<void> {
    const target = this.items.find((item) => item.id === id)
    if (target?.read === true) return

    const result = await api.markNotificationsRead({ ids: [id] })
    this.unread = result.unread
    this.items = this.items.map((item) => (item.id === id ? { ...item, read: true } : item))
    this.emit()
  }

  /**
   * Fills the list from the REST snapshot — on opening the panel, and after a
   * truncated catch-up.
   *
   * Deliberately not a plain assignment. A notification can arrive over the
   * event channel while this request is in flight; replacing the list with the
   * older snapshot would drop it, and taking the snapshot's unread count would
   * move the badge backwards — for a notification the user has already been
   * shown a toast about.
   */
  async refresh(): Promise<void> {
    const result = await api.listNotifications({ limit: MAX_ITEMS })

    const merged = new Map<number, NotificationRecord>()
    for (const item of [...result.notifications, ...this.items]) {
      const existing = merged.get(item.id)
      // Read is monotonic — nothing un-reads — so the flag is the one field
      // where either source being newer is informative.
      merged.set(
        item.id,
        existing === undefined ? item : { ...item, read: item.read || existing.read },
      )
    }
    this.items = [...merged.values()].sort((a, b) => b.id - a.id).slice(0, MAX_ITEMS)

    // The snapshot is authoritative about unread *as of when it was taken*;
    // anything newer arrived over the channel and has already been counted.
    if (this.latestId <= result.latestId) this.unread = result.unread

    if (result.latestId > this.latestId) {
      this.latestId = result.latestId
      writeCursor(this.latestId)
    }
    this.emit()
  }

  /** Requests permission from a user gesture, and reports what happened. */
  async requestDesktopPermission(): Promise<NotificationPermission> {
    if (typeof Notification === 'undefined') return 'denied'
    if (Notification.permission !== 'default') return Notification.permission
    return Notification.requestPermission()
  }
}

export const notifications = new NotificationsStore()

/** Subscribes a component to notifications. */
export function useNotifications(): NotificationsSnapshot {
  return useSyncExternalStore(notifications.subscribe, notifications.getSnapshot, notifications.getSnapshot)
}
