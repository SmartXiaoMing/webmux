import { useCallback, useEffect, useState } from 'react'
import type { QuickKey, QuickKeysResponse } from '@webmux/shared'
import { ApiError, api } from '../../lib/api'

export interface QuickKeysDialogProps {
  keys: readonly QuickKey[]
  limits: { maxKeys: number }
  onClose: () => void
  /**
   * The server's authoritative response, replacing the caller's copy of both
   * the list and the limit.
   */
  onChanged: (result: QuickKeysResponse) => void
  onSignOut: () => void
}

/**
 * Editor for the accessory key bar's user-defined macros.
 *
 * One screen with one form rather than a list view and a form view: the whole
 * object is three fields, and a second screen would only add navigation to a
 * dialog that is already the second tap.
 *
 * Every mutation answers with the full list, so the parent is updated from the
 * response and nothing refetches — the same contract the places routes use.
 */
export function QuickKeysDialog({
  keys,
  limits,
  onClose,
  onChanged,
  onSignOut,
}: QuickKeysDialogProps): React.JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [text, setText] = useState('')
  // Defaults to on: "常用的输入" is usually a command to run, and the checkbox is
  // one tap to turn off for a key that is only a fragment.
  const [sendEnter, setSendEnter] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleError = useCallback(
    (err: unknown, fallback: string): void => {
      if (err instanceof ApiError && err.status === 401) {
        onSignOut()
        return
      }
      setError(err instanceof ApiError ? err.message : fallback)
    },
    [onSignOut],
  )

  function resetForm(): void {
    setEditingId(null)
    setLabel('')
    setText('')
    setSendEnter(true)
    setError(null)
  }

  function startEdit(key: QuickKey): void {
    setEditingId(key.id)
    setLabel(key.label)
    setText(key.text)
    setSendEnter(key.sendEnter)
    setError(null)
  }

  const save = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const input = { label: label.trim(), text, sendEnter }
      const result =
        editingId === null
          ? await api.createQuickKey(input)
          : await api.updateQuickKey(editingId, input)
      onChanged(result)
      resetForm()
    } catch (err) {
      // The form is left filled so the attempt can be retried as-is.
      handleError(err, editingId === null ? '添加失败' : '保存失败')
    } finally {
      setBusy(false)
    }
  }, [editingId, label, text, sendEnter, onChanged, handleError])

  const remove = useCallback(
    async (id: string): Promise<void> => {
      setError(null)
      try {
        const result = await api.deleteQuickKey(id)
        onChanged(result)
        // Editing the key that was just deleted would leave the form pointing
        // at an id that no longer exists.
        setEditingId((current) => (current === id ? null : current))
      } catch (err) {
        handleError(err, '删除失败')
      }
    },
    [onChanged, handleError],
  )

  /*
   * A limit of zero means "not known yet" — the list request has not landed, or
   * it failed. Treating that as "at the limit" would disable the button
   * permanently and claim the cap is 0. The server refuses an over-limit create
   * with a 409 that is shown below, so this check is a convenience, not the
   * enforcement.
   */
  const atLimit = limits.maxKeys > 0 && editingId === null && keys.length >= limits.maxKeys
  const canSave = !busy && !atLimit && label.trim() !== '' && text !== ''

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-label="快捷键"
        className="surface-card flex max-h-full w-full max-w-lg flex-col p-3"
      >
        <h2 className="mb-1 text-sm text-body">快捷键</h2>
        <p className="mb-3 text-xs leading-relaxed text-faint">
          这里的按键会出现在终端下方的快捷键条里，点一下就发送。
        </p>

        <ul
          data-quick-key-list
          className="mb-3 max-h-40 overflow-y-auto rounded border border-line"
        >
          {keys.length === 0 && (
            <li className="px-3 py-4 text-center text-xs text-faint">还没有自定义快捷键</li>
          )}
          {keys.map((key) => (
            <li
              key={key.id}
              className="flex items-center gap-2 border-b border-line px-2 py-1.5 last:border-b-0"
            >
              <span className="max-w-24 shrink-0 truncate rounded border border-line bg-surface-raised px-1.5 font-mono text-[11px] text-body">
                {key.label}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint" title={key.text}>
                {key.text}
              </span>
              {key.sendEnter && (
                <span className="shrink-0 text-[10px] text-accent" title="自动回车">
                  回车
                </span>
              )}
              <button
                type="button"
                className="shrink-0 text-[11px] text-muted hover:text-accent"
                data-quick-key-edit={key.id}
                onClick={() => startEdit(key)}
              >
                编辑
              </button>
              <button
                type="button"
                className="shrink-0 text-[11px] text-muted hover:text-danger"
                data-quick-key-delete={key.id}
                aria-label={`删除快捷键 ${key.label}`}
                onClick={() => void remove(key.id)}
              >
                删除
              </button>
            </li>
          ))}
        </ul>

        <p className="mb-1 flex items-center gap-2 text-xs text-muted">
          {editingId === null ? '新建快捷键' : '编辑快捷键'}
          {editingId !== null && (
            <button
              type="button"
              className="text-[11px] text-muted underline hover:text-accent"
              data-quick-key-new
              onClick={resetForm}
            >
              改为新建
            </button>
          )}
        </p>

        <input
          className="field !min-h-9 !py-1 mb-2 text-sm"
          data-quick-key-label
          placeholder="名称，例如 git"
          maxLength={12}
          value={label}
          autoFocus
          onChange={(e) => setLabel(e.target.value)}
        />
        <input
          className="field !min-h-9 !py-1 mb-2 font-mono text-sm"
          data-quick-key-text
          placeholder="内容，例如 git status"
          maxLength={256}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSave) void save()
          }}
        />

        <label className="mb-3 flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            data-quick-key-enter
            checked={sendEnter}
            onChange={(e) => setSendEnter(e.target.checked)}
          />
          自动回车（直接执行命令）
        </label>

        {atLimit && (
          <p className="mb-2 text-xs text-warn">
            已达到上限（{limits.maxKeys} 个），删掉一个才能再添加。
          </p>
        )}
        {error !== null && <p className="mb-2 text-xs text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-quick-key-save
            disabled={!canSave}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : editingId === null ? '添加' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
