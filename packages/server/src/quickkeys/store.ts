import { randomBytes } from 'node:crypto'
import type { DB } from '../db/index'

/**
 * User-defined macros for the accessory key bar.
 *
 * Pure database access, no Fastify — same shape as `places/store.ts`, so the
 * ordering rules can be exercised without a server.
 *
 * Unlike `places`, nothing here trims or caps: silently discarding a key the
 * user just created is hostile in a way that silently dropping a stale
 * favourite is not. The cap is checked by the route, which can refuse
 * explicitly, and by the editor, which disables its own button.
 */

export interface QuickKeyRow {
  id: string
  label: string
  text: string
  /** SQLite has no boolean; 0 or 1. */
  send_enter: number
}

/**
 * Named rather than `SELECT *`, so a row that comes back is exactly the shape
 * `QuickKeyRow` promises. `created_at` is an ordering key, not part of a key,
 * and a `*` here would let it leak into the API response by accident.
 */
const COLUMNS = 'id, label, text, send_enter'

/**
 * Bounds so the bar stays a bar.
 *
 * The per-field lengths live in `quickKeyRequest` instead, since the request
 * schema is what actually enforces them — duplicating them here would only
 * create a second number to keep in step.
 */
export const MAX_QUICK_KEYS = 12

export class QuickKeyStore {
  constructor(private readonly db: DB) {}

  /**
   * Oldest first, so the bar reads in the order the keys were created.
   *
   * The id tiebreak is not decoration: two keys created in the same
   * millisecond — which a script or a fast double-tap will do — would
   * otherwise come back in whatever order SQLite felt like, and the bar would
   * reshuffle between loads.
   */
  list(): QuickKeyRow[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM quick_keys ORDER BY created_at ASC, id ASC`)
      .all() as QuickKeyRow[]
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM quick_keys').get() as { n: number }
    return row.n
  }

  create(label: string, text: string, sendEnter: boolean, now = Date.now()): QuickKeyRow {
    // Same shape as `newSessionId`: short, URL-safe, and wide enough that a
    // collision is not worth defending against at this scale.
    const id = randomBytes(5).toString('hex')
    this.db
      .prepare(
        'INSERT INTO quick_keys (id, label, text, send_enter, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, label, text, sendEnter ? 1 : 0, now)

    return { id, label, text, send_enter: sendEnter ? 1 : 0 }
  }

  /**
   * Replaces all three fields, and preserves `created_at` so editing a key does
   * not move it to the end of the bar.
   *
   * Returns null for an unknown id, so the route can answer 404 rather than
   * pretending it succeeded.
   */
  update(id: string, label: string, text: string, sendEnter: boolean): QuickKeyRow | null {
    const result = this.db
      .prepare('UPDATE quick_keys SET label = ?, text = ?, send_enter = ? WHERE id = ?')
      .run(label, text, sendEnter ? 1 : 0, id)

    if (result.changes === 0) return null
    return { id, label, text, send_enter: sendEnter ? 1 : 0 }
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM quick_keys WHERE id = ?').run(id).changes > 0
  }
}
