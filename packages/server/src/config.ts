import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'

/**
 * Configuration resolves in three layers, later wins:
 *   defaults  <-  JSON config file  <-  WEBMUX_* environment variables
 *
 * Defaults are deliberately conservative: the server binds to loopback only,
 * so exposing it to a network is an explicit opt-in that forces the operator to
 * think about TLS and the reverse proxy in front of it.
 */

/** Platform-appropriate per-user data directory. */
export function defaultDataDir(): string {
  const home = homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'webmux')
  }
  const xdg = process.env.XDG_DATA_HOME
  return xdg ? path.join(xdg, 'webmux') : path.join(home, '.local', 'share', 'webmux')
}

/**
 * One whitelisted file root.
 *
 * Strict on purpose: zod strips unknown keys by default, so a misspelling like
 * `readOnly: true` would be dropped silently and leave the root quietly
 * writable. Rejecting it turns a security downgrade nobody would notice into a
 * startup error.
 */
const fileRootSchema = z.strictObject({
  name: z.string().min(1).max(64),
  path: z.string().min(1),
  readonly: z.boolean().optional(),
})

const fileSchema = z.object({
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  dataDir: z.string().optional(),
  /** Login shell used for new tmux sessions. Defaults to $SHELL. */
  shell: z.string().optional(),
  /** tmux socket name; isolates webmux sessions from the operator's own tmux. */
  tmuxSocket: z.string().optional(),
  maxSessions: z.number().int().min(1).max(256).optional(),
  /** Per-session reconnect buffer. A client further behind than this is resynced from a snapshot. */
  ringBufferBytes: z.number().int().min(64 * 1024).optional(),
  /** Lines of scrollback retained in the server-side terminal mirror. */
  scrollbackLines: z.number().int().min(100).max(200_000).optional(),
  /** How long a login stays valid. */
  sessionTtlHours: z.number().int().min(1).max(24 * 365).optional(),
  /** Set true when behind a reverse proxy so client IPs come from X-Forwarded-For. */
  trustProxy: z.boolean().optional(),
  /** Extra allowed origins for the WebSocket upgrade check, e.g. "https://box.example.com". */
  allowedOrigins: z.array(z.string()).optional(),
  /** Public share links. */
  shares: z
    .strictObject({
      enabled: z.boolean().optional(),
      /** Default lifetime for a new link. A link that never expires is how share features leak. */
      defaultTtlHours: z.number().int().min(1).max(24 * 365).optional(),
      /** Ceiling on links that are still usable. */
      maxActive: z.number().int().min(0).max(10_000).optional(),
      defaultMaxDownloads: z.number().int().min(1).nullable().optional(),
      /** 0 means unlimited. Per-share overrides this. */
      defaultRateLimitBytesPerSec: z.number().int().min(0).optional(),
      /** How long an unlock cookie lasts, before the share's own expiry clamps it. */
      unlockTtlHours: z.number().int().min(1).max(24 * 30).optional(),
      unlockFailures: z.number().int().min(1).max(1000).optional(),
      unlockWindowMinutes: z.number().int().min(1).max(24 * 60).optional(),
      /** Concurrent scrypt verifications. See shares/verify.ts for why this exists. */
      maxConcurrentVerifications: z.number().int().min(1).max(64).optional(),
      /** Circuit breaker on unlock attempts per minute; 0 disables it. */
      globalVerifyPerMinute: z.number().int().min(0).optional(),
      /** How long a dead share row is kept before it is swept. */
      retentionDays: z.number().int().min(1).max(3650).optional(),
      /** Serve image/text/PDF/media inline on a share rather than as an attachment. */
      inlinePreview: z.boolean().optional(),
    })
    .optional(),
  /** File browser. Omit entirely to browse `$HOME`. */
  files: z
    .strictObject({
      roots: z.array(fileRootSchema).optional(),
      /** How long an abandoned upload is kept before its staging area is swept. */
      uploadTtlHours: z.number().int().min(1).max(24 * 30).optional(),
      /** Refuse uploads larger than this. Null means no explicit ceiling. */
      maxUploadBytes: z.number().int().positive().nullable().optional(),
    })
    .optional(),
})

type FileConfig = z.infer<typeof fileSchema>

