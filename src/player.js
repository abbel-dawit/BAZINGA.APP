// Playback engine: YouTube (music video or audio upload) or an offline file on the device.
import { db, kv } from './db.js';
import { lib } from './store.js';
import * as store from './store.js';
import * as yt from './youtube.js';
import { emit, toast, debounce, genreOf } from './util.js';
import { logoSrc } from './ui.js';

export const NO_MATCH = 'No YouTube match for this song.';
export const P = {
  queue: [],          // [{id, user}]
  origin: '',         // where the queue came from: 'mix' (BAZINGA! button) or '' (a list played as-is)
  cursor: -1,
  mode: 'video',      // 'video' | 'audio' — music video is the default
  preferOffline: true,
  shuffle: false,
  repeat: 'off',      // off | all | one
  playing: false,
  loading: false,
  source: null,       // 'yt' | 'local'
  ytId: null,
  time: 0, duration: 0,
  volume: 0.9,
  error: ''
};

// Two audio elements: the one playing, and the next offline song already loaded behind it (no gap between songs)
let audio = new Audio(), audioNext = new Audio();
audio.preload = audioNext.preload = 'auto';
let preLocal = null;       // { tid, url } — the next offline song, loaded and waiting in audioNext
let ytPre = null, preYT = null; // computers: a second, hidden YouTube player that buffers the next song ({ tid, vid, mode })
let ytPlayer = null, ytReady = null, tick = null, objUrl = null, loadToken = 0;
let wantPlay = false;      // the listener wants music playing (used to undo pauses the phone does on its own)
let resumeAt = 0, resumeFor = null; // where to pick up the restored song after a refresh
let duckLevel = 1;         // temporary volume dip while the voice assistant talks (never saved)
let endHook = null;        // app.js: what to play when the queue runs out
let pausedDuring = -1;     // the listener paused while this load was still starting
let verify = null;         // checks that an instant "play" really started
// Read-only: does the listener want music playing right now? (drives instant Play/Pause feedback)
Object.defineProperty(P, 'want', { get: () => wantPlay, enumerable: false });
// What every Play/Pause button should show: flips the moment you tap, no waiting for YouTube
export const isOn = () => P.playing || (wantPlay && P.loading);

const changed = () => {
  emit('player', P);
  if ('mediaSession' in navigator) try { navigator.mediaSession.playbackState = current() ? (P.playing || (wantPlay && P.loading) ? 'playing' : 'paused') : 'none'; } catch { }
};
// P.at = when this device last did anything with the player (used to decide which device "wins" on sync)
// wasOn = music was playing when the app was last seen (so it can carry on when you come back)
const saveNow = () => { P.at = Date.now(); return kv.set('player', {
  queue: P.queue, cursor: P.cursor, origin: P.origin, mode: P.mode, shuffle: P.shuffle, repeat: P.repeat, volume: P.volume, preferOffline: P.preferOffline,
  time: Math.floor(P.time || 0), at: P.at, wasOn: !!(wantPlay && current())
}); };
const persist = debounce(saveNow, 500);
export const setEndHook = fn => { endHook = fn; };
const outVol = () => Math.max(0, Math.min(1, P.volume * duckLevel));

// Ask the phone for a proper music audio session (high quality, keeps playing when locked).
// Safari 17+ supports this; elsewhere it's a harmless no-op.
export function audioMode(type = 'playback') { try { if (navigator.audioSession && navigator.audioSession.type !== type) navigator.audioSession.type = type; } catch { } }

export const current = () => (P.cursor >= 0 && P.queue[P.cursor]) ? lib.tracks.get(P.queue[P.cursor].id) : null;

// ---------- Continue on another device ----------
// What's playing here, for device sync (song, spot in the song, queue, video/audio, shuffle).
export function syncState() {
  const q = P.queue.slice(Math.max(0, P.cursor - 50), P.cursor + 250), off = Math.max(0, P.cursor - 50);
  const extra = []; // songs that aren't in the library (a BAZINGA! mix, search results) travel with the queue
  for (const it of q) { const t = lib.tracks.get(it.id); if (t?.transient) { const x = { ...t }; delete x.transient; extra.push(x); } }
  return { queue: q, cursor: P.cursor - off, time: Math.floor(P.time || 0), mode: P.mode, shuffle: P.shuffle, origin: P.origin, at: P.at || 0, tracks: extra };
}
export const lastActive = () => P.at || 0;
// Take over another device's spot (only when nothing is playing here). Press play to continue.
export function adopt(s) {
  if (!s || isOn()) return false;
  for (const t of s.tracks || []) if (!lib.tracks.has(t.id)) store.remember(t);
  const queue = (s.queue || []).filter(q => lib.tracks.has(q.id));
  if (!queue.length) return false;
  const curId = s.queue[s.cursor]?.id, cursor = Math.max(0, queue.findIndex(q => q.id === curId));
  loadToken++; audio.pause(); try { ytPlayer?.pauseVideo?.(); } catch { }
  wantPlay = false;
  Object.assign(P, { queue, cursor, mode: s.mode || P.mode, shuffle: !!s.shuffle, origin: s.origin || '', playing: false, loading: false, source: null, ytId: null, error: '', time: s.time || 0 });
  const t = current(); P.duration = (t?.durationMs || 0) / 1000;
  resumeAt = s.time || 0; resumeFor = t?.id || null;
  P.at = s.at || Date.now();
  kv.set('player', { queue: P.queue, cursor: P.cursor, origin: P.origin, mode: P.mode, shuffle: P.shuffle, repeat: P.repeat, volume: P.volume, preferOffline: P.preferOffline, time: Math.floor(P.time), at: P.at });
  if (t) setMediaSession(t);
  changed(); emit('time', P);
  return true;
}
export async function restore() {
  const s = await kv.get('player');
  if (s) { Object.assign(P, s, { playing: false }); delete P.wasOn; resumeAt = +s.time || 0; P.time = resumeAt; }
  // The app was closed (or the phone cleared it) while music played less than 30 min ago: carry on
  resumeOnLaunch = !!(s?.wasOn && Date.now() - (s.at || 0) < 30 * 60e3);
  // v1.6: music video is the default for everyone (once); switching to Audio afterwards is remembered
  if (!(await kv.get('videoDefault'))) { P.mode = 'video'; await kv.set('videoDefault', 1); persist(); }
  P.queue = P.queue.filter(q => lib.tracks.has(q.id));
  if (P.cursor >= P.queue.length) P.cursor = P.queue.length - 1;
  const t = current();
  if (t) P.duration = (t.durationMs || 0) / 1000;
  if (resumeAt && P.duration && resumeAt > P.duration - 5) resumeAt = P.time = 0;
  resumeFor = t?.id || null;
  audio.volume = P.volume;
  setupMediaSession();
  changed();
  // Look up the restored song (and the next ones) in the background, so "Resume" starts instantly
  if (t) setTimeout(() => { prefetch(t.id); prefetchNext(loadToken); }, 1200);
}

