/**
 * The public share page, rendered as a string.
 *
 * ## Why this is not a route in the SPA
 *
 * The React app is the *authenticated* origin's app. Routing an unauthenticated
 * visitor into it means the SPA boots, calls `/api/auth/status`, gets a 401 and
 * redirects to the login page — so the share page would need a carve-out in the
 * router, a carve-out in the auth guard, and a standing guarantee that nothing
 * along the way touches an authenticated endpoint. Each of those is a place
 * where a later edit re-authenticates the visitor or redirects them away.
 *
 * Instead: no runtime, no router, no state. From a filename to the page there is
 * exactly one path, and it goes through `escapeHtml`.
 *
 * ## The two rules that matter
 *
 * 1. **Entry names are attacker-influenced.** Anyone who can write a file can
 *    create one called `<img src=x onerror=...>`. This page is unauthenticated
 *    *and same-origin with the SPA*.
 * 2. **No `<script>`, ever.** That is why the unlock form is a native form POST
 *    and not `fetch()`. The moment there is inline JS, an escaping bug becomes
 *    script execution and the CSP has to grow a `script-src`, and the whole
 *    calculus changes.
 *
 * The CSP is `default-src 'none'`, whose value is not that it prevents the bug
 * but that it removes the *exfiltration channel* if one ever exists: no fetch,
 * no XHR, no WebSocket, no `<img>` beacon.
 *
 * ## Nothing above the shared basename is ever rendered
 *
 * Not the absolute path, not the root name, not the sibling roots. `/home/<user>/`
 * is the single most valuable recon item an absolute-path leak hands over, and
 * the root name gives away the multi-root layout for no benefit at all.
 *
 * ## If you ever add a per-file download link
 *
 * Every filename currently reaches only a text node. The first per-file link
 * puts a filename into an `href` (where `escapeHtml` is the wrong tool and
 * `encodeURIComponent` is the right one) and possibly into a query parameter
 * that gets reflected. That change kills the invariant this file is built on;
 * the escaping rules have to be revisited with it.
 */

/** How many directory entries a share page will list. */
export const MAX_LISTED_ENTRIES = 500

/** Longest display name rendered. A 4 KB filename must not make a 4 KB row. */
const MAX_DISPLAY_NAME = 120

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * One pass over the string, escaping all five characters.
 *
 * One pass rather than a chain of `.replace()` calls: a chain is correct only
 * if `&` happens to run first, and a single pass makes the question disappear.
 * `"` and `'` are escaped even in text nodes — a rule of "escape what the
 * context needs" is a rule that eventually gets a context wrong, and escaping
 * two extra characters is free.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] as string)
}

