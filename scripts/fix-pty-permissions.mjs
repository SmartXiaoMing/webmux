/**
 * node-pty's published prebuilds ship `spawn-helper` without its executable
 * bit, so `posix_spawnp` fails at spawn time with the unhelpful message
 * "posix_spawnp failed." — a failure that only shows up the first time a
 * terminal is opened, long after install appeared to succeed.
 *
 * This restores the bit. It runs as a postinstall so the fix survives a clean
 * `pnpm install`, and is a no-op on Windows (which uses conpty, not the
 * helper).
 */
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32') process.exit(0)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HELPERS = []
const MAX_DEPTH = 8

/** Finds every node-pty install, including the nested copies pnpm creates. */
function walk(dir, depth) {
  if (depth > MAX_DEPTH) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = path.join(dir, entry.name)

    if (entry.name === 'node-pty') {
      const prebuilds = path.join(full, 'prebuilds')
      if (!existsSync(prebuilds)) continue
      for (const platform of readdirSync(prebuilds)) {
        const helper = path.join(prebuilds, platform, 'spawn-helper')
        if (existsSync(helper)) HELPERS.push(helper)
      }
      continue
    }

    if (entry.name === 'node_modules' || entry.name.startsWith('@')) walk(full, depth + 1)
    else if (entry.name.startsWith('.pnpm')) walk(full, depth + 1)
  }
}

walk(path.join(root, 'node_modules'), 0)
walk(path.join(root, 'packages'), 0)

let fixed = 0
for (const helper of HELPERS) {
  try {
    const mode = statSync(helper).mode
    if ((mode & 0o111) === 0o111) continue // already executable
    chmodSync(helper, mode | 0o755)
    fixed += 1
  } catch (err) {
    console.warn(`[fix-pty-permissions] could not chmod ${helper}: ${err.message}`)
  }
}

if (fixed > 0) {
  console.log(`[fix-pty-permissions] restored the executable bit on ${fixed} spawn-helper binary(ies)`)
}
