// Shared helpers
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const uid = (p = 'id') => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Normalise a title/artist for matching ("Song (feat. X) - Remastered 2011" -> "song")
export function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\s*[\(\[][^\)\]]*(feat|ft\.|with|remaster|version|edit|mono|stereo|live|deluxe)[^\)\]]*[\)\]]/g, '')
    .replace(/\s+-\s+.*(remaster|version|edit|mono|stereo|live).*$/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
export const mainArtist = a => String(a || '').split(/;|,|&| feat\.? | ft\.? | x /i)[0].trim();
// "A;B;C" or "A, B, C" -> ["A","B","C"]
export const splitArtists = s => String(s || '').split(String(s).includes(';') ? ';' : /\s*,\s*/).map(x => x.trim()).filter(Boolean);
// Show only the main artist; featured artists go into the title: "Tapout (feat. Lil Wayne, Birdman & Future)"
export function displayTitle(t) {
  if (!t) return '';
  const others = (t.artists || []).slice(1).filter(a => a && norm(a) !== norm(t.artist));
  if (!others.length || /\((feat|ft|with)\b|\bfeat\.|\bft\./i.test(t.title)) return t.title;
  const list = others.length === 1 ? others[0] : others.slice(0, -1).join(', ') + ' & ' + others[others.length - 1];
  return `${t.title} (feat. ${list})`;
}
export const trackKey = (artist, title) => 't_' + norm(mainArtist(artist)) + '|' + norm(title);
export const albumKey = (artist, title) => 'a_' + norm(mainArtist(artist)) + '|' + norm(title);

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
export const fmtDur = ms => ms ? fmtTime(ms / 1000) : '';
export const yearOf = d => { const m = String(d || '').match(/\d{4}/); return m ? +m[0] : null; };

export function debounce(fn, ms = 300) {
  let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Event bus
const bus = new EventTarget();
export const on = (ev, fn) => bus.addEventListener(ev, e => fn(e.detail));
export const emit = (ev, detail) => bus.dispatchEvent(new CustomEvent(ev, { detail }));
export const toast = (msg, kind = 'info') => emit('toast', { msg, kind });

// JSONP (used for Apple's free iTunes Search API, which doesn't always send CORS headers)
let jsonpN = 0;
export function jsonp(url, timeout = 12000) {
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
export function imageToDataURL(file, size = 256) {
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

export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// base64url + deflate for compact share links
export async function packToString(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let out = bytes;
  if ('CompressionStream' in window) {
    const cs = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    out = new Uint8Array(await new Response(cs).arrayBuffer());
  }
  let bin = ''; out.forEach(b => bin += String.fromCharCode(b));
  return ('CompressionStream' in window ? 'z' : 'j') + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function unpackString(str) {
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

export function hashColor(s) {
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
export function broadGenre(raw) {
  if (!raw) return '';
  const k = String(raw);
  if (genreMemo.has(k)) return genreMemo.get(k);
  const s = k.toLowerCase().replace(/[_]+/g, ' ');
  let out = '';
  if (!/^(unknown|other|misc|none|—|-|\?|music|various)$/i.test(s.trim())) out = (GENRE_RULES.find(([, re]) => re.test(s)) || [''])[0];
  genreMemo.set(k, out);
  return out;
}
export const genreOf = t => broadGenre(t?.genre);
