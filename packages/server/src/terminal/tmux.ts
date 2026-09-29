import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import * as pty from 'node-pty'
import { logger } from '../logger'
import type { AttachedPty, CreateOptions, SessionBackend, SessionInfo } from './backend'

const execFileAsync = promisify(execFile)

/**
 * Separator for `list-sessions -F` output. A literal ASCII Unit Separator is
 * used because it cannot appear in a tmux session name and is vanishingly
 * unlikely in a path, unlike the more obvious choices of space or `|`.
 */
const FS = '\x1f'

const log = logger.child('tmux')

/**
 * Session/window/server options applied once the tmux server is up.
 *
 * `window-size manual` is the load-bearing one. Without it tmux resizes
 * windows from whichever client it considers authoritative, which fights the
 * browser for control and makes the server-side terminal mirror disagree with
 * what the user sees. With it, the browser's dimensions are applied explicitly
 * via `resize-window` and tmux never second-guesses them.
 *
 * `escape-time 0` matters more than it looks: tmux's 500 ms default makes Esc
 * feel broken in vim, because it waits to see whether the byte is the start of
 * an escape sequence.
 */
const WINDOW_SESSION_OPTIONS: Array<[string, string]> = [
  ['window-size', 'manual'],
  ['default-size', '80x24'],
  ['history-limit', '50000'],
  ['status', 'off'],
  ['allow-passthrough', 'on'],
  ['mouse', 'off'], // touch scrolling is handled in the browser
]

const SERVER_OPTIONS: Array<[string, string]> = [
  ['escape-time', '0'],
  ['focus-events', 'on'],
  ['set-clipboard', 'on'],
  ['exit-unattached', 'off'], // keep sessions alive while no browser is connected
  ['default-terminal', 'tmux-256color'],
]

export interface TmuxBackendOptions {
  socket: string
  /** Namespace for session names, e.g. "webmux-". Lets the backend own tmux naming. */
  prefix: string
  shell: string
}

export class TmuxBackend implements SessionBackend {
  readonly name = 'tmux'

  private readonly prefix: string
  private serverReady: Promise<void> | null = null

  constructor(private readonly opts: TmuxBackendOptions) {
    this.prefix = opts.prefix
  }

  private get baseArgs(): string[] {
    // -L isolates webmux from the operator's own tmux server; -f /dev/null
    // skips ~/.tmux.conf so behaviour does not depend on the host's dotfiles.
    return ['-L', this.opts.socket, '-f', '/dev/null', '-u']
  }

  private async run(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('tmux', [...this.baseArgs, ...args], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return stdout
  }

  private toTmuxName(id: string): string {
    return `${this.prefix}${id}`
  }

  private fromTmuxName(name: string): string {
    return name.startsWith(this.prefix) ? name.slice(this.prefix.length) : name
  }

  async probe(): Promise<boolean> {
    try {
      await execFileAsync('tmux', ['-V'], { encoding: 'utf8', timeout: 5000 })
      return true
    } catch {
      return false
    }
  }

  /**
   * Whether a tmux server is currently running on our socket.
   *
   * Any command would answer this, but this one is cheapest and has no side
   * effects.
   */
  private async serverAlive(): Promise<boolean> {
    try {
      await this.run('show-options', '-s', 'exit-empty')
      return true
    } catch {
      return false
    }
  }

  /**
   * Starts the tmux server if needed and applies options. Idempotent — safe to
   * call on every session creation, which also repairs options if an operator
   * has been poking at the server by hand.
   *
   * The memo is revalidated rather than trusted, because the server can die at
   * any time — a reboot, a crash, `tmux kill-server` — and the next
   * `new-session` would then quietly resurrect one with every option back at
   * its default.
   */
  private async ensureServer(): Promise<void> {
    if (this.serverReady !== null && (await this.serverAlive())) return this.serverReady
    this.serverReady = null

    this.serverReady = (async () => {
      /*
       * `exit-empty` goes off in the *same* invocation that starts the server,
       * and it has to come first.
       *
       * It defaults to on, which means a server started with no sessions exits
       * immediately. `start-server` returns 0 having done exactly that, so
       * every `set-option` below would run against a server that is already
       * gone, fail, and be logged only at debug — and then the first
       * `new-session` would start a fresh server with the entire configuration
       * missing. The symptoms are all quiet: tmux's status bar comes back and
       * steals the bottom line of every terminal, Esc waits 500 ms in vim, and
       * scrollback drops to the 2000-line default.
       */
      await this.run('start-server', ';', 'set-option', '-s', 'exit-empty', 'off')

      // `default-shell` belongs to the session scope, not the server scope, and
      // getting that wrong is not a cosmetic difference: `set-option -s
      // default-shell ...` fails with "no current session" — which, at debug
      // level, is invisible — and every session then starts in whatever shell
      // tmux picked rather than the configured one.
      const sessionOptions: Array<[string, string]> = [
        ...WINDOW_SESSION_OPTIONS,
        ['default-shell', this.opts.shell],
      ]
      await this.setOptions(sessionOptions, '-g')
      await this.setOptions(SERVER_OPTIONS, '-s')
      await this.setServerOption('default-terminal', 'tmux-256color')
      await this.setServerOption('terminal-overrides', ',*:Tc') // advertise truecolor

      /*
       * Read back what was just set.
       *
       * A single option failing above is tolerable — names and scopes drift
       * between tmux versions — which is why those calls only log at debug.
       * That is also exactly how two *total* failures stayed invisible: every
       * option rejected because the server had already exited, and then
       * `default-shell` rejected for being set in the wrong scope. Both are
       * silent, and both change what the user sees, so this says something out
       * loud instead.
       */
      const wrong: string[] = []
      for (const [name, value] of sessionOptions) {
        try {
          const actual = (await this.run('show-options', '-gv', name)).trim()
          if (actual !== value) wrong.push(`${name}=${actual} (wanted ${value})`)
        } catch {
          wrong.push(`${name}=<unreadable>`)
        }
      }
      if (wrong.length > 0) {
        log.warn(
          `tmux rejected ${wrong.length} option(s): ${wrong.join(', ')}. Expect a ` +
            `status bar stealing a line from every terminal, slow Esc in vim, or ` +
            `sessions starting in the wrong shell. Check this tmux version's option ` +
            `names and scopes.`,
        )
      }
    })().catch((err: unknown) => {
      this.serverReady = null // let the next caller retry
      throw err
    })
    return this.serverReady
  }

  private async setOptions(options: Array<[string, string]>, scope: '-g' | '-s'): Promise<void> {
    for (const [name, value] of options) {
      try {
        await this.run('set-option', scope, name, value)
      } catch (err) {
        // Option names and their scopes drift between tmux versions. A miss
        // here is worth knowing about but must not prevent a session starting.
        log.debug(`could not set ${scope} ${name}=${value}: ${(err as Error).message}`)
      }
    }
  }

  private async setServerOption(name: string, value: string): Promise<void> {
    try {
      await this.run('set-option', '-s', name, value)
    } catch (err) {
      log.debug(`could not set server option ${name}=${value}: ${(err as Error).message}`)
    }
  }

  async has(id: string): Promise<boolean> {
    try {
      await this.run('has-session', '-t', this.toTmuxName(id))
      return true
    } catch {
      return false
    }
  }

  async create({ id, cwd, title, cols, rows }: CreateOptions): Promise<void> {
    await this.ensureServer()
    const name = this.toTmuxName(id)

    if (!(await this.has(id))) {
      await this.run(
        'new-session',
        '-d',
        '-s',
        name,
        '-c',
        cwd,
        '-x',
        String(cols),
        '-y',
        String(rows),
      )
      // No explicit shell argument here, deliberately. Naming one would make
      // tmux run it as a plain command — argv[0] without the leading dash — and
      // a shell that is not a login shell never reads the user's profile, so
      // PATH additions and prompt customisation would silently go missing.
      // `default-shell` is set instead, which tmux turns into `-bash`/`-zsh`.
    }

    await this.setTitle(id, title)
  }

  async attach(id: string, cols: number, rows: number): Promise<AttachedPty> {
    const name = this.toTmuxName(id)
    const child = pty.spawn('tmux', [...this.baseArgs, 'attach', '-t', name], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: homedir(),
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    })
    return { pty: child, cols, rows }
  }

