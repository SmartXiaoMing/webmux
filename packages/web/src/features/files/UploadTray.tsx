import { useState } from 'react'
import { uploads, useUploadTasks, type BatchInfo, type UploadTask } from '../../lib/upload'
import { formatBytes } from './format'

/**
 * Progress for uploads in flight.
 *
 * Subscribed through `useSyncExternalStore` because progress updates arrive
 * far too often for `setState` — the store coalesces them into a frame-ish
 * window and this only re-renders when the snapshot actually changes.
 */

/**
 * Above this many files, a batch starts collapsed.
 *
 * A folder upload is a thousand rows otherwise, and the interesting thing
 * about it is the summary: how far along, and whether anything failed.
 */
const COLLAPSE_ABOVE = 8

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
        {groupTasks(tasks).map((group) =>
          group.batch === null ? (
            group.tasks.map((task) => <UploadRow key={task.key} task={task} />)
          ) : (
            <BatchRow key={group.batch.id} batch={group.batch} tasks={group.tasks} />
          ),
        )}
      </ul>
    </div>
  )
}

interface TaskGroup {
  batch: BatchInfo | null
  tasks: UploadTask[]
}

/**
 * One batch, one row — a folder upload otherwise buries the tray.
 *
 * Single-file uploads have no batch and keep rendering exactly as they always
 * have; only a folder (or a multi-file drop) gets a group.
 */
function groupTasks(tasks: readonly UploadTask[]): TaskGroup[] {
  const groups: TaskGroup[] = []
  const byId = new Map<string, TaskGroup>()

  for (const task of tasks) {
    if (task.batch === null) {
      groups.push({ batch: null, tasks: [task] })
      continue
    }
    let group = byId.get(task.batch.id)
    if (group === undefined) {
      group = { batch: task.batch, tasks: [] }
      byId.set(task.batch.id, group)
      groups.push(group)
    }
    group.tasks.push(task)
  }

  return groups
}

function BatchRow({ batch, tasks }: { batch: BatchInfo; tasks: UploadTask[] }): React.JSX.Element {
  // null means "decide from the batch itself", so a failure appearing later
  // still opens the group — until the user says otherwise.
  const [expanded, setExpanded] = useState<boolean | null>(null)

  const failed = tasks.filter((task) => task.state === 'failed').length
  const finished = tasks.filter((task) => task.state !== 'uploading' && task.state !== 'queued').length
  const bytesSent = tasks.reduce((sum, task) => sum + task.bytesSent, 0)
  const size = tasks.reduce((sum, task) => sum + task.size, 0)
  const allDone = finished === tasks.length

  const open = expanded ?? (failed > 0 || tasks.length <= COLLAPSE_ABOVE)
  const percent = size === 0 ? 100 : Math.min(100, Math.round((bytesSent / size) * 100))

  const summary = allDone
    ? failed > 0
      ? `${tasks.length - failed}/${tasks.length} · ${failed} 失败`
      : `${tasks.length} 个文件 · 完成`
    : `${finished}/${tasks.length}`

  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-xs text-body"
          title={batch.label}
          onClick={() => setExpanded(!open)}
        >
          {open ? '▾' : '▸'} {batch.label}
        </button>
        <span
          className={`shrink-0 font-mono text-[11px] ${
            failed > 0 ? 'text-danger' : allDone ? 'text-ok' : 'text-muted'
          }`}
        >
          {summary}
        </span>
      </div>

      <div className="h-1 w-full overflow-hidden rounded-full bg-line">
        <div
          className={`h-full transition-[width] duration-200 ${failed > 0 ? 'bg-danger' : 'bg-accent'}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <span className="font-mono text-[10px] text-faint">
        {formatBytes(bytesSent)} / {formatBytes(size)}
      </span>

      {open && (
        <ul className="flex flex-col gap-1.5 border-l border-line pl-2">
          {tasks.map((task) => (
            <UploadRow key={task.key} task={task} />
          ))}
        </ul>
      )}
    </li>
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
        {/* The relative path, not the bare name: a folder upload is mostly
            same-named files, and `index.js` alone says nothing about which. */}
        <span className="min-w-0 flex-1 truncate text-xs text-body" title={task.target}>
          {task.relPath ?? task.name}
        </span>
        <span className={`shrink-0 font-mono text-[11px] ${tone}`}>
          {task.state === 'failed'
            ? (task.error ?? '失败')
            : task.state === 'done'
              ? '完成'
              : task.state === 'cancelled'
                ? '已取消'
                : task.state === 'queued'
                  ? '排队中'
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
