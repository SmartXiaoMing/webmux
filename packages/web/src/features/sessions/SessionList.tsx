import { useState } from 'react'
import type { SessionSummary } from '@webmux/shared'
import { SectionHeader } from '../../components/SectionHeader'
import { FolderIcon, PencilIcon, PlusIcon, TerminalIcon } from '../../components/icons'

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

interface SessionNode {
  session: SessionSummary
  children: SessionSummary[]
}

/**
 * Groups sessions into roots and their children.
 *
 * One level only, which is enforced server-side: a session opened from a child
 * joins that child's root rather than nesting further. Both lists arrive
 * already sorted by `lastAttachedAt` (the registry does that), and `filter`
 * preserves that order, so neither level needs re-sorting here.
 *
 * A `parentId` pointing at a session that is not in the list makes the session
 * a root. That happens whenever a parent is killed or its shell exits, and the
 * tree is presentation — a session nobody can see is a worse outcome than one
 * at the top level.
 */
function buildTree(sessions: SessionSummary[]): SessionNode[] {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const children = new Map<string, SessionSummary[]>()
  const roots: SessionSummary[] = []

  for (const session of sessions) {
    if (session.parentId !== null && byId.has(session.parentId)) {
      const siblings = children.get(session.parentId)
      if (siblings) siblings.push(session)
      else children.set(session.parentId, [session])
    } else {
      roots.push(session)
    }
  }

  return roots.map((session) => ({ session, children: children.get(session.id) ?? [] }))
}

export interface SessionListProps {
  sessions: SessionSummary[]
  activeId: string | null
  onSelect: (id: string) => void
  onKill: (id: string) => void
  onRename: (id: string, title: string) => void
  /** Opens a shell rooted at this session's own directory. */
  onNewSession: (parent: SessionSummary) => void
}

/**
 * The session list.
 *
 * There is deliberately no "new session" button in the header. A terminal is
 * only useful in the directory you meant, so a session is created either from
 * the file browser — navigate, then ask for a shell in that directory — or from
 * another session, whose directory is exactly the one you were just working in.
 * A header button would have to guess a directory or make the user pick twice.
 */
export function SessionList({
  sessions,
  activeId,
  onSelect,
  onKill,
  onRename,
  onNewSession,
}: SessionListProps): React.JSX.Element {
  const [open, setOpen] = useState(true)
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

  function row(session: SessionSummary, nested: boolean): React.JSX.Element {
    const active = session.id === activeId

    if (editingId === session.id) {
      return (
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
      )
    }

    return (
      <div
        className={`group flex items-center gap-0.5 rounded-lg px-2 py-1.5 ${
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
              A terminal glyph replaces the status dot rather than joining it:
              its colour carries exactly the distinction the dot did, and a
              288px row has no room for two leading marks.
            */}
            <span
              className={`shrink-0 ${session.running ? 'text-ok' : 'text-faint'}`}
              title={session.running ? '运行中' : '已结束'}
            >
              <TerminalIcon size={13} />
            </span>
            <span className={`truncate text-sm ${active ? 'text-body' : 'text-muted'}`}>
              {session.title}
            </span>
            {session.clients > 0 && (
              <span className="shrink-0 rounded bg-accent-dim/40 px-1 text-[10px] text-accent">
                {session.clients}
              </span>
            )}
          </span>
          {/*
            The live directory, which is what actually tells two sessions
            apart — hence `shortPath` rather than leaving it to CSS truncation.
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

        {/* Always visible rather than hover-revealed: this is how a session tree
            gets built, and an affordance you have to discover by hovering is not
            one a touch screen can offer at all. Kept at low emphasis so a column
            of them does not compete with the titles. */}
        <button
          type="button"
          className="shrink-0 rounded px-1 text-faint hover:text-accent"
          data-session-new={session.id}
          aria-label={`在 ${session.title} 的目录新建会话`}
          title="在此目录新建会话"
          onClick={() => onNewSession(session)}
        >
          <PlusIcon size={13} />
        </button>

        <button
          type="button"
          className="shrink-0 rounded px-1 text-faint opacity-0 transition-opacity hover:text-accent focus-visible:opacity-100 group-hover:opacity-100 max-md:opacity-60"
          data-session-rename={session.id}
          aria-label={`重命名 ${session.title}`}
          title="重命名（也可以双击）"
          onClick={() => startRename(session)}
        >
          <PencilIcon size={13} />
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
          // Killing a session destroys whatever is running in it, so it takes
          // two taps rather than one.
          <button
            type="button"
            className="btn btn-danger shrink-0 !min-h-7 !px-1.5 !py-0 text-xs opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-60"
            title="终止会话"
            onClick={() => setConfirmKillId(session.id)}
          >
            ✕
          </button>
        )}
        {nested && <span className="sr-only">（子会话）</span>}
      </div>
    )
  }

  return (
    <div className={open ? 'flex min-h-0 flex-1 flex-col' : 'shrink-0'}>
      <SectionHeader
        label="会话"
        icon={<TerminalIcon size={12} />}
        count={sessions.length}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        testId="sessions"
      />

      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {sessions.length === 0 && (
            <p className="px-2 py-6 text-center text-xs leading-relaxed text-faint">
              还没有会话
              <br />
              点击「新建」创建一个持久终端
            </p>
          )}

          <ul className="space-y-0.5">
            {buildTree(sessions).map(({ session, children }) => (
              <li key={session.id}>
                {row(session, false)}
                {children.length > 0 && (
                  // Indented with a rule down the left, so the parent-child
                  // relationship survives even when the parent row is wider
                  // than the child's text.
                  <ul className="mt-0.5 ml-3 space-y-0.5 border-l border-line pl-1">
                    {children.map((child) => (
                      <li key={child.id}>{row(child, true)}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
