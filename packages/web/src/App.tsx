import { useCallback, useEffect, useState } from 'react'
import type { QuickKey, SessionSummary } from '@webmux/shared'
import { ApiError, api } from './lib/api'
import { useUploadTasks } from './lib/upload'
import { useAppHeight, useWakeLock } from './lib/use-app-height'
import { TabBar, type WorkspaceView } from './components/TabBar'
import { AuthPage } from './features/auth/AuthPage'
import { FileBrowser } from './features/files/FileBrowser'
import { SessionList } from './features/sessions/SessionList'
import { ThemeToggle } from './features/settings/ThemeToggle'
import { FontSizeControl } from './features/settings/FontSizeControl'
import { PlacesPanel } from './features/places/PlacesPanel'
import { ShareList } from './features/shares/ShareList'
import { TerminalView } from './features/terminal/TerminalView'
import { QuickKeysDialog } from './features/terminal/QuickKeysDialog'

type AuthState =
  | { kind: 'loading' }
  | { kind: 'setup' }
  | { kind: 'login' }
  | { kind: 'ready' }

/** How often the session list is re-fetched, to pick up changes made elsewhere. */
const SESSION_POLL_MS = 10_000

export function App(): React.JSX.Element {
  useAppHeight()

  const [auth, setAuth] = useState<AuthState>({ kind: 'loading' })

  const checkAuth = useCallback(async (): Promise<void> => {
    try {
      const status = await api.authStatus()
      if (!status.initialized) setAuth({ kind: 'setup' })
      else if (!status.authenticated) setAuth({ kind: 'login' })
      else setAuth({ kind: 'ready' })
    } catch {
      // The server is unreachable — treat it as "not logged in" and let the
      // user retry, rather than showing a dead app shell.
      setAuth({ kind: 'login' })
    }
  }, [])

  useEffect(() => {
    void checkAuth()
  }, [checkAuth])

  if (auth.kind === 'loading') {
    return (
      <div className="flex h-viewport items-center justify-center bg-ink">
        <span className="animate-pulse font-mono text-sm text-faint">webmux</span>
      </div>
    )
  }

  if (auth.kind === 'setup' || auth.kind === 'login') {
    return <AuthPage mode={auth.kind} onAuthenticated={() => setAuth({ kind: 'ready' })} />
  }

  return <Workspace onSignOut={() => setAuth({ kind: 'login' })} />
}

