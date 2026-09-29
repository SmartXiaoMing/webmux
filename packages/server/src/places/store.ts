import type { DB } from '../db/index'

/**
 * Directories the operator returns to.
 *
 * Pure database access, no Fastify — same shape as `shares/store.ts`, so the
 * ordering and trimming rules can be exercised without a server.
 */

export interface PlaceRow {
  path: string
  name: string
  /** Null means "not a favourite". */
  favorite_at: number | null
  /** Null means "never opened". */
  opened_at: number | null
}

/** Bounds so neither list can grow without limit. */
export const MAX_FAVORITES = 50
export const MAX_RECENT = 20

export class PlaceStore {
  constructor(private readonly db: DB) {}

  listFavorites(): PlaceRow[] {
    return this.db
      .prepare('SELECT * FROM places WHERE favorite_at IS NOT NULL ORDER BY favorite_at DESC')
      .all() as PlaceRow[]
  }

  listRecent(): PlaceRow[] {
    return this.db
      .prepare('SELECT * FROM places WHERE opened_at IS NOT NULL ORDER BY opened_at DESC LIMIT ?')
      .all(MAX_RECENT) as PlaceRow[]
  }

  /**
   * Sets the flag explicitly rather than toggling.
   *
   * A toggle makes a retried request flip the value back, so a client that
   * times out and retries ends up with the opposite of what the user asked for.
   */
  setFavorite(target: string, name: string, favorite: boolean, now = Date.now()): void {
    if (favorite) {
      this.db
        .prepare(
          `INSERT INTO places (path, name, favorite_at) VALUES (?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET favorite_at = excluded.favorite_at, name = excluded.name`,
        )
        .run(target, name, now)

      this.keepNewest('favorite_at', MAX_FAVORITES)
    } else {
      this.db.prepare('UPDATE places SET favorite_at = NULL WHERE path = ?').run(target)
    }

    this.dropDeadRows()
  }

  recordOpened(target: string, name: string, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO places (path, name, opened_at) VALUES (?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET opened_at = excluded.opened_at, name = excluded.name`,
      )
      .run(target, name, now)

    this.keepNewest('opened_at', MAX_RECENT)
    this.dropDeadRows()
  }

  /**
   * Forgets the timestamp on rows past the cap.
   *
   * Deliberately clears the column rather than deleting the row: a directory
   * that fell off the recent list may still be a favourite, and deleting the
   * row would silently un-favourite it.
   */
  private keepNewest(column: 'favorite_at' | 'opened_at', limit: number): void {
    this.db
      .prepare(
        `UPDATE places SET ${column} = NULL
          WHERE ${column} IS NOT NULL
            AND path NOT IN (
              SELECT path FROM places WHERE ${column} IS NOT NULL ORDER BY ${column} DESC LIMIT ?
            )`,
      )
      .run(limit)
  }

  /** A row that is neither a favourite nor recently opened is dead weight. */
  private dropDeadRows(): void {
    this.db.prepare('DELETE FROM places WHERE favorite_at IS NULL AND opened_at IS NULL').run()
  }
}
