import { z } from 'zod'

/**
 * REST DTOs. Everything here is shared verbatim between the Fastify routes and
 * the React client, so a route/schema drift becomes a compile error rather
 * than a runtime surprise.
 */

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthStatus {
  /**
   * False on a fresh install — no password has been set yet. The client must
   * route to the setup screen. Exposing this is safe and deliberate: it only
   * reveals that the instance is unclaimed, which is obvious from the fact
   * that no credentials exist to log in with.
   */
  initialized: boolean
  authenticated: boolean
}

export const setupRequest = z.object({
  password: z.string().min(8, 'password must be at least 8 characters').max(1024),
})

export const loginRequest = z.object({
  password: z.string().min(1).max(1024),
})

export type SetupRequest = z.infer<typeof setupRequest>
export type LoginRequest = z.infer<typeof loginRequest>

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionSummary {
  id: string
  title: string
  /** Where the session was created. An input to the backend, not an observation. */
  cwd: string
  /**
   * Where the shell actually is now, as the backend last reported it.
   *
   * Seeded with `cwd` and refreshed out of band, so it is never null and never
   * costs a read anything — "unknown" is expressed as "last known", which is
   * the honest state.
   */
  liveCwd: string
  cols: number
  rows: number
  /**
   * The session this one was opened from, or null for a root.
   *
   * Always a *root* session when set: the tree is deliberately only one level
   * deep, so opening a shell from a child joins that child's root rather than
   * nesting further. A parent that no longer exists is treated as null by the
   * client — see the tree building in SessionList.
   */
  parentId: string | null
  /** Number of attached WebSocket clients, across all browsers and devices. */
  clients: number
  createdAt: number
  lastAttachedAt: number
  /** False once the shell inside tmux has exited. */
  running: boolean
}

export const createSessionRequest = z.object({
  title: z.string().min(1).max(128).optional(),
  cwd: z.string().min(1).max(4096).optional(),
  cols: z.number().int().min(2).max(1000).optional(),
  rows: z.number().int().min(2).max(1000).optional(),
  /** The session this is being opened from. The server resolves the root. */
  parentId: z.string().min(1).max(128).optional(),
})

export type CreateSessionRequest = z.infer<typeof createSessionRequest>

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Chunk size for resumable uploads. Shared so the client's progress maths and
 * the server's per-request body limit cannot drift apart; the server still
 * echoes the authoritative value it actually used from `init`.
 */
export const FS_UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024

/** What a directory entry actually is. */
export type FsEntryKind = 'file' | 'dir' | 'symlink' | 'other'

export interface FsRoot {
  name: string
  /** Canonical absolute path, with symlinks resolved. */
  path: string
  readonly: boolean
  /**
   * A configured root can be unusable — an unmounted drive, a volume that has
   * not been attached yet. It stays in the list so the UI can say why, rather
   * than silently disappearing.
   */
  available: boolean
  unavailableReason?: string
}

/** How the server will render a file inline, or null when it will not. */
export type FsPreviewKind = 'image' | 'text' | 'pdf' | 'media' | null

export interface FsEntry {
  name: string
  /**
   * The literal path. For a symlink this is the link itself rather than its
   * target, so deleting or renaming what is on screen does what it says.
   */
  path: string
  kind: FsEntryKind
  /** Bytes. Zero for directories. */
  size: number
  mtimeMs: number
  hidden: boolean
  /**
   * Decided by the server's allowlist, so a client never keeps a second copy
   * of a security-relevant list. Null means "download, do not render".
   */
  preview: FsPreviewKind
  /** Name of the root this entry lives under. */
  root: string
}

export interface FsStat extends FsEntry {
  readonly: boolean
  /** Set when this entry is a symlink that resolves to somewhere inside the jail. */
  linkTarget?: string
}

export interface FsListing {
  path: string
  root: string
  readonly: boolean
  entries: FsEntry[]
  /** Opaque. Pass back verbatim for the next page; null at the end. */
  nextCursor: string | null
  /** Entries in the directory before pagination. */
  total: number
}

/** Half-open [start, end) byte range the server already holds. */
export type FsByteRange = [number, number]

export interface FsUploadStatus {
  uploadId: string
  /** Destination path, as the client asked for it. */
  path: string
  size: number
  chunkSize: number
  /** Merged and ascending, so a client can iterate them directly. */
  received: FsByteRange[]
  bytesReceived: number
  expiresAt: number
  complete: boolean
}

