// The user's library, kept in memory and mirrored to IndexedDB.
import { db, kv } from './db.js';
import { uid, emit, debounce, norm, mainArtist, albumKey, trackKey, splitArtists, genreOf } from './util.js';
import * as meta from './meta.js';

export const lib = {
  tracks: new Map(),
  albums: new Map(),
  playlists: new Map()
};

const changed = debounce(() => emit('library'), 120);
// Library version: bumped on every change, so derived lists (artists, genres, albums…) are worked out
// once per change instead of on every screen draw — that matters with big libraries.
let ver = 0;
export const bump = () => { ver++; };
export const version = () => ver;
const memo = new Map(); // name -> [version, value]
function cached(name, fn) { const m = memo.get(name); if (m && m[0] === ver) return m[1]; const v = fn(); memo.set(name, [ver, v]); return v; }
export const notify = (why = 'change') => { ver++; changed(); emit('dirty', why); };

// ---- deletion markers, used when syncing between devices ----
let tomb = { t: {}, p: {}, a: {} };
export const tombstones = () => tomb;
async function markDeleted(kind, id) { tomb[kind][id] = Date.now(); await kv.set('tombstones', tomb); }
export async function setTombstones(t) { tomb = t; await kv.set('tombstones', tomb); }

export async function load() {
  tomb = (await kv.get('tombstones')) || { t: {}, p: {}, a: {} };
  const old = Date.now() - 120 * 864e5;
  for (const k of ['t', 'p', 'a']) for (const [id, ts] of Object.entries(tomb[k] || {})) if (ts < old) delete tomb[k][id];
  const [t, a, p] = await Promise.all([db.all('tracks'), db.all('albums'), db.all('playlists')]);
  lib.tracks = new Map(t.map(x => [x.id, x]));
  lib.albums = new Map(a.map(x => [x.id, x]));
  lib.playlists = new Map(p.map(x => [x.id, x]));
  ver++;
  await migrateArtists(); ver++;
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
export async function upsertTracks(list, extra = {}) {
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
export function remember(t) {
  if (!lib.tracks.has(t.id)) lib.tracks.set(t.id, { ...t, transient: true });
  return lib.tracks.get(t.id);
}
const savedList = () => cached('saved', () => { const out = []; for (const t of lib.tracks.values()) if (!t.transient) out.push(t); return out; });
export const saved = () => savedList().slice();

export async function updateTrack(id, patch, { quiet = false } = {}) {
  const t = lib.tracks.get(id); if (!t) return;
  if (patch.liked && !t.liked) patch = { likedAt: Date.now(), ...patch };
  if ('liked' in patch && !!patch.liked !== !!t.liked) patch.likeTs = Date.now();
  patch.updatedAt = Date.now();
  if (t.transient) { Object.assign(t, patch); await upsertTracks([t]); return; }
  Object.assign(t, patch); ver++;
  if (quiet) { emit('dirty', 'track'); await db.put('tracks', t); return; }
  await db.put('tracks', t);
  notify('track');
}

// Likes update the screen in place (no page re-render), so the heart reacts instantly
export async function setLiked(id, on) {
  const t = lib.tracks.get(id); if (!t) return;
  if (t.transient) { if (on) { await upsertTracks([{ ...t, liked: true, likedAt: Date.now() }], {}); emit('like', { id, liked: true }); } return !!on; }
  if (!!t.liked === !!on) return !!on;
  const p = updateTrack(id, on ? { liked: true, likedAt: Date.now() } : { liked: false, likedAt: null }, { quiet: true });
  emit('like', { id, liked: !!on });
  await p;
  return !!on;
}
export async function toggleLike(id) {
  const t = lib.tracks.get(id); if (!t) return;
  return setLiked(id, !(t.liked && !t.transient));
}

// Every song some playlist or album uses (built once per clean-up, not once per song)
function referencedIds() {
  const s = new Set();
  for (const p of lib.playlists.values()) for (const id of p.trackIds) s.add(id);
  for (const a of lib.albums.values()) for (const id of a.trackIds || []) s.add(id);
  return s;
}
async function gc(ids) {
  if (!ids?.length) return;
  const used = referencedIds(), gone = [];
  for (const id of new Set(ids)) {
    const t = lib.tracks.get(id);
    if (!t || t.liked || t.localFileId || used.has(id)) continue;
    lib.tracks.delete(id); gone.push(id); tomb.t[id] = Date.now();
  }
  if (!gone.length) return;
  ver++;
  await delTracks(gone);
  await kv.set('tombstones', tomb);
}
const delTracks = ids => db.delMany('tracks', ids);

export async function deleteTrack(id) {
  const t = lib.tracks.get(id);
  if (t?.localFileId) await db.del('files', t.localFileId);
  for (const p of lib.playlists.values()) {
    if (p.trackIds.includes(id)) { p.trackIds = p.trackIds.filter(x => x !== id); p.updatedAt = Date.now(); await db.put('playlists', p); }
  }
  for (const a of lib.albums.values()) {
    if (a.trackIds?.includes(id)) { a.trackIds = a.trackIds.filter(x => x !== id); await db.put('albums', a); }
  }
  lib.tracks.delete(id); await db.del('tracks', id);
  await markDeleted('t', id);
  notify('delete');
}

// ---------- Playlists ----------
export async function createPlaylist(name, trackIds = [], extra = {}) {
  const p = { id: uid('pl'), name: name || 'New playlist', trackIds: [...new Set(trackIds)], createdAt: Date.now(), updatedAt: Date.now(), ...extra };
  lib.playlists.set(p.id, p);
  await db.put('playlists', p);
  notify('playlist');
  return p;
}
// quiet: the screen already shows the change (e.g. a drag to reorder), so don't redraw the page
export async function savePlaylist(p, { quiet = false } = {}) {
  p.updatedAt = Date.now(); lib.playlists.set(p.id, p); ver++;
  await db.put('playlists', p);
  if (quiet) emit('dirty', 'playlist'); else notify('playlist');
}
export async function addToPlaylist(pid, ids) {
  const p = lib.playlists.get(pid); if (!p) return 0;
  const before = p.trackIds.length;
  p.trackIds = [...new Set([...p.trackIds, ...ids])];
  await savePlaylist(p);
  return p.trackIds.length - before;
}
export async function removeFromPlaylist(pid, id) {
  const p = lib.playlists.get(pid); if (!p) return null;
  const index = p.trackIds.indexOf(id);
  const snapshot = lib.tracks.get(id) ? { ...lib.tracks.get(id) } : null;
  p.trackIds = p.trackIds.filter(x => x !== id);
  await savePlaylist(p); await gc([id]);
  return { pid, id, index, snapshot };
}
// Take several songs out of a playlist at once (undo with undoRemoveMany)
export async function removeManyFromPlaylist(pid, ids, opts) {
  const p = lib.playlists.get(pid); if (!p) return null;
  const drop = new Set(ids), removed = [];
  p.trackIds.forEach((id, index) => { if (drop.has(id)) removed.push({ id, index, snapshot: lib.tracks.get(id) ? { ...lib.tracks.get(id) } : null }); });
  if (!removed.length) return { pid, removed };
  p.trackIds = p.trackIds.filter(x => !drop.has(x));
  await savePlaylist(p, opts); await gc(removed.map(r => r.id));
  return { pid, removed };
}
export async function undoRemoveMany(r, opts) {
  const p = r && lib.playlists.get(r.pid); if (!p) return;
  const back = r.removed.filter(x => !lib.tracks.has(x.id) && x.snapshot).map(x => x.snapshot);
  if (back.length) await upsertTracks(back);
  for (const x of [...r.removed].sort((a, b) => a.index - b.index)) if (!p.trackIds.includes(x.id)) p.trackIds.splice(Math.min(x.index, p.trackIds.length), 0, x.id);
  await savePlaylist(p, opts);
}
// Move one song to a new spot in a playlist (custom order)
export async function moveInPlaylist(pid, id, toIndex, opts = { quiet: true }) {
  const p = lib.playlists.get(pid); if (!p) return;
  const from = p.trackIds.indexOf(id); if (from < 0) return;
  const ids = p.trackIds.slice(); ids.splice(from, 1);
  ids.splice(Math.max(0, Math.min(toIndex, ids.length)), 0, id);
  p.trackIds = ids;
  await savePlaylist(p, opts);
}
// Undo for removeFromPlaylist: put the song back exactly where it was
export async function undoRemoveFromPlaylist(r) {
  if (!r) return;
  const p = lib.playlists.get(r.pid); if (!p) return;
  if (!lib.tracks.has(r.id) && r.snapshot) await upsertTracks([r.snapshot]);
  if (!p.trackIds.includes(r.id)) p.trackIds.splice(Math.max(0, Math.min(r.index, p.trackIds.length)), 0, r.id);
  await savePlaylist(p);
}
// Swap a playlist's songs for new ones (the BAZINGA! mix), cleaning up songs nothing else uses
export async function replacePlaylistTracks(pid, ids) {
  const p = lib.playlists.get(pid); if (!p) return;
  const old = p.trackIds;
  p.trackIds = [...new Set(ids)];
  await savePlaylist(p);
  await gc(old.filter(id => !p.trackIds.includes(id) && lib.tracks.get(id)?.mix));
}
export async function deletePlaylist(pid) {
  const p = lib.playlists.get(pid); if (!p) return;
  lib.playlists.delete(pid); await db.del('playlists', pid); await markDeleted('p', pid);
  await gc(p.trackIds); notify('playlist');
}

// ---------- Albums ----------
export async function saveAlbum(album, tracks) {
  const saved = await upsertTracks(tracks.map(t => ({ ...t, album: album.title, albumId: album.id, itunesAlbumId: album.itunesAlbumId || t.itunesAlbumId })));
  const a = { ...album, trackIds: saved.map(t => t.id), savedAt: Date.now(), updatedAt: Date.now() };
  if (tomb.a[a.id]) { delete tomb.a[a.id]; kv.set('tombstones', tomb); }
  lib.albums.set(a.id, a);
  await db.put('albums', a);
  notify('album');
  return a;
}
export async function removeAlbum(id) {
  const a = lib.albums.get(id); if (!a) return;
  lib.albums.delete(id); await db.del('albums', id); await markDeleted('a', id);
  await gc(a.trackIds || []); notify('album');
}

// ---------- Derived views ----------
export const artists = () => cached('artists', artistsNow).slice();
function artistsNow() {
  const m = new Map();
  for (const t of savedList()) {
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

export const genres = () => cached('genres', genresNow).slice();
function genresNow() {
  const m = new Map();
  for (const t of savedList()) { const g = genreOf(t); if (g) m.set(g, (m.get(g) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// Albums the user has songs from but hasn't explicitly saved
export const implicitAlbums = () => cached('implicitAlbums', implicitNow).slice();
function implicitNow() {
  const m = new Map();
  for (const t of savedList()) {
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
export const setEnrich = v => { enrichOn = v; if (v) queueEnrich([...lib.tracks.values()]); };
export const enrichPending = () => enrichQ.size + coverQ.size;
export function queueEnrich(list) {
  for (const t of list) {
    if (t.transient) continue;
    if (!t.enriched) enrichQ.add(t.id);
    if (!t.artwork && !t.coverTried) coverQ.add(t.id);
  }
  runEnrich(); runCovers();
}
async function patchTrack(t, patch) {
  Object.assign(t, patch); ver++;
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
export async function coverFromVideo(id, vid) {
  const t = lib.tracks.get(id);
  if (!t || t.artwork || !vid) return;
  const artwork = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
  if (t.transient) { t.artwork = artwork; emit('track-art', { id, artwork }); return; }
  await patchTrack(t, { artwork });
}
