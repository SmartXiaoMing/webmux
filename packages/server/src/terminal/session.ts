import headless from '@xterm/headless'
import serializeAddon from '@xterm/addon-serialize'
import type { IPty } from 'node-pty'
import type { ServerMessage, SessionSummary } from '@webmux/shared'
import type { SessionBackend } from './backend'
import { ByteRing } from './ring'
import { logger } from '../logger'

// Both packages ship CommonJS only (their `module` field points at a file that
// was never published), so named imports are unavailable to Node's ESM loader
// and the interop form is required.
const { Terminal } = headless
const { SerializeAddon } = serializeAddon

type HeadlessTerminal = InstanceType<typeof Terminal>
type Serializer = InstanceType<typeof SerializeAddon>

const log = logger.child('session')

/** Pause the PTY when any client is this far behind. */
const HIGH_WATER_BYTES = 4 * 1024 * 1024
/** Resume once every client is back under this. */
const LOW_WATER_BYTES = 1024 * 1024

/**
 * Lines of history included in a resync snapshot. Deliberately smaller than
 * the mirror's scrollback: the snapshot is serialized to an ANSI string and
 * shipped on every cold attach, so this trades a little scrollback depth for a
 * much smaller payload.
 */
const SNAPSHOT_SCROLLBACK_LINES = 3000

/**
 * Ceiling on keystrokes held while the pty is still coming up.
 *
 * `attach` sets `connection.session` on the gateway before `ensureStarted()`
 * has resolved, so input can legitimately arrive while there is no pty to
 * write it to. Dropping it there is how a Backspace disappears while the
 * characters after it still land. The window is bounded by spawning
 * `tmux attach`, so the buffer only ever holds what was typed in that window;
 * the cap is a backstop, and on overflow the whole buffer goes rather than a
 * prefix of it — half a command is worse than none.
 */
const MAX_PENDING_INPUT_BYTES = 256 * 1024

/**
 * A client attached to a session. Deliberately a dumb transport — all protocol
 * state (sequence offsets, sync status) lives in the Session so there is
 * exactly one place that can get the replay/resync bookkeeping wrong.
 */
export interface SessionClient {
  readonly id: string
  /** Bytes queued but not yet flushed to the socket; drives backpressure. */
  readonly bufferedAmount: number
  /** Latched once the transport is gone, and never unset. */
  readonly closed: boolean
  sendControl(msg: ServerMessage): void
  sendData(buf: Buffer): void
  close(code: number, reason: string): void
}

export interface SessionOptions {
  id: string
  title: string
  cwd: string
  cols: number
  rows: number
  scrollbackLines: number
  ringBufferBytes: number
  /**
   * Set once, at creation: which session this one was opened from. Null means
   * it stands on its own.
   */
  parentId: string | null
}

export interface SessionExit {
  code: number
  signal?: number
}

/**
 * A single persistent shell.
 *
 * Three things are kept in lockstep, and the invariant that ties them together
 * is `seq` — the number of bytes the session has ever produced:
 *
 *   pty  ->  ring buffer (tail of the stream, for gap replay)
 *        ->  headless mirror (full screen + scrollback, for resync snapshots)
 *        ->  attached clients
 *
 * The pty is attached for the *lifetime of the session*, not the lifetime of a
 * browser connection. That is what keeps the mirror warm: a client attaching
 * after six hours away gets a snapshot of a terminal that never stopped being
 * updated, rather than a blank screen and whatever tmux chooses to repaint.
 */
export class Session {
  readonly id: string
  /** Immutable after construction — see the field on SessionOptions. */
  readonly parentId: string | null
  private title: string
  private cwd: string
  /**
   * The shell's own directory, which drifts away from `cwd` as the user `cd`s.
   * Maintained by the registry's refresh, never by this class.
   */
  private liveCwd: string
  private cols: number
  private rows: number

  private pty: IPty | null = null
  private starting: Promise<void> | null = null
  private disposed = false

  /** Keystrokes that arrived before the pty existed; flushed in `start()`. */
  private pendingInput: string[] = []
  private pendingInputBytes = 0

  private readonly mirror: HeadlessTerminal
  private readonly serializer: Serializer
  private readonly ring: ByteRing
  private readonly clients = new Set<SessionClient>()
  /** Clients currently receiving a snapshot; live output is withheld from them. */
  private readonly syncing = new Set<SessionClient>()

