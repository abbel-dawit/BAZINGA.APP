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
import { jsonp, norm, mainArtist, albumKey, trackKey, yearOf, sleep } from './util.js';
import { db } from './db.js';

const BASE = 'https://itunes.apple.com';
let country = 'US';
export const setCountry = c => { country = (c || 'US').toUpperCase(); };

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
export const backgroundBusy = () => waiting[1].length;

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
export async function deezerSearchSongs(q, limit = 20) { return (await deezer('search', { q, limit }, DAY)).filter(r => r.type === 'track' || r.title).map(songFromDeezer); }
export async function deezerSearchArtists(q, limit = 8) { return (await deezer('search/artist', { q, limit }, DAY)).map(a => ({ name: a.name, itunesArtistId: null, genre: '', picture: a.picture_xl || a.picture_big || '' })); }
export async function deezerArtistTop(name, limit = 10) {
  const res = await deezer('search/artist', { q: mainArtist(name), limit: 5 }, 14 * DAY, true);
  const k = norm(mainArtist(name));
  const a = res.find(r => norm(r.name) === k) || res[0];
  if (!a) return [];
  return (await deezer(`artist/${a.id}/top`, { limit }, DAY, true)).map(songFromDeezer);
}
export async function deezerCover(t) {
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
export function artistPictureNow(name) { const k = norm(name); return k ? picStore[k] : ''; }
export async function artistPicture(name, urgent = false) {
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
export const art = (u, size = 600) => u ? u.replace(/\/\d+x\d+(bb)?\./, `/${size}x${size}bb.`) : '';

export function songFromItunes(r) {
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
export function albumFromItunes(r) {
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

export async function searchSongs(term, limit = 25, o) {
  return (await call('search', { term, media: 'music', entity: 'song', limit }, o)).filter(r => r.kind === 'song').map(songFromItunes);
}
export async function searchAlbums(term, limit = 25, o) {
  return (await call('search', { term, media: 'music', entity: 'album', limit }, o)).filter(r => r.collectionType === 'Album').map(albumFromItunes);
}
export async function searchArtists(term, limit = 10, o) {
  return (await call('search', { term, media: 'music', entity: 'musicArtist', limit }, o))
    .map(r => ({ name: r.artistName, itunesArtistId: r.artistId, genre: r.primaryGenreName || '' }));
}

export async function albumTracks(itunesAlbumId) {
  const res = await call('lookup', { id: itunesAlbumId, entity: 'song', limit: 200 }, { ttl: 14 * DAY });
  const album = res.find(r => r.wrapperType === 'collection');
  const songs = res.filter(r => r.wrapperType === 'track' && r.kind === 'song').map(songFromItunes)
    .sort((a, b) => (a.discNumber - b.discNumber) || (a.trackNumber - b.trackNumber));
  return { album: album ? albumFromItunes(album) : null, tracks: songs };
}

export async function artistAlbums(itunesArtistId, o) {
  const res = await call('lookup', { id: itunesArtistId, entity: 'album', limit: 200 }, { ttl: 3 * DAY, ...o });
  const seen = new Set();
  return res.filter(r => r.wrapperType === 'collection' && r.collectionType === 'Album').map((r, i) => ({ ...albumFromItunes(r), rank: i })) // rank = Apple's own order (roughly most popular first)
    .filter(a => { const k = norm(a.title); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
}
export async function artistTopSongs(itunesArtistId) {
  const res = await call('lookup', { id: itunesArtistId, entity: 'song', limit: 25 }, { ttl: 3 * DAY });
  return res.filter(r => r.wrapperType === 'track').map(songFromItunes);
}
// Newest releases (albums, EPs and singles) for an artist
export async function artistLatest(itunesArtistId, o) {
  const res = await call('lookup', { id: itunesArtistId, entity: 'album', sort: 'recent', limit: 6 }, { ttl: DAY / 2, ...o });
  return res.filter(r => r.wrapperType === 'collection').map(albumFromItunes);
}
export async function findArtistId(name, o) {
  const res = await searchArtists(mainArtist(name), 5, { ttl: 30 * DAY, ...o });
  const n = norm(mainArtist(name));
  return (res.find(a => norm(a.name) === n) || res[0])?.itunesArtistId || null;
}

// Best iTunes match for a song we only know by name (fills genre/date/artwork/album)
export async function matchTrack(t, o = { bg: true }) {
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

export async function findAlbum(artist, title) {
  const res = await searchAlbums(`${mainArtist(artist)} ${title}`, 10, { ttl: 14 * DAY });
  const nt = norm(title), na = norm(mainArtist(artist));
  return res.find(a => norm(a.title) === nt && norm(a.artist).includes(na))
      || res.find(a => norm(a.title).includes(nt) && norm(a.artist).includes(na))
      || null;
}

// Helpers: give up after a while; take the first source that comes back with something
export const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]);
export function firstFull(list) {
  return new Promise(resolve => {
    let left = list.length, best = [];
    for (const p of list) Promise.resolve(p).then(v => { if (v?.length) resolve(v); else if (!--left) resolve(best); }, () => { if (!--left) resolve(best); });
  });
}
