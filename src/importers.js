// Importers that need no account at all: CSV exports (e.g. Exportify), pasted
// text lists, and music files already on the device (read their tags).
import { trackKey, albumKey, yearOf, splitArtists } from './util.js';

export function parseCSV(text) {
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
export function isAlbumCSV(text) {
  const head = (parseCSV(text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0])[0] || []).map(x => x.trim().toLowerCase());
  return head.includes('album name') && !head.some(x => x === 'track name' || x === 'title' || x === 'song');
}
export function tracksFromCSV(text) {
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
export function tracksFromText(text) {
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

export async function readLocalFile(file) {
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

export const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm|mp4)$/i;

// ---------- Apple Music / iTunes exports ----------
// Music app (Mac) or Apple Music / iTunes (Windows):
//   File → Library → Export Playlist…  → "Plain Text" (.txt, UTF-16, tab separated)
//   File → Library → Export Library…   → .xml (every playlist + Loved songs)
export async function readTextSmart(file) {
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
export function tracksFromAppleTxt(text) {
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
export function fromAppleXML(text) {
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
export async function unzipText(file, want = n => /\.csv$/i.test(n)) {
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
