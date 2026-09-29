import { uploads, useUploadTasks, type UploadTask } from '../../lib/upload'
import { formatBytes } from './format'

/**
 * Progress for uploads in flight.
 *
 * Subscribed through `useSyncExternalStore` because progress updates arrive
 * far too often for `setState` — the store coalesces them into a frame-ish
 * window and this only re-renders when the snapshot actually changes.
 */
export function UploadTray(): React.JSX.Element | null {
  const tasks = useUploadTasks()

  if (tasks.length === 0) return null

  const inFlight = tasks.filter((task) => task.state === 'uploading' || task.state === 'queued').length
  const settled = tasks.length - inFlight

  return (
    <div className="shrink-0 border-t border-line bg-surface px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs text-muted">
          上传队列 {inFlight > 0 ? `· ${inFlight} 进行中` : ''}
        </span>
        {settled > 0 && (
          <button
            type="button"
            className="btn btn-ghost !min-h-6 !px-2 !py-0 text-xs"
            onClick={() => uploads.clearFinished()}
          >
            清除已结束
          </button>
        )}
      </div>

      <ul className="flex max-h-36 flex-col gap-1.5 overflow-y-auto">
        {tasks.map((task) => (
          <UploadRow key={task.key} task={task} />
        ))}
      </ul>
    </div>
  )
}

function UploadRow({ task }: { task: UploadTask }): React.JSX.Element {
  const percent = task.size === 0 ? 100 : Math.min(100, Math.round((task.bytesSent / task.size) * 100))

  const tone =
    task.state === 'failed'
      ? 'text-danger'
      : task.state === 'done'
        ? 'text-ok'
        : task.state === 'cancelled'
          ? 'text-faint'
          : 'text-muted'

  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-body" title={task.name}>
          {task.name}
        </span>
        <span className={`shrink-0 font-mono text-[11px] ${tone}`}>
          {task.state === 'failed'
            ? (task.error ?? '失败')
            : task.state === 'done'
              ? '完成'
              : task.state === 'cancelled'
                ? '已取消'
                : `${percent}%`}
        </span>
        {(task.state === 'uploading' || task.state === 'queued') && (
          <button
            type="button"
            className="btn btn-ghost !min-h-6 !px-1.5 !py-0 text-xs"
            onClick={() => uploads.cancel(task.key)}
          >
            取消
          </button>
        )}
      </div>

      {task.state === 'uploading' && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-line">
          <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${percent}%` }} />
        </div>
      )}

      <span className="font-mono text-[10px] text-faint">
        {formatBytes(task.bytesSent)} / {formatBytes(task.size)}
      </span>
    </li>
  )
}
