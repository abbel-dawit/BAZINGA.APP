// Share links, v2 — the whole song / playlist / album still travels inside the link (nothing is uploaded),
// written much more compactly than v1:
//  • plain text (tab between fields, one line per song) instead of JSON, compressed with deflate
//  • anything the same as the song above is written as one character (album, artist, year, cover…)
//  • the long picture addresses of the music stores are cut down to the part that changes
//  • the audio version is "=" when it's the same video as the music video; times are in seconds
//  • a playlist carries full covers for its first few songs only: the rest show the song's video picture
//    until it's saved, and the saving device then finds the proper covers by itself (like any import)
// Old v1 links ("z…" / "j…") keep working: unpackShare reads both.
import { yearOf, unpackString } from './util.js';

const G = globalThis;
const b64u = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = s => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/')); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
async function squeeze(bytes, how) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new G.CompressionStream(how))).arrayBuffer()); }
async function unsqueeze(bytes, how) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new G.DecompressionStream(how))).arrayBuffer()); }

// ---------- covers, written short ----------
// Apple:   https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/ab/cd/ef/abcdef12-…/file.jpg/600x600bb.jpg
// Deezer:  https://cdn-images.dzcdn.net/images/cover/<md5>/500x500-000000-80-0-0.jpg
// YouTube: https://i.ytimg.com/vi/<id>/hqdefault.jpg   (usually the song's own video: one letter)
// Spotify: https://i.scdn.co/image/<hash>
const RE_APPLE = /^https?:\/\/is\d+-ssl\.mzstatic\.com\/image\/thumb\/(.+)\/(\d+)x\2bb\.(jpg|png|webp)$/i;
const RE_APPLE_UUID = /^([A-Za-z]+)(\d*)\/v4\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\/(.+)$/;
const RE_DEEZER = /^https?:\/\/(?:e-cdns-images|cdn-images|cdns-images)\.dzcdn\.net\/images\/(cover|artist)\/([0-9a-f]{32})\/(\d+)x\3-000000-80-0-0\.jpg$/i;
const RE_YT = /^https?:\/\/i\d?\.ytimg\.com\/vi\/([\w-]{11})\/(\w+)\.jpg$/;
const RE_SPOT = /^https?:\/\/i\.scdn\.co\/image\/([0-9a-f]{40})$/;
function artOut(u, vid, aid) {
  if (!u || u.startsWith('data:')) return '';
  let m = RE_APPLE.exec(u);
  if (m) {
    const ext = m[3].toLowerCase() === 'jpg' ? '' : '|' + m[3].toLowerCase();
    const k = RE_APPLE_UUID.exec(m[1]);
    if (k && k[6].startsWith(k[3] + k[4] + k[5])) return 'A' + (k[1] === 'Music' ? '' : k[1] + '!') + k[2] + '.' + k[6] + k[7] + k[8] + k[9] + k[10] + '/' + k[11] + ext;
    return 'a' + m[1] + ext;
  }
  if ((m = RE_DEEZER.exec(u))) return (m[1] === 'cover' ? 'd' : 'D') + m[2];
  if ((m = RE_YT.exec(u))) {
    const tail = m[2] === 'hqdefault' ? '' : '/' + m[2];
    if (!tail && m[1] === vid) return 'v';
    if (!tail && m[1] === aid) return 'u';
    return 'Y' + m[1] + tail;
  }
  if ((m = RE_SPOT.exec(u))) return 's' + m[1];
  return /^https?:\/\//.test(u) ? u : '';
}
function artIn(c, vid, aid) {
  if (!c) return '';
  if (c.startsWith('http')) return c;
  const k = c[0], r = c.slice(1);
  if (k === 'A') {
    const m = /^(?:([A-Za-z]+)!)?(\d*)\.([0-9a-f]{32})\/(.+?)(?:\|(\w+))?$/.exec(r); if (!m) return '';
    const h = m[3], uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    return `https://is1-ssl.mzstatic.com/image/thumb/${m[1] || 'Music'}${m[2]}/v4/${h.slice(0, 2)}/${h.slice(2, 4)}/${h.slice(4, 6)}/${uuid}/${m[4]}/600x600bb.${m[5] || 'jpg'}`;
  }
  if (k === 'a') { const m = /^(.+?)(?:\|(\w+))?$/.exec(r); return `https://is1-ssl.mzstatic.com/image/thumb/${m[1]}/600x600bb.${m[2] || 'jpg'}`; }
  if (k === 'd' || k === 'D') return `https://cdn-images.dzcdn.net/images/${k === 'd' ? 'cover' : 'artist'}/${r}/500x500-000000-80-0-0.jpg`;
  if (k === 'v' || k === 'u') { const id = k === 'v' ? vid : aid; return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : ''; }
  if (k === 'Y') { const [id, q] = r.split('/'); return `https://i.ytimg.com/vi/${id}/${q || 'hqdefault'}.jpg`; }
  if (k === 's') return `https://i.scdn.co/image/${r}`;
  return '';
}
// The address a cover comes back as (Apple / Deezer pictures come back at the size BAZINGA! asks for anyway)
export const artNormal = (u, vid, aid) => artIn(artOut(u, vid, aid), vid, aid);

