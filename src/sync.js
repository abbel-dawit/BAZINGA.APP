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
import { db, kv } from './db.js';
import { emit, on, debounce } from './util.js';
import * as store from './store.js';
import * as backup from './backup.js';

const S = { status: 'off', lastSync: 0, error: '', rev: 0 };
export const state = () => S;
let link = null;         // { secret, since, lastId, lastTs, pubTs, hash }
let keys = null;         // { id, key } derived from link.secret
let running = null, again = false, started = false;

export const available = () => !!window.crypto?.subtle && location.protocol.startsWith('http');
const RELAY = () => ((window.BAZINGA_CONFIG || {}).syncRelay || 'https://ntfy.sh').replace(/\/$/, '');
export const linked = () => !!link?.secret;
export const linkInfo = () => link;

export const deviceName = () => {
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
export const cleanSecret = s => String(s || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
export const cleanCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const appBase = () => location.origin + location.pathname;
export const linkURL = () => link ? `${appBase()}#/link/${link.secret}` : '';
export const codeURL = code => `${appBase()}#/c/${code}`;
// "K7M2-Q9XA"
export const prettyCode = c => c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : c;

// ---------- file format: gzip → AES-GCM → base64 ----------
function toB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function fromB64(b) { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
async function gz(bytes) { return 'CompressionStream' in window ? new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()) : bytes; }
async function gunz(u8) { return u8[0] === 0x1f && u8[1] === 0x8b ? new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()) : u8; }
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
async function relayList(topic, since = 'all') {
  const r = await fetch(`${RELAY()}/${topic}/json?poll=1&since=${since}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(r.status === 429 ? 'Sync is busy — will try again shortly.' : `Sync relay error (${r.status})`);
  return (await r.text()).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(m => m && m.event === 'message').sort((a, b) => a.time - b.time);
}
async function relayPost(topic, body, params) {
  const r = await fetch(`${RELAY()}/${topic}?${new URLSearchParams({ firebase: 'no', ...params })}`, { method: 'POST', body });
  if (!r.ok) throw new Error(r.status === 413 ? 'Your library is too big for the free sync relay.' : r.status === 429 ? 'Sync is busy — will try again shortly.' : `Sync relay error (${r.status})`);
  return r.json();
}
const postFile = (topic, bytes) => relayPost(topic, new Blob([bytes]), { filename: 'library.bz', title: deviceName() });
const postNote = (topic, text) => relayPost(topic, text, {});
const liveFile = m => m.attachment?.url && (!m.attachment.expires || m.attachment.expires * 1000 > Date.now() + 30e3);
async function fetchFile(m) {
  const r = await fetch(m.attachment.url, { cache: 'no-store' });
  if (!r.ok) throw new Error('Couldn\'t download the synced library — will try again.');
  return new Uint8Array(await r.arrayBuffer());
}

function hash(snap) {
  const s = JSON.stringify([snap.tracks, snap.albums, snap.playlists, snap.tombstones, snap.ytcache?.length, snap.profile]);
  let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + ':' + s.length;
}

async function localSnap() {
  const snap = await backup.snapshot();
  snap.tombstones = store.tombstones();
  snap.tracks = snap.tracks.map(t => { const x = { ...t }; delete x.hadLocalFile; delete x.localFileId; return x; }).sort((a, b) => a.id < b.id ? -1 : 1);
  snap.albums.sort((a, b) => a.id < b.id ? -1 : 1); snap.playlists.sort((a, b) => a.id < b.id ? -1 : 1);
  const p = snap.profile;
  snap.profile = p ? { username: p.username || '', picture: p.picture || '', updatedAt: p.updatedAt || 0 } : null;
  delete snap.player; delete snap.createdAt;
  delete snap.settings; // settings (and any private keys/tokens) stay on the device they were set on
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
  const ids = new Set(tracks.map(t => t.id));
  for (const p of playlists) p.trackIds = (p.trackIds || []).filter(i => ids.has(i));
  for (const a of albums) a.trackIds = (a.trackIds || []).filter(i => ids.has(i));
  const lp = L.profile, rp = R.profile;
  const profile = lp && rp ? ((rp.updatedAt || 0) > (lp.updatedAt || 0) ? rp : lp) : (lp || rp || null);
  return {
    app: 'BAZINGA', version: 1, tracks, playlists, albums, tombstones: tomb, profile,
    ytcache: [...yc.entries()].sort((p, q) => p[0] < q[0] ? -1 : 1)
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
  if (m.profile) {
    const local = await kv.get('profile');
    if (local && (m.profile.updatedAt || 0) > (local.updatedAt || 0)) {
      Object.assign(local, { username: m.profile.username || local.username, picture: m.profile.picture ?? local.picture, updatedAt: m.profile.updatedAt });
      await kv.set('profile', local); emit('profile-changed', local);
    }
  }
  await store.load();
  emit('library'); emit('synced-in');
}

// ---------- the sync itself ----------
async function saveLink() { if (link) await kv.set('syncLink', link); else await kv.del('syncLink'); }
export function syncNow() {
  if (!link || !available()) return Promise.resolve();
  if (!navigator.onLine) { setStatus('offline'); return Promise.resolve(); }
  if (running) { again = true; return running; }
  running = (async () => {
    setStatus('syncing');
    try {
      do { again = false; await once(); } while (again && link);
      if (link) setStatus('synced');
    } catch (e) {
      console.warn('sync failed', e);
      setStatus('error', /Failed to fetch|NetworkError|Load failed/.test(e.message) ? 'Couldn\'t reach the sync server.' : e.message);
    } finally { running = null; }
  })();
  return running;
}
async function once() {
  keys = keys || await derive(link.secret);
  const topic = topicOf(keys.id);
  const msgs = (await relayList(topic, link.lastTs ? Math.max(0, link.lastTs - 5) : 'all')).filter(m => m.id !== link.lastId && (!link.seen || !link.seen.includes(m.id)));
  // "Turn off sync everywhere" from another device
  for (const m of msgs) if (!m.attachment && m.message && m.time * 1000 > (link.since || 0)) {
    try { const note = await open(fromB64(m.message)); if (note?.t === 'off') { await leave(); emit('sync-removed'); return; } } catch { }
  }
  const latest = [...msgs].reverse().find(liveFile);
  const local = await localSnap();
  let base = local;
  if (latest) {
    const remote = await open(await fetchFile(latest));
    base = merge(local, remote);
    if (hash(base) !== hash(local)) await applyLocal(base);
    link.hash = hash(remote); link.lastId = latest.id; link.lastTs = latest.time; link.pubTs = Math.max(link.pubTs || 0, latest.time);
  }
  if (msgs.length) { link.seen = msgs.slice(-20).map(m => m.id); link.lastTs = Math.max(link.lastTs || 0, msgs[msgs.length - 1].time); }
  await saveLink();
  const h = hash(base);
  const fresh = Date.now() / 1000 - (link.pubTs || 0) < 50 * 60; // the relay keeps copies ~3 h: refresh hourly
  if (h === link.hash && fresh) return;
  const res = await postFile(topic, await seal(base));
  link.hash = h; link.lastId = res.id; link.lastTs = res.time; link.pubTs = res.time;
  await saveLink();
}

// ---------- start / join / leave ----------
// Turn sync on for the first time on this device (makes a new sync key and posts the library)
export async function create() {
  if (!available()) throw new Error('Device sync needs the online (GitHub Pages) version of BAZINGA!.');
  link = { secret: newSecret(), since: Date.now() }; keys = null;
  await saveLink();
  await syncNow();
  if (S.status === 'error') { const err = S.error; link = null; keys = null; await saveLink(); setStatus('off'); throw new Error(err); }
  start();
  return link;
}
// Is there a recent library posted under this key? (shown before joining)
export async function peek(secret) {
  const k = await derive(secret);
  const m = [...await relayList(topicOf(k.id))].reverse().find(liveFile);
  return m ? { device: m.title || '', updatedAt: m.time * 1000 } : null;
}
// Join an existing sync key. mode: 'merge' (combine with what's here) | 'replace' (use only the linked library)
export async function join(secret, mode = 'merge') {
  secret = cleanSecret(secret);
  if (secret.length < 16) throw new Error('That sync link isn\'t complete — copy the whole link and try again.');
  const found = await peek(secret).catch(() => null);
  if (mode === 'replace' && found) {
    for (const s of ['tracks', 'albums', 'playlists']) await db.clear(s);
    await store.setTombstones({ t: {}, p: {}, a: {} });
    const p = await kv.get('profile'); if (p) { p.updatedAt = 0; await kv.set('profile', p); }
    await store.load(); emit('library');
  }
  link = { secret, since: Date.now() }; keys = null;
  await saveLink();
  await syncNow();
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
export async function makeCode() {
  if (!link) await create();
  const r = crypto.getRandomValues(new Uint8Array(8));
  const code = [...r].map(b => CODE_ABC[b % 32]).join('');
  const k = await codeKeys(code);
  await postNote(k.topic, toB64(await sealWith(k.key, { s: link.secret, exp: Date.now() + 15 * 60e3 })));
  return code;
}
export async function redeemCode(code) {
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
export async function leave() { link = null; keys = null; await saveLink(); setStatus('off'); }
// Tell every linked device to stop syncing (each keeps its music)
export async function removeEverywhere() {
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
export async function restore() { link = await kv.get('syncLink'); if (link?.secret) start(); else setStatus('off'); }
export function start() {
  if (!link) { setStatus('off'); return; }
  syncNow();
  if (started) return; started = true;
  on('dirty', why => { if (link && why !== 'synced') schedule(); });
  document.addEventListener('visibilitychange', () => {
    if (!link) return;
    if (document.visibilityState === 'visible' && Date.now() - S.lastSync > 15e3) syncNow();
    if (document.visibilityState === 'hidden') syncNow(); // save before the browser is closed
  });
  window.addEventListener('online', () => link && syncNow());
  setInterval(() => { if (document.visibilityState === 'visible' && link) syncNow(); }, 90e3);
}
