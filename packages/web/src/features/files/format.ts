import type { FsEntryKind } from '@webmux/shared'

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (sameDay) return time
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
}

/** A single glyph per kind, so the list stays scannable at a glance. */
export function iconFor(kind: FsEntryKind): string {
  switch (kind) {
    case 'dir':
      return '▸'
    case 'symlink':
      return '↗'
    case 'file':
      return '·'
    default:
      return '?'
  }
}

/** Splits a path into breadcrumb segments, each with the absolute path to reach it. */
export function breadcrumbs(absPath: string): Array<{ name: string; path: string }> {
  const parts = absPath.split('/').filter(Boolean)
  const crumbs: Array<{ name: string; path: string }> = [{ name: '/', path: '/' }]
  let current = ''
  for (const part of parts) {
    current += `/${part}`
    crumbs.push({ name: part, path: current })
  }
  return crumbs
}

/** Joins a directory and a child name without doubling separators. */
export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}
