import { useCallback, useEffect, useRef, useState } from 'react'
import type { QuickKey } from '@webmux/shared'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { TerminalSocket, type SocketStatus } from '../../lib/terminal-socket'
import {
  minimumContrastRatio,
  terminalTheme,
  useTheme,
  type ResolvedTheme,
} from '../../lib/theme'
import { useFontSize } from '../../lib/font-scale'
import { KeyBar } from './KeyBar'

/** The DOM attribute is the source of truth; the pre-paint script already set it. */
function currentTheme(): ResolvedTheme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

/**
 * Applies a sticky Ctrl to whatever the keyboard produced.
 *
 * Ctrl is not a modifier the browser reports for soft keyboards — by the time
 * xterm sees the character, the intent is gone. So the translation happens
 * here: Ctrl+A through Ctrl+Z (and the handful of punctuation keys that have
 * control codes) map to the same bytes a hardware keyboard would send.
 */
function applyCtrl(data: string): string {
  let out = ''
  for (const char of data) {
    const code = char.charCodeAt(0)
    const upper = char.toUpperCase().charCodeAt(0)
    if (upper >= 64 && upper <= 95) {
      // @ A-Z [ \ ] ^ _  ->  0x00-0x1F
      out += String.fromCharCode(upper - 64)
    } else if (char === '?') {
      out += '\x7f'
    } else {
      out += char
    }
  }
  return out
}

export interface TerminalViewProps {
  sessionId: string
  /** Called with the shell's exit code once the PTY ends. */
  onExit?: (code: number) => void
  /** Called when the socket cannot recover on its own (bad auth, dead session). */
  onFatal?: (message: string) => void
  /**
   * User macros for the key bar, and how to open their editor.
   *
   * Both are passed in rather than fetched here: this component is mounted with
   * a `key` of the session id, so anything it fetched itself would be refetched
   * on every session switch — and the editor must outlive that remount anyway.
   */
  quickKeys: readonly QuickKey[]
  onEditQuickKeys: () => void
}

