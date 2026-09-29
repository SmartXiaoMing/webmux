/*
 * Offline fallback for the app shell.
 *
 * Scoped to that one job on purpose. This is not a versioning mechanism and not
 * a performance one: navigations are network-first, so an online user always
 * gets the current shell, which means the only situation this can be wrong in
 * is one where the network is already gone — and the alternative there is a
 * browser error page.
 *
 * Plain JavaScript, no build step: it is copied verbatim from `public/`, since
 * the service worker's scope depends on the URL it is served from.
 */

const CACHE = 'webmux-v1'

/*
 * Refreshed at install. Fetched individually rather than with `addAll`: one
 * 404 would fail the entire install and leave the app with no worker at all,
 * which is a much worse outcome than a missing icon.
 */
const PRECACHE = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => undefined)))),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)))),
  )
})

/*
 * Never intercepted, never cached.
 *
 *   - `/api/*` responses are per-cookie and carry no `Vary: Cookie`, while the
 *     Cache API keys on the URL alone — on a shared device that serves one
 *     person's session list to another. A cached auth status is also a UI that
 *     lies.
 *   - `/s/*` is a server-rendered page whose URL *is* the bearer token, and the
 *     server sends `no-store` deliberately. Caching it would keep the token in
 *     a cache that outlives the tab, and would defeat revocation, expiry and
 *     the download cap — the three things the share feature exists for. The
 *     Cache API does not honour `no-store` on its own, which is exactly why
 *     this is a path check rather than a header check.
 *   - `/ws` never reaches the fetch handler, but the rule documents the intent.
 */
function isUntouchable(url) {
  return /^\/(api|ws|s)(\/|$)/.test(url.pathname)
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (isUntouchable(url)) return

  // Navigations: network-first, falling back to the cached shell.
  //
  // Cache-first is wrong here in a specific way. After a redeploy the cached
  // `index.html` references an asset hash the new build deleted; asking for it
  // gets the server's SPA fallback, which answers with HTML where a module was
  // expected, and the app is a white screen. Network-first means the only
  // stale window is when the server is unreachable — precisely when a stale
  // shell is still better than nothing.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE)
            // One key for every navigation, so deep links do not each store a
            // copy of the same shell.
            await cache.put('/', response.clone())
          }
          return response
        })
        .catch(async () => (await caches.match('/')) ?? Response.error()),
    )
    return
  }

  // Content-hashed assets: a cache hit is by definition the right bytes.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(async (cached) => {
        if (cached) return cached
        const response = await fetch(request)
        if (response.ok) {
          const cache = await caches.open(CACHE)
          await cache.put(request, response.clone())
        }
        return response
      }),
    )
    return
  }

  // Icons, manifest, favicon: stale-while-revalidate. They change rarely and
  // matter at install time, so serving the copy while refreshing is right.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE)
            await cache.put(request, response.clone())
          }
          return response
        })
        .catch(async () => (await caches.match(request)) ?? Response.error())

      return cached ?? network
    }),
  )
})
