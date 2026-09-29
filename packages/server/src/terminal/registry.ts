import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { SessionSummary } from '@webmux/shared'
import type { Config } from '../config'
import { logger } from '../logger'
import type { SessionBackend } from './backend'
import { Session, type SessionExit } from './session'

const log = logger.child('registry')

/** Session names must survive a round-trip through tmux, so: alphanumerics only. */
function newSessionId(): string {
  return randomBytes(5).toString('hex')
}

/**
 * The directory a new session should start in.
 *
 * Checked here rather than trusted, and that is a change: the file browser's
 * paths are already inside the jail and known to exist, but the session tree
 * offers a session's *live* directory as the parent for a new one — and that is
 * wherever the user has `cd`'d to, including a directory that has since been
 * deleted. tmux does **not** fall back to `$HOME` for an unusable `-c` (the
 * opposite was assumed here for a long time): it starts a pane that never
 * produces a prompt, giving a blank terminal and nothing in any log.
 *
 * Falls back to the home directory rather than refusing. The user asked for a
 * shell, not for a directory, and a shell they cannot open is worse than one
 * that opens somewhere else — especially since the sidebar shows every
 * session's live directory, so where it landed is on screen immediately.
 */
function resolveCwd(requested: string | undefined): string {
  if (!requested) return homedir()

  try {
    if (statSync(requested).isDirectory()) return requested
    log.warn(`session cwd ${requested} is not a directory — starting in ${homedir()}`)
  } catch {
    log.warn(`session cwd ${requested} does not exist — starting in ${homedir()}`)
  }
  return homedir()
}

/**
 * How often each session's live working directory is re-read from the backend.
 *
 * Short enough that `cd` shows up in the sidebar while you are still looking at
 * it, long enough that one fork/exec every few seconds is unremarkable. The
 * client polls the session list every 10s on top of this, so the worst case a
 * user observes is roughly the sum of the two.
 */
const LIVE_CWD_REFRESH_MS = 5_000

export interface CreateSessionInput {
  title?: string | undefined
  cwd?: string | undefined
  cols?: number | undefined
  rows?: number | undefined
  /** The session this is being opened from, if the user opened it from one. */
  parentId?: string | undefined
}

export interface SessionRegistryOptions {
  backend: SessionBackend
  config: Config
  /** Invoked whenever the session list changes, so the UI can be refreshed. */
  onChange?: (() => void) | undefined
}

