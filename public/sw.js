const CACHE_NAME = 'bsky-bookmarks-v1';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => k !== CACHE_NAME ? caches.delete(k) : undefined)))
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Only handle navigation or same-origin static requests; skip cross-origin (APIs, OAuth, PDS)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html'))
    );
    return;
  }
  const url = new URL(request.url);
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request))
    );
  }
});
