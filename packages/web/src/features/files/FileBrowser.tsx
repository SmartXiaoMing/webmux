import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FsEntry, FsListing, FsRoot, FsSort } from '@webmux/shared'
import { ApiError, api } from '../../lib/api'
import { safeName } from '../../lib/upload'
import {
  batchLabel,
  manifestFromFileList,
  manifestFromSnapshot,
  runManifest,
  snapshotDrop,
  type UploadManifest,
} from '../../lib/folder-upload'
import { breadcrumbs, formatBytes, formatTime, iconFor, joinPath } from './format'
import { MoveDialog } from './MoveDialog'
import { PreviewOverlay } from './PreviewOverlay'
import { UploadTray } from './UploadTray'
import { ShareDialog } from '../shares/ShareDialog'
import { ActionMenu } from '../../components/Menu'
import {
  EyeIcon,
  EyeOffIcon,
  FilePlusIcon,
  FolderPlusIcon,
  FolderUpIcon,
  StarIcon,
  TerminalIcon,
  UploadIcon,
} from '../../components/icons'

export interface FileBrowserProps {
  /** Session expiry surfaces here rather than as an unexplained empty list. */
  onSignOut: () => void
  /** Typically the active terminal's cwd, when it falls inside a root. */
  initialPath?: string | null
  /** Fired when a share is created, so the shares view can refresh. */
  onSharesChanged?: () => void
  /**
   * A directory to jump to, pushed from elsewhere (the places panel).
   *
   * The nonce is load-bearing: navigating to the same path twice would
   * otherwise be a no-op, because React drops a state update that does not
   * change the value. Bumping the nonce makes the second click work.
   */
  navigateTo?: { path: string; nonce: number } | null
  /** Fired after a directory is listed, so the places panel can refresh. */
  onDirectoryOpened?: () => void
  /**
   * Favourite directories, passed down rather than fetched here: the places
   * panel already loads them, and a second copy would be a second thing to keep
   * in step.
   */
  favoritePaths?: readonly string[]
  /** Fired when the favourite flag changes, so the panel can refresh. */
  onPlacesChanged?: () => void
  /** Open a terminal rooted at this directory. Omit to hide the control. */
  onOpenTerminal?: (cwd: string) => void
}

const SORTS: Array<{ id: FsSort; label: string }> = [
  { id: 'name', label: '名称' },
  { id: 'size', label: '大小' },
  { id: 'mtime', label: '时间' },
]

