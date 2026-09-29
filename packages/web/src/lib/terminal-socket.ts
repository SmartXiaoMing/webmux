import { WS_CLOSE, WS_PATH, type ClientMessage, type ServerMessage } from '@webmux/shared'

export type SocketStatus =
  /** Never connected yet. */
  | 'idle'
  /** Opening a socket, or waiting out a reconnect backoff. */
  | 'connecting'
  /** Socket is up; the server is sending a snapshot or replay. */
  | 'syncing'
  /** Caught up and live. */
  | 'ready'
  /** Terminated for good — auth failure, or the session is gone. */
  | 'closed'

export interface TerminalSocketHandlers {
  /** Raw output bytes, in stream order. */
  onData(chunk: Uint8Array): void
  /** The screen is about to be replaced wholesale; reset before the next data. */
  onReset(): void
  onStatus(status: SocketStatus, detail?: string): void
  onExit(code: number): void
  onTitle(title: string): void
  /** Fatal — reconnecting will not help. */
  onFatal(message: string): void
}

const BASE_RECONNECT_MS = 500
const MAX_RECONNECT_MS = 15_000

/**
 * Bounds on keystrokes held while the socket cannot carry them.
 *
 * Output has a ring buffer and a replay protocol so a reconnect loses nothing.
 * Input had no such thing: `send` dropped whatever was typed while the socket
 * was down, and a dropped Backspace with the characters around it still
 * delivered turns "fix a typo" into a different command.
 *
 * The queue is all-or-nothing — expiring or overflowing discards the *whole*
 * thing rather than the oldest entries, because a prefix is not a smaller
 * version of what was typed: dropping `rm -rf ` and delivering `/tmp/x` runs a
 * command the user never wrote. An outage that outlasts the TTL therefore
 * loses the keystrokes outright, exactly as it did before this existed, but it
 * can no longer lose *part* of a command.
 */
const MAX_PENDING_INPUT_BYTES = 64 * 1024
const PENDING_INPUT_MAX_AGE_MS = 5_000

const textEncoder = new TextEncoder()

/**
 * Delay after a `TOO_SLOW` close, which skips the backoff but must not skip the
 * wait entirely.
 *
 * A session producing output faster than this client drains it would otherwise
 * cycle with no delay at all — attach, resync (a full screen serialisation),
 * get dropped for backlog, reattach — pinning a core at both ends for as long
 * as the runaway command runs. A short floor breaks the cycle while still
 * feeling immediate for the ordinary case, where the server was merely
 * momentarily ahead.
 */
const TOO_SLOW_RECONNECT_MS = 1500

/**
 * Terminal transport with automatic reconnection.
 *
 * The reconnect logic hinges on one number: the stream offset this client has
 * rendered. Reporting it back lets the server send only the bytes missed while
 * disconnected, so a brief network blip is invisible rather than a repaint.
 *
 * The offset is only ever advanced from a `synced` frame — the server sends
 * that *after* the replay or snapshot bytes, so the client never claims to
 * have data it has not actually received. Counting bytes locally between syncs
 * keeps the figure exact during live streaming.
 */
export class TerminalSocket {
  private ws: WebSocket | null = null
  private disposed = false
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  private syncedSeq = 0
  private bytesSinceSync = 0
  private hasSynced = false

  private cols = 80
  private rows = 24

  /**
   * True once the server has acknowledged the attach. Deliberately not "the
   * socket is open": the server accepts an `attach` frame, then resolves a
   * resize and only then starts (or finds) the pty, so input sent in between
   * arrives before there is anything to write it to.
   */
  private ready = false

  private pendingInput: Array<{ data: string; at: number }> = []
  private pendingInputBytes = 0

  constructor(
    private readonly sessionId: string,
    private readonly handlers: TerminalSocketHandlers,
    /** Injectable so tests can drive the staleness window without sleeping. */
    private readonly now: () => number = Date.now,
  ) {}

  /** Current consumed offset, or undefined if nothing has been synced yet. */
  private get lastSeq(): number | undefined {
    return this.hasSynced ? this.syncedSeq + this.bytesSinceSync : undefined
  }

  connect(): void {
    if (this.disposed) return
    this.clearTimer()

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${scheme}://${location.host}${WS_PATH}`

    this.handlers.onStatus('connecting', this.attempt === 0 ? '正在连接…' : '正在重连…')

    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      this.scheduleReconnect()
      return
    }
    socket.binaryType = 'arraybuffer'
    this.ws = socket

