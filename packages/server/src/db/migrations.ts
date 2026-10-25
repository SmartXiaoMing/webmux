import type { DB } from './index'

/**
 * Ordered schema migrations. Index N is applied to move the database from
 * `user_version = N` to `N + 1`. Never edit an entry that has shipped — append.
 */
export const migrations: Array<(db: DB) => void> = [
  // 1 — settings, session metadata, audit trail
  (db) => {
    db.exec(`
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- tmux is the runtime source of truth for which sessions exist; this
      -- table only carries the presentation metadata tmux does not model.
      CREATE TABLE sessions (
        id               TEXT PRIMARY KEY,
        title            TEXT NOT NULL,
        cwd              TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        last_attached_at INTEGER NOT NULL
      );

      CREATE TABLE audit (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        ts     INTEGER NOT NULL,
        action TEXT NOT NULL,
        detail TEXT,
        ip     TEXT
      );

      CREATE INDEX audit_ts_idx ON audit (ts DESC);
    `)
  },

  // 2 — public share links
  (db) => {
    db.exec(`
      CREATE TABLE shares (
        id             TEXT PRIMARY KEY,

        -- sha256 hex of the token. The token itself is never stored: it is
        -- shown once at creation and is unrecoverable afterwards, which is why
        -- the UI offers a regenerate.
        --
        -- Deliberately a FAST hash, and deliberately not the same treatment as
        -- password_hash below. The token is 256 bits from a CSPRNG, so a slow
        -- KDF adds nothing to a 2^256 preimage problem while making every
        -- *visitor request* cost 100 ms and 32 MB. A password's entropy comes
        -- from a human, so there cost-per-guess is the only lever that exists.
        -- Unifying the two "for consistency" breaks both at once.
        token_hash     TEXT NOT NULL UNIQUE,

        -- Literal path, matching how the rest of the API treats symlinks.
        path           TEXT NOT NULL,

        -- Snapshotted at creation so access can tell whether the share still
        -- points where it pointed. Without these, a share silently becomes a
        -- jail bypass the day a root is re-pointed at something else.
        root_name      TEXT NOT NULL,
        root_path      TEXT NOT NULL,
        name           TEXT NOT NULL,
        kind           TEXT NOT NULL CHECK (kind IN ('file', 'dir')),

        password_hash  TEXT,

        -- The lifetime as chosen, alongside the absolute expiry it produced.
        -- Regenerate needs it to restart the clock: copying expires_at verbatim
        -- would hand back a link that is born already dead, which is precisely
        -- the situation regenerate exists to fix. NULL means never expires.
        ttl_hours      INTEGER,
        expires_at     INTEGER,
        max_downloads  INTEGER,
        downloads      INTEGER NOT NULL DEFAULT 0,
        rate_limit_bps INTEGER,
        revoked_at     INTEGER,
        created_at     INTEGER NOT NULL,
        last_access_at INTEGER,
        last_access_ip TEXT
      );

      CREATE INDEX shares_token_idx ON shares (token_hash);
      CREATE INDEX shares_created_idx ON shares (created_at DESC);
    `)
  },

  // 3 — directories the operator returns to
  (db) => {
    db.exec(`
      -- One table with two nullable timestamps rather than two tables: a
      -- directory is routinely both a favourite and recently opened, and
      -- splitting them would mean reconciling the duplicate everywhere.
      CREATE TABLE places (
        path        TEXT PRIMARY KEY,

        -- Basename, kept for display so the sidebar does not have to parse a
        -- path to render a row.
        name        TEXT NOT NULL,

        -- NULL means "not a favourite" / "never opened". Both are stored as
        -- timestamps because the lists are ordered by recency, and ordering by
        -- a separate counter would mean maintaining one.
        favorite_at INTEGER,
        opened_at   INTEGER
      );

      CREATE INDEX places_favorite_idx ON places (favorite_at DESC);
      CREATE INDEX places_opened_idx ON places (opened_at DESC);
    `)
  },

  // 4 — user-defined macros for the accessory key bar
  (db) => {
    db.exec(`
      CREATE TABLE quick_keys (
        id         TEXT PRIMARY KEY,

        -- What the button says. Short by construction: the key bar is one row
        -- and must never grow vertically, so a caption is not free-form text.
        label      TEXT NOT NULL,

        -- What the button sends.
        text       TEXT NOT NULL,

        -- Append a carriage return, so one macro can either complete a fragment
        -- like the built-in "/" key, or run a whole command.
        send_enter INTEGER NOT NULL DEFAULT 0,

        -- Ordering only, and a timestamp rather than a maintained counter for
        -- the same reason as the places table: the list is short and is never
        -- reordered.
        created_at INTEGER NOT NULL
      );

      CREATE INDEX quick_keys_created_idx ON quick_keys (created_at);
    `)
  },

  // 5 — notifications and push subscriptions
  (db) => {
    db.exec(`
      -- Notifications raised by local callers (POST /api/notify) and delivered
      -- to browsers over /ws/events and to phones over Web Push.
      CREATE TABLE notifications (
        -- AUTOINCREMENT is load-bearing, not habit. This id is the cursor a
        -- reconnecting client sends back to be brought up to date, so a pruned
        -- row's id must never be handed to a new row: a plain INTEGER PRIMARY
        -- KEY reuses the largest id after the largest row is deleted, which
        -- would make a client silently skip everything until it caught up.
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        title      TEXT NOT NULL,
        body       TEXT,
        level      TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
        -- The terminal that raised it, when the caller knew. Enables
        -- click-to-jump; a deleted session just renders as a plain row.
        session_id TEXT,
        -- Who sent it: hostname, script name, whatever the caller said. For
        -- display only, and never trusted for anything.
        source     TEXT,
        read_at    INTEGER
      );

      CREATE INDEX notifications_created_idx ON notifications (created_at DESC);

      -- Partial, because the only query this serves is counting and fetching
      -- *unread* rows, and those are a small fraction of the table.
      CREATE INDEX notifications_unread_idx ON notifications (id) WHERE read_at IS NULL;

      -- One row per browser/device that has agreed to receive push messages.
      CREATE TABLE push_subscriptions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint     TEXT NOT NULL UNIQUE,
        p256dh       TEXT NOT NULL,
        auth         TEXT NOT NULL,
        ua           TEXT,
        -- The VAPID public key this subscription was created against. Push
        -- subscriptions are bound to the sender key: rotate the key and every
        -- existing row is undeliverable, so the row records which key it
        -- belongs to and the two are compared before each delivery.
        vapid_public TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        last_ok_at   INTEGER,
        failures     INTEGER NOT NULL DEFAULT 0,
        -- Set once the push service keeps refusing; the row is kept so the
        -- count shown in the UI does not silently drop to zero.
        disabled_at  INTEGER
      );

      CREATE INDEX push_subscriptions_live_idx ON push_subscriptions (disabled_at);
    `)
  },
]
