// Cross-device sync for signed-in users.
// The whole library (songs, likes, playlists, albums, YouTube matches, settings) is saved as one
// compressed file in the user's private Supabase Storage folder. Every change bumps a revision
// number in their profile; devices compare revisions, download what's new, MERGE it with what
// they have (newest edit wins per item, likes merge separately, deletions are remembered), and
// upload the result. Two devices saving at the same moment can't overwrite each other: the
// revision bump only succeeds if nobody else saved in between, otherwise we merge and retry.
import { db, kv } from './db.js';
import { emit, on, debounce, sleep } from './util.js';
import * as cloud from './cloud.js';
import * as store from './store.js';
import * as backup from './backup.js';

const BUCKET = 'libraries';
const S = { status: 'off', lastSync: 0, error: '', rev: 0 };
export const state = () => S;
let st = null; // persisted per user: {rev, hash}
let running = null, again = false, started = false, timer = null;

const device = () => {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'device';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} on ${os}`;
};
function setStatus(status, error = '') { S.status = status; S.error = error; if (status === 'synced') S.lastSync = Date.now(); emit('sync', S); }

// ---------- file format ----------
async function pack(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  if ('CompressionStream' in window) return new Blob([await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()], { type: 'application/gzip' });
  return new Blob([bytes], { type: 'application/json' });
}
async function unpack(blob) {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const stream = head[0] === 0x1f && head[1] === 0x8b ? blob.stream().pipeThrough(new DecompressionStream('gzip')) : blob.stream();
  return JSON.parse(await new Response(stream).text());
}
const newFileName = rev => `${cloud.user().id}/lib-${rev}-${Math.random().toString(36).slice(2, 10)}.bz`;

function hash(snap) {
  const s = JSON.stringify([snap.tracks, snap.albums, snap.playlists, snap.tombstones, snap.ytcache?.length, snap.settings]);
  let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + ':' + s.length;
}

async function localSnap() {
  const snap = await backup.snapshot();
  snap.tombstones = store.tombstones();
  snap.tracks = snap.tracks.map(t => { const x = { ...t }; delete x.hadLocalFile; delete x.localFileId; return x; }).sort((a, b) => a.id < b.id ? -1 : 1);
  snap.albums.sort((a, b) => a.id < b.id ? -1 : 1); snap.playlists.sort((a, b) => a.id < b.id ? -1 : 1);
  delete snap.player; delete snap.profile; delete snap.createdAt;
  // never upload private keys/tokens; they stay on the device they were typed into
  if (snap.settings) { snap.settings = { ...snap.settings }; for (const k of ['ytKey', 'geniusToken', 'googleClientId', 'customInstance']) delete snap.settings[k]; }
  return snap;
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
export function merge(L, R) {
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
  // keep songs that playlists/albums still point at
  const ids = new Set(tracks.map(t => t.id));
  for (const p of playlists) p.trackIds = (p.trackIds || []).filter(i => ids.has(i));
  for (const a of albums) a.trackIds = (a.trackIds || []).filter(i => ids.has(i));
  return {
    app: 'BAZINGA', version: 1, tracks, playlists, albums, tombstones: tomb,
    ytcache: [...yc.entries()].sort((p, q) => p[0] < q[0] ? -1 : 1),
    settings: { ...(R.settings || {}), ...(L.settings || {}) } // this device's own settings win
  };
}

async function applyLocal(m) {
  const cur = new Map((await db.all('tracks')).map(t => [t.id, t]));
  await db.clear('tracks');
  await db.putMany('tracks', m.tracks.map(t => { const c = cur.get(t.id); return c?.localFileId ? { ...t, localFileId: c.localFileId } : t; }));
  await db.clear('albums'); await db.putMany('albums', m.albums);
  await db.clear('playlists'); await db.putMany('playlists', m.playlists);
  for (const [k, v] of m.ytcache || []) await db.put('ytcache', v, k);
  await store.setTombstones(m.tombstones);
  await store.load();
  emit('library'); emit('synced-in');
}

// ---------- profile (username + picture) ----------
async function syncProfile(prof) {
  const local = await kv.get('profile');
  if (!local) return;
  const remoteTs = prof?.updated_at ? Date.parse(prof.updated_at) : 0;
  if (prof && remoteTs > (local.updatedAt || 0) && (prof.username || prof.avatar)) {
    local.username = prof.username || local.username;
    local.picture = prof.avatar ?? local.picture;
    local.updatedAt = remoteTs;
    await kv.set('profile', local); emit('profile-changed', local);
  } else if (!prof || (local.updatedAt || 0) > remoteTs || !prof.username) {
    await cloud.saveProfile({ username: local.username, avatar: local.picture || null, terms_version: local.termsAccepted || null });
  }
}
export async function pushProfile() { if (cloud.signedIn()) { try { const l = await kv.get('profile'); await cloud.saveProfile({ username: l.username, avatar: l.picture || null }); } catch { } } }

// ---------- the sync itself ----------
export function syncNow() {
  if (!cloud.signedIn() || !navigator.onLine) { if (cloud.signedIn()) setStatus('offline'); return Promise.resolve(); }
  if (running) { again = true; return running; }
  running = (async () => {
    setStatus('syncing');
    try {
      do { again = false; await once(); } while (again);
      setStatus('synced');
    } catch (e) {
      console.warn('sync failed', e);
      setStatus('error', /Failed to fetch|NetworkError|Load failed/.test(e.message) ? 'Couldn\'t reach the sync server.' : e.message);
    } finally { running = null; }
  })();
  return running;
}
async function once() {
  const uid = cloud.user().id;
  st = st || (await kv.get('sync:' + uid)) || { rev: 0, hash: '' };
  for (let attempt = 0; attempt < 4; attempt++) {
    let prof = await cloud.getProfile();
    if (!prof) prof = await cloud.saveProfile({});
    if (attempt === 0) await syncProfile(prof);
    const remoteRev = prof.library_rev || 0;
    let local = await localSnap(), base = local, remoteHash = st.hash;
    if (remoteRev > st.rev) {
      let remote = null;
      if (prof.library_file) {
        try { remote = await unpack(await cloud.downloadFile(BUCKET, prof.library_file)); } catch (e) { if (e.status !== 400 && e.status !== 404) throw e; }
      }
      if (remote) {
        base = merge(local, remote);
        remoteHash = hash(remote);
        if (hash(base) !== hash(local)) await applyLocal(base);
      }
      st.rev = remoteRev; st.hash = remoteHash; await kv.set('sync:' + uid, st);
    }
    S.rev = st.rev;
    const h = hash(base);
    if (h === st.hash && remoteRev === st.rev) return; // nothing new to upload
    // Upload under a brand-new file name, then claim the next revision for it.
    // The claim only succeeds if no other device saved in between, so nothing is ever overwritten.
    const next = remoteRev + 1, file = newFileName(next);
    await cloud.uploadFile(BUCKET, file, await pack(base));
    const got = await cloud.rpc('bump_library_rev', { expected: remoteRev, device: device(), file });
    if (got === null || got === undefined || got === '' || (Array.isArray(got) && !got.length)) {
      cloud.deleteFiles(BUCKET, [file]).catch(() => { }); // someone else saved first: drop ours, merge theirs, retry
      continue;
    }
    st.rev = next; st.hash = h; S.rev = next;
    await kv.set('sync:' + uid, st);
    if (prof.library_file) cloud.deleteFiles(BUCKET, [prof.library_file]).catch(() => { });
    return;
  }
  throw new Error('Another device keeps saving — will try again shortly.');
}

// When this device's library belonged to someone else (or to nobody), decide what to do with it
export async function ownerOf() { return kv.get('syncOwner'); }
export async function claim(mode) { // 'merge' | 'replace'
  const uid = cloud.user().id;
  if (mode === 'replace') {
    for (const s of ['tracks', 'albums', 'playlists']) await db.clear(s);
    await store.setTombstones({ t: {}, p: {}, a: {} });
    await store.load(); emit('library');
  }
  await kv.set('syncOwner', uid);
  st = { rev: 0, hash: '' }; await kv.set('sync:' + uid, st);
}

let lastPush = 0;
const schedule = debounce(() => {
  const wait = Math.max(0, lastPush + 30e3 - Date.now());
  setTimeout(() => { lastPush = Date.now(); syncNow(); }, wait);
}, 6000);
export function start() {
  if (!cloud.signedIn()) { setStatus('off'); return; }
  st = null;
  syncNow();
  if (started) return; started = true;
  on('dirty', why => { if (cloud.signedIn() && why !== 'synced') schedule(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && cloud.signedIn() && Date.now() - S.lastSync > 20e3) syncNow(); });
  window.addEventListener('online', () => cloud.signedIn() && syncNow());
  timer = setInterval(() => { if (document.visibilityState === 'visible' && cloud.signedIn()) syncNow(); }, 120e3);
}
export function stop() { st = null; setStatus('off'); }

// Delete everything this user has in the cloud
export async function deleteCloudData() {
  const uid = cloud.user().id;
  try { const files = await cloud.listFiles(BUCKET, uid + '/'); await cloud.deleteFiles(BUCKET, files.map(f => `${uid}/${f.name}`)); } catch { }
  await cloud.rpc('delete_my_account');
}