// ---------- YouTube IFrame player ----------
function loadYT() {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => {
      ytPlayer = makeYT('yt-player', () => { ytPlayer.setVolume(outVol() * 100); markActiveYT(); resolve(ytPlayer); });
      // Computers: a second player waits behind the first and buffers the next song while this one plays
      if (dualYT()) {
        const slot = document.createElement('div'); slot.id = 'yt-player-b';
        document.getElementById('yt-player')?.parentElement?.appendChild(slot);
        ytPre = makeYT('yt-player-b', pl => { try { pl.mute(); } catch { } markActiveYT(); });
      }
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytReady = null; reject(new Error('Could not load YouTube player (offline?)')); };
    document.head.appendChild(s);
  });
  return ytReady;
}
// Both YouTube players are built the same way; only the one that's playing (ytPlayer) drives the app
function makeYT(elId, onReady) {
  const pl = new YT.Player(elId, {
        width: '100%', height: '100%',
        // cc_load_policy 0 + unloading the captions module = no subtitles by default
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, cc_load_policy: 0, iv_load_policy: 3, ...(location.protocol.startsWith('http') ? { origin: location.origin } : {}) },
        events: {
          onReady: () => onReady(pl),
          onStateChange: e => {
            if (pl !== ytPlayer) { preState(pl, e.data); return; }
            if (P.source !== 'yt') return;
            if (e.data === YT.PlayerState.PLAYING && !wantPlay && pausedDuring === loadToken) { try { ytPlayer.pauseVideo(); } catch { } P.loading = false; changed(); return; }
            if (e.data === YT.PlayerState.PLAYING) { quietStart = false; P.playing = true; P.loading = false; P.needsTap = false; wantPlay = true; resumeTries = 0; noCaptions(); if (!tick) startTick(); changed(); }
            else if (e.data === YT.PlayerState.PAUSED) {
              if (isRerouting()) return;
              // Phones pause YouTube when you leave the browser or lock the screen. If you didn't
              // ask for that, start it again straight away.
              // (Only right after leaving / a new song starting — a pause you make later from the lock screen is respected.)
              if (wantPlay && document.hidden && (Date.now() - hiddenAt < 8000 || Date.now() - startedAt < 8000) && resumeTries < 10) { resumeTries++; setTimeout(() => { try { if (wantPlay) ytPlayer.playVideo(); } catch { } }, Math.min(150 * resumeTries, 1500)); return; }
              P.playing = false; P.loading = false; if (!document.hidden && !leavingNow()) wantPlay = false; changed();
            }
            else if (e.data === YT.PlayerState.ENDED) ended();
            else if (e.data === YT.PlayerState.BUFFERING) { if (!P.loading) { P.loading = true; changed(); } }
            else if (e.data === YT.PlayerState.CUED && wantPlay) ytPlayer.playVideo();
          },
          onError: e => { if (pl === ytPlayer) ytError(e.data); else preYT = null; }
        }
      });
  return pl;
}
// ---------- Next song, already loading ----------
// Computers (not phones/tablets, which only let the player that was tapped make sound) keep a second
// YouTube player that loads the next song muted in the last 30 s of this one, then swap to it instantly.
const dualYT = () => {
  try { return !/iphone|ipad|ipod|android/i.test(navigator.userAgent) && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) && matchMedia('(hover: hover) and (pointer: fine)').matches; } catch { return false; }
};
function markActiveYT() {
  try { ytPlayer?.getIframe?.()?.classList.remove('yt-idle'); ytPre?.getIframe?.()?.classList.add('yt-idle'); } catch { }
}
// The waiting player: once the next song starts buffering, hold it paused at the start
function preState(pl, st) {
  if (pl !== ytPre || !preYT) return;
  if (st === 1) { try { pl.pauseVideo(); pl.seekTo(0, true); } catch { } preYT.ready = true; }
}
function nextIndex() {
  if (P.repeat === 'one' || stopAfterSong) return -1;
  if (P.cursor < P.queue.length - 1) return P.cursor + 1;
  return P.repeat === 'all' && P.queue.length > 1 ? 0 : -1;
}
let preBusy = false;
async function preloadNext() {
  if (preBusy) return;
  const i = nextIndex(); if (i < 0) return;
  const t = lib.tracks.get(P.queue[i]?.id); if (!t) return;
  preBusy = true;
  try {
    // An offline song: read the file and have it ready to play
    if (t.localFileId && (P.preferOffline || !navigator.onLine)) {
      if (preLocal?.tid === t.id) return;
      const f = await db.get('files', t.localFileId);
      if (!f?.blob) return;
      if (preLocal?.url) URL.revokeObjectURL(preLocal.url);
      const url = URL.createObjectURL(f.blob);
      preLocal = { tid: t.id, url };
      audioNext.src = url; audioNext.volume = outVol(); applySink(audioNext);
      try { audioNext.load(); } catch { }
      return;
    }
    if (!navigator.onLine || !ytPre?.loadVideoById || preYT?.tid === t.id) return;
    const c = await yt.findForTrack(t, { need: P.mode });
    const vid = c[P.mode] || c[P.mode === 'video' ? 'audio' : 'video'];
    if (!vid || !ytPre?.loadVideoById || (preYT?.tid === t.id && preYT.vid === vid)) return;
    preYT = { tid: t.id, vid, mode: P.mode, ready: false };
    try { ytPre.mute(); ytPre.loadVideoById(vid); } catch { preYT = null; }
  } catch { } finally { preBusy = false; }
}
// Swap to the player that already holds this song
function swapYT(id, at) {
  const old = ytPlayer; ytPlayer = ytPre; ytPre = old; preYT = null;
  try { old.pauseVideo(); old.mute(); } catch { }
  markActiveYT();
  P.source = 'yt'; P.ytId = id; P.loading = true; P.needsTap = false; changed();
  startedAt = Date.now(); captionsOffFor = null;
  try { ytPlayer.seekTo(at > 1 ? at : 0, true); ytPlayer.unMute(); ytPlayer.setVolume(outVol() * 100); ytPlayer.playVideo(); } catch { }
  emit('video-visible', true);
}

