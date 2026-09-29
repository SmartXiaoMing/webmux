import { useState, type FormEvent } from 'react'
import { ApiError, api } from '../../lib/api'

export interface AuthPageProps {
  /** `setup` claims the instance; `login` authenticates against it. */
  mode: 'setup' | 'login'
  onAuthenticated: () => void
}

export function AuthPage({ mode, onAuthenticated }: AuthPageProps): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const isSetup = mode === 'setup'

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setError(null)

    if (isSetup && password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    if (isSetup && password.length < 8) {
      setError('密码至少需要 8 个字符')
      return
    }

    setBusy(true)
    try {
      if (isSetup) await api.setup(password)
      else await api.login(password)
      onAuthenticated()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '发生未知错误')
      setPassword('')
      setConfirm('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-viewport items-center justify-center bg-ink px-4">
      <form onSubmit={submit} className="surface-card w-full max-w-sm p-6">
        <div className="mb-6">
          <h1 className="font-mono text-lg text-body">webmux</h1>
          <p className="mt-1 text-sm text-muted">
            {isSetup ? '首次使用，请设置访问密码' : '请输入密码以继续'}
          </p>
        </div>

        <label className="mb-1 block text-xs text-muted" htmlFor="password">
          密码
        </label>
        <input
          id="password"
          className="field"
          type="password"
          value={password}
          autoFocus
          autoComplete={isSetup ? 'new-password' : 'current-password'}
          onChange={(e) => setPassword(e.target.value)}
        />

        {isSetup && (
          <>
            <label className="mt-4 mb-1 block text-xs text-muted" htmlFor="confirm">
              确认密码
            </label>
            <input
              id="confirm"
              className="field"
              type="password"
              value={confirm}
              autoComplete="new-password"
              onChange={(e) => setConfirm(e.target.value)}
            />
          </>
        )}

        {error && (
          <p role="alert" className="mt-4 text-sm text-danger">
            {error}
          </p>
        )}

        <button
          type="submit"
          className="btn btn-primary mt-6 w-full"
          disabled={busy || password.length === 0}
        >
          {busy ? '处理中…' : isSetup ? '设置密码并进入' : '登录'}
        </button>

        {isSetup && (
          <p className="mt-4 text-xs leading-relaxed text-faint">
            此密码用于访问本机终端，请使用较长的随机密码。webmux 会以 scrypt 哈希存储，明文不会被保存。
          </p>
        )}
      </form>
    </div>
  )
}