  async resize(id: string, cols: number, rows: number): Promise<{ cols: number; rows: number }> {
    // `-x`/`-y` are width/height for resize-window. Both must be positive;
    // tmux rejects -x 0, so callers clamp to at least 2 columns / 1 row.
    await this.run('resize-window', '-t', this.toTmuxName(id), '-x', String(cols), '-y', String(rows))
    return { cols, rows }
  }

  async kill(id: string): Promise<void> {
    try {
      await this.run('kill-session', '-t', this.toTmuxName(id))
    } catch (err) {
      // Already gone is a success as far as callers are concerned.
      log.debug(`kill-session ${id}: ${(err as Error).message}`)
    }
  }

  async setTitle(id: string, title: string): Promise<void> {
    try {
      // Stored as a tmux user option so it travels with the session and
      // survives both a webmux restart and deletion of webmux's own database.
      await this.run('set-option', '-t', this.toTmuxName(id), '@webmux_title', title)
    } catch (err) {
      log.debug(`set-title ${id}: ${(err as Error).message}`)
    }
  }

  /**
   * Format string fields, in order. Paths are the only field that could in
   * principle contain the separator; a tmux session name cannot.
   */
  private static readonly LIST_FORMAT = [
    '#{session_name}',
    '#{session_created}',
    '#{pane_current_path}',
    '#{@webmux_title}',
    '#{pane_dead}',
  ].join(FS)

  async list(): Promise<SessionInfo[]> {
    try {
      const stdout = await this.run('list-sessions', '-F', TmuxBackend.LIST_FORMAT)
      return this.parseList(stdout)
    } catch (err) {
      // A missing server is the ordinary empty state, not a failure — and it
      // is spelled differently on each platform, which is why this matches a
      // phrase rather than one string. Linux says "no server running on ...";
      // macOS, given `-L <socket>`, says "error connecting to <path>".
      //
      // Worth getting right: a fresh install logs this at boot, and a warning
      // that fires on a healthy system is how real warnings get ignored.
      const message = (err as Error).message ?? ''
      if (!/no server running|no sessions|error connecting to/i.test(message)) {
        log.warn(`list-sessions failed: ${message}`)
      }
      return []
    }
  }

  async listOrphans(): Promise<SessionInfo[]> {
    return this.list()
  }

  private parseList(stdout: string): SessionInfo[] {
    const out: SessionInfo[] = []
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      const [name, created, cwd, title, dead] = line.split(FS)
      if (!name || !name.startsWith(this.prefix)) continue

      const id = this.fromTmuxName(name)
      out.push({
        id,
        title: title?.trim() || id,
        cwd: cwd || homedir(),
        // tmux reports session_created in seconds; the rest of the codebase
        // works in milliseconds.
        createdAt: Number(created ?? 0) * 1000 || Date.now(),
        running: dead !== '1',
      })
    }
    return out
  }

  async shutdown(): Promise<void> {
    // Deliberately does nothing. Sessions are meant to outlive this process —
    // that is the entire reason a tmux backend was chosen. Client ptys are
    // torn down by the session registry, which detaches without killing.
  }
}