export type FsUploadInit = FsUploadStatus

export const fsSortKeys = ['name', 'size', 'mtime', 'kind'] as const
export type FsSort = (typeof fsSortKeys)[number]

/**
 * Query-string booleans, where every value is a string — including "false".
 * `z.coerce.boolean()` would turn "false" into `true`, because
 * `Boolean('false') === true`. That is the classic way this gets written wrong.
 */
const queryBool = (fallback: boolean) =>
  z
    .enum(['1', 'true', '0', 'false'])
    .transform((v) => v === '1' || v === 'true')
    // `.default` takes the post-transform type here, and is substituted for an
    // absent value without re-running the transform.
    .default(fallback)

export const fsListQuery = z.object({
  path: z.string().min(1).max(4096),
  sort: z.enum(fsSortKeys).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  cursor: z.string().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  showHidden: queryBool(true),
})

export const fsStatQuery = z.object({
  path: z.string().min(1).max(4096),
})

export const fsDownloadQuery = z.object({
  path: z.string().min(1).max(4096),
})

/** Same shape as a download; the server decides whether the type may render inline. */
export const fsPreviewQuery = fsDownloadQuery

export const fsMkdirRequest = z.object({
  path: z.string().min(1).max(4096),
  recursive: z.boolean().default(false),
})

/**
 * `touch`, but create-only: an existing path is refused rather than having its
 * mtime bumped. See the route for why.
 */
export const fsTouchRequest = z.object({
  path: z.string().min(1).max(4096),
})

export const fsRenameRequest = z.object({
  from: z.string().min(1).max(4096),
  to: z.string().min(1).max(4096),
  overwrite: z.boolean().default(false),
})

export const fsDeleteQuery = z.object({
  path: z.string().min(1).max(4096),
  /**
   * Recursion is opt-in. A bare delete of a directory is refused so that a
   * mistyped path can never silently destroy a tree.
   */
  recursive: queryBool(false),
})

export const fsArchiveQuery = z.object({
  path: z.string().min(1).max(4096),
  /** An enum so adding a second format later is not a breaking change. */
  format: z.enum(['zip']).default('zip'),
})

/**
 * Exactly one of `path` / `uploadId`.
 *
 * `uploadId` reuses the resumable staging area, so a large archive transfers
 * with resume, is garbage-collected when abandoned, and needs no new body
 * parser — and the staged file is already seekable, which is what a zip reader
 * wants.
 */
export const fsExtractRequest = z
  .object({
    /** An archive already inside the jail. */
    path: z.string().min(1).max(4096).optional(),
    uploadId: z.string().min(1).max(64).optional(),
    /** Full path of the directory to create. Must not already exist. */
    dest: z.string().min(1).max(4096),
  })
  .refine((value) => (value.path === undefined) !== (value.uploadId === undefined), {
    message: 'exactly one of path or uploadId is required',
  })

export const fsUploadInitRequest = z.object({
  path: z.string().min(1).max(4096),
  size: z.number().int().nonnegative(),
  /**
   * Optional caller-supplied identity for the upload, so a client that
   * restarts can ask the server whether it already knows about this file.
   */
  clientKey: z.string().min(8).max(64).optional(),
})

export const fsUploadChunkQuery = z.object({
  offset: z.coerce.number().int().nonnegative(),
})

export const fsUploadCompleteRequest = z.object({
  overwrite: z.boolean().default(false),
})

export type FsListQuery = z.infer<typeof fsListQuery>
export type FsStatQuery = z.infer<typeof fsStatQuery>
export type FsDownloadQuery = z.infer<typeof fsDownloadQuery>
export type FsMkdirRequest = z.infer<typeof fsMkdirRequest>
export type FsRenameRequest = z.infer<typeof fsRenameRequest>
export type FsDeleteQuery = z.infer<typeof fsDeleteQuery>
export type FsUploadInitRequest = z.infer<typeof fsUploadInitRequest>
export type FsUploadChunkQuery = z.infer<typeof fsUploadChunkQuery>
export type FsUploadCompleteRequest = z.infer<typeof fsUploadCompleteRequest>

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

export interface Place {
  /** Canonical absolute path — what the file browser navigates to. */
  path: string
  /** Basename, for display. */
  name: string
  favorite: boolean
  lastOpenedAt: number | null
}

export interface PlacesResponse {
  favorites: Place[]
  /** Most recently opened, newest first. Overlaps with `favorites` by design. */
  recent: Place[]
  limits: { maxFavorites: number; maxRecent: number }
}

