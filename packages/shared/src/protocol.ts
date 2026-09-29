import { z } from 'zod'

/**
 * WebSocket terminal protocol.
 *
 * One socket carries two kinds of frames, distinguished by JS type:
 *   - JSON **text** frames  -> control messages (this file)
 *   - **binary** frames     -> raw PTY bytes, forwarded verbatim to xterm.js
 *
 * PTY output is never converted to a JS string on the way through: multi-byte
 * UTF-8 sequences are routinely split across read() boundaries, and any
 * decode-then-reencode would corrupt them. Browsers get Uint8Array and let
 * xterm.js' internal streaming decoder handle the boundaries.
 */

// ---------------------------------------------------------------------------
// Sequence numbers
// ---------------------------------------------------------------------------

/**
 * `seq` is the count of bytes ever produced by a session's PTY — a monotonic
 * absolute stream offset, not a message counter. A client reports the offset it
 * has consumed (`lastSeq`), which lets the server either replay the exact gap
 * or declare that the client has fallen out of the ring buffer and must be
 * resynchronised from a snapshot.
 */
export type Seq = number

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export const attachMessage = z.object({
  t: z.literal('attach'),
  sessionId: z.string().min(1),
  /** Offset the client has already rendered. Omit for a cold attach. */
  lastSeq: z.number().int().nonnegative().optional(),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(1000),
})

export const inputMessage = z.object({
  t: z.literal('input'),
  data: z.string(),
})

export const resizeMessage = z.object({
  t: z.literal('resize'),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(1000),
})

export const pingMessage = z.object({ t: z.literal('ping') })
export const pongMessage = z.object({ t: z.literal('pong') })

export const clientMessage = z.discriminatedUnion('t', [
  attachMessage,
  inputMessage,
  resizeMessage,
  pingMessage,
  pongMessage,
])

export type ClientMessage = z.infer<typeof clientMessage>
export type AttachMessage = z.infer<typeof attachMessage>

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export interface AttachedMessage {
  t: 'attached'
  sessionId: string
  /**
   * The server's *current* stream offset, for diagnostics.
   *
   * Clients must not adopt this as their own position: the sync messages that
   * follow (`replay.toSeq` or `resync.seq`) describe where the client actually
   * lands, and using this value instead would double-count replayed bytes.
   */
  seq: Seq
  /** Dimensions actually applied — the client resizes its terminal to match. */
  cols: number
  rows: number
}

/**
 * The gap from `lastSeq` was still in the ring buffer. The exact missing bytes
 * follow immediately as a single binary frame, so the client can splice them
 * into its existing buffer with no visible discontinuity.
 */
export interface ReplayMessage {
  t: 'replay'
  fromSeq: Seq
  toSeq: Seq
}

/**
 * The client fell out of the ring buffer (cold start, or closed for a long
 * time). A serialized snapshot of the server-side terminal — screen contents,
 * scrollback and attributes — follows as a binary frame and must be written to
 * a **reset** terminal.
 *
 * `seq` is the stream offset that snapshot represents; any bytes the server
 * emits after it are delivered separately.
 */
export interface ResyncMessage {
  t: 'resync'
  seq: Seq
  cols: number
  rows: number
}

/**
 * Terminates every sync sequence: sent once the client has been brought fully
 * up to date, after `replay` or `resync` (and any catch-up that followed it).
 *
 * Without this marker a client cannot tell "the snapshot is still arriving"
 * from "the screen is now live" — it would have to guess with a timer. The UI
 * uses it to clear its reconnecting indicator; tests use it to avoid racing.
 */
export interface SyncedMessage {
  t: 'synced'
  seq: Seq
}

/** Session title changed (e.g. shell set the window title via OSC). */
export interface TitleMessage {
  t: 'title'
  title: string
}

/** The PTY exited. The session may still exist in tmux if it is configured to persist. */
export interface ExitMessage {
  t: 'exit'
  code: number
  signal?: number
}

export type ErrorCode =
  | 'unauthorized'
  | 'session_not_found'
  | 'session_limit'
  | 'bad_message'
  | 'internal'

export interface ErrorMessage {
  t: 'error'
  code: ErrorCode
  message: string
}

/** Server-initiated liveness probe; the client answers with `pong`. */
export interface PingMessage {
  t: 'ping'
}

export interface PongMessage {
  t: 'pong'
}

export type ServerMessage =
  | AttachedMessage
  | ReplayMessage
  | ResyncMessage
  | SyncedMessage
  | TitleMessage
  | ExitMessage
  | ErrorMessage
  | PingMessage
  | PongMessage

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

/**
 * Liveness is application-level rather than protocol-level: browser JavaScript
 * cannot observe WebSocket protocol pings or pongs, so both directions use
 * ordinary JSON frames and *any* inbound frame counts as proof of life.
 *
 * The server pings every `PING_INTERVAL_MS` and reaps a socket that has been
 * silent for `PONG_TIMEOUT_MS`.
 */
export const PING_INTERVAL_MS = 20_000
export const PONG_TIMEOUT_MS = 60_000

export const WS_PATH = '/ws/terminal'

/** Close codes in the application range, surfaced to the client for reconnect policy. */
export const WS_CLOSE = {
  /** Normal client-initiated close; do not reconnect. */
  NORMAL: 1000,
  /**
   * Auth failed at upgrade; reconnecting will not help until re-login.
   *
   * Reserved, and currently unreachable: the gateway rejects an
   * unauthenticated upgrade with an HTTP 401, and a browser reports a failed
   * WebSocket handshake as 1006 regardless of the status code — it cannot read
   * it. Emitting this instead would mean completing the handshake only to close
   * it, which puts an await in front of the gateway's message wiring. The
   * client compensates by recovering on the next `/api/sessions` poll, which
   * sees the same 401. Do not rely on this code arriving.
   */
  UNAUTHORIZED: 4001,
  /** Server is shutting down; reconnect with backoff. */
  SHUTTING_DOWN: 4002,
  /**
   * The socket could not keep up and its backlog was dropped rather than
   * allowed to grow without bound. Reconnecting is the correct response: the
   * client resyncs from a snapshot.
   */
  TOO_SLOW: 4003,
} as const
