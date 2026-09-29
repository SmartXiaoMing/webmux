import type {
  AuthStatus,
  CreateSessionRequest,
  FsListing,
  FsRoot,
  FsSort,
  FsStat,
  FsUploadStatus,
  PlacesResponse,
  QuickKeyRequest,
  QuickKeysResponse,
  SessionSummary,
  ShareCreateRequest,
  ShareCreated,
  SharesResponse,
} from '@webmux/shared'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      // The session lives in an httpOnly cookie, so it has to ride along on
      // every call — including same-origin ones.
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
  } catch {
    throw new ApiError(0, 'network', '无法连接到服务器')
  }

  if (res.status === 204) return undefined as T

  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      throw new ApiError(res.status, 'malformed', '服务器返回了无法解析的响应')
    }
  }

  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error
    throw new ApiError(res.status, err?.code ?? 'unknown', err?.message ?? `请求失败 (${res.status})`)
  }

  return body as T
}

export const api = {
  authStatus: () => request<AuthStatus>('/api/auth/status'),

  setup: (password: string) =>
    request<{ ok: true }>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  login: (password: string) =>
    request<{ ok: true }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  changePassword: (current: string, next: string) =>
    request<{ ok: true }>('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ current, next }),
    }),

  listSessions: () => request<SessionSummary[]>('/api/sessions'),

  createSession: (input: CreateSessionRequest = {}) =>
    request<SessionSummary>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  renameSession: (id: string, title: string) =>
    request<SessionSummary>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  killSession: (id: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  listRoots: () => request<{ roots: FsRoot[] }>('/api/fs/roots'),

  listFiles: (
    path: string,
    opts: { sort?: FsSort; order?: 'asc' | 'desc'; cursor?: string | null; limit?: number; showHidden?: boolean } = {},
  ) => {
    const query = new URLSearchParams({ path })
    if (opts.sort) query.set('sort', opts.sort)
    if (opts.order) query.set('order', opts.order)
    if (opts.cursor) query.set('cursor', opts.cursor)
    if (opts.limit) query.set('limit', String(opts.limit))
    if (opts.showHidden === false) query.set('showHidden', '0')
    return request<FsListing>(`/api/fs/list?${query}`)
  },

  statFile: (path: string) => request<FsStat>(`/api/fs/stat?path=${encodeURIComponent(path)}`),

  createDirectory: (path: string, recursive = false) =>
    request<FsStat>('/api/fs/mkdir', { method: 'POST', body: JSON.stringify({ path, recursive }) }),

  /** `touch`, but create-only: an existing path is a 409 rather than an mtime bump. */
  createFile: (path: string) =>
    request<FsStat>('/api/fs/touch', { method: 'POST', body: JSON.stringify({ path }) }),

  /**
   * Saves an edited text file.
   *
   * `baseMtimeMs` is the mtime the editor loaded. The server answers 409 when
   * the file has changed since, which is all that stands between a tab left
   * open overnight and someone else's edit being silently overwritten.
   */
  saveFileText: (path: string, text: string, baseMtimeMs?: number) =>
    request<FsStat>('/api/fs/content', {
      method: 'PUT',
      body: JSON.stringify({ path, text, ...(baseMtimeMs !== undefined ? { baseMtimeMs } : {}) }),
    }),

  extract: (input: { path: string } | { uploadId: string }, dest: string) =>
    request<FsStat & { files: number; directories: number; bytes: number }>('/api/fs/extract', {
      method: 'POST',
      body: JSON.stringify({ ...input, dest }),
    }),

  renameEntry: (from: string, to: string, overwrite = false) =>
    request<FsStat>('/api/fs/rename', { method: 'POST', body: JSON.stringify({ from, to, overwrite }) }),

  deleteEntry: (path: string, recursive = false) =>
    request<void>(`/api/fs?path=${encodeURIComponent(path)}&recursive=${recursive ? 'true' : 'false'}`, {
      method: 'DELETE',
    }),

  uploadInit: (path: string, size: number) =>
    request<FsUploadStatus>('/api/fs/upload/init', {
      method: 'POST',
      body: JSON.stringify({ path, size }),
    }),

  /** What the server already holds — how an upload resumes after a reload. */
  uploadStatus: (uploadId: string) =>
    request<FsUploadStatus>(`/api/fs/upload/${encodeURIComponent(uploadId)}`),

  uploadComplete: (uploadId: string, overwrite = false) =>
    request<FsStat>(`/api/fs/upload/${encodeURIComponent(uploadId)}/complete`, {
      method: 'POST',
      body: JSON.stringify({ overwrite }),
    }),

  uploadAbort: (uploadId: string) =>
    request<void>(`/api/fs/upload/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }),

  /**
   * A plain navigation target, not a fetch.
   *
   * Handing this to an `<a download>` lets the browser do the saving, with its
   * own progress UI and its own resume. Fetching into a Blob would buffer the
   * entire file in memory — ruinous for exactly the large files this exists
   * for — and would lose resumability.
   */
  downloadUrl: (path: string) => `/api/fs/download?path=${encodeURIComponent(path)}`,

  /** Renders inline when the server's allowlist permits it, downloads when it does not. */
  previewUrl: (path: string) => `/api/fs/preview?path=${encodeURIComponent(path)}`,

  /**
   * A streaming ZIP, for a directory or a single file.
   *
   * Also a navigation target: the pre-flight walk happens before the response
   * starts, so this can take a moment on a large tree, and letting the browser
   * own the download means its own progress and retry behaviour apply.
   */
  archiveUrl: (path: string) => `/api/fs/archive?path=${encodeURIComponent(path)}`,

  // -------------------------------------------------------------------------
  // Places
  // -------------------------------------------------------------------------

  listPlaces: () => request<PlacesResponse>('/api/places'),

  /** Explicit value, not a toggle — a retry must not flip it back. */
  setFavorite: (path: string, favorite: boolean) =>
    request<PlacesResponse>('/api/places/favorite', {
      method: 'PUT',
      body: JSON.stringify({ path, favorite }),
    }),

  recordOpened: (path: string) =>
    request<void>('/api/places/opened', { method: 'PUT', body: JSON.stringify({ path }) }),

  // -------------------------------------------------------------------------
  // Quick keys
  // -------------------------------------------------------------------------

  listQuickKeys: () => request<QuickKeysResponse>('/api/quickkeys'),

  /*
   * All three mutations answer with the whole list, so the caller replaces its
   * copy from the response instead of refetching — and cannot drift from the
   * server's ordering.
   */

  createQuickKey: (input: QuickKeyRequest) =>
    request<QuickKeysResponse>('/api/quickkeys', { method: 'POST', body: JSON.stringify(input) }),

  updateQuickKey: (id: string, input: QuickKeyRequest) =>
    request<QuickKeysResponse>(`/api/quickkeys/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  deleteQuickKey: (id: string) =>
    request<QuickKeysResponse>(`/api/quickkeys/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // -------------------------------------------------------------------------
  // Shares
  // -------------------------------------------------------------------------

  listShares: () => request<SharesResponse>('/api/shares'),

  createShare: (input: ShareCreateRequest) =>
    request<ShareCreated>('/api/shares', { method: 'POST', body: JSON.stringify(input) }),

  revokeShare: (id: string) =>
    request<void>(`/api/shares/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** Issues a fresh token. The old URL stops working immediately. */
  regenerateShare: (id: string) =>
    request<ShareCreated>(`/api/shares/${encodeURIComponent(id)}/regenerate`, { method: 'POST' }),
}

/**
 * Turns the server's relative share URL into one the visitor can paste.
 *
 * The server returns `/s/<token>` rather than an absolute URL because an
 * absolute one would have to be derived from the `Host` header, which is
 * attacker-controlled on a misconfigured deployment. Resolving it here puts the
 * origin decision in the one place that actually knows the origin.
 */
export function absoluteShareUrl(relative: string): string {
  return new URL(relative, window.location.origin).toString()
}

/**
 * Fetches a preview's bytes as text.
 *
 * Bounded server-side (text previews are capped), so this cannot balloon; and
 * `text/plain` under `nosniff` means whatever comes back is inert regardless of
 * what the file actually contained.
 */
export async function fetchPreviewText(
  path: string,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  let res: Response
  try {
    res = await fetch(`/api/fs/preview?path=${encodeURIComponent(path)}`, {
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    })
  } catch {
    throw new ApiError(0, 'network', '无法连接到服务器')
  }

  if (!res.ok) {
    throw new ApiError(res.status, 'preview_failed', `无法预览 (${res.status})`)
  }
  return {
    text: await res.text(),
    truncated: res.headers.get('x-webmux-truncated') === 'true',
  }
}
