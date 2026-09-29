import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FsEntry, FsListing } from '@webmux/shared'
import { ApiError, api } from '../../lib/api'
import { breadcrumbs, joinPath } from './format'

export interface MoveDialogProps {
  entry: FsEntry
  onClose: () => void
  onMoved: () => void
  onSignOut: () => void
}

/**
 * Picks a destination directory, then renames into it.
 *
 * There is no `move` endpoint and there does not need to be one: `rename`
 * already accepts any from → to inside the jail, so a cross-directory move is
 * the same request. A second endpoint that did exactly what rename does would
 * be a second thing to keep in step, not a feature.
 */
export function MoveDialog({ entry, onClose, onMoved, onSignOut }: MoveDialogProps): React.JSX.Element {
  const parent = useMemo(() => {
    const withoutName = entry.path.slice(0, entry.path.length - entry.name.length)
    return withoutName.length > 1 ? withoutName.replace(/\/$/, '') : withoutName
  }, [entry.path, entry.name])

  const [path, setPath] = useState(parent)
  const [listing, setListing] = useState<FsListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    async (target: string): Promise<void> => {
      setLoading(true)
      try {
        const result = await api.listFiles(target, { sort: 'name' })
        setListing(result)
        setError(null)
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          onSignOut()
          return
        }
        setListing(null)
        setError(err instanceof ApiError ? err.message : '无法列出该目录')
      } finally {
        setLoading(false)
      }
    },
    [onSignOut],
  )

  useEffect(() => {
    void load(path)
  }, [path, load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Moving a directory into itself or into one of its own descendants would
  // detach the subtree from the tree entirely.
  const intoItself =
    entry.kind === 'dir' && (path === entry.path || path.startsWith(`${entry.path}/`))

  const target = joinPath(path, entry.name)

  const move = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.renameEntry(entry.path, target)
      onMoved()
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onSignOut()
        return
      }
      setError(err instanceof ApiError ? err.message : '移动失败')
    } finally {
      setBusy(false)
    }
  }, [entry.path, target, onMoved, onSignOut])

  const crumbs = breadcrumbs(path).slice(-4)

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-label={`移动 ${entry.name}`}
        className="surface-card flex max-h-full w-full max-w-lg flex-col p-3"
      >
        <p className="mb-2 text-sm text-body">
          移动 <span className="font-mono text-xs text-muted">{entry.name}</span> 到
        </p>

        <div className="mb-2 flex items-center gap-0.5 overflow-x-auto rounded border border-line bg-ink px-1 py-1">
          {crumbs.map((crumb, index) => (
            <span key={crumb.path} className="flex shrink-0 items-center">
              {index > 0 && <span className="px-0.5 text-faint">/</span>}
              <button
                type="button"
                className={`max-w-28 truncate rounded px-1 py-0.5 font-mono text-[11px] ${
                  index === crumbs.length - 1 ? 'text-body' : 'text-muted hover:text-accent'
                }`}
                onClick={() => setPath(crumb.path)}
                title={crumb.path}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </div>

        <div className="mb-2 min-h-40 flex-1 overflow-y-auto rounded border border-line">
          {loading && <p className="px-3 py-4 text-xs text-faint">载入中…</p>}
          {!loading && listing?.entries.filter((child) => child.kind === 'dir').length === 0 && (
            <p className="px-3 py-4 text-xs text-faint">这里没有子目录</p>
          )}
          <ul>
            {listing?.entries
              .filter((child) => child.kind === 'dir')
              .map((child) => (
                <li key={child.path}>
                  <button
                    type="button"
                    className="w-full border-b border-line px-3 py-1.5 text-left text-sm text-body hover:bg-surface-raised/60"
                    onClick={() => setPath(child.path)}
                  >
                    {/* Hidden from the accessible name: a screen reader should
                        hear the directory, not "black right-pointing small
                        triangle". */}
                    <span aria-hidden="true" className="mr-1.5 font-mono text-xs text-accent">
                      ▸
                    </span>
                    {child.name}
                  </button>
                </li>
              ))}
          </ul>
        </div>

        <p className="mb-2 truncate font-mono text-[11px] text-faint" title={target}>
          → {target}
        </p>

        {error !== null && <p className="mb-2 text-xs text-danger">{error}</p>}
        {intoItself && (
          <p className="mb-2 text-xs text-warn">不能把一个目录移动到它自己里面。</p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || intoItself}
            onClick={() => void move()}
          >
            {busy ? '移动中…' : '移动到此处'}
          </button>
        </div>
      </div>
    </div>
  )
}
