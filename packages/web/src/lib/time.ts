/**
 * How long ago, in words.
 *
 * Shared by the session list and the notification panel, which both answer the
 * same question at the same granularity — "is this stale?" — and both render
 * it in a row too narrow for a timestamp.
 */
export function relativeTime(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000)
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86_400)} 天前`
}
