import { useSyncExternalStore } from 'react'
import type { ITheme } from '@xterm/xterm'

/**
 * Theme state and the two terminal palettes.
 *
 * The `data-theme` attribute on `<html>` is the source of truth, not this
 * module's variables: `index.html` sets it with a synchronous script before the
 * first paint, so by the time React runs the page is already correctly coloured
 * and the only bug available is React disagreeing with it.
 */

export type ThemeChoice = 'system' | 'dark' | 'light'
export type ResolvedTheme = 'dark' | 'light'

const STORAGE_KEY = 'webmux.theme'
const LIGHT_CHROME = '#ffffff'
const DARK_CHROME = '#11151d'

const listeners = new Set<() => void>()
const media = window.matchMedia('(prefers-color-scheme: light)')

function readStored(): ThemeChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
  } catch {
    // localStorage throws in some privacy configurations.
    return 'system'
  }
}

/** Read from the DOM, so the first render agrees with what is already painted. */
function readResolved(): ResolvedTheme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

let choice: ThemeChoice = readStored()
let resolved: ResolvedTheme = readResolved()

function apply(next: ThemeChoice): void {
  choice = next
  resolved = next === 'system' ? (media.matches ? 'light' : 'dark') : next

  document.documentElement.dataset.theme = resolved
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta !== null) meta.setAttribute('content', resolved === 'light' ? LIGHT_CHROME : DARK_CHROME)

  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Not being able to remember the choice is not a reason to fail to apply it.
  }

  for (const listener of listeners) listener()
}

// Only a *system* choice follows the system; an explicit one must not be
// clobbered when the OS flips at sunset.
media.addEventListener('change', () => {
  if (choice === 'system') apply('system')
})

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useTheme(): {
  choice: ThemeChoice
  resolved: ResolvedTheme
  setChoice: (next: ThemeChoice) => void
} {
  // `choice` is re-read through the same subscribe/getSnapshot pair; the
  // snapshot is the pair itself so a change to either re-renders.
  const snapshot = useSyncExternalStore(
    subscribe,
    () => `${choice}|${resolved}`,
    () => `${choice}|${resolved}`,
  )
  const [currentChoice, currentResolved] = snapshot.split('|') as [ThemeChoice, ResolvedTheme]
  return { choice: currentChoice, resolved: currentResolved, setChoice: apply }
}

// ---------------------------------------------------------------------------
// Terminal palettes
// ---------------------------------------------------------------------------

/**
 * The 16 ANSI colours, per theme.
 *
 * Two relationships are re-derived rather than flipped, because a light
 * terminal is not an inverted dark one:
 *
 *   - **`bright*` means "more contrast against the background"**, which on
 *     white means darker and more saturated. Every light terminal does this.
 *   - **`brightBlack` is the exception.** Its real-world job is "dim, comment,
 *     disabled", so it stays *lighter* than `black` — inverting it would make
 *     the dimmest thing on screen the most prominent.
 *
 * These are a contract with the *remote* program, not with us: a user's
 * `LS_COLORS` may have been tuned for a dark background and no palette we
 * choose can fix `#0000ff` on white. That is a known cost of a light terminal
 * everywhere, not something introduced here.
 */
const ANSI: Record<ResolvedTheme, Omit<ITheme, 'background' | 'foreground' | 'cursor' | 'cursorAccent' | 'selectionBackground'>> = {
  dark: {
    black: '#11151d',
    red: '#ff6b6b',
    green: '#5fd38d',
    yellow: '#ffb454',
    blue: '#5aa9ff',
    magenta: '#c792ea',
    cyan: '#4dd0e1',
    white: '#c3ccda',
    brightBlack: '#4a5364',
    brightRed: '#ff8a8a',
    brightGreen: '#7fe0a5',
    brightYellow: '#ffc978',
    brightBlue: '#7cbcff',
    brightMagenta: '#d8aef2',
    brightCyan: '#6fe0ee',
    brightWhite: '#e6ecf5',
  },
  light: {
    black: '#24292f',
    red: '#cf222e',
    green: '#1a7f37',
    yellow: '#8a6100',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#57606a',
    brightBlack: '#6e7781',
    brightRed: '#a40e26',
    brightGreen: '#0f5323',
    brightYellow: '#6b4700',
    brightBlue: '#0550ae',
    brightMagenta: '#6639ba',
    brightCyan: '#0f6f77',
    brightWhite: '#1f2430',
  },
}

/**
 * The scrollbar slider.
 *
 * Not decoration, and not reachable from CSS: xterm 6's scrollbar is its own
 * `SmoothScrollableElement`, painted from these three theme keys and injected
 * as a `<style>` at higher specificity than any rule we could write. Leaving
 * them out gives xterm's default translucent-white slider — invisible on a
 * light background.
 */
const SCROLLBAR: Record<ResolvedTheme, Pick<ITheme, 'scrollbarSliderBackground' | 'scrollbarSliderHoverBackground' | 'scrollbarSliderActiveBackground'>> = {
  dark: {
    scrollbarSliderBackground: '#2e364699',
    scrollbarSliderHoverBackground: '#2e3646cc',
    scrollbarSliderActiveBackground: '#2e3646ff',
  },
  light: {
    scrollbarSliderBackground: '#c8ced8cc',
    scrollbarSliderHoverBackground: '#c8ced8e6',
    scrollbarSliderActiveBackground: '#b4bcc9',
  },
}

/** The chrome colours, read from CSS so the two palettes cannot drift apart. */
function chrome(): { background: string; foreground: string; cursor: string } {
  const styles = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string): string =>
    styles.getPropertyValue(name).trim() || fallback

  return {
    background: read('--color-ink', '#0b0e14'),
    foreground: read('--color-body', '#c3ccda'),
    cursor: read('--color-accent', '#5aa9ff'),
  }
}

/**
 * A complete xterm theme for the current resolved theme.
 *
 * Complete is load-bearing: `_setTheme` falls back to xterm's *defaults* for
 * absent keys, not to the previously applied theme, so a partial object
 * silently resets everything it omits.
 *
 * `background` is deliberately the same value as `--color-ink`, so the terminal
 * never shows a seam against its container. Keep them equal.
 */
export function terminalTheme(mode: ResolvedTheme): ITheme {
  const { background, foreground, cursor } = chrome()
  return {
    background,
    foreground,
    cursor,
    cursorAccent: background,
    // A light background needs a lower alpha, not less colour: the dark
    // value is opaque enough to hide text on white.
    selectionBackground: mode === 'light' ? '#1f6feb2e' : '#2b5f9688',
    ...ANSI[mode],
    ...SCROLLBAR[mode],
  }
}

/**
 * Raised in light mode only.
 *
 * xterm then lifts any foreground that clashes with the background up to WCAG
 * AA, which is exactly the dark-blue-on-white case a remote `LS_COLORS` will
 * produce. It costs per-cell colour maths (cached) and can make a few colours
 * surprising, so it is deliberately one-sided.
 */
export function minimumContrastRatio(mode: ResolvedTheme): number {
  return mode === 'light' ? 4.5 : 1
}

export const THEME_STORAGE_KEY = STORAGE_KEY