let ytRetried = false, resumeTries = 0, hiddenAt = 0, startedAt = 0, captionsOffFor = null;
function noCaptions() {
  if (captionsOffFor === P.ytId) return; captionsOffFor = P.ytId;
  try { ytPlayer.unloadModule('captions'); ytPlayer.unloadModule('cc'); } catch { }
  try { ytPlayer.setOption('captions', 'track', {}); } catch { }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { comeBack(); return; }
  hiddenAt = Date.now(); leftAt = Date.now(); resumeTries = 0;
  saveNow(); // (the phone may close the app any moment now)
  audioMode('playback');
  // Leaving the browser / locking the phone: keep going
  if (wantPlay && P.source === 'yt') setTimeout(() => { try { if (wantPlay && ytPlayer?.getPlayerState?.() !== 1) ytPlayer.playVideo(); } catch { } }, 500);
  if (wantPlay && P.source === 'local' && audio.paused) audio.play().catch(() => { });
  persist();
});
// ---------- Keep playing when you come back ----------
// Leaving the app (switching apps, locking the phone, closing the tab) and coming back carries on with
// the music if it was playing when you left. If the browser needs a tap first, one tap anywhere does it.
let leftAt = 0, resumeOnLaunch = false, quietStart = false, autoResumeOn = true, tapArmed = false;
try { autoResumeOn = localStorage.getItem('bz_autoresume') !== '0'; } catch { }
export const setAutoResume = on => { autoResumeOn = !!on; try { localStorage.setItem('bz_autoresume', on ? '1' : '0'); } catch { } };
const leavingNow = () => Date.now() - leftAt < 1500;
// (focus moving into the YouTube video itself isn't leaving)
window.addEventListener('blur', () => setTimeout(() => { if (document.activeElement?.tagName !== 'IFRAME') leftAt = Date.now(); }, 0));
window.addEventListener('pagehide', () => { leftAt = Date.now(); saveNow(); });
document.addEventListener('freeze', () => { leftAt = Date.now(); saveNow(); });
window.addEventListener('pageshow', e => { if (e.persisted) comeBack(); });
window.addEventListener('focus', () => { if (!document.hidden) comeBack(); });
let backT = null;
function comeBack() {
  resumeTries = 0;
  if (!wantPlay || !autoResumeOn || !current()) return;
  clearTimeout(backT);
  backT = setTimeout(() => {
    if (!wantPlay || document.hidden) return;
    if (P.source === 'yt') { try { const st = ytPlayer?.getPlayerState?.(); if (st === 2 || st === 5 || st === -1) ytPlayer.playVideo(); } catch { } }
    else if (P.source === 'local' && audio.paused) audio.play().catch(() => blocked());
    else if (!P.source) load(true);
    // still silent a moment later: the browser wants a tap
    setTimeout(() => {
      if (!wantPlay || document.hidden || !current() || reallyPlaying()) return;
      P.playing = false; P.loading = false; changed(); // show the true state (it may still say "playing" from before you left)
      blocked();
    }, 1800);
  }, 150);
}
const reallyPlaying = () => {
  if (P.source === 'yt') { try { const st = ytPlayer?.getPlayerState?.(); return st === 1 || st === 3; } catch { return P.playing; } }
  if (P.source === 'local') return !audio.paused;
  return false;
};
// The browser blocked starting on its own: the next tap anywhere carries on (and the app shows a Play button)
function blocked() {
  emit('resume-blocked');
  if (tapArmed) return; tapArmed = true;
  const go = e => {
    off();
    if (e.target?.closest?.('[data-p="toggle"],[data-p="next"],[data-p="prev"],.row,[data-act^="play"]')) return; // that tap already starts something
    if (!P.playing && current()) play();
  };
  const off = () => { tapArmed = false; document.removeEventListener('pointerdown', go, true); document.removeEventListener('keydown', go, true); };
  document.addEventListener('pointerdown', go, true); document.addEventListener('keydown', go, true);
  setTimeout(off, 120e3);
}
// Called once the app is on screen after starting up
export function resumeLast() {
  if (!resumeOnLaunch || !autoResumeOn || !current() || isOn()) return false;
  resumeOnLaunch = false; quietStart = true;
  play();
  setTimeout(() => { if (quietStart && wantPlay && !P.playing && !P.needsTap) blocked(); }, 4500);
  return true;
}
async function ytError(code) {
  const t = current(); if (!t) return;
  // 101/150 = embedding disabled by owner; try the other version, then re-search once
  const c = await db.get('ytcache', t.id) || {};
  const other = P.mode === 'video' ? 'audio' : 'video';
  if (c[other] && c[other] !== P.ytId) { toast('That upload can\'t be embedded — using the ' + other + ' version'); return startYT(c[other]); }
  if (!ytRetried) {
    ytRetried = true;
    try { const n = await yt.findForTrack(t, { force: true }); const id = n[P.mode] || n[other]; if (id && id !== P.ytId) return startYT(id); } catch { }
  }
  P.error = 'YouTube won\'t play this one here.'; console.warn('YouTube error code', code);
  P.loading = false; changed();
  setTimeout(() => { if (P.error) next(); }, 2500);
}

