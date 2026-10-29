// Bayad service worker: serves the app from cache so it opens with no internet.
// Bump VERSION whenever you change index.html or other app files.
const VERSION = 'bayad-v4';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './db-worker.js',
  './sqlite/sqlite3.mjs',
  './sqlite/sqlite3.wasm',
  './sqlite/sqlite3-opfs-async-proxy.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png'
];
const FONT_CACHE = 'bayad-fonts';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(c => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== FONT_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google Fonts: cache-first, saved after the first online visit.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(FONT_CACHE).then(async cache => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
          return res;
        } catch (e) {
          return new Response('', { status: 504 });
        }
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;
  // Sign-in and sync always go to the server, never the cache.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname === '/healthz') return;

  // Page loads: network first so updates arrive, cached copy when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok && res.type === 'basic' && (url.pathname === '/' || url.pathname === '/index.html')) {
            const copy = res.clone(); caches.open(VERSION).then(c => c.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Other app files: cache first.
  event.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }))
  );
});