/** Bounded independently of the entry cap, so one name cannot blow up a row. */
function displayName(name: string): string {
  const cleaned = name.replace(/[\r\n\0]/g, '')
  return cleaned.length <= MAX_DISPLAY_NAME ? cleaned : `${cleaned.slice(0, MAX_DISPLAY_NAME)}…`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

function formatTime(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export interface ShareEntry {
  name: string
  size: number
  mtimeMs: number
  isDirectory: boolean
}

const STYLE = `
:root { color-scheme: dark }
* { box-sizing: border-box }
body {
  margin: 0; padding: 2rem 1rem; min-height: 100vh;
  background: #0b0e14; color: #c3ccda;
  font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
}
main { max-width: 42rem; margin: 0 auto }
h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 .25rem; word-break: break-all }
p.meta { margin: 0 0 1.25rem; color: #6d7889; font-size: .82rem }
a.button, button {
  display: inline-block; padding: .6rem 1rem; border-radius: .5rem;
  background: #5aa9ff; color: #06121f; text-decoration: none;
  font-size: .9rem; font-weight: 500; border: 0; cursor: pointer;
}
table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: .85rem }
th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid #222836 }
th { color: #6d7889; font-weight: 500; font-size: .78rem }
td.size, th.size { text-align: right; color: #6d7889; font-family: ui-monospace, monospace; white-space: nowrap }
td.name { word-break: break-all }
td.dir { color: #5aa9ff }
.note { color: #6d7889; font-size: .82rem; margin: 1rem 0 }
.error { color: #ff6b6b; font-size: .85rem; margin: .75rem 0 }
form { margin: 1.25rem 0; display: flex; gap: .5rem; flex-wrap: wrap }
input[type=password] {
  flex: 1 1 12rem; padding: .6rem .75rem; border-radius: .5rem;
  border: 1px solid #222836; background: #11151d; color: #c3ccda; font-size: .95rem;
}
footer { margin-top: 2.5rem; color: #4a5364; font-size: .75rem }
`

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
<footer>webmux</footer>
</body>
</html>
`
}

export interface PageContext {
  /** Already validated against `SHARE_TOKEN_PATTERN`, so it holds nothing escapable. */
  token: string
  name: string
}

/** The unlock form. Also used for a wrong password and for a rate-limited attempt. */
export function renderPasswordPage(
  context: PageContext,
  message?: { kind: 'error' | 'note'; text: string },
): string {
  const notice =
    message === undefined
      ? ''
      : `<p class="${message.kind === 'error' ? 'error' : 'note'}">${escapeHtml(message.text)}</p>`

  return shell(
    context.name,
    `    <h1>${escapeHtml(displayName(context.name))}</h1>
    <p class="meta">这个分享受密码保护</p>
${notice === '' ? '' : `    ${notice}\n`}    <form method="post" action="/s/${context.token}">
      <input type="password" name="password" placeholder="密码" autofocus autocomplete="off" aria-label="密码">
      <button type="submit">打开</button>
    </form>`,
  )
}

export function renderFilePage(context: PageContext, size: number, mtimeMs: number): string {
  return shell(
    context.name,
    `    <h1>${escapeHtml(displayName(context.name))}</h1>
    <p class="meta">${formatBytes(size)} · ${formatTime(mtimeMs)}</p>
    <a class="button" href="/s/${context.token}/raw">下载</a>`,
  )
}

export function renderDirectoryPage(
  context: PageContext,
  entries: ShareEntry[],
  totalIsCapped: boolean,
): string {
  const rows = entries
    .map(
      (entry) => `      <tr>
        <td class="name${entry.isDirectory ? ' dir' : ''}">${escapeHtml(displayName(entry.name))}${entry.isDirectory ? '/' : ''}</td>
        <td class="size">${entry.isDirectory ? '—' : formatBytes(entry.size)}</td>
        <td class="size">${formatTime(entry.mtimeMs)}</td>
      </tr>`,
    )
    .join('\n')

  const capped = totalIsCapped
    ? `<p class="note">还有更多条目未显示（共 ${MAX_LISTED_ENTRIES}+ 项）。下载压缩包可以看到全部内容。</p>`
    : ''

  return shell(
    context.name,
    `    <h1>${escapeHtml(displayName(context.name))}</h1>
    <p class="meta">目录分享 · ${entries.length}${totalIsCapped ? '+' : ''} 项</p>
    <a class="button" href="/s/${context.token}/raw">打包下载 (zip)</a>
${capped}
    <table>
      <thead><tr><th>名称</th><th class="size">大小</th><th class="size">修改时间</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>`,
  )
}

/**
 * Every refusal the visitor can see.
 *
 * One page rather than five, because the visitor's action is identical in all
 * of them: ask for a new link. `/raw` reaches this too — a browser navigation
 * showing `{"error":{"code":"share_expired"}}` is a worse product than a
 * sentence.
 */
export function renderUnavailablePage(reason: string): string {
  return shell(
    '链接不可用',
    `    <h1>链接不可用</h1>
    <p class="meta">${escapeHtml(reason)}</p>`,
  )
}

export function renderNotFoundPage(): string {
  return shell(
    '找不到',
    `    <h1>找不到</h1>
    <p class="meta">这个链接不存在，或者已经被删除了。</p>`,
  )
}

export const MESSAGES = {
  revoked: '这个分享已被撤销。',
  expired: '这个分享已过期。',
  exhausted: '这个分享的下载次数已经用完。',
  sourceUnavailable: '分享的文件已经不在了。',
  wrongPassword: '密码不正确。',
} as const
