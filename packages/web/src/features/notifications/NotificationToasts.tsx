import type { NotificationRecord, NotifyLevel } from '@webmux/shared'
import { notifications, useNotifications } from '../../lib/notifications'

const LEVEL_BORDER: Record<NotifyLevel, string> = {
  info: 'border-line-strong',
  warn: 'border-warn',
  error: 'border-danger',
}

export interface NotificationToastsProps {
  onOpenSession: (sessionId: string) => void
}

/**
 * The in-page announcement for a notification that arrives while the page is
 * visible.
 *
 * Deliberately not portalled, unlike the panel: it is anchored to the app's
 * own box (which tracks `visualViewport`), so a phone's soft keyboard cannot
 * push it off-screen. Same reasoning as the dialogs in `App.tsx`.
 *
 * Only shown for the visible tab. A hidden tab goes down the system
 * notification path instead, and showing both would mean two announcements for
 * one event.
 */
export function NotificationToasts({ onOpenSession }: NotificationToastsProps): React.JSX.Element | null {
  const { toasts } = useNotifications()
  if (toasts.length === 0) return null

  const open = (item: NotificationRecord): void => {
    void notifications.markRead(item.id).catch(() => undefined)
    notifications.dismissToast(item.id)
    if (item.sessionId !== null) onOpenSession(item.sessionId)
  }

  return (
    <div
      data-notification-toasts=""
      // Bottom on a phone (thumb reach, and it clears the tab bar), bottom
      // right on a desktop (out of the way of the terminal's cursor).
      className="pointer-events-none absolute inset-x-3 bottom-20 z-50 flex flex-col items-stretch gap-2 sm:inset-x-auto sm:right-4 sm:w-80"
    >
      {toasts.map((item) => (
        <div
          key={item.id}
          data-notification-toast={item.id}
          className={`pointer-events-auto flex items-start gap-2 rounded-lg border-l-2 ${LEVEL_BORDER[item.level]} border-y border-r border-y-line border-r-line bg-surface-raised p-2.5 shadow-lg`}
        >
          <button
            type="button"
            className="min-w-0 flex-1 text-left"
            onClick={() => open(item)}
          >
            <span className="block truncate text-xs text-body">{item.title}</span>
            {item.body !== null && (
              <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-muted">
                {item.body}
              </span>
            )}
            {item.sessionId !== null && (
              <span className="mt-1 block text-[10px] text-faint">点按回到终端</span>
            )}
          </button>
          <button
            type="button"
            aria-label="关闭"
            data-notification-dismiss={item.id}
            className="shrink-0 px-1 text-xs text-faint hover:text-body"
            onClick={() => notifications.dismissToast(item.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
