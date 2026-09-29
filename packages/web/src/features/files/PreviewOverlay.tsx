import { useEffect, useState } from 'react'
import type { FsEntry, FsStat } from '@webmux/shared'
import { ApiError, api, fetchPreviewText } from '../../lib/api'

export interface PreviewOverlayProps {
  entry: FsEntry
  /** The entry's root is read-only, so nothing may be written back to it. */
  readonly: boolean
  onClose: () => void
  /** A save landed; the caller refreshes the list and what stays on screen. */
  onSaved: (stat: FsStat) => void
  onSignOut: () => void
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm', '.mov', '.ogv'])

/**
 * Shows a file without downloading it, and edits it when it is text.
 *
 * Whether a file *may* be shown is decided entirely by the server — `entry.preview`
 * is the server's verdict from its own allowlist, so the client never keeps a
 * second copy of a security-relevant list. What this component does with each
 * verdict is purely presentational.
 *
 * Editing is offered only for text that arrived whole: a truncated preview is
 * the first 512 KiB of a larger file, and saving that would replace the file
 * with its own prefix. The server refuses the same case, because a gate that
 * lives only in the client is not a gate.
 */
export function PreviewOverlay({
  entry,
  readonly,
  onClose,
  onSaved,
  onSignOut,
}: PreviewOverlayProps): React.JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mediaFailed, setMediaFailed] = useState(false)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** Which action a pending discard confirmation belongs to. */
  const [confirming, setConfirming] = useState<'close' | 'cancel' | null>(null)
  /**
   * The mtime this editor is based on, sent with the save so the server can
   * refuse to overwrite a file that changed underneath it. Kept in state
   * rather than read from `entry` so that saving twice in a row works: the
   * second save needs the mtime the first one produced.
   */
  const [mtimeMs, setMtimeMs] = useState(entry.mtimeMs)
  /** A textarea's value normalises CRLF to LF; remember what the file used. */
  const [crlf, setCrlf] = useState(false)

  const url = api.previewUrl(entry.path)

  const dirty = editing && text !== null && draft !== text

  const cancelEdit = (): void => {
    setDraft(text ?? '')
    setSaveError(null)
    setEditing(false)
  }

  const discard = (): void => {
    const action = confirming
    setConfirming(null)
    if (action === 'close') {
      onClose()
      return
    }
    cancelEdit()
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (confirming !== null) {
        setConfirming(null)
        return
      }
      if (dirty) {
        setConfirming('close')
        return
      }
      if (editing) {
        cancelEdit()
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    if (entry.preview !== 'text') return

    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setText(null)

    void fetchPreviewText(entry.path, controller.signal)
      .then((result) => {
        setText(result.text)
        setTruncated(result.truncated)
        setCrlf(result.text.includes('\r\n'))
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        if (err instanceof ApiError && err.status === 401) {
          onSignOut()
          return
        }
        setError(err instanceof ApiError ? err.message : '无法预览')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [entry.path, entry.preview, onSignOut])

  const extension = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()
  const isVideo = VIDEO_EXTENSIONS.has(extension)

  const editable =
    !readonly && entry.preview === 'text' && text !== null && !truncated && !loading && error === null

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    try {
      const stat = await api.saveFileText(
        entry.path,
        crlf ? draft.replace(/\n/g, '\r\n') : draft,
        mtimeMs,
      )
      setText(draft)
      setTruncated(false)
      setMtimeMs(stat.mtimeMs)
      setEditing(false)
      setConfirming(null)
      onSaved(stat)
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 401) {
        onSignOut()
        return
      }
      if (err instanceof ApiError && err.code === 'conflict') {
        // The draft is deliberately left in place: the user's work is the one
        // thing here that cannot be recovered from disk.
        setSaveError('文件已在磁盘上被修改，请重新打开预览后再保存')
      } else if (err instanceof ApiError && err.code === 'too_large') {
        setSaveError('文件过大，无法通过预览编辑')
      } else {
        setSaveError(err instanceof ApiError ? err.message : '保存失败')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col bg-ink/95"
      role="dialog"
      aria-label={`预览 ${entry.name}`}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm text-body" title={entry.path}>
          {entry.name}
        </span>
        {truncated && (
          <span className="shrink-0 text-[11px] text-warn" title="文件过大，只显示开头部分">
            已截断
          </span>
        )}
        {editing ? (
          <>
            <button
              type="button"
              className="btn btn-primary !min-h-7 !px-2 !py-0 text-xs"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="btn btn-ghost !min-h-7 !px-2 !py-0 text-xs"
              disabled={saving}
              onClick={() => {
                if (dirty) {
                  setConfirming('cancel')
                  return
                }
                cancelEdit()
              }}
            >
              取消
            </button>
          </>
        ) : (
          editable && (
            <button
              type="button"
              className="btn btn-ghost !min-h-7 !px-2 !py-0 text-xs"
              onClick={() => {
                setDraft(text ?? '')
                setSaveError(null)
                setEditing(true)
              }}
            >
              编辑
            </button>
          )
        )}
        <a
          className="btn btn-ghost !min-h-7 !px-2 !py-0 text-xs"
          href={api.downloadUrl(entry.path)}
          download={entry.name}
        >
          下载
        </a>
        <button
          type="button"
          className="btn btn-ghost !min-h-7 !px-2 !py-0 text-xs"
          onClick={() => {
            if (dirty) {
              setConfirming('close')
              return
            }
            onClose()
          }}
        >
          关闭
        </button>
      </header>

      {confirming !== null && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-2">
          <span className="min-w-0 flex-1 text-xs text-warn">有未保存的修改</span>
          <button
            type="button"
            className="btn btn-danger !min-h-7 !px-2 !py-0 text-xs"
            onClick={discard}
          >
            放弃修改
          </button>
          <button
            type="button"
            className="btn btn-ghost !min-h-7 !px-2 !py-0 text-xs"
            onClick={() => setConfirming(null)}
          >
            继续编辑
          </button>
        </div>
      )}

      {saveError !== null && (
        <p className="shrink-0 border-b border-line px-3 py-2 text-xs text-danger">{saveError}</p>
      )}

      {editing ? (
        // `text-base` on a phone is not a style choice: iOS Safari zooms the
        // page when a focused field is under 16px and does not zoom back out.
        <textarea
          className="field min-h-0 flex-1 resize-none rounded-none border-0 font-mono leading-relaxed text-base sm:text-xs"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
          autoFocus
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {loading && <p className="text-xs text-faint">载入中…</p>}
          {error !== null && <p className="text-xs text-danger">{error}</p>}

          {entry.preview === null && (
            <p className="text-xs leading-relaxed text-muted">
              这种文件不能内联预览。
              <br />
              请下载后用本地程序打开。
            </p>
          )}

          {entry.preview === 'image' && (
            <img src={url} alt={entry.name} className="mx-auto max-w-full" />
          )}

          {entry.preview === 'pdf' && (
            <iframe src={url} title={entry.name} className="h-full min-h-[70vh] w-full border-0" />
          )}

          {entry.preview === 'media' &&
            (mediaFailed ? (
              <p className="text-xs text-muted">
                这个文件无法在浏览器里播放，请下载后查看。
              </p>
            ) : isVideo ? (
              <video
                src={url}
                controls
                className="mx-auto max-w-full"
                onError={() => setMediaFailed(true)}
              />
            ) : (
              <audio src={url} controls className="w-full" onError={() => setMediaFailed(true)} />
            ))}

          {entry.preview === 'text' && text !== null && (
            // `whitespace-pre-wrap` keeps the file's own line structure while
            // still wrapping long lines, which is what makes a log readable.
            <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-body">
              {text}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
