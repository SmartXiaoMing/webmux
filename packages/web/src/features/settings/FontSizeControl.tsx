import { useFontSize } from '../../lib/font-scale'

/**
 * Terminal font size.
 *
 * Sits beside the theme toggle because it answers the same kind of complaint —
 * on a phone the default is small enough that a shell prompt no longer eats the
 * whole line, but "small enough" differs with eyesight and screen, so it is
 * adjustable rather than fixed.
 */
export function FontSizeControl(): React.JSX.Element {
  const { fontSize, larger, smaller } = useFontSize()

  return (
    <div className="flex items-center gap-1" role="group" aria-label="终端字号">
      <button
        type="button"
        className="btn btn-ghost !min-h-7 !px-2 !py-0 text-xs"
        aria-label="减小字号"
        title="减小字号"
        data-font-size="smaller"
        onClick={smaller}
      >
        A-
      </button>
      <span
        className="min-w-8 text-center font-mono text-[11px] text-muted"
        data-font-size-value={fontSize}
      >
        {fontSize}
      </span>
      <button
        type="button"
        className="btn btn-ghost !min-h-7 !px-2 !py-0 text-xs"
        aria-label="增大字号"
        title="增大字号"
        data-font-size="larger"
        onClick={larger}
      >
        A+
      </button>
    </div>
  )
}
