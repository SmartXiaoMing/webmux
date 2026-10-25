import { renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Config } from './config'

/** What the CLI needs in order to find this instance. */
export interface RuntimeInfo {
  url: string
  host: string
  port: number
  pid: number
  startedAt: number
  dataDir: string
  tokenFile: string
}

export function runtimeFilePath(dataDir: string): string {
  return path.join(dataDir, 'runtime.json')
}

/**
 * The address a local CLI should dial.
 *
 * Never `localhost`. Node resolves it through getaddrinfo, which on a host
 * that prefers IPv6 answers `::1` first — while the default bind is the
 * IPv4-only `0.0.0.0`, so the connection is refused. The literal address the
 * server actually bound to has no such ambiguity, and for a wildcard bind the
 * loopback literal is what reaches it.
 */
function cliUrl(host: string, port: number): string {
  const dial =
    host === '' || host === '0.0.0.0' || host === '::'
      ? '127.0.0.1'
      : host.replace(/^\[|\]$/g, '')
  return `http://${dial.includes(':') ? `[${dial}]` : dial}:${port}`
}

/**
 * Publishes where this instance is listening, so `webmux notify` can find it
 * without re-deriving the configuration.
 *
 * A file rather than an environment variable because the callers are shells
 * that were started long before this process, and because a non-default port
 * or data directory has to be discoverable somehow.
 *
 * Written to a temporary name and renamed: the CLI may read it at any moment,
 * and a reader that catches a half-written file would report a corrupt port
 * rather than a missing server.
 */
export function writeRuntimeFile(config: Config, tokenFile: string): RuntimeInfo {
  const info: RuntimeInfo = {
    url: cliUrl(config.host, config.port),
    host: config.host,
    port: config.port,
    pid: process.pid,
    startedAt: Date.now(),
    dataDir: config.dataDir,
    tokenFile,
  }

  const target = runtimeFilePath(config.dataDir)
  const temporary = `${target}.tmp`
  writeFileSync(temporary, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, target)
  return info
}
