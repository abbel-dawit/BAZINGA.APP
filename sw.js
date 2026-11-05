// BAZINGA service worker — makes the app open and run with no internet.
const VERSION = 'bazinga-v48';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'favicon.ico',
  'js/bazinga.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/app-192.png', 'icons/app-512.png', 'icons/bmc-qr.png', 'icons/favicon-32.png', 'icons/apple-touch-icon.png', 'version.json'
];
let trimT = null;
const trimSoon = () => { clearTimeout(trimT); trimT = setTimeout(async () => { try { const c = await caches.open('bazinga-img'), ks = await c.keys(); for (const k of ks.slice(0, Math.max(0, ks.length - 3000))) await c.delete(k); } catch { } }, 10000); };
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== 'bazinga-img').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// ---------- Home Screen icon in your theme colour ----------
// The page saves your colour in the 'bz-meta' cache. The install manifest and the app / Home Screen icons
// keep the same addresses, and are answered here with that colour's versions, so an installed app picks
// the new icon up the next time the phone checks for updates (Android/Chrome), and "Add to Home Screen"
// always uses your colour.
const THEMES = ['mint', 'violet', 'indigo', 'ocean', 'cyan', 'gold', 'sunset', 'rose', 'crimson'];
let themeNow = null;
async function theme() {
  if (themeNow) return themeNow;
  try { const r = await (await caches.open('bz-meta')).match('theme'); themeNow = r ? (await r.text()) : 'volt'; } catch { themeNow = 'volt'; }
  return themeNow;
}
self.addEventListener('message', e => {
  if (e.data?.theme) themeNow = e.data.theme;
  // An update is ready: fetch the new page now, so the reload opens the new version straight away
  if (e.data?.refreshShell) e.waitUntil((async () => {
    try { const c = await caches.open(VERSION), r = await fetch('index.html', { cache: 'no-store' }); if (r.ok) { await c.put('index.html', r.clone()); await c.put('./', r); } } catch { }
    e.ports?.[0]?.postMessage('ok');
  })());
});
const THEMED_ICON = /\/icons\/(apple-touch-icon|app-192|app-512|app-maskable-512|maskable-512|favicon-32|favicon-16)\.png$/;
async function themedFetch(req, url) {
  const t = await theme();
  if (url.pathname.endsWith('/manifest.webmanifest')) {
    const base = await (await fetch('manifest.webmanifest', { cache: 'no-cache' }).catch(() => caches.match('manifest.webmanifest'))).json();
    if (THEMES.includes(t)) base.icons = base.icons.map(i => ({ ...i, src: `icons/theme/${t}-${i.src.split('/').pop().split('?')[0]}` }));
    return new Response(JSON.stringify(base), { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache' } });
  }
  const m = THEMED_ICON.exec(url.pathname);
  if (m && THEMES.includes(t)) {
    const themed = new URL(`icons/theme/${t}-${m[1]}.png`, self.registration.scope).href;
    const c = await caches.open(VERSION);
    const hit = await c.match(themed);
    if (hit) return hit;
    const r = await fetch(themed); if (r.ok) c.put(themed, r.clone()); return r;
  }
  return null;
}
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin && (url.pathname.endsWith('/manifest.webmanifest') || THEMED_ICON.test(url.pathname))) {
    e.respondWith(themedFetch(e.request, url).then(r => r || fetch(e.request)).catch(() => fetch(e.request)));
    return;
  }
  // App files. The page opens INSTANTLY from the saved copy (no waiting on the network = no black screen
  // on launch), and the saved copy is refreshed quietly in the background. Updates still arrive: the app
  // checks version.json (always from the network) and reloads into the new version.
  if (url.origin === location.origin) {
    if (url.pathname.endsWith('/version.json')) {
      e.respondWith(fetch(e.request, { cache: 'no-store' }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || Response.error())));
      return;
    }
    const isPage = e.request.mode === 'navigate' || /\/(index\.html)?$/.test(url.pathname);
    const versioned = /[?&](v|fresh)=/.test(url.search); // css/app.css?v=… and js/bazinga.js?v=… never change once made
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const key = isPage ? 'index.html' : e.request;
      const hit = isPage ? (await cache.match('index.html')) || (await cache.match('./')) : await cache.match(e.request, { ignoreSearch: !versioned });
      const refresh = fetch(isPage ? 'index.html' : e.request, { cache: 'no-cache' }).then(r => {
        if (r.ok) { const c = r.clone(); cache.put(key, c); if (isPage) cache.put('./', r.clone()); }
        return r;
      });
      if (hit) { if (!versioned) e.waitUntil(refresh.catch(() => { })); return hit; }
      try { return await refresh; }
      catch { return (isPage ? await caches.match('index.html') : null) || Response.error(); }
    })());
    return;
  }
  // Fonts + every picture (album art, artist photos, video thumbnails): cache first, so anything that loaded
  // once shows instantly afterwards — and offline. The picture cache is trimmed to the newest ~3000.
  if (e.request.destination === 'image' || /fonts\.(googleapis|gstatic)\.com|mzstatic\.com|i\.scdn\.co|ytimg\.com|dzcdn\.net|deezer\.com/.test(url.hostname)) {
    e.respondWith(caches.open('bazinga-img').then(async cache => {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      try { const r = await fetch(e.request); if (r.ok || r.type === 'opaque') { cache.put(e.request, r.clone()); trimSoon(); } return r; }
      catch { return hit || Response.error(); }
    }));
  }
});