let tickN = 0;
function startTick() {
  clearInterval(tick);
  tick = setInterval(() => {
    if (P.source === 'yt' && ytPlayer?.getCurrentTime) {
      P.time = ytPlayer.getCurrentTime() || 0;
      P.duration = ytPlayer.getDuration() || P.duration;
    } else if (P.source === 'local') {
      P.time = audio.currentTime; P.duration = audio.duration || P.duration;
    }
    emit('time', P);
    updatePositionState();
    if (P.playing && ++tickN % 10 === 0) persist(); // remember the spot every ~5 s
    // Get the next song ready: offline files a few seconds in, YouTube in the last 30 s
    if (P.playing && P.time > 3 && (P.duration && P.duration - P.time < 30 || nextIsLocal())) preloadNext();
  }, 500);
}

let startWatch = null;
async function startYT(id, start = 0) {
  P.source = 'yt'; P.ytId = id; P.loading = true; P.needsTap = false; changed();
  startedAt = Date.now(); if (document.hidden) resumeTries = 0;
  const pl = await loadYT();
  if (preYT?.vid === id) preYT = null; // (it's playing here now)
  pl.loadVideoById(start > 1 ? { videoId: id, startSeconds: start } : id);
  try { pl.unMute(); } catch { } // the waiting player mutes itself; YouTube remembers that, so always unmute the one playing
  pl.setVolume(outVol() * 100);
  // Ask YouTube for its best stream (it still adapts to your connection)
  try { pl.setPlaybackQuality(P.mode === 'video' ? 'hd1080' : 'highres'); } catch { }
  emit('video-visible', true);
  // Some phones (iPhone especially) only let YouTube start after you tap the video itself once.
  // If nothing has started after a few seconds, show the video so one tap starts it.
  clearTimeout(startWatch);
  const my = loadToken;
  startWatch = setTimeout(() => {
    if (my !== loadToken || !wantPlay || P.source !== 'yt' || document.hidden) return;
    let st = -9; try { st = ytPlayer.getPlayerState(); } catch { }
    if (st === -1 || st === 5 || st === 2 && !P.playing) { P.needsTap = true; P.loading = false; changed(); if (quietStart) { quietStart = false; blocked(); } else emit('needs-tap'); }
  }, 3500);
}
// Load the YouTube player in the background right after start-up, so the first song starts instantly
export function warmup() { if (location.protocol.startsWith('http') && navigator.onLine) loadYT().catch(() => { }); }

// ---------- Core ----------
async function load(autoplay = true) {
  const my = ++loadToken;
  const t = current();
  const at = resumeFor && resumeFor === t?.id ? resumeAt : 0; resumeAt = 0; resumeFor = null;
  audio.pause();
  if (P.source !== 'yt') { try { ytPlayer?.pauseVideo?.(); } catch { } }
  P.error = ''; P.time = at; P.duration = (t?.durationMs || 0) / 1000; ytRetried = false;
  if (!t) { P.playing = false; P.source = null; wantPlay = false; changed(); return; }
  if (autoplay) { wantPlay = true; audioMode('playback'); }
  P.loading = true; changed();
  setMediaSession(t);
  persist();

  // Offline file first (if user prefers it or we're offline)
  if (t.localFileId && (P.preferOffline || !navigator.onLine)) {
    if (preLocal?.tid === t.id) {
      // Already loaded behind the current song: swap and play straight away
      const old = audio; audio = audioNext; audioNext = old;
      old.pause(); old.removeAttribute('src'); try { old.load(); } catch { }
      if (objUrl) URL.revokeObjectURL(objUrl);
      objUrl = preLocal.url; preLocal = null;
      P.source = 'local'; P.ytId = null;
      emit('video-visible', false);
      try { ytPlayer?.pauseVideo?.(); } catch { }
      audio.volume = outVol();
      try { audio.currentTime = at || 0; } catch { }
      if (autoplay) audio.play().catch(() => { P.playing = false; changed(); if (quietStart) { quietStart = false; blocked(); } });
      P.loading = false; changed(); startTick();
      return;
    }
    const f = await db.get('files', t.localFileId);
    if (my !== loadToken) return;
    if (f?.blob) {
      if (objUrl) URL.revokeObjectURL(objUrl);
      objUrl = URL.createObjectURL(f.blob);
      P.source = 'local'; P.ytId = null;
      emit('video-visible', false);
      try { ytPlayer?.pauseVideo?.(); } catch { }
      audio.src = objUrl; applySink(audio);
      audio.volume = outVol();
      if (at) audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = at; } catch { } }, { once: true });
      if (autoplay) audio.play().catch(() => { P.playing = false; changed(); if (quietStart) { quietStart = false; blocked(); } });
      P.loading = false; changed(); startTick();
      return;
    }
  }
  if (!navigator.onLine) {
    P.error = 'You\'re offline and this song has no offline file. Skipping…'; P.loading = false; changed();
    setTimeout(() => my === loadToken && next(), 1500); return;
  }
  try {
    const c = await yt.findForTrack(t, { need: P.mode });
    if (my !== loadToken) return;
    const id = c[P.mode] || c[P.mode === 'video' ? 'audio' : 'video'];
    if (!t.artwork) store.coverFromVideo(t.id, c.audio || c.video);
    if (!id) throw new Error(NO_MATCH);
    if (!c[P.mode]) toast(`No ${P.mode === 'video' ? 'music video' : 'audio upload'} found — playing the other version`);
    if (preYT && preYT.tid === t.id && preYT.vid === id && ytPre) swapYT(id, at);
    else await startYT(id, at);
    if (!autoplay) ytPlayer.pauseVideo();
    startTick();
    prefetchNext(my);
  } catch (e) {
    if (my !== loadToken) return;
    P.error = e.message; P.loading = false; P.playing = false; changed();
  }
}

