import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreIcon } from './icons'

export interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}

export interface ActionMenuProps {
  items: MenuItem[]
  /** Accessible name for the trigger. */
  label?: string
}

const MENU_WIDTH = 160
const ITEM_HEIGHT = 34
const GUTTER = 6

/**
 * A trigger button and its dropdown.
 *
 * The menu is portalled to `document.body` rather than positioned inside the
 * row, and that is not incidental: the file list scrolls inside
 * `overflow-y: auto`, so an absolutely-positioned menu is clipped the moment it
 * would extend past the list's edge — which is exactly what happens on the last
 * rows, where the menu matters most. Fixed positioning computed from the
 * trigger's rect is what makes it escape the clip.
 *
 * It flips above the trigger when there is not room below, and closes on an
 * outside press, Escape, a scroll or a resize — a fixed-position menu goes
 * stale the instant the page moves underneath it.
 */
export function ActionMenu({ items, label = '操作' }: ActionMenuProps): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

  const place = useCallback((): void => {
    const trigger = triggerRef.current
    if (!trigger) return

    const rect = trigger.getBoundingClientRect()
    const height = items.length * ITEM_HEIGHT + 8
    const below = rect.bottom + GUTTER + height <= window.innerHeight
    const top = below ? rect.bottom + GUTTER : Math.max(GUTTER, rect.top - GUTTER - height)

    // Right-aligned to the trigger, then clamped into the viewport.
    const left = Math.min(
      Math.max(GUTTER, rect.right - MENU_WIDTH),
      window.innerWidth - MENU_WIDTH - GUTTER,
    )
    setPosition({ top, left })
  }, [items.length])

  useEffect(() => {
    if (!open) return
    place()

    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) === true) return
      if (triggerRef.current?.contains(target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const close = (): void => setOpen(false)

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    // Capture, so a scroll inside the list is caught too — scroll events from
    // an inner container do not bubble to the window otherwise.
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)

    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open, place])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        data-action-menu-trigger=""
        className="btn btn-ghost !min-h-7 !px-1.5 !py-0 text-xs"
        onClick={() => setOpen((value) => !value)}
      >
        <MoreIcon />
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            data-action-menu=""
            style={{ position: 'fixed', top: position.top, left: position.left, width: MENU_WIDTH }}
            className="z-50 flex flex-col rounded-lg border border-line bg-surface py-1 shadow-lg"
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled ?? false}
                className={`px-3 py-1.5 text-left text-xs disabled:opacity-45 ${
                  item.danger === true ? 'text-danger hover:bg-surface-raised' : 'text-body hover:bg-surface-raised'
                }`}
                onClick={() => {
                  setOpen(false)
                  item.onSelect()
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}
