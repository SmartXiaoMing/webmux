import { randomUUID } from 'node:crypto'
import type { DB } from '../db/index'
import { generateShareToken, hashShareToken } from './tokens'

/**
 * Persistence for share links.
 *
 * The row is the authority for every access decision. A valid unlock cookie
 * only proves we minted it; `revoked_at`, `expires_at`, the root snapshot and
 * the download count are re-read from here on every request. A share feature
 * that trusts its own cookie is a revocation bypass wearing a costume.
 */

export interface ShareRow {
  id: string
  token_hash: string
  path: string
  root_name: string
  root_path: string
  name: string
  kind: 'file' | 'dir'
  password_hash: string | null
  ttl_hours: number | null
  expires_at: number | null
  max_downloads: number | null
  downloads: number
  rate_limit_bps: number | null
  revoked_at: number | null
  created_at: number
  last_access_at: number | null
  last_access_ip: string | null
}

export interface CreateShareInput {
  path: string
  rootName: string
  rootPath: string
  name: string
  kind: 'file' | 'dir'
  /** Null means the link never expires. */
  ttlHours: number | null
  maxDownloads: number | null
  passwordHash: string | null
  rateLimitBps: number | null
}

const HOUR_MS = 3_600_000

function expiryFor(ttlHours: number | null, now: number): number | null {
  return ttlHours === null ? null : now + ttlHours * HOUR_MS
}

export class ShareStore {
  constructor(private readonly db: DB) {}

  private insert(input: CreateShareInput, tokenHash: string, now: number): ShareRow {
    const row: ShareRow = {
      id: randomUUID(),
      token_hash: tokenHash,
      path: input.path,
      root_name: input.rootName,
      root_path: input.rootPath,
      name: input.name,
      kind: input.kind,
      password_hash: input.passwordHash,
      ttl_hours: input.ttlHours,
      expires_at: expiryFor(input.ttlHours, now),
      max_downloads: input.maxDownloads,
      downloads: 0,
      rate_limit_bps: input.rateLimitBps,
      revoked_at: null,
      created_at: now,
      last_access_at: null,
      last_access_ip: null,
    }

    this.db
      .prepare(
        `INSERT INTO shares (
           id, token_hash, path, root_name, root_path, name, kind, password_hash,
           ttl_hours, expires_at, max_downloads, downloads, rate_limit_bps,
           revoked_at, created_at, last_access_at, last_access_ip
         ) VALUES (
           @id, @token_hash, @path, @root_name, @root_path, @name, @kind, @password_hash,
           @ttl_hours, @expires_at, @max_downloads, @downloads, @rate_limit_bps,
           @revoked_at, @created_at, @last_access_at, @last_access_ip
         )`,
      )
      .run(row)

    return row
  }

  /** Returns the row and the one and only sight of the token. */
  create(input: CreateShareInput, now = Date.now()): { row: ShareRow; token: string } {
    const token = generateShareToken()
    return { row: this.insert(input, hashShareToken(token), now), token }
  }

  byToken(token: string): ShareRow | null {
    return (
      (this.db.prepare('SELECT * FROM shares WHERE token_hash = ?').get(hashShareToken(token)) as
        | ShareRow
        | undefined) ?? null
    )
  }

  byId(id: string): ShareRow | null {
    return (this.db.prepare('SELECT * FROM shares WHERE id = ?').get(id) as ShareRow | undefined) ?? null
  }

  list(): ShareRow[] {
    // Everything, including dead rows: the owner should see "expired 3 days
    // ago" rather than have a share silently vanish and wonder if they deleted
    // it. Ordering puts the usable ones first.
    return this.db
      .prepare(
        `SELECT * FROM shares
          ORDER BY (revoked_at IS NULL) DESC, (expires_at IS NULL OR expires_at > ?) DESC, created_at DESC`,
      )
      .all(Date.now()) as ShareRow[]
  }