// Look up the next couple of songs while this one plays, so skipping is instant.
function prefetchNext(my) {
  setTimeout(() => {
    if (my !== loadToken || !navigator.onLine) return;
    const around = [...P.queue.slice(P.cursor + 1, P.cursor + 6), ...(P.cursor > 0 ? [P.queue[P.cursor - 1]] : [])];
    // one after another (the very next song first), so they never compete with each other
    (async () => { for (const q of around) {
      if (my !== loadToken) return;
      const t = lib.tracks.get(q.id);
      if (t && !(t.localFileId && P.preferOffline)) await yt.findForTrack(t, { need: P.mode }).catch(() => { });
    } })();
  }, 300);
}
const nextIsLocal = () => { const i = nextIndex(); const t = i >= 0 && lib.tracks.get(P.queue[i]?.id); return !!(t && t.localFileId && (P.preferOffline || !navigator.onLine)); };
// The queue changed (Play next, reorder, shuffle): look up the new next songs right away
const queueChanged = () => { if (current()) prefetchNext(loadToken); };
// Start looking up a song the moment the pointer rests on it, so tapping it plays right away
export function prefetch(id) {
  const t = lib.tracks.get(id);
  if (t && navigator.onLine && !(t.localFileId && P.preferOffline)) yt.findForTrack(t, { need: P.mode }).catch(() => { });
}

// Sleep timer: "stop at the end of this song"
let stopAfterSong = false;
export const setStopAfterSong = on => { stopAfterSong = !!on; };
export const stopsAfterSong = () => stopAfterSong;
// Sleep timer: gently fade the music out, then pause (the saved volume is never touched)
let fadeT = null;
export function fadeOutAndPause(ms = 8000) {
  clearInterval(fadeT);
  const t0 = Date.now(), from = duckLevel;
  fadeT = setInterval(() => {
    const k = Math.min(1, (Date.now() - t0) / ms);
    duckLevel = from * (1 - k); applyVol();
    if (k >= 1) { clearInterval(fadeT); pause(); setTimeout(() => { duckLevel = 1; applyVol(); }, 400); emit('sleep-done'); }
  }, 100);
}
export const cancelFade = () => { if (fadeT) { clearInterval(fadeT); fadeT = null; duckLevel = 1; applyVol(); } };
function ended() {
  if (stopAfterSong) { stopAfterSong = false; seek(0); pause(); emit('sleep-done'); return; }
  if (P.repeat === 'one') { seek(0); play(); return; }
  next(true);
}
for (const el of [audio, audioNext]) {
  el.addEventListener('ended', () => el === audio && P.source === 'local' && ended());
  el.addEventListener('play', () => { if (el !== audio) return; P.playing = true; if (!tick) startTick(); changed(); });
  el.addEventListener('pause', () => { if (el !== audio || isRerouting()) return; P.playing = false; if (!document.hidden && !leavingNow() && !el.ended && !fadeT) wantPlay = false; changed(); });
  el.addEventListener('error', () => { if (el !== audio) { if (preLocal) { URL.revokeObjectURL(preLocal.url); preLocal = null; } return; } if (P.source === 'local') { P.error = 'Could not play the offline file.'; changed(); } });
}

// Play/pause update every button instantly (optimistic); the player then catches up.
export function play() {
  if (!current()) return;
  wantPlay = true; pausedDuring = -1; audioMode('playback');
  if (P.source === 'local') { P.playing = true; changed(); audio.play().catch(() => { P.playing = false; changed(); }); }
  else if (P.source === 'yt' && ytPlayer) {
    P.playing = true; P.error = ''; changed();
    try { ytPlayer.playVideo(); } catch { }
    // If the phone refused to start it, show the real state again
    clearTimeout(verify);
    verify = setTimeout(() => { let st = -9; try { st = ytPlayer.getPlayerState(); } catch { } if (wantPlay && st !== 1 && st !== 3 && !document.hidden) { P.playing = false; P.loading = false; changed(); } }, 2500);
  }
  else load(true);
}
export function pause() {
  wantPlay = false; pausedDuring = loadToken; clearTimeout(verify); quietStart = false;
  P.playing = false; P.loading = false; changed();
  if (P.source === 'local') audio.pause();
  else if (ytPlayer?.pauseVideo) try { ytPlayer.pauseVideo(); } catch { }
}
export const toggle = () => isOn() ? pause() : play();

