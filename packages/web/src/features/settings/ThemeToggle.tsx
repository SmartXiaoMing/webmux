import { useTheme, type ThemeChoice } from '../../lib/theme'

const CHOICES: Array<{ id: ThemeChoice; label: string; title: string }> = [
  { id: 'system', label: '自动', title: '跟随系统' },
  { id: 'dark', label: '深色', title: '始终使用深色' },
  { id: 'light', label: '浅色', title: '始终使用浅色' },
]

/**
 * Theme picker.
 *
 * Lives in the sidebar footer rather than in a 设置 tab: `TabBar.tsx` already
 * argues that a tab opening onto nothing is a bug the user meets in the first
 * minute, and one segmented control is not a destination. The sidebar is one
 * tap away on a phone and always visible on desktop, and it is where the next
 * setting will go — so when 设置 does earn its own view, moving this is one
 * import.
 */
export function ThemeToggle(): React.JSX.Element {
  const { choice, setChoice } = useTheme()

  return (
    <div
      role="group"
      aria-label="主题"
      className="flex shrink-0 items-center gap-0.5 rounded border border-line p-0.5"
    >
      {CHOICES.map((option) => (
        <button
          key={option.id}
          type="button"
          data-theme-value={option.id}
          aria-pressed={choice === option.id}
          title={option.title}
          onClick={() => setChoice(option.id)}
          className={`flex-1 rounded px-1.5 py-1 text-xs ${
            choice === option.id ? 'bg-surface-raised text-body' : 'text-muted'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
