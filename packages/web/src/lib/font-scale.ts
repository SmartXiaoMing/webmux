import { useSyncExternalStore } from 'react'

/**
 * Terminal font size, in CSS pixels.
 *
 * Stored per device, unlike the favourites list: a phone and a desktop want
 * genuinely different sizes, so syncing this across them would be wrong rather
 * than convenient.
 *
 * The default is chosen by the device rather than shared, because 13.5px on a
 * 390px-wide phone fits so few columns that the shell prompt alone fills the
 * line — which is the complaint this exists to answer.
 */

export const MIN_FONT_SIZE = 9
export const MAX_FONT_SIZE = 20
export const FONT_SIZE_STEP = 0.5

const STORAGE_KEY = 'webmux.fontSize'
const NARROW = '(max-width: 640px)'

export function defaultFontSize(): number {
  return window.matchMedia(NARROW).matches ? 10.5 : 13.5
}

function clamp(value: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value * 2) / 2))
}

function read(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return defaultFontSize()
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? clamp(parsed) : defaultFontSize()
  } catch {
    return defaultFontSize()
  }
}

const listeners = new Set<() => void>()
let current = read()

function set(next: number): void {
  const value = clamp(next)
  if (value === current) return
  current = value
  try {
    localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    // Not being able to remember it is not a reason to refuse to apply it.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useFontSize(): {
  fontSize: number
  larger: () => void
  smaller: () => void
} {
  const fontSize = useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  )
  return {
    fontSize,
    larger: () => set(fontSize + FONT_SIZE_STEP),
    smaller: () => set(fontSize - FONT_SIZE_STEP),
  }
}