export function seek(sec) {
  if (!P.source) { resumeAt = sec; resumeFor = current()?.id || null; } // not started yet (e.g. after a refresh): start from here
  if (P.source === 'local') audio.currentTime = sec;
  else ytPlayer?.seekTo?.(sec, true);
  P.time = sec; emit('time', P);
}

// Worth saving as a new playlist? Only a queue BAZINGA! made or one that's shuffled — a list playing
// in its own order already exists as that playlist/album.
export const queueIsNew = () => P.queue.length > 1 && (P.origin === 'mix' || !!P.shuffle);
export function next(auto = false) {
  if (!P.queue.length) return;
  if (!auto) noteSkip();
  if (P.cursor < P.queue.length - 1) P.cursor++;
  else if (P.repeat === 'all') P.cursor = 0;
  else {
    // Queue finished: autoplay (replay the queue or start Liked Songs — Settings → Playback)
    const plan = endHook?.(P.queue.map(q => q.id));
    if (plan?.ids?.length) {
      let list = plan.ids.filter(id => lib.tracks.has(id)).map(id => ({ id, user: false }));
      if (plan.shuffle) { resetSkips(); list = genreShuffle(list.map(q => q.id)).map(id => ({ id, user: false })); }
      if (list.length) { P.queue = list; P.cursor = 0; P.origin = ''; if (plan.msg) toast(plan.msg); load(true); return; }
    }
    if (auto) { P.playing = false; wantPlay = false; changed(); }
    return;
  }
  load(true);
}
export function prev() {
  if (P.time > 4) return seek(0);
  if (P.cursor > 0) { P.cursor--; load(true); }
  else seek(0);
}

// Replace the queue with a list and start at `start`
export function playList(ids, start = 0, { shuffle = P.shuffle, origin = '' } = {}) {
  ids = ids.filter(id => lib.tracks.has(id));
  if (!ids.length) return toast('Nothing to play');
  let list = ids.map(id => ({ id, user: false }));
  if (shuffle) {
    resetSkips();
    list = genreShuffle(ids, { first: ids[start] }).map(id => ({ id, user: false })); start = 0;
  }
  P.queue = list; P.cursor = start; P.shuffle = shuffle; P.origin = origin;
  load(true);
}

// Add to the end of the "up next" user section (after the current song and any user-queued songs)
export function addToQueue(ids, playNext = false) {
  ids = [].concat(ids).filter(id => lib.tracks.has(id));
  if (!ids.length) return;
  const items = ids.map(id => ({ id, user: true }));
  if (P.cursor < 0) { P.queue = items; P.cursor = 0; load(true); return; }
  let at = P.cursor + 1;
  if (!playNext) while (at < P.queue.length && P.queue[at].user) at++;
  P.queue.splice(at, 0, ...items);
  persist(); changed(); queueChanged();
  toast(ids.length === 1 ? (playNext ? 'Playing next' : 'Added to queue') : `${ids.length} songs added to queue`);
}
// Quietly add songs to the end of the queue (used while the BAZINGA! mix is still being built)
export function appendToQueue(ids) {
  ids = [].concat(ids).filter(id => lib.tracks.has(id) && !P.queue.some(q => q.id === id));
  if (!ids.length) return;
  P.queue.push(...ids.map(id => ({ id, user: false })));
  persist(); changed();
}
export function removeFromQueue(i) {
  if (i === P.cursor) return;
  P.queue.splice(i, 1);
  if (i < P.cursor) P.cursor--;
  persist(); changed();
}
export function moveInQueue(from, to) {
  if (from === to) return;
  const [it] = P.queue.splice(from, 1);
  P.queue.splice(to, 0, it);
  if (P.cursor === from) P.cursor = to;
  else if (from < P.cursor && to >= P.cursor) P.cursor--;
  else if (from > P.cursor && to <= P.cursor) P.cursor++;
  persist(); changed(); queueChanged();
}
export function jumpTo(i) { P.cursor = i; load(true); }
export function clearQueue() { P.queue = P.queue.slice(0, P.cursor + 1); persist(); changed(); }
export function clearUserQueue() { P.queue = P.queue.filter((q, i) => i <= P.cursor || !q.user); persist(); changed(); }

export function setShuffle(v) {
  P.shuffle = v;
  if (v && P.cursor >= 0) { resetSkips(); reshuffleRest(); }
  persist(); changed(); queueChanged();
}
export function cycleRepeat() { P.repeat = { off: 'all', all: 'one', one: 'off' }[P.repeat]; persist(); changed(); }
export function setVolume(v) { P.volume = v; duckLevel = 1; applyVol(); persist(); changed(); }
function applyVol() { audio.volume = outVol(); try { ytPlayer?.setVolume?.(outVol() * 100); } catch { } }
// Silence the music while the voice assistant is on screen, without touching the saved volume
export function duck(on) { duckLevel = on ? 0 : 1; applyVol(); }

// Switch between music video and audio-only version, keeping position
export async function setMode(mode) {
  if (mode === P.mode) return;
  P.mode = mode; preYT = null; persist(); changed(); queueChanged();
  const t = current();
  if (t && P.source === 'yt') {
    const at = P.time, wasPlaying = P.playing;
    const c = await yt.findForTrack(t);
    const id = c[mode];
    if (!id) { toast(`No ${mode === 'video' ? 'music video' : 'audio version'} found for this song`); return; }
    await startYT(id, at);
    if (!wasPlaying) setTimeout(() => ytPlayer.pauseVideo(), 600);
  }
}
export function setPreferOffline(v) { P.preferOffline = v; persist(); }
export const reloadCurrent = () => load(true);
// Restart the sound output in place (fixes thin "phone call" audio after the microphone was used)
let rerouting = 0;
export function refreshOutput() {
  if (!P.playing) return;
  rerouting = Date.now();
  if (P.source === 'local') { const at = audio.currentTime; audio.pause(); setTimeout(() => { try { audio.currentTime = at; } catch { } audio.play().catch(() => { }); }, 120); }
  else if (P.source === 'yt' && ytPlayer) { try { ytPlayer.pauseVideo(); setTimeout(() => ytPlayer.playVideo(), 160); } catch { } }
}
const isRerouting = () => Date.now() - rerouting < 1500;

