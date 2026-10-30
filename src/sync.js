// No-login, no-setup device sync.
// A "sync key" (a long random secret made on the first device) is the only thing that ties
// devices together. Other devices and browsers join by scanning a QR code, opening a link, or
// typing a short code that works for 15 minutes. Nothing about the person is ever asked for.
//
// Transport: the free public ntfy.sh relay (no account, nothing for the app owner to set up).
// The whole library (songs, likes, playlists, albums, YouTube matches, name & picture) is
// compressed and ENCRYPTED on the device with a key derived from the sync key, then posted to a
// topic whose name is a one-way hash of that key. ntfy.sh only ever sees unreadable bytes.
// Copies on the relay last about 3 hours. Changes (a like, a playlist edit, a setting…) go out right away
// as a small "delta" with only what changed, and every linked device that's open hears about it within
// seconds (live connection to the relay). The whole library is re-sent every couple of hours so a
// complete copy is always there for devices that were closed. Devices merge whatever is newer
// (newest edit wins per item, likes merge separately, deletions are remembered).
// What's playing (song, spot, queue) travels too, so you can continue on another device.
import { db, kv, SYNC_KV, onSyncedKvChange } from './db.js';
import { emit, on, debounce } from './util.js';
import * as store from './store.js';
import * as backup from './backup.js';
import * as player from './player.js';

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
// A random id for this browser, so it can tell its own messages and "now playing" from other devices'
const DEV = (() => { try { let d = localStorage.getItem('bz_dev'); if (!d) { d = Math.random().toString(36).slice(2, 12); localStorage.setItem('bz_dev', d); } return d; } catch { return 'x' + Math.random().toString(36).slice(2, 10); } })();
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
export function cancel() { abortCtl?.abort(); }
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
        if (res?.id) mine.add(res.id);
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
export function mergeSettings(L, R) {
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

// ---------- deltas: only what changed since the last send ----------
function changesSince(snap, t) {
  const after = x => x > t;
  const d = {
    t: 'delta', dev: DEV,
    tracks: snap.tracks.filter(x => after(Math.max(x.updatedAt || 0, x.likeTs || 0))),
    playlists: snap.playlists.filter(x => after(x.updatedAt || x.createdAt || 0)),
    albums: snap.albums.filter(x => after(x.updatedAt || x.savedAt || 0)),
    tombstones: Object.fromEntries(['t', 'p', 'a'].map(k => [k, Object.fromEntries(Object.entries(snap.tombstones?.[k] || {}).filter(([, ts]) => after(ts)))])),
    profile: snap.profile && after(snap.profile.updatedAt || 0) ? snap.profile : null,
    settings: (() => { const st = snap.settings; if (!st) return null; const keys = Object.keys(st.ts).filter(k => after(st.ts[k])); return keys.length ? { values: Object.fromEntries(keys.map(k => [k, st.values[k]])), ts: Object.fromEntries(keys.map(k => [k, st.ts[k]])) } : null; })(),
    kvx: Object.fromEntries(Object.entries(snap.kvx || {}).filter(([, r]) => after(r.ts || 0))),
    ytcache: []
  };
  const empty = !d.tracks.length && !d.playlists.length && !d.albums.length && !['t', 'p', 'a'].some(k => Object.keys(d.tombstones[k]).length) && !d.profile && !d.settings && !Object.keys(d.kvx).length;
  return empty ? null : d;
}
// The newer of two "now playing" states
const newerNow = (a, b) => !a ? b : !b ? a : ((b.at || 0) > (a.at || 0) ? b : a);

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
export async function syncNow({ interactive = false } = {}) {
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
let playerWanted = false, lastPlayerPost = 0;
const mine = new Set(); // ids of messages this device posted (no need to read them back)
async function post(topic, bytesOrNote) {
  const res = bytesOrNote; if (res?.id) { mine.add(res.id); if (mine.size > 200) mine.delete(mine.values().next().value); }
  return res;
}
async function once() {
  keys = keys || await derive(link.secret);
  const topic = topicOf(keys.id);
  const startedAt = Date.now();
  step('Checking for changes…', 6);
  const msgs = (await relayList(topic, link.lastTs ? Math.max(0, link.lastTs - 5) : 'all'))
    .filter(m => m.id !== link.lastId && !mine.has(m.id) && (!link.seen || !link.seen.includes(m.id)));
  // Notes: "turn off sync everywhere", and small changes sent as text
  const deltas = [];
  for (const m of msgs) {
    if (m.attachment) { if (m.attachment.name === 'delta.bz' && liveFile(m)) deltas.push({ m }); continue; }
    if (!m.message || m.time * 1000 <= (link.since || 0) - 60e3) continue;
    try {
      const note = await open(fromB64(m.message));
      if (note?.t === 'off' && m.time * 1000 > (link.since || 0)) { await leave(); emit('sync-removed'); return; }
      if (note?.t === 'delta' && note.dev !== DEV) deltas.push({ m, data: note });
    } catch { }
  }
  const latest = [...msgs].reverse().find(m => liveFile(m) && m.attachment.name !== 'delta.bz');
  const local = await localSnap();
  // what changed here since the last send (captured before anything from other devices is merged in)
  const pending = link.deltaFrom ? changesSince(local, link.deltaFrom) : null;
  let base = local, replaced = false, remoteNow = null;
  if (latest) {
    step('Downloading your music…', 15);
    const bytes = await fetchLibrary(topic, latest);
    if (!bytes) { setTimeout(() => link && syncNow(), 20e3); return; } // another device is still sending its parts: check again in 20 s
    const remote = await open(bytes);
    if (sig()?.aborted) throw new DOMException('cancelled', 'AbortError');
    step('Merging with this device…', 75);
    // Joining with "use only the synced library": swap it in now that it has fully arrived
    // (a cancelled download leaves this device untouched; settings are never wiped, only merged)
    if (link.replace) { replaced = true; local.tracks = []; local.albums = []; local.playlists = []; local.tombstones = { t: {}, p: {}, a: {} }; if (local.profile) local.profile.updatedAt = 0; delete link.replace; }
    base = merge(local, remote);
    if (remote.now?.dev !== DEV) remoteNow = newerNow(remoteNow, remote.now);
    link.lastId = latest.id; link.pubTs = Math.max(link.pubTs || 0, latest.time);
  }
  // small changes from other devices, oldest first
  for (const d of deltas.sort((a, b) => a.m.time - b.m.time)) {
    try {
      const data = d.data || await open(await fetchFile(d.m));
      if (data.dev === DEV) continue;
      base = merge(base, data);
      remoteNow = newerNow(remoteNow, data.now);
    } catch (e) { if (isAbort(e)) throw e; }
  }
  if (replaced || hash(base) !== hash(local)) { step('Saving to this device…', 85); await applyLocal(base); }
  // continue where you left off on another device (only if nothing is playing here)
  if (remoteNow && remoteNow.dev !== DEV && (remoteNow.at || 0) > player.lastActive() && player.adopt(remoteNow)) emit('player-adopted', remoteNow);
  if (msgs.length) { link.seen = msgs.slice(-30).map(m => m.id); link.lastTs = Math.max(link.lastTs || 0, msgs[msgs.length - 1].time); }
  link.deltaFrom = startedAt;
  await saveLink();
  // ---- send ----
  const now = Date.now() / 1000;
  const stale = !link.pubTs || now - link.pubTs > 140 * 60 || !link.hash; // keep a full copy on the relay (copies last ~3 h)
  const withNow = playerWanted && player.syncState().queue.length ? { ...player.syncState(), dev: DEV, device: deviceName() } : null;
  if (stale) {
    step('Sending your library to your other devices…', 92);
    const full = { ...base, now: { ...player.syncState(), dev: DEV, device: deviceName() } };
    const res = await post(topic, await postLibrary(topic, await seal(full)));
    link.hash = hash(base); link.lastId = res.id; link.lastTs = res.time; link.pubTs = res.time;
    playerWanted = false; lastPlayerPost = Date.now();
  } else if (pending || withNow) {
    step('Sending your changes…', 94);
    const d = pending || { t: 'delta', dev: DEV, tracks: [], playlists: [], albums: [], tombstones: { t: {}, p: {}, a: {} }, ytcache: [] };
    if (withNow) d.now = withNow;
    const sealed = await seal(d), b64 = toB64(sealed);
    // small enough for a plain message (no file storage used on the relay), otherwise a small file
    const res = await post(topic, b64.length <= 3900 ? await postNote(topic, b64) : await relayPost(topic, new Blob([sealed]), { filename: 'delta.bz', title: deviceName() }));
    if (res?.time) link.lastTs = Math.max(link.lastTs || 0, res.time);
    if (withNow) { playerWanted = false; lastPlayerPost = Date.now(); }
  }
  await saveLink();
}
// "What's playing" changed: send it to the other devices (right away when you pause or leave the app;
// at most every 3 minutes for song changes — the free relay allows ~250 messages a day)
let playerT = null;
export function notePlayer(kind) {
  if (!link) return;
  playerWanted = true;
  clearTimeout(playerT);
  const wait = kind === 'track' ? Math.max(4000, lastPlayerPost + 180e3 - Date.now()) : 1500;
  playerT = setTimeout(() => link && syncNow(), wait);
}

// ---------- live updates: hear about other devices' changes within seconds ----------
let es = null;
function listen() {
  try { es?.close(); } catch { }
  es = null;
  if (!link || !window.EventSource) return;
  (keys ? Promise.resolve(keys) : derive(link.secret)).then(k => {
    keys = keys || k;
    if (!link) return;
    es = new EventSource(`${RELAY()}/${topicOf(keys.id)}/sse`);
    let t = null;
    es.onmessage = e => {
      let m = null; try { m = JSON.parse(e.data); } catch { }
      if (!m || m.event !== 'message' || mine.has(m.id)) return;
      clearTimeout(t); t = setTimeout(() => link && syncNow(), 800);
    };
  }).catch(() => { });
}

// ---------- start / join / leave ----------
// Turn sync on for the first time on this device (makes a new sync key and posts the library)
export async function create() {
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
export async function peek(secret) {
  const k = await derive(secret);
  const m = [...await relayList(topicOf(k.id))].reverse().find(liveFile);
  return m ? { device: m.title || '', updatedAt: m.time * 1000 } : null;
}
// Join an existing sync key. mode: 'merge' (combine with what's here) | 'replace' (use only the linked library)
export async function join(secret, mode = 'merge') {
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
export async function leave() { link = null; keys = null; try { es?.close(); } catch { } es = null; await saveLink(); setStatus('off'); }
// Tell every linked device to stop syncing (each keeps its music)
export async function removeEverywhere() {
  if (!link) return;
  keys = keys || await derive(link.secret);
  await postNote(topicOf(keys.id), toB64(await seal({ t: 'off', at: Date.now() })));
  await leave();
}

// A change was made here: send it within a few seconds (several quick changes go out together)
let lastPush = 0;
const schedule = debounce(() => {
  const wait = Math.max(0, lastPush + 8e3 - Date.now());
  setTimeout(() => { lastPush = Date.now(); syncNow(); }, wait);
}, 2500);
export async function restore() { link = await kv.get('syncLink'); if (link?.secret) start(); else setStatus('off'); }
export function start() {
  if (!link) { setStatus('off'); return; }
  syncNow();
  listen();
  if (started) return; started = true;
  on('dirty', why => { if (link && why !== 'synced') schedule(); });
  onSyncedKvChange(() => { if (link) schedule(); });
  document.addEventListener('visibilitychange', () => {
    if (!link) return;
    if (document.visibilityState === 'visible') { if (Date.now() - S.lastSync > 5e3) syncNow(); if (!es || es.readyState === 2) listen(); }
    if (document.visibilityState === 'hidden') { playerWanted = true; syncNow(); } // save (and hand over what's playing) before the app is closed
  });
  window.addEventListener('online', () => { if (link) { syncNow(); listen(); } });
  setInterval(() => { if (document.visibilityState === 'visible' && link) syncNow(); }, 90e3);
}
