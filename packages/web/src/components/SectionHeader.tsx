import type { ReactNode } from 'react'
import { ChevronRightIcon } from './icons'

export interface SectionHeaderProps {
  label: string
  icon: ReactNode
  open: boolean
  onToggle: () => void
  /** Shown as `(n)` when greater than zero. */
  count?: number
  /** Test hook; rendered as `data-toggle="<value>"`. */
  testId: string
}

/**
 * A collapsible sidebar section header.
 *
 * Only the header, not the section: the session list has to keep growing to
 * fill whatever space is left when it is open, and shrink to nothing when it is
 * closed, while the directory lists are fixed-height. A component that owned
 * the body too would have to know about both, so the callers own their own
 * layout and share only this.
 *
 * The glyph rotates rather than being swapped for a different icon: rotation
 * reads as *state*, while two different icons read as two different buttons.
 */
export function SectionHeader({
  label,
  icon,
  open,
  onToggle,
  count,
  testId,
}: SectionHeaderProps): React.JSX.Element {
  return (
    <button
      type="button"
      aria-expanded={open}
      data-toggle={testId}
      className="flex w-full shrink-0 items-center gap-1 px-3 py-2 text-left text-xs font-medium tracking-wide text-muted uppercase"
      onClick={onToggle}
    >
      <span className={open ? 'rotate-90 transition-transform' : 'transition-transform'}>
        <ChevronRightIcon size={12} />
      </span>
      {icon}
      {label}
      {count !== undefined && count > 0 && <span className="text-faint">({count})</span>}
    </button>
  )
}