    socket.onopen = () => {
      this.attempt = 0
      const attach: ClientMessage = {
        t: 'attach',
        sessionId: this.sessionId,
        cols: this.cols,
        rows: this.rows,
        ...(this.lastSeq !== undefined ? { lastSeq: this.lastSeq } : {}),
      }
      this.handlers.onStatus('syncing', '正在同步…')
      socket.send(JSON.stringify(attach))
    }

    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        this.handleControl(JSON.parse(event.data) as ServerMessage)
        return
      }
      const chunk = new Uint8Array(event.data as ArrayBuffer)
      // Bytes delivered after `synced` are live output, so they extend the
      // offset. Snapshot and replay bytes are already covered by the offset
      // the server reported in `synced`.
      if (this.hasSynced) this.bytesSinceSync += chunk.byteLength
      this.handlers.onData(chunk)
    }

    socket.onclose = (event) => {
      this.ws = null
      this.ready = false
      if (this.disposed) return

      // No branch for "the session expired": an unauthenticated upgrade is
      // refused with an HTTP 401, and the browser reports every failed
      // handshake as 1006 without the status code. That case is caught by the
      // session-list poll, which gets its own 401 and signs the user out — so
      // reconnecting here is harmless, just redundant for a few seconds.

      if (event.code === WS_CLOSE.NORMAL) {
        this.handlers.onStatus('closed')
        return
      }
      // A slow-client disconnect is the server protecting itself, and the
      // backlog is already gone — so reset the backoff rather than growing it.
      // Not to zero, though; see TOO_SLOW_RECONNECT_MS.
      if (event.code === WS_CLOSE.TOO_SLOW) {
        this.handlers.onStatus('connecting', '输出过快，正在重新同步…')
        this.attempt = 0
        this.scheduleReconnect(TOO_SLOW_RECONNECT_MS)
        return
      }

      this.scheduleReconnect()
    }

    socket.onerror = () => {
      // `onclose` follows and carries the code, so recovery is handled there.
    }
  }

  private handleControl(msg: ServerMessage): void {
    switch (msg.t) {
      case 'attached':
        // The server is now writing to a pty, so held keystrokes have
        // somewhere to go. Flushing here rather than on `open` is what keeps
        // them in order: a key typed between `open` and `attached` would
        // otherwise overtake everything queued while the socket was down.
        this.ready = true
        this.flushPendingInput()
        break

      case 'resync':
        // The snapshot reproduces the whole screen, so whatever is on screen
        // now is about to be replaced rather than appended to.
        this.handlers.onReset()
        break

      case 'synced':
        this.syncedSeq = msg.seq
        this.bytesSinceSync = 0
        this.hasSynced = true
        this.handlers.onStatus('ready')
        break

      case 'title':
        this.handlers.onTitle(msg.title)
        break

      case 'exit':
        this.handlers.onExit(msg.code)
        break

      case 'error':
        // A missing session is terminal; anything else is worth a retry.
        if (msg.code === 'session_not_found') {
          this.handlers.onStatus('closed', msg.message)
          this.handlers.onFatal(msg.message)
        }
        break

      case 'ping':
        this.send({ t: 'pong' })
        break

      case 'replay':
      case 'pong':
        break
    }
  }

  private scheduleReconnect(overrideDelay?: number): void {
    if (this.disposed) return
    if (this.reconnectTimer !== null) return

    const delay =
      overrideDelay ?? Math.min(BASE_RECONNECT_MS * 1.7 ** this.attempt, MAX_RECONNECT_MS)
    this.attempt += 1

    // Jitter keeps a fleet of tabs from reconnecting in lockstep after a
    // server restart.
    const jittered = delay * (0.85 + Math.random() * 0.3)
    this.handlers.onStatus('connecting', `连接中断，${Math.ceil(jittered / 1000)} 秒后重连…`)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, jittered)
  }

  private clearTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  /**
   * Delivers a keystroke, holding it if the socket cannot carry it yet.
   *
   * The `pendingInput.length === 0` clause in the fast path is load-bearing:
   * without it, a key typed after the socket opens but before `attached`
   * would be sent immediately and overtake keys still queued from the outage.
   */
  write(data: string): void {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN && this.pendingInput.length === 0) {
      this.send({ t: 'input', data })
      return
    }
    this.enqueueInput(data)
  }

  private enqueueInput(data: string): void {
    if (this.disposed) return
    this.pendingInput.push({ data, at: this.now() })
    this.pendingInputBytes += textEncoder.encode(data).byteLength
    if (this.pendingInputBytes > MAX_PENDING_INPUT_BYTES) this.clearPendingInput()
  }

  private flushPendingInput(): void {
    if (this.pendingInput.length === 0) return
    const oldest = this.pendingInput[0]
    if (oldest !== undefined && this.now() - oldest.at > PENDING_INPUT_MAX_AGE_MS) {
      this.clearPendingInput()
      return
    }
    const queued = this.pendingInput
    this.pendingInput = []
    this.pendingInputBytes = 0
    for (const item of queued) this.send({ t: 'input', data: item.data })
  }

  private clearPendingInput(): void {
    this.pendingInput = []
    this.pendingInputBytes = 0
  }

  /**
   * Resizes both the viewport and the remote PTY. Sent even while
   * disconnected — the dimensions are remembered and applied on attach, so a
   * phone rotated during an outage comes back at the right size.
   */
  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    this.send({ t: 'resize', cols, rows })
  }

  dispose(): void {
    this.disposed = true
    // A deliberate close must not deliver keystrokes the user typed into a
    // terminal they were leaving.
    this.clearPendingInput()
    this.clearTimer()
    const socket = this.ws
    this.ws = null
    // 1000 tells the server this is deliberate, so it does not treat the
    // disconnect as a fault.
    socket?.close(WS_CLOSE.NORMAL, 'client closed')
  }
}
