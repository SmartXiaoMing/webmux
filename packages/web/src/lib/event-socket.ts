import { EVENTS_WS_PATH, type NotifyClientMessage, type NotifyServerMessage } from '@webmux/shared'

export type EventSocketStatus =
  /** Never connected yet, or waiting out a reconnect delay. */
  | 'connecting'
  /** Greeted; the backlog has been delivered. */
  | 'ready'
  /** The browser says there is no network. */
  | 'offline'

export interface EventSocketHandlers {
  onMessage(message: NotifyServerMessage): void
  onStatus(status: EventSocketStatus): void
}

const BASE_RECONNECT_MS = 1_000
const MAX_RECONNECT_MS = 30_000

/**
 * The notification stream.
 *
 * Much simpler than `TerminalSocket` next door, and deliberately not sharing
 * code with it. That one exists to make a byte stream survive a reconnect
 * without a visible repaint — sequence numbers, ring-buffer replay, snapshot
 * resync, held keystrokes. This one carries JSON events whose entire recovery
 * story is "ask for everything since id N", so the two have nothing to say to
 * each other, and folding them together would mean making the terminal's
 * carefully-tuned machinery conditional on which mode it was in.
 */
export class EventSocket {
  private ws: WebSocket | null = null
  private disposed = false
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly handlers: EventSocketHandlers,
    /**
     * The highest id already seen, read at connect time rather than captured,
     * so a reconnect asks for exactly what was missed while it was away.
     */
    private readonly cursor: () => number | undefined,
  ) {}

  private send(message: NotifyClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message))
  }

  connect(): void {
    if (this.disposed) return
    this.clearTimer()

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    let socket: WebSocket
    try {
      socket = new WebSocket(`${scheme}://${location.host}${EVENTS_WS_PATH}`)
    } catch {
      this.scheduleReconnect()
      return
    }

    this.ws = socket
    this.handlers.onStatus('connecting')

    socket.onopen = () => {
      this.attempt = 0
      const since = this.cursor()
      this.send(since !== undefined ? { t: 'hello', since } : { t: 'hello' })
    }

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      let message: NotifyServerMessage
      try {
        message = JSON.parse(event.data) as NotifyServerMessage
      } catch {
        return
      }

      if (message.t === 'ping') {
        this.send({ t: 'pong' })
        return
      }
      this.handlers.onMessage(message)
    }

    socket.onclose = () => {
      this.ws = null
      if (this.disposed) return
      // No branch for an expired session. An unauthenticated upgrade is refused
      // with an HTTP 401, and the browser reports every failed handshake as
      // 1006 without the status code — so this cannot tell the two apart. The
      // session poll does, and it signs the tab out; until then, retrying is
      // the right thing to do anyway.
      this.scheduleReconnect()
    }

    socket.onerror = () => {
      // `onclose` follows and carries the code, so recovery lives there.
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.timer !== null) return

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      // A browser that knows it is offline does not need to be told; the
      // `online` listener below is what brings this back.
      this.handlers.onStatus('offline')
      return
    }

    const delay = Math.min(BASE_RECONNECT_MS * 1.7 ** this.attempt, MAX_RECONNECT_MS)
    this.attempt += 1
    // Jitter, so every tab of every device does not reconnect in lockstep
    // after a restart.
    const jittered = delay * (0.85 + Math.random() * 0.3)

    this.handlers.onStatus('connecting')
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, jittered)
  }

  /** Called by the owner when the browser regains connectivity. */
  retryNow(): void {
    if (this.disposed) return
    this.clearTimer()
    this.attempt = 0
    if (this.ws === null) this.connect()
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
    const socket = this.ws
    this.ws = null
    try {
      socket?.close(1000, 'client closed')
    } catch {
      // Already closing.
    }
  }
}
