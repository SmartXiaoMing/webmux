import type { DB } from './db/index'
import { logger } from './logger'

/**
 * Append-only trail of security-relevant events. For a service that hands out
 * a shell, "who authenticated and when" is the one record worth keeping even
 * in a single-user deployment — it is how you notice that someone else is.
 */
export function audit(db: DB, action: string, detail: string | null, ip: string | null): void {
  try {
    db.prepare('INSERT INTO audit (ts, action, detail, ip) VALUES (?, ?, ?, ?)').run(
      Date.now(),
      action,
      detail,
      ip,
    )
  } catch (err) {
    // Never let bookkeeping break the request it is describing.
    logger.warn(`failed to write audit entry for ${action}`, err)
  }
}
