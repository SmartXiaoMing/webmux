/**
 * Accessory key bar.
 *
 * A soft keyboard has no Esc, no Tab, no arrows and no Ctrl, which makes a
 * terminal on a phone nearly unusable without help — you cannot interrupt a
 * process, complete a path, or recall history.
 *
 * Ctrl and Alt are *sticky*: tapping Ctrl arms it, the next key from the
 * keyboard is combined with it, and the modifier clears. That is the only
 * arrangement that works when the modifier and the key come from different
 * input surfaces.
 */

import type { QuickKey } from '@webmux/shared'

export interface KeyBarProps {
  onKey: (sequence: string) => void
  ctrl: boolean
  alt: boolean
  onToggleCtrl: () => void
  onToggleAlt: () => void
  /** Server-synced macros, rendered after the built-ins. */
  quickKeys: readonly QuickKey[]
  onEditQuickKeys: () => void
  className?: string
}

/** Sequences as a real terminal sends them. */
const KEYS: Array<{ label: string; seq: string; title: string }> = [
  // First, because it is the key a soft keyboard hides when the on-screen
  // return is swallowed by the app shell — and CR, not LF, for the reason
  // spelled out on `macroSequence`.
  { label: 'Enter', seq: '\r', title: '回车（Enter）' },
  // DEL, not BS: it is what xterm sends for Backspace and what the pane's
  // `erase` is set to, so it is the byte that actually deletes. This is also
  // the only reliable delete on a phone — a soft keyboard's own Backspace goes
  // through the IME's compose machinery, where it can be swallowed.
  { label: '⌫', seq: '\x7f', title: '退格（Backspace）' },
  { label: 'Esc', seq: '\x1b', title: 'Escape' },
  { label: 'Tab', seq: '\t', title: 'Tab' },
  { label: '↑', seq: '\x1b[A', title: 'Up' },
  { label: '↓', seq: '\x1b[B', title: 'Down' },
  { label: '←', seq: '\x1b[D', title: 'Left' },
  { label: '→', seq: '\x1b[C', title: 'Right' },
  { label: '/', seq: '/', title: 'Slash' },
  { label: '-', seq: '-', title: 'Dash' },
  { label: '|', seq: '|', title: 'Pipe' },
  { label: '~', seq: '~', title: 'Tilde' },
  { label: '^C', seq: '\x03', title: 'Interrupt (SIGINT)' },
]

/**
 * What a macro actually sends.
 *
 * A carriage return, not a newline: a terminal's Enter key sends CR and the
 * tty's `ICRNL` turns it into LF for the reading process. A literal LF arrives
 * as Ctrl+J in raw-mode programs — vim and less treat the two as different
 * keys, so sending `\n` would type the command without running it.
 */
function macroSequence(key: QuickKey): string {
  return key.sendEnter ? `${key.text}\r` : key.text
}

export function KeyBar({
  onKey,
  ctrl,
  alt,
  onToggleCtrl,
  onToggleAlt,
  quickKeys,
  onEditQuickKeys,
  className = '',
}: KeyBarProps): React.JSX.Element {
  return (
    <div className={`flex items-center border-t border-line bg-surface py-1.5 ${className}`}>
      {/*
        Only this strip scrolls, and it scrolls rather than wraps: a wrapped bar
        would change height as it reflows and shove the terminal around
        mid-command. Every child is `shrink-0`, so the line can never wrap.

        The built-in keys are a module constant and appear unconditionally —
        nothing here waits on a fetch, so a failed or pending quick-key load
        leaves the bar exactly as it is without them.
      */}
      <div
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-2"
        style={{ scrollbarWidth: 'none' }}
      >
        <button
          type="button"
          className="key shrink-0"
          data-active={ctrl}
          onClick={onToggleCtrl}
          title="Ctrl（粘滞）"
        >
          Ctrl
        </button>
        <button
          type="button"
          className="key shrink-0"
          data-active={alt}
          onClick={onToggleAlt}
          title="Alt（粘滞）"
        >
          Alt
        </button>

        <div className="mx-0.5 h-5 w-px shrink-0 bg-line" aria-hidden />

        {KEYS.map((key) => (
          <button
            key={key.label}
            type="button"
            className="key shrink-0"
            title={key.title}
            onClick={() => onKey(key.seq)}
          >
            {key.label}
          </button>
        ))}

        {quickKeys.length > 0 && (
          <>
            {/* Conditional, so an empty group leaves no dangling separator. */}
            <div className="mx-0.5 h-5 w-px shrink-0 bg-line" aria-hidden />
            {quickKeys.map((key) => (
              <button
                key={key.id}
                type="button"
                className="key max-w-32 shrink-0 truncate"
                data-quick-key={key.id}
                title={key.text}
                onClick={() => onKey(macroSequence(key))}
              >
                {key.label}
              </button>
            ))}
          </>
        )}
      </div>

      {/*
        Outside the scroller on purpose. At the end of a scrollable strip it
        would be off-screen on a phone until the user swiped — which is the one
        device where this editor matters most.
      */}
      <div className="mx-0.5 h-5 w-px shrink-0 bg-line" aria-hidden />
      <button
        type="button"
        className="key mr-2 ml-1.5 shrink-0"
        data-quick-keys-open
        aria-label="编辑快捷键"
        title="编辑快捷键"
        onClick={onEditQuickKeys}
      >
        +
      </button>
    </div>
  )
}
