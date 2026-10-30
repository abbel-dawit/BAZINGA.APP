/* BAZINGA — built from src/ by build.py. Edit src/, then run: python3 build.py */
(() => {
"use strict";
// ---------- db.js ----------
const __m_db = (() => {
// BAZINGA — on-device storage (IndexedDB). Nothing ever leaves the device.
const DB_NAME = 'bazinga';
const DB_VERSION = 2;
const STORES = ['kv', 'tracks', 'albums', 'playlists', 'files', 'backups', 'ytcache', 'metacache'];
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) {
          db.createObjectStore(s, s === 'kv' || s === 'ytcache' || s === 'metacache' ? undefined : { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Storage is blocked in this browser (private mode?)'));
    req.onblocked = () => reject(new Error('Close other BAZINGA tabs and reload.'));
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

const db = {
  get: (store, key) => open().then(d => reqP(d.transaction(store).objectStore(store).get(key))),
  all: (store) => open().then(d => reqP(d.transaction(store).objectStore(store).getAll())),
  keys: (store) => open().then(d => reqP(d.transaction(store).objectStore(store).getAllKeys())),
  put: (store, val, key) => tx(store, 'readwrite', s => { key === undefined ? s.put(val) : s.put(val, key); }),
  putMany: (store, vals) => tx(store, 'readwrite', s => { for (const v of vals) s.put(v); }),
  del: (store, key) => tx(store, 'readwrite', s => { s.delete(key); }),
  clear: (store) => tx(store, 'readwrite', s => { s.clear(); }),
  async destroy() {
    if (dbp) { (await dbp).close(); dbp = null; }
    await new Promise(res => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = r.onerror = r.onblocked = () => res(); });
  }
};

// Simple key/value helpers.
// Items in SYNC_KV travel to your other synced devices. Each change is time-stamped so devices can tell
// which copy is newer. Removing one only reaches your other devices when you asked for that
// (e.g. "Disconnect"); things that just expire on this device are never removed elsewhere.
const SYNC_KV = ['spotifyClientId', 'spotifyToken', 'ytToken', 'ytLinks', 'ytUploads', 'taste', 'plPlays', 'mixPl'];
const SYNCED = new Set(SYNC_KV);
let stampsP = null, chain = Promise.resolve();
const kvHooks = [];
const onSyncedKvChange = fn => kvHooks.push(fn); // sync.js: send the change to your other devices
const changedKv = k => kvHooks.forEach(f => { try { f(k); } catch { } });
const loadStamps = () => stampsP || (stampsP = db.get('kv', '__stamps').then(v => v || {}).catch(() => ({})));
function editStamps(fn) {
  chain = chain.then(async () => { const s = await loadStamps(); fn(s); await db.put('kv', s, '__stamps'); }).catch(() => { });
  return chain;
}
const kv = {
  get: (k, dflt = null) => db.get('kv', k).then(v => v === undefined ? dflt : v),
  set: async (k, v) => { await db.put('kv', v, k); if (SYNCED.has(k)) { await editStamps(s => { s[k] = { ts: Date.now() }; }); changedKv(k); } },
  del: async (k, { everywhere = false } = {}) => {
    await db.del('kv', k);
    if (SYNCED.has(k)) { await editStamps(s => { if (everywhere) s[k] = { ts: Date.now(), del: true }; else delete s[k]; }); if (everywhere) changedKv(k); }
  },
  // for sync: read the time stamps, and write a value that came from another device (keeping its stamp)
  stamps: async () => ({ ...(await loadStamps()) }),
  putSynced: async (k, rec) => {
    if (rec.del) await db.del('kv', k); else await db.put('kv', rec.v, k);
    await editStamps(s => { s[k] = rec.del ? { ts: rec.ts, del: true } : { ts: rec.ts }; });
  }
};

return { STORES, db, SYNC_KV, onSyncedKvChange, kv };
})();
// ---------- util.js ----------
const __m_util = (() => {
// Shared helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const uid = (p = 'id') => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Normalise a title/artist for matching ("Song (feat. X) - Remastered 2011" -> "song")
function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\s*[\(\[][^\)\]]*(feat|ft\.|with|remaster|version|edit|mono|stereo|live|deluxe)[^\)\]]*[\)\]]/g, '')
    .replace(/\s+-\s+.*(remaster|version|edit|mono|stereo|live).*$/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
const mainArtist = a => String(a || '').split(/;|,|&| feat\.? | ft\.? | x /i)[0].trim();
// "A;B;C" or "A, B, C" -> ["A","B","C"]
const splitArtists = s => String(s || '').split(String(s).includes(';') ? ';' : /\s*,\s*/).map(x => x.trim()).filter(Boolean);
// Show only the main artist; featured artists go into the title: "Tapout (feat. Lil Wayne, Birdman & Future)"
function displayTitle(t) {
  if (!t) return '';
  const others = (t.artists || []).slice(1).filter(a => a && norm(a) !== norm(t.artist));
  if (!others.length || /\((feat|ft|with)\b|\bfeat\.|\bft\./i.test(t.title)) return t.title;
  const list = others.length === 1 ? others[0] : others.slice(0, -1).join(', ') + ' & ' + others[others.length - 1];
  return `${t.title} (feat. ${list})`;
}
const trackKey = (artist, title) => 't_' + norm(mainArtist(artist)) + '|' + norm(title);
const albumKey = (artist, title) => 'a_' + norm(mainArtist(artist)) + '|' + norm(title);

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
const fmtDur = ms => ms ? fmtTime(ms / 1000) : '';
const yearOf = d => { const m = String(d || '').match(/\d{4}/); return m ? +m[0] : null; };

function debounce(fn, ms = 300) {
  let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Event bus
const bus = new EventTarget();
const on = (ev, fn) => { const h = e => fn(e.detail); bus.addEventListener(ev, h); return () => bus.removeEventListener(ev, h); };
const emit = (ev, detail) => bus.dispatchEvent(new CustomEvent(ev, { detail }));
const toast = (msg, kind = 'info') => emit('toast', { msg, kind });

// JSONP (used for Apple's free iTunes Search API, which doesn't always send CORS headers)
let jsonpN = 0;
function jsonp(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const cb = '__bz_jsonp_' + (++jsonpN);
    const s = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeout);
    function cleanup() { clearTimeout(timer); delete window[cb]; s.remove(); }
    window[cb] = data => { cleanup(); resolve(data); };
    s.onerror = () => { cleanup(); reject(new Error('network')); };
    s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
    document.head.appendChild(s);
  });
}

// Resize an image file to a square-ish data URL (for profile pictures)
function imageToDataURL(file, size = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// base64url + deflate for compact share links
async function packToString(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let out = bytes;
  if ('CompressionStream' in window) {
    const cs = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    out = new Uint8Array(await new Response(cs).arrayBuffer());
  }
  let bin = ''; out.forEach(b => bin += String.fromCharCode(b));
  return ('CompressionStream' in window ? 'z' : 'j') + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function unpackString(str) {
  const mode = str[0];
  const b64 = str.slice(1).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  let bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  if (mode === 'z') {
    const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(ds).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function hashColor(s) {
  let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(h) % 360} 55% 38%)`;
}

// ---------- Broad genres ----------
// Store/Spotify genres are very specific ("Southern Hip Hop", "Alternative R&B", "Afro-fusion"…).
// Everything in BAZINGA! is grouped into a short list of everyday genres instead.
// Songs whose genre doesn't fit any of them simply have no genre (there is no "Unknown").
const GENRE_RULES = [
  ['Afrobeats', /afro|amapiano|highlife|naija|nigeria|ghana|african|bongo|gqom|azonto|kizomba|afrikaans/],
  ['Gospel', /gospel|christian|worship|praise|inspirational|ccm/],
  ['K-Pop', /k-?pop|korean/],
  ['Latin', /latin|reggaet|urbano|salsa|bachata|merengue|cumbia|regional mexican|mexican|banda|corrido|tango|bossa|samba|sertanejo|brazil|mpb|flamenco|baile funk/],
  ['Reggae', /reggae|dancehall|ska\b|dub\b|soca|calypso/],
  ['Hip-Hop/Rap', /hip.?hop|\brap|trap|drill|grime|boom bap|crunk|bounce/],
  ['R&B', /r ?& ?b|rnb|rhythm and blues|new jack|quiet storm/],
  ['Soul', /soul|motown|funk|disco|doo.?wop/],
  ['Country', /country|americana|bluegrass|honky|nashville/],
  ['Jazz', /jazz|swing|bebop|big band|bop\b|smooth/],
  ['Blues', /blues/],
  ['Classical', /classical|orchestr|opera|baroque|symphon|chamber|piano|choral|romantic era|contemporary classical|minimalism/],
  ['Electronic', /electr|edm|house|techno|trance|dubstep|drum ?(&|and) ?bass|dnb|dance|club|garage|ambient|downtempo|synth|idm|breakbeat|hardstyle|lo.?fi|chill/],
  ['Metal', /metal|hardcore|grindcore|metalcore|djent/],
  ['Rock', /rock|punk|grunge|emo\b|shoegaze|alternative|indie|new wave|post-|britpop|garage rock/],
  ['Folk', /folk|singer.?songwriter|acoustic|celtic/],
  ['Soundtrack', /soundtrack|score|film|movie|\btv\b|musical|anime|video game|show tunes/],
  ['Pop', /pop|adult contemporary|teen|boy band|easy listening|vocal|cabaret|j-?pop|c-?pop|mandopop|cantopop/],
  ['Kids', /child|kids|lullab|nursery/],
  ['Holiday', /holiday|christmas|xmas/],
  ['Comedy', /comedy|spoken word/],
  ['World', /world|india|bollywood|punjabi|bhangra|desi|arab|turk|greek|french|chanson|german|schlager|ethio|habesha|amharic|zouk|mbalax|rai\b/]
];
const genreMemo = new Map();
function broadGenre(raw) {
  if (!raw) return '';
  const k = String(raw);
  if (genreMemo.has(k)) return genreMemo.get(k);
  const s = k.toLowerCase().replace(/[_]+/g, ' ');
  let out = '';
  if (!/^(unknown|other|misc|none|—|-|\?|music|various)$/i.test(s.trim())) out = (GENRE_RULES.find(([, re]) => re.test(s)) || [''])[0];
  genreMemo.set(k, out);
  return out;
}
const genreOf = t => broadGenre(t?.genre);

return { $, $$, uid, esc, norm, mainArtist, splitArtists, displayTitle, trackKey, albumKey, fmtTime, fmtDur, yearOf, debounce, sleep, on, emit, toast, jsonp, imageToDataURL, downloadBlob, packToString, unpackString, hashColor, broadGenre, genreOf };
})();
// ---------- ui.js ----------
const __m_ui = (() => {
// Reusable UI pieces: icons, rows, cards, menus, modals, toasts, filters.
const { esc, fmtDur, hashColor, $, on, mainArtist, yearOf, displayTitle, genreOf, emit } = __m_util;

const I = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  library: '<path d="M4 4v16M9 4v16M14 5l5 15"/>',
  import: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
  offline: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  minus: '<path d="M5 12h14"/>',
  google: '<circle cx="12" cy="12" r="10" fill="#fff" stroke="none"/><text x="12" y="16.6" text-anchor="middle" font-size="13.5" font-weight="800" font-family="Arial, Helvetica, sans-serif" fill="#4285F4" stroke="none">G</text>',
  discord: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5z" fill="currentColor" stroke="none"/><circle cx="9.5" cy="10" r="1.4" fill="#5865F2" stroke="none"/><circle cx="14.5" cy="10" r="1.4" fill="#5865F2" stroke="none"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  coffee: '<path d="M10 5c0-1.3.7-2 2-2h2.2c1.2 0 1.8-.6 1.8-1.8"/><path d="M6.4 8.4h11.4a1.9 1.9 0 0 1 1.9 1.9v3.5a7.6 7.4 0 0 1-15.2 0v-3.5a1.9 1.9 0 0 1 1.9-1.9z"/><path d="M19.7 10.4h1a1.7 1.7 0 0 1 1.7 1.7v.4c0 1.9-1.4 3.5-3.3 3.8"/><path d="M1.4 21.6h21.2"/>',
  instagram: '<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H8l1.3-2h5.4L16 6h1.5A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z"/><circle cx="12" cy="12.5" r="3.5"/>',
  xsocial: '<path d="M5 4l14 16M19 4L5 20" stroke-width="2.6"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  cloud: '<path d="M7 18a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  apple: '<path d="M16.4 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.8-.8-3-.8-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.3 0 2.1-1.1 2.8-2.3.9-1.3 1.3-2.6 1.3-2.6s-2.5-1-2.5-3.8zM14.2 5.8c.6-.8 1.1-1.9 1-3-.9 0-2.1.6-2.7 1.4-.6.7-1.1 1.8-1 2.9 1 .1 2.1-.5 2.7-1.3z" fill="currentColor" stroke="none"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/>',
  next: '<path d="M5 5l10 7-10 7z" fill="currentColor"/><path d="M19 5v14"/>',
  prev: '<path d="M19 5L9 12l10 7z" fill="currentColor"/><path d="M5 5v14"/>',
  shuffle: '<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  repeat: '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
  heartFill: '<path fill="currentColor" d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  queue: '<path d="M3 6h13M3 12h13M3 18h8"/><path d="M17 15v6l5-3z" fill="currentColor"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  video: '<rect x="2" y="5" width="15" height="14" rx="2"/><path d="M17 10l5-3v10l-5-3"/>',
  audio: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M17 9l5 6M22 9l-5 6"/>',
  yt: '<rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9v6l5-3z" fill="currentColor"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  sparkle: '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>',
  cloudOff: '<path d="M3 3l18 18M8 8a5 5 0 0 0-2 9.6h10M18 17.3A4 4 0 0 0 16.5 10a6 6 0 0 0-6.4-4.6"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  spotify: '<circle cx="12" cy="12" r="10"/><path d="M7 9.5c3.5-1 7-.7 10 1M7.5 12.8c3-.8 5.6-.5 8 .9M8 16c2.3-.5 4.3-.3 6 .7"/>',
  grip: '<circle cx="9" cy="7" r="1.2" fill="currentColor"/><circle cx="15" cy="7" r="1.2" fill="currentColor"/><circle cx="9" cy="12" r="1.2" fill="currentColor"/><circle cx="15" cy="12" r="1.2" fill="currentColor"/><circle cx="9" cy="17" r="1.2" fill="currentColor"/><circle cx="15" cy="17" r="1.2" fill="currentColor"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  shrink: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.6" r="1.3" fill="currentColor"/>',
  unlock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 7.6-1.7"/><circle cx="12" cy="15.6" r="1.3" fill="currentColor"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM18 18h3v3h-3zM18 14h3M14 18v3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.6 1.6M9.5 2.5h5M12 2.5V6M18.8 6.7l1.5-1.5"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  thumbUp: '<path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/><path d="M7 10l4-7a2.5 2.5 0 0 1 3 2.6L13.4 9H19a2 2 0 0 1 2 2.3l-1.3 8A2 2 0 0 1 17.7 21H7"/>',
  thumbDown: '<path d="M17 14V3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1z"/><path d="M17 14l-4 7a2.5 2.5 0 0 1-3-2.6l.6-3.4H5a2 2 0 0 1-2-2.3l1.3-8A2 2 0 0 1 6.3 3H17"/>',
  sad: '<circle cx="12" cy="12" r="10"/><path d="M8 16.5c1-1.4 2.4-2.1 4-2.1s3 .7 4 2.1"/><circle cx="8.8" cy="9.6" r="1.1" fill="currentColor"/><circle cx="15.2" cy="9.6" r="1.1" fill="currentColor"/>'
};
const icon = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n] || ''}</svg>`;

// ---------- Theme colour ----------
// One accent colour drives the whole app: buttons, glows, the logo bolt, the app icon and the wordmark shadow.
// The choice is mirrored to localStorage so index.html can paint the splash screen in it before the app loads.
const THEMES = [
  ['volt', 'Volt', [255, 214, 10]],
  ['mint', 'Mint', [16, 185, 129]], ['violet', 'Violet', [139, 61, 255]], ['indigo', 'Indigo', [99, 102, 241]],
  ['ocean', 'Ocean', [47, 128, 255]], ['cyan', 'Cyan', [6, 182, 212]], ['gold', 'Gold', [245, 180, 0]],
  ['sunset', 'Sunset', [255, 106, 43]], ['rose', 'Rose', [236, 72, 153]], ['crimson', 'Crimson', [239, 68, 68]]
];
let themeName = 'volt';
try { const t = localStorage.getItem('bz_theme'); if (THEMES.some(x => x[0] === t)) themeName = t; } catch { }
const currentTheme = () => themeName;
// Path of a logo/app icon in the current colour (the original yellow files are the "volt" set)
const logoSrc = (n = 'icon-192', name = themeName) => name === 'volt' ? `icons/${n}.png` : `icons/theme/${name}-${n}.png`;
function hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}
function rgbOf([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map(v => Math.round((v + m) * 255));
}
function themeVars(name) {
  const rgb = (THEMES.find(t => t[0] === name) || THEMES[0])[2];
  const [h, s, l] = hsl(rgb);
  const two = name === 'volt' ? [255, 149, 0] : rgbOf([(h - 18 + 360) % 360, Math.min(1, s * 1.05), l * 0.82]);
  const hi = rgbOf([h, s, Math.min(0.85, l + 0.12)]);
  const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
  return { '--volt': hex(rgb), '--volt-rgb': rgb.join(' '), '--volt-2': hex(two), '--volt-2-rgb': two.join(' '), '--volt-hi': hex(hi) };
}
function applyTheme(name) {
  if (!THEMES.some(t => t[0] === name)) name = 'volt';
  themeName = name;
  const vars = themeVars(name);
  try { localStorage.setItem('bz_theme', name); localStorage.setItem('bz_theme_vars', JSON.stringify(vars)); } catch { }
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.style.setProperty('--logo-url', `url("${new URL(logoSrc('icon-192'), location.href).href}")`);
  root.dataset.theme = name;
  // Every logo already on the page
  document.querySelectorAll('img').forEach(img => {
    const m = (img.getAttribute('src') || '').match(/^icons\/(?:theme\/[a-z]+-)?(icon-192|icon-512|app-192|app-512)\.png/);
    if (m) img.setAttribute('src', logoSrc(m[1]));
  });
  // Tab icon, Home Screen icon (iPhone reads it when you tap "Add to Home Screen") and the install manifest
  const set = (sel, href) => { const l = document.querySelector(sel); if (l) l.setAttribute('href', href); };
  set('link[rel="apple-touch-icon"]', logoSrc('apple-touch-icon') + '?v=4');
  set('link[rel="icon"][sizes="32x32"]', logoSrc('favicon-32'));
  set('link[rel="icon"][sizes="16x16"]', logoSrc('favicon-16'));
  set('link[rel="manifest"]', name === 'volt' ? 'manifest.webmanifest' : `icons/theme/manifest-${name}.webmanifest`);
  emit('theme', name);
}

// Ask image servers for the size we actually show (a 42px row thumbnail doesn't need a 1000px image)
function sized(src, px) {
  if (!src || src.startsWith('data:')) return src;
  const d = px <= 64 ? 120 : px <= 220 ? 300 : 600;
  return src
    .replace(/\/(\d+)x\1bb\./, `/${d}x${d}bb.`)                                   // Apple
    .replace(/\/(\d+)x\1-000000-80-0-0\.jpg$/, `/${Math.max(d, 250)}x${Math.max(d, 250)}-000000-80-0-0.jpg`) // Deezer
    .replace(/\/vi\/([\w-]{11})\/(hq|maxres|sd)default\.jpg$/, (m, id) => `/vi/${id}/${d <= 120 ? 'mqdefault' : 'hqdefault'}.jpg`); // YouTube
}
function cover(src, label, cls = '') {
  const px = /\bsm\b|qt-art|pb-art/.test(cls) ? 64 : /np-art|hero/.test(cls) ? 600 : 200;
  const eager = /hero|np-art|pb-art/.test(cls);
  if (src) return `<div class="cover ${cls}"><img src="${esc(sized(src, px))}" alt="" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" onerror="this.parentNode.classList.add('noimg');this.remove()"><span>${esc((label || '?')[0])}</span></div>`;
  return `<div class="cover noimg ${cls}" style="--c:${hashColor(label)}"><span>${esc((label || '?')[0].toUpperCase())}</span></div>`;
}

// One song row. `ctx` = {list, index, playlistId}
function trackRow(t, i, ctx = {}, playingId) {
  const isNow = false; // highlighting is done by markNow() so only ONE row lights up
  const main = t.artist || '';
  const artists = `<a href="#/artist/${encodeURIComponent(main)}" class="lnk">${esc(main)}</a>`;
  return `<div class="row ${isNow ? 'now' : ''} ${t.isVideo ? 'is-video' : ''}" data-act="play-row" data-list="${ctx.list}" data-i="${i}" data-id="${esc(t.id)}" role="button" tabindex="0">
    <div class="row-num">${isNow ? '<span class="eq"><i></i><i></i><i></i></span>' : (ctx.numbered ? (t.trackNumber || i + 1) : '')}${cover(t.artwork, t.title, t.isVideo ? 'sm wide' : 'sm')}</div>
    <div class="row-main">
      <div class="row-title"><span class="tt">${esc(displayTitle(t))}</span>${t.explicit ? '<span class="e">E</span>' : ''}${t.localFileId ? `<span class="off" title="Available offline">${icon('offline')}</span>` : ''}</div>
      <div class="row-sub">${artists}</div>
    </div>
    <div class="row-album hide-sm">${t.album ? `<a class="lnk" data-act="goto-album" data-id="${esc(t.id)}">${esc(t.album)}</a>` : ''}</div>
    <div class="row-meta hide-sm">${genreOf(t) ? `<span class="pill">${esc(genreOf(t))}</span>` : ''}${t.year || yearOf(t.releaseDate) || ''}</div>
    <button class="ib like ${t.liked ? 'on' : ''}" data-act="like" data-id="${esc(t.id)}" aria-label="Like">${icon(t.liked ? 'heartFill' : 'heart')}</button>
    <div class="row-dur hide-xs">${fmtDur(t.durationMs)}</div>
    <button class="ib" data-act="track-menu" data-id="${esc(t.id)}" data-pl="${ctx.playlistId || ''}" aria-label="More">${icon('more')}</button>
  </div>`;
}

function card({ href, img, title, sub, round = false, act = '', id = '' }) {
  return `<a class="card" href="${href}">
    <div class="card-art ${round ? 'round' : ''}">${cover(img, title)}${act ? `<button class="fab-play" data-act="${act}" data-id="${esc(id)}" aria-label="Play">${icon('play')}</button>` : ''}</div>
    <div class="card-t">${esc(title)}</div><div class="card-s">${esc(sub || '')}</div></a>`;
}

// ---------- Toasts ----------
on('toast', ({ msg, kind, action, ms }) => {
  const root = $('#toasts'); if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind + (action ? ' has-act' : '');
  const txt = document.createElement('span'); txt.textContent = msg; el.appendChild(txt);
  const life = ms || (action ? 6500 : 3200);
  let t1, t2;
  const bye = () => { el.classList.add('out'); setTimeout(() => el.remove(), 350); };
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-act'; b.type = 'button'; b.textContent = action.label || 'Undo';
    b.onclick = () => { clearTimeout(t1); clearTimeout(t2); bye(); try { action.fn(); } catch (e) { console.warn(e); } };
    el.appendChild(b);
  }
  root.appendChild(el);
  t1 = setTimeout(bye, life);
});
// A toast with an "Undo" (or other) button
const toastUndo = (msg, fn, label = 'Undo') => emit('toast', { msg, kind: 'info', action: { label, fn } });

// ---------- Modal ----------
function modal(html, { wide = false, onMount, locked = false, ownForms = false } = {}) {
  return new Promise(resolve => {
    const root = $('#modal-root');
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${locked ? '' : `<button class="ib modal-x" data-close aria-label="Close">${icon('close')}</button>`}${html}</div>`;
    root.appendChild(wrap);
    const close = v => { wrap.classList.add('out'); setTimeout(() => wrap.remove(), 180); document.removeEventListener('keydown', key); resolve(v); };
    const key = e => { if (e.key === 'Escape' && !locked) close(null); };
    document.addEventListener('keydown', key);
    wrap.addEventListener('click', e => {
      if ((e.target === wrap && !locked) || e.target.closest('[data-close]')) close(null);
      const r = e.target.closest('[data-resolve]');
      if (r) close(r.dataset.resolve);
    });
    if (!ownForms) wrap.querySelector('form')?.addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(e.target), o = {};
      for (const k of new Set(fd.keys())) { const v = fd.getAll(k); o[k] = v.length > 1 ? v : v[0]; }
      close(o);
    });
    onMount?.(wrap.querySelector('.modal'), close);
    setTimeout(() => wrap.querySelector('input:not([type=file]),button.primary')?.focus(), 50);
  });
}
async function promptText(title, value = '', label = 'Name', okText = 'Save') {
  const r = await modal(`<h3>${esc(title)}</h3><form><label class="fld"><span>${esc(label)}</span><input name="v" value="${esc(value)}" required maxlength="100"></label>
    <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">${esc(okText)}</button></div></form>`);
  return r ? r.v.trim() : null;
}
async function confirmBox(title, body, okText = 'Confirm', danger = false) {
  const r = await modal(`<h3>${esc(title)}</h3><p class="muted">${body}</p>
    <div class="modal-actions"><button class="btn ghost" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-resolve="ok">${esc(okText)}</button></div>`);
  return r === 'ok';
}

// ---------- Popup menu (bottom sheet on phones) ----------
function menu(anchor, items) {
  closeMenu();
  const root = $('#menu-root');
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = items.filter(Boolean).map(it => it === '-' ? '<hr>' :
    it.header ? `<div class="menu-h">${it.header}</div>` :
    `<button data-k="${it.k}" class="${it.danger ? 'danger' : ''}">${icon(it.icon || 'plus')}<span>${esc(it.label)}</span></button>`).join('');
  const back = document.createElement('div'); back.className = 'menu-back';
  root.append(back, m);
  const mobile = innerWidth < 700;
  if (mobile) { m.classList.add('sheet'); m.insertAdjacentHTML('afterbegin', '<div class="sheet-grab" aria-hidden="true"></div>'); }
  else {
    const r = anchor.getBoundingClientRect();
    const mw = 260, mh = Math.min(m.scrollHeight, innerHeight - 20);
    m.style.left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8)) + 'px';
    m.style.top = (r.bottom + mh + 8 > innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
  }
  return new Promise(resolve => {
    m.addEventListener('click', e => { const b = e.target.closest('button[data-k]'); if (b) { closeMenu(); resolve(b.dataset.k); } });
    back.addEventListener('click', () => { closeMenu(); resolve(null); });
    // Phones: pull the sheet down to close it (from the handle, or anywhere once its list is scrolled to the top)
    if (mobile) {
      let y0 = null, dy = 0, t0 = 0, on = false;
      const close = () => { m.style.transition = 'transform .18s ease-in'; m.style.transform = 'translateY(110%)'; back.style.opacity = '0'; setTimeout(() => { closeMenu(); resolve(null); }, 170); };
      m.addEventListener('touchstart', e => { if (e.touches.length !== 1) return; y0 = e.touches[0].clientY; dy = 0; t0 = Date.now(); on = false; m.style.transition = 'none'; }, { passive: true });
      m.addEventListener('touchmove', e => {
        if (y0 === null) return;
        dy = e.touches[0].clientY - y0;
        if (!on) { if (dy > 6 && (m.scrollTop <= 0 || e.target.closest('.sheet-grab'))) on = true; else if (dy < -6) { y0 = null; return; } else return; }
        if (e.cancelable) e.preventDefault();
        m.style.transform = `translateY(${Math.max(0, dy)}px)`;
        back.style.opacity = String(Math.max(0.2, 1 - dy / 400));
      }, { passive: false });
      m.addEventListener('touchend', () => {
        if (y0 === null) return; y0 = null;
        if (!on) return;
        const v = dy / Math.max(1, Date.now() - t0);
        if (dy > 90 || (dy > 30 && v > 0.5)) close();
        else { m.style.transition = 'transform .2s cubic-bezier(.2,.8,.2,1)'; m.style.transform = ''; back.style.opacity = ''; }
      }, { passive: true });
    }
  });
}
function closeMenu() { const r = $('#menu-root'); if (r) r.innerHTML = ''; }

// ---------- Filters (genre + release date + sort + text) ----------
function applyFilters(list, f) {
  let out = list;
  if (f.q) {
    const q = f.q.toLowerCase();
    out = out.filter(t => (t.title + ' ' + t.artist + ' ' + (t.album || '')).toLowerCase().includes(q));
  }
  if (f.genres?.length) out = out.filter(t => f.genres.includes(genreOf(t)));
  const y = t => t.year || yearOf(t.releaseDate);
  if (f.years?.length) out = out.filter(t => f.years.includes(y(t)));
  if (f.liked) out = out.filter(t => t.liked);
  if (f.offline) out = out.filter(t => t.localFileId);
  const by = {
    added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    liked: (a, b) => (b.likedAt || b.addedAt || 0) - (a.likedAt || a.addedAt || 0),
    title: (a, b) => a.title.localeCompare(b.title),
    artist: (a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title),
    newest: (a, b) => (b.releaseDate || String(y(b) || '')).localeCompare(a.releaseDate || String(y(a) || '')),
    oldest: (a, b) => (y(a) || 9999) - (y(b) || 9999) || (a.releaseDate || '').localeCompare(b.releaseDate || ''),
    album: (a, b) => (a.album || '').localeCompare(b.album || '') || (a.trackNumber || 0) - (b.trackNumber || 0)
  }[f.sort];
  if (by) out = [...out].sort(by);
  return out;
}

function filterBar(f, tracks, { showSort = true, keepOrder = false, likedSort = false } = {}) {
  // Top 10 broad genres in this list (never "Unknown"), plus any you already picked
  const gm = new Map();
  for (const t of tracks) { const g = genreOf(t); if (g) gm.set(g, (gm.get(g) || 0) + 1); }
  let genres = [...gm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const g of f.genres || []) if (!genres.some(x => x[0] === g)) genres.push([g, gm.get(g) || 0]);
  // Every year in the list, newest first — tap as many as you like
  const ym = new Map();
  for (const t of tracks) { const y = t.year || yearOf(t.releaseDate); if (y) ym.set(y, (ym.get(y) || 0) + 1); }
  const years = [...ym.entries()].sort((a, b) => b[0] - a[0]);
  const active = (f.genres?.length || 0) + (f.years?.length || 0) + (f.liked ? 1 : 0) + (f.offline ? 1 : 0);
  // Sort options open as an on-screen panel, just like Filters (no system picker)
  const sortOpts = [...(keepOrder ? [['', 'Custom order']] : []), ...(likedSort ? [['liked', 'Recently liked']] : []),
    ['added', 'Recently added'], ['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['newest', 'Year: newest'], ['oldest', 'Year: oldest']];
  const curSort = sortOpts.find(([v]) => v === (f.sort || '')) || sortOpts.find(([v]) => v === 'added');
  return `<div class="filters">
    <div class="filter-top">
      <div class="fsearch"><label class="searchbox sm">${icon('search')}<input data-f="q" placeholder="Filter songs" value="${esc(f.q || '')}" enterkeyhint="search" aria-label="Filter songs"></label>
        <button class="round-search" data-act="filter-go" aria-label="Search these songs" title="Search">${icon('search')}</button></div>
      <div class="fctl"><button class="chip ${f.open ? 'on' : ''}" data-act="toggle-filters">${icon('filter')}Filters${active ? ` <b>${active}</b>` : ''}</button>
      ${showSort ? `<button class="chip sort-chip ${f.sortOpen ? 'on' : ''}" data-act="toggle-sort" aria-expanded="${!!f.sortOpen}" aria-label="Sort: ${esc(curSort[1])}"><span class="sort-lbl">${esc(curSort[1])}</span>${icon('down')}</button>` : ''}</div>
    </div>
    ${showSort && f.sortOpen ? `<div class="filter-panel sort-panel"><div class="fp-sec"><div class="fp-h">Sort by</div><div class="chips">
      ${sortOpts.map(([v, l]) => `<button class="chip ${curSort[0] === v ? 'on' : ''}" data-act="f-sort" data-v="${v}" aria-pressed="${curSort[0] === v}">${curSort[0] === v ? icon('check') : ''}${esc(l)}</button>`).join('')}
    </div></div></div>` : ''}
    ${f.open ? `<div class="filter-panel">
      <div class="fp-sec"><div class="fp-h">Top genres</div><div class="chips">
        ${genres.length ? genres.map(([g, n]) => `<button class="chip ${f.genres?.includes(g) ? 'on' : ''}" data-act="f-genre" data-g="${esc(g)}">${esc(g)} <small>${n}</small></button>`).join('') : '<span class="muted">Genres appear as songs get matched.</span>'}
      </div></div>
      ${years.length ? `<div class="fp-sec"><div class="fp-h">Year <span class="fp-note">pick one or more</span></div>
        <div class="chips years-chips">${years.map(([y, n]) => `<button class="chip ${f.years?.includes(y) ? 'on' : ''}" data-act="f-year" data-y="${y}" aria-pressed="${!!f.years?.includes(y)}">${y} <small>${n}</small></button>`).join('')}</div>
      </div>` : ''}
      <div class="fp-sec"><div class="chips">
        <button class="chip ${f.liked ? 'on' : ''}" data-act="f-flag" data-k="liked">${icon('heart')}Liked only</button>
        <button class="chip ${f.offline ? 'on' : ''}" data-act="f-flag" data-k="offline">${icon('offline')}Offline only</button>
        ${active ? '<button class="chip ghost" data-act="f-clear">Clear all</button>' : ''}
      </div></div>
    </div>` : ''}
  </div>`;
}

function empty(title, body, cta = '') {
  return `<div class="empty"><img src="${logoSrc()}" alt="" class="empty-bolt"><h3>${title}</h3><p class="muted">${body}</p>${cta}</div>`;
}

// Liked Songs cover: a proper, full-size heart
const likedCover = (cls = '') => `<div class="cover liked-cover heart-cover ${cls}">${icon('heartFill')}</div>`;

// Big, centered, animated loader
function loader(text = '', cls = '') {
  return `<div class="bz-loader ${cls}" role="status" aria-live="polite"><div class="bz-orb"><span></span><span></span><span></span><img src="${logoSrc()}" alt=""></div>${text ? `<p>${esc(text)}</p>` : ''}</div>`;
}

return { icon, THEMES, currentTheme, logoSrc, themeVars, applyTheme, sized, cover, trackRow, card, toastUndo, modal, promptText, confirmBox, menu, closeMenu, applyFilters, filterBar, empty, likedCover, loader };
})();
// ---------- meta.js ----------
const __m_meta = (() => {
// Music metadata (genre, release date, artwork, albums, artists) from Apple's free
// iTunes Search API, plus Deezer's free API as a fallback for cover art and
// artist photos. No keys, no accounts.
//
// Speed + safety:
//  • Every answer is cached on the device (memory + IndexedDB), so repeat visits cost 0 requests.
//  • A token bucket keeps us under Apple's ~20 requests/minute guideline, so the user's IP never
//    gets blocked. Things the user is waiting for (search, opening an album) always jump ahead of
//    background work (filling in genres), and background work leaves headroom for them.
//  • Identical requests in flight are shared, never sent twice.
const { jsonp, norm, mainArtist, albumKey, trackKey, yearOf, sleep } = __m_util;
const { db } = __m_db;

const BASE = 'https://itunes.apple.com';
let country = 'US';
const setCountry = c => { country = (c || 'US').toUpperCase(); };

// ---------- persistent cache ----------
const mem = new Map();
const DAY = 864e5;
async function cached(key, ttl, fn) {
  const m = mem.get(key);
  if (m && (m.p || Date.now() - m.t < ttl)) return m.p || m.v;
  try {
    const hit = await db.get('metacache', key);
    if (hit && Date.now() - hit.t < ttl) { mem.set(key, { v: hit.v, t: hit.t }); return hit.v; }
  } catch { }
  const p = fn().then(v => {
    mem.set(key, { v, t: Date.now() });
    db.put('metacache', { v, t: Date.now() }, key).catch(() => { });
    return v;
  }, e => { mem.delete(key); throw e; });
  mem.set(key, { p });
  return p;
}
// Drop cache entries older than 30 days, once per start, when idle
setTimeout(async () => {
  try {
    const keys = await db.keys('metacache'), vals = await db.all('metacache');
    keys.forEach((k, i) => { if (Date.now() - (vals[i]?.t || 0) > 30 * DAY) db.del('metacache', k); });
  } catch { }
}, 20000);

// ---------- iTunes rate limiter (token bucket with priorities) ----------
const CAP = 9, REFILL_MS = 3000, BG_RESERVE = 4;
let tokens = CAP, lastRefill = Date.now(), pausedUntil = 0, fgPausedUntil = 0; // background back-off never blocks what you're waiting for for long
const waiting = [[], []]; // [foreground, background]
let pumping = false;
function refill() {
  const n = Math.floor((Date.now() - lastRefill) / REFILL_MS);
  if (n > 0) { tokens = Math.min(CAP, tokens + n); lastRefill += n * REFILL_MS; }
}
async function pump() {
  if (pumping) return; pumping = true;
  while (waiting[0].length || waiting[1].length) {
    refill();
    const now = Date.now();
    if (waiting[0].length) {
      if (now < fgPausedUntil) { await sleep(Math.min(fgPausedUntil - now, 1500)); continue; }
      if (tokens >= 1 || now - lastRefill > REFILL_MS) { tokens = Math.max(0, tokens - 1); waiting[0].shift()(); continue; }
    }
    if (now < pausedUntil) { await sleep(Math.min(pausedUntil - now, 1000)); continue; }
    if (!waiting[0].length && waiting[1].length && tokens > BG_RESERVE) { tokens--; waiting[1].shift()(); continue; }
    await sleep(Math.max(80, lastRefill + REFILL_MS - Date.now()));
  }
  pumping = false;
}
const slot = (bg) => new Promise(r => { waiting[bg ? 1 : 0].push(r); pump(); });
const backgroundBusy = () => waiting[1].length;

async function call(path, params, { bg = false, ttl = DAY } = {}) {
  const q = new URLSearchParams({ ...params, country }).toString();
  const url = `${BASE}/${path}?${q}`;
  return cached('it:' + url, ttl, async () => {
    // Things you're waiting for: 2 quick tries. Background work: 3 patient tries.
    const tries = bg ? 3 : 2;
    for (let attempt = 0; attempt < tries; attempt++) {
      await slot(bg);
      try { return (await jsonp(url, bg ? 10000 : 7000)).results || []; }
      catch (e) {
        // Apple answers rate-limited requests with an error page: back off (background much longer)
        pausedUntil = Math.max(pausedUntil, Date.now() + 15000 * (attempt + 1));
        if (!bg) fgPausedUntil = Date.now() + 2500;
        tokens = 0;
        if (attempt === tries - 1 || !navigator.onLine) throw e;
      }
    }
  });
}

// ---------- Deezer (covers + artist photos; generous limits, still spaced politely) ----------
let dzLast = 0;
async function deezer(path, params, ttl = 7 * DAY, urgent = false) {
  const url = `https://api.deezer.com/${path}?${new URLSearchParams({ ...params, output: 'jsonp' })}`;
  return cached('dz:' + url, ttl, async () => {
    // Background lookups are paced; something you're looking at right now skips the line.
    if (!urgent) {
      const wait = dzLast + 150 - Date.now(); dzLast = Math.max(Date.now(), dzLast + 150);
      if (wait > 0) await sleep(wait);
    }
    const d = await jsonp(url, 8000);
    if (d?.error) throw new Error(d.error.message || 'Deezer error');
    return d?.data || [];
  });
}
// Deezer as a fast second source for search and artist top songs
function songFromDeezer(r) {
  const title = r.title_short || r.title || '', artist = r.artist?.name || '';
  return {
    id: trackKey(artist, title), title, artist, artists: [artist],
    album: r.album?.title || '', albumId: r.album?.title ? albumKey(artist, r.album.title) : '',
    durationMs: (r.duration || 0) * 1000, artwork: r.album?.cover_xl || r.album?.cover_big || '',
    explicit: !!r.explicit_lyrics, deezerId: r.id || null
  };
}
async function deezerSearchSongs(q, limit = 20) { return (await deezer('search', { q, limit }, DAY)).filter(r => r.type === 'track' || r.title).map(songFromDeezer); }
async function deezerSearchArtists(q, limit = 8) { return (await deezer('search/artist', { q, limit }, DAY)).map(a => ({ name: a.name, itunesArtistId: null, genre: '', picture: a.picture_xl || a.picture_big || '' })); }
async function deezerArtistTop(name, limit = 10) {
  const res = await deezer('search/artist', { q: mainArtist(name), limit: 5 }, 14 * DAY, true);
  const k = norm(mainArtist(name));
  const a = res.find(r => norm(r.name) === k) || res[0];
  if (!a) return [];
  return (await deezer(`artist/${a.id}/top`, { limit }, DAY, true)).map(songFromDeezer);
}
// ---------- BAZINGA! mix helpers (Deezer: fast, no key) ----------
// Deezer's own genre list, matched to BAZINGA!'s broad genres by name
const DZ_GENRE = { 'Hip-Hop/Rap': /rap|hip/i, 'R&B': /r&b|rnb/i, Soul: /soul|funk/i, Afrobeats: /africa/i, Latin: /latin/i, Reggae: /reggae/i, Pop: /^pop$/i,
  Rock: /^rock$/i, Electronic: /electro|dance/i, Country: /country/i, Jazz: /jazz/i, Blues: /blues/i, Classical: /classical/i, Metal: /metal/i,
  Folk: /folk/i, Gospel: /christ|gospel/i, 'K-Pop': /asia|k-?pop/i, Soundtrack: /film|game/i, Kids: /kid/i, World: /world|arab|indian|brazil/i };
async function deezerGenreId(name) {
  const re = DZ_GENRE[name]; if (!re) return null;
  const list = await deezer('genre', {}, 30 * DAY, true).catch(() => []);
  return list.find(g => g.id && re.test(g.name))?.id ?? null;
}
// Top songs in a genre right now
async function deezerGenreTop(name, limit = 40) {
  const id = await deezerGenreId(name); if (id == null) return [];
  return (await deezer(`chart/${id}/tracks`, { limit }, DAY, true).catch(() => [])).map(songFromDeezer);
}
// Most popular artists in a genre (for the "pick your favourites" prompt)
async function deezerGenreArtists(name, limit = 10) {
  const id = await deezerGenreId(name); if (id == null) return [];
  let res = await deezer(`chart/${id}/artists`, { limit }, 3 * DAY, true).catch(() => []);
  if (!res.length) res = await deezer(`genre/${id}/artists`, {}, 3 * DAY, true).catch(() => []);
  return res.slice(0, limit).map(a => ({ name: a.name, picture: a.picture_xl || a.picture_big || a.picture_medium || '' }));
}
async function deezerCover(t) {
  const q = `artist:"${mainArtist(t.artist)}" track:"${String(t.title).replace(/\s*[\(\[].*?[\)\]]/g, '')}"`;
  let res = await deezer('search', { q, limit: 5 });
  if (!res.length) res = await deezer('search', { q: `${mainArtist(t.artist)} ${t.title}`, limit: 5 });
  const na = norm(mainArtist(t.artist));
  const hit = res.find(r => norm(r.artist?.name).includes(na) || na.includes(norm(r.artist?.name))) || null;
  return hit ? { artwork: hit.album?.cover_xl || hit.album?.cover_big || '', album: hit.album?.title || '', durationMs: (hit.duration || 0) * 1000 } : null;
}
// Artist photos: remembered on the device (instant on every later visit), looked up from Deezer once.
const picMem = new Map();
let picStore = {};
try { picStore = JSON.parse(localStorage.getItem('bz_apic') || '{}') || {}; } catch { }
const savePics = (() => { let t; return () => { clearTimeout(t); t = setTimeout(() => { try { localStorage.setItem('bz_apic', JSON.stringify(picStore)); } catch { } }, 800); }; })();
// Known photo for this artist right now (no waiting), or '' / undefined if not looked up yet
function artistPictureNow(name) { const k = norm(name); return k ? picStore[k] : ''; }
async function artistPicture(name, urgent = false) {
  const k = norm(name); if (!k) return '';
  if (typeof picStore[k] === 'string' && picStore[k]) return picStore[k];
  if (picMem.has(k)) return picMem.get(k);
  const p = deezer('search/artist', { q: mainArtist(name), limit: 3 }, 14 * DAY, urgent).then(res => {
    const a = res.find(r => norm(r.name) === k) || res[0];
    let pic = a?.picture_xl || a?.picture_big || '';
    if (/\/artist\/\/|images\/artist\/?$/.test(pic)) pic = ''; // Deezer's blank placeholder
    if (pic) { picStore[k] = pic; savePics(); }
    return pic;
  }).catch(() => { picMem.delete(k); return ''; });
  picMem.set(k, p);
  return p;
}

// ---------- iTunes helpers ----------
const art = (u, size = 600) => u ? u.replace(/\/\d+x\d+(bb)?\./, `/${size}x${size}bb.`) : '';

function songFromItunes(r) {
  return {
    id: trackKey(r.artistName, r.trackName),
    title: r.trackName,
    artist: r.artistName,
    album: r.collectionName || '',
    albumId: r.collectionName ? albumKey(r.collectionArtistName || r.artistName, r.collectionName) : '',
    itunesAlbumId: r.collectionId || null,
    itunesArtistId: r.artistId || null,
    itunesId: r.trackId || null,
    trackNumber: r.trackNumber || 0,
    discNumber: r.discNumber || 1,
    genre: r.primaryGenreName || '',
    releaseDate: r.releaseDate ? r.releaseDate.slice(0, 10) : '',
    year: yearOf(r.releaseDate),
    durationMs: r.trackTimeMillis || 0,
    artwork: art(r.artworkUrl100),
    explicit: r.trackExplicitness === 'explicit',
    enriched: true
  };
}
function albumFromItunes(r) {
  return {
    id: albumKey(r.artistName, r.collectionName),
    title: r.collectionName,
    artist: r.artistName,
    itunesAlbumId: r.collectionId,
    itunesArtistId: r.artistId || null,
    genre: r.primaryGenreName || '',
    releaseDate: r.releaseDate ? r.releaseDate.slice(0, 10) : '',
    year: yearOf(r.releaseDate),
    trackCount: r.trackCount || 0,
    artwork: art(r.artworkUrl100)
  };
}

async function searchSongs(term, limit = 25, o) {
  return (await call('search', { term, media: 'music', entity: 'song', limit }, o)).filter(r => r.kind === 'song').map(songFromItunes);
}
async function searchAlbums(term, limit = 25, o) {
  return (await call('search', { term, media: 'music', entity: 'album', limit }, o)).filter(r => r.collectionType === 'Album').map(albumFromItunes);
}
async function searchArtists(term, limit = 10, o) {
  return (await call('search', { term, media: 'music', entity: 'musicArtist', limit }, o))
    .map(r => ({ name: r.artistName, itunesArtistId: r.artistId, genre: r.primaryGenreName || '' }));
}

async function albumTracks(itunesAlbumId) {
  const res = await call('lookup', { id: itunesAlbumId, entity: 'song', limit: 200 }, { ttl: 14 * DAY });
  const album = res.find(r => r.wrapperType === 'collection');
  const songs = res.filter(r => r.wrapperType === 'track' && r.kind === 'song').map(songFromItunes)
    .sort((a, b) => (a.discNumber - b.discNumber) || (a.trackNumber - b.trackNumber));
  return { album: album ? albumFromItunes(album) : null, tracks: songs };
}

async function artistAlbums(itunesArtistId, o) {
  const res = await call('lookup', { id: itunesArtistId, entity: 'album', limit: 200 }, { ttl: 3 * DAY, ...o });
  const seen = new Set();
  return res.filter(r => r.wrapperType === 'collection' && r.collectionType === 'Album').map((r, i) => ({ ...albumFromItunes(r), rank: i })) // rank = Apple's own order (roughly most popular first)
    .filter(a => { const k = norm(a.title); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
}
async function artistTopSongs(itunesArtistId) {
  const res = await call('lookup', { id: itunesArtistId, entity: 'song', limit: 25 }, { ttl: 3 * DAY });
  return res.filter(r => r.wrapperType === 'track').map(songFromItunes);
}
// Newest releases (albums, EPs and singles) for an artist
async function artistLatest(itunesArtistId, o) {
  const res = await call('lookup', { id: itunesArtistId, entity: 'album', sort: 'recent', limit: 6 }, { ttl: DAY / 2, ...o });
  return res.filter(r => r.wrapperType === 'collection').map(albumFromItunes);
}
async function findArtistId(name, o) {
  const res = await searchArtists(mainArtist(name), 5, { ttl: 30 * DAY, ...o });
  const n = norm(mainArtist(name));
  return (res.find(a => norm(a.name) === n) || res[0])?.itunesArtistId || null;
}

// Best iTunes match for a song we only know by name (fills genre/date/artwork/album)
async function matchTrack(t, o = { bg: true }) {
  const res = await searchSongs(`${mainArtist(t.artist)} ${t.title}`, 10, { ttl: 30 * DAY, ...o });
  const nt = norm(t.title), na = norm(mainArtist(t.artist));
  let best = null, bestScore = 0;
  for (const r of res) {
    let s = 0;
    if (norm(r.title) === nt) s += 5; else if (norm(r.title).includes(nt) || nt.includes(norm(r.title))) s += 2;
    if (norm(mainArtist(r.artist)) === na) s += 4; else if (norm(r.artist).includes(na)) s += 2;
    if (t.album && norm(r.album) === norm(t.album)) s += 2;
    if (t.durationMs && r.durationMs && Math.abs(t.durationMs - r.durationMs) < 4000) s += 1;
    if (s > bestScore) { bestScore = s; best = r; }
  }
  return bestScore >= 6 ? best : null;
}

async function findAlbum(artist, title) {
  const res = await searchAlbums(`${mainArtist(artist)} ${title}`, 10, { ttl: 14 * DAY });
  const nt = norm(title), na = norm(mainArtist(artist));
  return res.find(a => norm(a.title) === nt && norm(a.artist).includes(na))
      || res.find(a => norm(a.title).includes(nt) && norm(a.artist).includes(na))
      || null;
}

// Helpers: give up after a while; take the first source that comes back with something
const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]);
function firstFull(list) {
  return new Promise(resolve => {
    let left = list.length, best = [];
    for (const p of list) Promise.resolve(p).then(v => { if (v?.length) resolve(v); else if (!--left) resolve(best); }, () => { if (!--left) resolve(best); });
  });
}

return { setCountry, backgroundBusy, deezerSearchSongs, deezerSearchArtists, deezerArtistTop, deezerGenreId, deezerGenreTop, deezerGenreArtists, deezerCover, artistPictureNow, artistPicture, art, songFromItunes, albumFromItunes, searchSongs, searchAlbums, searchArtists, albumTracks, artistAlbums, artistTopSongs, artistLatest, findArtistId, matchTrack, findAlbum, withTimeout, firstFull };
})();
// ---------- store.js ----------
const __m_store = (() => {
// The user's library, kept in memory and mirrored to IndexedDB.
const { db, kv } = __m_db;
const { uid, emit, debounce, norm, mainArtist, albumKey, trackKey, splitArtists, genreOf } = __m_util;
const meta = __m_meta;

const lib = {
  tracks: new Map(),
  albums: new Map(),
  playlists: new Map()
};

const changed = debounce(() => emit('library'), 120);
const notify = (why = 'change') => { changed(); emit('dirty', why); };

// ---- deletion markers, used when syncing between devices ----
let tomb = { t: {}, p: {}, a: {} };
const tombstones = () => tomb;
async function markDeleted(kind, id) { tomb[kind][id] = Date.now(); await kv.set('tombstones', tomb); }
async function setTombstones(t) { tomb = t; await kv.set('tombstones', tomb); }

async function load() {
  tomb = (await kv.get('tombstones')) || { t: {}, p: {}, a: {} };
  const old = Date.now() - 120 * 864e5;
  for (const k of ['t', 'p', 'a']) for (const [id, ts] of Object.entries(tomb[k] || {})) if (ts < old) delete tomb[k][id];
  const [t, a, p] = await Promise.all([db.all('tracks'), db.all('albums'), db.all('playlists')]);
  lib.tracks = new Map(t.map(x => [x.id, x]));
  lib.albums = new Map(a.map(x => [x.id, x]));
  lib.playlists = new Map(p.map(x => [x.id, x]));
  await migrateArtists();
  // Liked songs from before "recently liked" ordering existed: use when they were added
  const fix = [];
  for (const t of lib.tracks.values()) if (t.liked && !t.likedAt) { t.likedAt = t.addedAt || 1; fix.push(t); }
  if (fix.length) await db.putMany('tracks', fix);
}

// Older imports stored "Rich Gang;Lil Wayne;Birdman" as one artist. Split them:
// main artist stays as the artist, the rest become featured artists.
async function migrateArtists() {
  const remap = new Map(), changed = [];
  for (const t of [...lib.tracks.values()]) {
    let artists;
    if (t.artist?.includes(';')) artists = splitArtists(t.artist);                       // "A;B;C"
    else if (t.artists?.length > 1 && t.artist !== t.artists[0]) artists = t.artists;  // "A, B" + [A, B]
    else if (!t.artists?.length) artists = [t.artist];
    else continue;
    t.artists = artists; t.artist = artists[0] || t.artist;
    const nid = trackKey(t.artist, t.title);
    if (nid !== t.id) remap.set(t.id, nid);
    changed.push(t);
  }
  if (!changed.length) return;
  for (const [oldId, nid] of remap) {
    const t = lib.tracks.get(oldId);
    lib.tracks.delete(oldId); await db.del('tracks', oldId);
    const ex = lib.tracks.get(nid);
    if (ex) { if (t.liked) ex.liked = true; if (!ex.localFileId && t.localFileId) ex.localFileId = t.localFileId; await db.put('tracks', ex); }
    else { t.id = nid; lib.tracks.set(nid, t); }
    const c = await db.get('ytcache', oldId);
    if (c) { if (!(await db.get('ytcache', nid))) await db.put('ytcache', c, nid); await db.del('ytcache', oldId); }
  }
  const fix = ids => [...new Set(ids.map(i => remap.get(i) || i))];
  for (const p of lib.playlists.values()) if (p.trackIds.some(i => remap.has(i))) { p.trackIds = fix(p.trackIds); await db.put('playlists', p); }
  for (const a of lib.albums.values()) if (a.trackIds?.some(i => remap.has(i))) { a.trackIds = fix(a.trackIds); await db.put('albums', a); }
  await db.putMany('tracks', changed.filter(t => lib.tracks.get(t.id) === t));
  emit('dirty', 'migrate');
}

// Merge incoming tracks into the library, never throwing away data we already have.
async function upsertTracks(list, extra = {}) {
  const out = [];
  for (const n of list) {
    const old = lib.tracks.get(n.id);
    const merged = old ? { ...old } : { addedAt: Date.now() };
    for (const [k, v] of Object.entries(n)) {
      if (v !== undefined && v !== null && v !== '' && !(k === 'addedAt' && old)) merged[k] = v;
    }
    Object.assign(merged, extra);
    if (old?.liked && !old.transient) { merged.liked = true; merged.likedAt = old.likedAt || merged.likedAt; merged.likeTs = old.likeTs; }
    else if (extra.liked || (n.liked && !old?.liked)) merged.likeTs = Date.now();
    merged.updatedAt = Date.now();
    if (tomb.t[merged.id]) { delete tomb.t[merged.id]; kv.set('tombstones', tomb); }
    if (merged.liked && !merged.likedAt) merged.likedAt = extra.liked && n.addedAt && !old ? n.addedAt : Date.now();
    delete merged.transient;
    lib.tracks.set(merged.id, merged);
    out.push(merged);
  }
  await db.putMany('tracks', out);
  notify('tracks');
  queueEnrich(out);
  return out;
}

// Keep a track in memory only (e.g. playing a search result) until the user saves it.
function remember(t) {
  if (!lib.tracks.has(t.id)) lib.tracks.set(t.id, { ...t, transient: true });
  return lib.tracks.get(t.id);
}
const saved = () => [...lib.tracks.values()].filter(t => !t.transient);

async function updateTrack(id, patch, { quiet = false } = {}) {
  const t = lib.tracks.get(id); if (!t) return;
  if (patch.liked && !t.liked) patch = { likedAt: Date.now(), ...patch };
  if ('liked' in patch && !!patch.liked !== !!t.liked) patch.likeTs = Date.now();
  patch.updatedAt = Date.now();
  if (t.transient) { Object.assign(t, patch); await upsertTracks([t]); return; }
  Object.assign(t, patch);
  if (quiet) { emit('dirty', 'track'); await db.put('tracks', t); return; }
  await db.put('tracks', t);
  notify('track');
}

// Likes update the screen in place (no page re-render), so the heart reacts instantly
async function setLiked(id, on) {
  const t = lib.tracks.get(id); if (!t) return;
  if (t.transient) { if (on) { await upsertTracks([{ ...t, liked: true, likedAt: Date.now() }], {}); emit('like', { id, liked: true }); } return !!on; }
  if (!!t.liked === !!on) return !!on;
  const p = updateTrack(id, on ? { liked: true, likedAt: Date.now() } : { liked: false, likedAt: null }, { quiet: true });
  emit('like', { id, liked: !!on });
  await p;
  return !!on;
}
async function toggleLike(id) {
  const t = lib.tracks.get(id); if (!t) return;
  return setLiked(id, !(t.liked && !t.transient));
}

function isReferenced(id) {
  const t = lib.tracks.get(id);
  if (!t) return false;
  if (t.liked || t.localFileId) return true;
  for (const p of lib.playlists.values()) if (p.trackIds.includes(id)) return true;
  for (const a of lib.albums.values()) if (a.trackIds?.includes(id)) return true;
  return false;
}
async function gc(ids) {
  for (const id of ids) if (!isReferenced(id)) { lib.tracks.delete(id); await db.del('tracks', id); await markDeleted('t', id); }
}

async function deleteTrack(id) {
  const t = lib.tracks.get(id);
  if (t?.localFileId) await db.del('files', t.localFileId);
  for (const p of lib.playlists.values()) {
    if (p.trackIds.includes(id)) { p.trackIds = p.trackIds.filter(x => x !== id); await db.put('playlists', p); }
  }
  for (const a of lib.albums.values()) {
    if (a.trackIds?.includes(id)) { a.trackIds = a.trackIds.filter(x => x !== id); await db.put('albums', a); }
  }
  lib.tracks.delete(id); await db.del('tracks', id);
  await markDeleted('t', id);
  notify('delete');
}

// ---------- Playlists ----------
async function createPlaylist(name, trackIds = [], extra = {}) {
  const p = { id: uid('pl'), name: name || 'New playlist', trackIds: [...new Set(trackIds)], createdAt: Date.now(), updatedAt: Date.now(), ...extra };
  lib.playlists.set(p.id, p);
  await db.put('playlists', p);
  notify('playlist');
  return p;
}
async function savePlaylist(p) { p.updatedAt = Date.now(); lib.playlists.set(p.id, p); await db.put('playlists', p); notify('playlist'); }
async function addToPlaylist(pid, ids) {
  const p = lib.playlists.get(pid); if (!p) return 0;
  const before = p.trackIds.length;
  p.trackIds = [...new Set([...p.trackIds, ...ids])];
  await savePlaylist(p);
  return p.trackIds.length - before;
}
async function removeFromPlaylist(pid, id) {
  const p = lib.playlists.get(pid); if (!p) return null;
  const index = p.trackIds.indexOf(id);
  const snapshot = lib.tracks.get(id) ? { ...lib.tracks.get(id) } : null;
  p.trackIds = p.trackIds.filter(x => x !== id);
  await savePlaylist(p); await gc([id]);
  return { pid, id, index, snapshot };
}
// Undo for removeFromPlaylist: put the song back exactly where it was
async function undoRemoveFromPlaylist(r) {
  if (!r) return;
  const p = lib.playlists.get(r.pid); if (!p) return;
  if (!lib.tracks.has(r.id) && r.snapshot) await upsertTracks([r.snapshot]);
  if (!p.trackIds.includes(r.id)) p.trackIds.splice(Math.max(0, Math.min(r.index, p.trackIds.length)), 0, r.id);
  await savePlaylist(p);
}
// Swap a playlist's songs for new ones (the BAZINGA! mix), cleaning up songs nothing else uses
async function replacePlaylistTracks(pid, ids) {
  const p = lib.playlists.get(pid); if (!p) return;
  const old = p.trackIds;
  p.trackIds = [...new Set(ids)];
  await savePlaylist(p);
  await gc(old.filter(id => !p.trackIds.includes(id) && lib.tracks.get(id)?.mix));
}
async function deletePlaylist(pid) {
  const p = lib.playlists.get(pid); if (!p) return;
  lib.playlists.delete(pid); await db.del('playlists', pid); await markDeleted('p', pid);
  await gc(p.trackIds); notify('playlist');
}

// ---------- Albums ----------
async function saveAlbum(album, tracks) {
  const saved = await upsertTracks(tracks.map(t => ({ ...t, album: album.title, albumId: album.id, itunesAlbumId: album.itunesAlbumId || t.itunesAlbumId })));
  const a = { ...album, trackIds: saved.map(t => t.id), savedAt: Date.now(), updatedAt: Date.now() };
  if (tomb.a[a.id]) { delete tomb.a[a.id]; kv.set('tombstones', tomb); }
  lib.albums.set(a.id, a);
  await db.put('albums', a);
  notify('album');
  return a;
}
async function removeAlbum(id) {
  const a = lib.albums.get(id); if (!a) return;
  lib.albums.delete(id); await db.del('albums', id); await markDeleted('a', id);
  await gc(a.trackIds || []); notify('album');
}

// ---------- Derived views ----------
function artists() {
  const m = new Map();
  for (const t of saved()) {
    const names = t.artists?.length ? t.artists : [mainArtist(t.artist)];
    for (const name of names) {
      const k = norm(name); if (!k) continue;
      const e = m.get(k) || { key: k, name, count: 0, artwork: '', genres: new Set(), itunesArtistId: null };
      e.count++;
      if (!e.artwork && t.artwork) e.artwork = t.artwork;
      if (genreOf(t)) e.genres.add(genreOf(t));
      if (!e.itunesArtistId && t.itunesArtistId && norm(mainArtist(t.artist)) === k) e.itunesArtistId = t.itunesArtistId;
      m.set(k, e);
    }
  }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function genres() {
  const m = new Map();
  for (const t of saved()) { const g = genreOf(t); if (g) m.set(g, (m.get(g) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// Albums the user has songs from but hasn't explicitly saved
function implicitAlbums() {
  const m = new Map();
  for (const t of saved()) {
    if (!t.album) continue;
    const id = t.albumId || albumKey(t.artist, t.album);
    if (lib.albums.has(id)) continue;
    const e = m.get(id) || { id, title: t.album, artist: mainArtist(t.artist), artwork: t.artwork, year: t.year, itunesAlbumId: t.itunesAlbumId, trackIds: [], implicit: true };
    e.trackIds.push(t.id);
    if (!e.itunesAlbumId && t.itunesAlbumId) e.itunesAlbumId = t.itunesAlbumId;
    m.set(id, e);
  }
  return [...m.values()];
}

// ---------- Background enrichment (genre, release date, artwork, album ids) ----------
// Lane 1: Apple (genre, date, album, artwork) — paced by meta.js's rate limiter at background priority.
// Lane 2: covers still missing → Deezer, then the song's YouTube thumbnail as a last resort.
// Covers that arrive are swapped into what's on screen directly (no page re-render).
const enrichQ = new Set(), coverQ = new Set();
let enrichOn = true, lanes = 0;
const setEnrich = v => { enrichOn = v; if (v) queueEnrich([...lib.tracks.values()]); };
const enrichPending = () => enrichQ.size + coverQ.size;
function queueEnrich(list) {
  for (const t of list) {
    if (t.transient) continue;
    if (!t.enriched) enrichQ.add(t.id);
    if (!t.artwork && !t.coverTried) coverQ.add(t.id);
  }
  runEnrich(); runCovers();
}
async function patchTrack(t, patch) {
  Object.assign(t, patch);
  await db.put('tracks', t);
  if (patch.artwork) emit('track-art', { id: t.id, artwork: patch.artwork });
  emit('dirty', 'enrich'); // backups only; no full re-render while browsing
}
function runEnrich() {
  while (enrichOn && lanes < 2 && enrichQ.size) { lanes++; lane().finally(() => { lanes--; emit('enrich', enrichPending()); }); }
}
async function lane() {
  while (enrichQ.size && enrichOn) {
    if (!navigator.onLine) { await new Promise(r => setTimeout(r, 10000)); continue; }
    const id = enrichQ.values().next().value; enrichQ.delete(id);
    const t = lib.tracks.get(id);
    if (!t || t.enriched || t.transient) continue;
    try {
      const m = await meta.matchTrack(t);
      const patch = { enriched: true };
      if (m) {
        if (!t.genre && m.genre) patch.genre = m.genre;
        if (!t.releaseDate && m.releaseDate) { patch.releaseDate = m.releaseDate; patch.year = m.year; }
        if (!t.artwork && m.artwork) patch.artwork = m.artwork;
        if (!t.album && m.album) { patch.album = m.album; patch.albumId = m.albumId; }
        if (!t.durationMs && m.durationMs) patch.durationMs = m.durationMs;
        patch.itunesAlbumId = m.itunesAlbumId; patch.itunesArtistId = m.itunesArtistId;
      }
      await patchTrack(t, patch);
      emit('enrich', enrichPending());
    } catch (e) {
      enrichQ.add(id); // retry later; meta.js already backs off
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}
let coverWorkers = 0;
function runCovers() { while (enrichOn && coverWorkers < 2 && coverQ.size) { coverWorkers++; coverLane().finally(() => { coverWorkers--; emit('enrich', enrichPending()); }); } }
async function coverLane() {
  while (coverQ.size && enrichOn) {
    if (!navigator.onLine) { await new Promise(r => setTimeout(r, 10000)); continue; }
    const id = coverQ.values().next().value; coverQ.delete(id);
    const t = lib.tracks.get(id);
    if (!t || t.artwork || t.transient) continue;
    let artwork = '';
    try { artwork = (await meta.deezerCover(t))?.artwork || ''; } catch { }
    if (!artwork) { const c = await db.get('ytcache', id); const vid = c?.audio || c?.video; if (vid) artwork = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`; }
    await patchTrack(t, artwork ? { artwork, coverTried: true } : { coverTried: true });
  }
}
// Called by the player when a YouTube match is found for a song with no cover
async function coverFromVideo(id, vid) {
  const t = lib.tracks.get(id);
  if (!t || t.artwork || !vid) return;
  const artwork = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
  if (t.transient) { t.artwork = artwork; emit('track-art', { id, artwork }); return; }
  await patchTrack(t, { artwork });
}

return { lib, notify, tombstones, setTombstones, load, upsertTracks, remember, saved, updateTrack, setLiked, toggleLike, deleteTrack, createPlaylist, savePlaylist, addToPlaylist, removeFromPlaylist, undoRemoveFromPlaylist, replacePlaylistTracks, deletePlaylist, saveAlbum, removeAlbum, artists, genres, implicitAlbums, setEnrich, enrichPending, queueEnrich, coverFromVideo };
})();
// ---------- youtube.js ----------
const __m_youtube = (() => {
// Finding YouTube videos for each song — free and keyless by default.
// Sources, in order:
//   1. Your own YouTube Data API key (optional, Settings) — most reliable.
//   2. Public Invidious instances (open-source YouTube front-ends with a free JSON API).
//   3. Public Piped instances.
//
// Speed + safety:
//  • ONE search per song (the results almost always contain both the music video and the
//    "Topic"/official-audio upload). A second, targeted search only runs if one is missing.
//  • Servers are ranked by how fast and reliable they've actually been; the fastest is used first,
//    slow or failing ones are rested for 10 minutes.
//  • Batch matching runs a few songs at once, each on a DIFFERENT server, with a minimum gap per
//    server — fast for you, gentle on every server, so nobody rate-limits or blocks your IP.
//  • Every match is cached on the device, so a song is only ever looked up once.
const { db } = __m_db;
const { norm, mainArtist, sleep } = __m_util;

let settings = { ytKey: '', customInstance: '', ownerKey: '' }; // ownerKey: app-wide backup key from index.html
const setYTSettings = s => { settings = { ...settings, ...s }; };

const FALLBACK_INVIDIOUS = [
  'https://inv.nadeko.net', 'https://invidious.nerdvpn.de', 'https://yewtu.be',
  'https://invidious.f5.si', 'https://iv.melmac.space', 'https://invidious.privacyredirect.com'
];
const FALLBACK_PIPED = ['https://pipedapi.kavin.rocks', 'https://api.piped.private.coffee', 'https://pipedapi.adminforge.de'];

// ---------- server pool ----------
const pool = new Map(); // base -> {kind, ok, fail, ms, badUntil, last, busy}
function addServer(kind, base) { if (!pool.has(base)) pool.set(base, { kind, ok: 0, fail: 0, ms: 2500, badUntil: 0, last: 0, busy: 0 }); }
FALLBACK_INVIDIOUS.forEach(b => addServer('inv', b));
FALLBACK_PIPED.forEach(b => addServer('piped', b));
// Remember which servers were fast (and which were down) between visits, so the very first song
// of a session goes straight to a server that works instead of waiting on dead ones.
try {
  const saved = JSON.parse(localStorage.getItem('bz_yt_pool') || '{}');
  for (const [b, v] of Object.entries(saved)) { addServer(v.kind || 'inv', b); Object.assign(pool.get(b), { ok: v.ok || 0, fail: v.fail || 0, ms: v.ms || 2500, badUntil: v.badUntil || 0 }); }
} catch { }
let poolSaveT = 0;
function savePool() {
  clearTimeout(poolSaveT);
  poolSaveT = setTimeout(() => {
    const o = {}; for (const [b, v] of pool) if (v.ok || v.fail) o[b] = { kind: v.kind, ok: Math.min(v.ok, 50), fail: v.fail, ms: Math.round(v.ms), badUntil: v.badUntil };
    try { localStorage.setItem('bz_yt_pool', JSON.stringify(o)); } catch { }
  }, 1000);
}

async function fetchJSON(url, ms = 7000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (r.status === 429 || r.status === 403) { const e = new Error('rate'); e.rate = true; throw e; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Load the live list of healthy public servers in the background (never blocks a search)
let listLoaded = null;
function startInstances() {
  if (listLoaded) return listLoaded;
  listLoaded = (async () => {
    try {
      const list = await fetchJSON('https://api.invidious.io/instances.json?sort_by=health', 6000);
      for (const [, info] of list) if (info?.type === 'https' && info.api && info.cors) addServer('inv', info.uri.replace(/\/$/, ''));
    } catch { }
    try {
      const list = await fetchJSON('https://piped-instances.kavin.rocks/', 6000);
      for (const i of list) if (i.api_url) addServer('piped', i.api_url.replace(/\/$/, ''));
    } catch { }
  })();
  return listLoaded;
}

const MIN_GAP = 400; // ms between two requests to the same server
function rankServers(exclude = new Set()) {
  const now = Date.now();
  const list = [...pool.entries()].filter(([b, s]) => s.badUntil < now && !exclude.has(b));
  // Known-good servers by speed first, then untested ones (a little shuffled to spread load), then flaky ones
  const score = s => (s.ok ? s.ms : 4000 + Math.random() * 1500) + s.fail * 3000 + s.busy * 1500;
  return list.sort((a, b) => score(a[1]) - score(b[1])).map(([b]) => b);
}
function record(base, ok, ms, rate) {
  const s = pool.get(base); if (!s) return;
  if (ok) { s.ok++; s.fail = Math.max(0, s.fail - 1); s.ms = s.ms * 0.6 + ms * 0.4; }
  else { s.fail++; if (rate || s.fail >= 2) s.badUntil = Date.now() + 10 * 60e3; }
  savePool();
}
async function hit(base, q, ms = 7000) {
  const s = pool.get(base);
  const wait = s.last + MIN_GAP - Date.now();
  s.last = Math.max(Date.now(), s.last + MIN_GAP);
  if (wait > 0) await sleep(wait);
  s.busy++;
  const t0 = performance.now();
  try {
    const r = s.kind === 'inv' ? await searchInvidious(base, q, ms) : await searchPiped(base, q, ms);
    record(base, true, performance.now() - t0);
    return r;
  } catch (e) { record(base, false, 0, e.rate); throw e; }
  finally { s.busy--; }
}

// Normalised result: {id, title, author, seconds, views}
async function searchViaKey(q, key = settings.ytKey) {
  const u = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=12&q=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`;
  const d = await fetchJSON(u);
  return (d.items || []).map(i => ({ id: i.id.videoId, title: decodeEntities(i.snippet.title), author: i.snippet.channelTitle, seconds: 0 }));
}
async function searchInvidious(base, q, ms) {
  const d = await fetchJSON(`${base}/api/v1/search?type=video&q=${encodeURIComponent(q)}&fields=type,videoId,title,author,lengthSeconds,viewCount`, ms);
  return d.filter(v => v.type === 'video').map(v => ({ id: v.videoId, title: v.title, author: v.author, seconds: v.lengthSeconds || 0, views: v.viewCount || 0 }));
}
async function searchPiped(base, q, ms) {
  const d = await fetchJSON(`${base}/search?filter=videos&q=${encodeURIComponent(q)}`, ms);
  return (d.items || []).filter(v => v.url?.includes('watch')).map(v => ({
    id: new URL(v.url, 'https://x.y').searchParams.get('v'), title: v.title, author: (v.uploaderName || '').replace(/\s*-\s*Topic$/, ' - Topic'), seconds: v.duration || 0, views: v.views || 0
  }));
}
// Another keyless route that doesn't depend on the Invidious/Piped servers (which some networks —
// e.g. Safari's iCloud Private Relay — get blocked by): read YouTube's own results page through a
// free public CORS relay, and take the video list out of it. Several relays race; first answer wins.
const PROXIES = [
  u => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
  u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  u => 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(u)
];
const proxyBad = new Map(); // index -> rested until
const secs = t => String(t || '').split(':').reduce((a, b) => a * 60 + (+b || 0), 0);
function videosFromYtData(data) {
  const out = [], seen = new Set();
  const walk = o => {
    if (!o || typeof o !== 'object' || out.length >= 25) return;
    if (Array.isArray(o)) { for (const x of o) walk(x); return; }
    const v = o.videoRenderer;
    if (v?.videoId && !seen.has(v.videoId)) {
      seen.add(v.videoId);
      out.push({
        id: v.videoId,
        title: (v.title?.runs || []).map(r => r.text).join('') || v.title?.simpleText || '',
        author: (v.ownerText?.runs || v.longBylineText?.runs || [])[0]?.text || '',
        seconds: secs(v.lengthText?.simpleText),
        views: +String(v.viewCountText?.simpleText || '').replace(/\D/g, '') || 0
      });
      return;
    }
    for (const k in o) walk(o[k]);
  };
  walk(data);
  return out;
}
async function proxySearch(q, ms = 8000) {
  const url = 'https://www.youtube.com/results?hl=en&gl=US&search_query=' + encodeURIComponent(q) + '&sp=EgIQAQ%253D%253D';
  const now = Date.now();
  const tries = PROXIES.map((mk, i) => (async () => {
    if ((proxyBad.get(i) || 0) > now) throw new Error('rested');
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(mk(url), { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const html = await r.text();
      const m = html.match(/ytInitialData\s*=\s*(\{.+?\})\s*;\s*<\/script>/s);
      if (!m) throw new Error('no data');
      const list = videosFromYtData(JSON.parse(m[1]));
      if (!list.length) throw new Error('empty');
      return list;
    } catch (e) { proxyBad.set(i, Date.now() + 5 * 60e3); throw e; }
    finally { clearTimeout(t); }
  })());
  return Promise.any(tries).catch(() => { throw new Error('proxy search failed'); });
}
function decodeEntities(s) { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; }

// Fast path for a song you just tapped: ask the best server, and if it hasn't answered within a
// moment, ask the next one too (and so on) — the first good answer wins. A slow or dead server
// never holds the music up. The app's backup key joins in only if the free servers are all slow.
function raceSearch(q, order) {
  return new Promise((resolve, reject) => {
    let i = 0, pending = 0, done = false, timer = 0, keyTimer = 0, proxyTimer = 0, proxyDone = false;
    const win = r => { done = true; clearTimeout(timer); clearTimeout(keyTimer); clearTimeout(proxyTimer); resolve(r); };
    const giveUp = () => { if (!done && !pending && i >= order.length && proxyDone) { done = true; clearTimeout(keyTimer); reject(new Error('none')); } };
    // If the free servers haven't answered quickly (or all look down), YouTube's own page joins the race
    const anyGood = order.slice(0, 3).some(b => { const st = pool.get(b); return st && st.ok && st.fail < 2; });
    proxyTimer = setTimeout(() => {
      if (done) return; pending++;
      proxySearch(q).then(r => { pending--; proxyDone = true; if (!done && r.length) win(r); else giveUp(); }, () => { pending--; proxyDone = true; giveUp(); });
    }, anyGood ? 2200 : 300);
    const launch = () => {
      clearTimeout(timer);
      if (done) return;
      if (i >= order.length) { giveUp(); return; }
      const base = order[i++], st = pool.get(base); pending++;
      hit(base, q, 5000).then(r => { pending--; if (done) return; if (r.length) win(r); else launch(); }, () => { pending--; if (!done) launch(); });
      const known = st && st.ok && st.ms < 2500;
      timer = setTimeout(launch, known ? Math.max(700, Math.min(1600, st.ms * 1.6)) : 650);
    };
    launch();
    if (settings.ownerKey && settings.ownerKey !== settings.ytKey) {
      keyTimer = setTimeout(() => { if (done) return; pending++; searchViaKey(q, settings.ownerKey).then(r => { pending--; if (!done && r.length) win(r); else if (!done) launch(); }, () => { pending--; if (!done) launch(); }); }, 3000);
    }
  });
}

const qCache = new Map();
// preferFree: try free servers before spending API-key quota (used by the Search page while typing)
async function rawSearch(q, { preferFree = false, prefer = null } = {}) {
  const key = q.toLowerCase();
  if (qCache.has(key)) return qCache.get(key);
  const p = (async () => {
    startInstances();
    const useKey = settings.ytKey && !preferFree;
    if (useKey) { try { return await searchViaKey(q); } catch (e) { console.warn('YT key search failed', e); } }
    const tried = new Set();
    const order = [];
    if (settings.customInstance) { const b = settings.customInstance.replace(/\/$/, ''); addServer('inv', b); order.push(b); }
    if (prefer) order.push(prefer);
    for (const b of rankServers()) if (!order.includes(b)) order.push(b);
    if (!prefer) { try { return await raceSearch(q, order.slice(0, 12)); } catch { } }
    else for (const base of order.slice(0, 7)) {
      if (tried.has(base)) continue; tried.add(base);
      try { const r = await hit(base, q); if (r.length) return r; } catch { }
    }
    if (prefer) { try { return await proxySearch(q); } catch { } }
    // Free servers all failed: fall back to your key if we skipped it, then the app's backup key
    if (settings.ytKey && preferFree) { try { return await searchViaKey(q); } catch { } }
    if (settings.ownerKey && settings.ownerKey !== settings.ytKey) { try { return await searchViaKey(q, settings.ownerKey); } catch (e) { console.warn('backup key search failed', e); } }
    throw new Error('Couldn\'t reach YouTube search right now — try again in a moment, or add a free YouTube API key in Settings → YouTube matching.');
  })();
  qCache.set(key, p);
  p.catch(() => qCache.delete(key));
  if (qCache.size > 300) qCache.delete(qCache.keys().next().value);
  return p;
}

// Previews, snippets and teasers (often uploaded before a release, or as Shorts) aren't the full song
const PREVIEW = /(\b(preview|snippet|teaser|trailer|sneak ?peek|shorts|30 ?sec(ond)?s?|coming soon|unreleased|leak(ed)?)\b|#shorts?\b)/;
function isPreview(r, t) {
  const raw = String(r.title || '').toLowerCase(), song = String(t?.title || '').toLowerCase();
  if (PREVIEW.test(raw) && !PREVIEW.test(song)) return true;
  const full = t?.durationMs ? t.durationMs / 1000 : 0;
  if (r.seconds) {
    if (full > 90 && r.seconds < full * 0.72) return true; // much shorter than the real song
    if (!full && r.seconds < 70) return true;               // a minute or less: almost always a preview/short
  }
  return false;
}
// Score a result for "video" (official music video) or "audio" (Topic channel / official audio)
function score(r, t, mode) {
  const title = norm(r.title), author = String(r.author || '').toLowerCase();
  const nt = norm(t.title.replace(/\s*[\(\[](feat|ft|with)[^\)\]]*[\)\]]/i, '')), na = norm(mainArtist(t.artist));
  let s = 0;
  if (title.includes(nt)) s += 6;
  if (title.includes(na) || norm(author).includes(na)) s += 4;
  const isTopic = author.endsWith(' - topic');
  const vevo = author.includes('vevo');
  const raw = String(r.title).toLowerCase();
  if (mode === 'audio') {
    if (isTopic) s += 8;
    if (/official audio|\baudio\b/.test(raw)) s += 5;
    if (/lyric/.test(raw)) s += 1;
    if (/music video|official video/.test(raw)) s -= 2;
  } else {
    if (/official (music )?video|music video/.test(raw)) s += 7;
    if (vevo || norm(author) === na) s += 3;
    if (isTopic) s -= 4;
    if (/lyric|audio/.test(raw)) s -= 2;
  }
  if (/\b(cover|karaoke|instrumental|reaction|8d|slowed|sped up|nightcore|remix|live)\b/.test(raw) && !/(remix|live)/.test(norm(t.title))) s -= 6;
  if (t.durationMs && r.seconds) {
    const diff = Math.abs(r.seconds - t.durationMs / 1000);
    if (diff < 5) s += 3; else if (diff > 90 && mode === 'audio') s -= 3;
  }
  if (r.seconds > 1200) s -= 5;
  if (isPreview(r, t)) s -= 14; // never pick a preview when the full song is there
  if (r.views > 1e6) s += 1;
  return s;
}
function pick(list, t, mode, notId) {
  const b = list.filter(r => r.id !== notId).map(r => [score(r, t, mode), r]).sort((a, b) => b[0] - a[0])[0];
  return b && b[0] >= 8 ? b[1] : null;
}

const inflight = new Map();
const hot = new Map(); // matches already looked up this session (skips the database round-trip)
function forget(id) { id ? hot.delete(id) : hot.clear(); }
function findForTrack(t, { force = false, prefer = null, need = null } = {}) {
  if (!t) return Promise.reject(new Error('No song'));
  if (!force && hot.has(t.id)) return Promise.resolve(hot.get(t.id));
  if (!force && inflight.has(t.id)) return inflight.get(t.id);
  const p = (async () => {
    if (!force) {
      const c = await db.get('ytcache', t.id);
      // a match saved earlier that turns out to be a preview gets looked up again (your own links are kept)
      const stalePreview = c && !c.manual && !c.fromSearch && [c.videoTitle, c.audioTitle].some(x => x && isPreview({ title: x }, t));
      if (c && (c.video || c.audio) && !stalePreview) { hot.set(t.id, c); if (hot.size > 2000) hot.delete(hot.keys().next().value); return c; }
    }
    const base = `${mainArtist(t.artist)} ${t.title.replace(/\s*[\(\[](feat|ft|with)[^\)\]]*[\)\]]/i, '')}`;
    const out = { video: null, audio: null, videoTitle: '', audioTitle: '', checkedAt: Date.now() };
    let list = await rawSearch(base, { prefer });
    let v = pick(list, t, 'video'), a = pick(list, t, 'audio', v?.id);
    const save = async () => {
      if (v) { out.video = v.id; out.videoTitle = v.title; }
      if (a) { out.audio = a.id; out.audioTitle = a.title; }
      const guess = !out.video && !out.audio && (list.find(r => !isPreview(r, t)) || list[0]);
      if (guess) { out.audio = guess.id; out.audioTitle = guess.title; out.guess = true; }
      await db.put('ytcache', { ...out }, t.id);
      if (out.video || out.audio) hot.set(t.id, { ...out });
      return { ...out };
    };
    // Only spend a second search on whatever is still missing
    if (!a || !v) {
      const second = rawSearch(`${base} ${!a ? 'official audio' : 'official music video'}`, { prefer }).then(more => {
        const seen = new Set(list.map(r => r.id));
        list = [...list, ...more.filter(r => !seen.has(r.id))];
        v = v || pick(list, t, 'video', a?.id); a = a || pick(list, t, 'audio', v?.id);
      }).catch(() => { });
      // The version you're about to play is already known: start it now, finish the other quietly
      if (need && (need === 'video' ? v : a)) { const first = await save(); second.then(save).catch(() => { }); return first; }
      await Promise.race([second, sleep(need ? 2500 : 60000)]);
    }
    return save();
  })();
  inflight.set(t.id, p);
  p.finally(() => inflight.delete(t.id));
  return p;
}

// Match many songs quickly: a few parallel workers, each pinned to a different server.
async function matchMany(tracks, { onProgress, isCancelled } = {}) {
  startInstances();
  await Promise.race([listLoaded, sleep(1500)]);
  const workers = settings.ytKey ? 4 : Math.min(4, Math.max(2, rankServers().length >> 1));
  const servers = rankServers();
  let next = 0, done = 0, found = 0, failedInARow = 0, lastErr = null;
  async function worker(w) {
    while (next < tracks.length && !isCancelled?.()) {
      const t = tracks[next++];
      try {
        const c = await findForTrack(t, { prefer: servers[w % Math.max(1, servers.length)] });
        if (c.video || c.audio) found++;
        failedInARow = 0;
      } catch (e) { lastErr = e; if (++failedInARow >= 6) return; }
      onProgress?.(++done, tracks.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, tracks.length) }, (_, w) => worker(w)));
  if (!found && lastErr) throw lastErr;
  return { found, done };
}

async function setManual(trackId, mode, id, title = '') {
  const c = (await db.get('ytcache', trackId)) || {};
  c[mode] = id; c[mode + 'Title'] = title || 'Set manually'; c.manual = true; c.checkedAt = Date.now();
  await db.put('ytcache', c, trackId);
  hot.set(trackId, c);
  return c;
}

const thumb = (id, q = 'hqdefault') => id ? `https://i.ytimg.com/vi/${id}/${q}.jpg` : '';

function parseYouTubeId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1, 12);
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const m = u.pathname.match(/\/(embed|shorts|live)\/([\w-]{11})/);
    if (m) return m[2];
  } catch { }
  return null;
}

// Turn a YouTube result into a song: "Artist - Title (Official Video)" -> {artist, title}
function videoToSong(r) {
  let title = String(r.title || '').replace(/\s*[\(\[]\s*(official|music|lyric|lyrics|audio|video|visuali[sz]er|hd|4k|explicit)[^\)\]]*[\)\]]/gi, '').replace(/\s*\|.*$/, '').trim();
  let artist = String(r.author || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
  const m = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) { artist = m[1].trim(); title = m[2].trim(); }
  // "Essence ft. Tems" -> title "Essence", featured artist Tems
  const artists = [artist];
  const f = title.match(/\s*[\(\[]?\s*(?:ft\.?|feat\.?|featuring)\s+([^\)\]]+)[\)\]]?\s*$/i);
  if (f) { title = title.slice(0, f.index).trim(); artists.push(...f[1].split(/\s*(?:,|&| and | x )\s*/i).filter(Boolean)); }
  return { artist, title, artists };
}

// Build "untitled playlist" links that open straight on YouTube (50 videos per link)
function youtubePlaylistLinks(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) out.push('https://www.youtube.com/watch_videos?video_ids=' + ids.slice(i, i + 50).join(','));
  return out;
}

// ---------- public playlists (no sign-in) ----------
function parsePlaylistId(input) {
  const s = String(input || '').trim();
  if (/^(PL|UU|LL|FL|OLAK5uy_|RD)[\w-]{10,}$/.test(s)) return s;
  try { return new URL(s).searchParams.get('list'); } catch { return null; }
}
async function publicPlaylist(listId) {
  startInstances();
  // 1) your own API key, if you added one
  if (settings.ytKey) {
    try {
      const vids = []; let page = '', title = 'YouTube playlist';
      try { const m = await fetchJSON(`https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${listId}&key=${encodeURIComponent(settings.ytKey)}`); title = m.items?.[0]?.snippet?.title || title; } catch { }
      do {
        const d = await fetchJSON(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${listId}&key=${encodeURIComponent(settings.ytKey)}${page ? '&pageToken=' + page : ''}`);
        for (const it of d.items || []) { const id = it.contentDetails?.videoId; if (id && !/^(Deleted|Private) video$/.test(it.snippet.title)) vids.push({ id, title: it.snippet.title, author: it.snippet.videoOwnerChannelTitle || '' }); }
        page = d.nextPageToken || '';
      } while (page && vids.length < 5000);
      if (vids.length) return { title, videos: vids };
    } catch { }
  }
  // 2) free servers
  for (const base of rankServers().slice(0, 6)) {
    const s = pool.get(base);
    try {
      if (s.kind === 'inv') {
        const vids = []; let title = 'YouTube playlist';
        for (let page = 1; page <= 40; page++) {
          const d = await fetchJSON(`${base}/api/v1/playlists/${listId}?page=${page}`, 9000);
          title = d.title || title;
          const got = (d.videos || []).filter(v => v.videoId && v.lengthSeconds !== 0).map(v => ({ id: v.videoId, title: v.title, author: v.author, seconds: v.lengthSeconds || 0 }));
          const before = vids.length;
          for (const v of got) if (!vids.some(x => x.id === v.id)) vids.push(v);
          if (vids.length === before || !got.length) break;
        }
        if (vids.length) { record(base, true, 1500); return { title, videos: vids }; }
      } else {
        const d = await fetchJSON(`${base}/playlists/${listId}`, 9000);
        const vids = (d.relatedStreams || []).map(v => ({ id: new URL(v.url, 'https://x.y').searchParams.get('v'), title: v.title, author: v.uploaderName, seconds: v.duration || 0 }));
        let next = d.nextpage;
        while (next && vids.length < 5000) {
          const n = await fetchJSON(`${base}/nextpage/playlists/${listId}?nextpage=${encodeURIComponent(next)}`, 9000);
          vids.push(...(n.relatedStreams || []).map(v => ({ id: new URL(v.url, 'https://x.y').searchParams.get('v'), title: v.title, author: v.uploaderName, seconds: v.duration || 0 })));
          next = n.nextpage;
        }
        if (vids.length) { record(base, true, 1500); return { title: d.name || 'YouTube playlist', videos: vids }; }
      }
    } catch (e) { record(base, false, 0, e.rate); }
  }
  throw new Error('Couldn\'t read that playlist. Make sure it\'s public or unlisted, or sign in with YouTube to import your private playlists.');
}

return { setYTSettings, startInstances, proxySearch, rawSearch, isPreview, forget, findForTrack, matchMany, setManual, thumb, parseYouTubeId, videoToSong, youtubePlaylistLinks, parsePlaylistId, publicPlaylist };
})();
// ---------- ytaccount.js ----------
const __m_ytaccount = (() => {
// YouTube account sync: save BAZINGA! playlists to the user's YouTube account and
// import their YouTube playlists back (a second backup of their music).
//
// Uses Google's own sign-in popup (Google Identity Services) in the browser — no server.
// The access token lives only in memory/this device and expires after about an hour.
//
// YouTube limits (per Google sign-in key, per day): 10,000 "units".
//   create playlist = 50, add one song = 50, read 50 songs = 1.
//   → about 200 songs can be added per day per key. Uploads that hit the limit pause and
//     can be resumed the next day (Google resets the quota at midnight Pacific time).
const { kv } = __m_db;
const { sleep, emit } = __m_util;

const SCOPE = 'https://www.googleapis.com/auth/youtube';
const API = 'https://www.googleapis.com/youtube/v3/';
let clientId = '';
let token = null; // {access, expires}

function setGoogleClientId(id) { clientId = (id || '').trim(); }
const configured = () => !!clientId;
const signedIn = () => !!token && Date.now() < token.expires;

let gisP = null;
function loadGIS() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisP) return gisP;
  gisP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => res(); s.onerror = () => { gisP = null; rej(new Error('Couldn\'t load Google sign-in. Check your connection.')); };
    document.head.appendChild(s);
  });
  return gisP;
}

async function restoreSession() {
  const t = await kv.get('ytToken');
  if (t && Date.now() < t.expires) token = t;
}

// Must be called from a click (browsers block popups otherwise)
async function signIn({ prompt = '' } = {}) {
  if (!clientId) throw new Error('YouTube sign-in isn\'t set up yet. See Settings → YouTube account.');
  if (!location.protocol.startsWith('http')) throw new Error('YouTube sign-in only works on the hosted (GitHub Pages) version of BAZINGA!.');
  await loadGIS();
  return new Promise((resolve, reject) => {
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: SCOPE,
      callback: async r => {
        if (r.error) return reject(new Error(r.error === 'access_denied' ? 'YouTube access was not allowed.' : 'Google sign-in failed: ' + r.error));
        token = { access: r.access_token, expires: Date.now() + (r.expires_in - 60) * 1000 };
        await kv.set('ytToken', token);
        emit('yt-account');
        resolve(token);
      },
      error_callback: e => reject(new Error(e?.type === 'popup_closed' ? 'Sign-in window was closed.' : e?.type === 'popup_failed_to_open' ? 'Your browser blocked the sign-in popup — allow popups for this site.' : 'Google sign-in failed.'))
    });
    tc.requestAccessToken({ prompt });
  });
}
async function signOut() {
  try { if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token.access, () => { }); } catch { }
  token = null; await kv.del('ytToken', { everywhere: true }); emit('yt-account');
}

class QuotaError extends Error { constructor() { super('YouTube\'s daily limit for this app has been reached. Your upload is saved — tap "Resume" tomorrow (limits reset at midnight Pacific time), or add your own Google key in Settings for your own limit.'); this.quota = true; } }

async function api(method, path, { params = {}, body } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!signedIn()) await signIn();
    const r = await fetch(API + path + '?' + new URLSearchParams(params), {
      method, headers: { Authorization: 'Bearer ' + token.access, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (r.status === 401) { token = null; await kv.del('ytToken'); continue; }
    const d = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (r.ok) return d;
    const reason = d?.error?.errors?.[0]?.reason || '';
    if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded/.test(reason)) {
      if (reason === 'rateLimitExceeded' && attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
      throw new QuotaError();
    }
    if (r.status === 409 && attempt < 2) { await sleep(800); continue; } // YouTube busy with the previous insert
    if (reason === 'youtubeSignupRequired') throw new Error('This Google account doesn\'t have a YouTube channel yet. Open youtube.com, create your channel, then try again.');
    if (reason === 'videoNotFound' || reason === 'forbidden' && path === 'playlistItems') { const e = new Error('skip'); e.skip = true; throw e; }
    throw new Error(d?.error?.message || `YouTube error ${r.status}`);
  }
  throw new Error('Couldn\'t sign in to YouTube.');
}

async function allPages(path, params, map) {
  const out = []; let pageToken = '';
  do {
    const d = await api('GET', path, { params: { ...params, maxResults: 50, ...(pageToken ? { pageToken } : {}) } });
    out.push(...(d.items || []).map(map).filter(Boolean));
    pageToken = d.nextPageToken || '';
  } while (pageToken && out.length < 5000);
  return out;
}

// ---------- reading ----------
async function myPlaylists() {
  const lists = await allPages('playlists', { part: 'snippet,contentDetails', mine: true }, p => ({
    id: p.id, title: p.snippet.title, count: p.contentDetails?.itemCount ?? null, image: p.snippet.thumbnails?.medium?.url || ''
  }));
  try {
    const ch = await api('GET', 'channels', { params: { part: 'contentDetails', mine: true } });
    const likes = ch.items?.[0]?.contentDetails?.relatedPlaylists?.likes;
    if (likes) lists.unshift({ id: likes, title: 'Liked videos', count: null, image: '', liked: true });
  } catch { }
  return lists;
}
async function playlistVideos(id) {
  return allPages('playlistItems', { part: 'snippet,contentDetails', playlistId: id }, it => {
    const vid = it.contentDetails?.videoId || it.snippet?.resourceId?.videoId;
    if (!vid || /^(Deleted|Private) video$/.test(it.snippet?.title || '')) return null;
    return { id: vid, title: it.snippet.title, author: it.snippet.videoOwnerChannelTitle || '' };
  });
}

// ---------- writing ----------
async function createPlaylist(title, description, privacy = 'private') {
  const d = await api('POST', 'playlists', { params: { part: 'snippet,status' }, body: { snippet: { title: title.slice(0, 150), description: description.slice(0, 4900) }, status: { privacyStatus: privacy } } });
  return d.id;
}
async function existingVideoIds(playlistId) {
  try { return new Set((await playlistVideos(playlistId)).map(v => v.id)); }
  catch (e) { if (/not ?found/i.test(e.message)) return null; throw e; }
}

// Upload job, resumable. job = {key, title, ytPlaylistId, videoIds, done, privacy, created}
async function runUpload(job, { onProgress, isCancelled } = {}) {
  if (!job.ytPlaylistId) {
    job.ytPlaylistId = await createPlaylist(job.title, 'Made with BAZINGA! ⚡', job.privacy);
    await saveJob(job);
  }
  let skipped = job.skipped || 0;
  while (job.done < job.videoIds.length) {
    if (isCancelled?.()) break;
    const videoId = job.videoIds[job.done];
    try {
      await api('POST', 'playlistItems', { params: { part: 'snippet' }, body: { snippet: { playlistId: job.ytPlaylistId, resourceId: { kind: 'youtube#video', videoId } } } });
    } catch (e) {
      if (!e.skip) { await saveJob(job); throw e; }
      skipped++; job.skipped = skipped;
    }
    job.done++;
    if (job.done % 5 === 0) await saveJob(job);
    onProgress?.(job.done, job.videoIds.length);
    await sleep(120); // YouTube rejects inserts into the same playlist that arrive too close together
  }
  if (job.done >= job.videoIds.length) await clearJob(job.key); else await saveJob(job);
  return { url: 'https://www.youtube.com/playlist?list=' + job.ytPlaylistId, skipped, finished: job.done >= job.videoIds.length };
}
const pendingJobs = async () => (await kv.get('ytUploads')) || {};
async function saveJob(job) { const all = await pendingJobs(); all[job.key] = job; await kv.set('ytUploads', all); emit('yt-account'); }
async function clearJob(key) { const all = await pendingJobs(); delete all[key]; await kv.set('ytUploads', all); emit('yt-account'); }
const dropJob = clearJob;

// Units this upload will use (so we can tell the user before starting)
const unitsFor = (n, newPlaylist) => n * 50 + (newPlaylist ? 50 : 0);

return { setGoogleClientId, configured, signedIn, restoreSession, signIn, signOut, myPlaylists, playlistVideos, createPlaylist, existingVideoIds, runUpload, pendingJobs, dropJob, unitsFor };
})();
// ---------- spotify.js ----------
const __m_spotify = (() => {
// Spotify import (Liked Songs + playlists). Runs 100% in the browser using
// OAuth PKCE with the user's OWN free Spotify developer Client ID, so there is
// no shared server and no shared request limit. Tokens stay on the device.
const { kv } = __m_db;
const { trackKey, albumKey, yearOf, sleep } = __m_util;

const SCOPES = 'user-library-read playlist-read-private playlist-read-collaborative';
const redirectUri = () => location.origin + location.pathname;

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function login(clientId) {
  if (!location.protocol.startsWith('http')) throw new Error('Spotify login only works on the hosted (GitHub Pages) version of BAZINGA.');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem('bz_sp_verifier', verifier);
  sessionStorage.setItem('bz_sp_state', state);
  await kv.set('spotifyClientId', clientId);
  const p = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri(),
    code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state
  });
  location.href = 'https://accounts.spotify.com/authorize?' + p;
}

// Call on startup: completes the login if we just came back from Spotify.
async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (q.get('auth') === 'sb') return false; // that's a BAZINGA! account sign-in, not Spotify
  if (!q.get('code') && !q.get('error')) return false;
  const clean = () => history.replaceState(null, '', redirectUri() + location.hash);
  if (q.get('error')) { clean(); throw new Error('Spotify login was cancelled.'); }
  if (q.get('state') !== sessionStorage.getItem('bz_sp_state')) { clean(); throw new Error('Spotify login expired — please try again.'); }
  const clientId = await kv.get('spotifyClientId');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, grant_type: 'authorization_code', code: q.get('code'),
      redirect_uri: redirectUri(), code_verifier: sessionStorage.getItem('bz_sp_verifier')
    })
  });
  clean();
  if (!r.ok) throw new Error('Spotify login failed (' + r.status + '). Check the Redirect URI in your Spotify app.');
  await saveToken(await r.json());
  return true;
}

async function saveToken(t) {
  const prev = (await kv.get('spotifyToken')) || {};
  await kv.set('spotifyToken', {
    access: t.access_token, refresh: t.refresh_token || prev.refresh,
    expires: Date.now() + (t.expires_in - 60) * 1000
  });
}

async function token() {
  const t = await kv.get('spotifyToken');
  if (!t) throw new Error('Not connected to Spotify.');
  if (Date.now() < t.expires) return t.access;
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: await kv.get('spotifyClientId') })
  });
  if (!r.ok) { await kv.del('spotifyToken'); throw new Error('Spotify session expired — reconnect.'); }
  await saveToken(await r.json());
  return (await kv.get('spotifyToken')).access;
}

const isConnected = async () => !!(await kv.get('spotifyToken'));
const disconnect = () => kv.del('spotifyToken', { everywhere: true });

async function api(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(url.startsWith('http') ? url : 'https://api.spotify.com/v1' + url, {
      headers: { Authorization: 'Bearer ' + await token() }
    });
    if (r.status === 429) { await sleep((+r.headers.get('Retry-After') || 2) * 1000); continue; }
    if (!r.ok) { const e = new Error('Spotify ' + r.status); e.status = r.status; throw e; }
    return r.json();
  }
  throw new Error('Spotify is rate-limiting — try again in a minute.');
}

// Follow `next` links, trying a big page size first and smaller ones if Spotify refuses.
async function paged(path, onPage) {
  let out = [];
  for (const limit of [50, 20, 10]) {
    try {
      let url = path + (path.includes('?') ? '&' : '?') + 'limit=' + limit;
      out = [];
      while (url) {
        const d = await api(url);
        out.push(...(d.items || []));
        onPage?.(out.length, d.total);
        url = d.next;
      }
      return out;
    } catch (e) { if (e.status !== 400) throw e; }
  }
  return out;
}

function toTrack(t, addedAt) {
  if (!t || t.type === 'episode' || !t.name) return null;
  const artists = (t.artists || []).map(a => a.name);
  const artist = artists[0] || '';
  const al = t.album || {};
  return {
    id: trackKey(artist, t.name),
    title: t.name, artist, artists,
    album: al.name || '',
    albumId: al.name ? albumKey((al.artists?.[0]?.name) || artists[0], al.name) : '',
    spotifyId: t.id || null, spotifyAlbumId: al.id || null,
    releaseDate: al.release_date || '', year: yearOf(al.release_date),
    durationMs: t.duration_ms || 0,
    artwork: al.images?.[0]?.url || '',
    explicit: !!t.explicit,
    trackNumber: t.track_number || 0,
    addedAt: addedAt ? Date.parse(addedAt) : Date.now()
  };
}

async function likedSongs(onProgress) {
  const items = await paged('/me/tracks', onProgress);
  return items.map(i => toTrack(i.track || i.item, i.added_at)).filter(Boolean);
}

async function playlists() {
  const items = await paged('/me/playlists');
  return items.filter(Boolean).map(p => ({
    spotifyId: p.id, name: p.name, image: p.images?.[0]?.url || '',
    total: (p.items || p.tracks)?.total ?? null, owner: p.owner?.display_name || ''
  }));
}

async function playlistTracks(id, onProgress) {
  let items;
  try { items = await paged(`/playlists/${id}/items`, onProgress); }
  catch (e) {
    if (e.status === 404 || e.status === 403) items = await paged(`/playlists/${id}/tracks`, onProgress);
    else throw e;
  }
  return items.map(i => toTrack(i.item || i.track, i.added_at)).filter(Boolean);
}

return { redirectUri, login, handleRedirect, isConnected, disconnect, toTrack, likedSongs, playlists, playlistTracks };
})();
// ---------- importers.js ----------
const __m_importers = (() => {
// Importers that need no account at all: CSV exports (e.g. Exportify), pasted
// text lists, and music files already on the device (read their tags).
const { trackKey, albumKey, yearOf, splitArtists } = __m_util;

function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

// Exportify's "saved_albums.csv" lists albums, not songs
function isAlbumCSV(text) {
  const head = (parseCSV(text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0])[0] || []).map(x => x.trim().toLowerCase());
  return head.includes('album name') && !head.some(x => x === 'track name' || x === 'title' || x === 'song');
}
function tracksFromCSV(text) {
  const rows = parseCSV(text.replace(/^\uFEFF/, ''));
  if (rows.length < 2) return [];
  const h = rows[0].map(x => x.trim().toLowerCase());
  const col = (...names) => h.findIndex(x => names.some(n => x === n || x.includes(n)));
  const ci = {
    title: col('track name', 'title', 'song', 'name'),
    artist: col('artist name', 'artist'),
    album: col('album name', 'album'),
    date: col('release date', 'album release date', 'year'),
    dur: col('duration (ms)', 'duration'),
    genre: col('genres', 'genre'),
    added: col('added at', 'date added'),
    uri: col('track uri', 'spotify uri', 'uri'),
    img: col('album image url', 'image url', 'artwork url', 'artwork', 'cover')
  };
  if (ci.title < 0 || ci.artist < 0) throw new Error('CSV needs at least a track/title column and an artist column.');
  return rows.slice(1).map(r => {
    const rawA = (r[ci.artist] || '').trim();
    // Artists are split on ";" or on commas that aren't escaped as "\," (no regex look-behind: older Safari can't parse it)
    const artists = (rawA.includes(';') ? rawA.split(';') : rawA.replace(/\\,/g, '\u0000').split(',')).map(a => a.replace(/\u0000/g, ',').trim()).filter(Boolean);
    const title = (r[ci.title] || '').trim(), artist = artists[0] || '';
    if (!title || !artist) return null;
    const album = ci.album >= 0 ? r[ci.album]?.trim() : '';
    let dur = ci.dur >= 0 ? r[ci.dur] : '';
    let durationMs = 0;
    if (/^\d+$/.test(dur)) durationMs = +dur > 10000 ? +dur : +dur * 1000;
    else if (/^\d+:\d\d$/.test(dur)) { const [m, s] = dur.split(':'); durationMs = (+m * 60 + +s) * 1000; }
    const genre = ci.genre >= 0 ? (r[ci.genre] || '').split(',')[0].trim() : '';
    const releaseDate = ci.date >= 0 ? (r[ci.date] || '').trim() : '';
    const uri = ci.uri >= 0 ? r[ci.uri] || '' : '';
    return {
      id: trackKey(artist, title), title, artist, artists,
      album, albumId: album ? albumKey(artist, album) : '',
      releaseDate, year: yearOf(releaseDate), durationMs,
      genre: genre ? genre.replace(/\b\w/g, c => c.toUpperCase()) : '',
      spotifyId: uri.startsWith('spotify:track:') ? uri.split(':')[2] : null,
      artwork: ci.img >= 0 && /^https:\/\//.test(r[ci.img] || '') ? r[ci.img].trim() : '',
      addedAt: ci.added >= 0 && Date.parse(r[ci.added]) ? Date.parse(r[ci.added]) : Date.now()
    };
  }).filter(Boolean);
}

// "Artist - Title", "Title by Artist", or "Artist – Title" one per line
function tracksFromText(text) {
  return text.split(/\r?\n/).map(l => l.replace(/^\s*\d+[\.\)]\s*/, '').trim()).filter(Boolean).map(l => {
    let artist, title, m;
    if ((m = l.match(/^(.+?)\s+[-–—]\s+(.+)$/))) { artist = m[1]; title = m[2]; }
    else if ((m = l.match(/^(.+?)\s+by\s+(.+)$/i))) { title = m[1]; artist = m[2]; }
    else return null;
    const artists = splitArtists(artist);
    return { id: trackKey(artists[0], title), title: title.trim(), artist: artists[0], artists, addedAt: Date.now() };
  }).filter(Boolean);
}

// ---- Minimal ID3v2 / filename tag reader for local music files ----
function readSyncsafe(b, o) { return (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3]; }
function decodeText(bytes) {
  const enc = bytes[0]; const body = bytes.subarray(1);
  let s;
  if (enc === 1 || enc === 2) s = new TextDecoder(enc === 2 ? 'utf-16be' : 'utf-16').decode(body);
  else if (enc === 3) s = new TextDecoder('utf-8').decode(body);
  else s = new TextDecoder('latin1').decode(body);
  return s.replace(/\0+$/g, '').split('\0')[0].trim();
}
async function readID3(file) {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (String.fromCharCode(...head.subarray(0, 3)) !== 'ID3') return {};
  const ver = head[3];
  const size = readSyncsafe(head, 6);
  const b = new Uint8Array(await file.slice(10, 10 + Math.min(size, 2_000_000)).arrayBuffer());
  const tags = {}; let o = 0;
  const map = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TYER: 'year', TDRC: 'year', TCON: 'genre', TRCK: 'track', TPE2: 'albumArtist' };
  while (o + 10 < b.length) {
    const id = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fsz = ver === 4 ? readSyncsafe(b, o + 4) : (b[o + 4] << 24) | (b[o + 5] << 16) | (b[o + 6] << 8) | b[o + 7];
    if (fsz <= 0 || o + 10 + fsz > b.length) break;
    const data = b.subarray(o + 10, o + 10 + fsz);
    if (map[id]) tags[map[id]] = decodeText(data);
    if (id === 'APIC' && !tags.picture) {
      try {
        let p = 1; while (data[p]) p++; const mime = new TextDecoder('latin1').decode(data.subarray(1, p)) || 'image/jpeg';
        p += 2; // picture type
        if (data[0] === 1 || data[0] === 2) { while (p < data.length - 1 && !(data[p] === 0 && data[p + 1] === 0)) p += 2; p += 2; }
        else { while (data[p]) p++; p++; }
        tags.picture = new Blob([data.subarray(p)], { type: mime });
      } catch { }
    }
    o += 10 + fsz;
  }
  if (tags.genre) tags.genre = tags.genre.replace(/^\(\d+\)/, '').trim();
  return tags;
}

async function readLocalFile(file) {
  let tags = {};
  try { tags = await readID3(file); } catch { }
  const base = file.name.replace(/\.[^.]+$/, '').replace(/^\d+[\s.\-_]+/, '');
  let artist = tags.artist, title = tags.title;
  if (!artist || !title) {
    const m = base.match(/^(.+?)\s+-\s+(.+)$/);
    if (m) { artist = artist || m[1]; title = title || m[2]; }
    else { title = title || base; artist = artist || (file.webkitRelativePath?.split('/').slice(-3, -2)[0]) || 'Unknown Artist'; }
  }
  return {
    artist: artist.trim(), title: title.trim(), album: tags.album || '', albumArtist: tags.albumArtist || '',
    year: yearOf(tags.year), genre: tags.genre || '', trackNumber: parseInt(tags.track) || 0, picture: tags.picture || null
  };
}

const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm|mp4)$/i;

// ---------- Apple Music / iTunes exports ----------
// Music app (Mac) or Apple Music / iTunes (Windows):
//   File → Library → Export Playlist…  → "Plain Text" (.txt, UTF-16, tab separated)
//   File → Library → Export Library…   → .xml (every playlist + Loved songs)
async function readTextSmart(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  // UTF-16 without BOM: lots of zero bytes
  let zeros = 0; for (let i = 1; i < Math.min(buf.length, 400); i += 2) if (buf[i] === 0) zeros++;
  if (zeros > 100) return new TextDecoder('utf-16le').decode(buf);
  return new TextDecoder('utf-8').decode(buf).replace(/^﻿/, '');
}

function appleTrack(o) {
  const title = (o.title || '').trim();
  const artists = splitArtists(o.artist), artist = artists[0] || '';
  if (!title || !artist) return null;
  const year = parseInt(o.year) || null;
  return {
    id: trackKey(artist, title), title, artist, artists,
    album: (o.album || '').trim(), albumId: o.album ? albumKey(o.albumArtist || artist, o.album) : '',
    genre: (o.genre || '').trim(), year, releaseDate: o.releaseDate || (year ? String(year) : ''),
    durationMs: o.durationMs || 0, trackNumber: parseInt(o.trackNumber) || 0,
    addedAt: o.added && Date.parse(o.added) ? Date.parse(o.added) : Date.now()
  };
}

// Plain-text playlist export (tab separated, first row = headers)
function tracksFromAppleTxt(text) {
  const lines = text.split(/\r\n|\r|\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const h = lines[0].split('\t').map(x => x.trim().toLowerCase());
  const ix = n => h.indexOf(n);
  const c = { name: ix('name'), artist: ix('artist'), album: ix('album'), genre: ix('genre'), year: ix('year'), time: ix('time'), track: ix('track number'), added: ix('date added'), albumArtist: ix('album artist') };
  if (c.name < 0 || c.artist < 0) throw new Error('This doesn\'t look like an Apple Music playlist export (needs Name and Artist columns).');
  return lines.slice(1).map(l => {
    const r = l.split('\t');
    const t = +r[c.time];
    return appleTrack({
      title: r[c.name], artist: r[c.artist], album: r[c.album], genre: r[c.genre], year: r[c.year],
      durationMs: isFinite(t) && t > 0 ? (t > 20000 ? t : t * 1000) : 0, trackNumber: r[c.track], added: r[c.added],
      albumArtist: c.albumArtist >= 0 ? r[c.albumArtist] : ''
    });
  }).filter(Boolean);
}

// Full library export (XML property list)
function fromAppleXML(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Couldn\'t read that XML file.');
  const val = el => {
    if (!el) return null;
    switch (el.tagName) {
      case 'dict': { const o = {}; const k = [...el.children]; for (let i = 0; i < k.length; i += 2) o[k[i].textContent] = val(k[i + 1]); return o; }
      case 'array': return [...el.children].map(val);
      case 'integer': case 'real': return +el.textContent;
      case 'true': return true; case 'false': return false;
      case 'data': return null;
      default: return el.textContent;
    }
  };
  const root = val(doc.querySelector('plist > dict'));
  if (!root?.Tracks) throw new Error('This doesn\'t look like an Apple Music library export.');
  const byId = new Map(), loved = [];
  for (const [tid, o] of Object.entries(root.Tracks)) {
    if (o['Has Video'] || o['Movie'] || o['TV Show'] || o['Podcast'] || o['Music Video']) continue;
    const t = appleTrack({
      title: o.Name, artist: o.Artist || o['Album Artist'], album: o.Album, albumArtist: o['Album Artist'], genre: o.Genre, year: o.Year,
      releaseDate: o['Release Date'] ? String(o['Release Date']).slice(0, 10) : '', durationMs: o['Total Time'] || 0,
      trackNumber: o['Track Number'], added: o['Date Added']
    });
    if (!t) continue;
    byId.set(String(tid), t);
    if (o.Loved || o.Favorited) loved.push(t.id);
  }
  const SKIP = /^(Library|Music|Movies|TV Shows|Podcasts|Audiobooks|Downloaded|Purchased|Genius|Recently (Added|Played)|Top 25 Most Played)$/i;
  const playlists = (root.Playlists || []).filter(p => !p.Master && !p['Distinguished Kind'] && !p.Folder && !SKIP.test(p.Name || '') && p['Playlist Items']?.length)
    .map(p => ({ name: p.Name, smart: !!p['Smart Info'], trackIds: [...new Set(p['Playlist Items'].map(i => byId.get(String(i['Track ID']))?.id).filter(Boolean))] }))
    .filter(p => p.trackIds.length);
  return { tracks: [...byId.values()], playlists, loved };
}


// ---------- ZIP files (Exportify's "Export All" downloads a .zip of CSVs) ----------
// Tiny reader: walks the zip's central directory and inflates each entry with the browser's
// built-in DecompressionStream (Chrome, Edge, Safari 16.4+, Firefox 113+).
async function unzipText(file, want = n => /\.csv$/i.test(n)) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('That zip file looks damaged — try downloading it again.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  const td = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = td.decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/') || !want(name)) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = buf.subarray(start, start + csize);
    let bytes;
    if (method === 0) bytes = data;
    else if (method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('This browser can\'t open zip files — unzip it first and choose the .csv files instead.');
      bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    } else continue;
    out.push({ name: name.split('/').pop(), text: td.decode(bytes) });
  }
  return out;
}

return { parseCSV, isAlbumCSV, tracksFromCSV, tracksFromText, readLocalFile, AUDIO_EXT, readTextSmart, tracksFromAppleTxt, fromAppleXML, unzipText };
})();
// ---------- player.js ----------
const __m_player = (() => {
// Playback engine: YouTube (music video or audio upload) or an offline file on the device.
const { db, kv } = __m_db;
const { lib } = __m_store;
const store = __m_store;
const yt = __m_youtube;
const { emit, toast, debounce } = __m_util;
const { logoSrc } = __m_ui;

const P = {
  queue: [],          // [{id, user}]
  origin: '',         // where the queue came from: 'mix' (BAZINGA! button) or '' (a list played as-is)
  cursor: -1,
  mode: 'video',      // 'video' | 'audio' — music video is the default
  preferOffline: true,
  shuffle: false,
  repeat: 'off',      // off | all | one
  playing: false,
  loading: false,
  source: null,       // 'yt' | 'local'
  ytId: null,
  time: 0, duration: 0,
  volume: 0.9,
  error: ''
};

const audio = new Audio();
audio.preload = 'auto';
let ytPlayer = null, ytReady = null, tick = null, objUrl = null, loadToken = 0;
let wantPlay = false;      // the listener wants music playing (used to undo pauses the phone does on its own)
let resumeAt = 0, resumeFor = null; // where to pick up the restored song after a refresh
let duckLevel = 1;         // temporary volume dip while the voice assistant talks (never saved)
let endHook = null;        // app.js: what to play when the queue runs out
let pausedDuring = -1;     // the listener paused while this load was still starting
let verify = null;         // checks that an instant "play" really started
// Read-only: does the listener want music playing right now? (drives instant Play/Pause feedback)
Object.defineProperty(P, 'want', { get: () => wantPlay, enumerable: false });
// What every Play/Pause button should show: flips the moment you tap, no waiting for YouTube
const isOn = () => P.playing || (wantPlay && P.loading);

const changed = () => {
  emit('player', P);
  if ('mediaSession' in navigator) try { navigator.mediaSession.playbackState = current() ? (P.playing || (wantPlay && P.loading) ? 'playing' : 'paused') : 'none'; } catch { }
};
const persist = debounce(() => kv.set('player', {
  queue: P.queue, cursor: P.cursor, origin: P.origin, mode: P.mode, shuffle: P.shuffle, repeat: P.repeat, volume: P.volume, preferOffline: P.preferOffline,
  time: Math.floor(P.time || 0)
}), 500);
const setEndHook = fn => { endHook = fn; };
const outVol = () => Math.max(0, Math.min(1, P.volume * duckLevel));

// Ask the phone for a proper music audio session (high quality, keeps playing when locked).
// Safari 17+ supports this; elsewhere it's a harmless no-op.
function audioMode(type = 'playback') { try { if (navigator.audioSession && navigator.audioSession.type !== type) navigator.audioSession.type = type; } catch { } }

const current = () => (P.cursor >= 0 && P.queue[P.cursor]) ? lib.tracks.get(P.queue[P.cursor].id) : null;

async function restore() {
  const s = await kv.get('player');
  if (s) { Object.assign(P, s, { playing: false }); resumeAt = +s.time || 0; P.time = resumeAt; }
  // v1.6: music video is the default for everyone (once); switching to Audio afterwards is remembered
  if (!(await kv.get('videoDefault'))) { P.mode = 'video'; await kv.set('videoDefault', 1); persist(); }
  P.queue = P.queue.filter(q => lib.tracks.has(q.id));
  if (P.cursor >= P.queue.length) P.cursor = P.queue.length - 1;
  const t = current();
  if (t) P.duration = (t.durationMs || 0) / 1000;
  if (resumeAt && P.duration && resumeAt > P.duration - 5) resumeAt = P.time = 0;
  resumeFor = t?.id || null;
  audio.volume = P.volume;
  setupMediaSession();
  changed();
  // Look up the restored song (and the next ones) in the background, so "Resume" starts instantly
  if (t) setTimeout(() => { prefetch(t.id); prefetchNext(loadToken); }, 1200);
}

// ---------- YouTube IFrame player ----------
function loadYT() {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => {
      ytPlayer = new YT.Player('yt-player', {
        width: '100%', height: '100%',
        // cc_load_policy 0 + unloading the captions module = no subtitles by default
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, cc_load_policy: 0, iv_load_policy: 3, ...(location.protocol.startsWith('http') ? { origin: location.origin } : {}) },
        events: {
          onReady: () => { ytPlayer.setVolume(outVol() * 100); resolve(ytPlayer); },
          onStateChange: e => {
            if (P.source !== 'yt') return;
            if (e.data === YT.PlayerState.PLAYING && !wantPlay && pausedDuring === loadToken) { try { ytPlayer.pauseVideo(); } catch { } P.loading = false; changed(); return; }
            if (e.data === YT.PlayerState.PLAYING) { P.playing = true; P.loading = false; P.needsTap = false; wantPlay = true; resumeTries = 0; noCaptions(); if (!tick) startTick(); changed(); }
            else if (e.data === YT.PlayerState.PAUSED) {
              if (isRerouting()) return;
              // Phones pause YouTube when you leave the browser or lock the screen. If you didn't
              // ask for that, start it again straight away.
              // (Only right after leaving / a new song starting — a pause you make later from the lock screen is respected.)
              if (wantPlay && document.hidden && (Date.now() - hiddenAt < 8000 || Date.now() - startedAt < 8000) && resumeTries < 10) { resumeTries++; setTimeout(() => { try { if (wantPlay) ytPlayer.playVideo(); } catch { } }, Math.min(150 * resumeTries, 1500)); return; }
              P.playing = false; P.loading = false; if (!document.hidden) wantPlay = false; changed();
            }
            else if (e.data === YT.PlayerState.ENDED) ended();
            else if (e.data === YT.PlayerState.BUFFERING) { if (!P.loading) { P.loading = true; changed(); } }
            else if (e.data === YT.PlayerState.CUED && wantPlay) ytPlayer.playVideo();
          },
          onError: e => ytError(e.data)
        }
      });
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytReady = null; reject(new Error('Could not load YouTube player (offline?)')); };
    document.head.appendChild(s);
  });
  return ytReady;
}

let ytRetried = false, resumeTries = 0, hiddenAt = 0, startedAt = 0, captionsOffFor = null;
function noCaptions() {
  if (captionsOffFor === P.ytId) return; captionsOffFor = P.ytId;
  try { ytPlayer.unloadModule('captions'); ytPlayer.unloadModule('cc'); } catch { }
  try { ytPlayer.setOption('captions', 'track', {}); } catch { }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    // Back in the app: if the phone stopped the music while you were away, carry on right where it was
    resumeTries = 0;
    if (!wantPlay) return;
    if (P.source === 'yt') { try { const st = ytPlayer?.getPlayerState?.(); if (st === 2 || st === 5 || st === -1) ytPlayer.playVideo(); } catch { } }
    else if (P.source === 'local' && audio.paused) audio.play().catch(() => { });
    return;
  }
  hiddenAt = Date.now(); resumeTries = 0;
  audioMode('playback');
  // Leaving the browser / locking the phone: keep going
  if (wantPlay && P.source === 'yt') setTimeout(() => { try { if (wantPlay && ytPlayer?.getPlayerState?.() !== 1) ytPlayer.playVideo(); } catch { } }, 500);
  if (wantPlay && P.source === 'local' && audio.paused) audio.play().catch(() => { });
  persist();
});
async function ytError(code) {
  const t = current(); if (!t) return;
  // 101/150 = embedding disabled by owner; try the other version, then re-search once
  const c = await db.get('ytcache', t.id) || {};
  const other = P.mode === 'video' ? 'audio' : 'video';
  if (c[other] && c[other] !== P.ytId) { toast('That upload can\'t be embedded — using the ' + other + ' version'); return startYT(c[other]); }
  if (!ytRetried) {
    ytRetried = true;
    try { const n = await yt.findForTrack(t, { force: true }); const id = n[P.mode] || n[other]; if (id && id !== P.ytId) return startYT(id); } catch { }
  }
  P.error = 'YouTube won\'t play this one here (code ' + code + '). Set a different link from the ⋯ menu.';
  P.loading = false; changed();
  setTimeout(() => { if (P.error) next(); }, 2500);
}

let tickN = 0;
function startTick() {
  clearInterval(tick);
  tick = setInterval(() => {
    if (P.source === 'yt' && ytPlayer?.getCurrentTime) {
      P.time = ytPlayer.getCurrentTime() || 0;
      P.duration = ytPlayer.getDuration() || P.duration;
    } else if (P.source === 'local') {
      P.time = audio.currentTime; P.duration = audio.duration || P.duration;
    }
    emit('time', P);
    updatePositionState();
    if (P.playing && ++tickN % 10 === 0) persist(); // remember the spot every ~5 s
  }, 500);
}

let startWatch = null;
async function startYT(id, start = 0) {
  P.source = 'yt'; P.ytId = id; P.loading = true; P.needsTap = false; changed();
  startedAt = Date.now(); if (document.hidden) resumeTries = 0;
  const pl = await loadYT();
  pl.loadVideoById(start > 1 ? { videoId: id, startSeconds: start } : id);
  pl.setVolume(outVol() * 100);
  emit('video-visible', true);
  // Some phones (iPhone especially) only let YouTube start after you tap the video itself once.
  // If nothing has started after a few seconds, show the video so one tap starts it.
  clearTimeout(startWatch);
  const my = loadToken;
  startWatch = setTimeout(() => {
    if (my !== loadToken || !wantPlay || P.source !== 'yt' || document.hidden) return;
    let st = -9; try { st = ytPlayer.getPlayerState(); } catch { }
    if (st === -1 || st === 5 || st === 2 && !P.playing) { P.needsTap = true; P.loading = false; changed(); emit('needs-tap'); }
  }, 3500);
}
// Load the YouTube player in the background right after start-up, so the first song starts instantly
function warmup() { if (location.protocol.startsWith('http') && navigator.onLine) loadYT().catch(() => { }); }

// ---------- Core ----------
async function load(autoplay = true) {
  const my = ++loadToken;
  const t = current();
  const at = resumeFor && resumeFor === t?.id ? resumeAt : 0; resumeAt = 0; resumeFor = null;
  audio.pause();
  if (P.source !== 'yt') { try { ytPlayer?.pauseVideo?.(); } catch { } }
  P.error = ''; P.time = at; P.duration = (t?.durationMs || 0) / 1000; ytRetried = false;
  if (!t) { P.playing = false; P.source = null; wantPlay = false; changed(); return; }
  if (autoplay) { wantPlay = true; audioMode('playback'); }
  P.loading = true; changed();
  setMediaSession(t);
  persist();

  // Offline file first (if user prefers it or we're offline)
  if (t.localFileId && (P.preferOffline || !navigator.onLine)) {
    const f = await db.get('files', t.localFileId);
    if (my !== loadToken) return;
    if (f?.blob) {
      if (objUrl) URL.revokeObjectURL(objUrl);
      objUrl = URL.createObjectURL(f.blob);
      P.source = 'local'; P.ytId = null;
      emit('video-visible', false);
      audio.src = objUrl;
      audio.volume = outVol();
      if (at) audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = at; } catch { } }, { once: true });
      if (autoplay) audio.play().catch(() => { P.playing = false; changed(); });
      P.loading = false; changed(); startTick();
      return;
    }
  }
  if (!navigator.onLine) {
    P.error = 'You\'re offline and this song has no offline file. Skipping…'; P.loading = false; changed();
    setTimeout(() => my === loadToken && next(), 1500); return;
  }
  try {
    const c = await yt.findForTrack(t, { need: P.mode });
    if (my !== loadToken) return;
    const id = c[P.mode] || c[P.mode === 'video' ? 'audio' : 'video'];
    if (!t.artwork) store.coverFromVideo(t.id, c.audio || c.video);
    if (!id) throw new Error('No YouTube match found for this song. Use ⋯ → "Set YouTube link".');
    if (!c[P.mode]) toast(`No ${P.mode === 'video' ? 'music video' : 'audio upload'} found — playing the other version`);
    await startYT(id, at);
    if (!autoplay) ytPlayer.pauseVideo();
    startTick();
    prefetchNext(my);
  } catch (e) {
    if (my !== loadToken) return;
    P.error = e.message; P.loading = false; P.playing = false; changed();
  }
}

// Look up the next couple of songs while this one plays, so skipping is instant.
function prefetchNext(my) {
  setTimeout(() => {
    if (my !== loadToken || !navigator.onLine) return;
    const around = [...P.queue.slice(P.cursor + 1, P.cursor + 6), ...(P.cursor > 0 ? [P.queue[P.cursor - 1]] : [])];
    // one after another (the very next song first), so they never compete with each other
    (async () => { for (const q of around) {
      if (my !== loadToken) return;
      const t = lib.tracks.get(q.id);
      if (t && !(t.localFileId && P.preferOffline)) await yt.findForTrack(t, { need: P.mode }).catch(() => { });
    } })();
  }, 300);
}
// Start looking up a song the moment the pointer rests on it, so tapping it plays right away
function prefetch(id) {
  const t = lib.tracks.get(id);
  if (t && navigator.onLine && !(t.localFileId && P.preferOffline)) yt.findForTrack(t, { need: P.mode }).catch(() => { });
}

// Sleep timer: "stop at the end of this song"
let stopAfterSong = false;
const setStopAfterSong = on => { stopAfterSong = !!on; };
const stopsAfterSong = () => stopAfterSong;
// Sleep timer: gently fade the music out, then pause (the saved volume is never touched)
let fadeT = null;
function fadeOutAndPause(ms = 8000) {
  clearInterval(fadeT);
  const t0 = Date.now(), from = duckLevel;
  fadeT = setInterval(() => {
    const k = Math.min(1, (Date.now() - t0) / ms);
    duckLevel = from * (1 - k); applyVol();
    if (k >= 1) { clearInterval(fadeT); pause(); setTimeout(() => { duckLevel = 1; applyVol(); }, 400); emit('sleep-done'); }
  }, 100);
}
const cancelFade = () => { if (fadeT) { clearInterval(fadeT); fadeT = null; duckLevel = 1; applyVol(); } };
function ended() {
  if (stopAfterSong) { stopAfterSong = false; seek(0); pause(); emit('sleep-done'); return; }
  if (P.repeat === 'one') { seek(0); play(); return; }
  next(true);
}
audio.addEventListener('ended', () => P.source === 'local' && ended());
audio.addEventListener('play', () => { P.playing = true; if (!tick) startTick(); changed(); });
audio.addEventListener('pause', () => { if (isRerouting()) return; P.playing = false; changed(); });
audio.addEventListener('error', () => { if (P.source === 'local') { P.error = 'Could not play the offline file.'; changed(); } });

// Play/pause update every button instantly (optimistic); the player then catches up.
function play() {
  if (!current()) return;
  wantPlay = true; pausedDuring = -1; audioMode('playback');
  if (P.source === 'local') { P.playing = true; changed(); audio.play().catch(() => { P.playing = false; changed(); }); }
  else if (P.source === 'yt' && ytPlayer) {
    P.playing = true; P.error = ''; changed();
    try { ytPlayer.playVideo(); } catch { }
    // If the phone refused to start it, show the real state again
    clearTimeout(verify);
    verify = setTimeout(() => { let st = -9; try { st = ytPlayer.getPlayerState(); } catch { } if (wantPlay && st !== 1 && st !== 3 && !document.hidden) { P.playing = false; P.loading = false; changed(); } }, 2500);
  }
  else load(true);
}
function pause() {
  wantPlay = false; pausedDuring = loadToken; clearTimeout(verify);
  P.playing = false; P.loading = false; changed();
  if (P.source === 'local') audio.pause();
  else if (ytPlayer?.pauseVideo) try { ytPlayer.pauseVideo(); } catch { }
}
const toggle = () => isOn() ? pause() : play();

function seek(sec) {
  if (!P.source) { resumeAt = sec; resumeFor = current()?.id || null; } // not started yet (e.g. after a refresh): start from here
  if (P.source === 'local') audio.currentTime = sec;
  else ytPlayer?.seekTo?.(sec, true);
  P.time = sec; emit('time', P);
}

// Worth saving as a new playlist? Only a queue BAZINGA! made or one that's shuffled — a list playing
// in its own order already exists as that playlist/album.
const queueIsNew = () => P.queue.length > 1 && (P.origin === 'mix' || !!P.shuffle);
function next(auto = false) {
  if (!P.queue.length) return;
  if (P.cursor < P.queue.length - 1) P.cursor++;
  else if (P.repeat === 'all') P.cursor = 0;
  else {
    // Queue finished: autoplay (replay the queue or start Liked Songs — Settings → Playback)
    const plan = endHook?.(P.queue.map(q => q.id));
    if (plan?.ids?.length) {
      let list = plan.ids.filter(id => lib.tracks.has(id)).map(id => ({ id, user: false }));
      if (plan.shuffle) list.sort(() => Math.random() - 0.5);
      if (list.length) { P.queue = list; P.cursor = 0; P.origin = ''; if (plan.msg) toast(plan.msg); load(true); return; }
    }
    if (auto) { P.playing = false; wantPlay = false; changed(); }
    return;
  }
  load(true);
}
function prev() {
  if (P.time > 4) return seek(0);
  if (P.cursor > 0) { P.cursor--; load(true); }
  else seek(0);
}

// Replace the queue with a list and start at `start`
function playList(ids, start = 0, { shuffle = P.shuffle, origin = '' } = {}) {
  ids = ids.filter(id => lib.tracks.has(id));
  if (!ids.length) return toast('Nothing to play');
  let list = ids.map(id => ({ id, user: false }));
  if (shuffle) {
    const first = list.splice(start, 1)[0];
    list.sort(() => Math.random() - 0.5);
    list.unshift(first); start = 0;
  }
  P.queue = list; P.cursor = start; P.shuffle = shuffle; P.origin = origin;
  load(true);
}

// Add to the end of the "up next" user section (after the current song and any user-queued songs)
function addToQueue(ids, playNext = false) {
  ids = [].concat(ids).filter(id => lib.tracks.has(id));
  if (!ids.length) return;
  const items = ids.map(id => ({ id, user: true }));
  if (P.cursor < 0) { P.queue = items; P.cursor = 0; load(true); return; }
  let at = P.cursor + 1;
  if (!playNext) while (at < P.queue.length && P.queue[at].user) at++;
  P.queue.splice(at, 0, ...items);
  persist(); changed();
  toast(ids.length === 1 ? (playNext ? 'Playing next' : 'Added to queue') : `${ids.length} songs added to queue`);
}
// Quietly add songs to the end of the queue (used while the BAZINGA! mix is still being built)
function appendToQueue(ids) {
  ids = [].concat(ids).filter(id => lib.tracks.has(id) && !P.queue.some(q => q.id === id));
  if (!ids.length) return;
  P.queue.push(...ids.map(id => ({ id, user: false })));
  persist(); changed();
}
function removeFromQueue(i) {
  if (i === P.cursor) return;
  P.queue.splice(i, 1);
  if (i < P.cursor) P.cursor--;
  persist(); changed();
}
function moveInQueue(from, to) {
  if (from === to) return;
  const [it] = P.queue.splice(from, 1);
  P.queue.splice(to, 0, it);
  if (P.cursor === from) P.cursor = to;
  else if (from < P.cursor && to >= P.cursor) P.cursor--;
  else if (from > P.cursor && to <= P.cursor) P.cursor++;
  persist(); changed();
}
function jumpTo(i) { P.cursor = i; load(true); }
function clearQueue() { P.queue = P.queue.slice(0, P.cursor + 1); persist(); changed(); }
function clearUserQueue() { P.queue = P.queue.filter((q, i) => i <= P.cursor || !q.user); persist(); changed(); }

function setShuffle(v) {
  P.shuffle = v;
  if (v && P.cursor >= 0) {
    const rest = P.queue.slice(P.cursor + 1).sort(() => Math.random() - 0.5);
    P.queue = [...P.queue.slice(0, P.cursor + 1), ...rest];
  }
  persist(); changed();
}
function cycleRepeat() { P.repeat = { off: 'all', all: 'one', one: 'off' }[P.repeat]; persist(); changed(); }
function setVolume(v) { P.volume = v; duckLevel = 1; applyVol(); persist(); changed(); }
function applyVol() { audio.volume = outVol(); try { ytPlayer?.setVolume?.(outVol() * 100); } catch { } }
// Silence the music while the voice assistant is on screen, without touching the saved volume
function duck(on) { duckLevel = on ? 0 : 1; applyVol(); }

// Switch between music video and audio-only version, keeping position
async function setMode(mode) {
  if (mode === P.mode) return;
  P.mode = mode; persist(); changed();
  const t = current();
  if (t && P.source === 'yt') {
    const at = P.time, wasPlaying = P.playing;
    const c = await yt.findForTrack(t);
    const id = c[mode];
    if (!id) { toast(`No ${mode === 'video' ? 'music video' : 'audio version'} found for this song`); return; }
    await startYT(id, at);
    if (!wasPlaying) setTimeout(() => ytPlayer.pauseVideo(), 600);
  }
}
function setPreferOffline(v) { P.preferOffline = v; persist(); }
const reloadCurrent = () => load(true);
// Restart the sound output in place (fixes thin "phone call" audio after the microphone was used)
let rerouting = 0;
function refreshOutput() {
  if (!P.playing) return;
  rerouting = Date.now();
  if (P.source === 'local') { const at = audio.currentTime; audio.pause(); setTimeout(() => { try { audio.currentTime = at; } catch { } audio.play().catch(() => { }); }, 120); }
  else if (P.source === 'yt' && ytPlayer) { try { ytPlayer.pauseVideo(); setTimeout(() => ytPlayer.playVideo(), 160); } catch { } }
}
const isRerouting = () => Date.now() - rerouting < 1500;

// ---------- Lock screen / media keys ----------
function setMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album || '',
      artwork: t.artwork && !t.artwork.startsWith('data:') ? [{ src: t.artwork, sizes: '600x600', type: 'image/jpeg' }] : [{ src: logoSrc('icon-512'), sizes: '512x512', type: 'image/png' }]
    });
  } catch { }
}
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const h = (k, fn) => { try { ms.setActionHandler(k, fn); } catch { } };
  h('play', play); h('pause', pause); h('stop', pause);
  h('previoustrack', prev); h('nexttrack', () => next());
  h('seekto', d => seek(d.seekTime));
  h('seekbackward', d => seek(Math.max(0, P.time - (d.seekOffset || 10))));
  h('seekforward', d => seek(Math.min(P.duration || 1e9, P.time + (d.seekOffset || 10))));
  const t = current(); if (t) setMediaSession(t);
}
function updatePositionState() {
  if (!('mediaSession' in navigator) || !P.duration) return;
  try { navigator.mediaSession.setPositionState({ duration: P.duration, position: Math.min(P.time, P.duration), playbackRate: 1 }); } catch { }
}

// Stop everything (used when deleting the account)
function stopAll() {
  loadToken++; wantPlay = false; audio.pause(); audio.removeAttribute('src');
  try { ytPlayer?.stopVideo?.(); } catch { }
  P.queue = []; P.cursor = -1; P.playing = false; changed();
}

return { P, isOn, setEndHook, audioMode, current, restore, warmup, prefetch, setStopAfterSong, stopsAfterSong, fadeOutAndPause, cancelFade, play, pause, toggle, seek, queueIsNew, next, prev, playList, addToQueue, appendToQueue, removeFromQueue, moveInQueue, jumpTo, clearQueue, clearUserQueue, setShuffle, cycleRepeat, setVolume, duck, setMode, setPreferOffline, reloadCurrent, refreshOutput, stopAll };
})();
// ---------- backup.js ----------
const __m_backup = (() => {
// Auto-updating backups, all on the user's own device:
//  • Rolling snapshots inside the app's storage (last 5) — instant undo for mistakes.
//  • A linked backup FILE on the device (Chrome/Edge desktop): rewritten automatically on every change,
//    so it survives even if the browser's data is wiped.
//  • One-tap download / restore of a .json backup file on every browser.
const { db, kv } = __m_db;
const { debounce, emit, downloadBlob, on, toast } = __m_util;

const KEEP = 5;
const fsSupported = 'showSaveFilePicker' in window;

async function snapshot() {
  const [tracks, albums, playlists] = await Promise.all([db.all('tracks'), db.all('albums'), db.all('playlists')]);
  const ytKeys = await db.keys('ytcache');
  const ytVals = await db.all('ytcache');
  return {
    app: 'BAZINGA', version: 1, createdAt: new Date().toISOString(),
    profile: await kv.get('profile'),
    settings: await kv.get('settings'),
    player: await kv.get('player'),
    tracks: tracks.map(t => ({ ...t, localFileId: undefined, hadLocalFile: !!t.localFileId || t.hadLocalFile })),
    albums, playlists,
    ytcache: ytKeys.map((k, i) => [k, ytVals[i]])
  };
}

async function restore(data) {
  if (!data || data.app !== 'BAZINGA') throw new Error('That isn\'t a BAZINGA backup file.');
  // Keep links to offline files that still exist on this device
  const existing = new Map((await db.all('tracks')).filter(t => t.localFileId).map(t => [t.id, t.localFileId]));
  for (const s of ['tracks', 'albums', 'playlists', 'ytcache']) await db.clear(s);
  await db.putMany('tracks', (data.tracks || []).map(t => {
    const x = { ...t }; delete x.localFileId;
    if (existing.has(t.id)) x.localFileId = existing.get(t.id);
    return x;
  }));
  await db.putMany('albums', data.albums || []);
  await db.putMany('playlists', data.playlists || []);
  for (const [k, v] of data.ytcache || []) await db.put('ytcache', v, k);
  if (data.profile) await kv.set('profile', data.profile);
  if (data.settings) await kv.set('settings', data.settings);
  if (data.player) await kv.set('player', data.player);
}

async function writeInternal(snap) {
  const id = 'bk_' + Date.now();
  await db.put('backups', { id, ts: Date.now(), size: JSON.stringify(snap).length, counts: { tracks: snap.tracks.length, playlists: snap.playlists.length, albums: snap.albums.length }, data: snap });
  const all = (await db.all('backups')).sort((a, b) => b.ts - a.ts);
  for (const old of all.slice(KEEP)) await db.del('backups', old.id);
}

let fileState = 'none'; // none | ok | needs-permission | error
const linkedFileState = () => fileState;

async function writeFile(snap) {
  const h = await kv.get('backupHandle');
  if (!h) { fileState = 'none'; return; }
  const perm = await h.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') { fileState = 'needs-permission'; emit('backup-state'); return; }
  try {
    const w = await h.createWritable();
    await w.write(JSON.stringify(snap));
    await w.close();
    fileState = 'ok';
  } catch (e) { fileState = 'error'; console.warn(e); }
}

async function runBackup() {
  const profile = await kv.get('profile');
  if (!profile) return; // no account yet
  const snap = await snapshot();
  await writeInternal(snap);
  if (fsSupported) await writeFile(snap);
  await kv.set('lastBackup', Date.now());
  emit('backup-state');
}

const scheduled = debounce(runBackup, 4000);
function startAuto() {
  on('dirty', scheduled);
  // Also back up when the app is hidden/closed so nothing is lost
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') runBackup(); });
  // Check linked file permission on start
  kv.get('backupHandle').then(async h => {
    if (!h) return;
    fileState = (await h.queryPermission({ mode: 'readwrite' })) === 'granted' ? 'ok' : 'needs-permission';
    emit('backup-state');
  });
}

async function linkFile() {
  const h = await window.showSaveFilePicker({
    suggestedName: 'BAZINGA-backup.json',
    types: [{ description: 'BAZINGA backup', accept: { 'application/json': ['.json'] } }]
  });
  await kv.set('backupHandle', h);
  fileState = 'ok';
  await runBackup();
  toast('Auto-backup file linked — it updates itself on every change');
}
async function regrant() {
  const h = await kv.get('backupHandle'); if (!h) return;
  if ((await h.requestPermission({ mode: 'readwrite' })) === 'granted') { fileState = 'ok'; await runBackup(); toast('Auto-backup resumed'); }
}
async function unlinkFile() { await kv.del('backupHandle'); fileState = 'none'; emit('backup-state'); }

async function download() {
  const snap = await snapshot();
  const d = new Date().toISOString().slice(0, 10);
  downloadBlob(new Blob([JSON.stringify(snap)], { type: 'application/json' }), `BAZINGA-backup-${d}.json`);
  await kv.set('lastDownload', Date.now());
  emit('backup-state');
}

const listInternal = async () => (await db.all('backups')).sort((a, b) => b.ts - a.ts);
async function restoreInternal(id) { const b = await db.get('backups', id); if (b) await restore(b.data); }
async function restoreFromFile(file) { await restore(JSON.parse(await file.text())); }

return { fsSupported, snapshot, restore, linkedFileState, runBackup, startAuto, linkFile, regrant, unlinkFile, download, listInternal, restoreInternal, restoreFromFile };
})();
// ---------- sync.js ----------
const __m_sync = (() => {
// No-login, no-setup device sync.
// A "sync key" (a long random secret made on the first device) is the only thing that ties
// devices together. Other devices and browsers join by scanning a QR code, opening a link, or
// typing a short code that works for 15 minutes. Nothing about the person is ever asked for.
//
// Transport: the free public ntfy.sh relay (no account, nothing for the app owner to set up).
// The whole library (songs, likes, playlists, albums, YouTube matches, name & picture) is
// compressed and ENCRYPTED on the device with a key derived from the sync key, then posted to a
// topic whose name is a one-way hash of that key. ntfy.sh only ever sees unreadable bytes.
// Copies on the relay last about 3 hours, so every open device re-posts its library at least once
// an hour, and devices merge whatever is newer (newest edit wins per item, likes merge
// separately, deletions are remembered). Your own device always keeps the full library.
const { db, kv, SYNC_KV, onSyncedKvChange } = __m_db;
const { emit, on, debounce } = __m_util;
const store = __m_store;
const backup = __m_backup;

const S = { status: 'off', lastSync: 0, error: '', rev: 0 };
const state = () => S;
let link = null;         // { secret, since, lastId, lastTs, pubTs, hash }
let keys = null;         // { id, key } derived from link.secret
let running = null, again = false, started = false;

const available = () => !!window.crypto?.subtle && location.protocol.startsWith('http');
const RELAY = () => ((window.BAZINGA_CONFIG || {}).syncRelay || 'https://ntfy.sh').replace(/\/$/, '');
const linked = () => !!link?.secret;
const linkInfo = () => link;

const deviceName = () => {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'device';
  const br = /EdgA?\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /OPR\//.test(ua) ? 'Opera' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} on ${os}`;
};
function setStatus(status, error = '') { S.status = status; S.error = error; if (status === 'synced') S.lastSync = Date.now(); emit('sync', S); }

// ---------- keys & links ----------
const b64url = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
async function derive(secret) {
  const id = hex(await sha('bazinga-sync-id:' + secret));
  const key = await crypto.subtle.importKey('raw', await sha('bazinga-sync-key:' + secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { id, key };
}
const newSecret = () => b64url(crypto.getRandomValues(new Uint8Array(16)));
const cleanSecret = s => String(s || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
const cleanCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const appBase = () => location.origin + location.pathname;
const linkURL = () => link ? `${appBase()}#/link/${link.secret}` : '';
const codeURL = code => `${appBase()}#/c/${code}`;
// "K7M2-Q9XA"
const prettyCode = c => c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : c;

// ---------- file format: gzip → AES-GCM → base64 ----------
function toB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function fromB64(b) { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
// BZL1: a small LZ77 compressor (greedy, 64 KB window, 4-byte hash) — used only when the browser has no gzip.
const MAGIC = [0x42, 0x5a, 0x4c, 0x31];
const isLz = u => u.length > 4 && u[0] === 0x42 && u[1] === 0x5a && u[2] === 0x4c && u[3] === 0x31;
function lzCompress(src) {
  const n = src.length, out = new Uint8Array(n + (n >> 3) + 64); let o = 0;
  const put = b => { out[o++] = b; };
  const varint = v => { while (v >= 128) { put((v & 127) | 128); v = Math.floor(v / 128); } put(v); };
  for (const b of MAGIC) put(b); varint(n);
  const HB = 16, table = new Int32Array(1 << HB).fill(-1);
  const hash = i => (Math.imul(src[i] | src[i + 1] << 8 | src[i + 2] << 16 | src[i + 3] << 24, 2654435761) >>> (32 - HB));
  let i = 0, lit = 0;
  const flush = (end, mlen, dist) => { varint(end - lit); out.set(src.subarray(lit, end), o); o += end - lit; varint(mlen); if (mlen) varint(dist); };
  while (i + 4 <= n) {
    const h = hash(i), c = table[h]; table[h] = i;
    if (c >= 0 && i - c < 65536 && src[c] === src[i] && src[c + 1] === src[i + 1] && src[c + 2] === src[i + 2] && src[c + 3] === src[i + 3]) {
      let l = 4; while (i + l < n && src[c + l] === src[i + l] && l < 65535) l++;
      flush(i, l, i - c);
      for (let k = i + 1; k < i + l && k + 4 <= n; k += 2) table[hash(k)] = k;
      i += l; lit = i;
    } else i++;
  }
  flush(n, 0, 0);
  return out.subarray(0, o);
}
function lzDecompress(u) {
  let p = 4;
  const varint = () => { let v = 0, m = 1, b; do { b = u[p++]; v += (b & 127) * m; m *= 128; } while (b & 128); return v; };
  const n = varint(), out = new Uint8Array(n); let o = 0;
  while (o < n) {
    const L = varint(); out.set(u.subarray(p, p + L), o); o += L; p += L;
    if (o >= n) break;
    const M = varint(); if (!M) continue; const d = varint();
    for (let k = 0; k < M; k++, o++) out[o] = out[o - d];
  }
  return out;
}
// Always compressed: gzip where the browser has it (~5× smaller), otherwise BAZINGA!'s own LZ (~2.5× smaller).
// Before, browsers without gzip (e.g. iPhones before iOS 16.4) sent the library uncompressed and hit the relay's size limit.
async function gz(bytes) {
  if ('CompressionStream' in window) { try { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()); } catch { } }
  return lzCompress(bytes);
}
async function gunz(u8) {
  if (u8[0] === 0x1f && u8[1] === 0x8b) {
    if ('DecompressionStream' in window) return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    throw new Error('This browser can\'t open the synced library. Update it (or use Chrome / Safari 16.4+).');
  }
  return isLz(u8) ? lzDecompress(u8) : u8;
}
async function seal(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keys.key, await gz(new TextEncoder().encode(JSON.stringify(obj)))));
  const out = new Uint8Array(13 + ct.length); out[0] = 1; out.set(iv, 1); out.set(ct, 13);
  return out;
}
async function open(u, key = keys.key) {
  if (u[0] !== 1) throw new Error('This library was saved by a newer BAZINGA! — refresh to update.');
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(1, 13) }, key, u.subarray(13)));
  return JSON.parse(new TextDecoder().decode(await gunz(plain)));
}
async function sealWith(key, obj) { const k0 = keys; keys = { key }; try { return await seal(obj); } finally { keys = k0; } }

// ---------- the relay (ntfy.sh) ----------
// Only "simple" requests (no custom headers), so browsers don't need a CORS pre-check.
const topicOf = id => 'bz' + id.slice(0, 40);
// Progress + cancel for syncs you start yourself (linking, "Sync now")
let abortCtl = null;
const sig = () => abortCtl?.signal;
const step = (label, pct) => emit('sync-progress', { label, pct });
function cancel() { abortCtl?.abort(); }
const isAbort = e => e?.name === 'AbortError' || /abort/i.test(e?.message || '');
async function relayList(topic, since = 'all') {
  const r = await fetch(`${RELAY()}/${topic}/json?poll=1&since=${since}`, { cache: 'no-store', signal: sig() });
  if (!r.ok) throw new Error(r.status === 429 ? 'Sync is busy — will try again shortly.' : `Sync relay error (${r.status})`);
  return (await r.text()).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(m => m && m.event === 'message').sort((a, b) => a.time - b.time);
}
async function relayPost(topic, body, params) {
  const r = await fetch(`${RELAY()}/${topic}?${new URLSearchParams({ firebase: 'no', ...params })}`, { method: 'POST', body, signal: sig() });
  if (!r.ok) { const e = new Error(r.status === 413 ? 'Your library is too big for the free sync relay.' : r.status === 429 ? 'Sync is busy — will try again shortly.' : `Sync relay error (${r.status})`); e.tooBig = r.status === 413; throw e; }
  return r.json();
}
const postFile = (topic, bytes) => relayPost(topic, new Blob([bytes]), { filename: 'library.bz', title: deviceName() });
// Big libraries: the (already compressed + encrypted) file is sent in 6 MB parts, so it never hits the
// relay's 15 MB per-file limit and a slow connection only has to resend a small piece. Each part is named
// library.<set>.<i>of<n>.bz; a device only uses a set once every part of it has arrived.
let PART = 1536 * 1024, MIN_PART = 64 * 1024; // ntfy.sh's free tier accepts files up to 2 MB; parts shrink by themselves if it says "too big"
const partOf = m => { const x = /^library\.(\w+)\.(\d+)of(\d+)\.bz$/.exec(m?.attachment?.name || ''); return x ? { set: x[1], i: +x[2], n: +x[3] } : null; };
async function postLibrary(topic, bytes) {
  for (;;) {
    try {
      if (bytes.length <= PART) return await postFile(topic, bytes);
      const set = Math.random().toString(36).slice(2, 10), n = Math.ceil(bytes.length / PART);
      let res = null;
      for (let i = 0; i < n; i++) {
        step(`Sending your library… part ${i + 1} of ${n}`, 92 + 7 * i / n);
        res = await relayPost(topic, new Blob([bytes.subarray(i * PART, (i + 1) * PART)]), { filename: `library.${set}.${i + 1}of${n}.bz`, title: deviceName() });
      }
      return res;
    } catch (e) {
      // "too big": send smaller pieces (down to 256 KB). Still too big then means the relay's storage for
      // this connection is full for now — it empties itself within 3 hours, so just try again later.
      if (!e.tooBig) throw e;
      if (PART > MIN_PART) { PART = Math.max(MIN_PART, Math.floor(Math.min(PART, bytes.length) / 2)); continue; }
      const err = new Error('The free sync relay is full for the moment. Your devices will catch up automatically within a few hours.'); err.later = true; throw err;
    }
  }
}
// The newest complete library on the relay: a single file, or every part of a split one (downloaded side by side)
async function fetchLibrary(topic, latest) {
  const pt = partOf(latest);
  if (!pt) return fetchFile(latest);
  const all = (await relayList(topic, 'all')).filter(liveFile);
  const sets = new Map();
  for (const m of all) { const q = partOf(m); if (!q) continue; const g = sets.get(q.set) || { n: q.n, parts: new Map(), time: 0 }; g.parts.set(q.i, m); g.time = Math.max(g.time, m.time); sets.set(q.set, g); }
  const done = [...sets.values()].filter(g => g.parts.size === g.n).sort((a, b) => b.time - a.time)[0];
  if (!done || done.time < latest.time - 120) return null; // the newest set is still uploading: try again shortly
  let got = 0;
  const bufs = await Promise.all([...Array(done.n).keys()].map(async k => {
    const r = await fetch(done.parts.get(k + 1).attachment.url, { cache: 'no-store', signal: sig() });
    if (!r.ok) throw new Error('Couldn\'t download the synced library — will try again.');
    const b = new Uint8Array(await r.arrayBuffer()); got++;
    step(`Downloading your music… part ${got} of ${done.n}`, 15 + 55 * got / done.n);
    return b;
  }));
  const out = new Uint8Array(bufs.reduce((a, b) => a + b.length, 0)); let o = 0; for (const b of bufs) { out.set(b, o); o += b.length; }
  return out;
}
const postNote = (topic, text) => relayPost(topic, text, {});
const liveFile = m => m.attachment?.url && (!m.attachment.expires || m.attachment.expires * 1000 > Date.now() + 30e3);
async function fetchFile(m) {
  const r = await fetch(m.attachment.url, { cache: 'no-store', signal: sig() });
  if (!r.ok) throw new Error('Couldn\'t download the synced library — will try again.');
  const total = +r.headers.get('content-length') || m.attachment.size || 0;
  if (!r.body || !total) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader(), chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    chunks.push(value); got += value.length;
    step(`Downloading your music… ${Math.round(got / 1024)} KB`, 15 + 55 * Math.min(1, got / total));
  }
  const out = new Uint8Array(got); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function hash(snap) {
  const s = JSON.stringify([snap.tracks, snap.albums, snap.playlists, snap.tombstones, snap.ytcache?.length, snap.profile, snap.settings || null, snap.kvx || null]);
  let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + ':' + s.length;
}

async function localSnap() {
  const snap = await backup.snapshot();
  snap.tombstones = store.tombstones();
  snap.tracks = snap.tracks.map(t => { const x = { ...t }; delete x.hadLocalFile; delete x.localFileId; return x; }).sort((a, b) => a.id < b.id ? -1 : 1);
  // YouTube matches travel as ids only (titles are just for display and get filled in again when needed)
  snap.ytcache = (snap.ytcache || []).filter(([, v]) => v && (v.video || v.audio)).map(([k, v]) => [k, Object.fromEntries(Object.entries({ video: v.video, audio: v.audio, manual: v.manual, fromSearch: v.fromSearch, guess: v.guess }).filter(([, x]) => x))]);
  snap.albums.sort((a, b) => a.id < b.id ? -1 : 1); snap.playlists.sort((a, b) => a.id < b.id ? -1 : 1);
  const p = snap.profile;
  snap.profile = p ? { username: p.username || '', picture: p.picture || '', updatedAt: p.updatedAt || 0 } : null;
  delete snap.player; delete snap.createdAt;
  // Settings (keys, tokens, servers, theme, playback…) travel too — encrypted on the device like everything else.
  // Every setting carries the time it was last changed by you; values nobody ever set get stamp 0/1 so they
  // can never overwrite a real choice from another device.
  const st = snap.settings || {};
  const vals = { ...st }; delete vals._ts;
  const ts = {};
  for (const k of Object.keys(vals)) ts[k] = st._ts?.[k] || (has(vals[k]) ? 1 : 0);
  snap.settings = { values: vals, ts };
  // Other things worth having everywhere: Spotify / YouTube connections, YouTube playlist links, your taste picks…
  const stamps = await kv.stamps(), kvx = {};
  for (const k of SYNC_KV) {
    const v = await kv.get(k), st2 = stamps[k];
    if (st2?.del) kvx[k] = { del: true, ts: st2.ts };
    else if (v !== null && v !== undefined) kvx[k] = { v, ts: st2?.ts || 1 };
  }
  snap.kvx = kvx;
  return snap;
}
// Settings: per setting, the newer change wins. A setting one side doesn't have is simply added.
// Nothing is ever removed just because the other device doesn't know about it.
function mergeSettings(L, R) {
  if (!R) return L || null;
  if (!L) return R;
  const values = { ...L.values }, ts = { ...L.ts };
  for (const [k, v] of Object.entries(R.values || {})) {
    const rt = R.ts?.[k] || 0, lt = ts[k] || 0;
    if (!(k in values) || rt > lt) { values[k] = v; ts[k] = rt; }
  }
  return { values, ts };
}
// Synced items: the newer copy wins; a removal only wins if you removed it after the other copy was saved
function mergeKv(L = {}, R = {}) {
  const out = { ...L };
  for (const [k, r] of Object.entries(R)) { const l = out[k]; if (!l || (r.ts || 0) > (l.ts || 0)) out[k] = r; }
  return out;
}

// ---------- merge ----------
const has = v => v !== undefined && v !== null && v !== '';
function mergeTrack(a, b) {
  const newer = (a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b, older = newer === a ? b : a;
  const out = { ...older };
  for (const [k, v] of Object.entries(newer)) if (has(v)) out[k] = v;
  const lk = (a.likeTs || 0) >= (b.likeTs || 0) ? a : b;
  out.liked = !!lk.liked; out.likedAt = lk.likedAt || null; out.likeTs = lk.likeTs || 0;
  return out;
}
function merge(L, R) {
  const tomb = { t: {}, p: {}, a: {} };
  for (const src of [L.tombstones, R.tombstones]) for (const k of ['t', 'p', 'a']) for (const [id, ts] of Object.entries(src?.[k] || {})) tomb[k][id] = Math.max(tomb[k][id] || 0, ts);
  const byId = (xs) => new Map((xs || []).map(x => [x.id, x]));
  const unite = (la, ra, kind, combine, stamp) => {
    const A = byId(la), B = byId(ra), out = [];
    for (const id of new Set([...A.keys(), ...B.keys()])) {
      const a = A.get(id), b = B.get(id);
      const x = a && b ? combine(a, b) : (a || b);
      const dead = tomb[kind][id];
      if (dead && dead >= stamp(x)) continue;
      out.push(x);
    }
    return out.sort((p, q) => p.id < q.id ? -1 : 1);
  };
  const newerOf = f => (a, b) => (f(a) >= f(b) ? a : b);
  const tracks = unite(L.tracks, R.tracks, 't', mergeTrack, x => Math.max(x.updatedAt || 0, x.likeTs || 0));
  const playlists = unite(L.playlists, R.playlists, 'p', newerOf(x => x.updatedAt || x.createdAt || 0), x => x.updatedAt || x.createdAt || 0);
  const albums = unite(L.albums, R.albums, 'a', newerOf(x => x.updatedAt || x.savedAt || 0), x => x.updatedAt || x.savedAt || 0);
  const yc = new Map(R.ytcache || []);
  for (const [k, v] of L.ytcache || []) { const r = yc.get(k); if (!r || v?.manual || !r.manual) yc.set(k, v); }
  const ids = new Set(tracks.map(t => t.id));
  for (const p of playlists) p.trackIds = (p.trackIds || []).filter(i => ids.has(i));
  for (const a of albums) a.trackIds = (a.trackIds || []).filter(i => ids.has(i));
  const lp = L.profile, rp = R.profile;
  const profile = lp && rp ? ((rp.updatedAt || 0) > (lp.updatedAt || 0) ? rp : lp) : (lp || rp || null);
  return {
    app: 'BAZINGA', version: 1, tracks, playlists, albums, tombstones: tomb, profile,
    settings: mergeSettings(L.settings, R.settings), kvx: mergeKv(L.kvx, R.kvx),
    ytcache: [...yc.entries()].sort((p, q) => p[0] < q[0] ? -1 : 1)
  };
}

async function applyLocal(m) {
  const cur = new Map((await db.all('tracks')).map(t => [t.id, t]));
  await db.clear('tracks');
  await db.putMany('tracks', m.tracks.map(t => { const c = cur.get(t.id); return c?.localFileId ? { ...t, localFileId: c.localFileId } : t; }));
  await db.clear('albums'); await db.putMany('albums', m.albums);
  await db.clear('playlists'); await db.putMany('playlists', m.playlists);
  // YouTube matches: only write what actually changed, and keep this device's extra details (titles)
  const ycKeys = await db.keys('ytcache'), ycVals = await db.all('ytcache'), ycNow = new Map(ycKeys.map((k, i) => [k, ycVals[i]]));
  for (const [k, v] of m.ytcache || []) {
    const c = ycNow.get(k);
    if (c && c.video === v.video && c.audio === v.audio && !!c.manual === !!v.manual) continue;
    await db.put('ytcache', c && c.video === v.video && c.audio === v.audio ? { ...c, ...v } : v, k);
  }
  await store.setTombstones(m.tombstones);
  if (m.profile) {
    const local = await kv.get('profile');
    if (local && (m.profile.updatedAt || 0) > (local.updatedAt || 0)) {
      Object.assign(local, { username: m.profile.username || local.username, picture: m.profile.picture ?? local.picture, updatedAt: m.profile.updatedAt });
      await kv.set('profile', local); emit('profile-changed', local);
    }
  }
  // Settings: only write if something actually changed
  if (m.settings) {
    const cur = (await kv.get('settings')) || {};
    const curTs = cur._ts || {};
    let changed = false; const next = { ...cur, _ts: { ...curTs } };
    for (const [k, v] of Object.entries(m.settings.values)) {
      if (JSON.stringify(cur[k]) !== JSON.stringify(v)) { next[k] = v; changed = true; }
      if ((m.settings.ts[k] || 0) > (curTs[k] || 0)) { next._ts[k] = m.settings.ts[k]; changed = true; }
    }
    if (changed) { await kv.set('settings', next); emit('settings-synced', next); }
  }
  if (m.kvx) {
    const stamps = await kv.stamps();
    for (const [k, rec] of Object.entries(m.kvx)) {
      if (!SYNC_KV.includes(k)) continue;
      const mine = stamps[k], have = await kv.get(k);
      // the merge already picked the winner; only write it if this device doesn't have exactly that yet
      const same = rec.del ? (mine?.del && mine.ts === rec.ts && have === null) : (have !== null && (mine?.ts || 1) === rec.ts);
      if (!same) await kv.putSynced(k, rec);
    }
    emit('kv-synced');
  }
  await store.load();
  emit('library'); emit('synced-in');
}

// ---------- the sync itself ----------
async function saveLink() { if (link) await kv.set('syncLink', link); else await kv.del('syncLink'); }
async function syncNow({ interactive = false } = {}) {
  if (!link || !available()) return;
  if (!navigator.onLine) { setStatus('offline'); return; }
  if (running) { if (!interactive) { again = true; return running; } await running.catch(() => { }); }
  if (interactive) abortCtl = new AbortController();
  running = (async () => {
    setStatus('syncing');
    try {
      do { again = false; await once(); } while (again && link);
      if (link) { setStatus('synced'); step('Done', 100); }
    } catch (e) {
      if (isAbort(e)) { setStatus(link?.lastId ? 'synced' : 'off'); S.cancelled = true; return; }
      console.warn('sync failed', e);
      setStatus('error', /Failed to fetch|NetworkError|Load failed/.test(e.message) ? 'Couldn\'t reach the sync server.' : e.message);
      if (e.later) setTimeout(() => link && syncNow(), 30 * 60e3);
    } finally { running = null; if (interactive) abortCtl = null; }
  })();
  S.cancelled = false;
  return running;
}
async function once() {
  keys = keys || await derive(link.secret);
  const topic = topicOf(keys.id);
  step('Checking for changes…', 6);
  const msgs = (await relayList(topic, link.lastTs ? Math.max(0, link.lastTs - 5) : 'all')).filter(m => m.id !== link.lastId && (!link.seen || !link.seen.includes(m.id)));
  // "Turn off sync everywhere" from another device
  for (const m of msgs) if (!m.attachment && m.message && m.time * 1000 > (link.since || 0)) {
    try { const note = await open(fromB64(m.message)); if (note?.t === 'off') { await leave(); emit('sync-removed'); return; } } catch { }
  }
  const latest = [...msgs].reverse().find(liveFile);
  const local = await localSnap();
  let base = local;
  if (latest) {
    step('Downloading your music…', 15);
    const bytes = await fetchLibrary(topic, latest);
    if (!bytes) { setTimeout(() => link && syncNow(), 20e3); return; } // another device is still sending its parts: check again in 20 s
    const remote = await open(bytes);
    if (sig()?.aborted) throw new DOMException('cancelled', 'AbortError');
    step('Merging with this device…', 75);
    // Joining with "use only the synced library": swap it in now that it has fully arrived
    // (a cancelled download leaves this device untouched)
    let replaced = false;
    if (link.replace) { replaced = true; local.tracks = []; local.albums = []; local.playlists = []; local.tombstones = { t: {}, p: {}, a: {} }; if (local.profile) local.profile.updatedAt = 0; delete link.replace; } // settings are never wiped, only merged
    base = merge(local, remote);
    step('Saving to this device…', 85);
    if (replaced || hash(base) !== hash(local)) await applyLocal(base);
    link.hash = hash(remote); link.lastId = latest.id; link.lastTs = latest.time; link.pubTs = Math.max(link.pubTs || 0, latest.time);
  }
  if (msgs.length) { link.seen = msgs.slice(-20).map(m => m.id); link.lastTs = Math.max(link.lastTs || 0, msgs[msgs.length - 1].time); }
  await saveLink();
  const h = hash(base);
  const fresh = Date.now() / 1000 - (link.pubTs || 0) < 140 * 60; // the relay keeps copies ~3 h: refresh every ~2.3 h
  if (h === link.hash && fresh) return;
  step('Sending your library to your other devices…', 92);
  const res = await postLibrary(topic, await seal(base));
  link.hash = h; link.lastId = res.id; link.lastTs = res.time; link.pubTs = res.time;
  await saveLink();
}

// ---------- start / join / leave ----------
// Turn sync on for the first time on this device (makes a new sync key and posts the library)
async function create() {
  if (!available()) throw new Error('Device sync needs the online (GitHub Pages) version of BAZINGA!.');
  link = { secret: newSecret(), since: Date.now() }; keys = null;
  await saveLink();
  await syncNow({ interactive: true });
  if (S.cancelled) { link = null; keys = null; await saveLink(); setStatus('off'); const e = new Error('Cancelled'); e.cancelled = true; throw e; }
  if (S.status === 'error') { const err = S.error; link = null; keys = null; await saveLink(); setStatus('off'); throw new Error(err); }
  start();
  return link;
}
// Is there a recent library posted under this key? (shown before joining)
async function peek(secret) {
  const k = await derive(secret);
  const m = [...await relayList(topicOf(k.id))].reverse().find(liveFile);
  return m ? { device: m.title || '', updatedAt: m.time * 1000 } : null;
}
// Join an existing sync key. mode: 'merge' (combine with what's here) | 'replace' (use only the linked library)
async function join(secret, mode = 'merge') {
  secret = cleanSecret(secret);
  if (secret.length < 16) throw new Error('That sync link isn\'t complete — copy the whole link and try again.');
  abortCtl = new AbortController();
  step('Looking for your library…', 3);
  const found = await peek(secret).catch(e => { if (isAbort(e)) throw e; return null; });
  link = { secret, since: Date.now(), replace: mode === 'replace' && !!found }; keys = null;
  await saveLink();
  await syncNow({ interactive: true });
  if (S.cancelled) { await leave(); const e = new Error('Cancelled'); e.cancelled = true; throw e; }
  start();
  return found;
}
// Short codes: an 8-character code that hands this device's sync key to another device (15 minutes)
const CODE_ABC = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
async function codeKeys(code) {
  const topic = 'bzc' + hex(await sha('bazinga-code-id:' + code)).slice(0, 40);
  const key = await crypto.subtle.importKey('raw', await sha('bazinga-code-key:' + code), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { topic, key };
}
async function makeCode() {
  if (!link) await create();
  const r = crypto.getRandomValues(new Uint8Array(8));
  const code = [...r].map(b => CODE_ABC[b % 32]).join('');
  const k = await codeKeys(code);
  await postNote(k.topic, toB64(await sealWith(k.key, { s: link.secret, exp: Date.now() + 15 * 60e3 })));
  return code;
}
async function redeemCode(code) {
  const c = cleanCode(code);
  if (c.length !== 8) throw new Error('Codes have 8 letters and numbers, like K7M2-Q9XA.');
  const k = await codeKeys(c);
  const msgs = await relayList(k.topic, '20m');
  for (const m of msgs.reverse()) {
    try { const d = await open(fromB64(m.message), k.key); if (d?.s && d.exp > Date.now()) return d.s; } catch { }
  }
  throw new Error('That code didn\'t work — check it, or make a new one on your other device (codes last 15 minutes).');
}
// Stop syncing on this device (its music stays here)
async function leave() { link = null; keys = null; await saveLink(); setStatus('off'); }
// Tell every linked device to stop syncing (each keeps its music)
async function removeEverywhere() {
  if (!link) return;
  keys = keys || await derive(link.secret);
  await postNote(topicOf(keys.id), toB64(await seal({ t: 'off', at: Date.now() })));
  await leave();
}

let lastPush = 0;
const schedule = debounce(() => {
  const wait = Math.max(0, lastPush + 20e3 - Date.now());
  setTimeout(() => { lastPush = Date.now(); syncNow(); }, wait);
}, 5000);
async function restore() { link = await kv.get('syncLink'); if (link?.secret) start(); else setStatus('off'); }
function start() {
  if (!link) { setStatus('off'); return; }
  syncNow();
  if (started) return; started = true;
  on('dirty', why => { if (link && why !== 'synced') schedule(); });
  onSyncedKvChange(() => { if (link) schedule(); });
  document.addEventListener('visibilitychange', () => {
    if (!link) return;
    if (document.visibilityState === 'visible' && Date.now() - S.lastSync > 15e3) syncNow();
    if (document.visibilityState === 'hidden') syncNow(); // save before the browser is closed
  });
  window.addEventListener('online', () => link && syncNow());
  setInterval(() => { if (document.visibilityState === 'visible' && link) syncNow(); }, 90e3);
}

return { state, available, linked, linkInfo, deviceName, cleanSecret, cleanCode, linkURL, codeURL, prettyCode, cancel, mergeSettings, merge, syncNow, create, peek, join, makeCode, redeemCode, leave, removeEverywhere, restore, start };
})();
// ---------- voice.js ----------
const __m_voice = (() => {
// "Hey BAZINGA!" — voice assistant.
// Listens with the browser's speech recognition, understands everyday phrasing,
// and answers out loud with the most natural voice the device has
// (e.g. Siri/"Enhanced"/"Premium" voices on Apple, "Natural" voices on Edge/Windows, Google voices on Chrome/Android).
// Browsers without speech recognition (e.g. Firefox) get a text box instead — it still talks back.
const { lib } = __m_store;
const store = __m_store;
const meta = __m_meta;
const player = __m_player;
const { P } = __m_player;
const { $, esc, norm, mainArtist, displayTitle, emit, trackKey, sleep } = __m_util;

const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
// Brave ships the speech API but can't reach Google's speech service, so it gets the text box instead
const canListen = !!Rec && !navigator.brave;
let app = null;           // hooks from app.js: { go, search, openNP, closeNP, lyrics, back, toast }
let rec = null, listening = false, open = false, ducked = false, keep = false, closeTimer = null, usedMic = false, micEndedAt = 0;
const IOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const NO_SPEECH_CLOSE = 3500; // closes this fast when it didn't hear anything

const rand = a => a[Math.floor(Math.random() * a.length)];

// ---------- voice output ----------
let voice = null;
// Rank every voice the device has: natural/neural voices first, robotic & novelty voices last.
// (Browsers can't use Siri's own voice, but Apple's Premium/Enhanced voices, Edge's "Natural"
// voices and Chrome's Google voices sound close to it.)
const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|pipe organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy|princess|bruce|agnes|vicki|victoria|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley|espeak|compact|robot|novelty)\b/i;
// iPhone/iPad: voice NAMES don't say how good a voice is ("Samantha" can be the tiny robotic "compact"
// voice or the downloaded Enhanced one) — the voiceURI does (com.apple.voice.compact… / .enhanced… /
// .premium… / …siri…). Eloquence voices (Eddy, Flo, Reed…) are the robotic ones.
const quality = v => (v.voiceURI || '') + ' ' + v.name;
const isGreat = v => !!v && /natural|neural|premium|enhanced|siri|^google /i.test(quality(v));
function voiceScore(v) {
  const lang = (navigator.language || 'en-US').toLowerCase(), base = lang.slice(0, 2);
  const vl = v.lang.toLowerCase().replace('_', '-'), n = v.name, q = quality(v);
  let s = 0;
  if (vl === lang) s += 40; else if (vl.startsWith(base)) s += 28; else return -100;
  if (/natural|neural/i.test(n)) s += 60;                          // Edge / Windows "… Online (Natural)"
  if (/premium/i.test(q)) s += 58;                                 // Apple downloadable Premium voices
  if (/enhanced/i.test(q)) s += 50;                                // Apple Enhanced
  if (/siri/i.test(q)) s += 55;
  if (/\.compact\.|compact/i.test(q)) s -= 30;                     // Apple's small built-in voices: robotic
  if (/eloquence/i.test(q)) s -= 120;
  if (/^google /i.test(n)) s += 34;                                // Chrome network voices
  if (/\b(ava|zoe|evan|nathan|noelle|samantha|allison|susan|serena|karen|moira|tessa|daniel|aria|jenny|michelle|ana|emma|brian|andrew|ava multilingual|libby|sonia|ryan|natasha|william)\b/i.test(n)) s += 14;
  if (NOVELTY.test(n)) s -= 120;
  if (/microsoft (david|zira|mark|hazel|george)(?!.*natural)/i.test(n)) s -= 10; // older desktop voices
  return s;
}
let voicePref = '', rate = 1;
function voiceOptions() {
  if (!('speechSynthesis' in window)) return [];
  const vs = speechSynthesis.getVoices().map(v => ({ v, s: voiceScore(v) })).filter(x => x.s > -50).sort((a, b) => b.s - a.s);
  return vs.map(({ v, s }, i) => ({ name: v.name, lang: v.lang, best: i === 0, quality: s >= 80 ? 'Natural' : s >= 60 ? 'Good' : 'Basic' }));
}
function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  const vs = speechSynthesis.getVoices(); if (!vs.length) return null;
  if (voicePref) { const v = vs.find(x => x.name === voicePref); if (v) return v; }
  return vs.slice().sort((a, b) => voiceScore(b) - voiceScore(a))[0];
}
function setVoicePrefs({ name, speed } = {}) {
  if (name !== undefined) { voicePref = name || ''; voice = pickVoice(); }
  if (speed) rate = speed;
}
function previewVoice(name) {
  const old = voicePref; voicePref = name || ''; voice = pickVoice();
  say(rand(['Hey! I\'m BAZINGA. What do you want to hear?', 'Hi there. Say "play my liked songs" and I\'ll get the music going.']), { show: false });
  voicePref = old; voice = null;
}
if ('speechSynthesis' in window) { speechSynthesis.onvoiceschanged = () => { voice = pickVoice(); }; voice = pickVoice(); }

// Dip the music while listening/talking. This never changes your saved volume, so the music
// always comes back exactly as loud as it was.
// The music stays silent the whole time the assistant is on screen, and comes back when it closes.
function duck(on) {
  if (!on && open) return;
  if (on === ducked) return;
  ducked = on; player.duck(on);
}
// A bright, loud three-note chime every time the assistant starts listening
let actx = null;
function unlockChime() { try { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; actx = actx || new AC(); if (actx.state === 'suspended') actx.resume(); return actx; } catch { return null; } }
function chime() {
  const ac = unlockChime(); if (!ac) return;
  try {
    const t = ac.currentTime + 0.02;
    const out = ac.createDynamicsCompressor ? ac.createDynamicsCompressor() : ac.createGain();
    const master = ac.createGain(); master.gain.value = 1;
    master.connect(out); out.connect(ac.destination);
    [[1046.5, 0], [1318.5, 0.09], [2093, 0.18]].forEach(([f, d]) => {
      for (const [mult, amp] of [[1, 0.6], [2, 0.18], [3, 0.06]]) {
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = 'sine'; o.frequency.value = f * mult;
        g.gain.setValueAtTime(0.0001, t + d);
        g.gain.exponentialRampToValueAtTime(amp, t + d + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.6);
        o.connect(g); g.connect(master); o.start(t + d); o.stop(t + d + 0.65);
      }
    });
  } catch { }
}
// After using the microphone, phones keep audio in "phone call" mode (thin, quiet sound).
// Hand the audio back to music mode and gently restart the output so it sounds right again.
function restoreAudio() {
  duck(false);
  player.audioMode('playback');
  if (usedMic) { usedMic = false; if (matchMedia('(pointer: coarse)').matches) setTimeout(() => player.refreshOutput(), 250); }
}
function fail(text) { keep = true; return say(text); }
function say(text, { show = true } = {}) {
  if (show) setReply(text);
  if (!('speechSynthesis' in window)) return Promise.resolve();
  return new Promise(async res => {
    // Right after the microphone, iPhones still route sound like a phone call (thin, robotic).
    // Switch back to music audio and give it a moment before talking.
    player.audioMode('playback');
    if (IOS && Date.now() - micEndedAt < 700) await new Promise(r => setTimeout(r, 700 - (Date.now() - micEndedAt)));
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(guard); setState(listening ? 'listening' : 'idle'); if (!listening) duck(false); res(); };
    // Some phones never fire "end" for speech — don't leave the music dipped forever
    const guard = setTimeout(finish, Math.max(2500, text.length * 85));
    try {
      speechSynthesis.cancel();
      voice = voice || pickVoice();
      // Speak sentence by sentence with a natural pace: sounds less robotic, and avoids
      // Chrome cutting long speech off
      const spoken = text.replace(/BAZINGA!/g, 'Bazinga').replace(/\s*—\s*/g, ', ');
      // iPhone: one utterance (natural flow, no gaps between sentences). Chrome cuts long speech off, so it goes sentence by sentence.
      const parts = IOS ? [spoken] : (spoken.match(/[^.!?]+[.!?]*/g) || [spoken]);
      setState('speaking'); duck(true);
      // On iPhone a "compact" voice sounds robotic; the phone's own default voice (Settings → Accessibility →
      // Spoken Content) is usually the Siri-quality one, so use it unless a premium/enhanced voice was found or chosen.
      const useVoice = voice && (!IOS || isGreat(voice) || voicePref) ? voice : null;
      parts.forEach((part, i) => {
        const u = new SpeechSynthesisUtterance(part.trim());
        if (useVoice) { u.voice = useVoice; u.lang = useVoice.lang; } else u.lang = navigator.language || 'en-US';
        u.rate = (isGreat(useVoice) || !useVoice ? 1 : 0.97) * rate; u.pitch = 1; u.volume = 1;
        if (i === parts.length - 1) { u.onend = finish; }
        u.onerror = finish;
        speechSynthesis.speak(u);
      });
    } catch { finish(); }
  });
}

// ---------- UI ----------
function el() { return $('#voice'); }
function setState(s) { const v = el(); if (v) v.dataset.state = s; }
function setHeard(t) { const h = el()?.querySelector('.vc-heard'); if (h) { h.textContent = t; h.classList.toggle('empty', !t); } }
function setReply(t) { const r = el()?.querySelector('.vc-reply'); if (r) r.textContent = t; }

const SUGGEST = ['Play my liked songs', 'Play Blinding Lights by The Weeknd', 'Add Essence to the queue', 'Search for Burna Boy', 'Go to my artists', 'Show the lyrics', 'Switch to music video', 'What\'s playing?'];

function initVoice(hooks) {
  app = hooks;
  const wrap = document.createElement('div');
  wrap.id = 'voice'; wrap.hidden = true; wrap.dataset.state = 'idle';
  wrap.innerHTML = `<div class="vc-back" data-vc="close"></div>
    <div class="vc-sheet" role="dialog" aria-label="Voice assistant">
      <button class="ib vc-x" data-vc="close" aria-label="Close">✕</button>
      <div class="vc-orb" data-vc="mic" role="button" aria-label="Tap to talk"><i></i><i></i><i></i><b></b></div>
      <div class="vc-heard empty"></div>
      <div class="vc-reply">${canListen ? 'Listening… try "Play my liked songs"' : 'Type what you\'d like — for example "Play Tapout by Rich Gang"'}</div>
      <div class="vc-confirm" hidden><button class="btn primary" data-vc="yes">${'Yes, play it'}</button><button class="btn" data-vc="no">No</button></div>
      <form class="vc-form"><input name="q" placeholder="${canListen ? 'Or type a request…' : 'Type a request…'}" autocomplete="off" enterkeyhint="go"><button class="btn primary sm">Go</button></form>
      <div class="vc-sugg">${SUGGEST.map(s => `<button class="chip" data-vc-say="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener('click', e => {
    const c = e.target.closest('[data-vc]');
    if (c?.dataset.vc === 'close') close();
    if (c?.dataset.vc === 'mic') listening ? stopListening() : listen();
    if (c?.dataset.vc === 'yes' || c?.dataset.vc === 'no') { stopListening(); setHeard(c.dataset.vc === 'yes' ? 'Yes' : 'No'); handle(c.dataset.vc); }
    const s = e.target.closest('[data-vc-say]'); if (s) { setHeard(s.dataset.vcSay); handle(s.dataset.vcSay); }
  });
  ['focus', 'input'].forEach(ev => wrap.querySelector('.vc-form input').addEventListener(ev, () => clearTimeout(closeTimer)));
  wrap.querySelector('.vc-form').addEventListener('submit', e => {
    e.preventDefault(); const q = e.target.q.value.trim(); if (!q) return;
    e.target.q.value = ''; stopListening(); setHeard(q); handle(q);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) close(); });
}

function openVoice({ listenNow = true, fromWake = false } = {}) {
  const v = el(); if (!v) return;
  if (!fromWake) stopWake();
  clearTimeout(closeTimer); keep = false;
  open = true; v.hidden = false; requestAnimationFrame(() => v.classList.add('on'));
  micUI(true);
  unlockChime();
  duck(true);
  setHeard('');
  setReply(canListen ? rand(['I\'m listening…', 'Go ahead, I\'m listening.', 'What do you want to hear?']) : 'Type what you\'d like — for example "Play Tapout by Rich Gang"');
  // Unlock speech on iOS: speak an empty utterance inside the tap
  try { if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch { }
  if (!listenNow) return;
  if (canListen) listen(); else v.querySelector('input').focus();
}
// Close by itself once there's nothing left to do: right after a finished task, or after a short
// pause when it couldn't help (so you can try again) — it never just sits on screen.
function scheduleClose(ms) {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    const typing = document.activeElement && el()?.contains(document.activeElement) && document.activeElement.matches('input') && document.activeElement.value;
    if (!open || listening || pending || typing) return;
    let speaking = false; try { speaking = speechSynthesis.speaking; } catch { }
    if (speaking) return scheduleClose(600);
    close();
  }, ms);
}
// Mic buttons go back to normal: no ring, no stuck tap/hover highlight, no focus (Safari keeps these otherwise)
function micUI(on) {
  document.body.classList.toggle('voice-on', !!on);
  if (on) return;
  try { const a = document.activeElement; if (a && a !== document.body && !el()?.contains(a)) a.blur(); else a?.blur?.(); } catch { }
  document.querySelectorAll('[data-act="voice"]').forEach(b => { b.classList.remove('on', 'active'); b.removeAttribute('aria-pressed'); });
}
function close() {
  open = false;
  micUI(false); // first, so nothing below can leave the mic looking active
  clearTimeout(closeTimer); pending = null; confirmUI(false);
  stopListening(); try { speechSynthesis.cancel(); } catch { }
  try { restoreAudio(); } catch { }
  // Safari: make sure the microphone is really released (no recogniser left running unless "Hey Bazinga" is on)
  if (!wakeOn) stopWake();
  const v = el(); if (!v) return;
  v.classList.remove('on'); setTimeout(() => { if (!open) v.hidden = true; }, 220);
  scheduleWake(1200);
}

function listen() {
  if (!canListen) return;
  try { speechSynthesis.cancel(); } catch { }
  clearTimeout(closeTimer); keep = false;
  stopListening(); stopWake();
  player.audioMode('play-and-record');
  usedMic = true;
  rec = new Rec();
  rec.lang = navigator.language || 'en-US';
  // Ask for several guesses of what was said; each one is checked against your library
  rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 5;
  let final = '', finals = [];
  rec.onstart = () => { listening = true; setState('listening'); duck(true); };
  chime();
  rec.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) { final += r[0].transcript; finals.push([...Array(r.length)].map((_, k) => r[k].transcript)); }
      else interim += r[0].transcript;
    }
    setHeard((final + ' ' + interim).trim());
  };
  rec.onerror = e => {
    listening = false; setState('idle'); keep = true;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setReply('I need microphone access. Allow it in your browser\'s site settings, or type below.');
    else if (e.error === 'no-speech') setReply('I didn\'t hear anything. Tap the orb and try again.');
    else if (e.error === 'network') setReply('Voice recognition needs internet. You can type instead.');
    scheduleClose(e.error === 'no-speech' || e.error === 'aborted' ? NO_SPEECH_CLOSE : 8000);
  };
  rec.onend = () => {
    listening = false; setState('idle'); rec = null; micEndedAt = Date.now();
    player.audioMode('playback'); // release the microphone's audio mode right away
    const alts = [];
    for (let k = 1; k < 5; k++) { const a = finals.map(f => f[k] || f[0]).join(' ').trim(); if (a && a !== final.trim() && !alts.includes(a)) alts.push(a); }
    if (final.trim()) handle(final.trim(), alts); else { restoreAudio(); if (!pending) scheduleClose(NO_SPEECH_CLOSE); }
  };
  try { rec.start(); } catch { player.audioMode('playback'); }
}
function stopListening() {
  const r = rec; rec = null;
  if (r) { r.onend = r.onresult = r.onerror = null; try { r.abort(); } catch { } try { r.stop(); } catch { } player.audioMode('playback'); micEndedAt = Date.now(); }
  listening = false;
}

// ---------- understanding ----------
function clean(s) {
  return s.toLowerCase().replace(/[’']/g, "'").replace(/[.!?,]+$/g, '')
    .replace(/^(hey |ok |okay )?(bazinga|bazinga!)[, ]*/i, '')
    .replace(/^(please |can you |could you |would you |will you |i want to |i wanna |i'd like to |let's |lets |yo |hey )+/g, '')
    .replace(/ please$/g, '').replace(/\s+/g, ' ').trim();
}
function sim(a, b) {
  const A = norm(a), B = norm(b); if (!A || !B) return 0;
  if (A === B) return 1;
  if (B.includes(A) || A.includes(B)) return 0.85 * Math.min(A.length, B.length) / Math.max(A.length, B.length) + 0.15;
  const ta = new Set(A.split(' ')), tb = new Set(B.split(' '));
  let inter = 0; ta.forEach(x => { if (tb.has(x)) inter++; });
  return inter / Math.max(ta.size, tb.size);
}
function bestOf(list, q, key, min = 0.55) {
  let best = null, s = 0;
  for (const x of list) { const v = sim(q, key(x)); if (v > s) { s = v; best = x; } }
  return s >= min ? best : null;
}
const libTracks = () => store.saved();
const likedIds = () => libTracks().filter(t => t.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0)).map(t => t.id);
function artistTracks(name) {
  const n = norm(name);
  return libTracks().filter(t => norm(mainArtist(t.artist)) === n || (t.artists || []).some(a => norm(a) === n));
}

// Work out what "X" is: liked songs / a playlist / an album / an artist / a song
async function resolve(q, { prefer } = {}) {
  q = q.replace(/^(the |some |a )/, '').trim();
  if (/^(my )?(liked|favorite|favourite|loved)( songs| tracks| music)?$|^my (likes|favorites|favourites)$/.test(q)) {
    const ids = likedIds(); return ids.length ? { kind: 'liked', ids, label: 'your Liked Songs' } : { none: 'You don\'t have any liked songs yet.' };
  }
  let m;
  if ((m = q.match(/^(?:my )?playlist (?:called |named )?(.+)$/)) || (m = q.match(/^(?:my )?(.+?) playlist$/)) || prefer === 'playlist') {
    const name = m ? m[1] : q;
    const p = bestOf([...lib.playlists.values()], name, x => x.name, 0.45);
    if (p) return { kind: 'playlist', ids: p.trackIds, label: `your ${p.name} playlist` };
    if (m) return { none: `I couldn't find a playlist called ${name}.` };
  }
  if ((m = q.match(/^(?:the )?album (.+?)(?: by (.+))?$/))) {
    const [, title, by] = m;
    const local = bestOf([...lib.albums.values()], title, a => a.title, 0.6);
    if (local && (!by || sim(by, local.artist) > 0.5)) return { kind: 'album', ids: local.trackIds, label: `${local.title} by ${local.artist}` };
    const res = await meta.searchAlbums(by ? `${by} ${title}` : title, 5);
    const a = res[0]; if (!a) return { none: `I couldn't find the album ${title}.` };
    const { tracks } = await meta.albumTracks(a.itunesAlbumId);
    return { kind: 'album', ids: tracks.map(t => (lib.tracks.get(t.id) || store.remember(t)).id), label: `${a.title} by ${a.artist}`, sure: !!by && sim(by, a.artist) > 0.7 && sim(title, a.title) > 0.6 };
  }
  if ((m = q.match(/^(?:songs|music|tracks|something|stuff|anything|hits) (?:by|from) (.+)$/)) || (m = q.match(/^(.+?)'s (?:songs|music|hits)$/))) {
    return await artistPick(m[1]);
  }
  if ((m = q.match(/^(.+) by (.+)$/))) {
    const [, title, by] = m;
    const local = libTracks().find(t => sim(title, t.title) > 0.8 && (sim(by, t.artist) > 0.6 || (t.artists || []).some(a => sim(by, a) > 0.7)));
    if (local) return { kind: 'song', ids: [local.id], label: `${displayTitle(local)} by ${local.artist}` };
    const res = await meta.searchSongs(`${by} ${title}`, 8);
    const hit = res.find(r => sim(by, r.artist) > 0.5) || res[0];
    if (hit) { const t = lib.tracks.get(hit.id) || store.remember(hit); return { kind: 'song', ids: [t.id], label: `${t.title} by ${t.artist}`, sure: sim(by, t.artist) > 0.7 && sim(title, t.title) > 0.7 }; }
    return { none: `I couldn't find ${title} by ${by}.` };
  }
  // Bare name: playlist? artist? song?
  const p = bestOf([...lib.playlists.values()], q, x => x.name, 0.8);
  if (p) return { kind: 'playlist', ids: p.trackIds, label: `your ${p.name} playlist` };
  const art = store.artists().find(a => norm(a.name) === norm(q));
  if (art) return artistPick(art.name);
  const local = bestOf(libTracks(), q, t => t.title, 0.75);
  if (local) return { kind: 'song', ids: [local.id], label: `${displayTitle(local)} by ${local.artist}` };
  const res = await meta.searchSongs(q, 8);
  if (res[0]) {
    // If the words are really an artist name, play that artist
    if (res.filter(r => norm(r.artist) === norm(q)).length >= 3) return artistPick(res.find(r => norm(r.artist) === norm(q)).artist);
    const t = lib.tracks.get(res[0].id) || store.remember(res[0]);
    return { kind: 'song', ids: [t.id], label: `${t.title} by ${t.artist}` };
  }
  return { none: `I couldn't find anything for ${q}.` };
}
async function artistPick(name) {
  const mine = artistTracks(name);
  if (mine.length) return { kind: 'artist', ids: mine.map(t => t.id), label: mine[0].artist, shuffle: true, sure: true };
  const id = await meta.findArtistId(name);
  if (!id) return { none: `I couldn't find the artist ${name}.` };
  const top = await meta.artistTopSongs(id);
  if (!top.length) return { none: `I couldn't find songs by ${name}.` };
  return { kind: 'artist', ids: top.map(t => (lib.tracks.get(t.id) || store.remember(t)).id), label: top[0].artist, shuffle: false, sure: norm(top[0].artist) === norm(name) };
}

// ---------- library-aware matching ----------
// Speech recognition often mishears names ("Burner Boy", "wiz kid"), so everything is compared
// with typo-tolerant, sound-alike matching against YOUR library first: playlists, artists,
// albums and song titles (+ artist). Only if nothing in the library fits do we search the catalogue.
function lev(a, b) {
  if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const ratio = (a, b) => (a && b) ? 1 - lev(a, b) / Math.max(a.length, b.length) : 0;
// "sounds like": fold spellings the recogniser mixes up
const sound = s => s.replace(/ph/g, 'f').replace(/ck|q/g, 'k').replace(/z/g, 's').replace(/y/g, 'i').replace(/ee|ea/g, 'i').replace(/oo|ou/g, 'u').replace(/er\b/g, 'a').replace(/([a-z])\1+/g, '$1').replace(/h(?![aeiou])/g, '');
const STOP = new Set(['the', 'a', 'an', 'my', 'song', 'songs', 'track', 'music', 'by', 'from', 'of', 'and']);
// "seven" = "7", "number one" = "no 1"… so spoken numbers match titles
const NUMW = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100 };
const numify = s => s.replace(/\b(twenty|thirty|forty|fifty) (one|two|three|four|five|six|seven|eight|nine)\b/g, (m, a, b) => String(NUMW[a] + NUMW[b])).replace(/\b[a-z]+\b/g, w => w in NUMW ? String(NUMW[w]) : w);
function fuzzy(q, target) {
  const A = numify(norm(q)), B = numify(norm(target)); if (!A || !B) return 0;
  if (A === B) return 1;
  const cA = A.replace(/ /g, ''), cB = B.replace(/ /g, '');
  let s = Math.max(ratio(A, B), ratio(cA, cB) * 0.98, ratio(sound(cA), sound(cB)) * 0.95);
  if (B.includes(A) && A.length >= 3) s = Math.max(s, 0.7 + 0.3 * A.length / B.length);
  // word-by-word: every word you said should match a word in the name
  const ta = A.split(' ').filter(w => !STOP.has(w)), tb = B.split(' ').filter(w => !STOP.has(w));
  if (ta.length && tb.length) {
    let hit = 0;
    for (const w of ta) hit += Math.max(...tb.map(x => Math.max(ratio(w, x), ratio(sound(w), sound(x)))));
    const cover = hit / ta.length, coverB = Math.min(1, ta.length / tb.length);
    s = Math.max(s, cover * (0.8 + 0.2 * coverB));
  }
  return Math.min(1, s);
}
const artistNames = t => (t.artists?.length ? t.artists : [t.artist]).filter(Boolean);
function libraryCandidates(phrase) {
  let q = phrase.replace(/^(the |some |a )/, '').trim(), m;
  const out = [];
  const add = (c) => out.push(c);
  const pls = [...lib.playlists.values()];
  const albums = [...lib.albums.values(), ...store.implicitAlbums()];
  if (/^(my )?(liked|favorite|favourite|loved)( songs| tracks| music)?$|^my (likes|favorites|favourites)$/.test(q)) {
    const ids = likedIds(); if (ids.length) add({ kind: 'liked', ids, label: 'your Liked Songs', score: 1, key: 'liked' });
    return out;
  }
  if ((m = q.match(/^(?:my )?playlist (?:called |named )?(.+)$/)) || (m = q.match(/^(?:my )?(.+?) playlist$/))) {
    for (const p of pls) add({ kind: 'playlist', ids: p.trackIds, label: `your ${p.name} playlist`, name: p.name, score: fuzzy(m[1], p.name) + 0.04, key: 'p:' + p.id });
    return out;
  }
  if ((m = q.match(/^(?:the )?album (.+?)(?: by (.+))?$/))) {
    for (const a of albums) { let sc = fuzzy(m[1], a.title); if (m[2]) sc = sc * 0.65 + fuzzy(m[2], a.artist) * 0.35; add({ kind: 'album', ids: a.trackIds || [], label: `${a.title} by ${a.artist}`, name: a.title, score: sc, key: 'a:' + a.id }); }
    return out;
  }
  if ((m = q.match(/^(?:songs|music|tracks|something|stuff|anything|hits) (?:by|from) (.+)$/)) || (m = q.match(/^(.+?)'s (?:songs|music|hits)$/))) {
    for (const a of store.artists()) add({ kind: 'artist', name: a.name, label: a.name, score: fuzzy(m[1], a.name) + 0.03, key: 'r:' + a.key, shuffle: true });
    return out;
  }
  const songs = libTracks();
  if ((m = q.match(/^(.+) by (.+)$/))) {
    const [, title, by] = m;
    for (const t of songs) {
      const ts = fuzzy(title, t.title); if (ts < 0.45) continue;
      const as = Math.max(...artistNames(t).map(a => fuzzy(by, a)));
      add({ kind: 'song', ids: [t.id], label: `${displayTitle(t)} by ${t.artist}`, name: t.title, score: ts * 0.62 + as * 0.38, key: 's:' + t.id });
    }
    // "play <album> by <artist>" also counts
    for (const a of albums) add({ kind: 'album', ids: a.trackIds || [], label: `the album ${a.title} by ${a.artist}`, name: a.title, score: (fuzzy(title, a.title) * 0.62 + fuzzy(by, a.artist) * 0.38) - 0.04, key: 'a:' + a.id });
    return out;
  }
  // a bare name: could be a playlist, an artist, an album or a song ("essence", "essence wizkid")
  for (const p of pls) add({ kind: 'playlist', ids: p.trackIds, label: `your ${p.name} playlist`, name: p.name, score: fuzzy(q, p.name) + 0.02, key: 'p:' + p.id });
  for (const a of store.artists()) add({ kind: 'artist', name: a.name, label: a.name, score: fuzzy(q, a.name) + 0.01, key: 'r:' + a.key, shuffle: true });
  for (const a of albums) add({ kind: 'album', ids: a.trackIds || [], label: `the album ${a.title} by ${a.artist}`, name: a.title, score: fuzzy(q, a.title) - 0.03, key: 'a:' + a.id });
  for (const t of songs) {
    const s1 = fuzzy(q, t.title);
    const s2 = Math.max(...artistNames(t).map(a => fuzzy(q, `${t.title} ${a}`)), ...artistNames(t).map(a => fuzzy(q, `${a} ${t.title}`)));
    add({ kind: 'song', ids: [t.id], label: `${displayTitle(t)} by ${t.artist}`, name: t.title, score: Math.max(s1, s2 * 0.98), key: 's:' + t.id });
  }
  return out;
}
// Best library match over every way the phrase may have been heard
async function bestMatch(phrases, { exclude = new Set() } = {}) {
  const best = new Map();
  phrases.forEach((ph, i) => {
    const penalty = i === 0 ? 0 : 0.03; // the recogniser's first guess is usually right
    for (const c of libraryCandidates(ph)) {
      if (exclude.has(c.key)) continue;
      const sc = c.score - penalty;
      if (!best.has(c.key) || best.get(c.key).score < sc) best.set(c.key, { ...c, score: sc });
    }
  });
  const list = [...best.values()].sort((a, b) => b.score - a.score);
  const top = list[0]; if (!top) return null;
  top.runnerUp = list.find(c => c.key !== top.key && c.score > 0.5) || null;
  if (top.kind === 'artist') { const mine = artistTracks(top.name); top.ids = mine.map(t => t.id); }
  return top.ids?.length ? top : null;
}
let pending = null; // { action, cand, opts, phrases, tried:Set }
function confirmUI(on) { const c = el()?.querySelector('.vc-confirm'); if (c) c.hidden = !on; }
async function decide(action, phrases, opts = {}) {
  phrases = [...new Set(phrases.map(x => x.trim()).filter(Boolean))];
  const lib0 = opts.pre || await bestMatch(phrases, { exclude: opts.tried });
  const margin = lib0 ? lib0.score - (lib0.runnerUp?.score || 0) : 0;
  // Sure enough: do it
  if (lib0 && (lib0.score >= 0.9 || (lib0.score >= 0.8 && margin >= 0.1))) return perform(action, lib0, opts);
  // Somewhat sure: ask first
  if (lib0 && lib0.score >= 0.6) return ask(action, lib0, opts, phrases);
  // Not in the library: look it up in the music catalogue
  const r = await resolve(phrases[0]);
  if (r.none) return fail(r.none);
  const confident = r.kind === 'liked' || r.kind === 'playlist' || r.sure;
  return confident ? perform(action, r, opts) : ask(action, r, opts, phrases);
}
function perform(action, r, opts = {}) {
  pending = null; confirmUI(false);
  if (action === 'queue' || action === 'next') {
    player.addToQueue(r.ids, action === 'next');
    return say(action === 'next' ? `${cap(r.label)} plays next.` : (r.ids.length > 1 ? `Added ${r.ids.length} songs from ${r.label} to your queue.` : `Added ${r.label} to your queue.`));
  }
  player.playList(r.ids, 0, { shuffle: !!opts.shuffle || !!r.shuffle });
  const lines = r.kind === 'song' ? [`Playing ${r.label}.`, `Here's ${r.label}.`] :
    r.kind === 'artist' ? [`Playing ${r.label}.`, `Here's some ${r.label}.`] : [`Playing ${r.label}.`, `Here's ${r.label}.`, `Starting ${r.label}.`];
  return say(rand(lines));
}
async function ask(action, cand, opts, phrases) {
  const tried = opts.tried || new Set();
  if (cand.key) tried.add(cand.key);
  pending = { action, cand, opts: { ...opts, tried, pre: null }, phrases };
  keep = true;
  confirmUI(true);
  const verb = action === 'play' ? '' : action === 'next' ? ' next' : ' to the queue';
  await say(`Did you mean ${cand.label}${verb}?`);
  if (canListen && open) setTimeout(() => { if (pending && open && !listening) listen(); }, 150);
}
const YES = /^(yes|yeah|yep|yup|ya|sure|correct|right|ok|okay|that's it|that's right|that one|exactly|go ahead|play it|do it|please|of course|uh huh|mm hmm|yes please)\b/;
const NO = /^(no|nope|nah|not that|wrong|neither|no thanks|not really|cancel)\b/;
async function answer(q) {
  const p = pending;
  if (YES.test(q)) return perform(p.action, p.cand, p.opts);
  if (NO.test(q)) {
    // Offer the next-best library match once, otherwise ask again
    const next = !p.offeredNext && await bestMatch(p.phrases, { exclude: p.opts.tried });
    if (next && next.score >= 0.6) { await ask(p.action, next, p.opts, p.phrases); pending.offeredNext = true; return; }
    pending = null; confirmUI(false); keep = true;
    await say(p.action === 'play' ? 'Okay. What would you like me to play?' : 'Okay. Which song did you mean?');
    if (canListen && open) setTimeout(() => { if (open && !listening) listen(); }, 150);
    return;
  }
  // Said something else entirely: treat it as a new request (bare names keep the same action)
  pending = null; confirmUI(false);
  if (/^(play|put on|listen to|start|blast|shuffle|add|queue|go|open|show|search|find|pause|stop|next|skip)\b/.test(q)) return run(q);
  return decide(p.action, [q], { shuffle: p.opts.shuffle });
}

const PAGES = { home: '#/home', library: '#/library/songs', songs: '#/library/songs', 'liked songs': '#/library/liked', likes: '#/library/liked', liked: '#/library/liked', playlists: '#/library/playlists', albums: '#/library/albums', artists: '#/library/artists', search: '#/search', settings: '#/settings', import: '#/import', offline: '#/offline', queue: '#/queue', 'privacy policy': '#/legal', terms: '#/legal' };

async function handle(raw, alts = []) {
  const q = clean(raw);
  if (!q) return;
  keep = false;
  setState('thinking');
  try {
    if (pending) await answer(q);
    else await run(q, alts.map(clean).filter(Boolean));
  } catch (e) { console.warn(e); await fail('Hmm, something went wrong there. Mind trying again?'); }
  if (!listening) setState('idle');
  restoreAudio();
  // Task done: close the assistant (stays open if it couldn't help, so you can try again)
  if (open && !listening && !pending) scheduleClose(keep ? 8000 : 600);
}

async function run(q, alts = []) {
  let m;
  const cur = player.current();
  // --- playback controls
  if (/^(pause|stop)( the| this)?( music| song| track| it| playing)?$/.test(q)) { player.pause(); return say(rand(['Paused.', 'Okay, paused.', 'Done.'])); }
  if (/^(resume|continue|unpause|keep playing|play)( the| my)?( music| song| it)?$/.test(q)) { if (!cur) return fail('There\'s nothing queued up yet. Try "play my liked songs".'); player.play(); return say(rand(['Here we go.', 'Resuming.', 'Back on.'])); }
  if (/^(next|skip)( song| track| this( one| song)?)?$|^play (the )?next song$/.test(q)) { player.next(); return say(rand(['Skipping.', 'Next one.', 'Got it.'])); }
  if (/^(previous|last|go to the previous|play the previous|back to the last)( song| track| one)?$/.test(q)) { player.prev(); return say('Going back.'); }
  if (/^(restart|start over|play (it|this) again|from the (top|beginning))$/.test(q)) { player.seek(0); player.play(); return say('From the top.'); }
  if ((m = q.match(/^(turn )?(shuffle)( on| off)?$|^(turn (on|off) )shuffle$/))) { const off = /off/.test(q); player.setShuffle(!off); return say(off ? 'Shuffle\'s off.' : 'Shuffle\'s on.'); }
  if (/repeat (this|the song|one|it)|loop (this|it|the song)/.test(q)) { while (P.repeat !== 'one') player.cycleRepeat(); return say('I\'ll keep this one on repeat.'); }
  if (/^(turn )?(repeat|loop)( on| all)?$/.test(q)) { while (P.repeat !== 'all') player.cycleRepeat(); return say('Repeat is on.'); }
  if (/(repeat|loop) off|stop (repeating|looping)/.test(q)) { while (P.repeat !== 'off') player.cycleRepeat(); return say('Repeat is off.'); }
  if (/^(volume up|louder|turn (it|this|the volume) up|crank it( up)?)$/.test(q)) { const v = Math.min(1, P.volume + 0.2); player.setVolume(v); return say('Turning it up.'); }
  if (/^(volume down|quieter|softer|turn (it|this|the volume) down)$/.test(q)) { const v = Math.max(0.05, P.volume - 0.2); player.setVolume(v); return say('Turning it down.'); }
  if ((m = q.match(/^(?:set )?(?:the )?volume (?:to )?(\d{1,3})(?: percent|%)?$/))) { player.setVolume(Math.min(100, +m[1]) / 100); return say(`Volume at ${Math.min(100, +m[1])} percent.`); }
  if (/^mute$/.test(q)) { player.setVolume(0); return say('Muted.', { show: true }); }
  if (/(switch to|show|play|watch)( me)?( the)?( music)? video|video mode/.test(q)) { if (!cur) return fail('Nothing\'s playing yet.'); await player.setMode('video'); app.openNP(); return say('Here\'s the music video.'); }
  if (/(audio only|switch to audio|audio mode|hide (the )?video|just (the )?audio)/.test(q)) { await player.setMode('audio'); return say('Switched to audio only.'); }
  if (/^(show|open|display|pull up|give me)( me)?( the)? lyrics/.test(q) || /^lyrics$/.test(q)) { if (!cur) return fail('Play something first and I\'ll pull up the lyrics.'); app.openNP(); app.lyrics(true); return say('Here are the lyrics.'); }
  if (/^(hide|close)( the)? lyrics/.test(q)) { app.lyrics(false); return say('Lyrics hidden.'); }
  if (/^(open|show|go to)( the)? (now playing|full ?screen|player)$/.test(q)) { app.openNP(); return say('Here you go.'); }
  if (/^(close|exit|leave)( the)? (now playing|full ?screen|player)$/.test(q)) { app.closeNP(); return say('Okay.'); }
  if (/^(what'?s|what is) (this|playing|this song)|^what song is (this|playing)|^who (sings|is singing|made) (this|it)|^what am i listening to/.test(q)) {
    if (!cur) return say('Nothing\'s playing right now.');
    return say(`This is ${displayTitle(cur)} by ${cur.artist}${cur.album ? `, from ${cur.album}` : ''}.`);
  }
  if (/^(i )?(like|love)( this| this song| it)$|^(save|like|add) (this|this song|it) to (my )?(liked|likes|favorites|library)/.test(q)) {
    if (!cur) return fail('Nothing\'s playing.');
    if (!cur.liked || cur.transient) await store.upsertTracks([{ ...cur, liked: true, likedAt: Date.now() }]);
    return say(rand(['Saved to your Liked Songs.', 'Love it too. Added to Liked Songs.']));
  }
  // --- navigation
  if (/^(go )?back$|^go to the previous page$/.test(q)) { app.back(); return say('Okay.'); }
  if ((m = q.match(/^(?:go to|open|show(?: me)?|take me to|bring up|navigate to)(?: the| my)? (home|library|songs|liked songs|likes|liked|playlists|albums|artists|search|settings|import|offline|queue|privacy policy|terms)(?: page| tab| list)?$/))) {
    app.go(PAGES[m[1]]); return say(rand(['Here you go.', 'Opening ' + m[1] + '.', 'Sure.']));
  }
  if ((m = q.match(/^(?:go to|open|show(?: me)?)(?: the)? artist (.+)$/))) { app.go('#/artist/' + encodeURIComponent(m[1])); return say(`Here's ${m[1]}.`); }
  // --- search
  if ((m = q.match(/^(?:search(?: for)?|find(?: me)?|look up|look for|search youtube for) (.+)$/))) {
    app.search(m[1], /youtube/.test(q) ? 'youtube' : 'all'); return say(rand([`Here's what I found for ${m[1]}.`, `Searching for ${m[1]}.`]));
  }
  // --- queue
  const QUEUE_RE = [/^(?:add|put|throw|stick) (.+?) (?:to|in|on|into) (?:the |my )?queue$/, /^queue(?: up)? (.+)$/, /^play (.+?) next$/];
  if (QUEUE_RE.some(re => (m = q.match(re)))) {
    const next = /^play .+ next$/.test(q);
    const phrases = [m[1], ...alts.map(a => { for (const re of QUEUE_RE) { const x = a.match(re); if (x) return x[1]; } return null; }).filter(Boolean)];
    return decide(next ? 'next' : 'queue', phrases);
  }
  // --- play something
  const PLAY_RE = /^(?:play|put on|listen to|start|blast|shuffle)(?: me)? (.+)$/;
  if ((m = q.match(PLAY_RE))) {
    const shuffleWanted = /^shuffle /.test(q) || / on shuffle$/.test(q);
    const phrases = [m[1], ...alts.map(a => a.match(PLAY_RE)?.[1]).filter(Boolean)].map(x => x.replace(/ on shuffle$/, ''));
    return decide('play', phrases, { shuffle: shuffleWanted });
  }
  // --- anything else: treat it as something to play if it looks like a name, else search
  if (q.split(' ').length <= 6) {
    const best = await bestMatch([q, ...alts]);
    if (best && best.score >= 0.6) return decide('play', [q, ...alts], { pre: best });
  }
  app.search(q, 'all');
  return say(`I wasn't sure what you meant, so I searched for "${q}".`);
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);



// ---------- "Hey BAZINGA" — hands-free wake word (opt-in, Settings → Voice assistant) ----------
// While it's on and BAZINGA! is open on screen, the browser listens in the background. Saying
// "Hey Bazinga" (or just "Bazinga") opens the assistant; "Hey Bazinga, play my liked songs"
// does it straight away. Nothing is recorded or kept by BAZINGA!.
const WAKE = /\b(?:hey|hi|okay|ok|yo|a)?[\s,]*(ba[\s-]?[sz]ing(?:a|er|ah|uh|o)|bah?[\s-]?zing(?:a|er|ah)|bazooka|bossinga|bizinga|bezinga|pazinga)\b[\s,.!?]*/i;
let wakeOn = false, wakeRec = null, wakeTimer = null, wakeFails = 0, wakeHeard = false, wakeHeardTimer = null, wakeNeedsTap = false;
const wakeSupported = canListen;
const wakeActive = () => wakeOn;
// "Hey Bazinga" background listening has been retired: the microphone is only ever on while the
// assistant is open. setWake() always turns it off (kept so older saved settings can't switch it on).
function setWake(on) {
  wakeOn = false;
  if (wakeOn) { wakeFails = 0; startWake(); } else stopWake();
  emit('wake', wakeOn);
}
function scheduleWake(ms = 300) { clearTimeout(wakeTimer); if (wakeOn) wakeTimer = setTimeout(startWake, ms); }
function stopWake() {
  clearTimeout(wakeTimer); clearTimeout(wakeHeardTimer); wakeHeard = false;
  const r = wakeRec; wakeRec = null;
  if (r) { r.onend = r.onresult = r.onerror = null; try { r.abort(); } catch { } }
  document.body.classList.remove('wake-on');
}
function startWake() {
  if (!wakeOn || open || listening || wakeRec || document.hidden) return;
  let r;
  try { r = new Rec(); } catch { return; }
  r.lang = navigator.language || 'en-US';
  r.continuous = true; r.interimResults = true; r.maxAlternatives = 3;
  r.onstart = () => { wakeFails = 0; document.body.classList.add('wake-on'); };
  r.onresult = e => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      for (let k = 0; k < res.length; k++) {
        const text = res[k].transcript, m = text.match(WAKE);
        if (!m) continue;
        const rest = text.slice(m.index + m[0].length).trim();
        if (!wakeHeard) {               // show the assistant right away…
          wakeHeard = true;
          openVoice({ listenNow: false, fromWake: true }); // keep this listener going to catch the request
          setState('listening'); setReply('I\'m listening…'); duck(true); chime();
          clearTimeout(wakeHeardTimer);
          wakeHeardTimer = setTimeout(() => finishWake(''), 3500);
        }
        if (rest) setHeard(rest);
        if (res.isFinal) return finishWake(rest);
        return;
      }
    }
  };
  r.onerror = e => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      // Some browsers only allow the mic to start after a tap: try again on the next tap
      wakeNeedsTap = true;
      document.addEventListener('pointerdown', () => { if (wakeNeedsTap) { wakeNeedsTap = false; scheduleWake(50); } }, { once: true, capture: true });
    } else if (e.error !== 'no-speech' && e.error !== 'aborted') wakeFails++;
  };
  r.onend = () => {
    if (wakeRec === r) wakeRec = null;
    document.body.classList.remove('wake-on');
    if (wakeHeard) return finishWake('');
    if (!wakeNeedsTap) scheduleWake(wakeFails > 4 ? 15000 : wakeFails > 1 ? 3000 : 250);
  };
  wakeRec = r;
  try { r.start(); } catch { wakeRec = null; scheduleWake(3000); }
}
function finishWake(rest) {
  if (!wakeHeard) return;
  clearTimeout(wakeHeardTimer); wakeHeard = false;
  const r = wakeRec; wakeRec = null;
  if (r) { r.onend = r.onresult = r.onerror = null; try { r.abort(); } catch { } }
  document.body.classList.remove('wake-on');
  usedMic = true;
  const cmd = rest.replace(/^[,.\s]+/, '').trim();
  if (cmd.split(' ').length >= 1 && cmd.length > 2) { setHeard(cmd); handle(cmd); }
  else { setReply(rand(['Yes?', 'I\'m listening…', 'What do you want to hear?'])); setTimeout(() => { if (open && !listening) listen(); }, 120); }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) stopWake(); else scheduleWake(400); });
// Coming back to the page (Safari restores pages from its back/forward cache): the mic look must match reality
window.addEventListener('pageshow', () => micUI(open));
document.addEventListener('visibilitychange', () => { if (!document.hidden) micUI(open); });

return { canListen, voiceOptions, setVoicePrefs, previewVoice, initVoice, openVoice, wakeSupported, wakeActive, setWake };
})();
// ---------- legal.js ----------
const __m_legal = (() => {
// Privacy Policy & Terms of Use. Bump TERMS_VERSION whenever the text changes —
// every user will then be asked to accept again.
const TERMS_VERSION = '2026-10-30.2';
const OWNER = 'Abbel Dawit';

const LEGAL_HTML = `
<p class="tiny muted">Last updated: 30 October 2026 · Version ${TERMS_VERSION}</p>

<h3>Terms of Use</h3>
<p>BAZINGA! ("the App") is a free, personal project made available by ${OWNER} ("we", "us"). By creating a profile or otherwise using the App you agree to these Terms and the Privacy Policy below. If you do not agree, do not use the App.</p>

<h4>1. What the App is</h4>
<p>The App is a tool that runs entirely in your web browser. It helps you organise music you already have access to, look up matching videos on YouTube, and play them through YouTube's official embedded player or from files stored on your own device. The App does not host, sell, stream from its own servers, or distribute any music or video.</p>

<h4>2. Not affiliated</h4>
<p>The App is independent and is not affiliated with, endorsed by or sponsored by Spotify, YouTube, Google, Apple, or any artist, label or rights holder. All trademarks, names and artwork belong to their respective owners.</p>

<h4>3. Your responsibilities</h4>
<ul>
<li>You must be at least 13 years old (or the minimum age required where you live) to use the App.</li>
<li>You are solely responsible for how you use the App and for any content you import, add, play or share, including making sure you have the right to use any music files you add to the App.</li>
<li>You must follow the terms of every third-party service you use through the App, including YouTube's Terms of Service, Spotify's Developer and User Terms, and Apple's terms.</li>
<li>Lyrics are shown through Genius's own embed and remain the property of their rights holders; you may only use them for personal viewing.</li>
<li>You must not use the App for anything unlawful, to infringe anyone's rights, or to attempt to download or copy content from YouTube or other services.</li>
<li>You are responsible for keeping your own backups. Data stored in a browser can be lost (for example if browser data is cleared or a device is lost).</li>
</ul>

<h4>4. Third-party services</h4>
<p>The App connects directly from your device to third-party services (listed in the Privacy Policy). We do not control those services and are not responsible for their availability, accuracy, content, matching results, or how they handle your data. Search results and video matches are produced automatically and may be wrong, unavailable or removed at any time.</p>

<h4>5. No warranty</h4>
<p>THE APP IS PROVIDED "AS IS" AND "AS AVAILABLE", FREE OF CHARGE, WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS OR IMPLIED, INCLUDING ANY WARRANTY OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY, AVAILABILITY, SECURITY, OR THAT IT WILL BE ERROR-FREE OR THAT DATA WILL NOT BE LOST.</p>

<h4>6. Limitation of liability</h4>
<p>TO THE FULLEST EXTENT PERMITTED BY LAW, ${OWNER.toUpperCase()} AND ANY CONTRIBUTORS TO BAZINGA! SHALL NOT BE LIABLE FOR ANY CLAIM, LOSS OR DAMAGE OF ANY KIND — INCLUDING DIRECT, INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, LOSS OF DATA, LOSS OF PROFITS, DEVICE PROBLEMS, DATA CHARGES, OR CLAIMS BY THIRD PARTIES (INCLUDING COPYRIGHT CLAIMS) — ARISING OUT OF OR RELATED TO YOUR USE OF, OR INABILITY TO USE, THE APP OR ANY THIRD-PARTY SERVICE OR CONTENT ACCESSED THROUGH IT, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE. YOU USE THE APP ENTIRELY AT YOUR OWN RISK.</p>
<p>Some jurisdictions do not allow certain warranties or liabilities to be excluded. In those places, the exclusions above apply to the maximum extent the law allows.</p>

<h4>7. Indemnity</h4>
<p>You agree to defend, indemnify and hold harmless ${OWNER} and any contributors from any claims, damages, costs and expenses (including reasonable legal fees) arising from your use of the App, your content, or your breach of these Terms or of any third party's rights or terms.</p>

<h4>8. Changes and ending use</h4>
<p>We may change, suspend or discontinue the App, or update these Terms, at any time without notice. If the Terms change, the App will ask you to accept the new version before continuing. You can stop using the App at any time and delete all its data from Settings.</p>

<h4>9. General</h4>
<p>If any part of these Terms is found unenforceable, the rest remains in effect. These Terms are the entire agreement between you and us about the App.</p>

<h3>Privacy Policy</h3>
<h4>What we collect</h4>
<p><b>There are no accounts, no sign-in and no analytics.</b> We never ask for your name, email or password, and there is no advertising.</p>
<p><b>If you turn on device sync</b> (optional, Settings → Sync your devices), your device makes a random sync key and encrypts a copy of your music library (songs, likes, playlists, albums, YouTube matches, your display name and picture, and app settings, but never your API keys, tokens or offline music files) <b>before</b> it leaves the device. The encrypted copy is passed between your devices through ntfy.sh, a free public relay service, under a topic name derived from the key, together with a short device label such as "Safari on iPhone". Copies there expire after about 3 hours. Neither we nor ntfy.sh receive the key itself, so nobody else can read your library. If you create an 8-character short code, your sync key is posted to the relay encrypted with that code, and the app only accepts it for 15 minutes. Anyone you give your sync link, QR code or short code to can see and change your synced library, so share them only with your own devices. You can stop syncing at any time in <b>Settings → Sync your devices</b>.</p>

<h4>What is stored on your device</h4>
<p>Your display name, profile picture, library, playlists, albums, YouTube matches, settings, any music files you add, any Spotify sign-in token, and automatic backups are stored only in your browser's storage on your device (and in any backup file you choose to save). You can erase all of it at any time with <b>Settings → Erase this device</b>.</p>

<h4>Third-party services your device talks to</h4>
<p>To work, the App sends requests directly from your device to these services, which receive your IP address and the search terms or IDs needed. Their own privacy policies apply:</p>
<ul>
<li><b>YouTube / Google</b> — to show and play videos with the official YouTube player, and, if you add your own API key, to search YouTube.</li>
<li><b>Public Invidious and Piped servers</b> (independent, community-run) — to search for matching YouTube videos without an API key.</li>
<li><b>Apple iTunes Search API</b> — to look up genres, release dates, artwork, albums, artists and new releases.</li>
<li><b>Deezer API</b> — to find missing cover art and artist photos.</li>
<li><b>Genius</b> — only when you open lyrics: to find the song and show Genius's official lyrics widget (and, if you add one, using your own Genius access token).</li>
<li><b>Spotify</b> — only if you choose to connect it, to read your Liked Songs and playlists.</li>
<li><b>ntfy.sh</b> — only if you turn on device sync: relays the encrypted copy of your library between your devices (<a href="https://docs.ntfy.sh/privacy/" target="_blank" rel="noopener">ntfy.sh privacy policy</a>).</li>
<li><b>Google / YouTube account</b> — only if you choose to connect it (see below).</li>
<li><b>Buy Me a Coffee</b> — only if you choose to send a tip; payments happen on their site and BAZINGA! never sees your payment details.</li>
<li><b>Google Fonts</b> and <b>GitHub Pages</b> — to load the App's fonts and files.</li>
</ul>

<h4>YouTube account connection</h4>
<p>If you connect your YouTube account, BAZINGA! uses Google's sign-in to ask for permission to manage your YouTube playlists. It uses that permission <b>only</b> to (a) list your playlists and their videos when you choose to import them, and (b) create playlists and add videos to them when you choose "Save to YouTube". It never deletes anything, never uploads videos, never posts comments, and never reads anything else from your account. The access token Google issues is stored only on your device, expires after about an hour, and is never sent to us — we have no server. You can disconnect in Settings at any time, and revoke access completely at <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener">myaccount.google.com/permissions</a>.</p>
<p>BAZINGA! uses YouTube API Services. By using these features you agree to the <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener">YouTube Terms of Service</a>, and Google's handling of your data is described in the <a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Google Privacy Policy</a>.</p>

<h4>Voice assistant</h4>
<p>The voice assistant only listens after you tap the microphone, and stops after one request. Speech recognition is provided by your browser or operating system (for example Google in Chrome, Apple in Safari, Microsoft in Edge), which may process your voice on their servers under their own privacy policies. BAZINGA! itself never records, stores or sends your voice anywhere. If you prefer, you can type requests instead.</p>

<h4>Sharing</h4>
<p>When you share a song, playlist or album, its song list (and your username) is packed into the link itself. Anyone you give the link to can read it. Nothing is uploaded by the App.</p>

<h4>Children</h4>
<p>The App is not directed at children under 13.</p>

<h4>Contact</h4>
<p>Questions about these terms can be raised through the App's public GitHub repository.</p>
`;

return { TERMS_VERSION, OWNER, LEGAL_HTML };
})();
// ---------- qr.js ----------
const __m_qr = (() => {
// Tiny QR code maker (byte mode, error correction M), drawn as an SVG.
// Self-contained so the app needs no extra download. Based on the QR Code spec (ISO/IEC 18004).
const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const FORMAT_M = 0;

function rawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
  return r;
}
const dataCodewords = ver => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK_M[ver] * BLOCKS_M[ver];

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
  return z & 0xFF;
}
function rsDivisor(deg) {
  const r = new Array(deg).fill(0); r[deg - 1] = 1;
  let root = 1;
  for (let i = 0; i < deg; i++) {
    for (let j = 0; j < deg; j++) { r[j] = gfMul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; }
    root = gfMul(root, 0x02);
  }
  return r;
}
function rsRemainder(data, div) {
  const r = div.map(() => 0);
  for (const b of data) {
    const f = b ^ r.shift(); r.push(0);
    div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
  }
  return r;
}
function alignPositions(ver, size) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 1;
  for (; ver <= 40; ver++) {
    const cc = ver < 10 ? 8 : 16;
    if (4 + cc + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  }
  if (ver > 40) throw new Error('Too long for a QR code');
  const cap = dataCodewords(ver) * 8;
  // bit stream
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - bits.length % 8) % 8);
  for (let p = 0xEC; bits.length < cap; p ^= 0xEC ^ 0x11) put(p, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  // error correction + interleave
  const nBlocks = BLOCKS_M[ver], eccLen = ECC_PER_BLOCK_M[ver], raw = Math.floor(rawModules(ver) / 8);
  const nShort = nBlocks - raw % nBlocks, shortLen = Math.floor(raw / nBlocks);
  const div = rsDivisor(eccLen), blocks = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1)); k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const all = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) all.push(b[i]); });

  // modules
  const size = ver * 4 + 17;
  const M = Array.from({ length: size }, () => new Array(size).fill(false));
  const F = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = (x, y, dark) => { M[y][x] = dark; F[y][x] = true; };
  for (let i = 0; i < size; i++) { fn(6, i, i % 2 === 0); fn(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) fn(x, y, d !== 2 && d !== 4);
    }
  const al = alignPositions(ver, size), last = al.length - 1;
  al.forEach((ax, i) => al.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) fn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const drawFormat = mask => {
    const d = FORMAT_M << 3 | mask;
    let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412, bit = i => ((b >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) fn(8, i, bit(i));
    fn(8, 7, bit(6)); fn(8, 8, bit(7)); fn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) fn(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) fn(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) fn(8, size - 15 + i, bit(i));
    fn(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let r = ver; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25);
    const b = ver << 12 | r;
    for (let i = 0; i < 18; i++) { const bit = ((b >>> i) & 1) === 1, a = size - 11 + i % 3, c = Math.floor(i / 3); fn(a, c, bit); fn(c, a, bit); }
  }
  // data, zig-zag
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
      if (!F[y][x] && i < all.length * 8) { M[y][x] = ((all[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
    }
  }
  // pick the mask that's easiest to scan
  const maskFn = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
    (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
  const apply = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!F[y][x] && maskFn[m](x, y)) M[y][x] = !M[y][x]; };
  const penalty = () => {
    let p = 0, dark = 0;
    for (let y = 0; y < size; y++) for (const horiz of [true, false]) {
      let run = 0, prev = null;
      for (let x = 0; x < size; x++) {
        const c = horiz ? M[y][x] : M[x][y];
        if (c === prev) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else { run = 1; prev = c; }
      }
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = M[y][x]; if (c === M[y][x + 1] && c === M[y + 1][x] && c === M[y + 1][x + 1]) p += 3; }
    for (const row of M) for (const c of row) if (c) dark++;
    return p + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  };
  let best = 0, bestP = Infinity;
  for (let m = 0; m < 8; m++) { apply(m); drawFormat(m); const p = penalty(); if (p < bestP) { bestP = p; best = m; } apply(m); }
  apply(best); drawFormat(best);
  return M;
}

function qrSVG(text, { dark = '#000', light = '#fff', quiet = 4 } = {}) {
  const M = qrMatrix(text), n = M.length + quiet * 2;
  let d = '';
  M.forEach((row, y) => row.forEach((c, x) => { if (c) d += `M${x + quiet} ${y + quiet}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${n}" height="${n}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}

return { qrMatrix, qrSVG };
})();
// ---------- app.js ----------
const __m_app = (() => {
// BAZINGA — app shell, router and views
const { db, kv } = __m_db;
const { $, $$, esc, on, emit, toast, debounce, fmtTime, fmtDur, imageToDataURL, mainArtist, norm, trackKey, albumKey, yearOf, packToString, unpackString, sleep, downloadBlob, uid, displayTitle, genreOf } = __m_util;
const { icon, cover, trackRow, card, modal, promptText, confirmBox, menu, applyFilters, filterBar, empty, likedCover, loader, sized, toastUndo, THEMES, applyTheme, currentTheme, logoSrc } = __m_ui;
const { initVoice, openVoice, canListen, voiceOptions, setVoicePrefs, previewVoice, setWake, wakeSupported } = __m_voice;
const store = __m_store;
const { lib } = __m_store;
const meta = __m_meta;
const yt = __m_youtube;
const ya = __m_ytaccount;
const sync = __m_sync;
const sp = __m_spotify;
const imp = __m_importers;
const player = __m_player;
const { P } = __m_player;
const backup = __m_backup;
const { LEGAL_HTML, TERMS_VERSION } = __m_legal;
const { qrSVG } = __m_qr;

const view = () => $('#view');
const lists = new Map();      // listKey -> [trackIds] for "play from here"
const sections = new Map();   // sectionKey -> {tracks, opts}
const fstate = {};            // sectionKey -> filter state
let settings = { country: 'US', ytKey: '', customInstance: '', enrich: true, geniusToken: '', googleClientId: '', autoplay: 'liked', voiceName: '', wake: false };
const APP_VERSION = 'v1.1';
const APP_TAGLINE = 'Music Made For You';
const BMC_URL = 'https://buymeacoffee.com/bazinga.app';
let profile = null;
let routeToken = 0;

// ================= BOOT =================
async function boot() {
  window.__bzStarted = true;
  setTimeout(hideSplash, 12000); // never leave the splash up if something below goes wrong
  if (location.protocol === 'file:') setTimeout(() => toast('Opened from a file: library & offline files work, but YouTube playback, Spotify and sharing need the GitHub Pages link.', 'err'), 1500);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').then(r => r.update().catch(() => { })).catch(() => { });
  checkForUpdate(true);
  settings = { ...settings, ...(await kv.get('settings', {})) };
  applySettings();
  yt.startInstances(); // warm up the YouTube server list in the background
  ya.restoreSession();
  const joinReq = readJoinLink();
  try { if (await sp.handleRedirect()) { toast('Spotify connected ✓'); location.hash = '#/import'; } }
  catch (e) { toast(e.message, 'err'); }
  await store.load();
  for (const t of (await kv.get('mixTracks')) || []) store.remember(t); // songs of the last BAZINGA! mix (queue only)
  await retireAutoMix();
  profile = await kv.get('profile');
  await player.restore();
  player.setEndHook(queueEnded);
  (window.requestIdleCallback || (f => setTimeout(f, 1200)))(() => player.warmup());
  backup.startAuto();
  wireGlobal();
  wireLock();
  on('sync', () => { renderProfileChip(); const el = $('#sync-line'); if (el) el.innerHTML = syncLine(); });
  on('sync-removed', () => { toast('Sync was turned off on another device — your music stays here'); if (location.hash.startsWith('#/settings')) rerender(); });
  on('synced-in', () => { if (location.hash.startsWith('#/settings') && !$('.modal-wrap')) rerender(); });
  on('profile-changed', p => { profile = p; renderProfileChip(); });
  // Settings that arrived from another synced device
  on('settings-synced', s => { settings = { ...settings, ...s }; applySettings(); setVoicePrefs({ name: settings.voiceName || '' }); applyLockSetting(); if (location.hash.startsWith('#/settings') && !$('.modal-wrap') && !isTyping()) rerender(); });
  on('kv-synced', () => { ya.restoreSession(); });
  if (!profile) { welcome(joinReq); return; }
  await sync.restore();
  await showApp();
  if (joinReq) joinFlow(joinReq);
}

// ---------- Splash screen: fades out once the first screen is ready (shown at least ~1 s) ----------
function hideSplash() {
  const sp = $('#splash'); if (!sp || sp.classList.contains('out')) return;
  setTimeout(() => { sp.classList.add('out'); setTimeout(() => sp.remove(), 700); }, Math.max(0, 1100 - performance.now()));
}

// ---------- Always run the newest version ----------
// Every time BAZINGA! is opened (or comes back to the screen) it asks the site which version is
// live (version.json, written by build.py). If you've pushed an update to GitHub, it reloads into it
// straight away — or, if music is playing, at the next pause or the next time the app is opened.
const RUNNING_VERSION = (() => {
  const v = el => (el?.match(/[?&]v=([0-9a-f]+)/) || [])[1] || '';
  const js = v([...document.scripts].find(x => /js\/bazinga\.js\?v=/.test(x.src))?.src);
  const css = v([...document.querySelectorAll('link[rel=stylesheet]')].find(x => /css\/app\.css\?v=/.test(x.href))?.href);
  return js && css ? js + '.' + css : '';
})();
let updateReady = '', lastUpdateCheck = 0;
async function checkForUpdate(atLaunch = false) {
  if (!RUNNING_VERSION || !location.protocol.startsWith('http') || !navigator.onLine) return;
  if (!atLaunch && Date.now() - lastUpdateCheck < 60e3) return;
  lastUpdateCheck = Date.now();
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    const live = (await r.json())?.v;
    if (!live || live === RUNNING_VERSION) { try { sessionStorage.removeItem('bz_upd'); } catch { } return; }
    updateReady = live;
    applyUpdate(atLaunch);
  } catch { }
}
async function applyUpdate(atLaunch) {
  if (!updateReady) return;
  const busy = player.isOn?.() && !atLaunch;
  if (busy) return; // don't cut the music off — happens at the next pause or launch
  let tried = null; try { tried = sessionStorage.getItem('bz_upd'); } catch { }
  if (tried === updateReady + ':done') { updateReady = ''; return; } // already tried twice — give up quietly until the next launch
  if (tried === updateReady) {
    // A normal reload didn't pick it up: clear the app's saved files (never your music) and try once more
    try { for (const k of await caches.keys()) if (k !== 'bazinga-img') await caches.delete(k); } catch { }
    try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.update(); } catch { }
    try { sessionStorage.setItem('bz_upd', updateReady + ':done'); } catch { }
  } else { try { sessionStorage.setItem('bz_upd', updateReady); } catch { } }
  try { saveSpot(); } catch { }
  location.reload();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (updateReady && !player.isOn()) applyUpdate(false); else checkForUpdate(); } });
on('player', () => { if (updateReady && !player.isOn()) setTimeout(() => { if (!player.isOn()) applyUpdate(false); }, 1500); });

// ---------- Sync your devices (no login: QR code, link or short code) ----------
// Links look like  …/#/link/<sync key>  (QR code / copy link)  or  …/#/c/<8-letter code>  (short link)
function readJoinLink() {
  const m = location.hash.match(/^#\/(link|c)\/([A-Za-z0-9_-]+)/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search + '#/home');
  return m[1] === 'link' ? { secret: m[2] } : { code: m[2] };
}
function syncLine() {
  const S = sync.state();
  if (!sync.linked()) return '';
  const ago = S.lastSync ? Math.max(0, Math.round((Date.now() - S.lastSync) / 60e3)) : null;
  return S.status === 'syncing' ? `<span class="sync-st busy">${icon('cloud')} Syncing…</span>`
    : S.status === 'error' ? `<span class="sync-st err">${icon('cloudOff')} ${esc(S.error || 'Sync failed')} — will retry</span>`
    : S.status === 'offline' ? `<span class="sync-st">${icon('cloudOff')} Offline — will sync when you're back online</span>`
    : `<span class="sync-st ok">${icon('check')} Synced${ago === null ? '' : ago < 1 ? ' just now' : ` ${ago} min ago`}</span>`;
}
// A popup that shows how a sync is going (step + progress bar), with Cancel.
// Tapping outside or × just hides it — the sync carries on in the background.
async function withSyncProgress(title, task) {
  let box = null, closeIt = null;
  const set = (label, pct) => {
    if (!box) return;
    if (label) box.querySelector('.sp-step').textContent = label;
    if (pct != null) box.querySelector('.sp-bar i').style.width = Math.max(4, Math.min(100, pct)) + '%';
  };
  modal(`<div class="sync-prog"><div class="sp-orb">${icon('cloud')}</div><h3>${esc(title)}</h3>
      <p class="muted sp-step">Starting…</p><div class="sp-bar" role="progressbar"><i></i></div>
      <div class="modal-actions center"><button type="button" class="btn ghost" data-sp-cancel>Cancel</button></div>
      <p class="tiny muted">You can close this — syncing carries on in the background.</p></div>`, {
    onMount: (m, close) => {
      box = m; closeIt = close;
      m.querySelector('[data-sp-cancel]').onclick = () => { sync.cancel(); set('Cancelling…'); };
    }
  }).then(() => { box = null; });
  const off = on('sync-progress', ({ label, pct }) => set(label, pct));
  try { return await task(set); }
  finally { off(); if (box) { set('Done', 100); setTimeout(() => { if (box) closeIt(null); }, 350); } }
}
// Join another device's library (from a link, QR code or short code)
async function joinFlow(req) {
  if (!sync.available()) return toast('Device sync needs the online (GitHub Pages) version of BAZINGA!.', 'err');
  let secret = req.secret;
  try {
    if (!secret) { toast('Checking your code…'); secret = await sync.redeemCode(req.code); }
    secret = sync.cleanSecret(secret);
    if (sync.linked() && sync.linkInfo().secret === secret) return toast('This device is already synced ✓', 'ok');
    const found = await sync.peek(secret).catch(() => null);
    const hasLocal = store.saved().length || lib.playlists.size || lib.albums.size;
    let mode = req.mode || 'merge';
    if (hasLocal && !req.mode) {
      mode = await modal(`<h3>${icon('cloud')} Sync this device</h3>
        <p class="muted">Linking to the library from <b>${esc(found?.device || 'your other device')}</b>. This ${sync.linked() ? 'device is already synced with a different library' : 'device already has music'}. What should happen to it?</p>
        <div class="pick-list">
          <button class="pick wrap" data-resolve="merge">${cover('', '+', 'sm')}<span><b>Combine both</b><small>Keep this device's music and add the other device's (recommended)</small></span></button>
          <button class="pick wrap" data-resolve="replace">${cover('', '↺', 'sm')}<span><b>Use only the synced library</b><small>Replace the music on this device with the other device's</small></span></button>
        </div>`);
      if (!mode) return;
    }
    if (sync.linked()) await sync.leave();
    await withSyncProgress('Syncing your music', () => sync.join(secret, mode));
    const S = sync.state();
    if (S.status === 'error') throw new Error(S.error);
    toast(found ? `Synced ✓ — ${store.saved().length} songs on this device` : 'Linked ✓ — your music arrives the next time BAZINGA! is open on your other device', 'ok');
    renderProfileChip(); rerender();
  } catch (e) { if (e.cancelled) toast('Sync cancelled — nothing changed on this device'); else toast(e.message, 'err'); }
}
async function enterCodeDialog() {
  const r = await modal(`<h3>${icon('link')} Link this device</h3>
    <p class="muted tiny">On the device that has your music: <b>Settings → Sync your devices → Link a device</b>. Then scan the QR code with this device's camera, open the link, or type the short code here.</p>
    <form><label class="fld"><span>Short code or sync link</span><input name="c" required autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="K7M2-Q9XA"></label>
    <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Link</button></div></form>`);
  if (!r?.c) return null;
  const v = r.c.trim();
  const m = v.match(/#\/(link|c)\/([A-Za-z0-9_-]+)/);
  if (m) return m[1] === 'link' ? { secret: m[2] } : { code: m[2] };
  if (sync.cleanSecret(v).length >= 20) return { secret: v };
  return { code: v };
}
// Show the QR code + link + short code so another phone/browser can join
async function linkDeviceDialog() {
  if (!sync.available()) return toast('Device sync needs the online (GitHub Pages) version of BAZINGA!.', 'err');
  if (!sync.linked()) {
    try { await withSyncProgress('Turning on sync', () => sync.create()); renderProfileChip(); }
    catch (e) { return toast(e.cancelled ? 'Sync cancelled' : e.message, e.cancelled ? 'info' : 'err'); }
  }
  const url = sync.linkURL();
  let timer = null;
  await modal(`<div class="link-dlg">
    <h3>${icon('link')} Link another device</h3>
    <p class="muted tiny">Scan with the other phone's camera, or open the link in any browser — another browser on this phone works too. That device then stays in sync automatically.</p>
    <div class="qr-box">${qrSVG(url)}</div>
    <div class="row-btns center"><button class="btn primary" data-copy-link>${icon('link')}Copy link</button>${navigator.share ? `<button class="btn" data-share-link>${icon('share')}Share</button>` : ''}</div>
    <div class="code-box">
      <div class="kicker">Typing it in instead?</div>
      <div class="code-out" hidden><b class="code-big"></b><span class="tiny muted code-short"></span><span class="tiny muted code-left"></span></div>
      <button class="btn ghost" data-make-code>Get a short code</button>
    </div>
    <p class="tiny muted">Anyone with this link or code can see and change your library — only use it on your own devices.</p>
    <div class="modal-actions center"><button class="btn" data-close>Done</button></div></div>`, {
    onMount: m => {
      m.querySelector('[data-copy-link]').onclick = () => copyText(url);
      const sh = m.querySelector('[data-share-link]');
      if (sh) sh.onclick = () => navigator.share({ title: 'BAZINGA! sync link', text: 'Open this to sync your BAZINGA! music:', url }).catch(() => { });
      const mk = m.querySelector('[data-make-code]');
      mk.onclick = async () => {
        mk.disabled = true; mk.textContent = 'Making a code…';
        try {
          const code = await sync.makeCode(), until = Date.now() + 15 * 60e3;
          const out = m.querySelector('.code-out'); out.hidden = false;
          out.querySelector('.code-big').textContent = sync.prettyCode(code);
          out.querySelector('.code-short').textContent = sync.codeURL(code).replace(/^https?:\/\//, '');
          const tick = () => { const s = Math.max(0, Math.round((until - Date.now()) / 1000)); out.querySelector('.code-left').textContent = s ? `Works once, for ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Expired — get a new code'; if (!s) clearInterval(timer); };
          tick(); clearInterval(timer); timer = setInterval(tick, 1000);
          mk.textContent = 'Get a new code';
        } catch (e) { toast(e.message, 'err'); mk.textContent = 'Get a short code'; }
        mk.disabled = false;
      };
    }
  });
  clearInterval(timer);
  if (location.hash.startsWith('#/settings')) rerender();
}
async function syncMenu(kind) {
  if (kind === 'leave') {
    if (!await confirmBox('Stop syncing this device?', 'Your music stays on this device, but changes won\'t reach your other devices any more.', 'Stop syncing')) return;
    await sync.leave(); toast('This device is no longer synced'); renderProfileChip(); rerender();
  }
  if (kind === 'forget') {
    if (!await confirmBox('Turn off sync everywhere?', 'Every linked device stops syncing the next time it opens. Each device keeps the music it has.', 'Turn off everywhere', true)) return;
    try { await sync.removeEverywhere(); toast('Sync is off on every device'); renderProfileChip(); rerender(); } catch (e) { toast(e.message, 'err'); }
  }
}
async function wipeDevice() {
  player.stopAll();
  await db.destroy();
  try { localStorage.clear(); sessionStorage.clear(); } catch { }
  if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
  if (navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  location.replace(location.pathname);
}
async function profileChanged() { profile.updatedAt = Date.now(); await kv.set('profile', profile); emit('dirty', 'profile'); renderProfileChip(); }

function applySettings() {
  applyTheme(settings.theme || currentTheme());
  ya.setGoogleClientId(settings.googleClientId || window.BAZINGA_CONFIG?.googleClientId || '');
  meta.setCountry(settings.country);
  yt.setYTSettings({ ytKey: settings.ytKey, customInstance: settings.customInstance, ownerKey: window.BAZINGA_CONFIG?.youtubeApiKey || '' });
  store.setEnrich(settings.enrich !== false);
  keepAwake();
}

// ---------- Keep the screen on while BAZINGA! is open ----------
// Phones stop web music when they lock, so by default the screen stays awake while the app is open.
// Uses the Screen Wake Lock API; on older iPhones (no Wake Lock) a tiny silent, muted video does the same job.
let wakeLock = null, awakeVid = null;
async function keepAwake() {
  const want = settings.keepAwake !== false && !!profile && document.visibilityState === 'visible' && matchMedia('(pointer: coarse)').matches; // phones & tablets
  if (!want) {
    try { await wakeLock?.release(); } catch { } wakeLock = null;
    awakeVid?.pause();
    return;
  }
  if ('wakeLock' in navigator) {
    if (wakeLock && !wakeLock.released) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener?.('release', () => { wakeLock = null; }); } catch { wakeLock = null; }
    return;
  }
  if (!awakeVid) {
    awakeVid = document.createElement('video');
    Object.assign(awakeVid, { muted: true, loop: true, playsInline: true, src: 'media/awake.mp4' });
    awakeVid.setAttribute('playsinline', ''); awakeVid.setAttribute('muted', ''); awakeVid.setAttribute('aria-hidden', 'true');
    awakeVid.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0';
    document.body.appendChild(awakeVid);
  }
  awakeVid.play().catch(() => { });
}
document.addEventListener('visibilitychange', () => keepAwake());
// Some browsers only grant it after a tap — try again on the first touches until it holds
['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => { if (settings.keepAwake !== false && profile && !(wakeLock && !wakeLock.released) && !(awakeVid && !awakeVid.paused)) keepAwake(); }, { passive: true }));
// Colour swatches (welcome card + Settings → You). Tapping one previews it instantly.
const themePicker = (cur = currentTheme()) => `<div class="theme-pick" role="radiogroup" aria-label="Theme colour">${THEMES.map(([k, l, c]) =>
  `<button type="button" class="tp ${k === cur ? 'on' : ''}" data-theme="${k}" role="radio" aria-checked="${k === cur}" aria-label="${l}" title="${l}" style="--c:rgb(${c.join(' ')})"><i>${icon('check')}</i><span>${l}</span></button>`).join('')}</div>`;
function markThemePicks(name) { $$('.theme-pick .tp').forEach(b => { const on = b.dataset.theme === name; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); }); }
// Each setting remembers when YOU last changed it, so synced devices know which value is newer.
// Saving a form with an unchanged (or still empty) field doesn't count as a change.
async function saveSettings(patch) {
  const ts = { ...(settings._ts || {}) };
  for (const [k, v] of Object.entries(patch)) if (JSON.stringify(settings[k]) !== JSON.stringify(v)) ts[k] = Date.now();
  settings = { ...settings, ...patch, _ts: ts };
  await kv.set('settings', settings); applySettings(); emit('dirty', 'settings');
}

async function termsGate() {
  while (profile.termsAccepted !== TERMS_VERSION) {
    hideSplash();
    const r = await modal(`<h3>${icon('shield')} Privacy Policy & Terms</h3>
      <p class="muted tiny">${profile.termsAccepted ? 'Our terms have been updated. ' : ''}Please read and accept to keep using BAZINGA!.</p>
      <div class="legal-box">${LEGAL_HTML}</div>
      <form><label class="agree"><input type="checkbox" name="ok" required><span>I have read and agree to the Privacy Policy and Terms of Use, and I understand BAZINGA! is provided as-is with no liability.</span></label>
      <div class="modal-actions"><button type="button" class="btn ghost" data-resolve="no">Decline</button><button class="btn primary">Accept</button></div></form>`, { wide: true, locked: true });
    if (r && r.ok) { profile.termsAccepted = TERMS_VERSION; profile.termsAcceptedAt = new Date().toISOString(); await kv.set('profile', profile); emit('dirty', 'terms'); }
    else if (r === 'no') await modal(`<h3>You need to accept to use BAZINGA!</h3><p class="muted">If you don't agree, you can erase all of BAZINGA!'s data from this device.</p>
      <div class="modal-actions"><button class="btn danger" data-resolve="del">Delete my data</button><button class="btn primary" data-resolve="back">Go back</button></div>`, { locked: true })
      .then(x => x === 'del' && deleteAccount());
  }
}

// ---------- Screen lock: ignore touches while the music plays ----------
// Lock with the 🔒 button (top bar / sidebar / full-screen player) or by tapping an empty spot of
// the screen 3 times quickly. Tap 3 times anywhere to unlock. Settings → Playback turns it off.
let appLocked = false;
const lockFeature = () => settings.lockFeature !== false;
function setLocked(on) {
  appLocked = !!on;
  document.body.classList.toggle('app-locked', appLocked);
  let ov = $('#lock-layer');
  if (!ov) {
    ov = document.createElement('div'); ov.id = 'lock-layer'; ov.hidden = true;
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Screen locked');
    ov.innerHTML = `<div class="lock-pill">${icon('lock')}<span><b>Locked</b><small>Tap 3 times to unlock</small></span></div>`;
    document.body.appendChild(ov);
  }
  ov.hidden = !appLocked;
  if (appLocked) { try { document.activeElement?.blur(); } catch { } closeMenuSafe(); flashLockPill(); }
  else toast('Unlocked', 'ok');
}
function closeMenuSafe() { const m = $('#menu-root'); if (m) m.innerHTML = ''; }
let pillT = null;
function flashLockPill() {
  const p = $('#lock-layer .lock-pill'); if (!p) return;
  p.classList.add('show'); clearTimeout(pillT); pillT = setTimeout(() => p.classList.remove('show'), 2600);
}
function applyLockSetting() { document.body.classList.toggle('lock-off', !lockFeature()); }
function wireLock() {
  applyLockSetting();
  let taps = [];
  const interactive = 'button, a, input, select, textarea, label, summary, [data-act], [data-p], [contenteditable], .row, .card, .qrow, .modal-wrap, .menu, .menu-back, #yt-dock, .seek, .vol';
  document.addEventListener('pointerdown', e => {
    if (!appLocked && (!lockFeature() || !e.isPrimary || e.target.closest(interactive))) { taps = []; return; }
    const now = Date.now(), last = taps[taps.length - 1];
    if (last && (now - last.t > 500 || Math.hypot(e.clientX - last.x, e.clientY - last.y) > 60)) taps = [];
    taps.push({ t: now, x: e.clientX, y: e.clientY });
    if (appLocked) flashLockPill();
    if (taps.length >= 3) { taps = []; setLocked(!appLocked); }
  }, true);
  // While locked, nothing underneath reacts: no taps, keys, scrolling or zooming
  const block = e => { if (appLocked) { e.preventDefault(); e.stopPropagation(); } };
  ['click', 'dblclick', 'contextmenu', 'keydown', 'keypress', 'wheel', 'touchmove', 'gesturestart'].forEach(ev => document.addEventListener(ev, block, { capture: true, passive: false }));
}

// ---------- Keep the page pinned to the screen ----------
// iPhones scroll the whole page when the keyboard opens (or after a bounce) and sometimes leave it
// there, which lifts the bottom tab bar and leaves a gap under it — most visible in the installed app.
// Only the full-screen player scrolls the page on purpose, so everywhere else snap it back.
function pinPage() {
  if (document.body.classList.contains('np-open')) return;
  if (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop) { window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; }
}
const pinSoon = () => { setTimeout(pinPage, 60); setTimeout(pinPage, 350); };
document.addEventListener('focusout', pinSoon);
window.addEventListener('orientationchange', pinSoon);
window.addEventListener('pageshow', pinSoon);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pinSoon(); });
window.visualViewport?.addEventListener('resize', pinSoon);
window.addEventListener('scroll', () => { if (!document.body.classList.contains('np-open') && !isTypingNow()) pinSoon(); }, { passive: true });
const isTypingNow = () => document.activeElement?.matches?.('input,textarea,select');

// ---------- Phone top bar: shrink the logo text until everything fits ----------
// (Fonts and screen widths differ between phones, so measure instead of guessing.)
function fitTopbar() {
  const bar = $('.topbar'), wm = $('.brand-m .wordmark');
  if (!bar || !wm || getComputedStyle(bar).display === 'none') return;
  document.documentElement.style.removeProperty('--wm-size');
  let size = parseFloat(getComputedStyle(wm).fontSize) || 22, n = 0;
  const over = () => bar.scrollWidth > bar.clientWidth + 1 || [...bar.children].some(c => c.offsetParent && c.getBoundingClientRect().right > bar.getBoundingClientRect().right - 4);
  while (over() && size > 13 && n++ < 20) { size -= 1; document.documentElement.style.setProperty('--wm-size', size + 'px'); }
}
window.addEventListener('resize', debounce(fitTopbar, 150));
document.fonts?.ready?.then(() => fitTopbar());

// ---------- Live clock on the home hero (the device's own time zone & 12/24-hour setting) ----------
const clockText = () => new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
let clockTimer = null;
function startClock() {
  clearTimeout(clockTimer);
  const tick = () => {
    const els = $$('[data-clock]'); if (!els.length) return; // stops when you leave Home
    const t = clockText(); els.forEach(el => { if (el.textContent !== t) el.textContent = t; });
    const d = $('[data-date]'); if (d) d.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    clockTimer = setTimeout(tick, 60000 - Date.now() % 60000 + 50);
  };
  tick();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('[data-clock]')) startClock(); });

// ---------- Remember where you were (refresh / reopening the app lands on the same spot) ----------
const SPOT_KEY = 'bz_spot';
function saveSpot() {
  if (!profile || $('#app').hidden) return;
  try { localStorage.setItem(SPOT_KEY, JSON.stringify({ h: location.hash || '#/home', y: $('#main')?.scrollTop || 0, np: document.body.classList.contains('np-open'), q: lastSearch.q, tab: lastSearch.tab, ts: Date.now() })); } catch { }
}
function readSpot() { try { return JSON.parse(localStorage.getItem(SPOT_KEY) || 'null'); } catch { return null; } }
let restoreSpot = null;
function planRestore() {
  const sp = readSpot();
  if (!sp || Date.now() - sp.ts > 7 * 864e5) return;
  if (sp.q) lastSearch.q = sp.q;
  if (sp.tab) lastSearch.tab = sp.tab;
  const h = location.hash;
  // Installed apps always reopen at the start page, and some sign-in redirects drop the page — go back to where you were
  if ((!h || h === '#' || h === '#/' || h === '#/home') && sp.h && sp.h !== '#/home' && !/^#\/s\//.test(sp.h)) history.replaceState(null, '', location.pathname + location.search + sp.h);
  if ((location.hash || '#/home') === sp.h) restoreSpot = sp;
}
const saveSpotSoon = debounce(saveSpot, 300);
window.addEventListener('pagehide', saveSpot);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveSpot(); });

async function showApp() {
  await termsGate();
  planRestore();
  $('#onboarding').hidden = true;
  $('#app').hidden = false;
  $$('.ni').forEach(el => { const n = [...el.classList].find(c => c.startsWith('ni-')).slice(3); el.outerHTML = icon(n); });
  $('#main').addEventListener('scroll', saveSpotSoon, { passive: true });
  wireToTop();
  setTimeout(launchPopups, 3500);
  renderProfileChip(); renderSidebarPlaylists(); renderPlayer();
  requestAnimationFrame(fitTopbar); setTimeout(fitTopbar, 800);
  initVoice({
    go: h => { location.hash = h; }, back: () => goBack(),
    search: (q, tab = 'all') => { lastSearch.q = q; if (location.hash === '#/search/' + tab) route(); else location.hash = '#/search/' + tab; },
    openNP: () => openNP(), closeNP: () => closeNP(), lyrics: on => setLyrics(on), toast
  });
  route().finally(hideSplash);
  try { speechSynthesis.addEventListener('voiceschanged', () => { if (location.hash.startsWith('#/settings') && !$('#set-voice')) rerender(); }); } catch { }
  setVoicePrefs({ name: settings.voiceName || '' });
  setWake(false); // no background listening: the mic is only on while the assistant is open
  if (navigator.storage?.persist) navigator.storage.persist();
}

// ---------- Floating "back to top" (shows while you scroll far down, hides when you stop) ----------
function wireToTop() {
  const main = $('#main'), btn = $('#to-top');
  let idle = null, lastY = 0;
  const hide = () => btn.classList.remove('show');
  main.addEventListener('scroll', () => {
    const y = main.scrollTop;
    const far = y > Math.max(700, innerHeight * 1.2);
    btn.classList.toggle('show', far);
    lastY = y;
  }, { passive: true });
  btn.onclick = () => { main.scrollTo({ top: 0, behavior: 'smooth' }); hide(); };
}

// ---------- "Add to Home Screen" ----------
// Chrome/Edge/Samsung/Brave on Android & desktop give us a real install button; iPhone/iPad
// (Safari, and Chrome/Edge/Firefox there) and Firefox on Android get short step-by-step instructions.
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
window.addEventListener('appinstalled', () => { installEvt = null; kv.set('a2hs', { done: true }); toast('BAZINGA! is on your Home Screen ⚡', 'ok'); });
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// Counts each time the app is opened (a reload in the same tab doesn't count again)
async function countLaunch() {
  let fresh = true; try { fresh = !sessionStorage.getItem('bz_launch'); sessionStorage.setItem('bz_launch', '1'); } catch { }
  const n = ((await kv.get('launches')) || 0) + (fresh ? 1 : 0);
  if (fresh) await kv.set('launches', n);
  return { n, fresh };
}
const isInstalled = async () => isStandalone() || !!((await kv.get('a2hs')) || {}).done;
// First visit: "Add to Home Screen". Then every 5th visit until it's installed or "Don't show again".
// The "Do you love BAZINGA!?" coffee popup: every 10th time the app is opened, until "Don't show this again"
// (if it lands on an Add to Home Screen visit, it follows right after that popup).
async function launchPopups() {
  const { n, fresh } = await countLaunch();
  if (!fresh || !profile || $('.modal-wrap') || document.body.classList.contains('np-open')) return;
  const a2 = (await kv.get('a2hs')) || {}, cof = (await kv.get('phase2')) || {};
  const wantA2 = !a2.never && !(await isInstalled()) && (n === 1 || n % 5 === 0);
  const wantCoffee = !cof.never && (n % 10 === 0 || (cof.pending && n > 1));
  if (wantA2) await maybeInstallPrompt();
  if (!wantCoffee) return;
  cof.pending = false; await kv.set('phase2', cof);
  setTimeout(() => { if (!$('.modal-wrap') && !$('#mix-ov')) phase2Popup({ love: true }); else { cof.pending = true; kv.set('phase2', cof); } }, wantA2 ? 700 : 0);
}
async function maybeInstallPrompt(force = false) {
  if (isStandalone()) { if (force) toast('BAZINGA! is already installed on this device ✓', 'ok'); return; }
  const st = (await kv.get('a2hs')) || {};
  const ios = isIOS(), ua = navigator.userAgent;
  // Samsung Internet wraps installed sites in its own outdated Android package, which Google Play
  // Protect blocks ("Unsafe app blocked"). Nothing on our side can change that package, so on
  // Samsung Internet we never use its installer and send people to Chrome to install instead.
  const samsung = /SamsungBrowser/i.test(ua) && /android/i.test(ua);
  const canPrompt = installEvt && !samsung;
  const chromeIntent = `intent://${location.host}${location.pathname}#Intent;scheme=https;package=com.android.chrome;end`;
  const shareIc = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 11v9h14v-9"/></svg>';
  const dots = '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="19" r="1.8" fill="currentColor"/></svg>';
  const steps = canPrompt ? '' : samsung ? `<p class="a2-warn">${icon('shield')}<span>Samsung Internet's installer makes an app that Google Play Protect blocks. Install BAZINGA! from another browser instead — <b>Chrome, Firefox, Microsoft Edge, Brave or Opera</b> all work.</span></p>
      <ol class="a2-steps"><li>Tap <b>Copy link</b>, open one of those browsers (get one free from the Play Store if you need to) and paste the link.</li><li>In that browser, open its menu <span class="a2-ic">${dots}</span> and tap <b>Install</b> or <b>Add to Home screen</b>.</li><li>Bring your music along: here, <b>Settings → Sync your devices → Link a device</b>, then open that link in the new browser.</li></ol>` : ios ? `<ol class="a2-steps"><li>Tap the <b>Share</b> button <span class="a2-ic">${shareIc}</span> ${/CriOS|FxiOS|EdgiOS/.test(ua) ? '(top or bottom of the screen)' : 'in the toolbar'}.</li><li>Scroll and tap <b>Add to Home Screen</b> <span class="a2-ic">${icon('plus')}</span>.</li><li>Tap <b>Add</b>. Done — BAZINGA! opens like an app.</li></ol>`
    : /Firefox/i.test(ua) ? `<ol class="a2-steps"><li>Tap the menu <span class="a2-ic">${dots}</span>.</li><li>Tap <b>Install</b> (or <b>Add to Home screen</b>).</li></ol>`
    : `<ol class="a2-steps"><li>Open your browser menu <span class="a2-ic">${dots}</span>.</li><li>Tap <b>Install app</b> or <b>Add to Home screen</b>.</li></ol>`;
  const r = await modal(`<div class="a2hs">
      <div class="a2-icon"><img src="${logoSrc('app-192')}" alt="BAZINGA! app icon" width="96" height="96"></div>
      <h3>Add BAZINGA! to your Home Screen</h3>
      <p class="muted">One tap away, full screen like a real app, and music keeps going better in the background.</p>
      ${steps}
      <div class="modal-actions center">${canPrompt ? `<button class="btn primary" data-resolve="install">${icon('plus')}Add to Home Screen</button>` : samsung ? `<button class="btn primary" type="button" data-copy-app>${icon('link')}Copy link</button><a class="btn" href="${esc(chromeIntent)}">Open in Chrome</a>` : `<button class="btn primary" data-resolve="later">Got it</button>`}</div>
      <button class="lnk tiny a2-never" data-resolve="never">Don't show this again</button>
    </div>`, { onMount: m => { const c = m.querySelector('[data-copy-app]'); if (c) c.onclick = async () => toast(await copyText(location.origin + location.pathname) ? 'Link copied — paste it into your other browser' : location.origin + location.pathname, 'ok'); } });
  if (r === 'install' && canPrompt) {
    installEvt.prompt();
    try { const c = await installEvt.userChoice; if (c.outcome === 'accepted') st.done = true; } catch { }
    installEvt = null;
  } else if (r === 'never') st.never = true;
  kv.set('a2hs', st);
}

// ================= WELCOME (no sign-up, no login) =================
// One tap to start. Name and photo are optional and can be set any time in Settings.
function welcome(joinReq = null) {
  $('#app').hidden = true;
  const ob = $('#onboarding'); ob.hidden = false;
  const canSync = sync.available();
  ob.innerHTML = `<div class="ob-card">
    <div class="ob-brand"><span class="logo-mark big"><img src="${logoSrc('icon-512')}" class="ob-logo" alt=""></span><h1 class="wordmark">BAZINGA!</h1></div>
    <p class="muted ob-sub">${joinReq ? 'Almost there! This browser will sync with your music from your other device.' : 'All your favorite songs from Spotify and Apple Music, playing as music videos and audio in one free player. No sign up, no login, just press play ⚡'}</p>
    ${!joinReq ? `<form id="ob-form" class="ob-form" novalidate>
      <label class="ob-pic" title="Add a profile picture (optional)"><input type="file" accept="image/*" id="ob-file" hidden><div class="avatar xl" id="ob-avatar">${icon('user')}</div><span>Add photo</span></label>
      <label class="fld"><span>Pick a username</span><input name="username" id="ob-name" maxlength="30" autocomplete="nickname" placeholder="e.g. thunderkid" enterkeyhint="go"></label>
      <div class="fld ob-theme"><span>Pick your color</span>${themePicker()}</div>
    </form>` : ''}
    <label class="agree ob-terms"><input type="checkbox" id="ob-terms"><span>I agree to the <a class="lnk" href="#" id="ob-legal">Privacy Policy & Terms of Use</a>. BAZINGA! is provided as-is and isn't liable for anything.</span></label>
    <button class="btn primary big" id="ob-go">${joinReq ? `${icon('link')}Sync this browser` : `Let's go ${icon('play')}`}</button>
    ${!joinReq && canSync ? `<button class="btn" id="ob-link">${icon('qr')}I use BAZINGA! on another device</button>` : ''}
    ${!joinReq ? `<button class="btn ghost" id="ob-restore">${icon('restore')}Restore from a backup file</button>` : ''}
    <p class="tiny muted">No email, no password — your name and music are saved on this device.</p>
    <p class="copyright">© 2026 Abbel Dawit · BAZINGA!</p>
  </div>`;
  $('#ob-legal').onclick = e => { e.preventDefault(); showLegal(); };
  hideSplash();
  const termsOk = () => {
    if ($('#ob-terms').checked) return true;
    $('.ob-terms').classList.add('shake'); setTimeout(() => $('.ob-terms')?.classList.remove('shake'), 600);
    toast('Please accept the Privacy Policy & Terms first', 'err'); return false;
  };
  let pic = '';
  const fileIn = $('#ob-file');
  if (fileIn) fileIn.onchange = async e => { const f = e.target.files[0]; if (!f) return; pic = await imageToDataURL(f, 256); $('#ob-avatar').innerHTML = `<img src="${pic}" alt="">`; };
  const nameOk = () => {
    const i = $('#ob-name'); if (!i) return true;
    if (i.value.trim()) return true;
    i.focus(); i.closest('.fld').classList.add('shake'); setTimeout(() => i.closest('.fld')?.classList.remove('shake'), 600);
    toast('Pick a username first', 'err'); return false;
  };
  $('#ob-form')?.addEventListener('submit', e => { e.preventDefault(); $('#ob-go').click(); });
  ob.addEventListener('click', e => { const b = e.target.closest('[data-theme]'); if (!b) return; applyTheme(b.dataset.theme); markThemePicks(b.dataset.theme); });
  const start = async (req, name = '') => {
    profile = { username: name || 'Listener', picture: name ? pic : '', createdAt: Date.now(), updatedAt: name ? Date.now() : 0, termsAccepted: TERMS_VERSION, termsAcceptedAt: new Date().toISOString() };
    await kv.set('profile', profile);
    emit('dirty', 'profile');
    await saveSettings({ theme: currentTheme() });
    location.hash = '#/home';
    await sync.restore();
    await showApp();
    if (req) joinFlow({ ...req, mode: 'replace' });
  };
  $('#ob-go').onclick = () => { if (!joinReq && !nameOk()) return; if (termsOk()) start(joinReq, joinReq ? '' : $('#ob-name').value.trim().slice(0, 30)); };
  const lk = $('#ob-link');
  if (lk) lk.onclick = async () => { if (!termsOk()) return; const req = await enterCodeDialog(); if (req) start(req); };
  const rs = $('#ob-restore');
  if (rs) rs.onclick = () => pickFile('.json,application/json', async f => {
    try { await backup.restoreFromFile(f); location.reload(); } catch (err) { toast(err.message, 'err'); }
  });
}

// ================= ROUTER =================
window.addEventListener('hashchange', () => profile && profile.termsAccepted === TERMS_VERSION && route());
const showLegal = () => modal(`<h3>${icon('shield')} Privacy Policy & Terms</h3><div class="legal-box">${LEGAL_HTML}</div>`, { wide: true });
// Browser tab title: "BAZINGA! - <page>"
const setTitle = x => { document.title = 'BAZINGA! - ' + (x || APP_TAGLINE); };
const TITLES = { new: 'New from your top artists', home: APP_TAGLINE, search: 'Search', import: 'Settings', offline: 'Offline', settings: 'Settings', queue: 'Queue', legal: 'Privacy & Terms', s: 'Shared music', support: 'Support' };
const LIB_TABS = { songs: 'Songs', liked: 'Liked Songs', playlists: 'Playlists', albums: 'Albums', artists: 'Artists' };
// Where "Back" goes when there's no in-app history (e.g. a shared link opened directly)
const BACK_TO = { new: ['#/home', 'Home'], artist: ['#/library/artists', 'Artists'], album: ['#/library/albums', 'Albums'], playlist: ['#/library/playlists', 'Playlists'], genre: ['#/home', 'Home'], s: ['#/home', 'Home'], legal: ['#/settings', 'Settings'], queue: ['#/home', 'Home'] };
const navStack = [];
function goBack() {
  const name = (location.hash.replace(/^#\/?/, '').split('/')[0]);
  if (navStack.length > 1) history.back();
  else location.hash = (BACK_TO[name] || ['#/home'])[0];
}

async function route() {
  if (/^#\/(link|c)\//.test(location.hash)) { const req = readJoinLink(); if (req) joinFlow(req); return route(); }
  const my = ++routeToken;
  const full = location.hash || '#/home';
  if (navStack[navStack.length - 2] === full) navStack.pop(); else if (navStack[navStack.length - 1] !== full) navStack.push(full);
  if (navStack.length > 50) navStack.shift();
  const h = location.hash.replace(/^#\/?/, '') || 'home';
  const [name, ...rest] = h.split('/');
  setTitle(name === 'library' ? (LIB_TABS[rest[0] || 'songs'] || 'Library') : (TITLES[name] || (name === 'genre' ? decodeURIComponent(rest[0] || '') : APP_TAGLINE)));
  const arg = rest.map(decodeURIComponent);
  lists.clear(); sections.clear(); pagers.clear();
  $('#main')?.removeEventListener('scroll', settingsSpy);
  $$('.nav a, .tabbar a').forEach(a => a.classList.toggle('on', a.dataset.r === name || (name === 'import' && a.dataset.r === 'settings')));
  if (!restoreSpot?.np && document.body.classList.contains('np-open')) closeNP('nav');
  $('#modal-root').innerHTML = ''; $('#menu-root').innerHTML = '';
  closeQueueOnMobile();
  const v = view();
  v.scrollTop = 0; $('#main').scrollTop = 0;
  const routes = { new: vNewReleases, home: vHome, search: vSearch, library: vLibrary, playlist: vPlaylist, album: vAlbum, artist: vArtist, import: () => vSettings(['import']), offline: vOffline, settings: vSettings, s: vShared, queue: vQueue, genre: vGenre, legal: vLegal, support: vSupport };
  const fn = routes[name] || vHome;
  v.innerHTML = loader();
  // Back button on detail pages (artist, album, playlist, genre, shared, …) — added as soon as the
  // page appears, not after slow lookups finish
  const addBack = () => {
    const page = v.querySelector('.page');
    if (my !== routeToken || !page || !BACK_TO[name] || page.querySelector('.backbtn')) return;
    const prev = navStack[navStack.length - 2];
    const label = prev ? backLabel(prev) : BACK_TO[name][1];
    page.insertAdjacentHTML('afterbegin', `<button class="backbtn" data-act="go-back">${icon('back')}<span>${esc(label)}</span></button>`);
  };
  const run = (async () => fn(arg, my))();
  addBack(); requestAnimationFrame(addBack);
  try { await run; } catch (e) { console.error(e); if (my === routeToken) v.innerHTML = empty('Something went wrong', esc(e.message)); }
  if (my !== routeToken) return;
  addBack();
  markNow();
  // Coming back after a refresh: same scroll position, full-screen player open again if it was
  if (restoreSpot) {
    const sp = restoreSpot; restoreSpot = null;
    const y = sp.y || 0;
    if (y) { $('#main').scrollTop = y; setTimeout(() => { if ($('#main').scrollTop < y - 5) $('#main').scrollTop = y; }, 400); }
    if (sp.np && player.current()) openNP();
  }
  saveSpotSoon();
}
function backLabel(hash) {
  const [n, a] = hash.replace(/^#\/?/, '').split('/');
  if (n === 'library') return LIB_TABS[a || 'songs'] || 'Library';
  if (n === 'artist') return decodeURIComponent(a || 'Artist');
  if (n === 'playlist') return lib.playlists.get(a)?.name || 'Playlist';
  if (n === 'album') return 'Album';
  if (n === 'genre') return decodeURIComponent(a || 'Genre');
  return TITLES[n] === APP_TAGLINE ? 'Home' : (TITLES[n] || 'Back');
}
const stale = my => my !== routeToken;
const rerender = debounce(() => {
  // Re-render the current view softly when library changes (keeps scroll)
  const sc = $('#main').scrollTop;
  route().then(() => { $('#main').scrollTop = sc; });
}, 250);

// ================= TRACK LIST SECTIONS =================
const PAGE = 150;
function tracksSection(key, tracks, opts = {}) {
  sections.set(key, { tracks, opts });
  fstate[key] = fstate[key] || { sort: opts.defaultSort ?? 'added', open: false };
  return `<div class="tsec" data-tsec="${key}">${tracksSectionInner(key)}</div>`;
}
function tracksSectionInner(key) {
  const { tracks, opts } = sections.get(key);
  const f = fstate[key];
  const shown = opts.noFilter ? tracks : applyFilters(tracks, f);
  lists.set(key, shown.map(t => t.id));
  const cur = player.current()?.id;
  const head = opts.noFilter ? '' : filterBar(f, tracks, { keepOrder: opts.keepOrder, likedSort: opts.likedSort });
  const count = !opts.noFilter && shown.length !== tracks.length ? `<div class="muted tiny count">${shown.length} of ${tracks.length} songs</div>` : '';
  const rows = shown.slice(0, PAGE).map((t, i) => trackRow(t, i, { list: key, playlistId: opts.playlistId, numbered: opts.numbered }, cur)).join('');
  const more = shown.length > PAGE ? `<div class="more" data-more="${key}" data-at="${PAGE}"></div>` : '';
  return head + count + `<div class="rows">${rows || '<div class="muted pad">No songs match these filters.</div>'}</div>` + more;
}
function refreshSection(key, keepFocus) {
  const el = $(`[data-tsec="${key}"]`); if (!el) return;
  const active = document.activeElement?.dataset?.f;
  const pos = document.activeElement?.selectionStart;
  el.innerHTML = tracksSectionInner(key);
  markNow();
  if (keepFocus && active) { const i = el.querySelector(`[data-f="${active}"]`); i?.focus(); try { i.setSelectionRange(pos, pos); } catch { } }
  observeMore();
}
const moreObs = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const el = e.target, key = el.dataset.more, at = +el.dataset.at;
    const ids = lists.get(key) || [];
    const rowsEl = el.previousElementSibling;
    const cur = player.current()?.id;
    const { opts } = sections.get(key) || { opts: {} };
    rowsEl.insertAdjacentHTML('beforeend', ids.slice(at, at + PAGE).map((id, j) => trackRow(lib.tracks.get(id), at + j, { list: key, playlistId: opts.playlistId }, cur)).join(''));
    if (at + PAGE >= ids.length) { moreObs.unobserve(el); el.remove(); } else el.dataset.at = at + PAGE;
    markNow();
  }
}, { rootMargin: '600px' });
function observeMore() { $$('[data-more]').forEach(el => moreObs.observe(el)); }

// ================= VIEWS =================
function header(title, sub = '', art = '', actions = '', kind = '') {
  return `<header class="hero ${art ? 'has-art' : ''}">
    ${art ? `<div class="hero-art ${kind === 'artist' ? 'round' : ''}">${art}</div>` : ''}
    <div class="hero-txt">${kind ? `<div class="kicker">${kind}</div>` : ''}<h1>${title}</h1>${sub ? `<div class="hero-sub">${sub}</div>` : ''}</div>
  </header>${actions ? `<div class="actions">${actions}</div>` : ''}`;
}
const playBtns = (act, id = '') => `<button class="btn primary round-play" data-act="${act}" data-id="${esc(id)}" aria-label="Play">${icon('play')}</button>
  <button class="ib lg" data-act="${act}" data-id="${esc(id)}" data-shuffle="1" aria-label="Shuffle play" title="Shuffle">${icon('shuffle')}</button>
  <button class="ib lg" data-act="${act}" data-id="${esc(id)}" data-queue="1" aria-label="Add all to queue" title="Add to queue">${icon('queue')}</button>`;

// ---------- HOME ----------
async function vHome(_, my) {
  const all = store.saved();
  const hr = new Date().getHours();
  const greet = hr < 5 ? 'Late night vibes' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  if (!all.length) {
    view().innerHTML = `<div class="page home">
      <section class="home-hero empty-hero"><div class="hh-bg"></div><div class="hh-txt"><div class="kicker hh-when"><span data-date>${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span><span class="hh-time">${icon('clock')}<time data-clock>${clockText()}</time></span></div><h1>${greet}${profile.username && profile.username !== 'Listener' ? ', ' + esc(profile.username) : ''}</h1>
        <p>Bring in your Spotify, Apple Music or YouTube favourites and play them as music videos or audio.</p>
        <div class="row-btns">${bzBtn('primary')}<a class="btn" href="#/search">${icon('search')}Search</a><a class="btn" href="#/import">${icon('import')}Import music</a></div>
        <p class="tiny muted hh-note">You can import any time from Settings → Import music.${sync.available() && !sync.linked() ? ' Already using BAZINGA! somewhere else? <button class="lnk" data-act="enter-code">Link this device</button>.' : ''}</p></div></section></div>`;
    startClock();
    return;
  }
  const liked = all.filter(t => t.liked);
  const recent = all.filter(t => !t.mix || t.liked).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 12);
  // Top playlists: the ones you play most, then the newest
  const plays = (await kv.get('plPlays')) || {};
  if (stale(my)) return;
  const pls = [...lib.playlists.values()].sort((a, b) => ((plays[b.id]?.n || 0) - (plays[a.id]?.n || 0)) || ((plays[b.id]?.at || 0) - (plays[a.id]?.at || 0)) || ((b.createdAt || 0) - (a.createdAt || 0)));
  const albums = [...lib.albums.values()].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  const arts = store.artists().sort((a, b) => b.count - a.count).slice(0, 14);
  const gens = store.genres().slice(0, 10);
  const cur = player.current();
  const heroArt = cur?.artwork || liked.find(t => t.artwork)?.artwork || all.find(t => t.artwork)?.artwork || '';
  const collage = [...new Set([cur, ...liked, ...recent].filter(t => t?.artwork).map(t => t.artwork))].slice(0, 4);
  lists.set('recent', recent.map(t => t.id));
  if (cur) lists.set('cont', [cur.id]);
  view().innerHTML = `<div class="page home">
    <section class="home-hero">
      <div class="hh-bg" ${heroArt ? `style="background-image:url('${esc(sized(heroArt, 300))}')"` : ''}></div>
      <div class="hh-txt">
        <div class="kicker hh-when"><span data-date>${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span><span class="hh-time">${icon('clock')}<time data-clock>${clockText()}</time></span></div>
        <h1>${greet}${profile.username && profile.username !== 'Listener' ? ', ' + esc(profile.username) : ''}</h1>
        <p>${all.length} songs · ${lib.playlists.size} playlists · ${store.artists().length} artists</p>
        <div class="row-btns">
          ${bzBtn('primary')}
          ${liked.length ? `<button class="btn" data-act="play-list" data-id="home-liked">${icon('play')}Play Liked Songs</button>` : ''}
          <button class="btn" data-act="play-list" data-id="home-all" data-shuffle="1">${icon('shuffle')}Shuffle everything</button>
        </div>
      </div>
      ${collage.length >= 2 ? `<div class="hh-collage">${collage.map((src, i) => `<img src="${esc(sized(src, 300))}" alt="" style="--i:${i}" loading="lazy">`).join('')}</div>` : ''}
    </section>
    ${cur ? `<section class="jump" id="jump">${jumpInner(cur)}</section>` : ''}
    <section class="home-pls"><div class="sec-h"><h2>Your playlists</h2><a href="#/library/playlists" class="lnk">See all</a></div>
      <div class="pl-grid">
        <a class="card" href="#/library/liked"><div class="card-art">${likedCover()}<button class="fab-play" data-act="play-list" data-id="home-liked" aria-label="Play Liked Songs">${icon('play')}</button></div><div class="card-t">Liked Songs</div><div class="card-s">${liked.length} songs</div></a>
        ${pls.slice(0, 5).map(p => card({ href: `#/playlist/${p.id}`, img: plCover(p), title: p.name, sub: `${p.trackIds.length} songs`, act: 'play-playlist', id: p.id })).join('')}
        ${!pls.length ? `<button class="card card-new" data-act="new-playlist"><div class="card-art"><div class="cover noimg new-pl">${icon('plus')}</div></div><div class="card-t">New playlist</div><div class="card-s">Make your own mix</div></button>` : ''}
      </div></section>
    <section id="new-releases" class="shelf-sec"></section>
    <section class="home-recent"><div class="sec-h"><h2>Recently added</h2><a href="#/library/songs" class="lnk">See all</a></div>
      <div class="rows two">${recent.map((t, i) => trackRow(t, i, { list: 'recent' })).join('')}</div></section>
    <section class="shelf-sec"><div class="sec-h"><h2>Your artists</h2><a href="#/library/artists" class="lnk">See all</a></div>
      <div class="shelf">${arts.map(a => artistCard(a.name, a.artwork, `${a.count} song${a.count > 1 ? 's' : ''}`)).join('')}</div></section>
    ${gens.length ? `<section><div class="sec-h"><h2>Your genres</h2></div><div class="genre-tiles">${gens.map(([g, n]) => `<a class="gt" href="#/genre/${encodeURIComponent(g)}" style="--c:${genreColor(g)}"><b>${esc(g)}</b><small>${n} songs</small></a>`).join('')}</div></section>` : ''}
    ${albums.length ? `<section class="shelf-sec"><div class="sec-h"><h2>Your albums</h2><a href="#/library/albums" class="lnk">See all</a></div><div class="shelf">${albums.slice(0, 14).map(albumCard).join('')}</div></section>` : ''}
  </div>`;
  lists.set('home-liked', liked.sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0)).map(t => t.id));
  lists.set('home-all', all.map(t => t.id));
  fillArtistPics();
  startClock();
  newReleases(my);
}

// "Jump back in" — kept in sync with the player instantly (no page reload)
// The BAZINGA! button: one tap builds a fresh mix of new songs from your top artists and genres
const bzBtn = (cls = '') => `<button class="btn bz-btn ${cls}" data-act="bz-mix" aria-label="BAZINGA! Make me a fresh mix"><img src="${logoSrc()}" alt="" class="bz-bolt" width="22" height="22" decoding="sync" draggable="false">BAZINGA!</button>`;
const jumpBtn = (on = player.isOn()) => `${icon(on ? 'pause' : 'play')}<span>${on ? 'Pause' : 'Resume'}</span>`;
const jumpInner = t => `<div class="jump-art" data-jid="${esc(t.id)}">${cover(t.artwork, t.title)}</div><div class="jump-txt"><div class="kicker">Jump back in</div><h2>${esc(displayTitle(t))}</h2><p>${esc(t.artist)}</p>
  <div class="row-btns"><button class="btn primary" data-p-ext="toggle" id="jump-toggle" data-on="${player.isOn() ? 1 : 0}">${jumpBtn()}</button><button class="btn" data-p-ext="open">${icon('expand')}<span>Full screen</span></button></div></div>`;
function updateJump() {
  const box = $('#jump'); if (!box) return;
  const t = player.current(); if (!t) return;
  const art = box.querySelector('.jump-art');
  if (art?.dataset.jid !== t.id || (t.artwork && !art.querySelector('img'))) { box.innerHTML = jumpInner(t); return; }
  const b = $('#jump-toggle'), on = player.isOn() ? '1' : '0';
  if (b && b.dataset.on !== on) { b.dataset.on = on; b.innerHTML = jumpBtn(on === '1'); }
}

// "New from your artists": latest releases by the artists you listen to most.
// Cached for 12 hours; uses only a handful of lookups, paced by the rate limiter.
const releaseCard = a => {
  const days = a.releaseDate ? Math.round((Date.now() - Date.parse(a.releaseDate)) / 864e5) : 999;
  const when = days < 0 ? 'Coming soon' : days < 1 ? 'Today' : days < 7 ? `${days} day${days > 1 ? 's' : ''} ago` : days < 60 ? `${Math.round(days / 7)} weeks ago` : (a.year || '');
  return `<a class="card" href="#/album/it/${a.itunesAlbumId}"><div class="card-art">${cover(a.artwork, a.title)}${days <= 30 ? '<span class="new-badge">NEW</span>' : ''}<button class="fab-play" data-act="play-it-album" data-id="${a.itunesAlbumId}" aria-label="Play">${icon('play')}</button></div>
    <div class="card-t">${esc(a.title.replace(/ - (Single|EP)$/, ''))}</div><div class="card-s">${esc(a.artist)} · ${/ - Single$/.test(a.title) ? 'Single' : / - EP$/.test(a.title) ? 'EP' : 'Album'} · ${when}</div></a>`;
};
const NR_SHELF = 10, NR_PAGE = 25;
// "New from your top artists": newest albums, EPs and singles from the artists you have the most songs by.
// Home shows 10 in a sideways-scrolling row; "See more" opens the full list, 25 at a time.
// Your top 6 artists are looked up first (quick), the next 14 quietly in the background. Cached for 12 hours.
async function newReleases(my) {
  const box = $('#new-releases'); if (!box) return;
  const render = items => {
    if (stale(my) || !$('#new-releases')) return;
    if (!items.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="sec-h"><h2>New from your top artists</h2><a href="#/new" class="lnk">See more</a></div>
      <div class="shelf">${items.slice(0, NR_SHELF).map(releaseCard).join('')}</div>`;
  };
  const items = await loadNewReleases({ onUpdate: render, skeleton: () => { if (!stale(my)) box.innerHTML = `<div class="sec-h"><h2>New from your top artists</h2></div><div class="shelf">${'<div class="card skel"><div class="card-art"><div class="cover"></div></div><div class="card-t"></div><div class="card-s"></div></div>'.repeat(6)}</div>`; } });
  render(items);
}
async function loadNewReleases({ onUpdate = () => { }, skeleton = () => { } } = {}) {
  const top = store.artists().sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 20);
  const sig = 'v3|' + top.map(a => a.key).join('|');
  const c = await kv.get('newReleases');
  const fresh = c?.items?.length && c.sig === sig;
  if (fresh) onUpdate(c.items);
  if (c && c.sig === sig && Date.now() - c.ts < 12 * 36e5) return c.items || [];
  if (!navigator.onLine || !top.length) return fresh ? c.items : [];
  if (!fresh) skeleton();
  const have = new Set([...lib.albums.values()].map(a => a.itunesAlbumId));
  const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const byRank = new Map(), seen = new Set();
  // Newest releases of your #1 artist first, then #2, … (fresh ones from the last year preferred)
  const pickItems = () => {
    const out = [];
    for (let r = 0; r < top.length; r++) {
      const rel = (byRank.get(r) || []).filter(a => a.itunesAlbumId && !have.has(a.itunesAlbumId)).sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
      const recent = rel.filter(a => (a.releaseDate || '') >= yearAgo);
      out.push(...(recent.length ? recent.slice(0, 6) : rel.slice(0, 2)));
    }
    return out;
  };
  const take = async (a, rank, o) => {
    try {
      const id = a.itunesArtistId || await meta.findArtistId(a.name, o);
      if (!id) return;
      const rel = [];
      for (const al of await meta.artistLatest(id, o)) if (!seen.has(al.itunesAlbumId)) { seen.add(al.itunesAlbumId); rel.push(al); }
      byRank.set(rank, rel);
      if (!fresh && rank === 0) { const items = pickItems(); if (items.length) onUpdate(items); }
    } catch { }
  };
  await Promise.all(top.slice(0, 6).map((a, i) => take(a, i)));
  let items = pickItems();
  if (items.length) onUpdate(items);
  await Promise.all(top.slice(6).map((a, i) => take(a, i + 6, { bg: true })));
  items = pickItems();
  await kv.set('newReleases', { ts: Date.now(), sig, items });
  onUpdate(items);
  return items;
}
// Full list page (See more): 25 at a time, "Show more" until the end
async function vNewReleases(_, my) {
  let items = [], shown = NR_PAGE;
  const draw = () => {
    if (stale(my)) return;
    const left = items.length - shown;
    view().innerHTML = `<div class="page"><h1 class="page-h">New from your top artists</h1>
      <p class="muted">The latest albums, EPs and singles from the artists you listen to most.</p>
      ${items.length ? `<div class="cards">${items.slice(0, shown).map(releaseCard).join('')}</div>
        ${left > 0 ? `<div class="more-wrap"><button class="more-btn" id="nr-more">Show more <small>${left} more</small></button></div>` : ''}`
      : empty('Nothing new yet', 'New releases from your top artists show up here.')}</div>`;
    const b = $('#nr-more'); if (b) b.onclick = () => { const y = $('#main').scrollTop; shown += NR_PAGE; draw(); $('#main').scrollTop = y; };
  };
  // Shows what's ready straight away; more appears as the rest of your artists are looked up
  const update = v => { if (v.length === items.length && items.length) return; items = v; const y = $('#main').scrollTop; draw(); $('#main').scrollTop = y; };
  const got = await loadNewReleases({ onUpdate: update });
  update(got); if (!got.length && !items.length) draw();
}

// ================= BAZINGA! MIX =================
// One tap: a fresh playlist of songs you don't have yet from your top 50 artists (your #1 artist first,
// taking turns), then today's top songs in your favourite genres. Built for a fast start: the first few
// artists are fetched together and the music starts as soon as there's something to play; the rest of
// the mix keeps filling in behind it (queue + playlist).
const MIX_GENRES = ['Hip-Hop/Rap', 'Pop', 'R&B', 'Afrobeats', 'Rock', 'Electronic', 'Latin', 'Country', 'Soul', 'Reggae', 'Jazz', 'Gospel', 'K-Pop', 'Classical', 'Metal', 'Folk', 'Blues'];
const mixPlaylist = async () => { const id = await kv.get('mixPl'); return id && lib.playlists.get(id); };
// Earlier versions saved every mix as a "BAZINGA! Mix" playlist automatically. Remove that one (only if
// it's still the untouched auto-made playlist); songs the user liked or put in other playlists stay.
async function retireAutoMix() {
  const pl = await mixPlaylist();
  if (pl && pl.mix && pl.name === 'BAZINGA! Mix') await store.deletePlaylist(pl.id);
  if (await kv.get('mixPl')) await kv.del('mixPl');
}
// Songs that are only in the library because an earlier mix put them there
const isMixOnly = (t, mixId) => t.mix && !t.liked && ![...lib.playlists.values()].some(p => p.id !== mixId && p.trackIds.includes(t.id));
function libraryTaste(mixId) {
  const own = store.saved().filter(t => !isMixOnly(t, mixId));
  const am = new Map(), gm = new Map();
  for (const t of own) {
    const a = mainArtist(t.artist), k = norm(a);
    if (k) { const e = am.get(k) || { name: a, n: 0 }; e.n += t.liked ? 2 : 1; am.set(k, e); }
    const g = genreOf(t); if (g) gm.set(g, (gm.get(g) || 0) + 1);
  }
  return {
    artists: [...am.values()].sort((a, b) => b.n - a.n).map(a => a.name),
    genres: [...gm.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]),
    have: new Set(own.map(t => t.id)), haveTitles: new Set(own.map(t => norm(t.title) + '|' + norm(mainArtist(t.artist))))
  };
}
function mixOverlay() {
  $('#mix-ov')?.remove();
  const el = document.createElement('div');
  el.id = 'mix-ov'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
  el.innerHTML = `<div class="mo-bg" aria-hidden="true"><i></i><i></i><i></i></div><div class="mo-arts" aria-hidden="true"></div>
    <div class="mo-core"><div class="mo-orb"><span></span><span></span><span></span><img src="${logoSrc('icon-512')}" alt=""></div>
    <h2 class="wordmark">BAZINGA!</h2><p class="mo-step">Reading your vibe…</p><div class="mo-bar"><i></i></div></div>
    <button class="ib mo-x" type="button" aria-label="Cancel">${icon('close')}</button>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('on'));
  let arts = 0;
  const api = {
    cancelled: false,
    step(t, pct) { const s = el.querySelector('.mo-step'); if (s && s.textContent !== t) { s.textContent = t; s.classList.remove('in'); void s.offsetWidth; s.classList.add('in'); } if (pct != null) el.querySelector('.mo-bar i').style.width = Math.min(100, pct) + '%'; },
    art(src) {
      if (!src || arts >= 8) return;
      const i = arts++, img = new Image(); img.alt = ''; img.src = sized(src, 300); img.style.setProperty('--i', i);
      // covers float around the edges, never over the bolt in the middle
      const spots = [[6, 10], [74, 8], [10, 66], [76, 64], [40, 4], [42, 78], [2, 38], [82, 36]];
      img.style.left = spots[i][0] + '%'; img.style.top = spots[i][1] + '%';
      img.onload = () => el.querySelector('.mo-arts')?.appendChild(img);
    },
    close() { el.classList.remove('on'); el.classList.add('out'); setTimeout(() => el.remove(), 450); }
  };
  el.querySelector('.mo-x').onclick = () => { api.cancelled = true; api.close(); };
  return api;
}
// First time, with no music yet: pick favourite genres, then favourite artists in them
async function tastePicker() {
  let genres = [], artists = [];
  return modal(`<div class="taste"><div class="taste-step" data-s="1">
      <div class="taste-ic"><img src="${logoSrc()}" alt=""></div>
      <h3>What do you love listening to?</h3><p class="muted">Pick as many genres as you like. Your BAZINGA! mix starts here.</p>
      <div class="chips taste-genres">${MIX_GENRES.map(g => `<button type="button" class="chip" data-g="${esc(g)}" aria-pressed="false" style="--c:${genreColor(g)}">${esc(g)}</button>`).join('')}</div>
      <div class="modal-actions center"><button type="button" class="btn primary" data-next disabled>Next ${icon('play')}</button></div></div>
    <div class="taste-step" data-s="2" hidden>
      <h3>Now your favorite artists</h3><p class="muted">Top artists in the genres you picked. Choose any you like, or skip.</p>
      <div class="taste-artists"></div>
      <div class="modal-actions center"><button type="button" class="btn ghost" data-back>Back</button><button type="button" class="btn primary" data-go>${icon('sparkle')}Make my mix</button></div></div></div>`, {
    wide: true,
    onMount: (m, close) => {
      m.classList.add('taste-modal');
      const s1 = m.querySelector('[data-s="1"]'), s2 = m.querySelector('[data-s="2"]'), next = m.querySelector('[data-next]');
      m.querySelector('.taste-genres').onclick = e => {
        const b = e.target.closest('[data-g]'); if (!b) return;
        const g = b.dataset.g, on = !genres.includes(g);
        genres = on ? [...genres, g] : genres.filter(x => x !== g);
        b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); next.disabled = !genres.length;
      };
      next.onclick = async () => {
        s1.hidden = true; s2.hidden = false;
        const box = m.querySelector('.taste-artists');
        box.innerHTML = genres.map(g => `<div class="ta-group"><div class="fp-h">${esc(g)}</div><div class="ta-row" data-genre="${esc(g)}">${loader('', 'sm inline')}</div></div>`).join('');
        await Promise.all(genres.map(async g => {
          const list = await meta.deezerGenreArtists(g, 10).catch(() => []);
          const row = box.querySelector(`[data-genre="${CSS.escape(g)}"]`); if (!row) return;
          row.innerHTML = list.length ? list.map(a => `<button type="button" class="ta ${artists.includes(a.name) ? 'on' : ''}" data-a="${esc(a.name)}" aria-pressed="${artists.includes(a.name)}">${cover(a.picture, a.name, 'round')}<span>${esc(a.name)}</span><i>${icon('check')}</i></button>`).join('')
            : '<span class="muted tiny">Couldn\'t load artists for this one, but its top songs still go in your mix.</span>';
        }));
      };
      m.querySelector('.taste-artists').onclick = e => {
        const b = e.target.closest('[data-a]'); if (!b) return;
        const a = b.dataset.a, on = !artists.includes(a);
        artists = on ? [...artists, a] : artists.filter(x => x !== a);
        $$(`.ta[data-a="${CSS.escape(a)}"]`, m).forEach(x => { x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
      };
      m.querySelector('[data-back]').onclick = () => { s2.hidden = true; s1.hidden = false; };
      m.querySelector('[data-go]').onclick = () => close({ genres, artists });
    }
  });
}
let mixBusy = false;
async function bazingaMix() {
  if (mixBusy) return;
  if (!navigator.onLine) return toast('Your BAZINGA! mix needs an internet connection', 'err');
  const oldPl = await mixPlaylist();
  const lt = libraryTaste(oldPl?.id);
  const saved = (await kv.get('taste')) || {};
  if (lt.artists.length < 3 && !saved.artists?.length && !saved.genres?.length) {
    const picked = await tastePicker();
    if (!picked?.genres?.length) return;
    Object.assign(saved, picked, { at: Date.now() }); await kv.set('taste', saved);
  }
  mixBusy = true;
  const ov = mixOverlay();
  try {
    const uniq = a => [...new Map(a.filter(Boolean).map(x => [norm(x), x])).values()];
    const libFirst = lt.artists.length >= 3;
    const artists = uniq(libFirst ? [...lt.artists.slice(0, 50), ...(saved.artists || [])] : [...(saved.artists || []), ...lt.artists]).slice(0, 50);
    const genres = uniq([...(saved.genres || []), ...lt.genres]).filter(g => MIX_GENRES.includes(g)).slice(0, 5);
    const per = artists.length > 30 ? 2 : artists.length > 12 ? 3 : 5;
    const seen = new Set(), seenTitle = new Set();
    const fresh = s => {
      const k = norm(s.title) + '|' + norm(mainArtist(s.artist));
      if (!s.title || !s.artist || lt.have.has(s.id) || lt.haveTitles.has(k) || seen.has(s.id) || seenTitle.has(k)) return false;
      if (/\b(karaoke|instrumental|8d audio|sped up|slowed)\b/i.test(s.title)) return false;
      seen.add(s.id); seenTitle.add(k); return true;
    };
    // a little shuffle inside each artist's top songs, so every mix feels new
    const jiggle = list => list.map((x, i) => [x, i + Math.random() * 4]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
    const picks = new Array(artists.length).fill(null);
    const fetchArtist = async i => {
      if (ov.cancelled) return;
      const top = await meta.withTimeout(meta.deezerArtistTop(artists[i], 12).catch(() => []), 6000, []);
      picks[i] = jiggle(top).filter(fresh).slice(0, per);
      if (picks[i][0]?.artwork) ov.art(picks[i][0].artwork);
    };
    const roundRobin = () => { const out = [], max = Math.max(0, ...picks.map(p => p?.length || 0)); for (let r = 0; r < max; r++) for (const p of picks) if (p?.[r]) out.push(p[r]); return out; };
    // The mix only lives in the queue (kept across refreshes) — nothing goes into the library or a
    // playlist unless the user saves it (+ in the queue card) or likes a song.
    const mixTracks = [];
    const save = async list => { const out = list.map(t => lib.tracks.get(t.id) || store.remember({ ...t, mix: 1 })); mixTracks.push(...list.map(t => ({ ...t, mix: 1 }))); await kv.set('mixTracks', mixTracks.slice(-300)); return out; };

    // 1) Fast start: your top few artists at once
    ov.step(artists.length ? `Digging into ${artists[0]}…` : 'Finding the hottest songs in your genres…', 12);
    const first = Math.min(6, artists.length);
    await Promise.all([...Array(first).keys()].map(fetchArtist));
    if (ov.cancelled) return;
    let startList = roundRobin();
    let genreSongs = null;
    const fetchGenres = async () => {
      const lists = await Promise.all(genres.map(g => meta.withTimeout(meta.deezerGenreTop(g, 30).catch(() => []), 7000, [])));
      const out = [], n = Math.max(0, ...lists.map(l => l.length));
      for (let r = 0; r < n && out.length < 45; r++) for (const l of lists) if (l[r] && fresh(l[r])) out.push(l[r]);
      return out;
    };
    if (startList.length < 3) {
      ov.step('Mixing in the top songs from your genres…', 40);
      genreSongs = await fetchGenres();
      if (ov.cancelled) return;
      startList = [...startList, ...genreSongs.splice(0, 8)];
    }
    if (!startList.length) { ov.close(); return toast('Couldn\'t build a mix right now. Try again in a moment', 'err'); }
    ov.step('Your mix is ready. Here we go ⚡', 70);
    const firstSaved = await save(startList);
    const startIds = firstSaved.map(t => t.id);
    player.prefetch(startIds[0]);
    nowCtx = { list: null };
    player.playList(startIds, 0, { shuffle: false, origin: 'mix' });
    // Keep the overlay up until the music actually starts (or a few seconds pass)
    const t0 = Date.now();
    const waitStart = setInterval(() => { if (ov.cancelled || P.playing || P.needsTap || P.error || Date.now() - t0 > 9000) { clearInterval(waitStart); ov.step('Enjoy ⚡', 100); setTimeout(() => ov.close(), 250); } }, 200);

    // 2) The rest of your top artists, then your genres, filled in behind the music
    const rest = [...Array(artists.length).keys()].slice(first);
    const queue = rest.slice();
    await Promise.all([...Array(Math.min(5, queue.length)).keys()].map(async () => { while (queue.length) await fetchArtist(queue.shift()); }));
    if (!genreSongs) genreSongs = await fetchGenres();
    const already = new Set(startIds);
    const more = [...roundRobin().filter(t => !already.has(t.id)).slice(0, 110), ...genreSongs].slice(0, 150);
    if (!more.length) return;
    const moreSaved = await save(more);
    const all = [...startIds, ...moreSaved.map(t => t.id)];
    // still playing the mix? add the rest to the queue
    if (P.queue.some(q => q.id === startIds[0])) player.appendToQueue(moreSaved.map(t => t.id));
    toast(`Your BAZINGA! mix: ${all.length} songs ⚡ Tap + in the queue to save it as a playlist`, 'ok');
  } catch (e) { console.warn(e); ov.close(); toast('Couldn\'t build a mix right now. Try again in a moment', 'err'); }
  finally { mixBusy = false; }
}

// Artist card with a real artist photo (loaded lazily from Deezer, cached on the device)
// Artist photo block: shows the remembered photo straight away; otherwise the library cover until
// the photo is found (then it's swapped in only once fully loaded, so nothing flashes).
function apic(name, fallback, cls, wrapCls = '') {
  const pic = meta.artistPictureNow(name);
  if (pic) return `<div class="${wrapCls}">${cover(pic, name, cls)}</div>`;
  return `<div class="${wrapCls}" data-apic="${esc(name)}" data-cls="${esc(cls)}">${cover(fallback, name, cls)}</div>`;
}
function swapPic(el, pic) {
  if (!pic || !el.isConnected) return;
  const img = new Image(); img.decoding = 'async';
  const px = /hero/.test(el.dataset.cls || '') ? 600 : /\bsm\b/.test(el.dataset.cls || '') ? 64 : 200;
  img.src = sized(pic, px);
  const put = () => { if (el.isConnected) { el.innerHTML = cover(pic, el.dataset.apic, el.dataset.cls || 'round'); el.removeAttribute('data-apic'); } };
  (img.decode ? img.decode() : Promise.resolve()).then(put, put);
}
function artistCard(name, fallback, sub) {
  return `<a class="card" href="#/artist/${encodeURIComponent(name)}">${apic(name, fallback, 'round', 'card-art round')}
    <div class="card-t">${esc(name)}</div><div class="card-s">${esc(sub || '')}</div></a>`;
}
const apicObs = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const el = e.target; apicObs.unobserve(el);
    meta.artistPicture(el.dataset.apic).then(pic => swapPic(el, pic));
  }
}, { rootMargin: '600px' }) : null;
function fillArtistPics(root = document) { if (apicObs) root.querySelectorAll('[data-apic]').forEach(el => apicObs.observe(el)); }

function genreColor(g) { let h = 7; for (const c of g) h = (h * 33 + c.charCodeAt(0)) % 360; return `hsl(${h} 70% 42%)`; }
const plCover = p => p.image || (p.trackIds.map(id => lib.tracks.get(id)?.artwork).find(Boolean) || '');
const albumCard = a => card({ href: albumHref(a), img: a.artwork, title: a.title, sub: [a.year, a.artist].filter(Boolean).join(' · '), act: 'play-album', id: a.id });
const albumHref = a => lib.albums.has(a.id) || !a.itunesAlbumId ? `#/album/${encodeURIComponent(a.id)}` : `#/album/it/${a.itunesAlbumId}`;

// ---------- GENRE ----------
async function vGenre([g]) {
  const tracks = store.saved().filter(t => genreOf(t) === g);
  view().innerHTML = `<div class="page">${header(esc(g), `${tracks.length} songs in your library`, '', playBtns('play-list', 'genre'), 'Genre')}
    ${tracksSection('genre', tracks)}</div>`;
  observeMore();
}

// ---------- LIBRARY ----------
async function vLibrary([tab = 'songs']) {
  const all = store.saved();
  const tabs = [['songs', 'Songs', all.length], ['liked', 'Liked', all.filter(t => t.liked).length], ['playlists', 'Playlists', lib.playlists.size], ['albums', 'Albums', lib.albums.size + store.implicitAlbums().length], ['artists', 'Artists', store.artists().length]];
  let body = '';
  if (tab === 'songs' || tab === 'liked') {
    const tracks = tab === 'liked' ? all.filter(t => t.liked) : all;
    body = tracks.length ? `<div class="actions">${playBtns('play-list', tab)}${matchBtn(tab, tab === 'liked' ? 'Liked Songs (BAZINGA!)' : 'My BAZINGA! songs', 'lib:' + tab)}</div>${tracksSection(tab, tracks, tab === 'liked' ? { defaultSort: 'liked', likedSort: true } : {})}`
      : empty(tab === 'liked' ? 'No liked songs yet' : 'No songs yet', 'Tap the heart on any song, or import your Spotify Liked Songs.', `<a class="btn primary" href="#/import">${icon('import')}Import</a>`);
  } else if (tab === 'playlists') {
    const pls = [...lib.playlists.values()].sort((a, b) => a.name.localeCompare(b.name));
    body = `<div class="actions"><button class="btn" data-act="new-playlist">${icon('plus')}New playlist</button>${pls.length ? `<button class="btn yt-save" data-act="yt-backup">${icon('upload')}Save playlists to YouTube</button>` : ''}</div>
      <div class="cards"><a class="card" href="#/library/liked"><div class="card-art">${likedCover()}<button class="fab-play" data-act="play-list" data-id="liked-all" aria-label="Play">${icon('play')}</button></div><div class="card-t">Liked Songs</div><div class="card-s">${all.filter(t => t.liked).length} songs</div></a>
      ${pls.map(p => card({ href: `#/playlist/${p.id}`, img: plCover(p), title: p.name, sub: `${p.trackIds.length} songs${p.source ? ' · ' + p.source : ''}`, act: 'play-playlist', id: p.id })).join('')}</div>`;
  } else if (tab === 'albums') {
    const saved = [...lib.albums.values()].sort((a, b) => a.title.localeCompare(b.title));
    const imp = store.implicitAlbums().sort((a, b) => b.trackIds.length - a.trackIds.length || a.title.localeCompare(b.title));
    body = `<div class="actions"><a class="btn" href="#/search/albums">${icon('search')}Find albums</a></div>
      ${saved.length ? `<h2>Saved albums</h2>${pagedGrid('alb-saved', saved.map(albumCard))}` : empty('No saved albums yet', 'Search any album, or open one from a song (⋯ → Go to album) and tap "Save album".')}
      ${imp.length ? `<h2>From your songs</h2><p class="muted tiny">Albums you have songs from. Open one to see and save the full album.</p>${pagedGrid('alb-imp', imp.map(a => card({ href: albumHref(a), img: a.artwork, title: a.title, sub: `${a.artist} · ${a.trackIds.length} in library`, act: 'play-album', id: a.id })))}` : ''}`;
  } else if (tab === 'artists') {
    const arts = store.artists();
    artistUI.limit = PAGE_N;
    body = arts.length ? `<div class="art-tools">
        <label class="searchbox sm art-search">${icon('search')}<input id="art-q" placeholder="Search your artists" value="${esc(artistUI.q)}" autocomplete="off" enterkeyhint="search"></label>
        <div class="seg art-sort" role="group" aria-label="Sort artists"><button data-act="art-sort" data-v="count" class="${artistUI.sort === 'count' ? 'on' : ''}">Most songs</button><button data-act="art-sort" data-v="az" class="${artistUI.sort === 'az' ? 'on' : ''}">A–Z</button></div>
      </div>
      <div class="az">${[...new Set(arts.map(a => letterOf(a.name)))].sort((a, b) => a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)).map(l => `<a href="#" data-act="az" data-l="${l}">${l}</a>`).join('')}</div>
      <div class="artist-list" id="artist-list">${artistRows(arts)}</div>`
      : empty('No artists yet', 'Artists from all your songs, playlists and albums show up here.');
  }
  lists.set('liked-all', all.filter(t => t.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0)).map(t => t.id));
  view().innerHTML = `<div class="page"><h1 class="page-h">Your Library</h1>
    <div class="tabs">${tabs.map(([k, l, n]) => `<a href="#/library/${k}" class="tab ${tab === k ? 'on' : ''}" data-tab="${k}">${l}<small>${n}</small></a>`).join('')}</div>${body}</div>`;
  observeMore();
  fillArtistPics();
  const aq = $('#art-q');
  if (aq) aq.addEventListener('input', debounce(() => { artistUI.q = aq.value; artistUI.limit = PAGE_N; redrawArtists(); }, 120));
}
// ---------- Long lists load 100 at a time, with a quiet "Show more" at the bottom ----------
const PAGE_N = 100;
const pagers = new Map();
function pagedGrid(key, items, cls = 'cards') {
  pagers.set(key, { items, at: PAGE_N });
  return `<div class="${cls}" data-pg="${key}">${items.slice(0, PAGE_N).join('')}</div>${moreBtn(key, items.length - PAGE_N)}`;
}
const moreBtn = (key, left) => left > 0 ? `<div class="more-wrap"><button class="more-btn" data-act="show-more" data-pg="${key}">Show more <small>${left} more</small></button></div>` : '';
function showMore(key) {
  const pg = pagers.get(key), grid = $(`[data-pg="${key}"]:not(button)`); if (!pg || !grid) return;
  grid.insertAdjacentHTML('beforeend', pg.items.slice(pg.at, pg.at + PAGE_N).join(''));
  pg.at += PAGE_N;
  const wrap = grid.nextElementSibling;
  if (wrap?.classList.contains('more-wrap')) wrap.outerHTML = moreBtn(key, pg.items.length - pg.at);
  fillArtistPics(grid);
}
// ---------- Artists list: most songs first (or A–Z), with search ----------
const artistUI = { sort: 'count', q: '', limit: PAGE_N };
const letterOf = n => (n[0] || '#').toUpperCase().replace(/[^A-Z]/, '#');
function artistRows(arts) {
  const q = norm(artistUI.q);
  let list = q ? arts.filter(a => norm(a.name).includes(q)) : arts;
  list = artistUI.sort === 'az' ? [...list].sort((a, b) => a.name.localeCompare(b.name)) : [...list].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  if (!list.length) return `<p class="muted pad">No artists match "${esc(artistUI.q)}".</p>`;
  const seen = new Set();
  const left = list.length - artistUI.limit;
  return list.slice(0, artistUI.limit).map(a => {
    const L = letterOf(a.name), first = artistUI.sort === 'az' && !seen.has(L); seen.add(L);
    return `<a class="artist-row" href="#/artist/${encodeURIComponent(a.name)}" ${first || artistUI.sort !== 'az' ? `data-letter="${L}"` : ''}>
      ${apic(a.name, a.artwork, 'round sm')}<div><b>${esc(a.name)}</b><small>${a.count} song${a.count > 1 ? 's' : ''}${a.genres.size ? ' · ' + esc([...a.genres].slice(0, 2).join(', ')) : ''}</small></div>
      <button class="ib art-play" data-act="play-artist" data-name="${esc(a.name)}" aria-label="Play ${esc(a.name)}">${icon('play')}</button></a>`;
  }).join('') + (left > 0 ? `<div class="more-wrap span-all"><button class="more-btn" data-act="art-more">Show more <small>${left} more</small></button></div>` : '');
}
function redrawArtists() {
  const el = $('#artist-list'); if (!el) return;
  el.innerHTML = artistRows(store.artists());
  $$('.art-sort button').forEach(b => b.classList.toggle('on', b.dataset.v === artistUI.sort));
  fillArtistPics(el);
}
// On phones these two fold into a ⋯ menu so the action row stays on one line
const matchBtn = (key, name = 'My BAZINGA! playlist', job = key, offline = '', noMore = false) => `<span class="yt-acts"><button class="btn ghost" data-act="match-list" data-list="${key}" title="Find YouTube versions for every song">${icon('yt')}Find YouTube matches</button>
  <button class="btn yt-save" data-act="yt-export" data-list="${key}" data-name="${esc(name)}" data-job="${esc(job)}">${icon('upload')}Save to YouTube</button></span>
  ${noMore ? '' : `<button class="ib lg yt-more ${offline ? 'always' : ''}" data-act="yt-more" data-list="${key}" data-name="${esc(name)}" data-job="${esc(job)}" ${offline ? `data-offline="${esc(offline)}"` : ''} aria-label="More options" title="More">${icon('more')}</button>`}`;

// ---------- PLAYLIST ----------
async function vPlaylist([id]) {
  const p = lib.playlists.get(id);
  if (!p) { view().innerHTML = empty('Playlist not found', 'It may have been deleted.'); return; }
  const tracks = p.trackIds.map(i => lib.tracks.get(i)).filter(Boolean);
  setTitle(p.name);
  const dur = tracks.reduce((s, t) => s + (t.durationMs || 0), 0);
  fstate['pl'] = fstate['pl'] && fstate['pl']._id === id ? fstate['pl'] : { sort: '', open: false, _id: id };
  view().innerHTML = `<div class="page">
    ${header(esc(p.name), `${esc(profile.username)} · ${tracks.length} songs${dur ? ' · ' + fmtTime(dur / 1000) : ''}${p.source ? ' · from ' + esc(p.source) : ''}`, cover(plCover(p), p.name), '', 'Playlist')}
    <div class="actions">${playBtns('play-list', 'pl')}
      <button class="ib lg" data-act="share-playlist" data-id="${p.id}" title="Share">${icon('share')}</button>
      <button class="ib lg" data-act="playlist-menu" data-id="${p.id}" aria-label="More options" title="More">${icon('more')}</button>
      ${matchBtn('pl', p.name, p.id, '', true)}</div>
    ${tracks.length ? tracksSection('pl', tracks, { playlistId: p.id, keepOrder: true, defaultSort: '' }) : empty('This playlist is empty', 'Use ⋯ → "Add to playlist" on any song.')}
  </div>`;
  observeMore();
}

// ---------- ALBUM ----------
async function vAlbum(arg, my) {
  let album, tracks, savedA = null, remote = null;
  if (arg[0] === 'it') {
    const res = await meta.albumTracks(arg[1]);
    if (stale(my)) return;
    if (!res.album) { view().innerHTML = empty('Album not found', ''); return; }
    album = res.album; tracks = res.tracks;
    savedA = lib.albums.get(album.id);
  } else {
    const id = arg[0];
    savedA = lib.albums.get(id);
    album = savedA || store.implicitAlbums().find(a => a.id === id);
    if (!album) { view().innerHTML = empty('Album not found', ''); return; }
    tracks = (album.trackIds || []).map(i => lib.tracks.get(i)).filter(Boolean);
    if (!savedA && album.itunesAlbumId) { location.replace(`#/album/it/${album.itunesAlbumId}`); return; }
    if (!savedA && navigator.onLine) {
      // try to find the full album
      try { remote = await meta.findAlbum(album.artist, album.title); } catch { }
      if (stale(my)) return;
      if (remote) { location.replace(`#/album/it/${remote.itunesAlbumId}`); return; }
    }
  }
  // Use library versions of tracks where they exist (keeps likes, offline files, YouTube links)
  tracks = tracks.map(t => lib.tracks.get(t.id) || store.remember(t));
  const dur = tracks.reduce((s, t) => s + (t.durationMs || 0), 0);
  const offlineN = tracks.filter(t => t.localFileId).length;
  window.__album = { album, tracks };
  setTitle(album.title);
  const artistLink = `<a class="lnk" href="#/artist/${encodeURIComponent(mainArtist(album.artist))}">${esc(album.artist)}</a>`;
  view().innerHTML = `<div class="page">
    ${header(esc(album.title), `${artistLink} · ${album.year || ''} · ${tracks.length} songs${dur ? ' · ' + fmtTime(dur / 1000) : ''}${album.genre ? ' · ' + esc(album.genre) : ''}`, cover(album.artwork, album.title), '', 'Album')}
    <div class="actions">${playBtns('play-list', 'album')}
      ${savedA ? `<button class="btn save-alb" data-act="unsave-album" data-id="${esc(album.id)}">${icon('check')}<span>Saved</span></button>` : `<button class="btn primary-o save-alb" data-act="save-album">${icon('plus')}<span>Save<span class="hide-sm"> album</span></span></button>`}
      <button class="ib lg" data-act="share-album" title="Share">${icon('share')}</button>
      ${matchBtn('album', `${album.title} — ${album.artist}`, 'album:' + album.id, `Offline files${offlineN ? ` (${offlineN}/${tracks.length})` : ''}`)}</div>
    ${tracksSection('album', tracks, { noFilter: true, numbered: true })}
    ${album.releaseDate ? `<p class="muted tiny pad">Released ${new Date(album.releaseDate).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</p>` : ''}
  </div>`;
}

// ---------- ARTIST ----------
async function vArtist([name], my) {
  setTitle(name);
  const n = norm(name);
  const mine = store.saved().filter(t => (t.artists?.length ? t.artists : [mainArtist(t.artist)]).some(a => norm(a) === n) || norm(mainArtist(t.artist)) === n);
  const a = store.artists().find(x => x.key === n);
  view().innerHTML = `<div class="page">${header(esc(name), mine.length ? `${mine.length} song${mine.length === 1 ? '' : 's'} in your library` : 'Not in your library yet', apic(name, a?.artwork || mine[0]?.artwork, 'hero round'), '', 'artist')}
    <div class="actions">${mine.length ? playBtns('play-list', 'artist-mine') : ''}</div>
    ${mine.length ? `<h2>In your library</h2>${tracksSection('artist-mine', mine, { defaultSort: 'newest' })}`
      : `<div class="panel artist-empty">${icon('heart')}<div><b>No songs by ${esc(name)} in your library yet</b><p class="muted tiny">Tap the ♡ on any song below to add it, or <a class="lnk" href="#/search" data-artist-search="${esc(name)}">search for more</a>.</p></div></div>`}
    <div id="artist-top">${loader(mine.length ? 'Loading popular songs…' : `Finding the top songs by ${name}…`, 'sm')}</div>
    <div id="artist-topalb"></div>
    <div id="artist-albums"></div></div>`;
  // The big photo is fetched right now (ahead of anything else), not when it scrolls into view
  const heroPic = view().querySelector('.page [data-apic][data-cls="hero round"]');
  if (heroPic) meta.artistPicture(name, true).then(pic => swapPic(heroPic, pic));
  observeMore(); fillArtistPics();
  const $top = () => $('#artist-top'), $alb = () => $('#artist-albums');
  let id = a?.itunesArtistId || mine.find(t => t.itunesArtistId && norm(mainArtist(t.artist)) === n)?.itunesArtistId;
  const idP = id ? Promise.resolve(id) : meta.findArtistId(name).catch(() => null);
  // Top 10: Apple first, Deezer if Apple is slow; never more than ~10 s of loading
  const later = (ms, fn) => sleep(ms).then(fn).catch(() => []);
  const topP = meta.withTimeout(meta.firstFull([idP.then(i => i ? meta.artistTopSongs(i) : []).catch(() => []), later(2000, () => meta.deezerArtistTop(name, 10))]), 10000, []);
  topP.then(top => {
    if (stale(my) || !$top()) return;
    const topT = top.slice(0, 10).map(t => lib.tracks.get(t.id) || store.remember(t));
    lists.set('artist-top', topT.map(t => t.id));
    const cur = player.current()?.id;
    $top().innerHTML = topT.length
      ? `<div class="sec-h"><h2>${mine.length ? 'Popular songs' : `Top 10 songs by ${esc(name)}`}</h2><button class="btn sm ghost" data-act="play-list" data-id="artist-top">${icon('play')}Play all</button></div><div class="rows">${topT.map((t, i) => trackRow(t, i, { list: 'artist-top', numbered: true }, cur)).join('')}</div>`
      : `<div class="pad"><p class="muted">${navigator.onLine ? 'Couldn\'t load songs by this artist right now.' : 'You\'re offline — songs by this artist will show when you\'re back online.'}</p>${navigator.onLine ? `<button class="btn" data-act="retry-route">${icon('restore')}Try again</button>` : ''}</div>`;
    markNow();
  });
  // Albums (Apple only), loaded alongside
  idP.then(async i => {
    if (!i) return;
    const albums = await meta.withTimeout(meta.artistAlbums(i).catch(() => []), 12000, []);
    if (stale(my) || !$alb() || !albums.length) return;
    // Top 10 albums (card grid under the top songs): albums holding the artist's most popular songs
    // come first, then full albums in Apple's popularity order. Singles are left to the discography.
    const top = await Promise.race([topP, sleep(6000).then(() => [])]);
    if (stale(my) || !$('#artist-topalb')) return;
    const base = x => norm(String(x || '').replace(/\s*[\(\[].*?[\)\]]/g, '').replace(/\s*-\s*(single|ep)$/i, ''));
    const hit = new Map();
    top.slice(0, 10).forEach((t, r) => { for (const k of [t.itunesAlbumId && 'id:' + t.itunesAlbumId, t.album && 't:' + base(t.album)]) if (k && !hit.has(k)) hit.set(k, r); });
    const songRank = a => Math.min(hit.get('id:' + a.itunesAlbumId) ?? 99, hit.get('t:' + base(a.title)) ?? 99);
    const full = albums.filter(a => (a.trackCount || 0) >= 5 || songRank(a) < 99);
    const topAlb = [...full].sort((a, b) => (songRank(a) - songRank(b)) || ((a.rank ?? 0) - (b.rank ?? 0))).slice(0, 10);
    if (topAlb.length >= 2) $('#artist-topalb').innerHTML = `<div class="sec-h"><h2>Top 10 albums</h2></div><div class="cards top-albums">${topAlb.map(al => card({ href: `#/album/it/${al.itunesAlbumId}`, img: al.artwork, title: al.title, sub: [al.year, `${al.trackCount} songs`].filter(Boolean).join(' · ') })).join('')}</div>`;
    $alb().innerHTML = `<h2>Discography</h2>${pagedGrid('artist-alb', albums.map(al => card({ href: `#/album/it/${al.itunesAlbumId}`, img: al.artwork, title: al.title, sub: `${al.year || ''} · ${al.trackCount} songs` })))}`;
  });
  await Promise.race([topP, sleep(50)]);
}

// ---------- SEARCH ----------
let lastSearch = { q: '', tab: 'all' };
const SEARCH_TABS = [['all', 'All'], ['songs', 'Songs'], ['albums', 'Albums'], ['artists', 'Artists'], ['youtube', 'YouTube']];
async function vSearch([tab = lastSearch.tab]) {
  lastSearch.tab = tab;
  view().innerHTML = `<div class="page"><h1 class="page-h">Search</h1>
    <div class="search-row"><label class="searchbox big">${icon('search')}<input id="sq" placeholder="${tab === 'youtube' ? 'Search YouTube…' : 'Songs, albums, artists, YouTube…'}" value="${esc(lastSearch.q)}" autocomplete="off" enterkeyhint="search">
      <button type="button" class="ib sb-clear" aria-label="Clear" ${lastSearch.q ? '' : 'hidden'}>${icon('close')}</button></label>
      <button class="search-go" data-act="search-go" aria-label="Search" title="Search">${icon('search')}</button>
      <button class="mic-btn ghosty" data-act="voice" aria-label="Search by voice" title="Ask BAZINGA!">${icon('mic')}</button></div>
    <div class="tabs">${SEARCH_TABS.map(([k, l]) => `<a href="#/search/${k}" class="tab ${tab === k ? 'on' : ''}">${k === 'youtube' ? icon('yt') : ''}${l}</a>`).join('')}</div>
    <div id="sres"></div></div>`;
  const inp = $('#sq'), clr = $('.sb-clear');
  const run = debounce(() => doSearch(inp.value.trim(), tab), 400);
  inp.addEventListener('input', () => { clr.hidden = !inp.value; run(); });
  const go = () => { run.cancel(); doSearch(inp.value.trim(), tab); inp.blur(); };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  $('.search-go').onclick = e => { e.preventDefault(); if (!inp.value.trim()) { inp.focus(); return; } go(); };
  clr.onclick = () => { inp.value = ''; clr.hidden = true; doSearch('', tab); inp.focus(); };
  if (innerWidth > 700) inp.focus();
  if (lastSearch.q) doSearch(lastSearch.q, tab);
  else $('#sres').innerHTML = searchHints(tab);
}
function searchHints(tab) {
  const g = store.genres().slice(0, 12);
  return `<p class="muted">${tab === 'youtube' ? 'Search all of YouTube — tap a result to play it, or use ⋯ to queue it, like it or add it to a playlist.' : 'Search the whole music catalogue and YouTube for songs, full albums and artists — play them as videos or audio and save albums to your library.'}</p>
  ${g.length && tab !== 'youtube' ? `<h2>Browse your genres</h2><div class="genre-tiles">${g.map(([x, n]) => `<a class="gt" href="#/genre/${encodeURIComponent(x)}" style="--c:${genreColor(x)}"><b>${esc(x)}</b><small>${n} songs</small></a>`).join('')}</div>` : ''}`;
}
// Turn YouTube results into playable rows (each plays that exact video)
async function ytResultsToTracks(results) {
  const out = [];
  for (const r of results.filter(r => r.id && (!r.seconds || r.seconds < 1800)).slice(0, 20)) {
    const { artist, title } = yt.videoToSong(r);
    const id = 'yt_' + r.id;
    const t = lib.tracks.get(id) || store.remember({ id, title, artist, artists: [artist], artwork: yt.thumb(r.id), durationMs: (r.seconds || 0) * 1000, isVideo: true, ytTitle: r.title, enriched: true, coverTried: true, addedAt: Date.now() });
    if (!(await db.get('ytcache', id))) await db.put('ytcache', { video: r.id, audio: r.id, videoTitle: r.title, audioTitle: r.title, fromSearch: true }, id);
    out.push(t);
  }
  return out;
}
// ---------- Search relevance ----------
// Only keep results that actually match what was typed: every word must appear (as the start of a
// word in the title / artist / album), with one typo allowed in longer words. Best matches first.
const STOP = new Set(['the', 'a', 'an', 'by', 'and', 'of', 'feat', 'ft', 'with', 'x']);
function near(a, b) { // edit distance <= 1
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, d = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++d > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return d + (a.length - i) + (b.length - j) <= 1;
}
function relevance(q) {
  const nq = norm(q);
  const toks = nq.split(' ').filter(t => t && !STOP.has(t));
  const words = toks.length ? toks : nq.split(' ').filter(Boolean);
  return (...fields) => {
    const text = norm(fields.filter(Boolean).join(' '));
    if (!words.length) return 1;
    const tw = text.split(' ');
    let hits = 0, exact = 0;
    for (const t of words) {
      if (tw.some(w => w === t)) { hits++; exact++; }
      else if (tw.some(w => w.startsWith(t) || (t.length >= 5 && w.length >= 4 && near(t, w.slice(0, t.length + 1)) ) || (t.length >= 5 && near(t, w)))) hits++;
      else if (t.length >= 3 && text.replace(/ /g, '').includes(t)) hits += 0.8; // "acdc" vs "ac dc"
    }
    const need = words.length >= 4 ? words.length - 1 : words.length;
    if (hits < need) return null;
    let sc = hits + exact * 0.5;
    if (text.includes(nq)) sc += 3;
    if (norm(fields[0] || '').startsWith(nq)) sc += 2;
    return sc;
  };
}
function keepRelevant(list, q, fieldsOf) {
  const rel = relevance(q);
  return list.map((x, i) => ({ x, i, s: rel(...fieldsOf(x)) })).filter(o => o.s !== null)
    .sort((a, b) => (b.s - a.s) || (a.i - b.i)).map(o => o.x);
}

let searchSeq = 0;
async function doSearch(q, tab) {
  lastSearch.q = q;
  const my = ++searchSeq;
  const box = $('#sres'); if (!box) return;
  if (!q) { box.innerHTML = searchHints(tab); return; }
  const local = tab === 'youtube' ? [] : applyFilters(store.saved(), { q }).slice(0, 8);
  box.innerHTML = `${local.length && tab !== 'albums' && tab !== 'artists' ? `<h2>In your library</h2>${rowsFor('s-local', local)}` : ''}<div id="s-main">${loader(tab === 'youtube' ? 'Searching YouTube…' : 'Searching…', 'search')}</div>${tab === 'all' ? '<div id="s-yt"></div>' : ''}`;
  markNow();
  if (!navigator.onLine) { $('#s-main').innerHTML = '<p class="muted">Offline — only your library is searchable.</p>'; return; }
  const alive = () => my === searchSeq && $('#sres');
  // YouTube results (own tab, or a section under the music results on "All")
  const ytPart = async (target, limit) => {
    if (q.length < 2) return;
    try {
      const res = keepRelevant(await yt.rawSearch(q, { preferFree: true }), q, r => [r.title, r.author]);
      if (!alive()) return;
      const tracks = (await ytResultsToTracks(res)).slice(0, limit);
      prefetchTop(tracks, 2);
      const el = $(target); if (!el) return;
      el.innerHTML = tracks.length ? `<div class="sec-h"><h2>${icon('yt')} From YouTube</h2>${tab === 'all' && tracks.length >= limit ? '<a class="lnk" href="#/search/youtube">See all</a>' : ''}</div>${rowsFor('s-yt-list', tracks)}` : (tab === 'youtube' ? '<p class="muted">No YouTube results.</p>' : '');
      markNow();
    } catch (e) { const el = $(target); if (el && alive()) el.innerHTML = tab === 'youtube' ? `<p class="muted">${esc(e.message)}</p>` : ''; }
  };
  if (tab === 'youtube') return ytPart('#s-main', 20);
  if (tab === 'all') ytPart('#s-yt', 6);
  try {
    const want = t => tab === 'all' || tab === t;
    // Apple's catalogue first; if it's slow, Deezer steps in. Nothing waits more than ~9 seconds.
    const later = (ms, fn) => sleep(ms).then(fn).catch(() => []);
    const songsP = want('songs') ? meta.firstFull([meta.searchSongs(q, tab === 'songs' ? 40 : 10).catch(() => []), later(1800, () => meta.deezerSearchSongs(q, tab === 'songs' ? 40 : 10))]) : [];
    const artistsP = want('artists') ? meta.firstFull([meta.searchArtists(q, tab === 'artists' ? 20 : 6).catch(() => []), later(1800, () => meta.deezerSearchArtists(q, tab === 'artists' ? 20 : 6))]) : [];
    const albumsP = want('albums') ? meta.searchAlbums(q, tab === 'albums' ? 40 : 12).catch(() => []) : [];
    // Each section appears the moment its results arrive
    const box = () => $('#s-main');
    let shown = 0, settled = 0;
    const parts = { artists: '', albums: '', songs: '' };
    const paint = () => {
      if (!alive() || !box()) return;
      const html = parts.songs + parts.artists + parts.albums;
      if (html) { box().innerHTML = html + (settled < 3 ? `<div class="s-more">${loader('', 'sm inline')}</div>` : ''); fillArtistPics(box()); markNow(); }
      else if (settled === 3) box().innerHTML = `<p class="muted">No results from the music catalogue for "${esc(q)}". Check the spelling, or try the YouTube tab.</p>`;
    };
    const part = (p, fill) => meta.withTimeout(Promise.resolve(p), 9000, []).then(v => { if (alive()) { fill(v || []); settled++; shown++; paint(); } }, () => { settled++; paint(); });
    await Promise.all([
      part(artistsP.then?.(v => keepRelevant(v, q, a => [a.name])) ?? artistsP, v => { parts.artists = v.length ? `<h2>Artists</h2><div class="${tab === 'all' ? 'shelf' : 'cards'}">${v.map(a => artistCard(a.name, a.picture || '', a.genre)).join('')}</div>` : ''; }),
      part(albumsP.then?.(v => keepRelevant(v, q, a => [a.title, a.artist])) ?? albumsP, v => { parts.albums = v.length ? `<h2>Albums</h2><div class="${tab === 'all' ? 'shelf' : 'cards'}">${v.map(a => card({ href: `#/album/it/${a.itunesAlbumId}`, img: a.artwork, title: a.title, sub: `${a.artist} · ${a.year || ''}`, act: 'play-it-album', id: a.itunesAlbumId })).join('')}</div>` : ''; }),
      part(songsP.then?.(v => keepRelevant(v, q, t => [t.title, t.artist, t.album])) ?? songsP, v => { const st = dedupeSongs(v, local).map(t => lib.tracks.get(t.id) || store.remember(t)); prefetchTop(st, 3); parts.songs = st.length ? `<h2>Songs</h2>${rowsFor('s-songs', st)}` : ''; })
    ]);
  } catch (e) {
    if (alive()) $('#s-main').innerHTML = '<p class="muted">Music search is unavailable right now. Try again in a moment.</p>';
  }
}
// One row per song: the catalogue often lists the same song several times (single, album, deluxe,
// explicit/clean, "feat." spelled differently, remasters). Keep the first (best match), prefer one with
// a cover, and skip songs already shown under "In your library". Remixes, live and acoustic versions stay.
const songKey = t => norm(String(t.title || '')
  .replace(/\s*[\(\[](feat|ft|with)\.?[^\)\]]*[\)\]]/gi, '')
  .replace(/\s*[\(\[][^\)\]]*\b(explicit|clean|remaster(ed)?|album version|single version|original( mix| version)?|radio edit|bonus track|from [^\)\]]*)\b[^\)\]]*[\)\]]/gi, '')
  .replace(/\s+-\s+(\d{4}\s+)?(remaster(ed)?|single version|album version|radio edit)(\s+\d{4})?$/i, '')) + '|' + norm(mainArtist(t.artist));
function dedupeSongs(list, already = []) {
  const seen = new Map(), have = new Set(already.map(songKey));
  for (const t of list) {
    const k = songKey(t); if (have.has(k)) continue;
    const prev = seen.get(k);
    if (!prev) seen.set(k, t);
    else if (!prev.artwork && t.artwork) seen.set(k, t);
  }
  return [...seen.values()];
}
// Look up the YouTube version of the top results right away, so tapping one starts instantly
function prefetchTop(tracks, n) { setTimeout(() => tracks.slice(0, n).forEach((t, k) => setTimeout(() => player.prefetch(t.id), k * 450)), 250); }
function rowsFor(key, tracks) {
  lists.set(key, tracks.map(t => t.id));
  const cur = player.current()?.id;
  return `<div class="rows">${tracks.map((t, i) => trackRow(t, i, { list: key }, cur)).join('')}</div>`;
}

// ---------- IMPORT ----------
// Import lives inside Settings (Settings → Import music); #/import jumps straight there.
async function importSection() {
  const connected = await sp.isConnected();
  const clientId = await kv.get('spotifyClientId', '');
  return `<section id="import" class="set-group"><h2 class="group-h">${icon('import')} Import music</h2>
    <p class="muted tiny group-sub">Bring in songs and playlists from Spotify, YouTube, Apple Music, CSV files, a pasted list, or music files on this device.</p>
    <div class="panel">
      <div class="panel-h">${icon('spotify', 'brand-sp')}<div><h2>From Spotify</h2><p class="muted tiny">Your Liked Songs and every playlist — no account setup, takes about a minute. Uses <b>Exportify</b>, a free, open-source tool that reads your Spotify library (read-only) right in your browser.</p></div></div>
      <ol class="steps">
        <li><b>Open Exportify</b> below → tap <b>Get Started</b> → log in to Spotify and allow access.</li>
        <li>Tap <b>Export All</b> to download everything (a <code>.zip</code>), or <b>Export</b> next to just the playlists you want (<code>.csv</code>).</li>
        <li>Come back here and choose the downloaded file. Liked Songs go to your Liked Songs, every playlist comes in as a playlist.</li>
      </ol>
      <div class="row-btns">
        <button class="btn primary" data-act="exportify">${icon('spotify')}Open Exportify</button>
        <label class="btn">${icon('import')}Choose downloaded file<input type="file" accept=".zip,.csv,application/zip,text/csv" multiple hidden data-act-change="exportify-file"></label>
      </div>
      <label class="drop" data-drop="csv">${icon('import')}<span>…or drop the .zip / .csv here</span><input type="file" accept=".zip,.csv,application/zip,text/csv" multiple hidden data-act-change="exportify-file"></label>
      <details class="howto sp-dev" ${connected ? 'open' : ''}><summary>Advanced: connect Spotify directly with a developer key</summary>
      ${connected ? `<div class="row-btns">
          <button class="btn primary" data-act="sp-liked">${icon('heartFill')}Import Liked Songs</button>
          <button class="btn" data-act="sp-playlists">${icon('library')}Choose playlists</button>
          <button class="btn ghost" data-act="sp-disconnect">Disconnect</button></div>`
      : `<p class="tiny muted">Imports straight from Spotify without downloading a file. Needs a free Spotify developer app (Spotify requires the developer account to have Premium).</p><ol>
          <li>Open <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener" class="lnk">developer.spotify.com/dashboard</a> and log in.</li>
          <li>Click <b>Create app</b>. Any name. Tick <b>Web API</b>.</li>
          <li>Under <b>Redirect URIs</b> add exactly: <code class="copy" data-act="copy" data-v="${esc(sp.redirectUri())}">${esc(sp.redirectUri())}</code></li>
          <li>Save, then copy the <b>Client ID</b> and paste it below.</li></ol>
        <form class="inline-form" id="sp-form"><input name="cid" placeholder="Spotify Client ID" value="${esc(clientId)}" required pattern="[A-Za-z0-9]{20,40}"><button class="btn">${icon('spotify')}Connect Spotify</button></form>`}
      </details>
    </div>
    <div class="panel">
      <div class="panel-h">${icon('yt', 'brand-yt')}<div><h2>From YouTube</h2><p class="muted tiny">Bring in your YouTube playlists and Liked videos — handy as a second backup of your music. Each song keeps the exact video from the playlist.</p></div></div>
      <div class="row-btns">${ya.configured() ? `<button class="btn primary" data-act="yt-import-mine">${icon('yt')}${ya.signedIn() ? 'Choose my YouTube playlists' : 'Sign in & choose my playlists'}</button>${ya.signedIn() ? '<button class="btn ghost" data-act="yt-signout">Disconnect</button>' : ''}` : ''}</div>
      <form class="inline-form" id="ytlink-form"><input name="u" placeholder="Paste any public or unlisted YouTube playlist link" required><button class="btn">${icon('import')}Import link</button></form>
      ${!ya.configured() ? '<p class="tiny muted">Public and unlisted playlist links work right away. To pick your private playlists and Liked videos, connect a YouTube account below (Settings → YouTube backup).</p>' : ''}
    </div>
    <div class="panel">
      <div class="panel-h">${icon('apple', 'brand-am')}<div><h2>From Apple Music</h2><p class="muted tiny">Import playlists, your whole library and Favorite (Loved) songs, with genres and years. No Apple account login needed.</p></div></div>
      <details class="howto"><summary>How to export from Apple Music</summary><ol>
        <li><b>Mac</b> (Music app) or <b>Windows</b> (Apple Music / iTunes app).</li>
        <li><b>Everything at once:</b> File → Library → <b>Export Library…</b> → save the <code>.xml</code> file.</li>
        <li><b>One playlist:</b> select it, then File → Library → <b>Export Playlist…</b> → format <b>Plain Text</b> (<code>.txt</code>).</li>
        <li>Drop the file below. On iPhone/Android the Apple Music app can't export — do it once on a computer, or use any converter that gives a CSV and the CSV option below.</li></ol></details>
      <label class="drop"><input type="file" accept=".xml,.txt,text/plain,text/xml,application/xml" multiple hidden data-act-change="apple">${icon('apple')}<span>Choose Apple Music export (.xml / .txt)</span></label>
    </div>
    <div class="panel">
      <div class="panel-h">${icon('file')}<div><h2>From a CSV file</h2><p class="muted tiny">No Spotify key needed. Export any playlist or your Liked Songs at <a class="lnk" href="https://exportify.net" target="_blank" rel="noopener">exportify.net</a> (or any CSV with title + artist columns), then drop the files here. Genres and release dates come along too.</p></div></div>
      <label class="drop" data-drop="csv"><input type="file" accept=".csv,text/csv" multiple hidden data-act-change="csv">${icon('import')}<span>Choose CSV files</span></label>
    </div>
    <div class="panel">
      <div class="panel-h">${icon('edit')}<div><h2>Paste a list</h2><p class="muted tiny">One song per line — "Artist - Title" or "Title by Artist".</p></div></div>
      <form id="paste-form"><textarea name="t" rows="5" placeholder="Daft Punk - One More Time&#10;Blinding Lights by The Weeknd"></textarea>
      <div class="row-btns"><input name="name" placeholder="Playlist name (optional)"><button class="btn">${icon('plus')}Add songs</button></div></form>
    </div>
    <div class="panel">
      <div class="panel-h">${icon('folder')}<div><h2>Music files on this device</h2><p class="muted tiny">MP3/M4A/FLAC/etc. that you own. They play fully offline and get grouped into albums from their tags. Songs already in your library get linked automatically.</p></div></div>
      <div class="row-btns"><button class="btn" data-act="add-files">${icon('file')}Add files</button><button class="btn" data-act="add-folder">${icon('folder')}Add a folder</button></div>
    </div>
  </section>`;
}
function wireImport() {
  $('#sp-form')?.addEventListener('submit', e => { e.preventDefault(); sp.login(new FormData(e.target).get('cid').trim()); });
  $('#paste-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const tracks = imp.tracksFromText(fd.get('t'));
    if (!tracks.length) return toast('Couldn\'t read any "Artist - Title" lines', 'err');
    const saved = await store.upsertTracks(tracks);
    if (fd.get('name')) { const p = await store.createPlaylist(fd.get('name'), saved.map(t => t.id), { source: 'pasted' }); location.hash = '#/playlist/' + p.id; }
    else { await Promise.all(saved.map(t => store.updateTrack(t.id, { liked: true }))); toast(`${saved.length} songs added to Liked`); location.hash = '#/library/liked'; }
  });
  $('[data-act-change="csv"]').addEventListener('change', e => { importCSVFiles([...e.target.files]); e.target.value = ''; });
  $$('[data-act-change="exportify-file"]').forEach(i => i.addEventListener('change', e => { exportifyWaiting = false; importCSVFiles([...e.target.files], { source: 'Spotify' }); e.target.value = ''; }));
  $('[data-act-change="apple"]').addEventListener('change', e => importAppleFiles([...e.target.files]));
  $('#ytlink-form').addEventListener('submit', e => { e.preventDefault(); ytImportLink(e.target.u.value.trim()); });
}

// CSV and ZIP files (Exportify, or any CSV with title + artist columns)
async function importCSVFiles(files, { source = 'CSV' } = {}) {
  const items = [];
  for (const f of files) {
    try {
      if (/\.zip$/i.test(f.name) || f.type === 'application/zip') items.push(...await imp.unzipText(f));
      else items.push({ name: f.name, text: await f.text() });
    } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
  }
  const csvs = items.filter(x => !imp.isAlbumCSV(x.text));
  if (!csvs.length) { if (items.length) toast('No songs found in that file', 'err'); return; }
  const prog = csvs.length > 1 ? progress(`Importing ${csvs.length} playlists…`) : null;
  let likedN = 0, pls = 0, songs = 0, firstPl = null;
  const usedNames = new Map(); // each file becomes its own playlist, even if two files share a name
  const report = [];
  for (let i = 0; i < csvs.length; i++) {
    const f = csvs[i];
    prog?.set(i + 1, csvs.length);
    if (prog?.cancelled) break;
    try {
      const tracks = imp.tracksFromCSV(f.text);
      if (!tracks.length) continue;
      const base = (f.name.split('/').pop() || 'Playlist').replace(/\.csv$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Imported playlist';
      // Only a file that is clearly your Liked Songs export goes into Liked Songs; everything else is a playlist
      if (/^(your |my )?liked( songs)?$/i.test(base)) {
        await store.upsertTracks(tracks.map(t => ({ ...t, liked: true, likedAt: t.addedAt || Date.now() })));
        likedN += tracks.length; songs += tracks.length; report.push(['Liked Songs', tracks.length]); continue;
      }
      const k = base.toLowerCase(), n = (usedNames.get(k) || 0) + 1; usedNames.set(k, n);
      const name = n > 1 ? `${base} (${n})` : base;
      const saved = await store.upsertTracks(tracks);
      // Re-importing the same playlist file updates it (only the first file with that name in this batch)
      const ex = n === 1 && [...lib.playlists.values()].find(x => x.name === name && (x.source === source || x.source === 'CSV' || x.source === 'Spotify'));
      let pl;
      if (ex) { ex.trackIds = saved.map(t => t.id); await store.savePlaylist(ex); pl = ex; }
      else pl = await store.createPlaylist(name, saved.map(t => t.id), { source });
      firstPl = firstPl || pl;
      pls++; songs += saved.length; report.push([name, saved.length]);
    } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
  }
  const msg = [pls ? `${pls} playlist${pls > 1 ? 's' : ''}` : '', likedN ? `${likedN} Liked Songs` : ''].filter(Boolean).join(' and ');
  if (report.length > 1) setTimeout(() => modal(`<h3>${icon('check')} Imported ${report.length} files</h3><div class="imp-report">${report.map(([n, c]) => `<div><span>${esc(n)}</span><b>${c} song${c === 1 ? "" : "s"}</b></div>`).join('')}</div><div class="modal-actions center"><button class="btn primary" data-close>Done</button></div>`), 400);
  if (prog) prog.done(msg ? `Imported ${msg} ✓` : 'Nothing to import'); else if (msg) toast(`Imported ${msg} ✓`, 'ok'); else toast('No songs found in that file', 'err');
  renderSidebarPlaylists();
  if (pls === 1 && !likedN && firstPl) location.hash = '#/playlist/' + firstPl.id;
  else if (likedN && !pls) location.hash = '#/library/liked';
  else if (pls || likedN) location.hash = '#/library/playlists';
}
// Spotify via Exportify: open it in a small window, then pick up the downloaded file when you're back
let exportifyWaiting = false;
function openExportify() {
  const narrow = innerWidth < 760;
  const w = narrow ? null : window.open('https://exportify.net/', 'exportify', `popup=yes,width=${Math.min(1000, screen.availWidth - 80)},height=${Math.min(800, screen.availHeight - 80)},left=60,top=40`);
  if (!w) window.open('https://exportify.net/', '_blank', 'noopener');
  exportifyWaiting = true;
  toast('Export from Exportify, then come back here and choose the file', 'info');
}
async function exportifyReturn() {
  if (!exportifyWaiting || document.hidden || !profile) return;
  exportifyWaiting = false;
  await sleep(400);
  if ($('.modal-wrap')) return;
  modal(`<div class="sp-back"><div class="sp-back-ic">${icon('spotify')}</div><h3>Got your Spotify file?</h3>
    <p class="muted">Choose the <b>.zip</b> (Export All) or <b>.csv</b> files you just downloaded from Exportify — usually in your <b>Downloads</b> folder.</p>
    <label class="btn primary big">${icon('import')}Choose file<input type="file" accept=".zip,.csv,application/zip,text/csv" multiple hidden id="sp-back-file"></label>
    <button class="btn ghost block" data-close>Not yet</button></div>`, {
    onMount: (m, close) => m.querySelector('#sp-back-file').addEventListener('change', e => { const fs = [...e.target.files]; close(null); if (fs.length) importCSVFiles(fs, { source: 'Spotify' }); })
  });
}
window.addEventListener('focus', () => setTimeout(exportifyReturn, 300));
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(exportifyReturn, 300); });

async function importAppleFiles(files) {
  let any = false;
  for (const f of files) {
    try {
      const text = await imp.readTextSmart(f);
      if (/^\s*<\?xml|<plist/i.test(text.slice(0, 400))) {
        const lib2 = imp.fromAppleXML(text);
        if (!lib2.tracks.length) { toast(`${f.name}: no songs found`, 'err'); continue; }
        const r = await modal(`<h3>Import from Apple Music</h3><p class="muted tiny">${lib2.tracks.length} songs found. Pick what to bring in.</p>
          <form><div class="pick-list">
            <label class="pick">${likedCover('sm')}<span><b>Favorite (Loved) songs → Liked</b><small>${lib2.loved.length} songs</small></span><input type="checkbox" name="loved" value="1" ${lib2.loved.length ? 'checked' : 'disabled'}></label>
            <label class="pick"><div class="cover sm noimg"><span>♪</span></div><span><b>All songs in my library</b><small>${lib2.tracks.length} songs</small></span><input type="checkbox" name="all" value="1"></label>
            ${lib2.playlists.map((p, i) => `<label class="pick">${cover('', p.name, 'sm')}<span><b>${esc(p.name)}</b><small>${p.trackIds.length} songs${p.smart ? ' · smart playlist' : ''}</small></span><input type="checkbox" name="p" value="${i}" ${p.smart ? '' : 'checked'}></label>`).join('')}
          </div><div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Import</button></div></form>`, { wide: true });
        if (!r) continue;
        const pick = [].concat(r.p || []).map(Number);
        const need = new Set([...(r.loved ? lib2.loved : []), ...pick.flatMap(i => lib2.playlists[i].trackIds), ...(r.all ? lib2.tracks.map(t => t.id) : [])]);
        const saved = await store.upsertTracks(lib2.tracks.filter(t => need.has(t.id)));
        if (r.loved) for (const id of lib2.loved) if (need.has(id)) await store.updateTrack(id, { liked: true });
        for (const i of pick) {
          const p = lib2.playlists[i];
          const ex = [...lib.playlists.values()].find(x => x.source === 'Apple Music' && x.name === p.name);
          if (ex) { ex.trackIds = p.trackIds; await store.savePlaylist(ex); } else await store.createPlaylist(p.name, p.trackIds, { source: 'Apple Music' });
        }
        toast(`Apple Music: ${saved.length} songs, ${pick.length} playlists imported`, 'ok'); any = true;
      } else {
        const tracks = imp.tracksFromAppleTxt(text);
        if (!tracks.length) { toast(`${f.name}: no songs found`, 'err'); continue; }
        const saved = await store.upsertTracks(tracks);
        const name = f.name.replace(/\.txt$/i, '');
        await store.createPlaylist(name, saved.map(t => t.id), { source: 'Apple Music' });
        toast(`Playlist "${name}" imported (${saved.length})`, 'ok'); any = true;
      }
    } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
  }
  renderSidebarPlaylists();
  if (any) location.hash = '#/library/playlists';
}

async function spImportLiked() {
  const prog = progress('Importing Liked Songs…');
  try {
    const tracks = await sp.likedSongs((n, total) => prog.set(n, total));
    await store.upsertTracks(tracks, { liked: true });
    prog.done(`${tracks.length} Liked Songs imported`);
    location.hash = '#/library/liked';
  } catch (e) { prog.fail(e.message); }
}
async function spChoosePlaylists() {
  let pls;
  const prog = progress('Loading your playlists…');
  try { pls = await sp.playlists(); prog.close(); } catch (e) { return prog.fail(e.message); }
  if (!pls.length) return toast('No playlists found on that account');
  const r = await modal(`<h3>Choose playlists to import</h3>
    <form><div class="pick-list">${pls.map(p => `<label class="pick">${cover(p.image, p.name, 'sm')}<span><b>${esc(p.name)}</b><small>${p.total ?? '?'} songs · ${esc(p.owner)}</small></span><input type="checkbox" name="p" value="${p.spotifyId}" checked></label>`).join('')}</div>
    <p class="tiny muted">Spotify only lets apps read songs in playlists you own or collaborate on.</p>
    <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Import</button></div></form>`, { wide: true });
  if (!r) return;
  const sel = [].concat(r.p || []);
  const picked = pls.filter(p => sel.includes(p.spotifyId));
  let ok = 0;
  for (const p of picked) {
    const pr = progress(`Importing "${p.name}"…`);
    try {
      const tracks = await sp.playlistTracks(p.spotifyId, (n, t) => pr.set(n, t));
      const saved = await store.upsertTracks(tracks);
      const existing = [...lib.playlists.values()].find(x => x.spotifyId === p.spotifyId);
      if (existing) { existing.trackIds = saved.map(t => t.id); existing.name = p.name; await store.savePlaylist(existing); }
      else await store.createPlaylist(p.name, saved.map(t => t.id), { source: 'Spotify', spotifyId: p.spotifyId, image: p.image });
      pr.done(`"${p.name}" — ${saved.length} songs`); ok++;
    } catch (e) { pr.fail(`"${p.name}": ${e.status === 403 ? 'Spotify doesn\'t allow reading this playlist (not yours)' : e.message}`); }
  }
  renderSidebarPlaylists();
  if (ok) location.hash = '#/library/playlists';
}

// ---------- OFFLINE ----------
async function vOffline() {
  const off = store.saved().filter(t => t.localFileId);
  let est = '';
  try { const e = await navigator.storage.estimate(); est = `${(e.usage / 1e6).toFixed(0)} MB used of ~${(e.quota / 1e9).toFixed(1)} GB available`; } catch { }
  const persisted = await navigator.storage?.persisted?.();
  view().innerHTML = `<div class="page">${header('Offline', `${off.length} songs playable without internet${est ? ' · ' + est : ''}`, '', '', '')}
    <div class="panel">
      <p class="muted">BAZINGA! plays offline from music files you own that are stored on this device. Add files or a whole folder — they're matched to songs in your library by their tags or by "Artist - Title" file names, and grouped into albums.</p>
      <div class="row-btns"><button class="btn primary" data-act="add-files">${icon('file')}Add music files</button><button class="btn" data-act="add-folder">${icon('folder')}Add a folder</button>
      <label class="toggle"><input type="checkbox" id="pref-off" ${P.preferOffline ? 'checked' : ''}><span></span>Prefer offline files when online too</label></div>
      ${persisted === false ? '<p class="tiny muted">Tip: install BAZINGA! (browser menu → Install / Add to Home Screen) so your browser keeps the files safe.</p>' : ''}
      <p class="tiny muted">YouTube streams themselves can't be saved — that's against YouTube's rules — so songs without a file need internet.</p>
    </div>
    ${off.length ? `<div class="actions">${playBtns('play-list', 'offline')}</div>${tracksSection('offline', off)}` : empty('Nothing offline yet', 'Add music files above to listen anywhere.')}</div>`;
  $('#pref-off').onchange = e => player.setPreferOffline(e.target.checked);
  observeMore();
}

async function addLocalFiles(files, { albumHint } = {}) {
  files = files.filter(f => imp.AUDIO_EXT.test(f.name) || f.type.startsWith('audio/'));
  if (!files.length) return toast('No audio files found', 'err');
  const prog = progress(`Adding ${files.length} files…`);
  let linked = 0, added = 0;
  const albums = new Map();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    prog.set(i + 1, files.length);
    try {
      const tag = await imp.readLocalFile(f);
      let id = trackKey(tag.artist, tag.title);
      // Album page: match by title against the album's tracks
      if (albumHint && !lib.tracks.has(id)) {
        const m = albumHint.find(t => norm(t.title) === norm(tag.title) || norm(f.name).includes(norm(t.title)));
        if (m) id = m.id;
      }
      const existing = lib.tracks.get(id);
      const fileId = 'f_' + id;
      await db.put('files', { id: fileId, blob: f, name: f.name, type: f.type, size: f.size, addedAt: Date.now() });
      let art = existing?.artwork || '';
      if (!art && tag.picture) { try { art = await imageToDataURL(tag.picture, 300); } catch { } }
      const t = {
        ...(existing || {}), id, title: existing?.title || tag.title, artist: existing?.artist || tag.artist,
        album: existing?.album || tag.album, genre: existing?.genre || tag.genre, year: existing?.year || tag.year,
        trackNumber: existing?.trackNumber || tag.trackNumber, artwork: art, localFileId: fileId
      };
      if (t.album && !t.albumId) t.albumId = albumKey(tag.albumArtist || t.artist, t.album);
      await store.upsertTracks([t]);
      existing && !existing.transient ? linked++ : added++;
      if (t.album) {
        const a = albums.get(t.albumId) || { id: t.albumId, title: t.album, artist: tag.albumArtist || mainArtist(t.artist), year: t.year, genre: t.genre, artwork: art, ids: [] };
        a.ids.push([t.trackNumber || 999, id]); if (!a.artwork) a.artwork = art;
        albums.set(t.albumId, a);
      }
    } catch (e) { console.warn('file failed', f.name, e); }
  }
  // Save albums found in the files (so they show up as albums on the device)
  for (const a of albums.values()) {
    const old = lib.albums.get(a.id);
    const ids = a.ids.sort((x, y) => x[0] - y[0]).map(x => x[1]);
    const merged = { ...(old || {}), updatedAt: Date.now(), id: a.id, title: old?.title || a.title, artist: old?.artist || a.artist, year: old?.year || a.year, genre: old?.genre || a.genre, artwork: old?.artwork || a.artwork, trackIds: [...new Set([...(old?.trackIds || []), ...ids])], savedAt: old?.savedAt || Date.now() };
    lib.albums.set(a.id, merged); await db.put('albums', merged);
  }
  store.notify('files');
  prog.done(`${added} new songs, ${linked} linked to your library${albums.size ? `, ${albums.size} albums` : ''} — available offline`);
}

// ---------- SETTINGS ----------
// Scroll so the section's title sits just under the sticky top bar + section tabs (nothing hidden)
function jumpToSection(id, smooth) {
  const el = document.getElementById(id), main = $('#main'); if (!el || !main) return;
  // where the tabs end once they've stuck under the top bar (they sit lower before you scroll)
  const tb = $('.topbar'), topEdge = Math.max(tb && getComputedStyle(tb).display !== 'none' ? tb.getBoundingClientRect().bottom : 0, main.getBoundingClientRect().top);
  const covered = topEdge + ($('.set-jump')?.offsetHeight || 0) - 6;
  const target = main.scrollTop + el.getBoundingClientRect().top - covered - 12;
  main.scrollTo({ top: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
  markSetTab(id);
  // while it glides there, don't let the sections it passes light up their tabs
  setSpyHold = Date.now() + (smooth ? 900 : 150);
}
// Settings tabs follow you: the tab of the section you're reading is highlighted; back at the top, none is.
let setSpyHold = 0, setSpyRaf = 0;
function markSetTab(id) {
  $$('.set-jump a').forEach(a => {
    const on = !!id && a.dataset.jump === id;
    if (a.classList.contains('on') !== on) { a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); }
    if (on) { const bar = a.parentElement, l = a.offsetLeft - bar.offsetLeft, r = l + a.offsetWidth; if (l < bar.scrollLeft || r > bar.scrollLeft + bar.clientWidth) bar.scrollTo({ left: Math.max(0, l - 16), behavior: 'smooth' }); }
  });
}
function settingsSpy() {
  if (setSpyRaf) return;
  setSpyRaf = requestAnimationFrame(() => {
    setSpyRaf = 0;
    const bar = $('.set-jump'), main = $('#main'); if (!bar || !main) return;
    if (Date.now() < setSpyHold) { setSpyHold = Math.min(setSpyHold, Date.now() + 160); return; }
    if (main.scrollTop < 40) return markSetTab(null); // back at the top: nothing selected
    const line = bar.getBoundingClientRect().bottom + 24;
    let cur = null;
    for (const a of $$('.set-jump a')) { const sec = document.getElementById(a.dataset.jump); if (sec && sec.getBoundingClientRect().top <= line) cur = a.dataset.jump; }
    if (main.scrollTop + main.clientHeight >= main.scrollHeight - 4) cur = $$('.set-jump a').map(a => a.dataset.jump).filter(id => { const e = document.getElementById(id); return e && e.getBoundingClientRect().top < innerHeight; }).pop() || cur;
    markSetTab(cur);
  });
}
async function vSettings([section] = []) {
  const lastB = await kv.get('lastBackup');
  const lastD = await kv.get('lastDownload');
  const snaps = await backup.listInternal();
  const fstate2 = backup.linkedFileState();
  const imports = await importSection();
  const ytPanel = await ytBackupPanel();
  view().innerHTML = `<div class="page settings-page"><h1 class="page-h">Settings</h1>
    <nav class="set-jump" aria-label="Settings sections">
      <a href="#account" data-jump="account">${icon('user')}You</a><a href="#sync" data-jump="sync">${icon('link')}Sync</a><a href="#import" data-jump="import">${icon('import')}Import music</a><a href="#yt-backup" data-jump="yt-backup">${icon('yt')}YouTube backup</a>
      <a href="#playback" data-jump="playback">${icon('play')}Playback</a><a href="#voice-set" data-jump="voice-set">${icon('mic')}Voice</a><a href="#backup" data-jump="backup">${icon('restore')}Backup</a></nav>
    <section class="acct-hero" id="account">
      <div class="ah-bg" ${profile.picture ? `style="background-image:url('${esc(profile.picture)}')"` : ''}></div>
      <label class="ah-pic" title="Change photo"><input type="file" accept="image/*" id="pf-file" hidden>
        <span class="avatar xl ah-av">${profile.picture ? `<img src="${esc(profile.picture)}" alt="" referrerpolicy="no-referrer">` : icon('user')}</span><span class="ah-cam">${icon('edit')}</span></label>
      <div class="ah-txt">
        <div class="kicker">${sync.linked() ? `${icon('cloud')} Synced across your devices` : 'On this device · no login needed'}</div>
        <h2 class="pf-name">${esc(profile.username)}</h2>
        <div class="ah-stats">${(() => { const all = store.saved(); return [[all.length, 'songs'], [all.filter(t => t.liked).length, 'liked'], [lib.playlists.size, 'playlists'], [store.artists().length, 'artists']].map(([n, l]) => `<span><b>${n}</b>${l}</span>`).join(''); })()}</div>
        <div class="row-btns"><button class="btn" data-act="rename-user">${icon('edit')}Change name</button>${profile.picture ? `<button class="btn ghost" data-act="remove-pic">Remove photo</button>` : ''}</div>
        <div class="ah-theme"><div class="kicker">Theme color</div>${themePicker(settings.theme || currentTheme())}</div>
      </div>
    </section>
    <div class="panel acct-panel" id="sync"><h2>${icon('link')} Sync your devices</h2>
      ${!sync.available() ? `<p class="muted">Device sync works on the online (GitHub Pages) version of BAZINGA!. Here, use <b>Download backup now</b> below and <b>Restore from file</b> on the other device.</p>`
      : sync.linked() ? `<p class="muted">This device is synced. Your library, likes, playlists, albums and name stay the same on every phone, computer and browser you link — no login. To add another, tap <b>Link a device</b> and scan the QR code (another browser on this phone counts as a device too).</p>
        <div id="sync-line">${syncLine()}</div>
        <div class="row-btns"><button class="btn primary" data-act="link-device">${icon('qr')}Link a device</button><button class="btn" data-act="sync-now">${icon('restore')}Sync now</button><button class="btn ghost" data-act="enter-code">I have a code</button></div>
        <details class="howto"><summary>Stop syncing</summary><div class="row-btns"><button class="btn ghost" data-act="sync-leave">Stop syncing this device</button><button class="btn ghost danger-t" data-act="sync-forget">Turn off sync everywhere</button></div><p class="tiny muted">Synced copies pass through the free ntfy.sh relay, encrypted on your device first. Keep BAZINGA! open on a device now and then (at least every few hours when you've made changes) so your other devices can pick them up.</p><div></div></details>`
      : `<p class="muted">Use your music on your phone, computer and every browser — no account, no password. Scan a QR code or open a link on the other device and everything stays in sync automatically. Your library is encrypted on your device before it's sent.</p>
        <div class="row-btns"><button class="btn primary" data-act="link-device">${icon('qr')}Link a device</button><button class="btn" data-act="enter-code">${icon('link')}I have a code or link</button></div>`}
    </div>
    <div class="panel support-panel only-m">${supportPanelInner()}</div>
    ${imports}
    ${ytPanel}
    <div class="panel" id="playback"><h2>${icon('play')} Playback</h2>
      <div class="fld"><span>When the queue finishes</span><div class="seg big choice" id="set-autoplay">
        ${[['liked', 'Play Liked Songs'], ['replay', 'Replay the queue'], ['off', 'Stop']].map(([v, l]) => `<label><input type="radio" name="autoplay" value="${v}" ${(settings.autoplay || 'liked') === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}
      </div></div>
      <p class="tiny muted">Autoplay keeps the music going: after the last song it starts your Liked Songs (shuffled), or plays the same queue again from the top. If the queue already was your Liked Songs, it replays them.</p>
      <label class="toggle"><input type="checkbox" id="set-prefoff" ${P.preferOffline ? 'checked' : ''}><span></span>Prefer offline files when online too</label>
      <label class="toggle"><input type="checkbox" id="set-awake" ${settings.keepAwake !== false ? 'checked' : ''}><span></span><div>Keep the screen on while BAZINGA! is open<small class="tiny muted" style="display:block">Phones stop web music when they lock — this keeps your songs playing.</small></div></label>
      <label class="toggle"><input type="checkbox" id="set-lock" ${settings.lockFeature !== false ? 'checked' : ''}><span></span><div>Screen lock<small class="tiny muted" style="display:block">Shows a lock button (top bar on phones, sidebar on computers), and tapping an empty spot 3 times quickly locks the app so pocket touches and accidental taps do nothing. Tap 3 times again to unlock — the music keeps playing.</small></div></label>
      <button class="btn" data-act="a2hs">${icon('plus')}Add BAZINGA! to your Home Screen</button>
      <p class="tiny muted">Lock screen & background: for now, keep BAZINGA! open to keep the music going — phones pause web players when they lock or you switch apps. Songs with an offline file keep playing. Lock-screen listening is Phase 2: <a class="lnk" href="#/support" data-act="phase2">help us unlock it ☕</a></p>
    </div>
    <div class="panel" id="voice-set"><h2>${icon('mic')} Voice assistant</h2>
      ${(() => {
        const vs = voiceOptions();
        if (!vs.length) return '<p class="muted tiny">This browser has no built-in voices, so the assistant answers on screen only.</p>';
        return `<div class="fld"><span>Voice</span><div class="voice-pick"><select id="set-voice" class="select">
          <option value="">Automatic — most natural voice (${esc(vs[0].name)})</option>
          ${vs.map(v => `<option value="${esc(v.name)}" ${settings.voiceName === v.name ? 'selected' : ''}>${esc(v.name)} · ${v.quality}</option>`).join('')}
          </select><button class="btn" id="voice-try" type="button">${icon('play')}Try it</button></div></div>
          `;
      })()}
      <p class="tiny muted">Tap a mic button to talk to BAZINGA!. The microphone is only on while the assistant is open, and the music stays quiet until it closes.</p>
    </div>
    <div class="panel" id="backup"><h2>${icon('restore')} Backup & restore</h2>
      <p class="muted">BAZINGA! backs itself up automatically every time something changes. Last backup: <b>${lastB ? new Date(lastB).toLocaleString() : 'not yet'}</b>.</p>
      ${backup.fsSupported ? `<div class="sub-panel"><b>Auto-updating backup file</b>
        <p class="tiny muted">Pick a file on this device (e.g. in Documents or a synced folder). BAZINGA! keeps it up to date automatically — it survives even if browser data is cleared.</p>
        ${fstate2 === 'ok' ? `<p class="ok-line">${icon('check')} Linked and up to date.</p><button class="btn ghost" data-act="bk-unlink">Unlink file</button>`
          : fstate2 === 'needs-permission' ? `<button class="btn primary" data-act="bk-regrant">Resume auto-backup (allow access)</button>`
          : `<button class="btn primary" data-act="bk-link">${icon('file')}Choose backup file</button>`}</div>`
        : `<div class="sub-panel"><b>Backup file</b><p class="tiny muted">This browser can't write to a file automatically, so download a backup now and then (last: ${lastD ? new Date(lastD).toLocaleDateString() : 'never'}). We'll remind you weekly.</p></div>`}
      <div class="row-btns"><button class="btn" data-act="bk-download">${icon('import')}Download backup now</button><button class="btn" data-act="bk-restore-file">${icon('restore')}Restore from file</button></div>
      ${snaps.length ? `<details class="howto"><summary>Automatic snapshots on this device (${snaps.length})</summary>${snaps.map(s => `<div class="snap"><span>${new Date(s.ts).toLocaleString()} · ${s.counts.tracks} songs, ${s.counts.playlists} playlists, ${s.counts.albums} albums</span><button class="btn sm ghost" data-act="bk-restore-snap" data-id="${s.id}">Restore</button></div>`).join('')}</details>` : ''}
      <p class="tiny muted">Backups contain your library, playlists, albums, YouTube matches, profile and settings. Offline music files aren't copied (they're large) — keep the originals and re-add them after a restore.</p>
    </div>

    <div class="panel support-panel only-d">${supportPanelInner()}</div>

    <div class="panel"><h2>${icon('mic')} Lyrics (Genius)</h2>
      <p class="muted tiny">Lyrics come from Genius's official lyrics widget. If they don't load, add a free Genius access token: open <a class="lnk" href="https://genius.com/api-clients" target="_blank" rel="noopener">genius.com/api-clients</a> → New API Client (any name, any website) → Generate Access Token → paste it here. It's stored only on this device.</p>
      <form id="genius-form" class="stack"><label class="fld"><span>Genius access token (optional)</span><input name="geniusToken" value="${esc(settings.geniusToken || '')}" autocomplete="off"></label><button class="btn">Save</button></form>
    </div>

    <div class="panel"><h2>${icon('yt')} YouTube matching</h2>
      <p class="muted tiny">By default BAZINGA! finds videos through free public services — no key, no limits, but they're sometimes slow or down. For rock-solid matching add your own free YouTube Data API key (Google Cloud Console → YouTube Data API v3 → Credentials). It's stored only on this device.</p>
      <form id="yt-form" class="stack">
        <label class="fld"><span>Your YouTube API key (optional)</span><input name="ytKey" value="${esc(settings.ytKey)}" placeholder="AIza…" autocomplete="off"></label>
        <label class="fld"><span>Custom Invidious server (optional)</span><input name="customInstance" value="${esc(settings.customInstance)}" placeholder="https://your-invidious.example"></label>
        <button class="btn">Save</button></form>
      <button class="btn ghost" data-act="clear-ytcache">Forget all YouTube matches</button>
    </div>

    <div class="panel"><h2>${icon('sparkle')} Music info</h2>
      <label class="toggle"><input type="checkbox" id="set-enrich" ${settings.enrich !== false ? 'checked' : ''}><span></span>Automatically fill in genres, release dates & artwork</label>
      <label class="fld"><span>Music store region (for search & albums)</span><select id="set-country" class="select">${['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'ES', 'IT', 'NL', 'SE', 'BR', 'MX', 'JP', 'KR', 'IN', 'NG', 'ZA', 'KE', 'ET', 'EG', 'AE', 'TR', 'PL', 'IE', 'NZ'].map(c => `<option ${settings.country === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <p class="tiny muted" id="enrich-status"></p>
    </div>

    <div class="panel danger-zone"><h2>${icon('trash')} Erase this device</h2>
      <p class="muted">Erases your name, library, playlists, albums, offline files and on-device backups from this browser. ${sync.linked() ? 'Your other synced devices keep their music. ' : ''}A backup file you saved elsewhere is not touched.</p>
      <button class="btn danger" data-act="delete-account">Erase everything here</button></div>
    <p class="tiny muted center"><a class="lnk" href="#/legal">Privacy Policy & Terms</a></p>
  </div>`;
  $('#pf-file').onchange = async e => { const f = e.target.files[0]; if (!f) return; profile.picture = await imageToDataURL(f, 256); await profileChanged(); rerender(); };
  $('#gcid-form')?.addEventListener('submit', async e => { e.preventDefault(); await saveSettings({ googleClientId: e.target.cid.value.trim() }); await ya.signOut(); toast('Saved — now sign in with YouTube', 'ok'); rerender(); });
  wireImport();
  $$('#set-autoplay input').forEach(i => i.onchange = () => saveSettings({ autoplay: i.value }));
  $$('.ah-theme [data-theme]').forEach(b => b.onclick = async () => {
    const k = b.dataset.theme; markThemePicks(k); await saveSettings({ theme: k });
    toast(`${THEMES.find(t => t[0] === k)[1]} it is ⚡`, 'ok');
  });
  $('#set-prefoff').onchange = e => player.setPreferOffline(e.target.checked);
  $('#set-lock').onchange = e => { saveSettings({ lockFeature: e.target.checked }); applyLockSetting(); toast(e.target.checked ? 'Screen lock is on — tap 3 times or use the lock button' : 'Screen lock is off', e.target.checked ? 'ok' : 'info'); };
  $('#set-awake').onchange = e => { saveSettings({ keepAwake: e.target.checked }); toast(e.target.checked ? 'Your screen stays on while BAZINGA! is open ⚡' : 'Screen can lock again — music may stop when it does', e.target.checked ? 'ok' : 'info'); };
  $('#set-voice')?.addEventListener('change', e => { saveSettings({ voiceName: e.target.value }); setVoicePrefs({ name: e.target.value }); previewVoice(e.target.value); });
  $('#voice-try')?.addEventListener('click', () => previewVoice($('#set-voice').value));
  // (the tab lets go of focus right away, so it can't keep looking selected after you scroll on)
  $$('.set-jump a').forEach(a => a.onclick = e => { e.preventDefault(); a.blur(); jumpToSection(a.dataset.jump, true); });
  const main = $('#main'); main.removeEventListener('scroll', settingsSpy); main.addEventListener('scroll', settingsSpy, { passive: true });
  if (section) requestAnimationFrame(() => jumpToSection(section, false));
  $('#genius-form').onsubmit = async e => { e.preventDefault(); await saveSettings({ geniusToken: e.target.geniusToken.value.trim() }); lyricsCache.clear(); toast('Saved', 'ok'); };
  $('#yt-form').onsubmit = async e => { e.preventDefault(); await saveSettings(Object.fromEntries(new FormData(e.target))); toast('Saved'); };
  $('#set-enrich').onchange = e => saveSettings({ enrich: e.target.checked });
  $('#set-country').onchange = e => saveSettings({ country: e.target.value });
  const st = () => { const el = $('#enrich-status'); if (el) { const n = store.enrichPending(); el.textContent = n ? `Filling in details for ${n} songs in the background…` : ''; } };
  st(); on('enrich', st);
}

// ---------- SHARED LINK ----------
async function vShared([data]) {
  let d;
  try { d = await unpackString(data); } catch { view().innerHTML = empty('This share link is broken', 'Ask your friend to share it again.'); return; }
  const tracks = (d.t || []).map(x => ({
    id: trackKey(x[1], x[0]), title: x[0], artist: x[1], artists: x[1].split(/\s*,\s*/), album: x[2] || '', year: x[3] || null, genre: x[4] || '', durationMs: x[5] || 0, artwork: x[6] || '', _yt: [x[7], x[8]]
  }));
  for (const t of tracks) { if (t._yt[0] || t._yt[1]) { const c = (await db.get('ytcache', t.id)) || {}; if (!c.video && t._yt[0]) c.video = t._yt[0]; if (!c.audio && t._yt[1]) c.audio = t._yt[1]; await db.put('ytcache', c, t.id); } delete t._yt; }
  const ts = tracks.map(t => lib.tracks.get(t.id) || store.remember(t));
  window.__shared = { d, tracks: ts };
  setTitle(d.n || 'Shared music');
  view().innerHTML = `<div class="page">${header(esc(d.n || 'Shared music'), `Shared by ${esc(d.by || 'a friend')} · ${ts.length} songs`, cover(d.a || ts[0]?.artwork, d.n), '', d.k === 'album' ? 'Album' : d.k === 'song' ? 'Song' : 'Playlist')}
    <div class="actions">${playBtns('play-list', 'shared')}<button class="btn primary-o" data-act="save-shared">${icon('plus')}Save to my library</button></div>
    ${tracksSection('shared', ts, { noFilter: true })}</div>`;
}

// ---------- LEGAL ----------
async function vLegal() {
  view().innerHTML = `<div class="page"><h1 class="page-h">Privacy Policy & Terms</h1><div class="panel legal">${LEGAL_HTML}
    <p class="ok-line">${icon('check')} You accepted version ${esc(profile.termsAccepted || '')}${profile.termsAcceptedAt ? ' on ' + new Date(profile.termsAcceptedAt).toLocaleDateString() : ''}.</p></div></div>`;
}

// ---------- QUEUE (full page on phones) ----------
async function vQueue() { view().innerHTML = `<div class="page"><h1 class="page-h">Queue</h1><div id="queue-page"></div></div>`; renderQueue($('#queue-page')); }

async function notePlaylistPlay(pid) {
  if (!pid || !lib.playlists.has(pid)) return;
  const m = (await kv.get('plPlays')) || {};
  m[pid] = { n: (m[pid]?.n || 0) + 1, at: Date.now() };
  kv.set('plPlays', m);
}
// What to play when the queue runs out (Settings → Playback)
function queueEnded(ids) {
  const mode = settings.autoplay || 'liked';
  if (mode === 'off') return null;
  const liked = store.saved().filter(t => t.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0)).map(t => t.id);
  const wasLiked = ids.length && ids.every(id => lib.tracks.get(id)?.liked) && ids.length >= Math.min(liked.length, 20);
  if (mode === 'liked' && liked.length && !wasLiked) { nowCtx = { list: null }; return { ids: liked, shuffle: true, msg: 'Queue finished — playing your Liked Songs' }; }
  return { ids, shuffle: P.shuffle, msg: 'Queue finished — playing it again' };
}

// ================= PROGRESS HELPER =================
function progress(label) {
  const root = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast prog';
  el.innerHTML = `<div class="pl">${esc(label)}</div><div class="bar"><i style="width:0%"></i></div><button class="ib sm" aria-label="Stop">${icon('close')}</button>`;
  root.appendChild(el);
  const ctl = { cancelled: false };
  el.querySelector('button').onclick = () => { ctl.cancelled = true; el.remove(); };
  const end = (msg, kind) => { el.remove(); if (msg) toast(msg, kind); };
  return Object.assign(ctl, {
    set(n, total) { el.querySelector('i').style.width = total ? (100 * n / total).toFixed(1) + '%' : '30%'; el.querySelector('.pl').textContent = `${label} ${n}${total ? '/' + total : ''}`; },
    done: m => end(m, 'ok'), fail: m => end(m, 'err'), close: () => end()
  });
}

// ================= YOUTUBE BATCH + EXPORT =================
async function ytMatches() {
  const keys = await db.keys('ytcache'), vals = await db.all('ytcache');
  const m = new Map(); keys.forEach((k, i) => m.set(k, vals[i])); return m;
}
async function matchList(ids) {
  const have = await ytMatches();
  const todo = ids.filter(id => { const c = have.get(id); return !c || (!c.video && !c.audio); }).map(id => lib.tracks.get(id)).filter(Boolean);
  if (!todo.length) return toast('All songs already have YouTube matches ✓', 'ok');
  const prog = progress('Finding YouTube versions…');
  try {
    const { found } = await yt.matchMany(todo, { onProgress: (n, t) => prog.set(n, t), isCancelled: () => prog.cancelled });
    if (!prog.cancelled) prog.done(`Matched ${found} of ${todo.length} songs`);
  } catch (e) { prog.fail(e.message); }
  emit('dirty', 'yt');
}
// Which YouTube playlist a BAZINGA! list was saved to before (so "update" adds only new songs)
async function ytLinkOf(key) { return lib.playlists.get(key)?.ytPlaylistId || ((await kv.get('ytLinks')) || {})[key] || null; }
async function setYtLink(key, ytId) {
  const pl = lib.playlists.get(key);
  if (pl) { pl.ytPlaylistId = ytId; await store.savePlaylist(pl); return; }
  const m = (await kv.get('ytLinks')) || {}; m[key] = ytId; await kv.set('ytLinks', m);
}
const ytNoSetup = () => `<p class="tiny muted">Creating playlists on your YouTube account needs a one-time Google key for this copy of BAZINGA! (Settings → YouTube backup). Until then, open the songs as a ready-made playlist on YouTube below.</p>`;

async function ytExport(ids, name = 'My BAZINGA! playlist', jobKey = 'list') {
  ids = ids.filter(id => lib.tracks.has(id));
  if (!ids.length) return toast('No songs here yet', 'err');
  const pending = (await ya.pendingJobs())[jobKey];
  const have = await ytMatches();
  const missing = ids.filter(id => { const c = have.get(id); return !c?.video && !c?.audio; }).length;
  const signed = ya.signedIn(), ready = ya.configured();
  const linked = await ytLinkOf(jobKey);
  const r = await modal(`<h3>${icon('yt')} Save to YouTube</h3>
    ${pending ? `<div class="sub-panel"><b>Upload paused — ${pending.videoIds.length - pending.done} songs left</b><p class="tiny muted">"${esc(pending.title)}" stopped at YouTube's daily limit.</p>
      <div class="row-btns"><button class="btn primary" data-resolve="resume">${icon('upload')}Resume upload</button><button class="btn ghost" data-resolve="drop">Discard</button></div></div>` : ''}
    ${ready ? `<form class="yt-form">
      <p class="muted tiny">Creates a real playlist on your YouTube account with ${ids.length === 1 ? 'this song' : `these ${ids.length} songs`}${missing ? ` (BAZINGA! first finds YouTube versions for the ${missing} without one)` : ''}.</p>
      <label class="fld"><span>Playlist name</span><input name="title" value="${esc(name)}" maxlength="150" required></label>
      ${ytChoiceFields(!!linked)}
      <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">${icon('upload')}${signed ? 'Save to YouTube' : 'Sign in & save'}</button></div>
    </form>` : ytNoSetup()}
    <details class="howto" ${ready ? '' : 'open'}><summary>No sign-in: open as a playlist on YouTube</summary><div class="yt-links"></div></details>`, {
    wide: true,
    onMount: m => {
      const d = m.querySelector('details');
      const fill = async () => {
        if (d.dataset.done) return; d.dataset.done = 1;
        m.querySelector('.yt-links').innerHTML = await ytLinksHTML([{ title: name, ids }], missing);
      };
      d.addEventListener('toggle', () => d.open && fill());
      if (d.open) fill();
    }
  });
  if (!r) return;
  if (r === 'resume') return resumeUpload(jobKey);
  if (r === 'drop') { await ya.dropJob(jobKey); return toast('Discarded'); }
  try { if (!ya.signedIn()) await ya.signIn(); } catch (e) { return toast(e.message, 'err'); }
  const res = await uploadList({ ids, title: r.title.trim() || name, jobKey, mode: r.mode, privacy: r.privacy, update: !!r.update });
  if (res?.url) ytDoneModal([res]);
}
const ytChoiceFields = (canUpdate, updateLabel = 'Update the YouTube playlist I made before (adds only new songs)') => `
  <div class="fld"><span>Which versions?</span><div class="seg big choice">
    <label><input type="radio" name="mode" value="video" ${P.mode === 'video' ? 'checked' : ''}><span>${icon('video')}Music videos</span></label>
    <label><input type="radio" name="mode" value="audio" ${P.mode !== 'video' ? 'checked' : ''}><span>${icon('audio')}Audio only</span></label></div></div>
  <label class="fld"><span>Who can see it on YouTube?</span><select name="privacy" class="select"><option value="private">Only me (private)</option><option value="unlisted">Anyone with the link (unlisted)</option><option value="public">Everyone (public)</option></select></label>
  ${canUpdate ? `<label class="toggle"><input type="checkbox" name="update" value="1" checked><span></span>${updateLabel}</label>` : ''}
  <p class="tiny muted">YouTube lets this app add about 200 songs a day for all users together. Bigger uploads pause and you can resume them later.</p>`;

// "Open on YouTube" links (no sign-in needed), 50 songs per link
async function ytLinksHTML(groups, missing = 0) {
  const have = await ytMatches();
  const part = (links, label) => links.map((l, i) => `<a class="btn ${i ? '' : 'primary'} block" href="${l}" target="_blank" rel="noopener">${icon('yt')}${esc(label)}${links.length > 1 ? ` — part ${i + 1}/${links.length}` : ''}</a>`).join('');
  let html = '';
  for (const g of groups) {
    const vids = [], auds = [];
    g.ids.forEach(id => { const c = have.get(id); if (c?.video || c?.audio) vids.push(c.video || c.audio); if (c?.audio || c?.video) auds.push(c.audio || c.video); });
    if (!vids.length) continue;
    html += `${groups.length > 1 ? `<h4>${esc(g.title)}</h4>` : ''}${part(yt.youtubePlaylistLinks(vids), groups.length > 1 ? 'Music videos' : 'Open music videos on YouTube')}${part(yt.youtubePlaylistLinks(auds), groups.length > 1 ? 'Audio versions' : 'Open audio versions on YouTube')}`;
  }
  return html ? `<p class="tiny muted">Opens YouTube with the songs lined up as a playlist (50 per link).${missing ? ` ${missing} songs don't have a YouTube match yet — use "Find YouTube matches" first to include them.` : ''}</p>${html}`
    : '<p class="tiny muted">No YouTube matches yet — tap "Find YouTube matches" first.</p>';
}

// Make sure every song has a YouTube version, then create/update the playlist on the user's account
async function uploadList({ ids, title, jobKey, mode, privacy, update, quiet = false }) {
  let have = await ytMatches();
  const todo = ids.filter(id => { const c = have.get(id); return !c?.video && !c?.audio; }).map(id => lib.tracks.get(id)).filter(Boolean);
  if (todo.length) {
    const pr = progress(`Finding YouTube versions for "${title}"…`);
    try { await yt.matchMany(todo, { onProgress: (n, t) => pr.set(n, t), isCancelled: () => pr.cancelled }); pr.close(); } catch (e) { pr.fail(e.message); return null; }
    if (pr.cancelled) return null;
    have = await ytMatches();
  }
  let videoIds = [...new Set(ids.map(id => { const c = have.get(id); return c?.[mode] || c?.video || c?.audio; }).filter(Boolean))];
  if (!videoIds.length) { toast(`"${title}": no YouTube versions found`, 'err'); return null; }
  let ytPlaylistId = null;
  const linked = await ytLinkOf(jobKey);
  if (update && linked) {
    try {
      const existing = await ya.existingVideoIds(linked);
      if (existing) { ytPlaylistId = linked; videoIds = videoIds.filter(v => !existing.has(v)); }
    } catch (e) { toast(e.message, 'err'); return null; }
    if (ytPlaylistId && !videoIds.length) { if (!quiet) toast(`"${title}" is already up to date on YouTube ✓`, 'ok'); return { title, url: 'https://www.youtube.com/playlist?list=' + ytPlaylistId, upToDate: true }; }
  }
  const job = { key: jobKey, title, ytPlaylistId, videoIds, done: 0, privacy, created: Date.now() };
  return runUploadJob(job);
}
async function runUploadJob(job) {
  const pr = progress(`Saving "${job.title}" to YouTube…`);
  try {
    const res = await ya.runUpload(job, { onProgress: (n, t) => pr.set(n, t), isCancelled: () => pr.cancelled });
    if (job.ytPlaylistId) await setYtLink(job.key, job.ytPlaylistId);
    if (pr.cancelled) { toast('Upload paused — resume it any time from Settings → YouTube backup'); return null; }
    pr.close();
    return { title: job.title, url: res.url, skipped: res.skipped };
  } catch (e) {
    pr.fail(e.message);
    if (job.ytPlaylistId) await setYtLink(job.key, job.ytPlaylistId);
    if (e.quota) modal(`<h3>Daily YouTube limit reached</h3><p class="muted">${esc(e.message)}</p><p class="tiny muted">${job.done} of ${job.videoIds.length} songs of "${esc(job.title)}" are already in the playlist.</p><div class="modal-actions"><button class="btn primary" data-close>OK</button></div>`);
    return e.quota ? { quota: true } : null;
  }
}
function ytDoneModal(results) {
  results = results.filter(r => r?.url);
  if (!results.length) return;
  modal(`<h3>${icon('check')} Saved to YouTube</h3>
    <p class="muted">${results.length === 1 ? `"${esc(results[0].title)}" is on your YouTube account${results[0].skipped ? ` (${results[0].skipped} videos YouTube wouldn't allow were skipped)` : ''}.` : `${results.length} playlists are on your YouTube account.`}</p>
    <div class="pick-list">${results.map(r => `<a class="pick" href="${r.url}" target="_blank" rel="noopener">${cover('', r.title, 'sm')}<span><b>${esc(r.title)}</b><small>${r.upToDate ? 'Already up to date' : 'Open on YouTube'}</small></span>${icon('yt')}</a>`).join('')}</div>
    <div class="modal-actions"><button class="btn primary" data-close>Done</button></div>`);
}
async function resumeUpload(key) {
  const job = (await ya.pendingJobs())[key];
  if (!job) return toast('Nothing to resume');
  try { if (!ya.signedIn()) await ya.signIn(); } catch (e) { return toast(e.message, 'err'); }
  const res = await runUploadJob(job);
  if (res?.url) ytDoneModal([res]);
}

// Settings → YouTube backup: pick any playlists (and Liked Songs) and create them on YouTube in one go
function backupLists() {
  const liked = store.saved().filter(t => t.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0)).map(t => t.id);
  return [
    ...(liked.length ? [{ key: 'lib:liked', title: 'Liked Songs (BAZINGA!)', ids: liked, liked: true }] : []),
    ...[...lib.playlists.values()].sort((a, b) => a.name.localeCompare(b.name)).filter(p => p.trackIds.length).map(p => ({ key: p.id, title: p.name, ids: p.trackIds.filter(id => lib.tracks.has(id)), img: plCover(p) }))
  ];
}
async function ytBackupPicker() {
  const all = backupLists();
  if (!all.length) return toast('Make a playlist or like some songs first', 'err');
  const ready = ya.configured();
  const links = await kv.get('ytLinks') || {};
  const r = await modal(`<h3>${icon('yt')} Save playlists to YouTube</h3>
    <p class="muted tiny">${ready ? 'Pick what to put on your YouTube account. Each one becomes a YouTube playlist; ones you saved before just get the new songs added.' : 'Pick what to open on YouTube.'}</p>
    <form><div class="pick-list">${all.map(l => `<label class="pick">${l.liked ? likedCover('sm') : cover(l.img, l.title, 'sm')}<span><b>${esc(l.title)}</b><small>${l.ids.length} songs${(lib.playlists.get(l.key)?.ytPlaylistId || links[l.key]) ? ' · on YouTube' : ''}</small></span><input type="checkbox" name="p" value="${esc(l.key)}" checked></label>`).join('')}</div>
      ${ready ? ytChoiceFields(true, 'Update playlists I saved before (adds only new songs)') : ytNoSetup()}
      <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">${icon(ready ? 'upload' : 'yt')}${ready ? (ya.signedIn() ? 'Save to YouTube' : 'Sign in & save') : 'Get YouTube links'}</button></div></form>`, { wide: true });
  if (!r) return;
  const pick = [].concat(r.p || []);
  const chosen = all.filter(l => pick.includes(l.key));
  if (!chosen.length) return toast('Nothing selected');
  if (!ready) {
    const have = await ytMatches();
    const todo = [...new Set(chosen.flatMap(l => l.ids))].filter(id => { const c = have.get(id); return !c?.video && !c?.audio; }).map(id => lib.tracks.get(id)).filter(Boolean);
    if (todo.length) {
      const pr = progress('Finding YouTube versions…');
      try { await yt.matchMany(todo, { onProgress: (n, t) => pr.set(n, t), isCancelled: () => pr.cancelled }); pr.close(); } catch (e) { pr.fail(e.message); }
      if (pr.cancelled) return;
    }
    return modal(`<h3>${icon('yt')} Open on YouTube</h3><div class="yt-links">${await ytLinksHTML(chosen)}</div>`, { wide: true });
  }
  try { if (!ya.signedIn()) await ya.signIn(); } catch (e) { return toast(e.message, 'err'); }
  const results = [];
  for (const l of chosen) {
    const res = await uploadList({ ids: l.ids, title: l.title, jobKey: l.key, mode: r.mode, privacy: r.privacy, update: !!r.update, quiet: true });
    if (res?.quota) break;
    if (res) results.push(res);
  }
  ytDoneModal(results);
  if (location.hash.startsWith('#/settings')) rerender();
}
async function ytBackupPanel() {
  const jobs = Object.values(await ya.pendingJobs());
  const ready = ya.configured(), signed = ya.signedIn();
  const keyForm = `<form id="gcid-form" class="inline-form"><input name="cid" value="${esc(settings.googleClientId || '')}" placeholder="…apps.googleusercontent.com" autocomplete="off"><button class="btn">Save key</button></form>`;
  const steps = `<ol class="tiny"><li>Open <a class="lnk" href="https://console.cloud.google.com/" target="_blank" rel="noopener">console.cloud.google.com</a> → create a project → enable <b>YouTube Data API v3</b>.</li>
      <li>OAuth consent screen → External → add yourself as a test user.</li>
      <li>Credentials → Create credentials → OAuth client ID → <b>Web application</b>. Under Authorized JavaScript origins add <code class="copy" data-act="copy" data-v="${esc(location.origin)}">${esc(location.origin)}</code></li>
      <li>Copy the Client ID and paste it here.</li></ol>`;
  return `<section class="panel yt-panel" id="yt-backup"><h2>${icon('yt', 'brand-yt')} YouTube backup</h2>
    <p class="muted tiny">Turn your BAZINGA! playlists and Liked Songs into real playlists on your YouTube account, and bring your YouTube playlists back in — a second copy of your music, just in case. The YouTube sign-in stays on this device and expires after about an hour.</p>
    <div class="yt-two">
      <div class="sub-panel"><b>${icon('upload')} BAZINGA! → YouTube</b><p class="tiny muted">Pick playlists and they're created on your YouTube account automatically.</p>
        <button class="btn primary" data-act="yt-backup">${icon('upload')}Save playlists to YouTube</button></div>
      <div class="sub-panel"><b>${icon('import')} YouTube → BAZINGA!</b><p class="tiny muted">Import your YouTube playlists and Liked videos, or any public playlist link (Import music → From YouTube).</p>
        ${ready ? `<button class="btn" data-act="yt-import-mine">${icon('yt')}Import my YouTube playlists</button>` : `<a class="btn" href="#/settings/import">${icon('import')}Import a playlist link</a>`}</div>
    </div>
    <div class="row-btns">${!ready ? '' : signed ? `<span class="ok-line">${icon('check')} YouTube connected</span><button class="btn ghost" data-act="yt-signout">Disconnect</button>` : `<button class="btn ghost" data-act="yt-signin">${icon('yt')}Connect YouTube account</button>`}</div>
    ${jobs.length ? `<div class="sub-panel"><b>Paused uploads</b>${jobs.map(j => `<div class="snap"><span>${esc(j.title)} · ${j.videoIds.length - j.done} songs left</span><span><button class="btn sm primary" data-act="yt-resume" data-job="${esc(j.key)}">Resume</button> <button class="btn sm ghost" data-act="yt-drop" data-job="${esc(j.key)}">Discard</button></span></div>`).join('')}</div>` : ''}
    ${ready ? `<details class="howto"><summary>Use your own Google key (for big uploads)</summary><p class="tiny muted">YouTube lets each Google key add about 200 songs a day. With your own free key you get your own daily allowance:</p>${steps}${keyForm}</details>`
      : `<details class="howto"><summary>Connect your YouTube account (one-time setup)</summary><p class="tiny muted">Creating playlists on YouTube needs a free Google sign-in key. Without it you can still open any playlist on YouTube as a ready-made playlist and import public playlist links.</p>${steps}${keyForm}</details>`}
  </section>`;
}

// ---------- import from YouTube ----------
async function importVideos(title, videos, { liked = false, source = 'YouTube', ytPlaylistId = null } = {}) {
  const tracks = [], seen = new Set();
  for (const v of videos) {
    const { artist, title: t, artists } = yt.videoToSong(v);
    if (!artist || !t) continue;
    const id = trackKey(artist, t);
    if (seen.has(id)) continue; seen.add(id);
    tracks.push({ id, title: t, artist, artists, durationMs: (v.seconds || 0) * 1000, addedAt: Date.now() });
    const c = await db.get('ytcache', id);
    if (!c?.video && !c?.audio) await db.put('ytcache', { video: v.id, audio: v.id, videoTitle: v.title, audioTitle: v.title, fromYouTube: true }, id);
  }
  if (!tracks.length) throw new Error('No playable videos found in that playlist.');
  const saved = await store.upsertTracks(tracks, liked ? { liked: true } : {});
  if (liked) return { count: saved.length, liked: true };
  const ex = [...lib.playlists.values()].find(x => ytPlaylistId && x.ytPlaylistId === ytPlaylistId);
  if (ex) { ex.trackIds = saved.map(t => t.id); ex.name = title; await store.savePlaylist(ex); return { count: saved.length, playlist: ex }; }
  const p = await store.createPlaylist(title, saved.map(t => t.id), { source, ytPlaylistId });
  return { count: saved.length, playlist: p };
}
async function ytImportMine() {
  let lists;
  const pr = progress('Loading your YouTube playlists…');
  try { if (!ya.signedIn()) await ya.signIn(); lists = await ya.myPlaylists(); pr.close(); } catch (e) { return pr.fail(e.message); }
  if (!lists.length) return toast('No playlists on that YouTube account');
  const r = await modal(`<h3>${icon('yt')} Import from YouTube</h3><form><div class="pick-list">${lists.map(p => `<label class="pick">${p.liked ? likedCover('sm') : cover(p.image, p.title, 'sm')}<span><b>${esc(p.title)}</b><small>${p.count ?? '?'} videos${p.liked ? ' · goes to your Liked Songs' : ''}</small></span><input type="checkbox" name="p" value="${esc(p.id)}" ${p.liked ? '' : 'checked'}></label>`).join('')}</div>
    <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Import</button></div></form>`, { wide: true });
  if (!r) return;
  const pick = [].concat(r.p || []);
  let n = 0;
  for (const id of pick) {
    const p = lists.find(x => x.id === id);
    const pg = progress(`Importing "${p.title}"…`);
    try { const vids = await ya.playlistVideos(id); const res = await importVideos(p.title, vids, { liked: !!p.liked, ytPlaylistId: p.liked ? null : id }); pg.done(`"${p.title}" — ${res.count} songs`); n++; }
    catch (e) { pg.fail(`"${p.title}": ${e.message}`); }
  }
  renderSidebarPlaylists();
  if (n) location.hash = '#/library/playlists';
}
async function ytImportLink(link) {
  const id = yt.parsePlaylistId(link);
  if (!id) return toast('Paste a YouTube playlist link (it contains "list=")', 'err');
  const pr = progress('Reading YouTube playlist…');
  try {
    let data;
    try { data = await yt.publicPlaylist(id); }
    catch (e) { if (ya.signedIn()) data = { title: 'YouTube playlist', videos: await ya.playlistVideos(id) }; else throw e; }
    const res = await importVideos(data.title, data.videos, { ytPlaylistId: id });
    pr.done(`"${data.title}" — ${res.count} songs imported`);
    renderSidebarPlaylists();
    location.hash = '#/playlist/' + res.playlist.id;
  } catch (e) { pr.fail(e.message); }
}

// ---------- Support (Buy Me a Coffee) ----------
const supportPanelInner = () => `<h2>${icon('coffee')} Support BAZINGA!</h2><p class="muted tiny">Free, no ads, made by one person. Tips keep it going.</p>${coffeeButton()}`;
const coffeeButton = (label = 'Buy me a coffee', cls = '') => `<a class="coffee-btn ${cls}" href="${BMC_URL}" target="_blank" rel="noopener">
  <span class="cb-cup"><i></i><i></i><i></i>${icon('coffee')}</span><span class="cb-txt"><b>${label}</b><small>buymeacoffee.com/bazinga.app</small></span><span class="cb-shine"></span></a>`;
async function vSupport() {
  view().innerHTML = `<div class="page support">
    <section class="sup-hero">
      <div class="sup-bg"></div>
      <div class="sup-txt">
        <div class="kicker">Support BAZINGA!</div>
        <h1>Keep the music free ⚡</h1>
        <p>BAZINGA! has no ads, no subscriptions and no tracking — it's built and kept alive by one person. If it makes your day a little louder, a coffee goes a long way.</p>
        ${coffeeButton('Buy me a coffee', 'big')}
        <p class="tiny muted">Payments are handled securely by Buy Me a Coffee. BAZINGA! never sees your card details.</p>
      </div>
      <div class="sup-qr"><div class="qr-card"><img src="icons/bmc-qr.png" alt="QR code for buymeacoffee.com/bazinga.app" width="240" height="240"><span>Scan to tip from your phone</span></div></div>
    </section>
    <section class="p2-sec" aria-label="Phase 2 goal">
      <div class="p2-sec-h"><div><div class="kicker">Phase 2 ⚡</div><h2>Lock-screen listening</h2><p class="muted">The license that lets everyone keep their music and streams playing on the lock screen. Every coffee counts toward it.</p></div>
      <button class="btn primary" data-act="phase2">${icon('coffee')}Support Phase 2</button></div>
      ${p2GoalHTML()}
    </section>
    <div class="sup-grid">
      <div class="panel"><h2>${icon('heart')} What your tip does</h2><p class="muted">Keeps the app free for everyone, pays for testing devices and time spent on new features like the voice assistant and YouTube sync.</p></div>
      <div class="panel"><h2>${icon('share')} Free ways to help</h2><p class="muted">Share a playlist with a friend, follow along, and tell people about BAZINGA!</p>
        <div class="row-btns"><a class="btn" href="https://www.instagram.com/bazinga.app" target="_blank" rel="noopener">${icon('instagram')}@bazinga.app</a><a class="btn" href="https://x.com/bazinga_app" target="_blank" rel="noopener">${icon('xsocial')}@bazinga_app</a></div></div>
    </div>
  </div>`;
}
// ---------- Phase 2 goal: lock-screen listening ----------
// Phase 2 is explained in the Support page and the coffee popup (no live totals — that would need a database).
const p2GoalHTML = () => '';
const animateP2 = () => { };

async function phase2Popup({ love = false } = {}) {
  const st = (await kv.get('phase2')) || {};
  st.lastShown = new Date().toISOString().slice(0, 10); await kv.set('phase2', st);
  // Step 1: a quick "do you love it?" — only people who do are asked for a coffee
  const loveQ = () => `
      <div class="love-ic"><img src="${logoSrc()}" alt=""></div>
      <h3>Do you love BAZINGA!?</h3>
      <p class="muted">Quick question, be honest!</p>
      <div class="love-btns"><button type="button" class="love-no" data-p2="no" aria-label="No, not really">${icon('thumbDown')}</button><button type="button" class="love-yes" data-p2="yes" aria-label="Yes, I love it">${icon('thumbUp')}</button></div>`;
  const yay = () => `
      <div class="p2-confetti" aria-hidden="true">${Array.from({ length: 24 }, (_, i) => `<i style="--x:${(i * 37) % 100}%;--d:${(i % 7) * 90}ms;--r:${(i * 53) % 360}deg;--c:${['var(--volt)', '#fff', 'var(--volt-2)', 'var(--volt)', '#7cf'][i % 5]}"></i>`).join('')}</div>
      <div class="p2-icon glow">${icon('heartFill')}</div>
      <h3>You just made my day! 🥹⚡</h3>
      <p>Hearing you love BAZINGA! honestly means the world. Want to help make it even better? Every coffee turns into new features, faster fixes and more music magic ⚡</p>
      <a class="coffee-btn big p2-support" href="${BMC_URL}" target="_blank" rel="noopener"><span class="cb-cup"><i></i><i></i><i></i>${icon('coffee')}</span><span class="cb-txt"><b>Buy me a coffee</b><small>Make BAZINGA! even better ☕</small></span><span class="cb-shine"></span></a>
      <div class="p2-btns"><button class="btn p2-notnow" data-p2="close">Not now</button><button class="btn ghost p2-never" data-p2="never">Don't show this again</button></div>`;
  const sad = () => `<div class="sad-face" aria-label="Sad face">${icon('sad')}</div>`;
  const ask = () => `
      <div class="kicker">Phase 2 ⚡ Lock-screen listening</div>
      <h3>Help unlock music on your lock screen</h3>
      <p>Right now your phone pauses BAZINGA! when the screen locks or you leave the app. To let everyone enjoy music and streams on the lock screen, BAZINGA! needs a music license — and that's what Phase 2 is for.</p>
      ${p2GoalHTML()}
      <a class="coffee-btn big p2-support" href="${BMC_URL}" target="_blank" rel="noopener"><span class="cb-cup"><i></i><i></i><i></i>${icon('coffee')}</span><span class="cb-txt"><b>Support Phase 2</b><small>Every coffee counts ☕</small></span><span class="cb-shine"></span></a>
      <div class="p2-btns"><button class="btn ghost p2-later" data-p2="later">Not now</button><button class="btn ghost p2-never" data-p2="never">Don't show this again</button></div>`;
  const later = () => `
      <div class="p2-icon">${icon('play')}</div>
      <h3>No worries — enjoy the music 💛</h3>
      <p>Just so you know: until Phase 2, <b>keep BAZINGA! open</b> to keep your music playing. Locking your phone or switching apps will pause it.</p>
      <p class="tiny muted">We'll keep your screen awake while you're in the app${settings.keepAwake === false ? ' (turn it on in Settings → Playback)' : ''}. You can support Phase 2 any time from the ☕ button.</p>
      <button class="btn primary" data-resolve="later">Got it</button>`;
  const waiting = () => `
      <div class="p2-icon spin">${icon('coffee')}</div>
      <h3>Finishing up on Buy Me a Coffee…</h3>
      <p class="muted">Come back here when you're done.</p>
      <button class="btn primary" data-p2="thanks">I'm done ✓</button>
      <button class="btn ghost" data-p2="back">I didn't support this time</button>`;
  const thanks = () => `
      <div class="p2-confetti" aria-hidden="true">${Array.from({ length: 28 }, (_, i) => `<i style="--x:${(i * 37) % 100}%;--d:${(i % 7) * 90}ms;--r:${(i * 53) % 360}deg;--c:${['var(--volt)', '#fff', 'var(--volt-2)', 'var(--volt)', '#7cf'][i % 5]}"></i>`).join('')}</div>
      <div class="p2-icon glow">${icon('heartFill')}</div>
      <h3>Thank you, legend! ⚡</h3>
      <p>You just helped bring BAZINGA! closer to Phase 2 — lock-screen listening for everyone. It means a lot.</p>
      ${p2GoalHTML()}
      <p class="p2-note">${icon('play')}<span>Until we reach the goal, please <b>keep the app open</b> to keep your music playing.</span></p>
      <button class="btn primary" data-resolve="thanks">Back to my music</button>`;
  let body = null, state = 'ask', onBack = null;
  const show = (k, html) => {
    state = k; body.dataset.step = k; body.innerHTML = html;
    body.classList.remove('in'); void body.offsetWidth; body.classList.add('in');
  };
  const r = await modal(`<div class="p2"><div class="p2-bg" aria-hidden="true"><i></i><i></i><i></i></div><div class="p2-body"></div></div>`, {
    onMount: (m, close) => {
      m.classList.add('p2-modal');
      body = m.querySelector('.p2-body'); if (love) show('love', loveQ()); else show('yay', yay());
      m.addEventListener('click', e => {
        if (e.target.closest('.p2-support')) {
          st.supportClickedAt = Date.now(); kv.set('phase2', st);
          setTimeout(() => show('wait', waiting()), 300);
          // When you come back from Buy Me a Coffee: thank you (and fetch the new total)
          onBack = () => { if (document.visibilityState === 'visible' && state === 'wait') thank(); };
          document.addEventListener('visibilitychange', onBack); window.addEventListener('focus', onBack);
          return;
        }
        const b = e.target.closest('[data-p2]'); if (!b) return;
        if (b.dataset.p2 === 'yes') { st.lovedAt = Date.now(); kv.set('phase2', st); show('yay', yay()); }
        if (b.dataset.p2 === 'no') { st.notLovedAt = Date.now(); kv.set('phase2', st); m.classList.add('sad'); show('sad', sad()); setTimeout(() => close(null), 1700); }
        if (b.dataset.p2 === 'close') close(null);
        if (b.dataset.p2 === 'later') show('later', later());
        if (b.dataset.p2 === 'never') { st.never = true; kv.set('phase2', st); toast('Got it — you won\'t see this again. The ☕ button is always in the top bar.'); m.closest('.modal-wrap')?.querySelector('[data-close]')?.click(); }
        if (b.dataset.p2 === 'thanks') thank();
        if (b.dataset.p2 === 'back') show('later', later());
      });
    }
  });
  async function thank() {
    if (state === 'thanks') return;
    st.supportedAt = Date.now(); kv.set('phase2', st);
    show('thanks', thanks());
  }
  if (onBack) { document.removeEventListener('visibilitychange', onBack); window.removeEventListener('focus', onBack); }
  if (state === 'later') { st.declinedAt = Date.now(); kv.set('phase2', st); }
}
// ================= SHARING =================
async function shareTracks(kind, name, tracks, artwork) {
  const t = [];
  for (const x of tracks.slice(0, 400)) {
    const c = await db.get('ytcache', x.id) || {};
    t.push([x.title, x.artist, x.album || '', x.year || yearOf(x.releaseDate) || 0, x.genre || '', x.durationMs || 0, (x.artwork || '').startsWith('data:') ? '' : x.artwork || '', c.video || '', c.audio || '']);
  }
  const packed = await packToString({ k: kind, n: name, by: profile.username, a: (artwork || '').startsWith('data:') ? '' : artwork, t });
  const url = location.href.split('#')[0] + '#/s/' + packed;
  modal(`<h3>Share "${esc(name)}"</h3><p class="muted tiny">Anyone with this link can open, play and save it in their own BAZINGA! app. The whole ${kind} is packed inside the link — nothing is uploaded anywhere.</p>
    <div class="copy-box"><input readonly value="${esc(url)}" aria-label="Share link"></div>
    <button class="btn primary big" data-act="copy" data-v="${esc(url)}">${icon('link')}Copy link</button>`);
}

// Copy that also works where the Clipboard API isn't available (e.g. opened from a file)
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch { }
  const ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { }
  ta.remove(); return ok;
}

// ================= TRACK MENU =================
async function trackMenu(btn, id, plId) {
  const t = lib.tracks.get(id); if (!t) return;
  const c = await db.get('ytcache', id) || {};
  const pls = [...lib.playlists.values()];
  const k = await menu(btn, [
    { header: `<b>${esc(displayTitle(t))}</b><small>${esc(t.artist)}</small>` },
    { k: 'next', label: 'Play next', icon: 'play' },
    { k: 'queue', label: 'Add to queue', icon: 'queue' },
    { k: 'addpl', label: 'Add to playlist…', icon: 'plus' },
    { k: 'like', label: t.liked ? 'Remove from Liked' : 'Add to Liked Songs', icon: 'heart' },
    '-',
    t.album || t.itunesAlbumId ? { k: 'album', label: 'Go to album', icon: 'disc' } : null,
    t.album || t.itunesAlbumId ? { k: 'savealbum', label: 'Save full album', icon: 'plus' } : null,
    { k: 'artist', label: 'Go to artist', icon: 'mic' },
    { k: 'share', label: 'Share song', icon: 'share' },
    '-',
    { k: 'ytv', label: c.video ? 'Change music video link' : 'Set music video link', icon: 'video' },
    { k: 'yta', label: c.audio ? 'Change audio link' : 'Set audio link', icon: 'audio' },
    c.video || c.audio ? { k: 'ytopen', label: 'Open on YouTube', icon: 'yt' } : null,
    { k: 'file', label: t.localFileId ? 'Replace offline file' : 'Attach offline file', icon: 'offline' },
    t.localFileId ? { k: 'unfile', label: 'Remove offline file', icon: 'cloudOff' } : null,
    '-',
    plId ? { k: 'unpl', label: 'Remove from this playlist', icon: 'trash', danger: true } : null,
    !t.transient ? { k: 'del', label: 'Remove from library', icon: 'trash', danger: true } : null
  ]);
  if (!k) return;
  if (k === 'next' || k === 'queue') player.addToQueue(id, k === 'next');
  if (k === 'addpl') addToPlaylistDialog([id]);
  if (k === 'like') likeClick(id);
  if (k === 'album') gotoAlbum(t);
  if (k === 'savealbum') saveAlbumOf(t);
  if (k === 'artist') location.hash = '#/artist/' + encodeURIComponent(mainArtist(t.artist));
  if (k === 'share') shareTracks('song', `${t.title} — ${t.artist}`, [t], t.artwork);
  if (k === 'ytv' || k === 'yta') setYTLink(t, k === 'ytv' ? 'video' : 'audio', c);
  if (k === 'ytopen') window.open('https://www.youtube.com/watch?v=' + (c[P.mode] || c.video || c.audio), '_blank', 'noopener');
  if (k === 'file') pickFile('audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav', f => attachFile(t, f));
  if (k === 'unfile') { await db.del('files', t.localFileId); await store.updateTrack(id, { localFileId: null }); toast('Offline file removed'); }
  if (k === 'unpl') { const r = await store.removeFromPlaylist(plId, id); toastUndo('Removed from playlist', async () => { await store.undoRemoveFromPlaylist(r); toast('Put back ✓'); }); }
  if (k === 'del' && await confirmBox('Remove from library?', `"${esc(t.title)}" will be removed from your library and all playlists.`, 'Remove', true)) { await store.deleteTrack(id); toast('Removed'); }
}

async function attachFile(t, f) {
  if (t.transient) await store.upsertTracks([t]);
  const fileId = 'f_' + t.id;
  await db.put('files', { id: fileId, blob: f, name: f.name, type: f.type, size: f.size, addedAt: Date.now() });
  await store.updateTrack(t.id, { localFileId: fileId });
  toast('Available offline ✓');
}

async function setYTLink(t, mode, c) {
  const r = await modal(`<h3>${mode === 'video' ? 'Music video' : 'Audio'} for "${esc(t.title)}"</h3>
    ${c[mode] ? `<p class="muted tiny">Current: ${esc(c[mode + 'Title'] || c[mode])}</p>` : ''}
    <form><label class="fld"><span>Paste a YouTube link</span><input name="u" placeholder="https://youtube.com/watch?v=…" required></label>
    <div class="modal-actions"><a class="btn ghost" target="_blank" rel="noopener" href="https://www.youtube.com/results?search_query=${encodeURIComponent(t.artist + ' ' + t.title + (mode === 'audio' ? ' audio' : ' official video'))}">${icon('search')}Search YouTube</a><button class="btn primary">Save</button></div></form>
    <button class="btn ghost block" data-resolve="research">${icon('restore')}Search again automatically</button>`);
  if (!r) return;
  if (r === 'research') {
    try { await yt.findForTrack(t, { force: true }); toast('Updated'); } catch (e) { toast(e.message, 'err'); }
  } else {
    const vid = yt.parseYouTubeId(r.u);
    if (!vid) return toast('That doesn\'t look like a YouTube link', 'err');
    await yt.setManual(t.id, mode, vid);
    toast('Saved ✓');
  }
  emit('dirty', 'yt');
  if (player.current()?.id === t.id && P.mode === mode) player.reloadCurrent();
}

async function addToPlaylistDialog(ids) {
  const pls = [...lib.playlists.values()].sort((a, b) => a.name.localeCompare(b.name));
  const r = await modal(`<h3>Add to playlist</h3><div class="pick-list">
    <button class="pick" data-resolve="__new">${'<div class="cover sm noimg"><span>+</span></div>'}<span><b>New playlist</b></span></button>
    ${pls.map(p => `<button class="pick" data-resolve="${p.id}">${cover(plCover(p), p.name, 'sm')}<span><b>${esc(p.name)}</b><small>${p.trackIds.length} songs</small></span></button>`).join('')}</div>`);
  if (!r) return;
  for (const id of ids) { const t = lib.tracks.get(id); if (t?.transient) await store.upsertTracks([t]); }
  if (r === '__new') {
    const name = await promptText('New playlist', '', 'Name', 'Create'); if (!name) return;
    await store.createPlaylist(name, ids); toast(`Added to "${name}"`);
  } else { const n = await store.addToPlaylist(r, ids); toast(n ? `Added to "${lib.playlists.get(r).name}"` : 'Already in that playlist'); }
  renderSidebarPlaylists();
}

async function resolveAlbum(t) {
  if (t.itunesAlbumId) return { href: `#/album/it/${t.itunesAlbumId}`, itunesAlbumId: t.itunesAlbumId };
  if (t.albumId && lib.albums.has(t.albumId)) return { href: `#/album/${encodeURIComponent(t.albumId)}` };
  if (!t.album) return null;
  const a = await meta.findAlbum(t.artist, t.album).catch(() => null);
  if (a) { store.updateTrack(t.id, { itunesAlbumId: a.itunesAlbumId }); return { href: `#/album/it/${a.itunesAlbumId}`, itunesAlbumId: a.itunesAlbumId }; }
  return { href: `#/album/${encodeURIComponent(t.albumId || albumKey(t.artist, t.album))}` };
}
async function gotoAlbum(t) {
  const r = await resolveAlbum(t);
  if (r) location.hash = r.href; else toast('Album not found', 'err');
}
async function saveAlbumOf(t) {
  const r = await resolveAlbum(t);
  if (!r?.itunesAlbumId) return toast('Couldn\'t find the full album', 'err');
  const { album, tracks } = await meta.albumTracks(r.itunesAlbumId);
  if (!album) return toast('Couldn\'t load that album', 'err');
  await store.saveAlbum(album, tracks.map(x => lib.tracks.get(x.id) ? { ...x, ...stripTransient(lib.tracks.get(x.id)) } : x));
  toast(`Saved album "${album.title}" (${tracks.length} songs)`);
}
const stripTransient = t => { const x = { ...t }; delete x.transient; return x; };

async function playlistMenu(btn, id) {
  const p = lib.playlists.get(id); if (!p) return;
  // One ⋯ for everything: on phones the YouTube buttons live in here too (on computers they're on the page)
  const narrow = innerWidth <= 700;
  const k = await menu(btn, [
    narrow ? { k: 'yt-match', label: 'Find YouTube matches', icon: 'yt' } : null,
    narrow ? { k: 'yt-save', label: 'Save to YouTube', icon: 'upload' } : null,
    narrow ? '-' : null,
    { k: 'rename', label: 'Rename', icon: 'edit' },
    { k: 'cover', label: 'Change cover', icon: 'file' },
    { k: 'dup', label: 'Duplicate', icon: 'plus' },
    { k: 'csv', label: 'Export as CSV', icon: 'import' },
    p.spotifyId ? { k: 'resync', label: 'Re-sync from Spotify', icon: 'restore' } : null,
    '-', { k: 'del', label: 'Delete playlist', icon: 'trash', danger: true }
  ]);
  if (k === 'yt-match') matchList(lists.get('pl') || p.trackIds);
  if (k === 'yt-save') ytExport(lists.get('pl') || p.trackIds, p.name, p.id);
  if (k === 'rename') { const n = await promptText('Rename playlist', p.name); if (n) { p.name = n; await store.savePlaylist(p); renderSidebarPlaylists(); } }
  if (k === 'cover') pickFile('image/*', async f => { p.image = await imageToDataURL(f, 400); await store.savePlaylist(p); });
  if (k === 'dup') { const np = await store.createPlaylist(p.name + ' (copy)', p.trackIds); renderSidebarPlaylists(); location.hash = '#/playlist/' + np.id; }
  if (k === 'csv') {
    const rows = [['Track Name', 'Artist Name(s)', 'Album Name', 'Release Date', 'Genres', 'Duration (ms)']];
    for (const tid of p.trackIds) { const t = lib.tracks.get(tid); if (t) rows.push([t.title, t.artist, t.album || '', t.releaseDate || t.year || '', t.genre || '', t.durationMs || '']); }
    downloadBlob(new Blob([rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' }), p.name + '.csv');
  }
  if (k === 'resync') {
    const pr = progress(`Syncing "${p.name}"…`);
    try { const tr = await sp.playlistTracks(p.spotifyId, (n, t) => pr.set(n, t)); const s = await store.upsertTracks(tr); p.trackIds = s.map(t => t.id); await store.savePlaylist(p); pr.done('Synced ✓'); }
    catch (e) { pr.fail(e.message); }
  }
  if (k === 'del' && await confirmBox('Delete playlist?', `"${esc(p.name)}" will be deleted. Songs stay in your library if they're liked or in other playlists/albums.`, 'Delete', true)) {
    await store.deletePlaylist(id); renderSidebarPlaylists(); location.hash = '#/library/playlists';
  }
}

// ================= LIKES =================
// The heart flips the moment you tap it (no page reload). On the Liked Songs page an un-liked song
// stays put for a few seconds (dimmed) so you can tap the heart again to keep it.
const LIKE_GRACE = 6000;
const likeTimers = new Map();
function setHeart(b, on) {
  if (!b) return;
  b.classList.toggle('on', on);
  b.innerHTML = icon(on ? 'heartFill' : 'heart');
  b.setAttribute('aria-pressed', on);
  b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
}
function likeClick(id, btn) {
  const t = lib.tracks.get(id); if (!t) return;
  const on = !(t.liked && !t.transient);
  if (btn) setHeart(btn, on);
  store.setLiked(id, on).catch(e => toast(e.message, 'err'));
  if (on) toast('Added to Liked Songs');
  else toastUndo('Removed from Liked Songs', () => store.setLiked(id, true));
}
function markUnliked() {
  for (const id of likeTimers.keys()) $$(`[data-tsec="liked"] .row[data-id="${CSS.escape(id)}"]`).forEach(r => r.classList.add('unliked'));
}
function onLikeChanged({ id, liked }) {
  const sel = CSS.escape(id);
  $$(`.like[data-id="${sel}"]`).forEach(b => { if (b.classList.contains('on') !== liked) setHeart(b, liked); });
  if (player.current()?.id === id) $$('#playerbar .like, #np .np-info .like').forEach(b => { if (b.classList.contains('on') !== liked) setHeart(b, liked); });
  const sec = sections.get('liked');
  if (sec) {
    clearTimeout(likeTimers.get(id)); likeTimers.delete(id);
    $$(`[data-tsec="liked"] .row[data-id="${sel}"]`).forEach(r => r.classList.toggle('unliked', !liked));
    if (!liked) likeTimers.set(id, setTimeout(() => {
      likeTimers.delete(id);
      if (lib.tracks.get(id)?.liked || sections.get('liked') !== sec) return;
      $$(`[data-tsec="liked"] .row[data-id="${sel}"]`).forEach(r => r.classList.add('leaving'));
      setTimeout(() => { if (sections.get('liked') !== sec) return; sec.tracks = sec.tracks.filter(t => t.id !== id); refreshSection('liked'); markUnliked(); likedCount(); }, 280);
    }, LIKE_GRACE));
    else if (!sec.tracks.some(t => t.id === id) && lib.tracks.get(id)) { sec.tracks = [lib.tracks.get(id), ...sec.tracks]; refreshSection('liked'); markUnliked(); }
  }
  likedCount();
}
function likedCount() {
  const n = store.saved().filter(t => t.liked).length;
  const el = $('.tab[data-tab="liked"] small'); if (el) el.textContent = n;
}

// ================= GLOBAL EVENTS =================
function pickFile(accept, cb, { multiple = false, dir = false } = {}) {
  const i = document.createElement('input');
  i.type = 'file'; i.accept = accept; i.multiple = multiple;
  if (dir) i.webkitdirectory = true;
  i.onchange = () => { const fs = [...i.files]; if (fs.length) cb(multiple || dir ? fs : fs[0]); };
  i.click();
}

function idsForPlayAct(el) {
  const key = el.dataset.id;
  if (lists.has(key)) return lists.get(key);
  return [];
}

function wireGlobal() {
  document.addEventListener('click', async e => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const act = a.dataset.act, id = a.dataset.id;
    switch (act) {
      case 'play-row': {
        if (e.target.closest('a')) return; // artist/album links
        if (a.dataset.list === 'pl') notePlaylistPlay(location.hash.split('/')[2]);
        const ids = lists.get(a.dataset.list) || [a.dataset.id];
        const i = +a.dataset.i;
        if (player.current()?.id === a.dataset.id && nowCtx.list === a.dataset.list && nowCtx.i === i) { player.toggle(); return; }
        nowCtx = { list: a.dataset.list, i, id: a.dataset.id };
        player.playList(ids, Math.min(i, ids.length - 1), { shuffle: false });
        break;
      }
      case 'like': e.stopPropagation(); likeClick(id, a); break;
      case 'track-menu': e.stopPropagation(); trackMenu(a, id, a.dataset.pl); break;
      case 'goto-album': e.preventDefault(); e.stopPropagation(); gotoAlbum(lib.tracks.get(id)); break;
      case 'play-list': {
        const ids = lists.get(id) || [];
        if (a.dataset.queue) player.addToQueue(ids);
        else if (a.dataset.shuffle) { nowCtx = { list: null }; player.playList(ids, a.dataset.shuffle ? Math.floor(Math.random() * ids.length) : 0, { shuffle: !!a.dataset.shuffle }); }
        else { nowCtx = { list: id, i: 0, id: ids[0] }; player.playList(ids, 0, { shuffle: false }); }
        if (id === 'pl') notePlaylistPlay(location.hash.split('/')[2]);
        break;
      }
      case 'play-playlist': e.preventDefault(); e.stopPropagation(); notePlaylistPlay(id); player.playList(lib.playlists.get(id)?.trackIds || [], 0, { shuffle: false }); break;
      case 'play-album': {
        e.preventDefault(); e.stopPropagation();
        const al = lib.albums.get(id) || store.implicitAlbums().find(x => x.id === id);
        player.playList(al?.trackIds || [], 0, { shuffle: false }); break;
      }
      case 'play-artist': {
        e.preventDefault(); e.stopPropagation();
        const n = norm(a.dataset.name);
        player.playList(store.saved().filter(t => (t.artists?.length ? t.artists : [t.artist]).some(x => norm(x) === n) || norm(mainArtist(t.artist)) === n).map(t => t.id), 0, { shuffle: true }); break;
      }
      case 'toggle-filters': { const key = a.closest('[data-tsec]').dataset.tsec; fstate[key].open = !fstate[key].open; if (fstate[key].open) fstate[key].sortOpen = false; refreshSection(key); break; }
      case 'toggle-sort': { const key = a.closest('[data-tsec]').dataset.tsec; fstate[key].sortOpen = !fstate[key].sortOpen; if (fstate[key].sortOpen) fstate[key].open = false; refreshSection(key); break; }
      case 'f-sort': { const key = a.closest('[data-tsec]').dataset.tsec; fstate[key].sort = a.dataset.v; fstate[key].sortOpen = false; refreshSection(key); break; }
      case 'f-genre': { const key = a.closest('[data-tsec]').dataset.tsec; const f = fstate[key]; const g = a.dataset.g; f.genres = f.genres?.includes(g) ? f.genres.filter(x => x !== g) : [...(f.genres || []), g]; refreshSection(key); break; }
      case 'f-year': { const key = a.closest('[data-tsec]').dataset.tsec; const f = fstate[key]; const y = +a.dataset.y; f.years = f.years?.includes(y) ? f.years.filter(x => x !== y) : [...(f.years || []), y]; refreshSection(key); break; }
      case 'f-flag': { const key = a.closest('[data-tsec]').dataset.tsec; fstate[key][a.dataset.k] = !fstate[key][a.dataset.k]; refreshSection(key); break; }
      case 'f-clear': { const key = a.closest('[data-tsec]').dataset.tsec; Object.assign(fstate[key], { genres: [], years: [], liked: false, offline: false, q: '' }); refreshSection(key); break; }
      case 'new-playlist': { const n = await promptText('New playlist', '', 'Name', 'Create'); if (n) { const p = await store.createPlaylist(n); renderSidebarPlaylists(); location.hash = '#/playlist/' + p.id; } break; }
      case 'playlist-menu': playlistMenu(a, id); break;
      case 'share-playlist': { const p = lib.playlists.get(id); shareTracks('playlist', p.name, p.trackIds.map(x => lib.tracks.get(x)).filter(Boolean), plCover(p)); break; }
      case 'share-album': { const { album, tracks } = window.__album; shareTracks('album', `${album.title} — ${album.artist}`, tracks, album.artwork); break; }
      case 'save-album': { const { album, tracks } = window.__album; await store.saveAlbum(album, tracks.map(stripTransient)); toast(`Album saved to your library`); break; }
      case 'unsave-album': if (await confirmBox('Remove album?', 'The album will be removed from your library. Liked songs and songs in playlists stay.', 'Remove', true)) { await store.removeAlbum(id); toast('Album removed'); } break;
      case 'album-offline': { const { tracks } = window.__album; pickFile('audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav', fs => addLocalFiles(fs, { albumHint: tracks }), { multiple: true }); break; }
      case 'save-shared': {
        const { d, tracks } = window.__shared;
        const saved = await store.upsertTracks(tracks.map(stripTransient));
        if (d.k === 'song') { await store.updateTrack(saved[0].id, { liked: true }); toast('Added to Liked Songs'); }
        else { const p = await store.createPlaylist(d.n, saved.map(t => t.id), { source: 'shared by ' + (d.by || 'friend'), image: d.a || '' }); renderSidebarPlaylists(); location.hash = '#/playlist/' + p.id; }
        break;
      }
      case 'match-list': matchList(lists.get(a.dataset.list) || []); break;
      case 'yt-export': ytExport(lists.get(a.dataset.list) || [], a.dataset.name, a.dataset.job); break;
      case 'yt-signin': try { await ya.signIn({ prompt: 'select_account' }); toast('YouTube connected ✓', 'ok'); rerender(); } catch (err) { toast(err.message, 'err'); } break;
      case 'yt-signout': await ya.signOut(); toast('Disconnected from YouTube'); rerender(); break;
      case 'yt-import-mine': ytImportMine(); break;
      case 'yt-resume': resumeUpload(a.dataset.job); break;
      case 'yt-drop': await ya.dropJob(a.dataset.job); rerender(); break;
      case 'support': e.preventDefault(); phase2Popup(); break;
      case 'phase2': e.preventDefault(); phase2Popup(); break;
      case 'exportify': openExportify(); break;
      case 'sp-liked': spImportLiked(); break;
      case 'sp-playlists': spChoosePlaylists(); break;
      case 'sp-disconnect': await sp.disconnect(); route(); break;
      case 'add-files': pickFile('audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav', fs => addLocalFiles(fs), { multiple: true }); break;
      case 'add-folder': pickFile('', fs => addLocalFiles(fs), { dir: true }); break;
      case 'go-back': goBack(); break;
      case 'voice': e.preventDefault(); openVoice(); break;
      case 'bz-mix': e.preventDefault(); bazingaMix(); break;
      case 'play-it-album': {
        e.preventDefault(); e.stopPropagation();
        try { const { tracks } = await meta.albumTracks(id); player.playList(tracks.map(t => (lib.tracks.get(t.id) || store.remember(t)).id), 0, { shuffle: false }); }
        catch { toast('Couldn\'t load that album right now', 'err'); }
        break;
      }
      case 'copy': copyText(a.dataset.v).then(ok => {
        toast(ok ? 'Link copied ✓' : 'Couldn\'t copy — select the link and copy it', ok ? 'ok' : 'err');
        if (ok && a.classList.contains('big')) { a.innerHTML = `${icon('check')}Copied!`; setTimeout(() => { if (a.isConnected) a.innerHTML = `${icon('link')}Copy link`; }, 2000); }
      }); break;
      case 'az': {
        e.preventDefault();
        // The letters always work alphabetically: switch the list to A–Z, then jump
        if (artistUI.sort !== 'az' || artistUI.q) { artistUI.sort = 'az'; artistUI.q = ''; const qi = $('#art-q'); if (qi) qi.value = ''; }
        { // make sure that letter is loaded (lists show 100 at a time)
          const sorted = store.artists().sort((x, y) => x.name.localeCompare(y.name));
          const idx = sorted.findIndex(x => letterOf(x.name) === a.dataset.l);
          artistUI.limit = Math.max(PAGE_N, idx + PAGE_N);
          redrawArtists();
        }
        $$('.az a').forEach(x => x.classList.toggle('on', x === a));
        $(`#artist-list [data-letter="${a.dataset.l}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }
      case 'retry-route': route(); break;
      case 'filter-go': { const i = a.closest('.fsearch')?.querySelector('input'); if (i) { if (!i.value) i.focus(); else { i.blur(); const key = a.closest('[data-tsec]')?.dataset.tsec; if (key) { fstate[key].q = i.value; refreshSection(key); } } } break; }
      case 'a2hs': maybeInstallPrompt(true); break;
      case 'art-more': artistUI.limit += PAGE_N; redrawArtists(); break;
      case 'show-more': showMore(a.dataset.pg); break;
      case 'art-sort': artistUI.sort = a.dataset.v; artistUI.limit = PAGE_N; redrawArtists(); $$('.az a').forEach(x => x.classList.remove('on')); break;
      case 'yt-backup': ytBackupPicker(); break;
      case 'yt-more': {
        const wide = innerWidth > 700; // on computers the YouTube buttons are already on the page
        const k = await menu(a, [a.dataset.offline ? { k: 'offline', label: a.dataset.offline, icon: 'offline' } : null, wide ? null : { k: 'match', label: 'Find YouTube matches', icon: 'yt' }, wide ? null : { k: 'save', label: 'Save to YouTube', icon: 'upload' }]);
        if (k === 'offline') { const { tracks } = window.__album; pickFile('audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav', fs => addLocalFiles(fs, { albumHint: tracks }), { multiple: true }); }
        if (k === 'match') matchList(lists.get(a.dataset.list) || []);
        if (k === 'save') ytExport(lists.get(a.dataset.list) || [], a.dataset.name, a.dataset.job);
        break;
      }
      case 'rename-user': { const n = await promptText('Change your name', profile.username, 'Name'); if (n) { profile.username = n; await profileChanged(); rerender(); } break; }
      case 'remove-pic': profile.picture = ''; await profileChanged(); rerender(); break;
      case 'lock': setLocked(true); break;
      case 'link-device': linkDeviceDialog(); break;
      case 'enter-code': { const req = await enterCodeDialog(); if (req) joinFlow(req); break; }
      case 'sync-leave': syncMenu('leave'); break;
      case 'sync-forget': syncMenu('forget'); break;
      case 'sync-now': withSyncProgress('Syncing your music', () => sync.syncNow({ interactive: true })).then(() => { const S = sync.state(); toast(S.cancelled ? 'Sync cancelled' : S.status === 'synced' ? 'Synced ✓' : S.error || 'Sync failed', S.cancelled ? 'info' : S.status === 'synced' ? 'ok' : 'err'); }); break;
      case 'bk-link': try { await backup.linkFile(); rerender(); } catch (err) { if (err.name !== 'AbortError') toast(err.message, 'err'); } break;
      case 'bk-regrant': await backup.regrant(); rerender(); renderBackupNag(); break;
      case 'bk-unlink': await backup.unlinkFile(); rerender(); break;
      case 'bk-download': await backup.download(); toast('Backup downloaded ✓'); renderBackupNag(); break;
      case 'bk-restore-file': pickFile('.json,application/json', async f => {
        if (!await confirmBox('Restore this backup?', 'Your current library will be replaced with the one in the backup file.', 'Restore')) return;
        try { await backup.restoreFromFile(f); toast('Restored ✓'); setTimeout(() => location.reload(), 600); } catch (err) { toast(err.message, 'err'); }
      }); break;
      case 'bk-restore-snap': if (await confirmBox('Restore snapshot?', 'Your current library will be replaced with this snapshot.', 'Restore')) { await backup.restoreInternal(id); location.reload(); } break;
      case 'clear-ytcache': if (await confirmBox('Forget YouTube matches?', 'Songs will be searched again next time they play.', 'Forget', true)) { await db.clear('ytcache'); yt.forget(); toast('Done'); } break;
      case 'delete-account': deleteAccount(); break;
      case 'bk-nag-dl': await backup.download(); renderBackupNag(); break;
      case 'bk-nag-x': await kv.set('lastDownload', Date.now()); renderBackupNag(); break;
    }
  });
  // Faster song switching: look a song up as soon as you rest on it / touch it
  let hoverT = null;
  document.addEventListener('pointerover', e => {
    const r = e.target.closest?.('.row[data-id], .qrow [data-qjump]'); if (!r) return;
    clearTimeout(hoverT);
    const id = r.dataset.id || P.queue[+r.dataset.qjump]?.id;
    if (id) hoverT = setTimeout(() => player.prefetch(id), e.pointerType === 'mouse' ? 220 : 0);
  }, { passive: true });
  document.addEventListener('pointerout', e => { if (e.target.closest?.('.row')) clearTimeout(hoverT); }, { passive: true });
  // Keyboard: Enter on a row plays it; space toggles playback
  document.addEventListener('keydown', e => {
    if (e.target.matches('input,textarea,select')) return;
    if (e.key === 'Enter' && e.target.matches('.row')) e.target.click();
    if (e.code === 'Space' && !e.target.matches('button,a,.row')) { e.preventDefault(); player.toggle(); }
  });
  // Filter inputs
  document.addEventListener('input', e => {
    const f = e.target.dataset.f; if (!f) return;
    const key = e.target.closest('[data-tsec]')?.dataset.tsec; if (!key) return;
    fstate[key][f] = e.target.value;
    if (f === 'q' || f === 'from' || f === 'to') debouncedRefresh(key);
    else refreshSection(key);
  });
  document.addEventListener('change', e => {
    if (e.target.dataset.f === 'sort') { const key = e.target.closest('[data-tsec]').dataset.tsec; fstate[key].sort = e.target.value; refreshSection(key); }
  });
  // Drag & drop CSV/audio anywhere
  document.addEventListener('dragover', e => { if (profile) e.preventDefault(); });
  document.addEventListener('drop', e => {
    if (!profile) return; e.preventDefault();
    const fs = [...e.dataTransfer.files];
    const csv = fs.filter(f => /\.(csv|zip)$/i.test(f.name)), aud = fs.filter(f => imp.AUDIO_EXT.test(f.name));
    const apple = fs.filter(f => /\.(xml|txt)$/i.test(f.name));
    if (csv.length) importCSVFiles(csv);
    if (apple.length) importAppleFiles(apple);
    if (aud.length) addLocalFiles(aud);
  });

  on('library', () => { renderSidebarPlaylists(); if (!document.querySelector('.modal-wrap') && !isTyping()) softRefresh(); });
  on('player', renderPlayer);
  on('like', onLikeChanged);
  on('needs-tap', () => { openNP(); requestAnimationFrame(placeDock); });
  on('track-art', ({ id, artwork }) => {
    $$(`.row[data-id="${CSS.escape(id)}"] .row-num .cover`).forEach(c => { c.outerHTML = cover(artwork, lib.tracks.get(id)?.title, 'sm'); });
    markNow();
    if (player.current()?.id === id) { renderPlayer(); if (document.body.classList.contains('np-open')) renderNP(true); }
  });
  on('time', renderTime);
  on('video-visible', v => document.body.classList.toggle('has-video', v));
  on('backup-state', renderBackupNag);
  window.addEventListener('online', () => document.body.classList.remove('is-offline'));
  window.addEventListener('offline', () => document.body.classList.add('is-offline'));
  if (!navigator.onLine) document.body.classList.add('is-offline');
  // Re-place the video on any size change (window, phone rotation, browser bars)
  const schedulePlace = () => requestAnimationFrame(() => requestAnimationFrame(placeDock));
  window.addEventListener('resize', schedulePlace);
  window.visualViewport?.addEventListener('resize', schedulePlace);
  if ('ResizeObserver' in window) new ResizeObserver(schedulePlace).observe($('#np'));
  // Yellow fill on every slider as it moves
  document.addEventListener('input', e => { const r = e.target; if (r.type === 'range') r.style.setProperty('--p', (100 * (r.value - (r.min || 0)) / ((r.max || 100) - (r.min || 0))).toFixed(2) + '%'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.classList.contains('np-open') && !$('.modal-wrap')) closeNP(); });
  wirePlayerUI();
}
const debouncedRefresh = debounce(k => refreshSection(k, true), 200);
const isTyping = () => document.activeElement?.matches('input,textarea');
// Lighter refresh: only re-render sections in place when possible
function softRefresh() {
  const h = location.hash;
  if (/^#\/(search|import|settings|s\/)/.test(h)) return;
  rerender();
}

async function deleteAccount() {
  const ok = await modal(`<h3>Erase this device?</h3>
    <p class="muted">This permanently erases everything BAZINGA! saved in this browser: library, playlists, albums, offline files and on-device backups.${sync.linked() ? ' Your other synced devices keep their music.' : ''} This can't be undone.</p>
    <form><label class="fld"><span>Type ERASE to confirm</span><input name="u" required autocomplete="off" autocapitalize="characters"></label>
    <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn danger">Erase everything</button></div></form>`);
  if (!ok) return;
  if (ok.u.trim().toUpperCase() !== 'ERASE') return toast('Nothing was erased — type ERASE to confirm', 'err');
  await sync.leave();
  await wipeDevice();
}

// ================= SIDEBAR / PROFILE =================
function renderProfileChip() {
  const S = sync.state();
  const dot = sync.linked() ? `<i class="sync-dot ${S.status}" title="${S.status === 'synced' ? 'Synced' : S.status === 'syncing' ? 'Syncing…' : S.status === 'error' ? 'Sync problem' : 'Synced device'}"></i>` : '';
  const html = `<div class="avatar">${profile.picture ? `<img src="${esc(profile.picture)}" alt="" referrerpolicy="no-referrer">` : esc(profile.username[0].toUpperCase())}${dot}</div><span>${esc(profile.username)}</span>`;
  $$('.profile-chip').forEach(el => el.innerHTML = html);
}
function renderSidebarPlaylists() {
  const el = $('#side-pl'); if (!el) return;
  const pls = [...lib.playlists.values()].sort((a, b) => a.name.localeCompare(b.name));
  el.innerHTML = `<a href="#/library/liked" class="spl">${likedCover('sm')}<span>Liked Songs</span></a>` +
    pls.map(p => `<a href="#/playlist/${p.id}" class="spl">${cover(plCover(p), p.name, 'sm')}<span>${esc(p.name)}</span></a>`).join('');
}
async function renderBackupNag() {
  const el = $('#nag'); if (!el || !profile) return;
  const st = backup.linkedFileState();
  const lastD = await kv.get('lastDownload');
  const n = store.saved().length;
  if (st === 'needs-permission') el.innerHTML = `<div class="nag">${icon('restore')}<span>Auto-backup to your file is paused.</span><button class="btn sm primary" data-act="bk-regrant">Resume</button></div>`;
  else if (!backup.fsSupported && n > 20 && (!lastD || Date.now() - lastD > 7 * 864e5)) el.innerHTML = `<div class="nag">${icon('restore')}<span>Keep your library safe — save a backup file to this device.</span><button class="btn sm primary" data-act="bk-nag-dl">Save backup</button><button class="ib sm nag-x" data-act="bk-nag-x" aria-label="Dismiss">${icon('close')}</button></div>`;
  else el.innerHTML = '';
}

// ================= PLAYER UI =================
function wirePlayerUI() {
  const bar = $('#playerbar'), np = $('#np');
  const handle = e => {
    const b = e.target.closest('[data-p]'); if (!b) return;
    const k = b.dataset.p;
    if (k === 'toggle') player.toggle();
    if (k === 'next') player.next();
    if (k === 'prev') player.prev();
    if (k === 'shuffle') player.setShuffle(!P.shuffle);
    if (k === 'repeat') player.cycleRepeat();
    if (k === 'mode') player.setMode(b.dataset.m);
    if (k === 'like') { const t = player.current(); if (t) likeClick(t.id, b); }
    if (k === 'queue') toggleQueue();
    if (k === 'npq') toggleNPQueue();
    if (k === 'lyrics') setLyrics(!document.body.classList.contains('np-lyr'));
    if (k === 'dock-min') { document.body.classList.toggle('dock-min'); dockMinLabel(); try { localStorage.setItem('bz_dock_min', document.body.classList.contains('dock-min') ? '1' : ''); } catch { } placeDock(); }
    if (k === 'open') openNP();
    if (k === 'close') closeNP();
    if (k === 'more') { const t = player.current(); if (t) trackMenu(b, t.id); }
    if (k === 'sleep') sleepMenu(b);
    if (k === 'mute') player.setVolume(P.volume > 0 ? 0 : 0.8);
    if (k === 'artist') { const t = player.current(); if (t) { closeNP('nav'); location.hash = '#/artist/' + encodeURIComponent(mainArtist(t.artist)); } }
    if (k === 'album') { const t = player.current(); if (t) { closeNP('nav'); gotoAlbum(t); } }
    if (k === 'dock-size') { document.body.classList.toggle('dock-big'); dockSizeLabel(); try { localStorage.setItem('bz_dock_big', document.body.classList.contains('dock-big') ? '1' : ''); } catch { } placeDock(); }
  };
  const head = $('#np-head');
  bar.addEventListener('click', handle); np.addEventListener('click', handle); head.addEventListener('click', handle);
  $('#yt-dock').addEventListener('click', handle);
  for (const r of $$('.seek')) wireSeek(r);
  $$('.vol').forEach(v => v.addEventListener('input', () => player.setVolume(+v.value)));
  wireSwipeClose();
  let headDark = false;
  window.addEventListener('scroll', () => { const d = scrollY > 8; if (d !== headDark) { headDark = d; head.classList.toggle('scrolled', d); } }, { passive: true });
  try { history.scrollRestoration = 'manual'; } catch { }
  try { if (localStorage.getItem('bz_dock_big')) document.body.classList.add('dock-big'); } catch { }
  dockSizeLabel();
  try { if (localStorage.getItem('bz_dock_min')) document.body.classList.add('dock-min'); if (localStorage.getItem('bz_npq') !== '0') document.body.classList.add('np-q'); if (localStorage.getItem('bz_lyr')) document.body.classList.add('np-lyr'); } catch { }
  dockMinLabel();
  // Buttons outside the player (e.g. "Jump back in" on Home)
  document.addEventListener('click', e => { const l = e.target.closest('[data-artist-search]'); if (l) { lastSearch.q = l.dataset.artistSearch; } });
  // About to open an artist? Start fetching their photo now, so it's there when the page opens
  const warmArtist = e => {
    const l = e.target.closest?.('a[href^="#/artist/"]'); if (!l) return;
    let name = ''; try { name = decodeURIComponent(l.getAttribute('href').slice(9)); } catch { return; }
    if (name && !meta.artistPictureNow(name)) meta.artistPicture(name, true).then(pic => { if (pic) { const i = new Image(); i.src = sized(pic, 600); } });
  };
  document.addEventListener('pointerover', warmArtist, { passive: true });
  document.addEventListener('touchstart', warmArtist, { passive: true });
  document.addEventListener('click', e => { const b = e.target.closest('[data-p-ext]'); if (!b) return; if (b.dataset.pExt === 'toggle') player.toggle(); if (b.dataset.pExt === 'open') openNP(); });
}
// Pull down to close the full-screen player (phones/tablets).
// Works from anywhere in the player while it's scrolled to the top: the top bar, the cover, the
// song info, the controls, and the upper part of the video (a touch strip over it, since the video
// frame itself swallows touches; tapping that strip plays/pauses like tapping the video).
// The player follows your finger; let go far enough (or flick) and it closes, otherwise it springs back.
// Sliders, the queue list (when scrolled), lyrics and text boxes keep their own gestures.
function wireSwipeClose() {
  const body = document.body;
  const dock = $('#yt-dock');
  if (!dock.querySelector('.np-grab')) dock.insertAdjacentHTML('beforeend', '<div class="np-grab" aria-hidden="true"></div>');
  let g = null;
  const setPull = y => body.style.setProperty('--np-pull', Math.max(0, y) + 'px');
  const skip = t => t.closest('.seek, .vol, input, textarea, select, .np-lyrics, .menu, .modal-wrap, .grip, .qrow')
    || (t.closest('.np-q-body') && t.closest('.np-q-body').scrollTop > 0)
    || (t.closest('#yt-dock') && !t.closest('.np-grab'));
  const atTop = () => (window.scrollY || document.documentElement.scrollTop || 0) <= 1;
  const start = e => {
    g = null;
    if (!body.classList.contains('np-open') || e.touches.length !== 1 || skip(e.target) || !atTop()) return;
    const t = e.touches[0];
    g = { x: t.clientX, y: t.clientY, t: Date.now(), dy: 0, on: false, grab: !!e.target.closest('.np-grab') };
  };
  const move = e => {
    if (!g) return;
    const t = e.touches[0], dx = t.clientX - g.x, dy = t.clientY - g.y;
    if (!g.on) {
      if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || !atTop()) { g = null; return; } // scrolling up / sideways: not ours
      g.on = true; body.classList.add('np-pulling'); body.classList.remove('np-springing');
    }
    if (e.cancelable) e.preventDefault(); // no page bounce / pull-to-refresh while pulling
    g.dy = dy; setPull(dy < 140 ? dy : 140 + (dy - 140) * 0.7);
  };
  const end = () => {
    if (!g) return;
    const was = g; g = null;
    if (!was.on) {
      if (was.grab) player.toggle(); // a plain tap on the video strip = tap on the video
      return;
    }
    const v = was.dy / Math.max(1, Date.now() - was.t); // px per ms
    body.classList.remove('np-pulling'); body.classList.add('np-springing');
    if (was.dy > 120 || (was.dy > 45 && v > 0.55)) {
      setPull(innerHeight);
      setTimeout(() => { closeNP(); body.classList.remove('np-springing'); setPull(0); }, 220);
    } else {
      setPull(0);
      setTimeout(() => body.classList.remove('np-springing'), 260);
    }
  };
  for (const el of [$('#np'), $('#np-head'), dock]) {
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end, { passive: true });
    el.addEventListener('touchcancel', () => { if (g?.on) { g.dy = 0; end(); } g = null; }, { passive: true });
  }
}
// The yellow progress bar pauses its updates only while a finger/mouse is actually dragging it.
// Before, a drag that never "finished" (the page scrolled instead, the bar was redrawn when the next
// song started, or the browser cancelled the touch) left it frozen while the music kept playing.
let seeking = null; // the slider being dragged, or null
let seekIdle = null;
function endSeek(r, commit) {
  if (seeking !== r) return;
  clearTimeout(seekIdle);
  seeking = null;
  if (commit && P.duration) player.seek(r.value * P.duration / 1000);
  renderTime();
}
function wireSeek(r) {
  if (!r || r._wired) return; r._wired = true;
  r.addEventListener('input', () => {
    seeking = r;
    const t = fmtTime(r.value * P.duration / 1000);
    (r.closest('.pb-seek, .np-seek')?.querySelectorAll('.t-now') || []).forEach(x => x.textContent = t);
    clearTimeout(seekIdle); seekIdle = setTimeout(() => endSeek(r, true), 1500); // safety net
  });
  r.addEventListener('change', () => endSeek(r, true));
  ['pointercancel', 'touchcancel', 'blur'].forEach(ev => r.addEventListener(ev, () => endSeek(r, false)));
  ['pointerup', 'touchend'].forEach(ev => r.addEventListener(ev, () => setTimeout(() => endSeek(r, true), 0)));
}
// Full-screen player. Opening it adds a history step, so the phone's Back button/gesture closes it
// instead of leaving the page. Any navigation closes it properly (the video goes back to its corner).
function openNP() {
  if (!player.current()) return;
  const was = document.body.classList.contains('np-open');
  if (!was) window.scrollTo(0, 0);
  document.body.classList.add('np-open'); renderNP(true); requestAnimationFrame(placeDock); setTimeout(placeDock, 320);
  if (!was && !history.state?.bzNP) { try { history.pushState({ bzNP: 1 }, ''); } catch { } }
  saveSpotSoon();
}
function closeNP(how = 'ui') {
  const was = document.body.classList.contains('np-open');
  document.body.classList.remove('np-open'); if (was) window.scrollTo(0, 0); placeDock(); saveSpotSoon();
  if (!was || how === 'pop' || !history.state?.bzNP) return;
  if (how === 'ui') history.back(); else { try { history.replaceState(null, ''); } catch { } }
}
window.addEventListener('popstate', e => { if (document.body.classList.contains('np-open') && !e.state?.bzNP) closeNP('pop'); });
function toggleQueue() {
  if (innerWidth < 1000) { location.hash = '#/queue'; return; }
  document.body.classList.toggle('queue-open');
  if (document.body.classList.contains('queue-open')) renderQueue($('#queue-panel .qp-body'));
  placeDock();
}
function dockMinLabel() {
  const b = $('[data-p="dock-min"]'); if (!b) return;
  const min = document.body.classList.contains('dock-min');
  b.setAttribute('aria-label', min ? 'Show video' : 'Minimize video'); b.title = min ? 'Show video' : 'Minimize';
}
// The resize arrow points up while the video is small (make it bigger) and down while it's big
function dockSizeLabel() {
  const b = $('[data-p="dock-size"]'); if (!b) return;
  const big = document.body.classList.contains('dock-big');
  b.setAttribute('aria-label', big ? 'Smaller video' : 'Bigger video'); b.title = big ? 'Smaller' : 'Bigger';
}
// ---------- Sleep timer (full-screen player, next to ⋯) ----------
// Pick a time and the music fades out gently and pauses, or stop at the end of the current song.
let sleepAt = 0, sleepT = null, sleepTick = null;
const sleepLeft = () => sleepAt ? Math.max(0, sleepAt - Date.now()) : 0;
const fmtLeft = ms => { const m = Math.ceil(ms / 60e3); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + ' min' : ''}`.trim() : `${m} min`; };
function sleepBtn() {
  const b = $('#np-head .sleep-np'); if (!b) return;
  const on = !!sleepAt || player.stopsAfterSong();
  b.classList.toggle('on', on);
  const label = sleepAt ? `Sleep timer: ${fmtLeft(sleepLeft())} left` : player.stopsAfterSong() ? 'Sleep timer: stops after this song' : 'Sleep timer';
  b.setAttribute('aria-label', label); b.title = label;
}
function clearSleep(quiet) {
  clearTimeout(sleepT); clearInterval(sleepTick); sleepAt = 0; player.setStopAfterSong(false); player.cancelFade(); sleepBtn();
  if (!quiet) toast('Sleep timer off');
}
function setSleep(min) {
  clearSleep(true);
  if (min === 'song') { player.setStopAfterSong(true); sleepBtn(); toast('Music stops after this song 🌙', 'ok'); return; }
  sleepAt = Date.now() + min * 60e3;
  // fade over the last 8 seconds, then pause
  sleepT = setTimeout(() => player.fadeOutAndPause(8000), Math.max(0, min * 60e3 - 8000));
  sleepTick = setInterval(sleepBtn, 30e3);
  sleepBtn();
  toast(`Sleep timer: music stops in ${fmtLeft(min * 60e3)} 🌙`, 'ok');
}
async function sleepMenu(btn) {
  const active = sleepAt ? `${fmtLeft(sleepLeft())} left` : player.stopsAfterSong() ? 'Stops after this song' : '';
  const k = await menu(btn, [
    { header: `${icon('moon')} Sleep timer${active ? ` · <b>${active}</b>` : ''}` },
    ...[5, 10, 15, 30, 45, 60, 90].map(m => ({ k: String(m), label: m >= 60 ? `${m / 60 === 1 ? '1 hour' : m / 60 + ' hours'}` : `${m} minutes`, icon: 'timer' })),
    { k: 'song', label: 'End of this song', icon: 'disc' },
    (sleepAt || player.stopsAfterSong()) ? '-' : null,
    (sleepAt || player.stopsAfterSong()) ? { k: 'off', label: 'Turn off sleep timer', icon: 'close', danger: true } : null
  ]);
  if (!k) return;
  if (k === 'off') clearSleep();
  else setSleep(k === 'song' ? 'song' : +k);
}
on('sleep-done', () => { clearTimeout(sleepT); clearInterval(sleepTick); sleepAt = 0; sleepBtn(); toast('Sleep timer: music paused. Good night 🌙'); });
function toggleNPQueue() {
  const on = !document.body.classList.contains('np-q');
  document.body.classList.toggle('np-q', on);
  try { localStorage.setItem('bz_npq', on ? '1' : '0'); } catch { }
  renderNP();
  if (on && npNarrow.matches) setTimeout(() => npScrollTo($('#np .np-queue')), 60);
}
function closeQueueOnMobile() { if (innerWidth < 1000) document.body.classList.remove('queue-open'); }

let lastPlayedId = null;
function renderPlayer() {
  const t = player.current();
  if (t && P.playing && t.id !== lastPlayedId) { lastPlayedId = t.id; kv.get('plays').then(n => kv.set('plays', (n || 0) + 1)); }
  document.body.classList.toggle('has-track', !!t);
  // Subtle loading veil over the video / cover while a song is starting
  document.body.classList.toggle('song-loading', !!t && !!P.loading && !P.error);
  document.body.classList.toggle('needs-tap', !!P.needsTap);
  const dl = $('#yt-dock .dl-art');
  if (dl && t && dl.dataset.src !== (t.artwork || '')) { dl.dataset.src = t.artwork || ''; dl.style.backgroundImage = t.artwork ? `url("${sized(t.artwork, 300).replace(/"/g, '%22')}")` : ''; }
  const bar = $('#playerbar');
  if (!t) { bar.innerHTML = ''; bar.dataset.key = ''; return; }
  // Play/pause/buffering only touch the play button — the rest of the bar is left alone (instant, no flicker)
  const key = [t.id, t.artwork, displayTitle(t), t.artist, t.liked && !t.transient, P.error, P.mode, P.source, P.shuffle, P.repeat, document.body.classList.contains('queue-open'), P.volume > 0].join('|');
  if (bar.dataset.key === key && bar.firstElementChild) { patchPlayButtons(); playerTail(t); return; }
  bar.dataset.key = key;
  const modeBtns = `<div class="seg" role="group" aria-label="Playback version">
    <button data-p="mode" data-m="video" class="${P.mode === 'video' ? 'on' : ''}" title="Music video">${icon('video')}<span>Video</span></button>
    <button data-p="mode" data-m="audio" class="${P.mode === 'audio' ? 'on' : ''}" title="Audio only">${icon('audio')}<span>Audio</span></button></div>`;
  bar.innerHTML = `<div class="pb-progress"><i></i></div>
    <div class="pb-left" data-p="open">
      ${cover(t.artwork, t.title, 'pb-art')}
      <div class="pb-meta"><div class="pb-title">${esc(displayTitle(t))}</div><div class="pb-artist">${P.error ? `<span class="err-text">${esc(P.error)}</span>` : esc(t.artist)}</div></div>
      <button class="ib like ${t.liked && !t.transient ? 'on' : ''}" data-p="like" aria-label="Like">${icon(t.liked && !t.transient ? 'heartFill' : 'heart')}</button>
    </div>
    <div class="pb-center">
      <div class="pb-ctrls">
        <button class="ib hide-sm ${P.shuffle ? 'on' : ''}" data-p="shuffle" aria-label="Shuffle">${icon('shuffle')}</button>
        <button class="ib pb-prev" data-p="prev" aria-label="Previous">${icon('prev')}</button>
        <button class="play-btn ${P.loading ? 'busy' : ''}" data-p="toggle" data-on="${player.isOn() ? 1 : 0}" aria-label="${player.isOn() ? 'Pause' : 'Play'}">${icon(player.isOn() ? 'pause' : 'play')}</button>
        <button class="ib" data-p="next" aria-label="Next">${icon('next')}</button>
        <button class="ib hide-sm ${P.repeat !== 'off' ? 'on' : ''}" data-p="repeat" aria-label="Repeat">${icon('repeat')}${P.repeat === 'one' ? '<b class="r1">1</b>' : ''}</button>
      </div>
      <div class="pb-seek hide-sm"><span class="t-now">${fmtTime(P.time)}</span><input type="range" class="seek" min="0" max="1000" value="0" aria-label="Seek"><span class="t-dur">${fmtTime(P.duration)}</span></div>
    </div>
    <div class="pb-right hide-sm">
      ${P.source === 'local' ? `<span class="badge">${icon('offline')}Offline file</span>` : modeBtns}
      <button class="ib ${document.body.classList.contains('queue-open') ? 'on' : ''}" data-p="queue" aria-label="Queue">${icon('queue')}</button>
      <button class="ib" data-p="mute" aria-label="Mute">${icon(P.volume > 0 ? 'volume' : 'mute')}</button>
      <input type="range" class="vol" min="0" max="1" step="0.01" value="${P.volume}" aria-label="Volume">
    </div>`;
  const s = bar.querySelector('.seek');
  if (s) wireSeek(s);
  bar.querySelector('.vol')?.addEventListener('input', e => player.setVolume(+e.target.value));
  bar.querySelector('.vol')?.style.setProperty('--p', (P.volume * 100) + '%');
  renderTime();
  playerTail(t);
}
// Flip every play button in place (player bar + full screen)
function patchPlayButtons() {
  const on = player.isOn() ? '1' : '0';
  for (const b of $$('.play-btn[data-p="toggle"]')) {
    b.classList.toggle('busy', !!P.loading);
    if (b.dataset.on !== on) { b.dataset.on = on; b.innerHTML = icon(on === '1' ? 'pause' : 'play'); b.setAttribute('aria-label', on === '1' ? 'Pause' : 'Play'); }
  }
}
function playerTail(t) {
  markNow();
  document.body.classList.toggle('is-playing', player.isOn());
  updateJump();
  if (document.body.classList.contains('np-open')) renderNP();
  if (document.body.classList.contains('queue-open')) renderQueue($('#queue-panel .qp-body'));
  if (location.hash === '#/queue') renderQueue($('#queue-page'));
  const dt = $('#yt-dock .dock-title'); if (dt) dt.textContent = `${displayTitle(t)} · ${t.artist}`;
  const da = $('#yt-dock .dock-art'); if (da && da.dataset.src !== (t.artwork || '')) { da.dataset.src = t.artwork || ''; da.innerHTML = cover(t.artwork, t.title, 'sm'); }
  placeDock();
}
// Highlight exactly ONE row for the playing song — the one the user tapped (or the
// one that follows it in that list), never every copy of the same song on the page.
let nowCtx = { list: null };
function markNow() {
  const cur = player.current();
  let el = null;
  if (cur) {
    const ids = nowCtx.list && lists.get(nowCtx.list);
    if (ids) {
      if (ids[nowCtx.i] !== cur.id) {
        let j = ids.indexOf(cur.id, (nowCtx.i ?? -1) + 1);
        if (j < 0) j = ids.indexOf(cur.id);
        nowCtx.i = j;
      }
      if (nowCtx.i >= 0) el = document.querySelector(`.row[data-list="${CSS.escape(nowCtx.list)}"][data-i="${nowCtx.i}"]`);
    }
    if (!el) el = document.querySelector(`.row[data-id="${CSS.escape(cur.id)}"]`);
  }
  $$('.row.now').forEach(r => { if (r !== el) { r.classList.remove('now'); r.querySelector('.eq')?.remove(); } });
  if (el && (!el.classList.contains('now') || !el.querySelector('.eq'))) { el.classList.add('now'); (el.querySelector('.row-num .cover') || el.querySelector('.row-num')).insertAdjacentHTML('beforeend', '<span class="eq"><i></i><i></i><i></i></span>'); }
}

function renderTime() {
  if (seeking && !seeking.isConnected) { clearTimeout(seekIdle); seeking = null; } // the bar was redrawn mid-drag
  const pct = P.duration ? Math.max(0, Math.min(1, (P.time || 0) / P.duration)) : 0;
  $$('.pb-progress i').forEach(i => i.style.width = (pct * 100) + '%');
  if (seeking) return;
  $$('.seek').forEach(s => { s.value = Math.round(pct * 1000); s.style.setProperty('--p', (pct * 100).toFixed(2) + '%'); });
  $$('.t-now').forEach(x => x.textContent = fmtTime(P.time));
  $$('.t-dur').forEach(x => x.textContent = fmtTime(P.duration));
}

let qDragging = false;
// Full-screen player. The first render builds the page; after that (play/pause, like,
// shuffle…) only the parts that changed are patched, so the video slot, the lyrics
// and your scroll position never jump or reload.
const npTags = t => `${genreOf(t) ? `<span class="pill">${esc(genreOf(t))}</span>` : ''}${t.year ? `<span class="pill">${t.year}</span>` : ''}${t.durationMs ? `<span class="pill">${fmtDur(t.durationMs)}</span>` : ''}`;
const npLike = t => `<button class="ib lg like ${t.liked && !t.transient ? 'on' : ''}" data-p="like" aria-label="Like">${icon(t.liked && !t.transient ? 'heartFill' : 'heart')}</button>`;
const npCtrls = () => `
      <button class="ib lg ${P.shuffle ? 'on' : ''}" data-p="shuffle" aria-label="Shuffle">${icon('shuffle')}</button>
      <button class="ib xl" data-p="prev" aria-label="Previous">${icon('prev')}</button>
      <button class="play-btn big ${P.loading ? 'busy' : ''}" data-p="toggle" data-on="${player.isOn() ? 1 : 0}" aria-label="${player.isOn() ? 'Pause' : 'Play'}">${icon(player.isOn() ? 'pause' : 'play')}</button>
      <button class="ib xl" data-p="next" aria-label="Next">${icon('next')}</button>
      <button class="ib lg ${P.repeat !== 'off' ? 'on' : ''}" data-p="repeat" aria-label="Repeat">${icon('repeat')}${P.repeat === 'one' ? '<b class="r1">1</b>' : ''}</button>`;
function npExtra() {
  const qOn = document.body.classList.contains('np-q'), lOn = document.body.classList.contains('np-lyr');
  const upNext = Math.max(0, P.queue.length - P.cursor - 1);
  return `${P.source === 'local' ? `<span class="badge">${icon('offline')}Playing offline file</span>` : `<div class="seg big" role="group">
        <button data-p="mode" data-m="video" class="${P.mode === 'video' ? 'on' : ''}">${icon('video')}<span>Music video</span></button>
        <button data-p="mode" data-m="audio" class="${P.mode === 'audio' ? 'on' : ''}">${icon('audio')}<span>Audio only</span></button></div>`}
      <div class="np-toggles">
        <button class="chip ${lOn ? 'on' : ''}" data-p="lyrics" aria-pressed="${lOn}">${icon('mic')}${lOn ? 'Hide lyrics' : 'Lyrics'}</button>
        <button class="chip ${qOn ? 'on' : ''}" data-p="npq" aria-pressed="${qOn}">${icon('queue')}${qOn ? 'Hide queue' : 'Queue'}${upNext ? ` <small>${upNext}</small>` : ''}</button>
      </div>`;
}
// Scroll ONLY the scrolling part of the full-screen player (scrollIntoView would also shift the
// fixed top bar and video frame, leaving the video floating in the wrong place)
function npScrollTo(el) {
  if (!el) return;
  const headH = $('#np-head')?.offsetHeight || 60;
  window.scrollTo({ top: Math.max(0, scrollY + el.getBoundingClientRect().top - headH - 8), behavior: 'smooth' });
}
const npNarrow = matchMedia('(max-width: 900px), (max-height: 520px) and (orientation: landscape)'); // queue below the video on small or sideways phones
npNarrow.addEventListener?.('change', () => { if (document.body.classList.contains('np-open')) renderNP(true); });
const npQueueHTML = () => `<aside class="np-queue"><div class="np-q-head"><h3>Up next</h3><span class="muted tiny">Drag ${icon('grip')} to reorder</span><button class="ib sm" data-p="npq" aria-label="Hide queue">${icon('close')}</button></div><div class="np-q-body"></div></aside>`;
function renderNP(full = false) {
  if (qDragging) return;
  const t = player.current(); if (!t) return closeNP('nav');
  const np = $('#np');
  const showVid = P.source === 'yt';
  const qOn = document.body.classList.contains('np-q');
  const narrow = npNarrow.matches;
  const key = `${t.id}|${showVid}|${qOn}|${narrow}|${t.artwork || ''}`;
  if (!full && np.dataset.key === key && np.querySelector('.np-layout')) {
    // only rewrite what actually changed; play/pause just flips its button
    const setIf = (el, html) => { if (el && el._html !== html) { el._html = html; el.innerHTML = html; } };
    const c = np.querySelector('.np-ctrls'), cs = `${P.shuffle}|${P.repeat}`;
    if (c.dataset.sig !== cs) { c.dataset.sig = cs; c.innerHTML = npCtrls(); }
    patchPlayButtons();
    setIf(np.querySelector('.np-extra'), npExtra());
    const lk = np.querySelector('.np-info .like'), liked = t.liked && !t.transient;
    if (lk && lk.classList.contains('on') !== !!liked) lk.outerHTML = npLike(t);
    const err = np.querySelector('.np-err'); err.textContent = P.error || ''; err.hidden = !P.error;
    if (qOn) renderQueue(np.querySelector('.np-q-body'));
    renderTime(); placeDock();
    return;
  }
  np.dataset.key = key;
  const keep = { sc: scrollY || 0, q: $('.np-q-body')?.scrollTop || 0 };
  $('#np-head').innerHTML = `<button class="ib" data-p="close" aria-label="Close">${icon('down')}</button><div class="np-ctx">Now playing</div><button class="ib lock-np" data-act="lock" aria-label="Lock screen" title="Lock screen">${icon('lock')}</button><span class="np-head-r"><button class="ib sleep-np" data-p="sleep" aria-label="Sleep timer" title="Sleep timer">${icon('timer')}</button><button class="ib" data-p="more" aria-label="More">${icon('more')}</button></span>`;
  sleepBtn();
  // Layout: the top bar and the video/cover stay put; everything below scrolls on its own.
  // On wide screens the queue is a panel on the right with its own scroll.
  np.innerHTML = `<div class="np-bg ${t.artwork ? '' : 'none'}" ${t.artwork ? `style="background-image:url('${esc(sized(t.artwork, 300))}')"` : ''}></div>
    <div class="np-layout ${qOn && !narrow ? 'with-q' : ''}">
    <div class="np-main">
      <div class="np-scroll"><div class="np-inner">
        <div class="np-media ${showVid ? 'vid' : 'art'}">${showVid ? '<div id="np-slot" class="np-slot"></div>' : cover(t.artwork, t.title, 'np-art')}</div>
        <div class="np-info"><div><h2>${esc(displayTitle(t))}</h2><button class="lnk np-artist" data-p="artist">${esc(t.artist)}</button>${t.album ? `<button class="lnk np-album" data-p="album">${icon('disc')}${esc(t.album)}</button>` : ''}</div>
          <div class="np-side">${npLike(t)}<div class="np-tags np-tags-side">${npTags(t)}</div></div></div>
        <p class="err-text np-err" ${P.error ? '' : 'hidden'}>${esc(P.error || '')}</p>
        <div class="np-seek"><input type="range" class="seek" min="0" max="1000" value="0" aria-label="Seek"><div class="np-times"><span class="t-now">0:00</span><span class="t-dur">0:00</span></div></div>
        <div class="np-ctrls" data-sig="${P.shuffle}|${P.repeat}">${npCtrls()}</div>
        <div class="np-extra">${npExtra()}</div>
        <div class="np-tags np-tags-main">${npTags(t)}</div>
        ${qOn && narrow ? npQueueHTML() : ''}
        <section class="np-lyrics" aria-label="Lyrics"></section>
      </div></div>
    </div>
    ${qOn && !narrow ? npQueueHTML() : ''}
    </div>`;
  wireSeek(np.querySelector('.seek'));
  if (qOn) renderQueue(np.querySelector('.np-q-body'));
  if (document.body.classList.contains('np-lyr')) showLyrics(t);
  if (keep.sc) window.scrollTo(0, keep.sc);
  const qb = np.querySelector('.np-q-body'); if (qb) qb.scrollTop = keep.q;
  renderTime();
  placeDock();
}

// ---------- Lyrics (Genius) ----------
// Genius's official embed widget shows licensed lyrics. To use it we need the song's Genius id:
// we try Genius's search (with your free token if you added one). If Genius doesn't allow the
// lookup from this browser, you get a one-tap "Open lyrics on Genius" button instead.
const lyricsCache = new Map();
function setLyrics(on) {
  document.body.classList.toggle('np-lyr', on);
  try { localStorage.setItem('bz_lyr', on ? '1' : ''); } catch { }
  if (!document.body.classList.contains('np-open')) return;
  renderNP();
  const t = player.current();
  if (on && t) { showLyrics(t); setTimeout(() => npScrollTo($('#np .np-lyrics')), 80); }
  else { const el = $('.np-lyrics'); if (el) { el.innerHTML = ''; el.dataset.tid = ''; } }
}
async function geniusFind(t) {
  const q = `${t.artist} ${t.title.replace(/\s*[\(\[].*?[\)\]]/g, '')}`;
  const tries = [];
  if (settings.geniusToken) tries.push(async () => (await (await fetch(`https://api.genius.com/search?q=${encodeURIComponent(q)}&access_token=${encodeURIComponent(settings.geniusToken)}`)).json()).response.hits.map(h => h.result));
  tries.push(async () => (await (await fetch(`https://genius.com/api/search/song?per_page=5&q=${encodeURIComponent(q)}`)).json()).response.sections.flatMap(s => s.hits).map(h => h.result));
  for (const go of tries) {
    try {
      const res = (await go()).filter(Boolean);
      const na = norm(mainArtist(t.artist)), nt = norm(t.title.replace(/\s*[\(\[].*?[\)\]]/g, ''));
      const hit = res.find(r => norm(r.primary_artist?.name).includes(na) && norm(r.title).includes(nt))
        || res.find(r => norm(r.primary_artist?.name).includes(na) || norm(r.full_title || '').includes(na)) || null;
      if (hit) return { id: hit.id, url: hit.url };
      if (res.length) return null;
    } catch { }
  }
  return null;
}
async function showLyrics(t) {
  const el = $('.np-lyrics'); if (!el || !t) return;
  if (el.dataset.tid === t.id && el.innerHTML) return;
  el.dataset.tid = t.id;
  const searchUrl = `https://genius.com/search?q=${encodeURIComponent(`${t.artist} ${t.title}`)}`;
  el.innerHTML = `<div class="lyr-head"><h3>Lyrics</h3><span class="muted tiny">from Genius</span></div>${loader('Finding lyrics…', 'sm')}`;
  if (!lyricsCache.has(t.id)) lyricsCache.set(t.id, navigator.onLine ? geniusFind(t) : Promise.resolve(null));
  const g = await lyricsCache.get(t.id);
  if (el.dataset.tid !== t.id) return;
  if (g?.id) {
    const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>html,body{margin:0;background:#fff;font-family:system-ui,sans-serif}body{padding:4px}</style></head><body>
      <div id="rg_embed_link_${g.id}" class="rg_embed_link" data-song-id="${g.id}">Read <a href="${esc(g.url)}">${esc(t.title)}</a> on Genius</div>
      <script crossorigin src="https://genius.com/songs/${g.id}/embed.js"><\/script></body></html>`;
    el.innerHTML = `<div class="lyr-head"><h3>Lyrics</h3><a class="lnk tiny" href="${esc(g.url)}" target="_blank" rel="noopener">Open on Genius ↗</a></div>
      <iframe class="lyr-frame" title="Lyrics from Genius" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>`;
    el.querySelector('iframe').srcdoc = doc;
  } else {
    el.innerHTML = `<div class="lyr-head"><h3>Lyrics</h3></div><div class="lyr-empty">
      <p class="muted">${navigator.onLine ? 'Genius didn\'t let us load these lyrics here.' : 'Lyrics need an internet connection.'}</p>
      <a class="btn primary" href="${esc(g?.url || searchUrl)}" target="_blank" rel="noopener">${icon('link')}Open lyrics on Genius</a>
      ${!settings.geniusToken ? '<p class="tiny muted">Tip: add a free Genius token in Settings → Lyrics to load them right here.</p>' : ''}</div>`;
  }
}

// The YouTube player lives in one element at the top of the page (moving an iframe would reload it).
// In the full-screen player it is placed over the video slot as part of the page, so when the page
// scrolls the browser moves the video itself — perfectly in step, in every browser, no script per frame.
// Otherwise it sits in its corner mini-dock.
function placeDock() {
  const dock = $('#yt-dock');
  const vis = P.source === 'yt' && !!player.current();
  dock.classList.toggle('show', vis);
  if (!vis) return;
  const slot = document.body.classList.contains('np-open') ? $('#np-slot') : null;
  if (slot) {
    const r = slot.getBoundingClientRect();
    const st = dock.style, L = Math.round(r.left + scrollX) + 'px', T = Math.round(r.top + scrollY) + 'px', W = r.width + 'px', H = r.height + 'px';
    if (st.left !== L || st.top !== T || st.width !== W || st.height !== H) Object.assign(st, { left: L, top: T, width: W, height: H, right: 'auto', bottom: 'auto' });
    dock.classList.add('in-np');
  } else if (dock.classList.contains('in-np') || dock.hasAttribute('style')) {
    dock.classList.remove('in-np');
    dock.removeAttribute('style');
  }
  // the back-to-top button sits just to the left of the corner video (desktop)
  if (!slot) requestAnimationFrame(() => { const on = dock.classList.contains('show'); document.body.style.setProperty('--dockh', (on ? dock.offsetHeight : 0) + 'px'); document.body.style.setProperty('--dockw', (on ? dock.offsetWidth : 0) + 'px'); });
}

// Save the whole queue (BAZINGA! mix or a shuffled queue) as a new playlist, in the order it plays
async function saveQueueAsPlaylist() {
  const ids = P.queue.map(q => q.id).filter(id => lib.tracks.has(id));
  if (!ids.length) return;
  const day = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const name = await promptText('Save queue as a playlist', `${P.origin === 'mix' ? 'My BAZINGA! Mix' : 'Shuffle'} · ${day}`, 'Playlist name', 'Save');
  if (!name) return;
  const transient = ids.map(id => lib.tracks.get(id)).filter(t => t.transient);
  if (transient.length) await store.upsertTracks(transient.map(t => { const x = stripTransient(t); delete x.mix; return x; }));
  const pl = await store.createPlaylist(name, ids, { source: 'Saved from your queue' });
  renderSidebarPlaylists();
  toastUndo(`Saved "${name}" · ${ids.length} songs`, () => { closeNP('nav'); location.hash = '#/playlist/' + pl.id; }, 'Open');
}
function renderQueue(el, force = false) {
  if (!el || qDragging) return;
  const cur = player.current();
  if (!cur) { el.innerHTML = '<p class="muted pad">Nothing playing. Pick a song to start.</p>'; el.dataset.sig = ''; return; }
  // Skip the (expensive) rebuild when nothing in the queue changed — play/pause/buffering don't touch it
  const limit = +el.dataset.limit || 100;
  const canSave = player.queueIsNew();
  const sig = `${cur.id}|${P.cursor}|${P.queue.length}|${limit}|${canSave}|` + P.queue.slice(P.cursor, P.cursor + limit + 1).map(q => q.id + (q.user ? '*' : '')).join(',');
  if (!force && el.dataset.sig === sig && el.firstChild) return;
  el.dataset.sig = sig;
  const total = P.queue.length - P.cursor - 1;
  const after = P.queue.slice(P.cursor + 1).map((q, j) => ({ ...q, i: P.cursor + 1 + j })).slice(0, limit);
  const row = q => { const t = lib.tracks.get(q.id); if (!t) return ''; return `<div class="qrow ${q.user ? 'user' : ''}" data-qi="${q.i}">
      <span class="grip" title="Drag to reorder">${icon('grip')}</span>${cover(t.artwork, t.title, 'sm')}<div class="row-main" data-qjump="${q.i}"><div class="row-title">${esc(displayTitle(t))}${q.user ? '<span class="qtag">queued</span>' : ''}</div><div class="row-sub">${esc(t.artist)}</div></div>
      <button class="ib sm" data-qrm="${q.i}" aria-label="Remove from queue" title="Remove">${icon('close')}</button></div>`; };
  el.innerHTML = `<div class="q-h">Now playing${canSave ? `<button class="ib q-save" data-qsave aria-label="Save this queue as a new playlist" title="Save this queue as a playlist">${icon('plus')}</button>` : ''}</div><div class="qrow now">${cover(cur.artwork, cur.title, 'sm')}<div class="row-main"><div class="row-title">${esc(displayTitle(cur))}</div><div class="row-sub">${esc(cur.artist)}</div></div></div>
    ${after.length ? `<div class="q-h">Next up <span>${after.some(q => q.user) ? '<button class="lnk" data-qclear>Clear queued</button>' : ''}</span></div><div class="qlist">${after.map(row).join('')}</div>`
      : `<p class="muted tiny pad">Nothing after this song. ${settings.autoplay === 'off' ? 'Use ⋯ → "Add to queue" on any song.' : 'Autoplay picks up from here.'}</p>`}
    ${total > after.length ? `<button class="more-btn" data-qmore>Show more <small>${total - after.length} more</small></button>` : ''}`;
  el.onclick = e => {
    if (el._dragged) { el._dragged = false; return; }
    if (e.target.closest('[data-qmore]')) { el.dataset.limit = limit + 100; renderQueue(el, true); return; }
    const j = e.target.closest('[data-qjump]'); if (j) player.jumpTo(+j.dataset.qjump);
    const r = e.target.closest('[data-qrm]'); if (r) player.removeFromQueue(+r.dataset.qrm);
    if (e.target.closest('[data-qclear]')) player.clearUserQueue();
    if (e.target.closest('[data-qsave]')) saveQueueAsPlaylist();
  };
  // Drag to reorder — pointer events, so it works with mouse AND touch
  el.onpointerdown = e => {
    const g = e.target.closest('.grip'); if (!g) return;
    const rowEl = g.closest('.qrow'), list = el.querySelector('.qlist'); if (!rowEl || !list) return;
    e.preventDefault();
    const from = +rowEl.dataset.qi;
    const startOrder = [...list.children].map(r => +r.dataset.qi);
    rowEl.classList.add('dragging'); qDragging = true;
    g.setPointerCapture(e.pointerId);
    const scroller = el.closest('.np-q-body, .qp-body, #main, .np-scroll') || el;
    let raf = null, lastY = e.clientY;
    const autoscroll = () => {
      const r = scroller.getBoundingClientRect();
      if (lastY < r.top + 50) scroller.scrollTop -= 10; else if (lastY > r.bottom - 50) scroller.scrollTop += 10;
      raf = requestAnimationFrame(autoscroll);
    };
    raf = requestAnimationFrame(autoscroll);
    const move = ev => {
      lastY = ev.clientY;
      const sibs = [...list.children].filter(r => r !== rowEl);
      const before = sibs.find(r => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
      if (before) { if (rowEl.nextSibling !== before) list.insertBefore(rowEl, before); }
      else if (list.lastElementChild !== rowEl) list.appendChild(rowEl);
    };
    const up = () => {
      cancelAnimationFrame(raf);
      g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
      rowEl.classList.remove('dragging'); qDragging = false;
      const newPos = [...list.children].indexOf(rowEl);
      const to = startOrder[newPos];
      if (to !== from) { el._dragged = true; player.moveInQueue(from, to); } else emit('player', P);
    };
    g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
  };
}

boot().then(() => { const f = document.getElementById('boot-fail'); if (f) f.hidden = true; }).catch(e => {
  console.error(e); // details stay in the console; people just see a friendly "sorry" with Try again / Help
  const f = document.getElementById('boot-fail'); if (!f) return;
  f.hidden = false;
  const st = f.querySelector('.bf-status');
  if (st) st.textContent = /storage|indexeddb|private|blocked|quota/i.test(e?.message || '') ? 'This browser is blocking the storage BAZINGA! needs — Private mode or a full device can cause this.' : '';
});

return { APP_VERSION };
})();
})();
