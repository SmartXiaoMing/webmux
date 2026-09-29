import path from 'node:path'

/**
 * Response plumbing for downloads: content type, disposition and Range
 * parsing. Kept apart from the routes so the fiddly parts — the RFC 5987
 * encoding and the range grammar — can be read and tested on their own.
 */

const MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/plain',
  '.css': 'text/css',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.wasm': 'application/wasm',
}

/**
 * Cosmetic only. Every download is sent as an attachment with `nosniff`, so
 * this never decides whether a browser renders something — it just gives the
 * save dialog (and the client's icon picker) a sensible hint.
 */
export function mimeFor(name: string): string {
  return MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * RFC 5987 ext-value. `encodeURIComponent` leaves `'`, `(`, `)` and `*` bare,
 * and none of them are `attr-char`, so they have to be percent-encoded on top.
 */
function extValue(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/**
 * A `filename=` value that is guaranteed to be header-safe.
 *
 * CR and LF are stripped first and separately: they cannot appear in a header
 * value at all, and Node throws `ERR_INVALID_CHAR` while setting the header —
 * which would turn a download of an oddly-named file into a 500.
 *
 * Chinese filenames are the common case here, not the exotic one, so this
 * function's "nothing ASCII survives" branch is a main path rather than an
 * edge case.
 */
function sanitizeAscii(value: string): string {
  return value
    .replace(/[\r\n\0]/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/"/g, "'")
    // Drop anything outside printable ASCII; the real name travels in
    // `filename*` regardless.
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
}

function asciiFallback(name: string): string {
  // Stem and extension are split on the *original* name, because the ASCII
  // remainder of a Chinese filename is frequently just its extension:
  // stripping `中文 文件.txt` leaves `.txt`, which is a useless thing to save
  // a file as. The stripped stem is what tells us the name was lost.
  const rawExt = path.extname(name)
  const rawStem = rawExt === '' ? name : name.slice(0, -rawExt.length)

  const stem = sanitizeAscii(rawStem)
  const ext = sanitizeAscii(rawExt).replace(/[^A-Za-z0-9.]/g, '')

  // "Nothing usable survived" is the common case here, not an edge case.
  if (!/[A-Za-z0-9]/.test(stem)) {
    return /^\.[A-Za-z0-9]{1,12}$/.test(ext) ? `download${ext}` : 'download'
  }
  return `${stem}${ext}`
}

function disposition(type: 'inline' | 'attachment', name: string): string {
  return `${type}; filename="${asciiFallback(name)}"; filename*=UTF-8''${extValue(name)}`
}

/**
 * Always `attachment`.
 *
 * The SPA is served from the same origin as this endpoint, so an uploaded
 * `.html` rendered inline would be same-origin script execution with the
 * session cookie within reach. `X-Content-Type-Options: nosniff` (set by the
 * route) closes the other half of that.
 */
export function contentDisposition(name: string): string {
  return disposition('attachment', name)
}

/**
 * Only ever used for types `previewPolicy` has already cleared.
 *
 * Every caller must have gone through the allowlist: `inline` is the directive
 * that lets a response become a document in this origin.
 */
export function inlineDisposition(name: string): string {
  return disposition('inline', name)
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * Rendered as-is, by extension.
 *
 * An allowlist, not a blocklist. A blocklist's failure mode is that some type
 * nobody thought of renders, and this origin holds the session cookie.
 */
const PREVIEW_IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.ico'])
const PREVIEW_PDF = new Set(['.pdf'])
const PREVIEW_MEDIA = new Set([
  '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.wav', '.flac',
  '.mp4', '.m4v', '.webm', '.mov', '.ogv',
])

/**
 * Previewed as plain text — never as their real type.
 *
 * `.html`, `.htm`, `.xhtml` and `.svg` are here deliberately. They are
 * script-capable, so rendering them as themselves would be same-origin XSS;
 * serving them as `text/plain` with `nosniff` means the browser cannot sniff
 * markup back out of them, so you can read the source and nothing executes.
 * That is strictly more useful than refusing to preview them at all.
 */
const PREVIEW_AS_TEXT = new Set([
  '.txt', '.text', '.log', '.md', '.markdown', '.rst',
  '.csv', '.tsv', '.json', '.jsonl', '.ndjson', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg',
  '.xml', '.html', '.htm', '.xhtml', '.svg', '.css', '.scss', '.less',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.sh', '.bash', '.zsh', '.fish', '.sql', '.lua', '.pl',
  '.diff', '.patch', '.properties', '.gradle', '.tf', '.service', '.desktop',
])

/** Text previews are a prefix, never the whole thing: a 2 GB log must not reach the browser. */
export const PREVIEW_TEXT_LIMIT_BYTES = 512 * 1024

export interface PreviewPolicy {
  /**
   * How a client should render this. Sent to the client so it does not have to
   * keep a second copy of the allowlist — a copy that would drift, and whose
   * drift would be a security decision made in the wrong place.
   */
  kind: 'image' | 'text' | 'pdf' | 'media'
  contentType: string
  /** Present when the response is a prefix rather than the whole file. */
  byteLimit?: number
}

/**
 * How to preview a file, or null when it should just be downloaded.
 *
 * Keyed on the extension rather than on sniffed content, because the decision
 * has to be made before any bytes are read.
 *
 * Extensionless names count as text. That covers `README`, `Makefile`,
 * `Dockerfile`, `.gitignore` and `.env` — far more often text than not — and
 * the worst case for a binary that sneaks in is 512 KB of mojibake served as
 * `text/plain`, which cannot execute.
 */
export function previewPolicy(name: string): PreviewPolicy | null {
  const ext = path.extname(name).toLowerCase()

  if (ext === '' || PREVIEW_AS_TEXT.has(ext)) {
    return {
      kind: 'text',
      // Always text/plain whatever the extension says. This single line is
      // what makes previewing an .html file both safe and useful.
      contentType: 'text/plain; charset=utf-8',
      byteLimit: PREVIEW_TEXT_LIMIT_BYTES,
    }
  }
  if (PREVIEW_IMAGE.has(ext)) return { kind: 'image', contentType: mimeFor(name) }
  if (PREVIEW_PDF.has(ext)) return { kind: 'pdf', contentType: 'application/pdf' }
  if (PREVIEW_MEDIA.has(ext)) return { kind: 'media', contentType: mimeFor(name) }

  return null
}

export type RangeResult =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' }

/**
 * Single-range only.
 *
 * A malformed or multi-range header is ignored and the whole entity is sent,
 * which is explicitly allowed and far simpler than emitting
 * `multipart/byteranges`. A syntactically valid range that starts past the end
 * is the one case that must be reported as 416.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: 'full' }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return { kind: 'full' }

  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return { kind: 'full' }

  if (rawStart === '') {
    // Suffix form: the last N bytes.
    const suffix = Number(rawEnd)
    if (suffix === 0) return { kind: 'unsatisfiable' }
    const start = Math.max(0, size - suffix)
    return size === 0 ? { kind: 'unsatisfiable' } : { kind: 'partial', start, end: size - 1 }
  }

  const start = Number(rawStart)
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)

  if (start >= size || start > end) return { kind: 'unsatisfiable' }
  return { kind: 'partial', start, end }
}