// ---------- Lock screen / media keys ----------
function setMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album || '',
      artwork: t.artwork && !t.artwork.startsWith('data:') ? [{ src: t.artwork, sizes: '600x600', type: 'image/jpeg' }] : [{ src: logoSrc('icon-512'), sizes: '512x512', type: 'image/png' }]
    });
  } catch { }
}
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const h = (k, fn) => { try { ms.setActionHandler(k, fn); } catch { } };
  h('play', play); h('pause', pause); h('stop', pause);
  h('previoustrack', prev); h('nexttrack', () => next());
  h('seekto', d => seek(d.seekTime));
  h('seekbackward', d => seek(Math.max(0, P.time - (d.seekOffset || 10))));
  h('seekforward', d => seek(Math.min(P.duration || 1e9, P.time + (d.seekOffset || 10))));
  const t = current(); if (t) setMediaSession(t);
}
function updatePositionState() {
  if (!('mediaSession' in navigator) || !P.duration) return;
  try { navigator.mediaSession.setPositionState({ duration: P.duration, position: Math.min(P.time, P.duration), playbackRate: 1 }); } catch { }
}

// Stop everything (used when deleting the account)
export function stopAll() {
  loadToken++; wantPlay = false; audio.pause(); audio.removeAttribute('src');
  try { ytPlayer?.stopVideo?.(); ytPre?.stopVideo?.(); } catch { }
  preYT = null; if (preLocal) { URL.revokeObjectURL(preLocal.url); preLocal = null; } audioNext.removeAttribute('src');
  P.queue = []; P.cursor = -1; P.playing = false; changed();
}

