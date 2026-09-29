import type { IPty } from 'node-pty'

/**
 * The seam between webmux and whatever keeps shells alive.
 *
 * v1 ships a tmux implementation, which is the pragmatic choice on
 * Linux/macOS: tmux is a well-tested daemon that already solves session
 * survival, multi-client attach and terminal emulation, and it keeps sessions
 * alive across webmux restarts (the tmux server is a separate process).
 *
 * Everything tmux-specific — socket naming, `resize-window`, user options —
 * must stay behind this interface so the rest of the server never learns which
 * backend is in use. That keeps the door open for a native PTY daemon later
 * (needed for Windows, where tmux does not exist).
 */
export interface SessionInfo {
  id: string
  title: string
  cwd: string
  createdAt: number
  /** False once the shell inside has exited. */
  running: boolean
}

export interface CreateOptions {
  id: string
  cwd: string
  title: string
  cols: number
  rows: number
}

export interface AttachedPty {
  pty: IPty
  cols: number
  rows: number
}

export interface SessionBackend {
  readonly name: string

  /** Resolves false when the backend's external dependency is missing. */
  probe(): Promise<boolean>

  /** Idempotent: adopting an already-existing session is not an error. */
  create(opts: CreateOptions): Promise<void>

  /**
   * Spawns a *client* attached to the session. Killing the returned pty
   * detaches; it must never terminate the session itself.
   */
  attach(id: string, cols: number, rows: number): Promise<AttachedPty>

  list(): Promise<SessionInfo[]>

  has(id: string): Promise<boolean>

  /** Resize the session's viewport. Returns the dimensions actually applied. */
  resize(id: string, cols: number, rows: number): Promise<{ cols: number; rows: number }>

  kill(id: string): Promise<void>

  setTitle(id: string, title: string): Promise<void>

  /** Adopt sessions left behind by a previous webmux process. */
  listOrphans(): Promise<SessionInfo[]>

  shutdown(): Promise<void>
}
