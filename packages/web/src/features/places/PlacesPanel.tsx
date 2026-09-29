import { useCallback, useEffect, useState } from 'react'
import type { Place } from '@webmux/shared'
import { ApiError, api } from '../../lib/api'
import { ChevronRightIcon, HistoryIcon, StarIcon } from '../../components/icons'

export interface PlacesPanelProps {
  /** Switches to the file view and navigates there. */
  onOpenDirectory: (path: string) => void
  onSignOut: () => void
  /** Bumped by the caller when something elsewhere may have changed the lists. */
  reloadKey: number
}

/**
 * Favourites and recently opened directories.
 *
 * Both lists live on the server, so a directory starred on the desktop is
 * starred on the phone — unlike the font size, which is deliberately per device
 * because a phone and a desktop genuinely want different values.
 */
export function PlacesPanel({
  onOpenDirectory,
  onSignOut,
  reloadKey,
}: PlacesPanelProps): React.JSX.Element {
  const [favorites, setFavorites] = useState<Place[]>([])
  const [recent, setRecent] = useState<Place[]>([])
  const [showRecent, setShowRecent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await api.listPlaces()
      setFavorites(result.favorites)
      setRecent(result.recent)
      setError(null)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onSignOut()
        return
      }
      setError(err instanceof ApiError ? err.message : '无法加载目录列表')
    }
  }, [onSignOut])

  useEffect(() => {
    void load()
  }, [load, reloadKey])

  const unstar = useCallback(
    async (path: string): Promise<void> => {
      try {
        const result = await api.setFavorite(path, false)
        setFavorites(result.favorites)
        setRecent(result.recent)
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) onSignOut()
      }
    },
    [onSignOut],
  )

  function row(place: Place, key: string): React.JSX.Element {
    return (
      <li key={key} className="group flex items-center gap-1 rounded px-1 hover:bg-surface-raised/60">
        <button
          type="button"
          data-place={place.path}
          title={place.path}
          className="min-w-0 flex-1 truncate py-1 text-left text-xs text-muted"
          onClick={() => onOpenDirectory(place.path)}
        >
          {place.name}
        </button>
        {place.favorite && (
          <button
            type="button"
            aria-label={`取消收藏 ${place.name}`}
            title="取消收藏"
            data-unstar={place.path}
            className="shrink-0 text-accent opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-60"
            onClick={() => void unstar(place.path)}
          >
            <StarIcon size={13} filled />
          </button>
        )}
      </li>
    )
  }

  return (
    <div className="shrink-0 border-t border-line">
      {error !== null && <p className="px-3 py-1 text-[11px] text-danger">{error}</p>}

      <section>
        <h2 className="flex items-center gap-1 px-3 py-2 text-xs font-medium tracking-wide text-muted uppercase">
          <StarIcon size={12} />
          收藏目录
        </h2>
        {favorites.length === 0 ? (
          <p className="px-3 pb-2 text-[11px] text-faint">在文件页用星标收藏目录</p>
        ) : (
          <ul className="max-h-40 overflow-y-auto px-2 pb-2">{favorites.map((p) => row(p, p.path))}</ul>
        )}
      </section>

      <section className="border-t border-line">
        {/* Collapsed by default: this is "get back to where I was", not a
            primary view, and it grows on its own. */}
        <button
          type="button"
          aria-expanded={showRecent}
          data-recent-toggle=""
          className="flex w-full items-center gap-1 px-3 py-2 text-left text-xs font-medium tracking-wide text-muted uppercase"
          onClick={() => setShowRecent((value) => !value)}
        >
          <span className={showRecent ? 'rotate-90 transition-transform' : 'transition-transform'}>
            <ChevronRightIcon size={12} />
          </span>
          <HistoryIcon size={12} />
          已打开目录
          {recent.length > 0 && <span className="text-faint">({recent.length})</span>}
        </button>
        {showRecent && (
          <ul className="max-h-40 overflow-y-auto px-2 pb-2">
            {recent.length === 0 && <li className="px-2 py-1 text-[11px] text-faint">还没有打开过目录</li>}
            {recent.map((p) => row(p, `recent:${p.path}`))}
          </ul>
        )}
      </section>
    </div>
  )
}
