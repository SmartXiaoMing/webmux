import { useState } from 'react'
import type { SessionSummary } from '@webmux/shared'
import { FolderIcon, TerminalIcon } from '../../components/icons'

function relativeTime(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000)
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86_400)} 天前`
}

/** Longest tail kept by `shortPath`, in characters. */
const PATH_BUDGET = 28

/**
 * Trims a path down to its **tail**, for a 288px sidebar.
 *
 * Letting CSS truncate from the right would cut off exactly the part that
 * distinguishes two sessions: `/Users/mi/work/a` and `/Users/mi/work/b` both
 * render as `/Users/mi/work/…`, which is the one question this line exists to
 * answer. Dropping leading segments instead keeps the end — the directory you
 * are actually in — and the full path stays in the row's tooltip.
 *
 * The last two segments are kept unconditionally, and CSS ellipsis is the
 * backstop when even those are too long.
 */
function shortPath(path: string, budget = PATH_BUDGET): string {
  const parts = path.split('/').filter(Boolean)
  // Either it already fits, or there is only one segment and nothing to drop.
  if (path.length <= budget || parts.length <= 2) return path

  let tail = parts.slice(-2).join('/')
  for (let i = parts.length - 3; i >= 0; i -= 1) {
    const candidate = `${parts[i]}/${tail}`
    if (candidate.length > budget) break
    tail = candidate
  }
  return `…/${tail}`
}

export interface SessionListProps {
  sessions: SessionSummary[]
  activeId: string | null
  onSelect: (id: string) => void
  onKill: (id: string) => void
  onRename: (id: string, title: string) => void
}

/**
 * The session list.
 *
 * There is deliberately no "new session" button here. A terminal is only
 * useful in the directory you meant, so sessions are created from the file
 * browser — navigate, then ask for a shell in that directory. A button here
 * would either have to guess a directory or make the user pick one twice.
 */
export function SessionList({
  sessions,
  activeId,
  onSelect,
  onKill,
  onRename,
}: SessionListProps): React.JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirmKillId, setConfirmKillId] = useState<string | null>(null)

  function startRename(session: SessionSummary): void {
    setEditingId(session.id)
    setDraft(session.title)
  }

  function commitRename(): void {
    const title = draft.trim()
    if (editingId && title) onRename(editingId, title)
    setEditingId(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-3 py-3">
        <TerminalIcon size={12} />
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">会话</h2>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {sessions.length === 0 && (
          <p className="px-2 py-6 text-center text-xs leading-relaxed text-faint">
            还没有会话
            <br />
            点击「新建」创建一个持久终端
          </p>
        )}

        <ul className="space-y-0.5">
          {sessions.map((session) => {
            const active = session.id === activeId
            return (
              <li key={session.id}>
                {editingId === session.id ? (
                  <input
                    className="field !min-h-9 !py-1 text-sm"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                  />
                ) : (
                  <div
                    className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 ${
                      active ? 'bg-surface-raised' : 'hover:bg-surface-raised/60'
                    }`}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => onSelect(session.id)}
                      onDoubleClick={() => startRename(session)}
                    >
                      <span className="flex items-center gap-1.5">
                        {/*
                          A terminal glyph replaces the status dot rather than
                          joining it: its colour carries exactly the distinction
                          the dot did, and a 288px row has no room for two
                          leading marks.
                        */}
                        <span
                          className={`shrink-0 ${session.running ? 'text-ok' : 'text-faint'}`}
                          title={session.running ? '运行中' : '已结束'}
                        >
                          <TerminalIcon size={13} />
                        </span>
                        <span
                          className={`truncate text-sm ${active ? 'text-body' : 'text-muted'}`}
                        >
                          {session.title}
                        </span>
                        {session.clients > 0 && (
                          <span className="shrink-0 rounded bg-accent-dim/40 px-1 text-[10px] text-accent">
                            {session.clients}
                          </span>
                        )}
                      </span>
                      {/*
                        The live directory, which is what actually tells two
                        sessions apart — hence `shortPath` rather than leaving
                        it to CSS truncation. See that function for why.
                      */}
                      <span className="mt-0.5 flex items-center gap-1">
                        <span className="shrink-0 text-faint">
                          <FolderIcon size={11} />
                        </span>
                        <span
                          data-session-cwd={session.id}
                          title={session.liveCwd}
                          className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint"
                        >
                          {shortPath(session.liveCwd)}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-faint">
                          {relativeTime(session.lastAttachedAt)}
                        </span>
                      </span>
                    </button>

                    {confirmKillId === session.id ? (
                      <span className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          className="btn btn-danger !min-h-7 !px-1.5 !py-0 text-[11px]"
                          onClick={() => {
                            onKill(session.id)
                            setConfirmKillId(null)
                          }}
                        >
                          确认
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost !min-h-7 !px-1.5 !py-0 text-[11px]"
                          onClick={() => setConfirmKillId(null)}
                        >
                          取消
                        </button>
                      </span>
                    ) : (
                      // Killing a session destroys whatever is running in it,
                      // so it takes two taps rather than one.
                      <button
                        type="button"
                        className="btn btn-danger shrink-0 !min-h-7 !px-1.5 !py-0 text-xs opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-60"
                        title="终止会话"
                        onClick={() => setConfirmKillId(session.id)}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