/**
 * An explicit value rather than a toggle: a retried request would flip a
 * toggle back, leaving the user with the opposite of what they asked for.
 */
export const placeFavoriteRequest = z.object({
  path: z.string().min(1).max(4096),
  favorite: z.boolean(),
})

export const placeOpenedRequest = z.object({
  path: z.string().min(1).max(4096),
})

export type PlaceFavoriteRequest = z.infer<typeof placeFavoriteRequest>
export type PlaceOpenedRequest = z.infer<typeof placeOpenedRequest>

// ---------------------------------------------------------------------------
// Quick keys
// ---------------------------------------------------------------------------

/** A user-defined button on the accessory key bar. */
export interface QuickKey {
  id: string
  /** The button's caption. Short: the bar is a single row. */
  label: string
  /** What pressing it sends. */
  text: string
  /**
   * Append a carriage return after `text`. False types a fragment, like the
   * built-in `/` key; true runs the line.
   */
  sendEnter: boolean
}

export interface QuickKeysResponse {
  keys: QuickKey[]
  limits: { maxKeys: number }
}

/**
 * Note the absence of a newline ban on `text`: the editor is a single-line
 * input, so the UI cannot produce one, and policing a case that cannot be
 * reached would only add a rule to keep in step.
 */
export const quickKeyRequest = z.object({
  label: z.string().trim().min(1).max(12),
  text: z.string().min(1).max(256),
  sendEnter: z.boolean().default(true),
})

export type QuickKeyRequest = z.infer<typeof quickKeyRequest>

// ---------------------------------------------------------------------------
// Shares
// ---------------------------------------------------------------------------

export interface ShareSummary {
  id: string
  /** Basename only — the display name. */
  name: string
  /** Full path. Owner-only routes, never the public page. */
  path: string
  root: string
  kind: 'file' | 'dir'
  /** Null for a directory: unknown without walking it, which this does not do. */
  size: number | null
  createdAt: number
  expiresAt: number | null
  maxDownloads: number | null
  downloads: number
  /** Resolved against the configured default. */
  rateLimitBytesPerSec: number
  /** Whether a password is set. Never the hash, and never the password. */
  password: boolean
  revoked: boolean
  /** Still usable: not revoked, not expired, not exhausted. */
  active: boolean
  /** False when the underlying file or root no longer resolves. */
  available: boolean
  lastAccessAt: number | null
  lastAccessIp: string | null
}

/**
 * Returned exactly once, at creation.
 *
 * The database holds only a hash of the token, so this is the only time the URL
 * exists in a response. That is why the UI offers a regenerate: losing it is one
 * click to replace, not a re-do of the dialog.
 */
export interface ShareCreated extends ShareSummary {
  token: string
  /**
   * Relative on purpose. An absolute URL would have to be derived from the
   * `Host` header, which is attacker-controlled on a misconfigured deployment;
   * the client resolves this against the origin it actually reached.
   */
  url: string
}

export interface SharesConfigDefaults {
  enabled: boolean
  defaultTtlHours: number
  maxActive: number
  defaultRateLimitBytesPerSec: number
  inlinePreview: boolean
}

export interface SharesResponse {
  shares: ShareSummary[]
  /** So the create form can prefill without a fifth route. */
  config: SharesConfigDefaults
}

export const shareCreateRequest = z.object({
  path: z.string().min(1).max(4096),
  /**
   * A duration rather than an absolute timestamp: the server computes from its
   * own clock, so client skew cannot produce an already-dead link. Null means
   * it never expires; absent means the configured default.
   */
  expiresInHours: z.number().int().min(1).max(24 * 365).nullable().optional(),
  maxDownloads: z.number().int().min(1).max(1_000_000).nullable().optional(),
  /**
   * Floor of 1 KiB so a typo cannot create a link that never finishes.
   *
   * `2 ** 40`, not `1 << 40`: JavaScript's shift operators are 32-bit, so
   * `1 << 40` is `1 << 8` — 256 — and the ceiling would have rejected every
   * useful rate.
   */
  rateLimitBytesPerSec: z.number().int().min(1024).max(2 ** 40).nullable().optional(),
  /** Minimum 8, matching the instance password: a link can be forwarded. */
  password: z.string().min(8).max(1024).optional(),
})

export type ShareCreateRequest = z.infer<typeof shareCreateRequest>

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ApiError {
  error: {
    code: string
    message: string
  }
}
