import { useCallback, useEffect, useState } from 'react'
import { pushAvailability, subscribeToPush, unsubscribeFromPush, type PushAvailability } from '../../lib/push'
import { notifications } from '../../lib/notifications'

type PermissionState = NotificationPermission | 'unsupported'

function currentPermission(): PermissionState {
  // Safari on iOS exposes the constructor only in an installed web app; in a
  // plain tab it is simply absent, and saying so is better than a button that
  // silently does nothing.
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

/** What to say under the two rows, given everything that can be wrong. */
function availabilityNote(state: PushAvailability | null): string | null {
  if (state === null) return null
  switch (state.kind) {
    case 'insecure':
      return '手机推送需要 HTTPS：浏览器只在安全上下文里提供推送，http://192.168.x.x 这样的地址没有这个能力。给 webmux 配一个反代证书，或者用 Tailscale 之类的 https 入口。'
    case 'unsupported':
      return '这个浏览器里拿不到推送：可能是开发模式（没有 Service Worker），或者浏览器不支持。iOS 上还需要先把页面“添加到主屏幕”。'
    case 'server-off':
      return '服务端没有开启推送。'
    case 'disabled':
      return '服务端关闭了通知功能。'
    default:
      return null
  }
}

/**
 * The delivery controls at the foot of the notification panel.
 *
 * Two questions, because the implementation behind them differs by an order of
 * magnitude while the expectation does not: will I be told while the page is
 * in the background, and will I be told once it is closed.
 */
export function PushToggle(): React.JSX.Element {
  const [permission, setPermission] = useState<PermissionState>(currentPermission)
  const [availability, setAvailability] = useState<PushAvailability | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setAvailability(await pushAvailability())
    } catch {
      setAvailability({ kind: 'server-off' })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const ask = async (): Promise<void> => {
    setBusy(true)
    try {
      setPermission(await notifications.requestDesktopPermission())
    } finally {
      setBusy(false)
    }
  }

  const togglePush = async (): Promise<void> => {
    if (availability === null || availability.kind !== 'ready') return
    setBusy(true)
    setError(null)
    try {
      if (availability.subscription !== null && !availability.staleKey) {
        await unsubscribeFromPush()
      } else {
        await subscribeToPush(availability)
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const note = error ?? availabilityNote(availability)
  const pushReady = availability?.kind === 'ready'
  const subscribed = pushReady && availability.subscription !== null && !availability.staleKey

  return (
    <div className="shrink-0 border-t border-line px-3 py-2 text-[11px]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-faint">桌面通知</span>
        {permission === 'granted' && <span className="text-ok">已开启</span>}
        {permission === 'unsupported' && <span className="text-faint">此浏览器不支持</span>}
        {permission === 'denied' && (
          <span className="text-warn" title="在浏览器的站点设置里恢复通知权限">
            已被拒绝
          </span>
        )}
        {permission === 'default' && (
          <button
            type="button"
            data-notification-permission=""
            disabled={busy}
            className="btn btn-ghost !min-h-6 !px-2 !py-0 text-[11px]"
            onClick={() => void ask()}
          >
            开启
          </button>
        )}
      </div>
      <p className="mt-1 leading-snug text-faint">
        页面切到后台时用系统通知提醒；页面开着时用应用内提示，不重复打扰。
      </p>

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-line pt-2">
        <span className="text-faint">手机推送</span>
        {pushReady ? (
          <button
            type="button"
            data-notification-push=""
            disabled={busy}
            className="btn btn-ghost !min-h-6 !px-2 !py-0 text-[11px]"
            onClick={() => void togglePush()}
          >
            {busy ? '处理中…' : subscribed ? '关闭' : availability.staleKey ? '重新订阅' : '开启'}
          </button>
        ) : (
          <span className="text-faint">不可用</span>
        )}
      </div>
      <p className="mt-1 leading-snug text-faint">
        {subscribed && availability.kind === 'ready'
          ? `页面关掉、手机锁屏也能收到（共 ${availability.devices} 台设备）。`
          : '开启后，页面彻底关掉也能收到通知。'}
      </p>
      {note !== null && <p className="mt-1 leading-snug text-warn">{note}</p>}
    </div>
  )
}
