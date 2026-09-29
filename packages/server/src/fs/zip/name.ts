import { FsError } from '../jail'

/**
 * ZIP entry-name validation — the zip-slip defence.
 *
 * This is the one file in the archive code whose bugs are exploitable rather
 * than merely annoying. Note carefully what it does *not* do: validating a name
 * is only half the job. A name that is perfectly clean can still land outside
 * the jail, because a symlink that already exists inside the destination will
 * be followed by the write. That half belongs to `jail.resolveForCreate`, which
 * `extract.ts` runs on every entry. Neither half is sufficient alone, and the
 * tests for this file deliberately cover only the half it owns.
 */

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true })
const LENIENT_UTF8 = new TextDecoder('utf-8', { fatal: false })

/** Matches the jail's own limit, so an over-long name is a clean 400 rather than ENAMETOOLONG. */
const MAX_NAME_LENGTH = 4096
const MAX_SEGMENT_LENGTH = 255

/**
 * Decodes an entry name.
 *
 * The flag splits strict from lenient on purpose. When the writer set bit 11 it
 * promised UTF-8, and a malformed sequence means the promise was false —
 * guessing past that would mean guessing about a path. When the flag is clear
 * there is no promise: the spec nominally says CP437, but essentially every
 * real writer emits UTF-8 and merely forgot the flag, including every Chinese
 * Windows tool, which is exactly the case this project cares about. Decoding as
 * UTF-8 with replacement is right far more often than it is wrong; the cost is
 * that a genuinely CP437 archive comes out with U+FFFD in place of its accented
 * bytes.
 */
export function decodeEntryName(raw: Uint8Array, utf8Flag: boolean): string {
  try {
    return (utf8Flag ? STRICT_UTF8 : LENIENT_UTF8).decode(raw)
  } catch {
    throw new FsError('unsafe_archive', 'archive entry name is not valid UTF-8', 400)
  }
}

export interface ValidatedName {
  /** Normalised, `/`-separated, no trailing slash, no empty or `.` segments. */
  path: string
  /** The entry declared itself a directory with a trailing slash. */
  trailingSlash: boolean
}

export function validateEntryName(raw: string): ValidatedName {
  const reject = (why: string): never => {
    throw new FsError('unsafe_archive', `archive entry name rejected: it ${why}`, 400)
  }

  if (raw.length === 0) reject('is empty')
  if (raw.length > MAX_NAME_LENGTH) reject('is too long')
  // Representable in a zip (names carry an explicit length), and Node throws
  // ERR_INVALID_ARG_VALUE on it later — the same reason `jail.ts` checks first.
  if (raw.includes('\0')) reject('contains a null byte')

  const trailingSlash = raw.endsWith('/')
  const body = trailingSlash ? raw.slice(0, -1) : raw

  if (body.startsWith('/')) reject('is an absolute path')
  if (/^[A-Za-z]:([\\/]|$)/.test(body)) reject('looks like a Windows drive path')

  /*
   * Backslashes are refused outright, and this is a deliberate asymmetry with
   * the jail.
   *
   * On POSIX a backslash is an ordinary filename character, and `jail.ts`
   * leaves it alone for exactly that reason — the paths it sees come from the
   * operator's own filesystem, where a backslash is real data worth preserving.
   * A zip entry name is the opposite: untrusted foreign data, whose only other
   * consumer may be a Windows machine the archive is later copied to.
   *
   * So `..\..\etc\passwd` is simultaneously "one harmless POSIX filename" and
   * "a four-level traversal", and there is no way to tell which the writer
   * meant. Refusing costs us archives containing a file legitimately named
   * `a\b`; allowing costs a class of traversal we cannot even detect. Note the
   * writer side agrees — `write.ts` rewrites backslashes rather than emitting a
   * name this function would reject.
   */
  if (body.includes('\\')) reject('contains a backslash')

  // Empty and `.` segments are harmless normalisation (`a//b`, `a/./b`).
  // `..` is not normalised — it is refused, because resolving it is exactly the
  // operation that goes wrong.
  const segments = body.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) reject('resolves to nothing')

  for (const segment of segments) {
    if (segment === '..') reject('contains a parent-directory segment')
    if (segment.length > MAX_SEGMENT_LENGTH) reject('has a path segment that is too long')
  }

  return { path: segments.join('/'), trailingSlash }
}
