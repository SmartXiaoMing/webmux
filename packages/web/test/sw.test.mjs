/**
 * Unit tests for the service worker's push handling.
 *
 * Run in `node:vm` against a hand-built worker global, rather than in a
 * browser. The alternative is Playwright plus a Web Push service to talk to,
 * and what is actually worth checking here is small and entirely local: does a
 * notification click select the session it came from, does a payload that
 * cannot be parsed still produce something visible, and does an unread count
 * reach the app badge.
 *
 * The file is plain JavaScript with no build step — it is served verbatim from
 * `public/` — so reading and evaluating it directly is the only way to test it
 * at all.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const source = readFileSync(path.join(import.meta.dirname, '../public/sw.js'), 'utf8')

/**
 * Loads sw.js into a fake worker global and returns the handles a test needs.
 *
 * `options.clients` describes the windows `matchAll` reports: a URL, or an
 * object with `url` and `visibilityState`. Both matter — the push handler
 * checks visibility and the click handler has to tell the app from a share
 * page.
 */
function loadWorker(options = {}) {
  const listeners = new Map()
  const shown = []
  const badges = []
  const opened = []
  const focused = []
  const posted = []

  const clients = (options.clients ?? []).map((spec) => {
    const described = typeof spec === 'string' ? { url: spec } : spec
    const client = {
      url: described.url,
      visibilityState: described.visibilityState ?? 'hidden',
      focus: async () => {
        focused.push(described.url)
        return client
      },
      postMessage: (message) => posted.push(message),
    }
    return client
  })

  const self = {
    addEventListener: (type, handler) => listeners.set(type, handler),
    skipWaiting: () => {},
    registration: {
      showNotification: async (title, config) => {
        shown.push({ title, config })
      },
    },
    navigator: {
      setAppBadge: async (count) => {
        badges.push(count)
      },
    },
    clients: {
      claim: async () => {},
      matchAll: async () => clients,
      openWindow: async (url) => {
        opened.push(url)
      },
    },
  }

  const caches = {
    open: async () => ({ add: async () => {}, put: async () => {} }),
    keys: async () => [],
    match: async () => undefined,
  }

  const context = vm.createContext({
    self,
    caches,
    fetch: async () => ({ ok: true, clone: () => ({}) }),
    Response: { error: () => ({}) },
    URL,
    console,
  })
  vm.runInContext(source, context, { filename: 'sw.js' })

  /** Dispatches an event and waits for whatever it passed to `waitUntil`. */
  const dispatch = async (type, event) => {
    const handler = listeners.get(type)
    assert.ok(handler, `${type} has a handler`)
    let pending
    handler({ ...event, waitUntil: (promise) => (pending = promise) })
    if (pending) await pending
  }

  return { listeners, shown, badges, opened, focused, posted, dispatch }
}

describe('the service worker push handler', () => {
  it('shows what the payload says', async () => {
    const worker = loadWorker()
    await worker.dispatch('push', {
      data: {
        json: () => ({ id: 7, title: '构建完成', body: '耗时 3m12s', sessionId: 'abc', unread: 2 }),
      },
    })

    assert.equal(worker.shown.length, 1)
    assert.equal(worker.shown[0].title, '构建完成')
    assert.equal(worker.shown[0].config.body, '耗时 3m12s')
    // The tag is shared with the page's own notification for the same event,
    // so a hidden tab that shows one and a push that shows another collapse
    // into a single notification instead of two.
    assert.equal(worker.shown[0].config.tag, 'webmux-7')
    assert.equal(worker.shown[0].config.data.sessionId, 'abc')
    assert.deepEqual(worker.badges, [2])
  })

  it('still shows something when the payload cannot be read', async () => {
    // The browser requires a visible notification for every push, and a
    // malformed payload is not a reason to be silent — nor to throw.
    const worker = loadWorker()
    await worker.dispatch('push', {
      data: {
        json: () => {
          throw new Error('not json')
        },
      },
    })

    assert.equal(worker.shown.length, 1)
    assert.equal(worker.shown[0].title, 'webmux')
    assert.equal(worker.shown[0].config.tag, 'webmux')
    assert.equal(worker.badges.length, 0)
  })

  it('stays quiet when the app is open and in front', async () => {
    // The page raises an in-app toast for this same event; a system
    // notification as well would be the second announcement of one thing. The
    // shared tag cannot prevent it — that only collapses entries in the
    // notification centre.
    const worker = loadWorker({ clients: [{ url: 'http://localhost/', visibilityState: 'visible' }] })
    await worker.dispatch('push', {
      data: { json: () => ({ id: 9, title: '构建完成', unread: 1 }) },
    })

    assert.equal(worker.shown.length, 0)
    // The badge is still updated: that is the page's job only while it is
    // running, and this is the one path that knows even when it is not.
    assert.deepEqual(worker.badges, [1])
  })

  it('shows it when the app is open but in the background', async () => {
    const worker = loadWorker({ clients: [{ url: 'http://localhost/', visibilityState: 'hidden' }] })
    await worker.dispatch('push', { data: { json: () => ({ id: 9, title: '构建完成' }) } })

    assert.equal(worker.shown.length, 1)
  })
})

describe('the service worker click handler', () => {
  it('opens the app at the session when nothing is running', async () => {
    const worker = loadWorker()
    await worker.dispatch('notificationclick', {
      notification: { close: () => {}, data: { sessionId: 'abc' } },
    })

    assert.deepEqual(worker.opened, ['/?session=abc'])
  })

  it('asks an open app to switch sessions rather than reloading it', async () => {
    const worker = loadWorker({ clients: ['http://localhost/'] })
    await worker.dispatch('notificationclick', {
      notification: { close: () => {}, data: { sessionId: 'abc' } },
    })

    assert.equal(worker.opened.length, 0, 'no second window')
    assert.deepEqual(worker.focused, ['http://localhost/'])
    // Compared field by field: the message object was built inside the vm's
    // realm, so it has a different Object.prototype and deepEqual — which
    // checks prototypes — reports it as unequal to an identical literal.
    assert.equal(worker.posted.length, 1)
    assert.equal(worker.posted[0].t, 'open-session')
    assert.equal(worker.posted[0].sessionId, 'abc')
  })

  it('ignores a share page, which would swallow the click', async () => {
    // /s/<token> is same-origin but runs no application code, so focusing it
    // and posting a message would do nothing at all — worse than opening a
    // new window, which at least lands on the session.
    const worker = loadWorker({ clients: ['http://localhost/s/abc123'] })
    await worker.dispatch('notificationclick', {
      notification: { close: () => {}, data: { sessionId: 'abc' } },
    })

    assert.deepEqual(worker.focused, [])
    assert.equal(worker.posted.length, 0)
    assert.deepEqual(worker.opened, ['/?session=abc'])
  })

  it('falls back to the app root when the notification has no session', async () => {
    const worker = loadWorker()
    await worker.dispatch('notificationclick', {
      notification: { close: () => {}, data: null },
    })

    assert.deepEqual(worker.opened, ['/'])
  })
})