const envSchema = z.object({
  WEBMUX_HOST: z.string().optional(),
  WEBMUX_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  WEBMUX_DATA_DIR: z.string().optional(),
  WEBMUX_SHELL: z.string().optional(),
  WEBMUX_TMUX_SOCKET: z.string().optional(),
  WEBMUX_MAX_SESSIONS: z.coerce.number().int().min(1).max(256).optional(),
  WEBMUX_RING_BUFFER_BYTES: z.coerce.number().int().min(64 * 1024).optional(),
  WEBMUX_SCROLLBACK_LINES: z.coerce.number().int().min(100).max(200_000).optional(),
  WEBMUX_SESSION_TTL_HOURS: z.coerce.number().int().min(1).optional(),
  WEBMUX_TRUST_PROXY: z
    .enum(['1', 'true', 'yes', '0', 'false', 'no'])
    .transform((v) => v === '1' || v === 'true' || v === 'yes')
    .optional(),
  WEBMUX_SHARES_ENABLED: z
    .enum(['1', 'true', 'yes', '0', 'false', 'no'])
    .transform((v) => v === '1' || v === 'true' || v === 'yes')
    .optional(),
  WEBMUX_SHARES_DEFAULT_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 365).optional(),
  WEBMUX_SHARES_MAX_ACTIVE: z.coerce.number().int().min(0).max(10_000).optional(),
  WEBMUX_SHARES_DEFAULT_RATE_LIMIT: z.coerce.number().int().min(0).optional(),
  WEBMUX_CONFIG: z.string().optional(),
})

export interface FileRootConfig {
  name: string
  /**
   * Left as written. Canonicalising belongs to the jail, which is the only
   * place that has to reason about symlinks — config.ts stays free of fs calls.
   */
  path: string
  readonly: boolean
}

export interface FilesConfig {
  roots: FileRootConfig[]
  uploadTtlHours: number
  maxUploadBytes: number | null
}

export interface SharesConfig {
  enabled: boolean
  defaultTtlHours: number
  maxActive: number
  defaultMaxDownloads: number | null
  /** 0 means unlimited. */
  defaultRateLimitBytesPerSec: number
  unlockTtlHours: number
  unlockFailures: number
  unlockWindowMinutes: number
  maxConcurrentVerifications: number
  /** 0 disables the circuit breaker. */
  globalVerifyPerMinute: number
  retentionDays: number
  inlinePreview: boolean
}

/**
 * Whether an address is reachable only from this machine.
 *
 * Deliberately an allowlist rather than "is it 0.0.0.0": any address that is not
 * positively recognised counts as exposed, so an unrecognised form fails toward
 * warning rather than toward silence.
 */
export function isLoopbackHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (trimmed === 'localhost') return true
  if (trimmed === '::1') return true
  // The whole 127/8 block, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed)
}

/**
 * The plaintext-exposure warning for a listen address, or null when there is
 * nothing to say.
 *
 * Pure so the condition can be tested without starting a server — the case
 * worth pinning is that a wildcard bind is *not* treated as local, because
 * getting that backwards is exactly how a shell ends up on an open network
 * without anyone noticing.
 *
 * There is no way to silence this from configuration, and that is on purpose:
 * the situation it describes — a remote shell and a login password crossing a
 * network unencrypted — is not a preference. WireGuard or a TLS proxy in front
 * makes the warning harmless rather than wrong; binding back to 127.0.0.1
 * removes it.
 */
export function plaintextWarning(host: string): string | null {
  if (isLoopbackHost(host)) return null
  return (
    `listening on ${host} without TLS — the login password and everything typed ` +
    `into a terminal cross the network in the clear. Put a TLS reverse proxy in ` +
    `front (see the deployment section of README.md), use WireGuard/Tailscale, ` +
    `or bind back to 127.0.0.1.`
  )
}

/**
 * The forwarded-header warning for a listen address, or null.
 *
 * `trustProxy` is what makes the per-IP login rate limit work behind a reverse
 * proxy: without it every request appears to come from the proxy. On a listener
 * that is *also* reachable directly it does the opposite, because Fastify then
 * believes `X-Forwarded-For` from whoever connected — and a forged value per
 * attempt means the five-failures-per-fifteen-minutes limit never trips,
 * leaving an attacker unlimited password guesses (verified: with trustProxy on,
 * eight bad passwords with eight spoofed addresses all return 401 where the
 * sixth should have been 429).
 *
 * Binding to loopback makes the two mutually exclusive, which is why the
 * recommended deployment has the reverse proxy connect over 127.0.0.1.
 */
export function forwardedHeaderWarning(host: string, trustProxy: boolean): string | null {
  if (!trustProxy || isLoopbackHost(host)) return null
  return (
    `trustProxy is on while listening on ${host}: X-Forwarded-For is believed from ` +
    `anyone who can reach this port, so the per-IP login rate limit can be bypassed ` +
    `by forging it. Have the reverse proxy connect over 127.0.0.1 (or firewall the ` +
    `port to the proxy's address) and bind webmux to loopback.`
  )
}