function Workspace({ onSignOut }: { onSignOut: () => void }): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [exited, setExited] = useState<number | null>(null)
  const [view, setView] = useState<WorkspaceView>('terminal')

  const uploadTasks = useUploadTasks()
  const busyUploads = uploadTasks.filter((t) => t.state === 'uploading' || t.state === 'queued').length
  /** Bumped when a share is created, so the shares view is not stale. */
  const [sharesReloadKey, setSharesReloadKey] = useState(0)

  /** Favourite paths, shared with the file browser so it need not refetch. */
  const [favoritePaths, setFavoritePaths] = useState<readonly string[]>([])

  /*
   * Quick keys are server-backed and shared across devices, so they live here
   * next to `favoritePaths` rather than in a `lib/*.ts` module store — those
   * hold per-device preferences like the font size. Holding them above
   * `TerminalView` also matters for a mechanical reason: that component is
   * keyed by session id, so anything it fetched itself would be re-fetched on
   * every session switch.
   */
  const [quickKeys, setQuickKeys] = useState<QuickKey[]>([])
  const [quickKeyLimits, setQuickKeyLimits] = useState({ maxKeys: 0 })
  const [quickKeysOpen, setQuickKeysOpen] = useState(false)
  const [placesReloadKey, setPlacesReloadKey] = useState(0)
  /** A directory to push into the file browser; the nonce makes repeats work. */
  const [navigateTo, setNavigateTo] = useState<{ path: string; nonce: number } | null>(null)

  const refreshPlaces = useCallback(async (): Promise<void> => {
    try {
      const result = await api.listPlaces()
      setFavoritePaths(result.favorites.map((place) => place.path))
    } catch {
      // The sidebar is a convenience; a failure here must not break the shell.
    }
    setPlacesReloadKey((n) => n + 1)
  }, [])

  useEffect(() => {
    void refreshPlaces()
  }, [refreshPlaces])

  const refreshQuickKeys = useCallback(async (): Promise<void> => {
    try {
      const result = await api.listQuickKeys()
      setQuickKeys(result.keys)
      setQuickKeyLimits(result.limits)
    } catch {
      // The key bar works without them — its built-in keys never wait on this
      // — so a failure here is not worth an error banner.
    }
  }, [])

  useEffect(() => {
    void refreshQuickKeys()
  }, [refreshQuickKeys])

  const openDirectory = useCallback((path: string) => {
    setView('files')
    setSidebarOpen(false)
    setNavigateTo((current) => ({ path, nonce: (current?.nonce ?? 0) + 1 }))
  }, [])

  // A shell that is running something long is exactly when the screen must
  // not sleep.
  useWakeLock(activeId !== null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await api.listSessions()
      setSessions(list)
      setError(null)
      // Keep a valid selection as sessions come and go.
      setActiveId((current) => {
        if (current && list.some((s) => s.id === current)) return current
        return list[0]?.id ?? null
      })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onSignOut()
        return
      }
      setError(err instanceof ApiError ? err.message : '无法加载会话列表')
    }
  }, [onSignOut])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), SESSION_POLL_MS)
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  const createSession = useCallback(async (cwd: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const session = await api.createSession({ cwd })
      setSessions((prev) => [session, ...prev])
      setActiveId(session.id)
      setExited(null)
      setSidebarOpen(false)
      // Asking for a terminal from the file browser means you want to be in it.
      setView('terminal')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建会话失败')
    } finally {
      setBusy(false)
    }
  }, [])

  const killSession = useCallback(
    async (id: string): Promise<void> => {
      try {
        await api.killSession(id)
        setSessions((prev) => prev.filter((s) => s.id !== id))
        setActiveId((current) => (current === id ? null : current))
      } catch (err) {
        setError(err instanceof ApiError ? err.message : '终止会话失败')
      }
    },
    [],
  )

  const renameSession = useCallback(async (id: string, title: string): Promise<void> => {
    try {
      const updated = await api.renameSession(id, title)
      setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '重命名失败')
    }
  }, [])

  const active = sessions.find((s) => s.id === activeId) ?? null

  // Switching sessions must clear the previous session's exit banner, which
  // would otherwise still be on screen the moment the new terminal mounts.
  // Deriving it during render (rather than in an effect) means the stale banner
  // is never committed to the DOM in the first place.
  const [lastActiveId, setLastActiveId] = useState(activeId)
  if (activeId !== lastActiveId) {
    setLastActiveId(activeId)
    setExited(null)
  }

  return (
    /*
     * `relative` so the absolutely-positioned children below — the mobile
     * sidebar, its scrim, and the quick-keys dialog — anchor to this box rather
     * than to the initial containing block. This box is `h-viewport`, which
     * tracks `visualViewport`, so a dialog anchored here stays visible when a
     * phone's soft keyboard opens; anchored to the document it would centre
     * behind the keyboard.
     */
    <div className="relative flex h-viewport overflow-hidden bg-ink">
      {/* Sidebar: permanent on desktop, an overlay sheet on small screens. */}
      <aside
        className={`${
          sidebarOpen ? 'flex' : 'hidden'
        } absolute inset-y-0 left-0 z-30 w-72 flex-col border-r border-line bg-surface md:static md:z-auto md:flex`}
      >
        <div className="flex items-center justify-between border-b border-line px-3 py-3">
          <span className="font-mono text-sm text-body">webmux</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="btn btn-ghost !min-h-7 !px-2 !py-0 text-xs"
              onClick={async () => {
                await api.logout().catch(() => {})
                onSignOut()
              }}
            >
              退出
            </button>
            <button
              type="button"
              className="btn btn-ghost !min-h-7 !px-2 !py-0 text-xs md:hidden"
              onClick={() => setSidebarOpen(false)}
              aria-label="关闭侧栏"
            >
              ✕
            </button>
          </div>
        </div>

        <SessionList
          sessions={sessions}
          activeId={activeId}
          onSelect={(id) => {
            setActiveId(id)
            setSidebarOpen(false)
          }}
          onKill={(id) => void killSession(id)}
          onRename={(id, title) => void renameSession(id, title)}
        />

        <PlacesPanel
          onOpenDirectory={openDirectory}
          onSignOut={onSignOut}
          reloadKey={placesReloadKey}
        />

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-line px-3 py-2">
          <ThemeToggle />
          <FontSizeControl />
        </div>
      </aside>

      {sidebarOpen && (
        <button
          type="button"
          aria-label="关闭侧栏"
          className="absolute inset-0 z-20 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-2">
          <button
            type="button"
            className="btn btn-ghost !min-h-8 !px-2 !py-0 text-xs md:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="打开会话列表"
          >
            ☰
          </button>
          <span className="min-w-0 flex-1 truncate text-sm text-body">
            {view === 'terminal' ? (active?.title ?? '未选择会话') : view === 'files' ? '文件' : '分享'}
          </span>
          {view === 'terminal' && active && (
            // The live directory, not the creation one: this is the "where am
            // I" affordance, and it would be odd for it to be staler than the
            // row for the same session in the sidebar.
            <span className="hidden truncate font-mono text-[11px] text-faint sm:block">
              {active.liveCwd}
            </span>
          )}

          {/* Desktop switches views here; phones use the tab bar below. */}
          <div className="hidden shrink-0 items-center gap-0.5 rounded border border-line p-0.5 md:flex">
            {(['terminal', 'files', 'shares'] as const).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setView(id)}
                className={`rounded px-2 py-0.5 text-xs ${view === id ? 'bg-surface-raised text-body' : 'text-muted'}`}
              >
                {id === 'terminal' ? '终端' : id === 'files' ? '文件' : '分享'}
              </button>
            ))}
          </div>
        </header>

        {error && (
          <div className="border-b border-line bg-surface px-3 py-2 text-xs text-danger">{error}</div>
        )}

        {exited !== null && (
          <div className="border-b border-line bg-surface px-3 py-2 text-xs text-warn">
            会话已结束（exit {exited}）
          </div>
        )}

        {/*
          Hidden with CSS rather than unmounted when the files view is showing.
          Unmounting drops the socket, and coming back would force a resync from
          a server-side snapshot — a visible full repaint of the screen — just
          for glancing at a directory.
        */}
        <div className={view === 'terminal' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          {active ? (
            <TerminalView
              key={active.id}
              sessionId={active.id}
              quickKeys={quickKeys}
              onEditQuickKeys={() => setQuickKeysOpen(true)}
              onExit={setExited}
              onFatal={(message) => {
                setError(message)
                void checkAuthAgain(onSignOut)
              }}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-sm text-muted">还没有打开的终端</p>
              <p className="text-xs leading-relaxed text-faint">
                在「文件」里进入想要的目录，
                <br />
                再点工具条上的终端图标
              </p>
              <button type="button" className="btn btn-primary" onClick={() => setView('files')}>
                去文件
              </button>
            </div>
          )}
        </div>

        {view === 'files' && (
          <FileBrowser
            onSignOut={onSignOut}
            initialPath={active?.cwd ?? null}
            onSharesChanged={() => setSharesReloadKey((n) => n + 1)}
            navigateTo={navigateTo}
            onDirectoryOpened={() => setPlacesReloadKey((n) => n + 1)}
            favoritePaths={favoritePaths}
            onPlacesChanged={() => void refreshPlaces()}
            onOpenTerminal={(cwd) => void createSession(cwd)}
          />
        )}

        {view === 'shares' && <ShareList onSignOut={onSignOut} reloadKey={sharesReloadKey} />}

        <TabBar active={view} onChange={setView} busyUploads={busyUploads} />
      </main>

      {/*
        Mounted at the app root, not inside the terminal view: that view is
        keyed by session id, so switching sessions — which is a normal thing to
        do with the sidebar visible on desktop — would unmount the dialog and
        throw away an edit in progress.
      */}
      {quickKeysOpen && (
        <QuickKeysDialog
          keys={quickKeys}
          limits={quickKeyLimits}
          onClose={() => setQuickKeysOpen(false)}
          onChanged={(result) => {
            setQuickKeys(result.keys)
            setQuickKeyLimits(result.limits)
          }}
          onSignOut={onSignOut}
        />
      )}
    </div>
  )
}

/** A fatal socket error may mean the session expired; re-check before assuming. */
async function checkAuthAgain(onSignOut: () => void): Promise<void> {
  try {
    const status = await api.authStatus()
    if (!status.authenticated) onSignOut()
  } catch {
    // Leave the error on screen; the user can retry.
  }
}