// ---------- Audio output: speakers, Bluetooth headphones, AirPlay ----------
// Songs BAZINGA! plays itself (offline files) can be sent to any output the browser lists (setSinkId).
// YouTube plays inside its own frame, which always uses the system's output, so for YouTube we show the
// quickest way to switch it on this device (and AirPlay's picker on Apple devices).
const OUT_KEY = 'bz_out';
let outId = ''; try { outId = localStorage.getItem(OUT_KEY) || ''; } catch { }
export const canPickOutput = () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype && !!navigator.mediaDevices?.enumerateDevices;
export const canSelectOutput = () => !!navigator.mediaDevices?.selectAudioOutput;
export const canAirPlay = () => !!window.WebKitPlaybackTargetAvailabilityEvent && 'webkitShowPlaybackTargetPicker' in HTMLMediaElement.prototype;
export const outputId = () => outId;
async function applySink(el) {
  if (!canPickOutput() || !el) return;
  try { if ((el.sinkId || '') !== outId) await el.setSinkId(outId); }
  catch (e) { if (outId && (e.name === 'NotFoundError' || e.name === 'AbortError')) { outId = ''; try { localStorage.removeItem(OUT_KEY); } catch { } } }
}
// Every audio output the browser shows (names appear once the browser has allowed the microphone or an output once)
export async function listOutputs() {
  try { return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput' && d.deviceId !== 'communications'); } catch { return []; }
}
export const outputsNamed = async () => (await listOutputs()).some(d => d.label);
export async function setOutput(id) {
  outId = !id || id === 'default' ? '' : id;
  try { if (outId) localStorage.setItem(OUT_KEY, outId); else localStorage.removeItem(OUT_KEY); } catch { }
  await Promise.all([applySink(audio), applySink(audioNext)]);
  refreshOutput(); emit('output', outId);
}
// Firefox: the browser's own device chooser
export async function chooseOutput() { const d = await navigator.mediaDevices.selectAudioOutput(); await setOutput(d.deviceId); return d; }
// Chrome/Edge only share speaker names after the microphone has been allowed once. Opened and closed straight away.
export async function unlockOutputNames() {
  const st = await navigator.mediaDevices.getUserMedia({ audio: true });
  st.getTracks().forEach(t => t.stop());
  setTimeout(refreshOutput, 300); // headphones go back to full-quality music sound
}
// Safari (iPhone, iPad, Mac): Apple's AirPlay / Bluetooth picker
export function airplay() {
  const el = audio.src ? audio : (() => { if (!audioNext.src) audioNext.src = 'media/awake.mp4'; return audioNext; })();
  try { el.webkitShowPlaybackTargetPicker(); return true; } catch { return false; }
}
// Headphones connected or disconnected: restart the sound in place so it moves to the new output straight away
let lastOuts = null;
async function outputsChanged() {
  const now = await listOutputs(), ids = new Set(now.map(d => d.deviceId));
  if (outId && !ids.has(outId)) { outId = ''; try { localStorage.removeItem(OUT_KEY); } catch { } await Promise.all([applySink(audio), applySink(audioNext)]); toast('Audio output disconnected. Playing on this device'); }
  const added = lastOuts ? now.filter(d => d.label && d.deviceId !== 'default' && !lastOuts.has(d.deviceId)) : [];
  lastOuts = ids;
  setTimeout(refreshOutput, 400);
  if (added.length) emit('output-added', added[0]);
  emit('output', outId);
}
try { navigator.mediaDevices?.addEventListener?.('devicechange', outputsChanged); listOutputs().then(l => { lastOuts = new Set(l.map(d => d.deviceId)); }); } catch { }
applySink(audio); applySink(audioNext);

// ---------- Shuffle by genre ----------
// Shuffle plays songs in little runs of 3 from the same genre, and moves on to a similar genre next
// (Hip-Hop → R&B → Soul…), so it flows like a DJ set instead of jumping around. Skip one genre more
// than 5 times and the rest of the shuffle plays less of it (one song at a time, mostly later on).
const NEAR = {
  'Hip-Hop/Rap': ['R&B', 'Afrobeats', 'Reggae', 'Pop', 'Electronic'], 'R&B': ['Hip-Hop/Rap', 'Soul', 'Pop', 'Afrobeats', 'Gospel'],
  'Soul': ['R&B', 'Jazz', 'Blues', 'Gospel'], 'Pop': ['R&B', 'K-Pop', 'Electronic', 'Rock', 'Latin'], 'K-Pop': ['Pop', 'Electronic', 'R&B'],
  'Electronic': ['Pop', 'Hip-Hop/Rap', 'Latin', 'Afrobeats', 'K-Pop'], 'Afrobeats': ['Reggae', 'Hip-Hop/Rap', 'R&B', 'Latin', 'World'],
  'Reggae': ['Afrobeats', 'Latin', 'Hip-Hop/Rap'], 'Latin': ['Reggae', 'Pop', 'Afrobeats', 'Electronic'], 'Rock': ['Metal', 'Pop', 'Folk', 'Blues'],
  'Metal': ['Rock'], 'Folk': ['Country', 'Rock', 'Soundtrack'], 'Country': ['Folk', 'Rock', 'Blues'], 'Jazz': ['Blues', 'Soul', 'Classical'],
  'Blues': ['Jazz', 'Soul', 'Rock', 'Country'], 'Classical': ['Soundtrack', 'Jazz'], 'Soundtrack': ['Classical', 'Pop'], 'Gospel': ['Soul', 'R&B'],
  'World': ['Afrobeats', 'Latin', 'Folk'], 'Kids': ['Holiday', 'Soundtrack'], 'Holiday': ['Kids', 'Pop'], 'Comedy': []
};
const near = (a, b) => (NEAR[a] || []).includes(b) || (NEAR[b] || []).includes(a);
const RUN = 3;
let skips = new Map(), lessOf = new Set();
function resetSkips() { skips = new Map(); lessOf = new Set(); }
const gOf = id => genreOf(lib.tracks.get(id)) || '';
function mix(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }
// ids → shuffled ids in genre runs. first: song that must play first; prev: genre playing right now.
export function genreShuffle(ids, { first = null, prev = null, prevRun = 1 } = {}) {
  const buckets = new Map();
  for (const id of ids) { if (id === first) continue; const g = gOf(id); (buckets.get(g) || buckets.set(g, []).get(g)).push(id); }
  for (const b of buckets.values()) mix(b);
  const size = new Map([...buckets].map(([g, v]) => [g, v.length]));
  const out = []; let cur = prev, run = prev == null ? 0 : prevRun; // (the song playing now counts toward its run)
  if (first && lib.tracks.has(first)) { out.push(first); cur = gOf(first); run = 1; }
  const runFor = g => lessOf.has(g) ? 1 : RUN;
  while (out.length < ids.length) {
    const b = buckets.get(cur);
    if (b?.length && run < runFor(cur)) { out.push(b.pop()); run++; continue; }
    // next genre: similar ones are much more likely, never the same genre twice in a row if there's a choice,
    // genres you keep skipping only once the others are mostly done
    const left = [...buckets].filter(([, v]) => v.length);
    if (!left.length) break;
    const pool = left.length > 1 ? left.filter(([g]) => g !== cur) : left;
    let tot = 0;
    // (a genre that's falling behind gets a boost, so no genre piles up at the end — except ones you skip)
    const w = pool.map(([g, v]) => { const f = v.length / size.get(g); const x = (cur == null ? 1 : g && cur && near(cur, g) ? 4 : 1) * v.length * f * f * f * (lessOf.has(g) ? 0.04 : 1); tot += x; return x; });
    let r = Math.random() * tot, k = 0;
    while (k < w.length - 1 && (r -= w[k]) > 0) k++;
    cur = pool[k][0]; run = 0;
  }
  return out;
}
// Re-shuffle everything after the current song (songs you queued yourself stay first, in order)
function reshuffleRest() {
  const head = P.queue.slice(0, P.cursor + 1), rest = P.queue.slice(P.cursor + 1);
  const mine = rest.filter(q => q.user), others = rest.filter(q => !q.user).map(q => q.id);
  const cur = current();
  const g = cur ? gOf(cur.id) : null;
  P.queue = [...head, ...mine, ...genreShuffle(others, { prev: g, prevRun: lessOf.has(g) ? 99 : 1 }).map(id => ({ id, user: false }))];
}
// Skipping: tapping Next before most of the song has played (shuffle only)
function noteSkip() {
  const t = current(); if (!P.shuffle || !t) return;
  const played = P.time || 0, dur = P.duration || (t.durationMs || 0) / 1000;
  if (dur ? played > dur * 0.6 : played > 90) return; // (listened to most of it: not a skip)
  const g = genreOf(t); if (!g || lessOf.has(g)) return;
  const n = (skips.get(g) || 0) + 1; skips.set(g, n);
  if (n > 5) {
    lessOf.add(g);
    reshuffleRest(); persist(); queueChanged();
    toast(`Playing less ${g} for the rest of this shuffle`);
  }
}