export function FileBrowser({
  onSignOut,
  initialPath,
  onSharesChanged,
  navigateTo,
  onDirectoryOpened,
  favoritePaths = [],
  onPlacesChanged,
  onOpenTerminal,
}: FileBrowserProps): React.JSX.Element {
  /** Last directory reported to the server, so a re-list does not re-report. */
  const reportedPath = useRef<string | null>(null)
  const [roots, setRoots] = useState<FsRoot[]>([])
  const [path, setPath] = useState<string | null>(null)
  const [listing, setListing] = useState<FsListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const [sort, setSort] = useState<FsSort>('name')
  const [order, setOrder] = useState<'asc' | 'desc'>('asc')
  // Off by default: a directory full of dotfiles — `.git`, `.next`, an editor's
  // state — buries the handful of entries actually being looked for. The
  // tooltip still names the path, so nothing is hidden irrecoverably.
  const [showHidden, setShowHidden] = useState(false)

  /** Null when not creating; otherwise what the inline "new…" row will make. */
  const [creating, setCreating] = useState<'dir' | 'file' | null>(null)
  const [draft, setDraft] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [previewing, setPreviewing] = useState<FsEntry | null>(null)
  const [moving, setMoving] = useState<FsEntry | null>(null)
  const [sharing, setSharing] = useState<FsEntry | null>(null)
  const [unpacking, setUnpacking] = useState<string | null>(null)

  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  /**
   * Guards against a stale response overwriting a newer one — rapid navigation
   * can land out of order.
   */
  const requestId = useRef(0)
  const pickedInitial = useRef(false)

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

  // Roots, once.
  useEffect(() => {
    void (async () => {
      try {
        const { roots: loaded } = await api.listRoots()
        setRoots(loaded)
        const available = loaded.filter((r) => r.available)
        const inside =
          initialPath != null &&
          available.find((r) => initialPath === r.path || initialPath.startsWith(`${r.path}/`))
        setPath(pickedInitial.current ? (current) => current : (inside ? initialPath : available[0]?.path) ?? null)
        pickedInitial.current = true
      } catch (err) {
        handleError(err, '无法加载文件根目录')
      }
    })()
  }, [initialPath, handleError])

  const load = useCallback(
    async (target: string): Promise<void> => {
      const id = requestId.current + 1
      requestId.current = id
      setLoading(true)

      try {
        const result = await api.listFiles(target, { sort, order, showHidden })
        if (requestId.current !== id) return
        setListing(result)
        setError(null)

        // Reported once per directory, not once per listing: the browser
        // re-lists after every mutation, and a refresh is not a visit.
        if (reportedPath.current !== result.path) {
          reportedPath.current = result.path
          void api
            .recordOpened(result.path)
            .then(() => onDirectoryOpened?.())
            .catch(() => {
              // The recents list is a convenience; losing an entry is not
              // worth surfacing an error over.
            })
        }
      } catch (err) {
        if (requestId.current !== id) return
        setListing(null)
        handleError(err, '无法列出该目录')
      } finally {
        if (requestId.current === id) setLoading(false)
      }
    },
    [sort, order, showHidden, handleError],
  )

  useEffect(() => {
    if (path !== null) void load(path)
  }, [path, load])

  // A directory pushed from outside — the favourites or recents panel.
  useEffect(() => {
    if (navigateTo == null) return
    setConfirmDelete(null)
    setRenaming(null)
    setCreating(null)
    setPath(navigateTo.path)
    // `nonce` is in the dependency list on purpose: it is what makes clicking
    // the same directory twice a second navigation rather than a no-op.
  }, [navigateTo?.path, navigateTo?.nonce])

  const navigate = useCallback((target: string) => {
    setConfirmDelete(null)
    setRenaming(null)
    setCreating(null)
    setError(null)
    setPath(target)
  }, [])

  const readonly = listing?.readonly ?? true
  const isFavorite = path !== null && favoritePaths.includes(path)

  const toggleFavorite = useCallback(async (): Promise<void> => {
    if (path === null) return
    try {
      await api.setFavorite(path, !favoritePaths.includes(path))
      onPlacesChanged?.()
    } catch (err) {
      handleError(err, '收藏失败')
    }
  }, [path, favoritePaths, onPlacesChanged, handleError])
  const root = useMemo(() => roots.find((r) => r.name === listing?.root) ?? null, [roots, listing])

  /**
   * Runs a picked or dropped selection as one batch.
   *
   * The batch runner owns the ordering (directories before the files inside
   * them), the concurrency bound and the failure attribution; this only has to
   * reload the listing once at the end — doing it per file is a thousand
   * directory listings for a thousand-file folder.
   */
  const startBatch = useCallback(
    async (manifest: UploadManifest): Promise<void> => {
      if (path === null) return

      const result = await runManifest(manifest, path, batchLabel(manifest))
      if (manifest.errors.length > 0) {
        setError(`${manifest.errors.length} 项无法读取，已跳过`)
      }
      if (result.uploaded > 0 || manifest.dirs.length > 0) await load(path)
    },
    [path, load],
  )

  const submitCreate = useCallback(async (): Promise<void> => {
    const name = draft.trim()
    if (name === '' || path === null || creating === null) return
    const target = joinPath(path, safeName(name))
    try {
      if (creating === 'dir') await api.createDirectory(target)
      else await api.createFile(target)
      setCreating(null)
      setDraft('')
      await load(path)
    } catch (err) {
      handleError(err, creating === 'dir' ? '新建文件夹失败' : '新建文件失败')
    }
  }, [draft, path, creating, load, handleError])

  /** Unpacks a zip into a new directory beside it, named after the archive. */
  const unpack = useCallback(
    async (entry: FsEntry): Promise<void> => {
      if (path === null) return
      const stem = entry.name.replace(/\.zip$/i, '') || entry.name
      setUnpacking(entry.path)
      try {
        await api.extract({ path: entry.path }, joinPath(path, stem))
        await load(path)
      } catch (err) {
        handleError(err, '解压失败')
      } finally {
        setUnpacking(null)
      }
    },
    [path, load, handleError],
  )

  const submitRename = useCallback(
    async (entry: FsEntry): Promise<void> => {
      const name = draft.trim()
      if (name === '' || path === null) return
      try {
        await api.renameEntry(entry.path, joinPath(entry.path.slice(0, entry.path.length - entry.name.length), safeName(name)))
        setRenaming(null)
        setDraft('')
        await load(path)
      } catch (err) {
        handleError(err, '重命名失败')
      }
    },
    [draft, path, load, handleError],
  )

  const submitDelete = useCallback(
    async (entry: FsEntry): Promise<void> => {
      if (path === null) return
      try {
        // A directory needs recursion spelled out; the confirm step above is
        // where the user agreed to that.
        await api.deleteEntry(entry.path, entry.kind === 'dir')
        setConfirmDelete(null)
        await load(path)
      } catch (err) {
        handleError(err, '删除失败')
      }
    },
    [path, load, handleError],
  )

  const crumbs = useMemo(() => (path ? breadcrumbs(path) : []), [path])

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(event) => {
        if (readonly) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (readonly) return
        event.preventDefault()
        setDragging(false)
        // Snapshot taken synchronously, before anything is awaited: a
        // DataTransferItem stops answering `webkitGetAsEntry()` the moment
        // this handler returns, and a dropped folder's contents are only
        // reachable through those entries. There is deliberately no
        // `files.length > 0` gate — a folder-only drop can leave `.files`
        // empty, and in Chrome the folder itself shows up there as a 0-byte
        // entry that used to be uploaded over a real file of the same name.
        const snapshot = snapshotDrop(event.dataTransfer)
        void manifestFromSnapshot(snapshot)
          .then(startBatch)
          .catch(() => setError('无法读取拖入的内容'))
      }}
    >
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line bg-surface px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {crumbs.map((crumb, index) => (
            <span key={crumb.path} className="flex shrink-0 items-center">
              {index > 0 && <span className="px-0.5 text-faint">/</span>}
              <button
                type="button"
                data-crumb={crumb.path}
                className={`max-w-32 truncate rounded px-1 py-0.5 font-mono text-[11px] ${
                  index === crumbs.length - 1 ? 'text-body' : 'text-muted hover:text-accent'
                }`}
                onClick={() => navigate(crumb.path)}
                title={crumb.path}
              >
                {crumb.name}
              </button>
            </span>
          ))}
          {loading && <span className="ml-1 shrink-0 text-[11px] text-faint">载入中…</span>}
        </div>

        {root?.readonly && (
          <span className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-warn" title="该根目录为只读">
            只读
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-1 border-b border-line bg-surface px-2 py-1.5">
        <select
          className="!min-h-7 rounded border border-line bg-ink px-1 py-0 text-xs text-muted"
          value={sort}
          onChange={(event) => setSort(event.target.value as FsSort)}
          aria-label="排序方式"
        >
          {SORTS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-ghost !min-h-7 !px-2 !py-0 text-xs"
          onClick={() => setOrder((current) => (current === 'asc' ? 'desc' : 'asc'))}
          aria-label={order === 'asc' ? '升序' : '降序'}
          title={order === 'asc' ? '升序' : '降序'}
        >
          {order === 'asc' ? '↑' : '↓'}
        </button>
        <button
          type="button"
          data-toolbar="hidden"
          aria-label={showHidden ? '隐藏隐藏文件' : '显示隐藏文件'}
          aria-pressed={showHidden}
          title={showHidden ? '隐藏隐藏文件' : '显示隐藏文件'}
          className={`btn btn-ghost !min-h-7 !px-1.5 !py-0 text-xs ${showHidden ? '' : 'text-faint'}`}
          onClick={() => setShowHidden((current) => !current)}
        >
          {showHidden ? <EyeIcon /> : <EyeOffIcon />}
        </button>

        <span className="flex-1" />

        {/* A read, so it stays available on a readonly root. The server does a
            full pre-flight walk before the first byte, which is why this is a
            link rather than a fetch — the browser owns the wait and the save. */}
        {/*
          No "archive the whole directory" button here, deliberately. It is one
          click away from zipping a directory the user did not mean — the file
          browser can be sitting at a root, and the download then walks the
          entire tree before it starts. Per-entry packing is still in the row
          menu, where it names exactly what it will pack.

          What replaced it is the more common intent: run a shell here.
        */}
        {path !== null && onOpenTerminal !== undefined && (
          <button
            type="button"
            data-toolbar="terminal"
            aria-label="在当前目录打开终端"
            title="在当前目录打开终端"
            className="btn btn-ghost !min-h-7 !px-1.5 !py-0 text-xs"
            onClick={() => onOpenTerminal(path)}
          >
            <TerminalIcon />
          </button>
        )}

        {isFavorite ? (
          <button
            type="button"
            data-toolbar="favorite"
            aria-label="取消收藏此目录"
            title="取消收藏此目录"
            className="btn btn-ghost !min-h-7 !px-1.5 !py-0 text-xs text-accent"
            onClick={() => void toggleFavorite()}
          >
            <StarIcon filled />
          </button>
        ) : (
          <button
            type="button"
            data-toolbar="favorite"
            aria-label="收藏此目录"
            title="收藏此目录"
            className="btn btn-ghost !min-h-7 !px-1.5 !py-0 text-xs"
            onClick={() => void toggleFavorite()}
          >
            <StarIcon />
          </button>
        )}

        {!readonly && (
          <>
            <button
              type="button"
              data-toolbar="mkdir"
              aria-label="新建文件夹"
              title="新建文件夹"
              className="btn btn-ghost !min-h-7 !px-1.5 !py-0 text-xs"
              onClick={() => {
                setCreating('dir')
                setDraft('')
              }}
            >
              <FolderPlusIcon />
            </button>
            <button
              type="button"
              data-toolbar="touch"
              aria-label="新建文件"
              title="新建文件"
              className="btn btn-ghost !min-h-7 !px-1.5 !py-0 text-xs"
              onClick={() => {
                setCreating('file')
                setDraft('')
              }}
            >
              <FilePlusIcon />
            </button>
            <button
              type="button"
              data-toolbar="upload"
              aria-label="上传文件"
              title="上传文件"
              className="btn btn-ghost !min-h-7 !px-1.5 !py-0 text-xs"
              onClick={() => fileInput.current?.click()}
            >
              <UploadIcon />
            </button>
            <button
              type="button"
              data-toolbar="upload-folder"
              aria-label="上传文件夹"
              title="上传文件夹"
              className="btn btn-ghost !min-h-7 !px-1.5 !py-0 text-xs"
              onClick={() => folderInput.current?.click()}
            >
              <FolderUpIcon />
            </button>
            <input
              ref={fileInput}
              data-upload="files"
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                if (event.target.files) void startBatch(manifestFromFileList([...event.target.files]))
                // Cleared so picking the same file again still fires.
                event.target.value = ''
              }}
            />
            {/* Shown on every device on purpose: Safari on iOS ignores
                `webkitdirectory` and opens a plain file picker, which this
                same code path handles as loose files. Feature-detecting it
                reliably is not possible, and hiding the button on a false
                negative is worse than a harmless degradation. */}
            <input
              ref={folderInput}
              data-upload="folder"
              type="file"
              multiple
              className="hidden"
              {...({ webkitdirectory: '' } as Record<string, string>)}
              onChange={(event) => {
                if (event.target.files) void startBatch(manifestFromFileList([...event.target.files]))
                event.target.value = ''
              }}
            />
          </>
        )}
      </div>

      {error && (
        <div className="shrink-0 border-b border-line bg-surface px-3 py-2 text-xs text-danger">{error}</div>
      )}

      {/* Entries */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {creating !== null && (
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <input
              autoFocus
              className="field !min-h-8 !py-1 text-sm"
              placeholder={creating === 'dir' ? '文件夹名称' : '文件名称'}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submitCreate()
                if (event.key === 'Escape') setCreating(null)
              }}
            />
            <button type="button" className="btn btn-primary !min-h-8 !px-2 !py-0 text-xs" onClick={() => void submitCreate()}>
              创建
            </button>
            <button type="button" className="btn btn-ghost !min-h-8 !px-2 !py-0 text-xs" onClick={() => setCreating(null)}>
              取消
            </button>
          </div>
        )}

        {listing === null && !loading && !error && (
          <p className="px-3 py-6 text-center text-xs text-faint">没有可显示的目录</p>
        )}

        {listing?.entries.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-faint">这个目录是空的</p>
        )}

        <ul aria-label="文件列表">
          {listing?.entries.map((entry) => (
            <FileRow
              key={entry.path}
              entry={entry}
              readonly={readonly}
              renaming={renaming === entry.path}
              draft={draft}
              confirming={confirmDelete === entry.path}
              onDraft={setDraft}
              onNavigate={navigate}
              onStartRename={() => {
                setRenaming(entry.path)
                setDraft(entry.name)
              }}
              onSubmitRename={() => void submitRename(entry)}
              onCancelEdit={() => {
                setRenaming(null)
                setDraft('')
              }}
              onAskDelete={() => setConfirmDelete(entry.path)}
              onCancelDelete={() => setConfirmDelete(null)}
              onConfirmDelete={() => void submitDelete(entry)}
              onPreview={() => setPreviewing(entry)}
              onMove={() => setMoving(entry)}
              onShare={() => setSharing(entry)}
              onUnpack={() => void unpack(entry)}
              unpacking={unpacking === entry.path}
            />
          ))}
        </ul>
      </div>

      {dragging && !readonly && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-accent bg-ink/70">
          <span className="text-sm text-accent">松开以上传到 {path}</span>
        </div>
      )}

      {previewing !== null && (
        <PreviewOverlay
          entry={previewing}
          readonly={readonly}
          onClose={() => setPreviewing(null)}
          onSignOut={onSignOut}
          onSaved={(stat) => {
            // Keep the overlay open on what was just saved, and refresh the
            // row underneath so its size and mtime stop being stale.
            setPreviewing(stat)
            if (path !== null) void load(path)
          }}
        />
      )}

      {moving !== null && (
        <MoveDialog
          entry={moving}
          onClose={() => setMoving(null)}
          onMoved={() => {
            setMoving(null)
            if (path !== null) void load(path)
          }}
          onSignOut={onSignOut}
        />
      )}

      {sharing !== null && (
        <ShareDialog
          entry={sharing}
          onClose={() => setSharing(null)}
          onSignOut={onSignOut}
          onChanged={() => onSharesChanged?.()}
        />
      )}

      <UploadTray />
    </div>
  )
}