export interface Config {
  host: string
  port: number
  dataDir: string
  shell: string
  tmuxSocket: string
  maxSessions: number
  ringBufferBytes: number
  scrollbackLines: number
  sessionTtlHours: number
  trustProxy: boolean
  allowedOrigins: string[]
  files: FilesConfig
  shares: SharesConfig
  configFile: string | null
}

function readConfigFile(explicitPath: string | undefined, dataDir: string): FileConfig {
  const candidates = explicitPath
    ? [explicitPath]
    : [path.join(dataDir, 'config.json'), path.join(process.cwd(), 'webmux.config.json')]

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      if (explicitPath) throw new Error(`config file not found: ${candidate}`)
      continue
    }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(candidate, 'utf8'))
    } catch (err) {
      throw new Error(`failed to parse config file ${candidate}: ${(err as Error).message}`)
    }
    const parsed = fileSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`invalid config file ${candidate}:\n${z.prettifyError(parsed.error)}`)
    }
    return parsed.data
  }
  return {}
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = envSchema.parse(env)

  // dataDir has to be resolved before the config file can be located in it.
  const dataDir = e.WEBMUX_DATA_DIR ?? defaultDataDir()
  const file = readConfigFile(e.WEBMUX_CONFIG, dataDir)

  const shell = e.WEBMUX_SHELL ?? file.shell ?? env.SHELL ?? '/bin/bash'

  const config: Config = {
    host: e.WEBMUX_HOST ?? file.host ?? '127.0.0.1',
    port: e.WEBMUX_PORT ?? file.port ?? 8080,
    dataDir: path.resolve(e.WEBMUX_DATA_DIR ?? file.dataDir ?? dataDir),
    shell,
    tmuxSocket: e.WEBMUX_TMUX_SOCKET ?? file.tmuxSocket ?? 'webmux',
    maxSessions: e.WEBMUX_MAX_SESSIONS ?? file.maxSessions ?? 32,
    ringBufferBytes: e.WEBMUX_RING_BUFFER_BYTES ?? file.ringBufferBytes ?? 1024 * 1024,
    scrollbackLines: e.WEBMUX_SCROLLBACK_LINES ?? file.scrollbackLines ?? 10_000,
    sessionTtlHours: e.WEBMUX_SESSION_TTL_HOURS ?? file.sessionTtlHours ?? 24 * 7,
    trustProxy: e.WEBMUX_TRUST_PROXY ?? file.trustProxy ?? false,
    allowedOrigins: file.allowedOrigins ?? [],
    files: {
      // Defaulting to $HOME keeps the file browser usable on a fresh install.
      // It is not a privilege boundary — the operator already has a shell as
      // this user — it is a guardrail against a bug in the API reaching
      // further than intended. The jail additionally refuses dataDir.
      roots: file.files?.roots?.map((r) => ({
        name: r.name,
        path: r.path,
        readonly: r.readonly ?? false,
      })) ?? [{ name: 'home', path: homedir(), readonly: false }],
      uploadTtlHours: file.files?.uploadTtlHours ?? 24,
      maxUploadBytes: file.files?.maxUploadBytes ?? null,
    },
    shares: {
      enabled: e.WEBMUX_SHARES_ENABLED ?? file.shares?.enabled ?? true,
      // Never-expiring is the default nobody means, so the default is a week.
      defaultTtlHours: e.WEBMUX_SHARES_DEFAULT_TTL_HOURS ?? file.shares?.defaultTtlHours ?? 168,
      maxActive: e.WEBMUX_SHARES_MAX_ACTIVE ?? file.shares?.maxActive ?? 100,
      defaultMaxDownloads: file.shares?.defaultMaxDownloads ?? null,
      // Unlimited by default: DESIGN requires that rate limiting is *available*,
      // not that it is on. A 100 KB invoice at 1 MB/s is indistinguishable from
      // unlimited, and the uplink belongs to the operator.
      defaultRateLimitBytesPerSec:
        e.WEBMUX_SHARES_DEFAULT_RATE_LIMIT ?? file.shares?.defaultRateLimitBytesPerSec ?? 0,
      unlockTtlHours: file.shares?.unlockTtlHours ?? 12,
      // Same shape as the login limiter, so there is one concept to learn.
      unlockFailures: file.shares?.unlockFailures ?? 5,
      unlockWindowMinutes: file.shares?.unlockWindowMinutes ?? 15,
      maxConcurrentVerifications: file.shares?.maxConcurrentVerifications ?? 2,
      globalVerifyPerMinute: file.shares?.globalVerifyPerMinute ?? 60,
      retentionDays: file.shares?.retentionDays ?? 30,
      inlinePreview: file.shares?.inlinePreview ?? true,
    },
    configFile: e.WEBMUX_CONFIG ?? null,
  }

  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  return config
}
