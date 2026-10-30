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
import { db } from './db.js';
import { norm, mainArtist, sleep } from './util.js';

let settings = { ytKey: '', customInstance: '', ownerKey: '' }; // ownerKey: app-wide backup key from index.html
export const setYTSettings = s => { settings = { ...settings, ...s }; };

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
export function startInstances() {
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
export async function proxySearch(q, ms = 8000) {
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
export async function rawSearch(q, { preferFree = false, prefer = null } = {}) {
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
  if (r.views > 1e6) s += 1;
  return s;
}
function pick(list, t, mode, notId) {
  const b = list.filter(r => r.id !== notId).map(r => [score(r, t, mode), r]).sort((a, b) => b[0] - a[0])[0];
  return b && b[0] >= 8 ? b[1] : null;
}

const inflight = new Map();
const hot = new Map(); // matches already looked up this session (skips the database round-trip)
export function forget(id) { id ? hot.delete(id) : hot.clear(); }
export function findForTrack(t, { force = false, prefer = null, need = null } = {}) {
  if (!t) return Promise.reject(new Error('No song'));
  if (!force && hot.has(t.id)) return Promise.resolve(hot.get(t.id));
  if (!force && inflight.has(t.id)) return inflight.get(t.id);
  const p = (async () => {
    if (!force) {
      const c = await db.get('ytcache', t.id);
      if (c && (c.video || c.audio)) { hot.set(t.id, c); if (hot.size > 2000) hot.delete(hot.keys().next().value); return c; }
    }
    const base = `${mainArtist(t.artist)} ${t.title.replace(/\s*[\(\[](feat|ft|with)[^\)\]]*[\)\]]/i, '')}`;
    const out = { video: null, audio: null, videoTitle: '', audioTitle: '', checkedAt: Date.now() };
    let list = await rawSearch(base, { prefer });
    let v = pick(list, t, 'video'), a = pick(list, t, 'audio', v?.id);
    const save = async () => {
      if (v) { out.video = v.id; out.videoTitle = v.title; }
      if (a) { out.audio = a.id; out.audioTitle = a.title; }
      if (!out.video && !out.audio && list[0]) { out.audio = list[0].id; out.audioTitle = list[0].title; out.guess = true; }
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
export async function matchMany(tracks, { onProgress, isCancelled } = {}) {
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

export async function setManual(trackId, mode, id, title = '') {
  const c = (await db.get('ytcache', trackId)) || {};
  c[mode] = id; c[mode + 'Title'] = title || 'Set manually'; c.manual = true; c.checkedAt = Date.now();
  await db.put('ytcache', c, trackId);
  hot.set(trackId, c);
  return c;
}

export const thumb = (id, q = 'hqdefault') => id ? `https://i.ytimg.com/vi/${id}/${q}.jpg` : '';

export function parseYouTubeId(input) {
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
export function videoToSong(r) {
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
export function youtubePlaylistLinks(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) out.push('https://www.youtube.com/watch_videos?video_ids=' + ids.slice(i, i + 50).join(','));
  return out;
}

// ---------- public playlists (no sign-in) ----------
export function parsePlaylistId(input) {
  const s = String(input || '').trim();
  if (/^(PL|UU|LL|FL|OLAK5uy_|RD)[\w-]{10,}$/.test(s)) return s;
  try { return new URL(s).searchParams.get('list'); } catch { return null; }
}
export async function publicPlaylist(listId) {
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
