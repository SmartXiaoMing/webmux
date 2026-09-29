import { useState } from 'react'
import type { Place, PlacesResponse } from '@webmux/shared'
import { SectionHeader } from '../../components/SectionHeader'
import { HistoryIcon, StarIcon } from '../../components/icons'

/**
 * Favourites and recently opened directories, as two independent collapsible
 * sections.
 *
 * Separate components rather than one panel because the sidebar order is
 * 收藏目录 / 会话 / 已打开目录 — the session list sits between them, so a single
 * component could not place them. The data still arrives in one response
 * (`GET /api/places` returns both lists) and the caller holds it, so splitting
 * the rendering costs no extra requests.
 */

export interface PlacesSectionProps {
  places: PlacesResponse | null
  /** Switches to the file view and navigates there. */
  onOpenDirectory: (path: string) => void
  /** Shown once, above the favourites section, which is the first of the two. */
  error?: string | null
  onUnstar?: (path: string) => void
}

function PlaceRow({
  place,
  onOpenDirectory,
  onUnstar,
}: {
  place: Place
  onOpenDirectory: (path: string) => void
  onUnstar?: ((path: string) => void) | undefined
}): React.JSX.Element {
  return (
    <li className="group flex items-center gap-1 rounded px-1 hover:bg-surface-raised/60">
      <button
        type="button"
        data-place={place.path}
        title={place.path}
        className="min-w-0 flex-1 truncate py-1 text-left text-xs text-muted"
        onClick={() => onOpenDirectory(place.path)}
      >
        {place.name}
      </button>
      {place.favorite && onUnstar && (
        <button
          type="button"
          aria-label={`取消收藏 ${place.name}`}
          title="取消收藏"
          data-unstar={place.path}
          className="shrink-0 text-accent opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-60"
          onClick={() => onUnstar(place.path)}
        >
          <StarIcon size={13} filled />
        </button>
      )}
    </li>
  )
}

/**
 * 收藏目录, collapsed by default.
 *
 * It is a shortcut list that stays empty until something is starred, and an
 * expanded empty box is the most expensive kind of sidebar space. The count in
 * the header is what keeps a collapsed section from hiding its own contents.
 */
export function FavoritesSection({
  places,
  onOpenDirectory,
  onUnstar,
  error = null,
}: PlacesSectionProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const favorites = places?.favorites ?? []

  return (
    <section className="shrink-0 border-t border-line">
      {error !== null && <p className="px-3 py-1 text-[11px] text-danger">{error}</p>}
      <SectionHeader
        label="收藏目录"
        icon={<StarIcon size={12} />}
        count={favorites.length}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        testId="favorites"
      />
      {open &&
        (favorites.length === 0 ? (
          <p className="px-3 pb-2 text-[11px] text-faint">在文件页用星标收藏目录</p>
        ) : (
          <ul className="max-h-40 overflow-y-auto px-2 pb-2">
            {favorites.map((p) => (
              <PlaceRow key={p.path} place={p} onOpenDirectory={onOpenDirectory} onUnstar={onUnstar} />
            ))}
          </ul>
        ))}
    </section>
  )
}

/** 已打开目录 — "get back to where I was", also collapsed by default. */
export function RecentSection({ places, onOpenDirectory }: PlacesSectionProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const recent = places?.recent ?? []

  return (
    <section className="shrink-0 border-t border-line">
      <SectionHeader
        label="已打开目录"
        icon={<HistoryIcon size={12} />}
        count={recent.length}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        testId="recent"
      />
      {open && (
        <ul className="max-h-40 overflow-y-auto px-2 pb-2">
          {recent.length === 0 && <li className="px-2 py-1 text-[11px] text-faint">还没有打开过目录</li>}
          {recent.map((p) => (
            <PlaceRow key={`recent:${p.path}`} place={p} onOpenDirectory={onOpenDirectory} />
          ))}
        </ul>
      )}
    </section>
  )
}