  /** Soft revoke. The row survives so the list and the audit trail still resolve. */
  revoke(id: string, now = Date.now()): boolean {
    const result = this.db
      .prepare('UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(now, id)
    return result.changes > 0
  }

  /**
   * Issues a fresh token for an existing share, keeping its policy.
   *
   * One server-side transaction, never a client-side revoke-then-create: if the
   * create failed after the revoke succeeded, the owner would have lost the
   * share with no replacement — exactly the outcome this exists to prevent.
   *
   * The expiry clock restarts from `ttl_hours`, so a link regenerated the day
   * before it lapsed is not born already dead.
   */
  regenerate(id: string, now = Date.now()): { row: ShareRow; token: string } | null {
    const run = this.db.transaction((): { row: ShareRow; token: string } | null => {
      const old = this.byId(id)
      if (old === null || old.revoked_at !== null) return null

      const token = generateShareToken()
      this.db.prepare('UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id)

      return {
        row: this.insert(
          {
            path: old.path,
            rootName: old.root_name,
            rootPath: old.root_path,
            name: old.name,
            kind: old.kind,
            ttlHours: old.ttl_hours,
            maxDownloads: old.max_downloads,
            passwordHash: old.password_hash,
            rateLimitBps: old.rate_limit_bps,
          },
          hashShareToken(token),
          now,
        ),
        token,
      }
    })

    return run()
  }

  /**
   * Consumes one download, atomically, or refuses.
   *
   * The condition is evaluated by SQLite inside a single statement, so no
   * interleaving is possible. The naive read-then-write is not merely
   * off-by-one under concurrency: between the SELECT and the UPDATE the route
   * awaits a resolve, an open and possibly a scrypt, and the event loop
   * interleaves freely — so for `maxDownloads: 1` every concurrent request
   * reads 0, every one proceeds, and the control is *entirely* defeated.
   *
   * `better-sqlite3` detail: this uses `.get()`, not `.run()`. `.run()` reports
   * `changes` but does not return the row; `.get()` executes the UPDATE and
   * returns the first RETURNING row, or undefined. A returned row is success.
   *
   * Honest framing for whoever reads this next: **the cap is a leak-limiting
   * courtesy, not an enforcement boundary.** A client that starts every range
   * at byte 1 counts once and still receives 99.99% of the file. Expiry, the
   * rate limit and revocation are the controls; this is "the link stops working
   * after N people have had it".
   */
  claimDownload(id: string, now = Date.now()): number | null {
    const row = this.db
      .prepare(
        `UPDATE shares SET downloads = downloads + 1
          WHERE id = ?
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)
            AND (max_downloads IS NULL OR downloads < max_downloads)
        RETURNING downloads`,
      )
      .get(id, now) as { downloads: number } | undefined

    return row === undefined ? null : row.downloads
  }

  touch(id: string, ip: string | null, now = Date.now()): void {
    this.db.prepare('UPDATE shares SET last_access_at = ?, last_access_ip = ? WHERE id = ?').run(now, ip, id)
  }

  /** Usable shares — revoked, expired and exhausted ones free their slot. */
  countActive(now = Date.now()): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM shares
          WHERE revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)
            AND (max_downloads IS NULL OR downloads < max_downloads)`,
      )
      .get(now) as { n: number }
    return row.n
  }

  /**
   * Drops rows that have been dead longer than the retention window.
   *
   * Only the interval trigger needs this, unlike the upload staging area which
   * also needs a boot pass — a staging directory stranded by a SIGKILL is
   * something nothing else will ever find, whereas every share is a row.
   */
  sweep(now = Date.now(), retentionDays = 30): number {
    const cutoff = now - retentionDays * 24 * HOUR_MS
    const result = this.db
      .prepare(
        `DELETE FROM shares
          WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
             OR (expires_at IS NOT NULL AND expires_at < ?)`,
      )
      .run(cutoff, cutoff)
    return result.changes
  }
}
