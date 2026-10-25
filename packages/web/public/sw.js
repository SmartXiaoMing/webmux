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
  // Take over as soon as this worker is ready, rather than waiting for every
  // tab to close. A worker that predates the push handler below drops every
  // push event it is handed, and that window would otherwise last as long as
  // someone keeps a tab open. Safe here because every asset is content-hashed.
  self.skipWaiting()
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => undefined)))),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)))
      await self.clients.claim()
    })(),
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

/*
 * ---------------------------------------------------------------------------
 * Web Push
 * ---------------------------------------------------------------------------
 *
 * This is the half of the notification feature that works with the page
 * closed, and it is the only reason the worker exists beyond caching: the
 * browser wakes *this* file, not the app.
 *
 * The payload shape is duplicated from `PushPayload` in
 * `packages/shared/src/notify.ts`. The duplication is deliberate and
 * unavoidable: sw.js is served verbatim from `public/`, has no build step, and
 * cannot import anything. Keep the two in step by hand.
 *
 *   { id, title, body, level, sessionId, unread }
 */
self.addEventListener('push', (event) => {
  let payload = null
  try {
    payload = event.data ? event.data.json() : null
  } catch {
    // A payload we cannot read is still an event the browser insists we
    // display something for — an empty push is a valid way to say "check in".
    payload = null
  }

  const title = (payload && payload.title) || 'webmux'
  const options = {
    body: (payload && payload.body) || undefined,
    // The same tag the page uses when it raises its own notification for this
    // event, so the two replace one another instead of arriving twice. That
    // happens whenever a tab is open but hidden: it shows a system
    // notification, and so does this handler.
    tag: payload && payload.id ? 'webmux-' + payload.id : 'webmux',
    data: {
      sessionId: (payload && payload.sessionId) || null,
      id: (payload && payload.id) || null,
    },
  }

  event.waitUntil(
    (async () => {
      // With the app open and in front, the page raises an in-app toast for
      // this same event, and a system notification on top of it is the second
      // announcement of one thing. The shared tag below only collapses entries
      // in the notification centre, so it cannot prevent that — this check is
      // what does.
      //
      // It sits slightly against the promise `userVisibleOnly: true` makes, so
      // it is scoped as narrowly as possible: only a client that is actually
      // visible suppresses it, which is precisely the case where the user is
      // being told by the page instead.
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      if (!clientList.some((client) => client.visibilityState === 'visible')) {
        await self.registration.showNotification(title, options)
      }

      // The badge is set from here as well as from the page, because with the
      // app closed there is no page to do it.
      if (payload && typeof payload.unread === 'number' && self.navigator && self.navigator.setAppBadge) {
        await self.navigator.setAppBadge(payload.unread).catch(() => undefined)
      }
    })(),
  )
})

/*
 * A click focuses the app if it is already open and asks it to select the
 * session, rather than navigating: a reload would drop every terminal on
 * screen and reattach them, which is a heavy price for a notification click.
 *
 * `openWindow` is the fallback and is not always permitted — iOS refuses it in
 * some contexts — so it is never the only path.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const sessionId = typeof data.sessionId === 'string' && data.sessionId !== '' ? data.sessionId : null

  // Derived here rather than carried in the payload, because a notification
  // can also be raised by the page — which sets `data` itself and would have
  // to remember this format. One source of truth, and the session survives
  // either route.
  const url = sessionId === null ? '/' : '/?session=' + encodeURIComponent(sessionId)

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // The app, specifically — not merely the first same-origin window. A
      // share page (`/s/<token>`) runs no application code and listens for
      // nothing, so focusing it would swallow the click: no navigation, no
      // message, nothing.
      const appClient = clientList.find((client) => !new URL(client.url).pathname.startsWith('/s/'))
      if (appClient) {
        await appClient.focus()
        appClient.postMessage({ t: 'open-session', sessionId })
        return
      }
      await self.clients.openWindow(url)
    })(),
  )
})