/**
 * Starts a download without navigating the page.
 *
 * A plain `window.location.assign` would be a navigation for anything the
 * server sends inline — an image or a text file would replace the app. The
 * `download` attribute on a same-origin URL forces a save instead.
 */
function triggerDownload(url: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = ''
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

interface FileRowProps {
  entry: FsEntry
  readonly: boolean
  renaming: boolean
  draft: string
  confirming: boolean
  onDraft: (value: string) => void
  onNavigate: (path: string) => void
  onStartRename: () => void
  onSubmitRename: () => void
  onCancelEdit: () => void
  onAskDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
  onPreview: () => void
  onMove: () => void
  onShare: () => void
  onUnpack: () => void
  unpacking: boolean
}

function FileRow({
  entry,
  readonly,
  renaming,
  draft,
  confirming,
  onDraft,
  onNavigate,
  onStartRename,
  onSubmitRename,
  onCancelEdit,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
  onPreview,
  onMove,
  onShare,
  onUnpack,
  unpacking,
}: FileRowProps): React.JSX.Element {
  if (renaming) {
    return (
      <li className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <input
          autoFocus
          className="field !min-h-8 !py-1 text-sm"
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSubmitRename()
            if (event.key === 'Escape') onCancelEdit()
          }}
        />
        <button type="button" className="btn btn-primary !min-h-8 !px-2 !py-0 text-xs" onClick={onSubmitRename}>
          确定
        </button>
        <button type="button" className="btn btn-ghost !min-h-8 !px-2 !py-0 text-xs" onClick={onCancelEdit}>
          取消
        </button>
      </li>
    )
  }

  const isDir = entry.kind === 'dir'
  const isZip = !isDir && entry.name.toLowerCase().endsWith('.zip')

  return (
    <li className="group flex items-center gap-2 border-b border-line px-3 py-1.5 hover:bg-surface-raised/60">
      <span className={`shrink-0 font-mono text-xs ${isDir ? 'text-accent' : 'text-faint'}`}>{iconFor(entry.kind)}</span>

      {isDir || entry.kind === 'symlink' ? (
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-sm text-body"
          onClick={() => onNavigate(entry.path)}
          title={entry.path}
        >
          {entry.name}
        </button>
      ) : entry.preview !== null ? (
        // The server said this type may render, so the name opens a preview.
        // The preview carries its own download button for when seeing it is not
        // enough.
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-sm text-body"
          onClick={onPreview}
          title={entry.path}
        >
          {entry.name}
        </button>
      ) : (
        // Nothing to show, so the name downloads — a navigation, not a fetch,
        // which keeps the browser's own save UI and resume.
        <a
          className="min-w-0 flex-1 truncate text-sm text-body"
          href={api.downloadUrl(entry.path)}
          download={entry.name}
          title={entry.path}
        >
          {entry.name}
        </a>
      )}

      <span className="hidden shrink-0 font-mono text-[11px] text-faint sm:block">
        {formatTime(entry.mtimeMs)}
      </span>
      <span className="w-16 shrink-0 text-right font-mono text-[11px] text-muted">
        {isDir ? '—' : formatBytes(entry.size)}
      </span>

      {!readonly &&
        (confirming ? (
          <span className="flex shrink-0 items-center gap-1">
            <button type="button" className="btn btn-danger !min-h-7 !px-2 !py-0 text-xs" onClick={onConfirmDelete}>
              {/* Named distinctly from the item that opened this, so the
                  confirmation stays unambiguous. */}
              {isDir ? '删除整个目录' : '确认删除'}
            </button>
            <button type="button" className="btn btn-ghost !min-h-7 !px-2 !py-0 text-xs" onClick={onCancelDelete}>
              取消
            </button>
          </span>
        ) : (
          <span className="shrink-0">
            <ActionMenu
              label={`操作 ${entry.name}`}
              items={[
                isDir
                  ? { label: '打包下载', onSelect: () => triggerDownload(api.archiveUrl(entry.path)) }
                  : { label: '下载', onSelect: () => triggerDownload(api.downloadUrl(entry.path)) },
                ...(isZip
                  ? [{ label: unpacking ? '解压中…' : '解压', onSelect: onUnpack, disabled: unpacking }]
                  : []),
                { label: '分享', onSelect: onShare },
                { label: '移动', onSelect: onMove },
                { label: '重命名', onSelect: onStartRename },
                // Deliberately still two steps. Collapsing the buttons into a
                // menu is not a reason to make deletion one click.
                { label: '删除', onSelect: onAskDelete, danger: true },
              ]}
            />
          </span>
        ))}
    </li>
  )
}
