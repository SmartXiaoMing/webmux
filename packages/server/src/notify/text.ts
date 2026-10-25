import { NOTIFY_BODY_MAX, NOTIFY_TITLE_MAX } from '@webmux/shared'

/**
 * Cleaning applied to everything a caller supplies before it is stored.
 *
 * The content of a notification travels a long way from where it is written —
 * into a browser toast, into an operating system's notification centre, onto a
 * phone's lock screen — and each of those renders it as text, with no shell,
 * no terminal, and no way to see what was really sent. Two families of
 * characters are removed for that reason:
 *
 *   - C0/C1 controls and their relatives. A caller that attaches a chunk of
 *     terminal output should get readable text back, not escape sequences.
 *   - The invisible formatting characters. Bidi overrides can make a
 *     notification read in an order it was not written in, which is a
 *     phishing primitive; zero-width joiners and line separators do nothing
 *     but break rendering.
 *
 * Built from escapes rather than written as a regex literal on purpose:
 * several of these characters are invisible, and a literal one in the source
 * is unreviewable — it survives edits nobody can see, and at a glance it is
 * indistinguishable from a typo. Spelled out this way, every code point can be
 * read off the line it is on.
 *
 * Tab and newline are deliberately absent: they survive in the body, because a
 * caller reporting a failing command usually has a few lines worth showing.
 * Titles are collapsed to a single line separately, below.
 */
const STRIPPED = new RegExp(
  `[${[
    '\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f', // C0, minus tab and newline
    '\\u007f-\\u009f', // DEL and C1
    '\\u200b-\\u200f', // zero-width space/joiners, LRM, RLM
    '\\u2028\\u2029', // line and paragraph separator
    '\\u202a-\\u202e', // bidi embeddings and overrides
    '\\u2066-\\u2069', // bidi isolates
    '\\ufeff', // byte-order mark
  ].join('')}]`,
  'g',
)

/**
 * Truncates by code point rather than by UTF-16 unit.
 *
 * `String.prototype.slice` counts units, so it cuts a surrogate pair in half
 * and leaves a lone surrogate behind — rendered as a replacement character in
 * every destination listed above.
 */
function truncate(text: string, max: number): string {
  const points = Array.from(text)
  if (points.length <= max) return text
  return `${points.slice(0, max).join('')}…`
}

/** One line, no runs of whitespace: titles are rendered in narrow places. */
export function cleanTitle(raw: string): string {
  return truncate(raw.replace(STRIPPED, '').replace(/\s+/g, ' ').trim(), NOTIFY_TITLE_MAX)
}

/** Multi-line allowed; the ends are trimmed and line endings normalised. */
export function cleanBody(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const text = raw
    .replace(STRIPPED, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text === '' ? null : truncate(text, NOTIFY_BODY_MAX)
}
