import { useEffect, useState } from 'react'
import type { FsEntry, ShareCreated } from '@webmux/shared'
import { ApiError, absoluteShareUrl, api } from '../../lib/api'

export interface ShareDialogProps {
  entry: FsEntry
  onClose: () => void
  onSignOut: () => void
  /** Fired once a share exists, so the list can pick it up. */
  onChanged: () => void
}

/** `null` hours means the link never expires. */
const TTL_CHOICES: Array<{ label: string; hours: number | null }> = [
  { label: '1 小时', hours: 1 },
  { label: '24 小时', hours: 24 },
  { label: '7 天', hours: 168 },
  { label: '30 天', hours: 720 },
  { label: '永不过期', hours: null },
]

export function ShareDialog({
  entry,
  onClose,
  onSignOut,
  onChanged,
}: ShareDialogProps): React.JSX.Element {
  const [ttlIndex, setTtlIndex] = useState(2)
  const [maxDownloads, setMaxDownloads] = useState('')
  const [password, setPassword] = useState('')
  const [rateLimit, setRateLimit] = useState('')
  const [created, setCreated] = useState<ShareCreated | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleError = (err: unknown, fallback: string): void => {
    if (err instanceof ApiError && err.status === 401) {
      onSignOut()
      return
    }
    setError(err instanceof ApiError ? err.message : fallback)
  }

  async function create(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const share = await api.createShare({
        path: entry.path,
        expiresInHours: TTL_CHOICES[ttlIndex]?.hours ?? null,
        maxDownloads: maxDownloads.trim() === '' ? null : Number(maxDownloads),
        ...(password === '' ? {} : { password }),
        rateLimitBytesPerSec: rateLimit.trim() === '' ? null : Number(rateLimit) * 1024,
      })
      setCreated(share)
      onChanged()
    } catch (err) {
      handleError(err, '创建分享失败')
    } finally {
      setBusy(false)
    }
  }

  async function regenerate(): Promise<void> {
    if (created === null) return
    setBusy(true)
    setError(null)
    try {
      setCreated(await api.regenerateShare(created.id))
      setCopied(false)
      onChanged()
    } catch (err) {
      handleError(err, '重新生成失败')
    } finally {
      setBusy(false)
    }
  }

  async function copy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      // Clipboard access can be denied; the field is selectable either way.
      setError('无法自动复制，请手动选中链接')
    }
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-label={`分享 ${entry.name}`}
        className="surface-card flex max-h-full w-full max-w-lg flex-col overflow-y-auto p-4"
      >
        <h2 className="mb-1 text-sm text-body">
          分享 <span className="font-mono text-xs text-muted">{entry.name}</span>
        </h2>

        {created === null ? (
          <>
            <p className="mb-3 text-xs text-faint">
              {entry.kind === 'dir'
                ? '访客会看到一个文件清单，并且只能整包下载（zip）。'
                : '访客可以直接下载这个文件。'}
            </p>

            <label className="mb-1 text-xs text-muted">有效期</label>
            <select
              className="mb-3 !min-h-9 rounded border border-line bg-ink px-2 text-sm text-body"
              value={ttlIndex}
              onChange={(event) => setTtlIndex(Number(event.target.value))}
            >
              {TTL_CHOICES.map((choice, index) => (
                <option key={choice.label} value={index}>
                  {choice.label}
                </option>
              ))}
            </select>

            <label className="mb-1 text-xs text-muted">下载次数上限（留空为不限）</label>
            <input
              className="field !min-h-9 !py-1 mb-3 text-sm"
              inputMode="numeric"
              placeholder="不限"
              value={maxDownloads}
              onChange={(event) => setMaxDownloads(event.target.value.replace(/\D/g, ''))}
            />

            <label className="mb-1 text-xs text-muted">限速（KB/s，留空为不限）</label>
            <input
              className="field !min-h-9 !py-1 mb-3 text-sm"
              inputMode="numeric"
              placeholder="不限"
              value={rateLimit}
              onChange={(event) => setRateLimit(event.target.value.replace(/\D/g, ''))}
            />

            <label className="mb-1 text-xs text-muted">密码（留空则凭链接即可访问）</label>
            <input
              className="field !min-h-9 !py-1 mb-1 text-sm"
              type="password"
              autoComplete="new-password"
              placeholder="至少 8 位"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <p className="mb-3 text-[11px] leading-relaxed text-faint">
              不要使用你的登录密码。链接可能被转发，同一个密码就意味着一条链接换一台机器。
            </p>

            {error !== null && <p className="mb-2 text-xs text-danger">{error}</p>}

            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                取消
              </button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void create()}>
                {busy ? '创建中…' : '创建链接'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mb-2 text-xs leading-relaxed text-warn">
              这条链接只会显示这一次 —— 服务器只保存它的哈希，之后无法再取回。
              记下来，或者现在就用「重新生成」换一条新的。
            </p>

            <div className="mb-3 flex gap-2">
              <input
                readOnly
                className="field !min-h-9 !py-1 font-mono text-xs"
                value={absoluteShareUrl(created.url)}
                onFocus={(event) => event.target.select()}
                aria-label="分享链接"
              />
              <button
                type="button"
                className="btn btn-primary !px-3"
                onClick={() => void copy(absoluteShareUrl(created.url))}
              >
                {copied ? '已复制' : '复制'}
              </button>
            </div>

            <ul className="mb-3 flex flex-col gap-0.5 text-[11px] text-faint">
              <li>
                有效期：
                {created.expiresAt === null
                  ? '永不过期'
                  : new Date(created.expiresAt).toLocaleString()}
              </li>
              <li>下载上限：{created.maxDownloads ?? '不限'}</li>
              <li>
                限速：
                {created.rateLimitBytesPerSec === 0
                  ? '不限'
                  : `${Math.round(created.rateLimitBytesPerSec / 1024)} KB/s`}
              </li>
              <li>密码：{created.password ? '已设置' : '无'}</li>
            </ul>

            {error !== null && <p className="mb-2 text-xs text-danger">{error}</p>}

            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void regenerate()}>
                {busy ? '生成中…' : '重新生成'}
              </button>
              <button type="button" className="btn btn-primary" onClick={onClose}>
                完成
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
