/**
 * Minimal leveled logger. Deliberately dependency-free — the server has few
 * enough log sites that a full structured-logging library would be more
 * configuration than it is worth.
 */

type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const threshold: number = LEVELS[(process.env.WEBMUX_LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return
  const ts = new Date().toISOString()
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`
  const sink = level === 'error' || level === 'warn' ? console.error : console.log
  if (extra === undefined) sink(line)
  else sink(line, extra)
}

export interface Logger {
  debug(msg: string, extra?: unknown): void
  info(msg: string, extra?: unknown): void
  warn(msg: string, extra?: unknown): void
  error(msg: string, extra?: unknown): void
  child(scope: string): Logger
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
    child: (sub) => createLogger(`${scope}:${sub}`),
  }
}

export const logger = createLogger('webmux')
