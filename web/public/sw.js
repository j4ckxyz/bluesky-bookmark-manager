/*
 * Service worker for the installed app.
 *
 * The rules are deliberately conservative:
 *   - /api/* is never cached. Bookmark data is per-account and behind a
 *     session cookie, and a stale answer would be worse than an error.
 *   - Navigations go to the network first, falling back to the cached shell,
 *     so a new deploy is picked up immediately but the app still opens offline.
 *   - Hashed build assets are immutable, so they are served cache-first.
 */
const VERSION = 'v1'
const SHELL = `shell-${VERSION}`
const ASSETS = `assets-${VERSION}`
const SHELL_URL = '/index.html'

/*
 * Precache the shell *and* the hashed bundles it references. Without this the
 * app would only cache assets the worker itself served, and the worker does
 * not control the very first page load — so the first offline visit would get
 * an HTML shell with no JavaScript behind it.
 */
async function precache() {
  const cache = await caches.open(SHELL)
  const extras = ['/manifest.webmanifest', '/icon-192.png']

  let assets = []
  try {
    const response = await fetch(SHELL_URL, { cache: 'reload' })
    if (response.ok) {
      await cache.put(SHELL_URL, response.clone())
      const html = await response.text()
      assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])
    }
  } catch {
    // Offline at install time; the fetch handler fills the cache later.
  }

  await Promise.all(
    [...new Set([...extras, ...assets])].map((url) =>
      cache.add(url).catch(() => undefined),
    ),
  )
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') void self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Leave other origins (avatars, link thumbnails) to the browser.
  if (url.origin !== self.location.origin) return
  // Never touch the API, and never buffer the sync event stream.
  if (url.pathname.startsWith('/api/')) return
  if (request.headers.get('accept')?.includes('text/event-stream')) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          void caches.open(SHELL).then((cache) => cache.put(SHELL_URL, copy))
          return response
        })
        .catch(() => caches.match(SHELL_URL).then((hit) => hit ?? Response.error())),
    )
    return
  }

  if (url.pathname.startsWith('/assets/') || /\.(png|svg|webmanifest|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone()
              void caches.open(ASSETS).then((cache) => cache.put(request, copy))
            }
            return response
          }),
      ),
    )
  }
})
