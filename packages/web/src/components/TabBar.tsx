export type WorkspaceView = 'terminal' | 'files' | 'shares'

/**
 * The mobile tab bar.
 *
 * Only the tabs that exist. DESIGN §7 sketches four (终端 / 文件 / 分享 / 设置);
 * 分享 arrived with P3, and 设置 has nothing behind it yet — a tab that opens
 * onto nothing is a bug the user meets in the first minute. Adding an entry
 * here later is a one-line change, and the array exists so that stays true.
 */
const TABS: Array<{ id: WorkspaceView; label: string }> = [
  { id: 'terminal', label: '终端' },
  { id: 'files', label: '文件' },
  { id: 'shares', label: '分享' },
]

export interface TabBarProps {
  active: WorkspaceView
  onChange: (view: WorkspaceView) => void
  /** In-progress uploads, surfaced on the files tab so they are not forgotten. */
  busyUploads?: number
}

export function TabBar({ active, onChange, busyUploads = 0 }: TabBarProps): React.JSX.Element {
  return (
    <nav
      className="flex shrink-0 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      aria-label="主导航"
    >
      {TABS.map((tab) => {
        const selected = tab.id === active
        return (
          <button
            key={tab.id}
            type="button"
            aria-current={selected ? 'page' : undefined}
            onClick={() => onChange(tab.id)}
            className={`flex min-h-12 flex-1 items-center justify-center gap-1.5 text-xs ${
              selected ? 'text-accent' : 'text-muted'
            }`}
          >
            {tab.label}
            {tab.id === 'files' && busyUploads > 0 && (
              <span className="rounded-full bg-accent px-1.5 text-[10px] text-ink">{busyUploads}</span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
