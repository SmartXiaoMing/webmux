import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

// Deliberately not wrapped in <StrictMode>. Its double-invoked effects are
// useful for most components, but here they would open two WebSockets and
// build two xterm instances (each holding a WebGL context) on every mount,
// then tear one of each down — churn that obscures real lifecycle bugs in the
// code this app most depends on.
createRoot(container).render(<App />)

/*
 * Offline fallback for the app shell. See public/sw.js for what it will and
 * will not cache.
 *
 * Production only: Vite's dev server also serves `public/` at `/sw.js`, and a
 * worker caching the dev shell is a debugging trap where you edit a file and
 * the browser keeps serving the old one.
 *
 * After `load`, so registering it does not compete with the first paint or the
 * terminal's WebSocket handshake.
 *
 * Note it needs a secure context: over plain HTTP to a LAN address there is no
 * service worker and no install prompt. `localhost` and `127.0.0.1` are exempt.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // Blocked, insecure context, or an unsupported browser. Offline support
      // is a bonus; nothing else depends on it.
    })
  })
}
