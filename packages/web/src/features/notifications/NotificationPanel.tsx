import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { NotificationRecord, NotifyLevel } from '@webmux/shared'
import { BellIcon } from '../../components/icons'
import { notifications, useNotifications } from '../../lib/notifications'
import { relativeTime } from '../../lib/time'
import { PushToggle } from './PushToggle'

const PANEL_WIDTH = 340
const PANEL_MAX_HEIGHT = 430
const GUTTER = 8

/** A left edge stripe, so a failure reads as one at a glance. */
const LEVEL_ACCENT: Record<NotifyLevel, string> = {
  info: 'bg-line-strong',
  warn: 'bg-warn',
  error: 'bg-danger',
}

export interface NotificationPanelProps {
  /** Jumps to the terminal a notification came from. */
  onOpenSession: (sessionId: string) => void
}

/**
 * The bell, its unread badge, and the panel behind them.
 *
 * Positioned by portalling to `document.body` and computing coordinates from
 * the trigger's rect — the same reason as `ActionMenu`: the header sits above
 * content that scrolls, and an absolutely-positioned panel would be clipped by
 * it. Flipping and clamping are copied rather than shared, because this panel
 * is a different size and the placement rule that matters is "stay on screen",
 * which each one expresses for its own dimensions.
 */
export function NotificationPanel({ onOpenSession }: NotificationPanelProps): React.JSX.Element | null {
  const { items, unread, available } = useNotifications()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

  const place = useCallback((): void => {
    const trigger = triggerRef.current
    if (trigger === null) return

    const rect = trigger.getBoundingClientRect()
    const height = Math.min(PANEL_MAX_HEIGHT, window.innerHeight - 2 * GUTTER)
    const below = rect.bottom + GUTTER + height <= window.innerHeight
    const top = below ? rect.bottom + GUTTER : Math.max(GUTTER, rect.top - GUTTER - height)
    const left = Math.min(
      Math.max(GUTTER, rect.right - PANEL_WIDTH),
      window.innerWidth - PANEL_WIDTH - GUTTER,
    )
    setPosition({ top, left })
  }, [])

  useEffect(() => {
    if (!open) return
    place()

    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (panelRef.current?.contains(target) === true) return
      if (triggerRef.current?.contains(target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const close = (): void => setOpen(false)
    const onScroll = (event: Event): void => {
      // Capture phase, so a scroll inside a nested container is seen — but
      // this panel *has* one, its own list, and closing on it would make every
      // notification below the first screenful unreachable. Menu.tsx can treat
      // any scroll as "the anchor moved"; a scroll inside the panel is the
      // user reading it.
      if (panelRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)

    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open, place])

  const openItem = (item: NotificationRecord): void => {
    void notifications.markRead(item.id).catch(() => undefined)
    // A notification whose session is gone stays a plain row: the list is
    // history, and history does not get to resurrect a terminal.
    if (item.sessionId !== null) {
      onOpenSession(item.sessionId)
      setOpen(false)
    }
  }

  // Nothing to offer: with the feature switched off there is no ingress to
  // call and nothing to stream, so the bell would only lead to an empty panel
  // suggesting a command that returns 404.
  if (!available) return null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread > 0 ? `通知（${unread} 条未读）` : '通知'}
        title="通知"
        data-notification-bell=""
        className="btn btn-ghost relative !min-h-8 !px-2 !py-0"
        onClick={() => {
          const next = !open
          setOpen(next)
          // Opening the panel is the moment a stale list is most obvious, and
          // the one moment a fetch costs nothing anyone notices.
          if (next) void notifications.refresh().catch(() => undefined)
        }}
      >
        <BellIcon size={15} />
        {unread > 0 && (
          <span
            data-notification-badge=""
            className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-accent px-1 text-[10px] leading-4 text-ink"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="通知"
            data-notification-panel=""
            style={{ position: 'fixed', top: position.top, left: position.left, width: PANEL_WIDTH }}
            className="z-50 flex flex-col rounded-lg border border-line bg-surface shadow-lg"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
              <span className="text-xs text-body">通知</span>
              <button
                type="button"
                data-notification-read-all=""
                disabled={unread === 0}
                className="btn btn-ghost !min-h-6 !px-2 !py-0 text-[11px]"
                onClick={() => void notifications.markAllRead().catch(() => undefined)}
              >
                全部已读
              </button>
            </div>

            <div
              style={{ maxHeight: PANEL_MAX_HEIGHT - 96 }}
              className="min-h-0 flex-1 overflow-y-auto"
            >
              {items.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-faint">
                  还没有通知。
                  <br />
                  命令跑完时执行 <code className="font-mono text-muted">webmux notify "好了"</code>
                </p>
              ) : (
                items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-notification-item={item.id}
                    className="flex w-full gap-2 border-b border-line px-3 py-2 text-left last:border-b-0 hover:bg-surface-raised"
                    onClick={() => openItem(item)}
                  >
                    <span className={`mt-1 w-0.5 shrink-0 self-stretch rounded ${LEVEL_ACCENT[item.level]}`} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-1.5">
                        <span
                          className={`min-w-0 flex-1 truncate text-xs ${item.read ? 'text-muted' : 'text-body'}`}
                        >
                          {item.title}
                        </span>
                        {!item.read && <span className="size-1.5 shrink-0 rounded-full bg-accent" />}
                      </span>
                      {item.body !== null && (
                        <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-faint">
                          {item.body}
                        </span>
                      )}
                      <span className="mt-1 block text-[10px] text-faint">
                        {relativeTime(item.createdAt)}
                        {item.source !== null && ` · ${item.source}`}
                        {item.sessionId !== null && ' · 点按回到终端'}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>

            <PushToggle />
          </div>,
          document.body,
        )}
    </>
  )
}
