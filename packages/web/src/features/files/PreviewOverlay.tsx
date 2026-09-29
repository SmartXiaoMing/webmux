import { useEffect, useState } from 'react'
import type { FsEntry } from '@webmux/shared'
import { ApiError, api, fetchPreviewText } from '../../lib/api'

export interface PreviewOverlayProps {
  entry: FsEntry
  onClose: () => void
  onSignOut: () => void
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm', '.mov', '.ogv'])

/**
 * Shows a file without downloading it.
 *
 * Whether a file *may* be shown is decided entirely by the server — `entry.preview`
 * is the server's verdict from its own allowlist, so the client never keeps a
 * second copy of a security-relevant list. What this component does with each
 * verdict is purely presentational.
 */
export function PreviewOverlay({ entry, onClose, onSignOut }: PreviewOverlayProps): React.JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mediaFailed, setMediaFailed] = useState(false)

  const url = api.previewUrl(entry.path)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
        <a
          className="btn btn-ghost !min-h-7 !px-2 !py-0 text-xs"
          href={api.downloadUrl(entry.path)}
          download={entry.name}
        >
          下载
        </a>
        <button type="button" className="btn btn-ghost !min-h-7 !px-2 !py-0 text-xs" onClick={onClose}>
          关闭
        </button>
      </header>

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
    </div>
  )
}
