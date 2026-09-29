/**
 * MS-DOS date and time, as ZIP headers store them.
 *
 * No timezone field, because DOS had none: these are local wall-clock values.
 * Seconds have two-second resolution, so an extracted mtime differs from the
 * source by up to one second — a round-trip test must not compare them exactly.
 */

/** The DOS epoch. Earlier years cannot be represented and are clamped up. */
const MIN_YEAR = 1980
/** Later years overflow the 7-bit year field and are clamped down. */
const MAX_YEAR = 2107

export interface DosDateTime {
  time: number
  date: number
}

export function toDosDateTime(mtimeMs: number): DosDateTime {
  // A NaN mtime would make every field NaN, and writing zero is not a fix:
  // zero decodes as "1980-00-00", which some Windows paths reject outright.
  const at = new Date(Number.isFinite(mtimeMs) ? mtimeMs : Date.now())

  const year = Math.min(MAX_YEAR, Math.max(MIN_YEAR, at.getFullYear()))
  // When the year had to move, the month and day describe a date that does not
  // exist in the target year, so they are reset rather than carried over.
  const clamped = year !== at.getFullYear()

  const month = clamped ? 1 : at.getMonth() + 1
  const day = clamped ? 1 : at.getDate()

  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date: ((year - MIN_YEAR) << 9) | (month << 5) | day,
  }
}