export function TerminalView({
  sessionId,
  onExit,
  onFatal,
  quickKeys,
  onEditQuickKeys,
}: TerminalViewProps): React.JSX.Element {
  const { resolved } = useTheme()
  const { fontSize } = useFontSize()
  const hostRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const spacerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  /** Published by the mount effect so the font-size effect can re-measure. */
  const measureAndSyncRef = useRef<(() => void) | null>(null)
  const socketRef = useRef<TerminalSocket | null>(null)

  const [status, setStatus] = useState<SocketStatus>('idle')
  const [statusDetail, setStatusDetail] = useState<string | undefined>()
  const [ctrl, setCtrl] = useState(false)
  const [alt, setAlt] = useState(false)

  // Read by the terminal's data handler, which is installed once and would
  // otherwise close over stale modifier state.
  const ctrlRef = useRef(false)
  const altRef = useRef(false)
  ctrlRef.current = ctrl
  altRef.current = alt

  // Keep the latest callbacks reachable from the effect without making them
  // dependencies — the effect must run exactly once per session.
  const callbacks = useRef({ onExit, onFatal })
  callbacks.current = { onExit, onFatal }

  const sendKey = useCallback((sequence: string) => {
    socketRef.current?.write(sequence)
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    // Read from the DOM rather than from React state, so the terminal's first
    // paint cannot disagree with what is already on screen.
    const initialTheme = currentTheme()

    const term = new Terminal({
      theme: terminalTheme(initialTheme),
      // Raised in light mode only: xterm then lifts clashing foregrounds to
      // WCAG AA, which is exactly the dark-blue-on-white case a remote
      // LS_COLORS produces.
      minimumContrastRatio: minimumContrastRatio(initialTheme),
      fontFamily:
        "'JetBrains Mono', 'SF Mono', Menlo, 'DejaVu Sans Mono', Consolas, ui-monospace, monospace",
      // From the adjustable setting, whose device-appropriate default is what
      // keeps a phone's shell prompt from eating the whole line.
      fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10_000,
      allowProposedApi: true,
      // Treat Option as Meta so readline and emacs bindings work for Mac users.
      macOptionIsMeta: true,
      smoothScrollDuration: 0,
      windowOptions: {},
    })
    termRef.current = term

    const fit = new FitAddon()
    term.loadAddon(fit)
    fitRef.current = fit

    // Wide-character handling: without this, CJK text and emoji render at the
    // wrong width and desynchronise the cursor from the shell's idea of it.
    const unicode = new Unicode11Addon()
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'

    term.loadAddon(new WebLinksAddon())

    term.open(host)

    // Exposed for debugging and end-to-end tests. Reading the terminal's own
    // buffer is the only way to assert on what was *rendered* — scraping the
    // DOM cannot distinguish real output from a stale canvas. Harmless to
    // expose: anyone who can read this already has a shell.
    ;(window as unknown as { __webmuxTerm?: Terminal }).__webmuxTerm = term

    try {
      const webgl = new WebglAddon()
      // A lost context (GPU reset, tab backgrounded too long) leaves the
      // terminal blank; dropping the addon falls back to the DOM renderer.
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // No WebGL — software rendering, old device, or a headless browser. The
      // DOM renderer is slower but entirely functional.
    }

    const socket = new TerminalSocket(sessionId, {
      onData: (chunk) => term.write(chunk),
      onReset: () => term.reset(),
      onStatus: (next, detail) => {
        setStatus(next)
        setStatusDetail(detail)
      },
      onExit: (code) => callbacks.current.onExit?.(code),
      onTitle: () => {},
      onFatal: (message) => callbacks.current.onFatal?.(message),
    })
    socketRef.current = socket

    const dataSub = term.onData((data) => {
      let payload = data
      if (ctrlRef.current) {
        payload = applyCtrl(payload)
        setCtrl(false)
      }
      if (altRef.current) {
        payload = `\x1b${payload}`
        setAlt(false)
      }
      socket.write(payload)
    })

    // Fitting is what reports dimensions to the server: xterm fires onResize,
    // which forwards to the PTY. Doing it after `open` means the first fit
    // already reflects the real element size.
    const resizeSub = term.onResize(({ cols, rows }) => socket.resize(cols, rows))

    const fitNow = (): void => {
      try {
        fit.fit()
      } catch {
        // fit() throws when the element is hidden or has zero size — common
        // during a layout transition. The next observation corrects it.
      }
    }

    /*
     * Touch scrolling.
     *
     * xterm 6 has no touch scrolling and no scrollable element of its own —
     * `.xterm-viewport` is an empty transparent div whose `scrollTop` is never
     * written, and the scroll position lives in JS. So this overlay is the
     * whole mechanism, not a nicety.
     *
     * The truth on the terminal side is `buffer.active.viewportY`, in lines.
     */
    const scrollEl = scrollRef.current
    const spacerEl = spacerRef.current
    const container = host.parentElement
    let cell = 0

    const measure = (): void => {
      const screen = host.querySelector('.xterm-screen')
      if (!(screen instanceof HTMLElement) || term.rows === 0) return
      // The rect, not `clientHeight` (which rounds to an integer) and not
      // `fontSize * lineHeight` (xterm snaps the cell to device pixels). Two
      // sides deriving a different cell height *is* the jitter.
      cell = screen.getBoundingClientRect().height / term.rows
    }

    const sync = (): void => {
      if (scrollEl === null || spacerEl === null || cell === 0) return

      const total = term.buffer.active.length
      const maxTop = Math.max(0, (total - term.rows) * cell)

      const height = `${Math.round(total * cell)}px`
      if (spacerEl.style.height !== height) spacerEl.style.height = height

      // Clamped on both sides: iOS rubber-banding produces negative and
      // past-the-end values.
      const want = Math.min(Math.max(term.buffer.active.viewportY * cell, 0), maxTop)
      if (Math.abs(scrollEl.scrollTop - want) > 0.5) scrollEl.scrollTop = want
    }

    const onScroll = (): void => {
      if (scrollEl === null || cell === 0) return
      // Ignored unless a touch is actually driving it. The terminal is hidden
      // with a class when the user switches to another view, and a hidden
      // element's scrollTop reset would otherwise drag the terminal to line 0.
      if (container !== null && !container.classList.contains('term-touch')) return

      const maxLine = Math.max(0, term.buffer.active.length - term.rows)
      const line = Math.min(Math.max(Math.round(scrollEl.scrollTop / cell), 0), maxLine)
      if (line !== term.buffer.active.viewportY) term.scrollToLine(line)
    }

    // No gesture maths needed: the browser already suppresses `click` for a
    // gesture it treated as a scroll, so a tap is the only thing that produces
    // one. Focusing synchronously inside that handler is what opens the iOS
    // keyboard.
    const onClick = (): void => term.focus()

    // Seed from the device, then track the pointer that is actually in use. A
    // media query alone would break mouse selection on a touch-screen laptop.
    if (navigator.maxTouchPoints > 0 || matchMedia('(hover: none) and (pointer: coarse)').matches) {
      container?.classList.add('term-touch')
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') container?.classList.add('term-touch')
      else if (event.pointerType === 'mouse') container?.classList.remove('term-touch')
    }

    const refit = (): void => {
      fitNow()
      measure()
      sync()
    }

    measureAndSyncRef.current = refit
    refit()
    socket.connect()

    const observer = new ResizeObserver(refit)
    observer.observe(host)

    // Rotation and keyboard show/hide change the visual viewport without
    // necessarily resizing the element, so they need their own trigger.
    const viewport = window.visualViewport
    viewport?.addEventListener('resize', refit)

    scrollEl?.addEventListener('scroll', onScroll, { passive: true })
    scrollEl?.addEventListener('click', onClick)
    container?.addEventListener('pointerdown', onPointerDown, true)

    const scrollSub = term.onScroll(sync)
    const lineFeedSub = term.onLineFeed(sync)
    const parsedSub = term.onWriteParsed(sync)
    const bufferSub = term.buffer.onBufferChange(sync)

    return () => {
      viewport?.removeEventListener('resize', refit)
      observer.disconnect()
      scrollEl?.removeEventListener('scroll', onScroll)
      scrollEl?.removeEventListener('click', onClick)
      container?.removeEventListener('pointerdown', onPointerDown, true)
      scrollSub.dispose()
      lineFeedSub.dispose()
      parsedSub.dispose()
      bufferSub.dispose()
      dataSub.dispose()
      resizeSub.dispose()
      socket.dispose()
      term.dispose()
      termRef.current = null
      socketRef.current = null
      fitRef.current = null
      measureAndSyncRef.current = null
      delete (window as unknown as { __webmuxTerm?: Terminal }).__webmuxTerm
    }
  }, [sessionId])

  /*
   * Swap the theme in place.
   *
   * Deliberately not a remount: recreating the Terminal drops the socket and
   * forces a full resync from the server. Two xterm details make this the only
   * correct way — the options setter fires on *reference* inequality, so
   * mutating an existing theme object changes nothing, and `_setTheme` falls
   * back to xterm's own defaults for absent keys rather than to the previous
   * theme, so a partial object silently resets everything it omits.
   */
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = terminalTheme(resolved)
    term.options.minimumContrastRatio = minimumContrastRatio(resolved)
  }, [resolved])

  /*
   * Mirrors the socket status for end-to-end tests, alongside `__webmuxTerm`.
   *
   * Without it a test can only infer readiness from the connection banner's
   * *absence* — and that is true before the socket has even started connecting,
   * so a test that waits for it types into a socket that is not listening yet
   * and the keystrokes vanish. Harmless to expose: anything that can read this
   * already has a shell.
   */
  useEffect(() => {
    ;(window as unknown as { __webmuxStatus?: SocketStatus }).__webmuxStatus = status
  }, [status])

  /*
   * Applies a font-size change in place, like the theme.
   *
   * The refit is not optional: a different font size means a different cell
   * size, so the column and row counts change. Without it the terminal keeps
   * rendering at the old geometry and the server is never told about the new
   * one, which shows up as a shell that wraps its output in the wrong place.
   */
  useEffect(() => {
    const term = termRef.current
    if (!term || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    try {
      fitRef.current?.fit()
    } catch {
      // Hidden or zero-sized right now; the next observation corrects it.
    }
    measureAndSyncRef.current?.()
  }, [fontSize])

  const busy = status === 'connecting' || status === 'syncing'

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ink">
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="absolute inset-0" />

        {/*
          The touch-scroll overlay. See the effect above for the sync rules.

          Permanently mounted and never `display:none`d, on purpose: hiding it
          discards the layout box and resets `scrollTop` to 0, which fires a
          scroll event that would drive the terminal to line 0. `App.tsx` hides
          the whole terminal with a class when the user opens another view, so a
          conditional here would show up as "switching to files scrolled my
          terminal to the top".

          The spacer is what gives it something to scroll; its height is
          `buffer length × cell height` and is rewritten by the sync.
        */}
        <div ref={scrollRef} className="term-scroll" aria-hidden="true">
          <div ref={spacerRef} />
        </div>

        {busy && (
          // The presence of this element means "not ready yet": the socket is
          // connecting or still absorbing a snapshot. Marked so a test can wait
          // for the real precondition instead of matching the status wording,
          // which changes with the reason for the delay.
          <div
            data-connection-banner
            className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-2"
          >
            <div className="rounded-full border border-line bg-surface/95 px-3 py-1 text-xs text-muted shadow-lg backdrop-blur">
              <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warn align-middle" />
              {statusDetail ?? '正在连接…'}
            </div>
          </div>
        )}
      </div>

      <KeyBar
        onKey={sendKey}
        ctrl={ctrl}
        alt={alt}
        onToggleCtrl={() => setCtrl((v) => !v)}
        onToggleAlt={() => setAlt((v) => !v)}
        quickKeys={quickKeys}
        onEditQuickKeys={onEditQuickKeys}
        className="shrink-0 pb-[env(safe-area-inset-bottom)]"
      />
    </div>
  )
}
