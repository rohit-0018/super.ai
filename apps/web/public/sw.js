/* QWAI Service Worker — shell cache for offline support */
const CACHE = 'qwai-shell-v1';

/* Static assets to pre-cache on install */
const PRECACHE = ['/dashboard/', '/snipe/', '/portfolio/', '/wallets/', '/chat/'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  /* Never intercept API calls — always go to network */
  if (url.pathname.startsWith('/api/') || url.hostname !== self.location.hostname) return;

  /* Navigation: network-first, fall back to cached shell */
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          const clone = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
          return r;
        })
        .catch(() => caches.match(e.request).then((c) => c || caches.match('/dashboard/')))
    );
    return;
  }

  /* Static assets: cache-first */
  e.respondWith(
    caches.match(e.request).then(
      (cached) => cached || fetch(e.request).then((r) => {
        if (r.ok && e.request.method === 'GET') {
          caches.open(CACHE).then((c) => c.put(e.request, r.clone()));
        }
        return r;
      })
    )
  );
});
