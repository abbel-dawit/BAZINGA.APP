// "Hey BAZINGA!" — voice assistant.
// Listens with the browser's speech recognition, understands everyday phrasing,
// and answers out loud with the most natural voice the device has
// (e.g. Siri/"Enhanced"/"Premium" voices on Apple, "Natural" voices on Edge/Windows, Google voices on Chrome/Android).
// Browsers without speech recognition (e.g. Firefox) get a text box instead — it still talks back.
import { lib } from './store.js';
import * as store from './store.js';
import * as meta from './meta.js';
import * as player from './player.js';
import { P } from './player.js';
import { $, esc, norm, mainArtist, displayTitle, emit } from './util.js';

const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
// Brave ships the speech API but can't reach Google's speech service, so it gets the text box instead
export const canListen = !!Rec && !navigator.brave;
let app = null;           // hooks from app.js: { go, search, openNP, closeNP, lyrics, back, toast }
let rec = null, listening = false, open = false, ducked = false, keep = false, closeTimer = null, usedMic = false;

const rand = a => a[Math.floor(Math.random() * a.length)];

// ---------- voice output ----------
let voice = null;
// Rank every voice the device has: natural/neural voices first, robotic & novelty voices last.
// (Browsers can't use Siri's own voice, but Apple's Premium/Enhanced voices, Edge's "Natural"
// voices and Chrome's Google voices sound close to it.)
const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|pipe organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy|princess|bruce|agnes|vicki|victoria|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley|espeak|compact|robot|novelty)\b/i;
function voiceScore(v) {
  const lang = (navigator.language || 'en-US').toLowerCase(), base = lang.slice(0, 2);
  const vl = v.lang.toLowerCase().replace('_', '-'), n = v.name;
  let s = 0;
  if (vl === lang) s += 40; else if (vl.startsWith(base)) s += 28; else return -100;
  if (/natural|neural/i.test(n)) s += 60;                          // Edge / Windows "… Online (Natural)"
  if (/premium/i.test(n)) s += 58;                                 // Apple downloadable Premium voices
  if (/enhanced/i.test(n)) s += 50;                                // Apple Enhanced
  if (/siri/i.test(n)) s += 55;
  if (/^google /i.test(n)) s += 34;                                // Chrome network voices
  if (/\b(ava|zoe|evan|nathan|noelle|samantha|allison|susan|serena|karen|moira|tessa|daniel|aria|jenny|michelle|ana|emma|brian|andrew|ava multilingual|libby|sonia|ryan|natasha|william)\b/i.test(n)) s += 14;
  if (NOVELTY.test(n)) s -= 120;
  if (/microsoft (david|zira|mark|hazel|george)(?!.*natural)/i.test(n)) s -= 10; // older desktop voices
  return s;
}
let voicePref = '', rate = 1;
export function voiceOptions() {
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
export function setVoicePrefs({ name, speed } = {}) {
  if (name !== undefined) { voicePref = name || ''; voice = pickVoice(); }
  if (speed) rate = speed;
}
export function previewVoice(name) {
  const old = voicePref; voicePref = name || ''; voice = pickVoice();
  say(rand(['Hey! I\'m BAZINGA. What do you want to hear?', 'Hi there. Say "play my liked songs" and I\'ll get the music going.']), { show: false });
  voicePref = old; voice = null;
}
if ('speechSynthesis' in window) { speechSynthesis.onvoiceschanged = () => { voice = pickVoice(); }; voice = pickVoice(); }

// Dip the music while listening/talking. This never changes your saved volume, so the music
// always comes back exactly as loud as it was.
function duck(on) {
  if (on === ducked) return;
  ducked = on; player.duck(on);
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
  return new Promise(res => {
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
      const parts = spoken.match(/[^.!?]+[.!?]*/g) || [spoken];
      setState('speaking'); duck(true);
      parts.forEach((part, i) => {
        const u = new SpeechSynthesisUtterance(part.trim());
        if (voice) { u.voice = voice; u.lang = voice.lang; }
        const natural = voice && /natural|neural|premium|enhanced|siri/i.test(voice.name);
        u.rate = (natural ? 1 : 0.97) * rate; u.pitch = 1; u.volume = 1;
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

export function initVoice(hooks) {
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

export function openVoice({ listenNow = true, fromWake = false } = {}) {
  const v = el(); if (!v) return;
  if (!fromWake) stopWake();
  clearTimeout(closeTimer); keep = false;
  open = true; v.hidden = false; requestAnimationFrame(() => v.classList.add('on'));
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
function close() {
  clearTimeout(closeTimer); pending = null; confirmUI(false);
  stopListening(); try { speechSynthesis.cancel(); } catch { }
  restoreAudio();
  const v = el(); if (!v) return;
  open = false; v.classList.remove('on'); setTimeout(() => { if (!open) v.hidden = true; }, 220);
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
    scheduleClose(8000);
  };
  rec.onend = () => {
    listening = false; setState('idle'); rec = null;
    player.audioMode('playback'); // release the microphone's audio mode right away
    const alts = [];
    for (let k = 1; k < 5; k++) { const a = finals.map(f => f[k] || f[0]).join(' ').trim(); if (a && a !== final.trim() && !alts.includes(a)) alts.push(a); }
    if (final.trim()) handle(final.trim(), alts); else { restoreAudio(); if (!pending) scheduleClose(8000); }
  };
  try { rec.start(); } catch { player.audioMode('playback'); }
}
function stopListening() {
  const r = rec; rec = null;
  if (r) { r.onend = r.onresult = r.onerror = null; try { r.abort(); } catch { } try { r.stop(); } catch { } player.audioMode('playback'); }
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
export const wakeSupported = canListen;
export const wakeActive = () => wakeOn;
export function setWake(on) {
  wakeOn = !!on && canListen;
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
          setState('listening'); setReply('I\'m listening…'); duck(true);
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
