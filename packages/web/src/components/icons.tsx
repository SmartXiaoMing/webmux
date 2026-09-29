/**
 * Inline SVG icons.
 *
 * Inline rather than an icon package: these are a dozen small paths, and a
 * dependency for them would be larger than the whole set. `currentColor` so
 * they follow the surrounding text, and `aria-hidden` because every one of them
 * is used inside a control that already carries an `aria-label` — an icon that
 * announces itself as well would be read out twice.
 */

interface IconProps {
  size?: number
}

function Svg({ size = 16, children }: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/** Hidden files: shown when off, struck through when on. */
export function EyeIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  )
}

export function EyeOffIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M3 3l18 18" />
      <path d="M10.6 5.2A9.9 9.9 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4" />
      <path d="M6.2 6.7A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4-.8" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </Svg>
  )
}

/** Download a directory as an archive. */
export function ArchiveIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M12 11v5" />
      <path d="M9.5 13.5 12 16l2.5-2.5" />
    </Svg>
  )
}

/** A plain directory, for a path shown on its own rather than as an action. */
export function FolderIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </Svg>
  )
}

export function FolderPlusIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M12 11v5M9.5 13.5h5" />
    </Svg>
  )
}

export function FilePlusIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M12 12v4M10 14h4" />
    </Svg>
  )
}

export function UploadIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M12 16V4" />
      <path d="M7.5 8.5 12 4l4.5 4.5" />
      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </Svg>
  )
}

/** Open a terminal rooted at the current directory. */
export function TerminalIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7.5 9.5 2.5 2.5-2.5 2.5" />
      <path d="M13 14.5h3.5" />
    </Svg>
  )
}

export function MoreIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </Svg>
  )
}

export function StarIcon({ size, filled = false }: IconProps & { filled?: boolean }): React.JSX.Element {
  return (
    <svg
      width={size ?? 16}
      height={size ?? 16}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8Z" />
    </svg>
  )
}

/** Recently opened directories: a clock face wound back. */
export function HistoryIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </Svg>
  )
}

export function ChevronRightIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="m9 5 7 7-7 7" />
    </Svg>
  )
}
