import Database from 'better-sqlite3'
import path from 'node:path'
import { logger } from '../logger'
import { migrations } from './migrations'

export type DB = Database.Database

/**
 * Opens (creating if needed) the SQLite database and brings the schema up to
 * date. `user_version` tracks the migration cursor — SQLite stores it in the
 * file header, so no bookkeeping table is required.
 */
export function openDatabase(dataDir: string): DB {
  const file = path.join(dataDir, 'webmux.db')
  const db = new Database(file)

  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')

  const from = db.pragma('user_version', { simple: true }) as number

  for (let v = from; v < migrations.length; v++) {
    const migrate = migrations[v]
    if (!migrate) continue
    const target = v + 1
    logger.info(`applying migration ${target}/${migrations.length}`)
    // Each migration runs in its own transaction so a failure leaves the
    // database on the last good version rather than half-migrated.
    db.transaction(() => {
      migrate(db)
      db.pragma(`user_version = ${target}`)
    })()
  }

  return db
}

// ---------------------------------------------------------------------------
// settings — a tiny key/value store for auth material and instance state
// ---------------------------------------------------------------------------

export function getSetting(db: DB, key: string): string | null {
  const row = db.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?').get(key)
  return row?.value ?? null
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}

export function deleteSetting(db: DB, key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key)
}