  private seq = 0
  private paused = false
  private exit: SessionExit | null = null
  private createdAt = Date.now()
  private lastAttachedAt = Date.now()

  /** Outstanding writes handed to the mirror, for the resync flush barrier. */
  private pendingWrites = 0
  private writeWaiters: Array<() => void> = []

  constructor(
    private readonly backend: SessionBackend,
    private readonly opts: SessionOptions,
    private readonly onExit: (session: Session, info: SessionExit) => void,
  ) {
    this.id = opts.id
    this.parentId = opts.parentId
    this.title = opts.title
    this.cwd = opts.cwd
    // Seeded from the creation directory rather than left empty: both paths
    // into this class (create and adopt) know where the pane starts, so there
    // is no window at boot where the sidebar has nothing to show.
    this.liveCwd = opts.cwd
    this.cols = opts.cols
    this.rows = opts.rows

    this.mirror = new Terminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: opts.scrollbackLines,
      // The serialize addon reads through the public buffer API, which is
      // gated behind this flag.
      allowProposedApi: true,
    })
    this.serializer = new SerializeAddon()
    this.mirror.loadAddon(this.serializer)
    this.ring = new ByteRing(opts.ringBufferBytes)
  }

  get clientCount(): number {
    return this.clients.size
  }

  get isRunning(): boolean {
    return this.exit === null && !this.disposed
  }

  get currentSeq(): number {
    return this.seq
  }

  toSummary(): SessionSummary {
    return {
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      liveCwd: this.liveCwd,
      parentId: this.parentId,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      running: this.isRunning,
      clients: this.clients.size,
      lastAttachedAt: this.lastAttachedAt,
    }
  }

  get createdAtMs(): number {
    return this.createdAt
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Creates the backing session if needed and attaches a client pty. Memoized
   * so concurrent attaches cannot race into two ptys for one session.
   */
  ensureStarted(): Promise<void> {
    this.starting ??= this.start().catch((err: unknown) => {
      this.starting = null
      throw err
    })
    return this.starting
  }

  private async start(): Promise<void> {
    if (this.disposed) throw new Error(`session ${this.id} is disposed`)

    await this.backend.create({
      id: this.id,
      cwd: this.cwd,
      title: this.title,
      cols: this.cols,
      rows: this.rows,
      parentId: this.parentId,
    })

    const { pty } = await this.backend.attach(this.id, this.cols, this.rows)
    if (this.disposed) {
      pty.kill()
      throw new Error(`session ${this.id} was disposed during startup`)
    }
    this.pty = pty

    pty.onData((chunk) => this.handleData(chunk))
    pty.onExit(({ exitCode, signal }) => this.handleExit(exitCode, signal))

    // After the handlers are wired, so the shell's echo of these keystrokes is
    // captured like any other output.
    this.flushPendingInput()

    log.info(`session ${this.id} attached (${this.cols}x${this.rows})`)
  }

  private handleData(chunk: string): void {
    if (this.disposed) return

    // node-pty hands us strings: its socket uses setEncoding('utf8'), so
    // Node's StringDecoder has already reassembled characters split across
    // read() boundaries. Re-encoding to bytes here is lossless for text and
    // keeps the wire format binary, which matters because re-decoding on each
    // side is exactly how terminal streams get corrupted.
    const buf = Buffer.from(chunk, 'utf8')
    if (buf.length === 0) return

    this.ring.push(buf)
    this.writeMirror(buf)
    this.seq += buf.length

    for (const client of this.clients) {
      if (!this.syncing.has(client)) client.sendData(buf)
    }
    this.applyBackpressure()
  }

  private handleExit(code: number, signal?: number): void {
    // Killing the attached pty is how this class *detaches* — the tmux client
    // exits while its session keeps running. Without this guard, every
    // deliberate teardown would be misread as the shell having exited.
    if (this.disposed) return

    this.exit = { code, ...(signal !== undefined ? { signal } : {}) }
    log.info(`session ${this.id} pty exited code=${code} signal=${signal ?? '-'}`)

    for (const client of this.clients) {
      client.sendControl({ t: 'exit', code, ...(signal !== undefined ? { signal } : {}) })
    }
    this.onExit(this, this.exit)
  }

  /**
   * Detaches the client pty but leaves the backing session running — the whole
   * point of the backend abstraction. Called on webmux shutdown.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clients.clear()
    this.syncing.clear()

    // Release anyone waiting on a mirror flush. A resync parked on
    // `flushMirror()` would otherwise stay pending forever — nothing else ever
    // resolves these, and the `finally` that closes the resync out would never
    // run.
    for (const resolve of this.writeWaiters) resolve()
    this.writeWaiters = []

    // Nothing will ever flush these now, and they are the user's keystrokes.
    this.clearPendingInput()

    try {
      this.pty?.kill()
    } catch {
      // Already dead.
    }
    this.pty = null
    try {
      this.mirror.dispose()
    } catch {
      // Mirror disposal is best-effort; nothing depends on it after this point.
    }
  }

  // -------------------------------------------------------------------------
  // Mirror bookkeeping
  // -------------------------------------------------------------------------

  private writeMirror(buf: Buffer): void {
    this.pendingWrites += 1
    this.mirror.write(buf, () => {
      this.pendingWrites -= 1
      if (this.pendingWrites === 0) {
        const waiters = this.writeWaiters
        this.writeWaiters = []
        for (const resolve of waiters) resolve()
      }
    })
  }

  /**
   * Resolves once the mirror has digested everything written so far.
   *
   * Tracking outstanding writes ourselves rather than writing an empty string
   * with a callback is deliberate: xterm short-circuits zero-length writes
   * into a microtask, which would return before the real queue had drained.
   */
  private flushMirror(): Promise<void> {
    if (this.pendingWrites === 0) return Promise.resolve()
    return new Promise((resolve) => this.writeWaiters.push(resolve))
  }

  // -------------------------------------------------------------------------
  // Client attach / detach
  // -------------------------------------------------------------------------

  async attachClient(client: SessionClient, lastSeq?: number): Promise<void> {
    await this.ensureStarted()

    if (this.disposed) {
      client.close(1000, 'session disposed')
      return
    }

    // The socket can die during the await above — `ensureStarted` may spawn a
    // tmux client, which is not instant. The gateway's close handler runs
    // `detachClient` the moment that happens, and against a client that is not
    // in the set yet that is a no-op; registering it now would leave it there
    // for the lifetime of the session, and the resync below would serialize a
    // whole screen for a socket nobody is listening on.
    if (client.closed) return

    this.clients.add(client)
    this.syncing.delete(client)
    this.lastAttachedAt = Date.now()

    client.sendControl({
      t: 'attached',
      sessionId: this.id,
      seq: this.seq,
      cols: this.cols,
      rows: this.rows,
    })

    // Fast path: the gap is still buffered, so the client can splice it in with
    // no repaint. Ring read and send happen in one synchronous block — Node
    // cannot interleave new output between them, so there is no window in which
    // bytes could be delivered twice or skipped.
    //
    // The client derives its new offset from `replay.toSeq`, not from
    // `attached.seq` (which reports the server's current offset and would
    // double-count the replayed bytes).
    if (lastSeq !== undefined) {
      const missed = this.ring.since(lastSeq)
      if (missed !== null) {
        client.sendControl({ t: 'replay', fromSeq: lastSeq, toSeq: lastSeq + missed.length })
        if (missed.length > 0) client.sendData(missed)
        client.sendControl({ t: 'synced', seq: lastSeq + missed.length })
        return
      }
      log.debug(`session ${this.id}: client ${client.id} fell out of the ring, resyncing`)
    }

    await this.resync(client)
  }

  detachClient(client: SessionClient): void {
    this.clients.delete(client)
    this.syncing.delete(client)
    this.applyBackpressure()
  }

  /**
   * Rebuilds a client's screen from the mirror.
   *
   * Ordering is load-bearing. The client is marked `syncing` before the
   * snapshot offset is read, so live output is withheld for the whole operation
   * and cannot be delivered both inside the snapshot and again as a live frame.
   * Catch-up is computed *before* the flag clears, for the same reason: the
   * moment `syncing` lifts, anything new flows live and must not be duplicated.
   */
  private async resync(client: SessionClient): Promise<void> {
    this.syncing.add(client)
    try {
      // Captured before awaiting: writes queued up to this point are exactly
      // what the snapshot will contain.
      const seqAtSnapshot = this.seq
      await this.flushMirror()

      const snapshot = Buffer.from(
        this.serializer.serialize({ scrollback: SNAPSHOT_SCROLLBACK_LINES }),
        'utf8',
      )

      const catchup = this.ring.since(seqAtSnapshot)

      client.sendControl({
        t: 'resync',
        seq: seqAtSnapshot,
        cols: this.cols,
        rows: this.rows,
      })
      if (snapshot.length > 0) client.sendData(snapshot)

      let finalSeq = seqAtSnapshot
      if (catchup !== null && catchup.length > 0) {
        client.sendControl({
          t: 'replay',
          fromSeq: seqAtSnapshot,
          toSeq: seqAtSnapshot + catchup.length,
        })
        client.sendData(catchup)
        finalSeq = seqAtSnapshot + catchup.length
      } else if (catchup === null) {
        // Output outran the ring while serializing — a burst far larger than
        // the ring, which takes a multi-megabyte write during the few
        // milliseconds of serialization. The screen is still correct; only a
        // slice of scrollback is missing.
        log.warn(`session ${this.id}: output outran the ring during resync for client ${client.id}`)
        finalSeq = this.seq
      }

      // Sent last, and synchronously before the `finally` below lifts the
      // withhold, so a client can rely on `synced` meaning "everything before
      // this is on screen and nothing after it has been dropped".
      client.sendControl({ t: 'synced', seq: finalSeq })
    } finally {
      this.syncing.delete(client)
    }
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  write(data: string): void {
    if (this.disposed) return
    if (!this.pty) {
      this.enqueuePendingInput(data)
      return
    }
    this.pty.write(data)
  }

  private enqueuePendingInput(data: string): void {
    this.pendingInput.push(data)
    this.pendingInputBytes += Buffer.byteLength(data, 'utf8')
    if (this.pendingInputBytes > MAX_PENDING_INPUT_BYTES) {
      log.warn(`session ${this.id} dropped ${this.pendingInputBytes} byte(s) of input typed before its pty was ready`)
      this.clearPendingInput()
    }
  }

  private flushPendingInput(): void {
    if (this.pendingInput.length === 0) return
    const queued = this.pendingInput
    this.clearPendingInput()
    if (!this.pty) return
    try {
      for (const data of queued) this.pty.write(data)
    } catch (err: unknown) {
      // The pty died between the check and the write. Losing these keystrokes
      // is unavoidable; failing the attach over them is not.
      log.warn(`session ${this.id} could not flush pending input: ${(err as Error).message}`)
    }
  }

  private clearPendingInput(): void {
    this.pendingInput = []
    this.pendingInputBytes = 0
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (this.disposed) return
    if (cols === this.cols && rows === this.rows) return

    this.cols = cols
    this.rows = rows
    this.mirror.resize(cols, rows)

    // The backend window and the server-side pty are resized together on
    // purpose: the mirror must render exactly what the tmux window contains,
    // and a client pty smaller than its window would leave the mirror showing
    // a cropped view.
    await this.backend.resize(this.id, cols, rows)
    this.pty?.resize(cols, rows)
  }

  async setTitle(title: string): Promise<void> {
    this.title = title
    await this.backend.setTitle(this.id, title)
  }

  /**
   * Records where the shell actually is. Purely local — no backend call, and
   * deliberately not async, because its caller is a background refresh that
   * must never be able to block on a session.
   */
  setLiveCwd(cwd: string): void {
    // An unparseable line from the backend must not blank a good value.
    if (cwd) this.liveCwd = cwd
  }

  // -------------------------------------------------------------------------
  // Backpressure
  // -------------------------------------------------------------------------

  /**
   * A slow client must not be allowed to grow the process's memory without
   * bound, so the PTY is paused while any client is far enough behind. A
   * client that never drains is closed by the gateway rather than stalling the
   * shell forever.
   */
  private applyBackpressure(): void {
    if (!this.pty || this.disposed) return

    let worst = 0
    for (const client of this.clients) worst = Math.max(worst, client.bufferedAmount)

    if (!this.paused && worst > HIGH_WATER_BYTES) {
      this.paused = true
      this.pty.pause()
      log.debug(`session ${this.id}: pausing pty, client backlog ${worst} bytes`)
    } else if (this.paused && worst < LOW_WATER_BYTES) {
      this.paused = false
      this.pty.resume()
      log.debug(`session ${this.id}: resuming pty`)
    }
  }

  /** Called by the gateway when a socket drains, to re-evaluate the pause state. */
  reevaluateBackpressure(): void {
    this.applyBackpressure()
  }
}
