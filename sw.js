// BAZINGA service worker — makes the app open and run with no internet.
const VERSION = 'bazinga-v21';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'favicon.ico',
  'js/bazinga.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/app-192.png', 'icons/app-512.png', 'icons/bmc-qr.png', 'icons/favicon-32.png', 'icons/apple-touch-icon.png'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== 'bazinga-img').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // App files: network first (so updates arrive), cache fallback when offline
  if (url.origin === location.origin) {
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => {
      if (r.ok) { const c = r.clone(); caches.open(VERSION).then(cache => cache.put(e.request, c)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
    return;
  }
  // Fonts + album artwork: cache first, so covers show offline
  if (/fonts\.(googleapis|gstatic)\.com|mzstatic\.com|i\.scdn\.co|ytimg\.com|dzcdn\.net/.test(url.hostname)) {
    e.respondWith(caches.open('bazinga-img').then(async cache => {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      try { const r = await fetch(e.request); if (r.ok || r.type === 'opaque') cache.put(e.request, r.clone()); return r; }
      catch { return hit || Response.error(); }
    }));
  }
});
