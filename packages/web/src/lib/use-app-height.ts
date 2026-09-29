import { useEffect } from 'react'

/**
 * Keeps `--app-height` pinned to the *visible* viewport.
 *
 * On mobile, opening the soft keyboard shrinks the visual viewport but leaves
 * `window.innerHeight` untouched (iOS in particular). Layouts sized from
 * `innerHeight` therefore sit partly behind the keyboard, which for a terminal
 * means the cursor — the one line you actually need to see — is hidden.
 *
 * `visualViewport` reports the region not covered by the keyboard, and is the
 * only API that does. It also fires on scroll while the keyboard animates, so
 * the height stays correct mid-transition rather than snapping at the end.
 */
export function useAppHeight(): void {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const root = document.documentElement
    let frame = 0

    const apply = (): void => {
      cancelAnimationFrame(frame)
      // Coalesced into a frame: these events fire in bursts while the keyboard
      // animates, and each write forces a layout.
      frame = requestAnimationFrame(() => {
        root.style.setProperty('--app-height', `${Math.round(viewport.height)}px`)
      })
    }

    apply()
    viewport.addEventListener('resize', apply)
    viewport.addEventListener('scroll', apply)
    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', apply)
      viewport.removeEventListener('scroll', apply)
      root.style.removeProperty('--app-height')
    }
  }, [])
}

/**
 * Holds the screen awake while `active`.
 *
 * A long-running command is exactly the case where the phone locking is most
 * annoying, and exactly the case webmux exists for. The lock is dropped when
 * the page is hidden (the browser does this regardless) and re-acquired on
 * return, since a wake lock does not survive a visibility change.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const nav = navigator as Navigator & {
      wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinel> }
    }
    if (!nav.wakeLock) return

    let sentinel: WakeLockSentinel | null = null
    let cancelled = false

    const acquire = async (): Promise<void> => {
      if (cancelled || document.visibilityState !== 'visible') return
      try {
        sentinel = await nav.wakeLock!.request('screen')
        sentinel.addEventListener('release', () => {
          sentinel = null
        })
      } catch {
        // Denied (low battery, or an insecure context) — not worth surfacing.
      }
    }

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void acquire()
    }

    void acquire()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      void sentinel?.release().catch(() => {})
    }
  }, [active])
}
