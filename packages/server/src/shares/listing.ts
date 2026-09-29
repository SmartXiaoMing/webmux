import { lstat, opendir } from 'node:fs/promises'
import path from 'node:path'
import type { ShareEntry } from './page'

/**
 * One level of a directory, with the work bounded.
 *
 * Deliberately not `ops.listDirectory`: that reads and sorts the *entire*
 * directory in order to build a cursor and an exact total, which on an
 * unauthenticated page view is an O(n) readdir an anonymous visitor can repeat
 * at will. This stops after `cap + 1` entries and stats only the first `cap`,
 * so a 200 000-entry tree costs 501 dirents and 500 lstats — the same as a
 * small one.
 *
 * The cost of that bound is that the count is "500+" rather than exact, which
 * is the right trade for a page that is only orientation: the zip is the
 * product.
 */
export async function readTopLevel(
  dir: string,
  cap: number,
): Promise<{ entries: ShareEntry[]; capped: boolean }> {
  const handle = await opendir(dir)
  const names: { name: string; isDirectory: boolean }[] = []
  let capped = false

  for await (const dirent of handle) {
    if (names.length >= cap) {
      capped = true
      break
    }
    names.push({
      // Dirent type comes from readdir, so no stat is needed to classify.
      isDirectory: dirent.isDirectory(),
      name: dirent.name,
    })
  }

  // Dotfiles are shown: `walkForArchive` does not filter them, so the zip
  // contains them — a listing that hid them would disagree with what the
  // visitor actually receives.
  names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const entries = await Promise.all(
    names.map(async (entry) => {
      const info = await lstat(path.join(dir, entry.name)).catch(() => null)
      return {
        name: entry.name,
        isDirectory: entry.isDirectory,
        size: info === null || entry.isDirectory ? 0 : info.size,
        mtimeMs: info?.mtimeMs ?? 0,
      }
    }),
  )

  return { entries, capped }
}