/**
 * Owns the set of live sessions and mediates between tmux and the HTTP/WS
 * layers.
 *
 * On startup it adopts sessions that a previous webmux process left behind.
 * That works because tmux is the source of truth: the tmux server outlives
 * webmux, and each session carries its own title in a tmux user option, so
 * nothing has to be reconstructed from webmux's own database.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, Session>()
  private refreshTimer: NodeJS.Timeout | null = null
  /** Single-flight guard for the live-cwd refresh. */
  private refreshing = false

  constructor(private readonly opts: SessionRegistryOptions) {}

  private get backend(): SessionBackend {
    return this.opts.backend
  }

  private get config(): Config {
    return this.opts.config
  }

  /**
   * Reattaches to sessions surviving from a previous run. Called once at
   * startup; failures are logged rather than fatal, since losing the ability to
   * list old sessions should not stop the server from accepting new ones.
   */
  async adoptOrphans(): Promise<number> {
    let orphans: Awaited<ReturnType<SessionBackend['list']>> = []
    try {
      orphans = await this.backend.listOrphans()
    } catch (err) {
      log.warn(`could not list existing sessions: ${(err as Error).message}`)
      return 0
    }

    let adopted = 0
    for (const info of orphans) {
      if (this.sessions.has(info.id)) continue
      const session = new Session(
        this.backend,
        {
          id: info.id,
          title: info.title,
          cwd: info.cwd,
          cols: 80,
          rows: 24,
          scrollbackLines: this.config.scrollbackLines,
          ringBufferBytes: this.config.ringBufferBytes,
          // Read back from tmux, so the tree survives a webmux restart. A
          // parent that did not survive is left as-is here and shows up as a
          // root in the client, which is where that case is handled.
          parentId: info.parentId,
        },
        (s, exit) => this.handleExit(s, exit),
      )
      this.sessions.set(info.id, session)
      adopted += 1
    }

    if (adopted > 0) log.info(`adopted ${adopted} existing session(s)`)
    return adopted
  }

  /**
   * Resolves the session a new one should hang off.
   *
   * The tree is deliberately one level deep. Opening a shell from a root makes
   * a child of it; opening one from that child joins the *same* root rather
   * than nesting further, so a session created from a child lands beside it.
   * Without the flattening, a habit of opening a shell from the shell you are
   * in would grow an unbounded staircase that a 288px sidebar cannot show.
   *
   * An unknown or missing parent yields a root: the parent may have been killed
   * while this request was in flight, and a session that cannot be placed is
   * better at the top level than invisible.
   */
  private resolveParent(parentId: string | undefined): string | null {
    if (!parentId) return null
    const parent = this.sessions.get(parentId)
    if (!parent) return null
    return parent.parentId ?? parent.id
  }

  async create(input: CreateSessionInput = {}): Promise<Session> {
    if (this.sessions.size >= this.config.maxSessions) {
      throw Object.assign(new Error(`session limit reached (${this.config.maxSessions})`), {
        code: 'session_limit',
      })
    }

    const id = newSessionId()
    const session = new Session(
      this.backend,
      {
        id,
        title: input.title?.trim() || `session ${id}`,
        cwd: resolveCwd(input.cwd?.trim()),
        cols: input.cols ?? 80,
        rows: input.rows ?? 24,
        scrollbackLines: this.config.scrollbackLines,
        ringBufferBytes: this.config.ringBufferBytes,
        parentId: this.resolveParent(input.parentId),
      },
      (s, exit) => this.handleExit(s, exit),
    )

    this.sessions.set(id, session)

    try {
      // Eager rather than lazy: a session the user created should exist in tmux
      // immediately, so it appears in `tmux ls` and survives a webmux restart
      // even if no browser ever attaches to it.
      await session.ensureStarted()
    } catch (err) {
      this.sessions.delete(id)
      throw err
    }

    log.info(`created session ${id}`)
    this.opts.onChange?.()
    return session
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  /**
   * Keeps every session's live working directory fresh, out of band.
   *
   * A timer rather than work inside `list()`, and that is the whole point of
   * this method's shape: `list()` backs `GET /api/sessions`, which the client
   * polls as a liveness heartbeat. A route that can block on a tmux spawn —
   * `TmuxBackend.run` allows 10s before it gives up — is indistinguishable from
   * a dead server in the UI, and a sidebar line is not worth that. Here the
   * cost is one process per tick no matter how many browsers are watching, and
   * the endpoint can never be slow because of it.
   */
  startLiveCwdRefresh(intervalMs = LIVE_CWD_REFRESH_MS): void {
    if (this.refreshTimer !== null) return
    this.refreshTimer = setInterval(() => void this.refreshLiveCwd(), intervalMs)
    // Never hold the process open for a cosmetic refresh.
    this.refreshTimer.unref()
  }

  private async refreshLiveCwd(): Promise<void> {
    if (this.refreshing || this.sessions.size === 0) return
    this.refreshing = true
    try {
      for (const info of await this.backend.list()) {
        // Updates only. Adding or dropping sessions is `adoptOrphans`' job, and
        // the empty list tmux returns once its server is gone must leave the
        // last known paths alone rather than blanking the sidebar. Only `cwd`
        // is read back: `title` is written to tmux asynchronously (so a refresh
        // can legitimately observe the previous one), and `running` mirrors the
        // client pty rather than the pane.
        this.sessions.get(info.id)?.setLiveCwd(info.cwd)
      }
    } catch (err) {
      log.debug(`live cwd refresh failed: ${(err as Error).message}`)
    } finally {
      this.refreshing = false
    }
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .map((s) => s.toSummary())
      .sort((a, b) => b.lastAttachedAt - a.lastAttachedAt)
  }

  async kill(id: string): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) return false

    await this.backend.kill(id)
    session.dispose()
    this.sessions.delete(id)

    log.info(`killed session ${id}`)
    this.opts.onChange?.()
    return true
  }

  private handleExit(session: Session, exit: SessionExit): void {
    // The shell is gone, so tmux has already reaped the session; there is
    // nothing left to kill, only bookkeeping to drop.
    //
    // Disposed as well as forgotten, which `kill()` already does and this path
    // did not: an exited session's clients and its headless mirror — a whole
    // scrollback, tens of megabytes on a long-lived shell — stayed reachable
    // through the gateway's connection objects. Disposal here is safe because
    // `Session.handleExit` has already sent the `exit` frame to every client.
    this.sessions.delete(session.id)
    session.dispose()
    log.info(`session ${session.id} ended (code ${exit.code})`)
    this.opts.onChange?.()
  }

  /**
   * Detaches every client pty. Backing sessions are intentionally left
   * running — surviving this call is the property that makes webmux useful.
   */
  async shutdown(): Promise<void> {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    for (const session of this.sessions.values()) session.dispose()
    this.sessions.clear()
    await this.backend.shutdown()
  }
}
