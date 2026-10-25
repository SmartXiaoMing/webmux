import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import net from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'

/**
 * Configuration resolves in three layers, later wins:
 *   defaults  <-  JSON config file  <-  WEBMUX_* environment variables
 *
 * The default bind is 0.0.0.0, so container port mappings and a reverse proxy on
 * another host work without configuration. That default is exposed, and the
 * server speaks plain HTTP — so the boot warnings below exist to make sure the
 * operator knows, rather than to make the choice for them.
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
  /** Notifications: a local-only ingress plus delivery to browsers and phones. */
  notify: z
    .strictObject({
      enabled: z.boolean().optional(),
      /** How long a notification is kept before the sweep removes it. */
      retentionDays: z.number().int().min(1).max(3650).optional(),
      /** Ceiling on stored rows, so a runaway script cannot grow the database. */
      maxStored: z.number().int().min(10).max(100_000).optional(),
      /** Ingest limit per minute. 0 disables it; see notify/hub.ts for why that is unwise. */
      perMinute: z.number().int().min(0).max(10_000).optional(),
      /** Extra source CIDRs accepted by the local-only route. */
      allowFrom: z
        .array(
          z.string().refine((v) => parseCidr(v) !== null, {
            message: 'expected an IP address or CIDR, e.g. 172.17.0.0/16',
          }),
        )
        .max(32)
        .optional(),
      push: z
        .strictObject({
          enabled: z.boolean().optional(),
          /** VAPID `sub`: who a push service should contact about this sender. */
          subject: z.string().min(1).max(256).optional(),
        })
        .optional(),
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
  WEBMUX_NOTIFY_ENABLED: z
    .enum(['1', 'true', 'yes', '0', 'false', 'no'])
    .transform((v) => v === '1' || v === 'true' || v === 'yes')
    .optional(),
  WEBMUX_NOTIFY_PUSH_ENABLED: z
    .enum(['1', 'true', 'yes', '0', 'false', 'no'])
    .transform((v) => v === '1' || v === 'true' || v === 'yes')
    .optional(),
  WEBMUX_NOTIFY_PER_MINUTE: z.coerce.number().int().min(0).optional(),
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

/** Loopback, in the two families, as something Node can match against. */
const LOOPBACK_BLOCKS = ((): net.BlockList => {
  const list = new net.BlockList()
  list.addSubnet('127.0.0.0', 8, 'ipv4')
  list.addAddress('::1', 'ipv6')
  return list
})()

/**
 * Whether an address is in a block list, or false when it cannot be read.
 *
 * A BlockList does the two things that are easy to get wrong by hand: an IPv4
 * peer of a dual-stack listener arrives as `::ffff:127.0.0.1` — or, on some
 * platforms, in hex as `::ffff:7f00:1` — and `0:0:0:0:0:0:0:1` is the same
 * address as `::1`. Node matches all three against the IPv4/IPv6 rules of the
 * list without any rewriting here, which is the whole reason for using it.
 * That claim is load-bearing and is pinned by a test in security.test.mjs.
 *
 * Anything unparseable, and `undefined`, is refused: every case where the
 * address cannot be read is a case where the caller is not provably local.
 */
export function addressAllowed(list: net.BlockList, address: string | undefined): boolean {
  if (address === undefined) return false
  const trimmed = address.trim()
  if (trimmed === '') return false
  const family = trimmed.includes(':') ? 'ipv6' : 'ipv4'
  if (family === 'ipv4' ? !net.isIPv4(trimmed) : !net.isIPv6(trimmed)) return false
  return list.check(trimmed, family)
}

/**
 * Whether a **peer** address is this machine.
 *
 * Deliberately not `isLoopbackHost` above: that one classifies a configured
 * *listen* address and so accepts `localhost`, which a socket peer never is.
 * Different question, different input, different answer for the same string.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  return addressAllowed(LOOPBACK_BLOCKS, address)
}

/**
 * Splits an `allowFrom` entry into what `net.BlockList.addSubnet` wants, or
 * null when it is not an address.
 *
 * A bare address is accepted and treated as a host route, because requiring
 * the suffix would make the common case — one container gateway — needlessly
 * ceremonial.
 */
export function parseCidr(
  entry: string,
): { address: string; prefix: number; type: 'ipv4' | 'ipv6' } | null {
  const parts = entry.split('/')
  const address = parts[0]
  if (address === undefined || address === '' || parts.length > 2) return null

  const isV6 = net.isIPv6(address)
  if (!isV6 && !net.isIPv4(address)) return null
  const type: 'ipv4' | 'ipv6' = isV6 ? 'ipv6' : 'ipv4'
  const full = isV6 ? 128 : 32

  const text = parts[1]
  if (text === undefined) return { address, prefix: full, type }

  // Digits only, before any conversion. `Number('')` is 0 and `Number('0x10')`
  // is 16, so a trailing slash — `"10.0.0.0/"`, an unset shell variable, a
  // typo — would silently become `10.0.0.0/0`: a route matching the entire
  // internet, which switches off both the peer check and the forwarded-chain
  // check and leaves the token alone in front of the ingress.
  if (!/^\d{1,3}$/.test(text)) return null

  const prefix = Number(text)
  if (prefix < 0 || prefix > full) return null
  // A host route of zero bits is never what an operator means by "also allow
  // these", and it is the shape the typo above produces. Refusing it turns a
  // silently-disabled check into a startup error.
  if (prefix === 0) return null
  return { address, prefix, type }
}

/**
 * The source addresses `POST /api/notify` accepts.
 *
 * Loopback is always in, and IPv4-mapped IPv6 peers match the IPv4 rules —
 * verified, not assumed. `allowFrom` covers the two shapes where the caller is
 * genuinely local but its source address is not loopback: a bind to one
 * specific non-loopback address, and a container reaching the host through the
 * bridge gateway. Both are cases where the alternative is a route nobody can
 * call. Opening them up does not weaken the route much, because the token is
 * still required and a browser still cannot send these requests at all.
 */
export function buildNotifyAllowList(allowFrom: string[]): net.BlockList {
  const list = new net.BlockList()
  list.addSubnet('127.0.0.0', 8, 'ipv4')
  list.addAddress('::1', 'ipv6')

  for (const entry of allowFrom) {
    const parsed = parseCidr(entry)
    if (parsed === null) throw new Error(`invalid notify.allowFrom entry: ${entry}`)
    if (parsed.prefix === (parsed.type === 'ipv6' ? 128 : 32)) {
      list.addAddress(parsed.address, parsed.type)
    } else {
      list.addSubnet(parsed.address, parsed.prefix, parsed.type)
    }
  }
  return list
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
/**
 * The first-run warning for a listen address, or null.
 *
 * `/api/auth/setup` refuses only once a password exists, so between the first
 * start and the moment the operator completes setup, an instance on a
 * reachable address can be claimed by whoever gets there first — and the
 * default bind is now 0.0.0.0. On a machine with a public address that window
 * is measured in seconds, because scanners find new listeners quickly.
 *
 * Not a refusal: setup genuinely has to happen over the network on a headless
 * box. It just has to be done deliberately, and before the port is reachable
 * from anywhere untrusted.
 */
export function unclaimedWarning(host: string): string | null {
  if (isLoopbackHost(host)) return null
  return (
    `no password set yet and this port is reachable from the network: until you ` +
    `complete setup, anyone who can reach ${host} can claim this instance and ` +
    `choose its password. Finish setup now, or restart with WEBMUX_HOST=127.0.0.1 ` +
    `and set it over loopback.`
  )
}

export function forwardedHeaderWarning(host: string, trustProxy: boolean): string | null {
  if (!trustProxy || isLoopbackHost(host)) return null
  return (
    `trustProxy is on while listening on ${host}: X-Forwarded-For is believed from ` +
    `anyone who can reach this port, so the per-IP login rate limit can be bypassed ` +
    `by forging it. Have the reverse proxy connect over 127.0.0.1 (or firewall the ` +
    `port to the proxy's address) and bind webmux to loopback.`
  )
}

/**
 * The warning for a deployment where "local only" has stopped meaning local,
 * or null when there is nothing to say.
 *
 * `POST /api/notify` decides whether a caller is on this machine from the
 * socket peer address, because `req.ip` is precisely the value a client can
 * forge (see `forwardedHeaderWarning` above). That test is sound, and it is
 * why the route also requires a bearer token and refuses any request carrying
 * an `Origin` header.
 *
 * What the address test cannot survive is a reverse proxy on the same host:
 * everything the proxy forwards, from anywhere, arrives with a loopback peer.
 * The route additionally requires every hop of a forwarded chain to be
 * loopback, which catches the usual `$proxy_add_x_forwarded_for` setup — but a
 * proxy that sends no X-Forwarded-For at all leaves the token as the only
 * thing between the route and anyone who can reach the instance.
 *
 * Keyed on `trustProxy` rather than on the bind address because that flag is
 * the operator's own statement that a proxy is in front. Warning on every
 * non-loopback bind instead would fire for the default `0.0.0.0` and be tuned
 * out by everyone it matters to.
 */
export function notifyProxyWarning(host: string, trustProxy: boolean): string | null {
  if (!trustProxy || isLoopbackHost(host)) return null
  return (
    `trustProxy is on, so a reverse proxy is forwarding to this instance: every ` +
    `proxied request reaches /api/notify with a loopback peer address, and its ` +
    `"local only" check therefore rests on the notify token alone. That is still ` +
    `a secret a web page cannot read, but if this port is reachable from a network ` +
    `you do not control, set notify.enabled=false or keep the token out of reach.`
  )
}

export interface NotifyConfig {
  enabled: boolean
  retentionDays: number
  maxStored: number
  /** 0 disables the ingest rate limit. */
  perMinute: number
  allowFrom: string[]
  push: {
    enabled: boolean
    subject: string
  }
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
  notify: NotifyConfig
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
    // 0.0.0.0 by default so a container port mapping or a reverse proxy on
    // another host works without configuration. It is also the exposed case:
    // the server speaks plain HTTP, so the boot warnings below exist to make
    // sure that is a decision rather than an accident. Set WEBMUX_HOST=127.0.0.1
    // when a proxy on the same host connects over loopback.
    host: e.WEBMUX_HOST ?? file.host ?? '0.0.0.0',
    port: e.WEBMUX_PORT ?? file.port ?? 8866,
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
    notify: {
      enabled: e.WEBMUX_NOTIFY_ENABLED ?? file.notify?.enabled ?? true,
      retentionDays: file.notify?.retentionDays ?? 30,
      maxStored: file.notify?.maxStored ?? 500,
      // A rate limit is the only thing protecting the browser and the push
      // service from a script that calls in a loop, so it is on by default.
      perMinute: e.WEBMUX_NOTIFY_PER_MINUTE ?? file.notify?.perMinute ?? 30,
      allowFrom: file.notify?.allowFrom ?? [],
      push: {
        enabled: e.WEBMUX_NOTIFY_PUSH_ENABLED ?? file.notify?.push?.enabled ?? true,
        // Some push services reject a `sub` that is not a contact address, and
        // the RFC allows either a mailto: or an https: URL. It never receives
        // mail; it exists so an operator of a push service can reach whoever
        // runs this instance about a misbehaving sender.
        subject: file.notify?.push?.subject ?? 'mailto:webmux@localhost',
      },
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
