import { useCallback, useEffect, useState } from 'react'
import type { ShareSummary, SharesConfigDefaults } from '@webmux/shared'
import { ApiError, absoluteShareUrl, api } from '../../lib/api'
import { formatBytes, formatTime } from '../files/format'

export interface ShareListProps {
  onSignOut: () => void
  /** Bumped by the caller so a share created elsewhere shows up here. */
  reloadKey: number
}

export function ShareList({ onSignOut, reloadKey }: ShareListProps): React.JSX.Element {
  const [shares, setShares] = useState<ShareSummary[]>([])
  const [config, setConfig] = useState<SharesConfigDefaults | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null)
  /** The one and only sight of a freshly regenerated URL. */
  const [revealed, setRevealed] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const result = await api.listShares()
      setShares(result.shares)
      setConfig(result.config)
      setError(null)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onSignOut()
        return
      }
      setError(err instanceof ApiError ? err.message : '无法加载分享列表')
    } finally {
      setLoading(false)
    }
  }, [onSignOut])

  useEffect(() => {
    void load()
  }, [load, reloadKey])

  const handle = useCallback(
    async (id: string, action: () => Promise<void>, fallback: string): Promise<void> => {
      setBusyId(id)
      setError(null)
      try {
        await action()
        await load()
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          onSignOut()
          return
        }
        setError(err instanceof ApiError ? err.message : fallback)
      } finally {
        setBusyId(null)
      }
    },
    [load, onSignOut],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <span className="text-xs text-muted">
          分享链接
          {config !== null && ` · 最多 ${config.maxActive} 条同时有效`}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="btn btn-ghost !min-h-7 !px-2 !py-0 text-xs"
          onClick={() => void load()}
        >
          刷新
        </button>
      </div>

      {error !== null && (
        <div className="shrink-0 border-b border-line bg-surface px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      {revealed !== null && (
        <div className="shrink-0 border-b border-line bg-surface px-3 py-2">
          <p className="mb-1.5 text-[11px] text-warn">
            新链接只会显示这一次，服务器只存哈希。请现在复制。
          </p>
          <div className="flex gap-2">
            <input
              readOnly
              className="field !min-h-8 !py-1 font-mono text-xs"
              value={revealed}
              aria-label="新的分享链接"
              onFocus={(event) => event.target.select()}
            />
            <button
              type="button"
              className="btn btn-primary !min-h-8 !px-2 !py-0 text-xs"
              onClick={() => void navigator.clipboard.writeText(revealed).catch(() => {})}
            >
              复制
            </button>
            <button
              type="button"
              className="btn btn-ghost !min-h-8 !px-2 !py-0 text-xs"
              onClick={() => setRevealed(null)}
            >
              收起
            </button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && shares.length === 0 && <p className="px-3 py-6 text-center text-xs text-faint">载入中…</p>}

        {!loading && shares.length === 0 && (
          <p className="px-3 py-6 text-center text-xs leading-relaxed text-faint">
            还没有分享链接
            <br />
            在「文件」里选中一个文件或目录，用「分享」创建。
          </p>
        )}

        <ul>
          {shares.map((share) => (
            <li key={share.id} className="border-b border-line px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-body" title={share.path}>
                  {share.name}
                </span>
                <span className="shrink-0 text-[10px] text-faint">{share.kind === 'dir' ? '目录' : '文件'}</span>
                {share.password && (
                  <span className="shrink-0 rounded border border-line px-1 text-[10px] text-muted">密码</span>
                )}
                {share.revoked ? (
                  <span className="shrink-0 text-[10px] text-danger">已撤销</span>
                ) : !share.available ? (
                  <span className="shrink-0 text-[10px] text-warn" title="底层的文件或根目录已经找不到了">
                    源已失效
                  </span>
                ) : !share.active ? (
                  <span className="shrink-0 text-[10px] text-muted">已失效</span>
                ) : (
                  <span className="shrink-0 text-[10px] text-ok">有效</span>
                )}
              </div>

              <p className="mt-0.5 font-mono text-[10px] text-faint">
                {share.expiresAt === null ? '永不过期' : `到期 ${formatTime(share.expiresAt)}`}
                {' · '}
                下载 {share.downloads}
                {share.maxDownloads === null ? '' : `/${share.maxDownloads}`}
                {share.size === null ? '' : ` · ${formatBytes(share.size)}`}
                {share.lastAccessAt === null ? '' : ` · 最近访问 ${formatTime(share.lastAccessAt)}`}
              </p>

              {confirmRevoke === share.id ? (
                <div className="mt-1.5 flex items-center gap-1">
                  <span className="text-[11px] text-warn">撤销后这条链接立刻失效。</span>
                  <button
                    type="button"
                    className="btn btn-danger !min-h-7 !px-2 !py-0 text-xs"
                    disabled={busyId === share.id}
                    onClick={() =>
                      void handle(share.id, () => api.revokeShare(share.id), '撤销失败').then(() =>
                        setConfirmRevoke(null),
                      )
                    }
                  >
                    确认撤销
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost !min-h-7 !px-2 !py-0 text-xs"
                    onClick={() => setConfirmRevoke(null)}
                  >
                    取消
                  </button>
                </div>
              ) : (
                !share.revoked && (
                  <div className="mt-1.5 flex items-center gap-1">
                    <button
                      type="button"
                      className="btn btn-ghost !min-h-7 !px-2 !py-0 text-xs"
                      disabled={busyId === share.id}
                      title="换一条新链接；旧链接立刻失效"
                      onClick={() =>
                        void handle(
                          share.id,
                          async () => {
                            const fresh = await api.regenerateShare(share.id)
                            setRevealed(absoluteShareUrl(fresh.url))
                          },
                          '重新生成失败',
                        )
                      }
                    >
                      重新生成
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger !min-h-7 !px-2 !py-0 text-xs"
                      onClick={() => setConfirmRevoke(share.id)}
                    >
                      撤销
                    </button>
                  </div>
                )
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
