import { randomBytes } from 'node:crypto'
import { chmodSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getSetting, setSetting, type DB } from '../db/index'

/**
 * The bearer token `POST /api/notify` requires.
 *
 * The route's address checks establish that a caller is on this machine. That
 * is not the same as establishing that the caller is not a web page: every
 * page the operator visits can send a POST to 127.0.0.1, and the same-origin
 * policy stops the page reading the response, not the request from being made.
 * The refusal to accept any request carrying an `Origin` header closes that
 * off; the token is what is left for a caller that is genuinely local.
 *
 * Stored in `settings` like the other secrets, and mirrored to a file because
 * the callers are shell scripts: making them read SQLite to find the token
 * would be a cruel joke.
 */
const SETTING_KEY = 'notify.token'

export function getOrCreateNotifyToken(db: DB): string {
  const existing = getSetting(db, SETTING_KEY)
  if (existing !== null) return existing

  const token = randomBytes(32).toString('base64url')
  setSetting(db, SETTING_KEY, token)
  return token
}

export function notifyTokenPath(dataDir: string): string {
  return path.join(dataDir, 'notify-token')
}

/**
 * Writes the token where the CLI can find it.
 *
 * `mode` only applies at creation, so a file left behind by an earlier install
 * — or created by an editor, or restored from a backup — keeps whatever mode
 * it had. The explicit chmod is what actually enforces this, and it is the
 * difference between a secret and a world-readable secret.
 */
export function writeNotifyTokenFile(dataDir: string, token: string): string {
  const file = notifyTokenPath(dataDir)
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  return file
}