// ---------- pack / unpack ----------
const clean = v => String(v ?? '').replace(/[\t\n\r]+/g, ' ').trim();
// a real value that looks like one of the short marks (" or =) is written with a \ in front
const mark = v => (v === '"' || v === '=' || v.startsWith('\\') ? '\\' + v : v);
const unmark = v => (v.startsWith('\\') ? v.slice(1) : v);
const ART_KEEP = 6;
const KINDS = { song: 's', playlist: 'p', album: 'a' }, KIND_OF = { s: 'song', p: 'playlist', a: 'album' };
// tracks: [{ title, artist, album, year, genre, durationMs, artwork, video, audio }]
export function shareText({ kind, name, by, artwork, tracks, keepArt = kind === 'playlist' ? ART_KEEP : Infinity }) {
  const ts = tracks.map(t => ({
    title: clean(t.title), artist: clean(t.artist), album: clean(t.album), year: +t.year || '', genre: clean(t.genre),
    dur: t.durationMs ? Math.round(t.durationMs / 1000) : '', vid: clean(t.video), aid: clean(t.audio), art: t.artwork || ''
  }));
  // what most songs share (an album: the album, artist, year and genre) goes in the first line once
  const common = f => { const v = ts[0]?.[f]; return ts.length > 1 && ts.every(t => t[f] === v) ? v : ''; };
  const head = { album: common('album'), artist: common('artist'), year: common('year'), genre: common('genre') };
  const headArt = artOut(artwork || '', '', '');
  const lines = ['B2\t' + [KINDS[kind] || 'p', clean(name), clean(by), headArt, mark(head.album), mark(head.artist), head.year, mark(head.genre)].join('\t').replace(/\t+$/, '')];
  let prev = { ...head, art: headArt };
  ts.forEach((t, n) => {
    let art = artOut(t.art, t.vid, t.aid);
    // past the first few songs, a cover that would cost a whole address is left out (a cover that's the
    // same as the one above, or the playlist's own, costs one character and stays)
    if (n >= keepArt && art && art !== headArt && art !== prev.art && !'vu'.includes(art)) art = '';
    const same = (f, v) => (v !== '' && v === prev[f] ? '"' : mark(String(v)));
    const f = [
      t.title,
      same('artist', t.artist),
      same('album', t.album),
      same('year', t.year),
      same('genre', t.genre),
      String(t.dur),
      art && art === headArt && !'vu'.includes(art) ? '=' : art && art === prev.art && !'vu'.includes(art) ? '"' : art,
      t.vid,
      t.aid && t.aid === t.vid ? '=' : t.aid
    ];
    lines.push(f.join('\t').replace(/\t+$/, ''));
    prev = { artist: t.artist, album: t.album, year: t.year, genre: t.genre, art };
  });
  return lines.join('\n');
}
export function parseShareText(text) {
  const lines = text.split('\n');
  const h = lines[0].split('\t');
  if (h[0] !== 'B2') throw new Error('Not a BAZINGA! share');
  const d = { k: KIND_OF[h[1]] || 'playlist', n: h[2] || '', by: h[3] || '', a: artIn(h[4] || '', '', ''), t: [] };
  let prev = { album: unmark(h[5] || ''), artist: unmark(h[6] || ''), year: +h[7] || 0, genre: unmark(h[8] || ''), art: h[4] || '' };
  const headArt = h[4] || '';
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const f = line.split('\t');
    const pick = (i, k) => (f[i] === '"' ? prev[k] : unmark(f[i] ?? ''));
    const vid = f[7] || '', aid = f[8] === '=' ? vid : (f[8] || '');
    const artCode = f[6] === '=' ? headArt : f[6] === '"' ? prev.art : (f[6] || '');
    const t = { title: f[0] || '', artist: pick(1, 'artist'), album: pick(2, 'album'), year: +pick(3, 'year') || 0, genre: pick(4, 'genre'), dur: +f[5] || 0 };
    d.t.push([t.title, t.artist, t.album, t.year, t.genre, t.dur * 1000, artIn(artCode, vid, aid), vid, aid]);
    prev = { artist: t.artist, album: t.album, year: t.year, genre: t.genre, art: artCode };
  }
  return d;
}
const canSqueeze = () => 'CompressionStream' in G && 'DecompressionStream' in G;
// "y…" = v2 compressed;  "x…" = v2 uncompressed (browsers without compression, e.g. iPhones before iOS 16.4)
export async function packShare(o) {
  const bytes = new TextEncoder().encode(shareText(o));
  if (canSqueeze()) { try { return 'y' + b64u(await squeeze(bytes, 'deflate-raw')); } catch { } }
  return 'x' + b64u(bytes);
}
export async function unpackShare(str) {
  str = String(str || '').trim();
  const mode = str[0];
  if (mode === 'y' || mode === 'x') {
    let bytes = unb64u(str.slice(1));
    if (mode === 'y') {
      if (!canSqueeze()) throw new Error('This browser is too old to open this link — update it, or open the link in Chrome.');
      bytes = await unsqueeze(bytes, 'deflate-raw');
    }
    return parseShareText(new TextDecoder().decode(bytes));
  }
  return unpackString(str); // v1
}
// Pull a BAZINGA! link out of anything pasted or scanned (a whole message, a link from another copy of
// BAZINGA!, a link the chat app wrapped onto two lines…)
export function findShareRef(text) {
  const s = String(text || '').replace(/\s+/g, '');
  let m = s.match(/#\/(s|r)\/([A-Za-z0-9_\-.~%]+)/);
  if (m) return { kind: m[1], data: decodeURIComponent(m[2]) };
  m = s.match(/#\/(link|c)\/([A-Za-z0-9_-]+)/);
  if (m) return { kind: m[1], data: m[2] };
  if (/^[yxzj][A-Za-z0-9_-]{40,}$/.test(s)) return { kind: 's', data: s };
  return null;
}
export { yearOf };
