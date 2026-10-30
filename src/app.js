// BAZINGA — app shell, router and views
import { db, kv } from './db.js';
import { $, $$, esc, on, emit, toast, debounce, fmtTime, fmtDur, imageToDataURL, mainArtist, norm, trackKey, albumKey, yearOf, packToString, unpackString, sleep, downloadBlob, uid, displayTitle, genreOf } from './util.js';
import { icon, cover, trackRow, card, modal, promptText, confirmBox, menu, applyFilters, filterBar, empty, likedCover, loader, sized, toastUndo, THEMES, applyTheme, currentTheme, logoSrc } from './ui.js';
import { initVoice, openVoice, canListen, voiceOptions, setVoicePrefs, previewVoice, setWake, wakeSupported } from './voice.js';
import * as store from './store.js';
import { lib } from './store.js';
import * as meta from './meta.js';
import * as yt from './youtube.js';
import * as ya from './ytaccount.js';
import * as sync from './sync.js';
import * as sp from './spotify.js';
import * as imp from './importers.js';
import * as player from './player.js';
import { P } from './player.js';
import * as backup from './backup.js';
import { LEGAL_HTML, TERMS_VERSION } from './legal.js';
import { qrSVG } from './qr.js';

const view = () => $('#view');
const lists = new Map();      // listKey -> [trackIds] for "play from here"
const sections = new Map();   // sectionKey -> {tracks, opts}
const fstate = {};            // sectionKey -> filter state
let settings = { country: 'US', ytKey: '', customInstance: '', enrich: true, geniusToken: '', googleClientId: '', autoplay: 'liked', voiceName: '', wake: false };
export const APP_VERSION = 'v1.1';
const APP_TAGLINE = 'Music Made For You';
const BMC_URL = 'https://buymeacoffee.com/bazinga.app';
let profile = null;
let routeToken = 0;

// ================= BOOT =================
async function boot() {
  window.__bzStarted = true;
  setTimeout(hideSplash, 12000); // never leave the splash up if something below goes wrong
  if (location.protocol === 'file:') setTimeout(() => toast('Opened from a file: library & offline files work, but YouTube playback, Spotify and sharing need the GitHub Pages link.', 'err'), 1500);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').then(r => r.update().catch(() => { })).catch(() => { });
  checkForUpdate(true);
  settings = { ...settings, ...(await kv.get('settings', {})) };
  applySettings();
  yt.startInstances(); // warm up the YouTube server list in the background
  ya.restoreSession();
  const joinReq = readJoinLink();
  try { if (await sp.handleRedirect()) { toast('Spotify connected ✓'); location.hash = '#/import'; } }
  catch (e) { toast(e.message, 'err'); }
  await store.load();
  profile = await kv.get('profile');
  await player.restore();
  player.setEndHook(queueEnded);
  (window.requestIdleCallback || (f => setTimeout(f, 1200)))(() => player.warmup());
  backup.startAuto();
  wireGlobal();
  wireLock();
  on('sync', () => { renderProfileChip(); const el = $('#sync-line'); if (el) el.innerHTML = syncLine(); });
  on('sync-removed', () => { toast('Sync was turned off on another device — your music stays here'); if (location.hash.startsWith('#/settings')) rerender(); });
  on('synced-in', () => { if (location.hash.startsWith('#/settings') && !$('.modal-wrap')) rerender(); });
  on('profile-changed', p => { profile = p; renderProfileChip(); });
  // Settings that arrived from another synced device
  on('settings-synced', s => { settings = { ...settings, ...s }; applySettings(); setVoicePrefs({ name: settings.voiceName || '' }); applyLockSetting(); if (location.hash.startsWith('#/settings') && !$('.modal-wrap') && !isTyping()) rerender(); });
  on('kv-synced', () => { ya.restoreSession(); });
  if (!profile) { welcome(joinReq); return; }
  await sync.restore();
  await showApp();
  if (joinReq) joinFlow(joinReq);
}

// ---------- Splash screen: fades out once the first screen is ready (shown at least ~1 s) ----------
function hideSplash() {
  const sp = $('#splash'); if (!sp || sp.classList.contains('out')) return;
  setTimeout(() => { sp.classList.add('out'); setTimeout(() => sp.remove(), 700); }, Math.max(0, 1100 - performance.now()));
}

// ---------- Always run the newest version ----------
// Every time BAZINGA! is opened (or comes back to the screen) it asks the site which version is
// live (version.json, written by build.py). If you've pushed an update to GitHub, it reloads into it
// straight away — or, if music is playing, at the next pause or the next time the app is opened.
const RUNNING_VERSION = (() => {
  const v = el => (el?.match(/[?&]v=([0-9a-f]+)/) || [])[1] || '';
  const js = v([...document.scripts].find(x => /js\/bazinga\.js\?v=/.test(x.src))?.src);
  const css = v([...document.querySelectorAll('link[rel=stylesheet]')].find(x => /css\/app\.css\?v=/.test(x.href))?.href);
  return js && css ? js + '.' + css : '';
})();
let updateReady = '', lastUpdateCheck = 0;
async function checkForUpdate(atLaunch = false) {
  if (!RUNNING_VERSION || !location.protocol.startsWith('http') || !navigator.onLine) return;
  if (!atLaunch && Date.now() - lastUpdateCheck < 60e3) return;
  lastUpdateCheck = Date.now();
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    const live = (await r.json())?.v;
    if (!live || live === RUNNING_VERSION) { try { sessionStorage.removeItem('bz_upd'); } catch { } return; }
    updateReady = live;
    applyUpdate(atLaunch);
  } catch { }
}
async function applyUpdate(atLaunch) {
  if (!updateReady) return;
  const busy = player.isOn?.() && !atLaunch;
  if (busy) return; // don't cut the music off — happens at the next pause or launch
  let tried = null; try { tried = sessionStorage.getItem('bz_upd'); } catch { }
  if (tried === updateReady + ':done') { updateReady = ''; return; } // already tried twice — give up quietly until the next launch
  if (tried === updateReady) {
    // A normal reload didn't pick it up: clear the app's saved files (never your music) and try once more
    try { for (const k of await caches.keys()) if (k !== 'bazinga-img') await caches.delete(k); } catch { }
    try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.update(); } catch { }
    try { sessionStorage.setItem('bz_upd', updateReady + ':done'); } catch { }
  } else { try { sessionStorage.setItem('bz_upd', updateReady); } catch { } }
  try { saveSpot(); } catch { }
  location.reload();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (updateReady && !player.isOn()) applyUpdate(false); else checkForUpdate(); } });
on('player', () => { if (updateReady && !player.isOn()) setTimeout(() => { if (!player.isOn()) applyUpdate(false); }, 1500); });

// ---------- Sync your devices (no login: QR code, link or short code) ----------
// Links look like  …/#/link/<sync key>  (QR code / copy link)  or  …/#/c/<8-letter code>  (short link)
function readJoinLink() {
  const m = location.hash.match(/^#\/(link|c)\/([A-Za-z0-9_-]+)/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search + '#/home');
  return m[1] === 'link' ? { secret: m[2] } : { code: m[2] };
}
function syncLine() {
  const S = sync.state();
  if (!sync.linked()) return '';
  const ago = S.lastSync ? Math.max(0, Math.round((Date.now() - S.lastSync) / 60e3)) : null;
  return S.status === 'syncing' ? `<span class="sync-st busy">${icon('cloud')} Syncing…</span>`
    : S.status === 'error' ? `<span class="sync-st err">${icon('cloudOff')} ${esc(S.error || 'Sync failed')} — will retry</span>`
    : S.status === 'offline' ? `<span class="sync-st">${icon('cloudOff')} Offline — will sync when you're back online</span>`
    : `<span class="sync-st ok">${icon('check')} Synced${ago === null ? '' : ago < 1 ? ' just now' : ` ${ago} min ago`}</span>`;
}
// A popup that shows how a sync is going (step + progress bar), with Cancel.
// Tapping outside or × just hides it — the sync carries on in the background.
async function withSyncProgress(title, task) {
  let box = null, closeIt = null;
  const set = (label, pct) => {
    if (!box) return;
    if (label) box.querySelector('.sp-step').textContent = label;
    if (pct != null) box.querySelector('.sp-bar i').style.width = Math.max(4, Math.min(100, pct)) + '%';
  };
  modal(`<div class="sync-prog"><div class="sp-orb">${icon('cloud')}</div><h3>${esc(title)}</h3>
      <p class="muted sp-step">Starting…</p><div class="sp-bar" role="progressbar"><i></i></div>
      <div class="modal-actions center"><button type="button" class="btn ghost" data-sp-cancel>Cancel</button></div>
      <p class="tiny muted">You can close this — syncing carries on in the background.</p></div>`, {
    onMount: (m, close) => {
      box = m; closeIt = close;
      m.querySelector('[data-sp-cancel]').onclick = () => { sync.cancel(); set('Cancelling…'); };
    }
  }).then(() => { box = null; });
  const off = on('sync-progress', ({ label, pct }) => set(label, pct));
  try { return await task(set); }
  finally { off(); if (box) { set('Done', 100); setTimeout(() => { if (box) closeIt(null); }, 350); } }
}
// Join another device's library (from a link, QR code or short code)
async function joinFlow(req) {
  if (!sync.available()) return toast('Device sync needs the online (GitHub Pages) version of BAZINGA!.', 'err');
  let secret = req.secret;
  try {
    if (!secret) { toast('Checking your code…'); secret = await sync.redeemCode(req.code); }
    secret = sync.cleanSecret(secret);
    if (sync.linked() && sync.linkInfo().secret === secret) return toast('This device is already synced ✓', 'ok');
    const found = await sync.peek(secret).catch(() => null);
    const hasLocal = store.saved().length || lib.playlists.size || lib.albums.size;
    let mode = req.mode || 'merge';
    if (hasLocal && !req.mode) {
      mode = await modal(`<h3>${icon('cloud')} Sync this device</h3>
        <p class="muted">Linking to the library from <b>${esc(found?.device || 'your other device')}</b>. This ${sync.linked() ? 'device is already synced with a different library' : 'device already has music'}. What should happen to it?</p>
        <div class="pick-list">
          <button class="pick wrap" data-resolve="merge">${cover('', '+', 'sm')}<span><b>Combine both</b><small>Keep this device's music and add the other device's (recommended)</small></span></button>
          <button class="pick wrap" data-resolve="replace">${cover('', '↺', 'sm')}<span><b>Use only the synced library</b><small>Replace the music on this device with the other device's</small></span></button>
        </div>`);
      if (!mode) return;
    }
    if (sync.linked()) await sync.leave();
    await withSyncProgress('Syncing your music', () => sync.join(secret, mode));
    const S = sync.state();
    if (S.status === 'error') throw new Error(S.error);
    toast(found ? `Synced ✓ — ${store.saved().length} songs on this device` : 'Linked ✓ — your music arrives the next time BAZINGA! is open on your other device', 'ok');
    renderProfileChip(); rerender();
  } catch (e) { if (e.cancelled) toast('Sync cancelled — nothing changed on this device'); else toast(e.message, 'err'); }
}
async function enterCodeDialog() {
  const r = await modal(`<h3>${icon('link')} Link this device</h3>
    <p class="muted tiny">On the device that has your music: <b>Settings → Sync your devices → Link a device</b>. Then scan the QR code with this device's camera, open the link, or type the short code here.</p>
    <form><label class="fld"><span>Short code or sync link</span><input name="c" required autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="K7M2-Q9XA"></label>
    <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Link</button></div></form>`);
  if (!r?.c) return null;
  const v = r.c.trim();
  const m = v.match(/#\/(link|c)\/([A-Za-z0-9_-]+)/);
  if (m) return m[1] === 'link' ? { secret: m[2] } : { code: m[2] };
  if (sync.cleanSecret(v).length >= 20) return { secret: v };
  return { code: v };
}
// Show the QR code + link + short code so another phone/browser can join
async function linkDeviceDialog() {
  if (!sync.available()) return toast('Device sync needs the online (GitHub Pages) version of BAZINGA!.', 'err');
  if (!sync.linked()) {
    try { await withSyncProgress('Turning on sync', () => sync.create()); renderProfileChip(); }
    catch (e) { return toast(e.cancelled ? 'Sync cancelled' : e.message, e.cancelled ? 'info' : 'err'); }
  }
  const url = sync.linkURL();
  let timer = null;
  await modal(`<div class="link-dlg">
    <h3>${icon('link')} Link another device</h3>
    <p class="muted tiny">Scan with the other phone's camera, or open the link in any browser — another browser on this phone works too. That device then stays in sync automatically.</p>
    <div class="qr-box">${qrSVG(url)}</div>
    <div class="row-btns center"><button class="btn primary" data-copy-link>${icon('link')}Copy link</button>${navigator.share ? `<button class="btn" data-share-link>${icon('share')}Share</button>` : ''}</div>
    <div class="code-box">
      <div class="kicker">Typing it in instead?</div>
      <div class="code-out" hidden><b class="code-big"></b><span class="tiny muted code-short"></span><span class="tiny muted code-left"></span></div>
      <button class="btn ghost" data-make-code>Get a short code</button>
    </div>
    <p class="tiny muted">Anyone with this link or code can see and change your library — only use it on your own devices.</p>
    <div class="modal-actions center"><button class="btn" data-close>Done</button></div></div>`, {
    onMount: m => {
      m.querySelector('[data-copy-link]').onclick = () => copyText(url);
      const sh = m.querySelector('[data-share-link]');
      if (sh) sh.onclick = () => navigator.share({ title: 'BAZINGA! sync link', text: 'Open this to sync your BAZINGA! music:', url }).catch(() => { });
      const mk = m.querySelector('[data-make-code]');
      mk.onclick = async () => {
        mk.disabled = true; mk.textContent = 'Making a code…';
        try {
          const code = await sync.makeCode(), until = Date.now() + 15 * 60e3;
          const out = m.querySelector('.code-out'); out.hidden = false;
          out.querySelector('.code-big').textContent = sync.prettyCode(code);
          out.querySelector('.code-short').textContent = sync.codeURL(code).replace(/^https?:\/\//, '');
          const tick = () => { const s = Math.max(0, Math.round((until - Date.now()) / 1000)); out.querySelector('.code-left').textContent = s ? `Works once, for ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Expired — get a new code'; if (!s) clearInterval(timer); };
          tick(); clearInterval(timer); timer = setInterval(tick, 1000);
          mk.textContent = 'Get a new code';
        } catch (e) { toast(e.message, 'err'); mk.textContent = 'Get a short code'; }
        mk.disabled = false;
      };
    }
  });
  clearInterval(timer);
  if (location.hash.startsWith('#/settings')) rerender();
}
async function syncMenu(kind) {
  if (kind === 'leave') {
    if (!await confirmBox('Stop syncing this device?', 'Your music stays on this device, but changes won\'t reach your other devices any more.', 'Stop syncing')) return;
    await sync.leave(); toast('This device is no longer synced'); renderProfileChip(); rerender();
  }
  if (kind === 'forget') {
    if (!await confirmBox('Turn off sync everywhere?', 'Every linked device stops syncing the next time it opens. Each device keeps the music it has.', 'Turn off everywhere', true)) return;
    try { await sync.removeEverywhere(); toast('Sync is off on every device'); renderProfileChip(); rerender(); } catch (e) { toast(e.message, 'err'); }
  }
}
async function wipeDevice() {
  player.stopAll();
  await db.destroy();
  try { localStorage.clear(); sessionStorage.clear(); } catch { }
  if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
  if (navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  location.replace(location.pathname);
}
async function profileChanged() { profile.updatedAt = Date.now(); await kv.set('profile', profile); emit('dirty', 'profile'); renderProfileChip(); }

function applySettings() {
  applyTheme(settings.theme || currentTheme());
  setVoicePrefs({ recognizeKey: settings.auddToken || window.BAZINGA_CONFIG?.auddToken || '' });
  ya.setGoogleClientId(settings.googleClientId || window.BAZINGA_CONFIG?.googleClientId || '');
  meta.setCountry(settings.country);
  yt.setYTSettings({ ytKey: settings.ytKey, customInstance: settings.customInstance, ownerKey: window.BAZINGA_CONFIG?.youtubeApiKey || '' });
  store.setEnrich(settings.enrich !== false);
  keepAwake();
}

// ---------- Keep the screen on while BAZINGA! is open ----------
// Phones stop web music when they lock, so by default the screen stays awake while the app is open.
// Uses the Screen Wake Lock API; on older iPhones (no Wake Lock) a tiny silent, muted video does the same job.
let wakeLock = null, awakeVid = null;
async function keepAwake() {
  const want = settings.keepAwake !== false && !!profile && document.visibilityState === 'visible' && matchMedia('(pointer: coarse)').matches; // phones & tablets
  if (!want) {
    try { await wakeLock?.release(); } catch { } wakeLock = null;
    awakeVid?.pause();
    return;
  }
  if ('wakeLock' in navigator) {
    if (wakeLock && !wakeLock.released) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener?.('release', () => { wakeLock = null; }); } catch { wakeLock = null; }
    return;
  }
  if (!awakeVid) {
    awakeVid = document.createElement('video');
    Object.assign(awakeVid, { muted: true, loop: true, playsInline: true, src: 'media/awake.mp4' });
    awakeVid.setAttribute('playsinline', ''); awakeVid.setAttribute('muted', ''); awakeVid.setAttribute('aria-hidden', 'true');
    awakeVid.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0';
    document.body.appendChild(awakeVid);
  }
  awakeVid.play().catch(() => { });
}
document.addEventListener('visibilitychange', () => keepAwake());
// Some browsers only grant it after a tap — try again on the first touches until it holds
['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => { if (settings.keepAwake !== false && profile && !(wakeLock && !wakeLock.released) && !(awakeVid && !awakeVid.paused)) keepAwake(); }, { passive: true }));
// Colour swatches (welcome card + Settings → You). Tapping one previews it instantly.
const themePicker = (cur = currentTheme()) => `<div class="theme-pick" role="radiogroup" aria-label="Theme colour">${THEMES.map(([k, l, c]) =>
  `<button type="button" class="tp ${k === cur ? 'on' : ''}" data-theme="${k}" role="radio" aria-checked="${k === cur}" aria-label="${l}" title="${l}" style="--c:rgb(${c.join(' ')})"><i>${icon('check')}</i><span>${l}</span></button>`).join('')}</div>`;
function markThemePicks(name) { $$('.theme-pick .tp').forEach(b => { const on = b.dataset.theme === name; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); }); }
// Each setting remembers when YOU last changed it, so synced devices know which value is newer.
// Saving a form with an unchanged (or still empty) field doesn't count as a change.
async function saveSettings(patch) {
  const ts = { ...(settings._ts || {}) };
  for (const [k, v] of Object.entries(patch)) if (JSON.stringify(settings[k]) !== JSON.stringify(v)) ts[k] = Date.now();
  settings = { ...settings, ...patch, _ts: ts };
  await kv.set('settings', settings); applySettings(); emit('dirty', 'settings');
}

async function termsGate() {
  while (profile.termsAccepted !== TERMS_VERSION) {
    hideSplash();
    const r = await modal(`<h3>${icon('shield')} Privacy Policy & Terms</h3>
      <p class="muted tiny">${profile.termsAccepted ? 'Our terms have been updated. ' : ''}Please read and accept to keep using BAZINGA!.</p>
      <div class="legal-box">${LEGAL_HTML}</div>
      <form><label class="agree"><input type="checkbox" name="ok" required><span>I have read and agree to the Privacy Policy and Terms of Use, and I understand BAZINGA! is provided as-is with no liability.</span></label>
      <div class="modal-actions"><button type="button" class="btn ghost" data-resolve="no">Decline</button><button class="btn primary">Accept</button></div></form>`, { wide: true, locked: true });
    if (r && r.ok) { profile.termsAccepted = TERMS_VERSION; profile.termsAcceptedAt = new Date().toISOString(); await kv.set('profile', profile); emit('dirty', 'terms'); }
    else if (r === 'no') await modal(`<h3>You need to accept to use BAZINGA!</h3><p class="muted">If you don't agree, you can erase all of BAZINGA!'s data from this device.</p>
      <div class="modal-actions"><button class="btn danger" data-resolve="del">Delete my data</button><button class="btn primary" data-resolve="back">Go back</button></div>`, { locked: true })
      .then(x => x === 'del' && deleteAccount());
  }
}

// ---------- Screen lock: ignore touches while the music plays ----------
// Lock with the 🔒 button (top bar / sidebar / full-screen player) or by tapping an empty spot of
// the screen 3 times quickly. Tap 3 times anywhere to unlock. Settings → Playback turns it off.
let appLocked = false;
const lockFeature = () => settings.lockFeature !== false;
function setLocked(on) {
  appLocked = !!on;
  document.body.classList.toggle('app-locked', appLocked);
  let ov = $('#lock-layer');
  if (!ov) {
    ov = document.createElement('div'); ov.id = 'lock-layer'; ov.hidden = true;
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Screen locked');
    ov.innerHTML = `<div class="lock-pill">${icon('lock')}<span><b>Locked</b><small>Tap 3 times to unlock</small></span></div>`;
    document.body.appendChild(ov);
  }
  ov.hidden = !appLocked;
  if (appLocked) { try { document.activeElement?.blur(); } catch { } closeMenuSafe(); flashLockPill(); }
  else toast('Unlocked', 'ok');
}
function closeMenuSafe() { const m = $('#menu-root'); if (m) m.innerHTML = ''; }
let pillT = null;
function flashLockPill() {
  const p = $('#lock-layer .lock-pill'); if (!p) return;
  p.classList.add('show'); clearTimeout(pillT); pillT = setTimeout(() => p.classList.remove('show'), 2600);
}
function applyLockSetting() { document.body.classList.toggle('lock-off', !lockFeature()); }
function wireLock() {
  applyLockSetting();
  let taps = [];
  const interactive = 'button, a, input, select, textarea, label, summary, [data-act], [data-p], [contenteditable], .row, .card, .qrow, .modal-wrap, .menu, .menu-back, #yt-dock, .seek, .vol';
  document.addEventListener('pointerdown', e => {
    if (!appLocked && (!lockFeature() || !e.isPrimary || e.target.closest(interactive))) { taps = []; return; }
    const now = Date.now(), last = taps[taps.length - 1];
    if (last && (now - last.t > 500 || Math.hypot(e.clientX - last.x, e.clientY - last.y) > 60)) taps = [];
    taps.push({ t: now, x: e.clientX, y: e.clientY });
    if (appLocked) flashLockPill();
    if (taps.length >= 3) { taps = []; setLocked(!appLocked); }
  }, true);
  // While locked, nothing underneath reacts: no taps, keys, scrolling or zooming
  const block = e => { if (appLocked) { e.preventDefault(); e.stopPropagation(); } };
  ['click', 'dblclick', 'contextmenu', 'keydown', 'keypress', 'wheel', 'touchmove', 'gesturestart'].forEach(ev => document.addEventListener(ev, block, { capture: true, passive: false }));
}

// ---------- Keep the page pinned to the screen ----------
// iPhones scroll the whole page when the keyboard opens (or after a bounce) and sometimes leave it
// there, which lifts the bottom tab bar and leaves a gap under it — most visible in the installed app.
// Only the full-screen player scrolls the page on purpose, so everywhere else snap it back.
function pinPage() {
  if (document.body.classList.contains('np-open')) return;
  if (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop) { window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; }
}
const pinSoon = () => { setTimeout(pinPage, 60); setTimeout(pinPage, 350); };
document.addEventListener('focusout', pinSoon);
window.addEventListener('orientationchange', pinSoon);
window.addEventListener('pageshow', pinSoon);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pinSoon(); });
window.visualViewport?.addEventListener('resize', pinSoon);
window.addEventListener('scroll', () => { if (!document.body.classList.contains('np-open') && !isTypingNow()) pinSoon(); }, { passive: true });
const isTypingNow = () => document.activeElement?.matches?.('input,textarea,select');

// ---------- Phone top bar: shrink the logo text until everything fits ----------
// (Fonts and screen widths differ between phones, so measure instead of guessing.)
function fitTopbar() {
  const bar = $('.topbar'), wm = $('.brand-m .wordmark');
  if (!bar || !wm || getComputedStyle(bar).display === 'none') return;
  document.documentElement.style.removeProperty('--wm-size');
  let size = parseFloat(getComputedStyle(wm).fontSize) || 22, n = 0;
  const over = () => bar.scrollWidth > bar.clientWidth + 1 || [...bar.children].some(c => c.offsetParent && c.getBoundingClientRect().right > bar.getBoundingClientRect().right - 4);
  while (over() && size > 13 && n++ < 20) { size -= 1; document.documentElement.style.setProperty('--wm-size', size + 'px'); }
}
window.addEventListener('resize', debounce(fitTopbar, 150));
document.fonts?.ready?.then(() => fitTopbar());

// ---------- Live clock on the home hero (the device's own time zone & 12/24-hour setting) ----------
const clockText = () => new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
let clockTimer = null;
function startClock() {
  clearTimeout(clockTimer);
  const tick = () => {
    const els = $$('[data-clock]'); if (!els.length) return; // stops when you leave Home
    const t = clockText(); els.forEach(el => { if (el.textContent !== t) el.textContent = t; });
    const d = $('[data-date]'); if (d) d.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    clockTimer = setTimeout(tick, 60000 - Date.now() % 60000 + 50);
  };
  tick();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('[data-clock]')) startClock(); });

// ---------- Remember where you were (refresh / reopening the app lands on the same spot) ----------
const SPOT_KEY = 'bz_spot';
function saveSpot() {
  if (!profile || $('#app').hidden) return;
  try { localStorage.setItem(SPOT_KEY, JSON.stringify({ h: location.hash || '#/home', y: $('#main')?.scrollTop || 0, np: document.body.classList.contains('np-open'), q: lastSearch.q, tab: lastSearch.tab, ts: Date.now() })); } catch { }
}
function readSpot() { try { return JSON.parse(localStorage.getItem(SPOT_KEY) || 'null'); } catch { return null; } }
let restoreSpot = null;
function planRestore() {
  const sp = readSpot();
  if (!sp || Date.now() - sp.ts > 7 * 864e5) return;
  if (sp.q) lastSearch.q = sp.q;
  if (sp.tab) lastSearch.tab = sp.tab;
  const h = location.hash;
  // Installed apps always reopen at the start page, and some sign-in redirects drop the page — go back to where you were
  if ((!h || h === '#' || h === '#/' || h === '#/home') && sp.h && sp.h !== '#/home' && !/^#\/s\//.test(sp.h)) history.replaceState(null, '', location.pathname + location.search + sp.h);
  if ((location.hash || '#/home') === sp.h) restoreSpot = sp;
}
const saveSpotSoon = debounce(saveSpot, 300);
window.addEventListener('pagehide', saveSpot);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveSpot(); });

async function showApp() {
  await termsGate();
  planRestore();
  $('#onboarding').hidden = true;
  $('#app').hidden = false;
  $$('.ni').forEach(el => { const n = [...el.classList].find(c => c.startsWith('ni-')).slice(3); el.outerHTML = icon(n); });
  $('#main').addEventListener('scroll', saveSpotSoon, { passive: true });
  wireToTop();
  setTimeout(launchPopups, 3500);
  renderProfileChip(); renderSidebarPlaylists(); renderPlayer();
  requestAnimationFrame(fitTopbar); setTimeout(fitTopbar, 800);
  initVoice({
    go: h => { location.hash = h; }, back: () => goBack(),
    search: (q, tab = 'all') => { lastSearch.q = q; if (location.hash === '#/search/' + tab) route(); else location.hash = '#/search/' + tab; },
    openNP: () => openNP(), closeNP: () => closeNP(), lyrics: on => setLyrics(on), toast
  });
  route().finally(hideSplash);
  try { speechSynthesis.addEventListener('voiceschanged', () => { if (location.hash.startsWith('#/settings') && !$('#set-voice')) rerender(); }); } catch { }
  setVoicePrefs({ name: settings.voiceName || '' });
  setWake(false); // no background listening: the mic is only on while the assistant is open
  if (navigator.storage?.persist) navigator.storage.persist();
}

// ---------- Floating "back to top" (shows while you scroll far down, hides when you stop) ----------
function wireToTop() {
  const main = $('#main'), btn = $('#to-top');
  let idle = null, lastY = 0;
  const hide = () => btn.classList.remove('show');
  main.addEventListener('scroll', () => {
    const y = main.scrollTop;
    const far = y > Math.max(700, innerHeight * 1.2);
    btn.classList.toggle('show', far);
    lastY = y;
  }, { passive: true });
  btn.onclick = () => { main.scrollTo({ top: 0, behavior: 'smooth' }); hide(); };
}

// ---------- "Add to Home Screen" ----------
// Chrome/Edge/Samsung/Brave on Android & desktop give us a real install button; iPhone/iPad
// (Safari, and Chrome/Edge/Firefox there) and Firefox on Android get short step-by-step instructions.
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
window.addEventListener('appinstalled', () => { installEvt = null; kv.set('a2hs', { done: true }); toast('BAZINGA! is on your Home Screen ⚡', 'ok'); });
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// Counts each time the app is opened (a reload in the same tab doesn't count again)
async function countLaunch() {
  let fresh = true; try { fresh = !sessionStorage.getItem('bz_launch'); sessionStorage.setItem('bz_launch', '1'); } catch { }
  const n = ((await kv.get('launches')) || 0) + (fresh ? 1 : 0);
  if (fresh) await kv.set('launches', n);
  return { n, fresh };
}
const isInstalled = async () => isStandalone() || !!((await kv.get('a2hs')) || {}).done;
// First visit: "Add to Home Screen". Then every 5th visit until it's installed or "Don't show again".
// The "Do you love BAZINGA!?" coffee popup: every 10th time the app is opened, until "Don't show this again"
// (if it lands on an Add to Home Screen visit, it follows right after that popup).
async function launchPopups() {
  const { n, fresh } = await countLaunch();
  if (!fresh || !profile || $('.modal-wrap') || document.body.classList.contains('np-open')) return;
  const a2 = (await kv.get('a2hs')) || {}, cof = (await kv.get('phase2')) || {};
  const wantA2 = !a2.never && !(await isInstalled()) && (n === 1 || n % 5 === 0);
  const wantCoffee = !cof.never && (n % 10 === 0 || (cof.pending && n > 1));
  if (wantA2) await maybeInstallPrompt();
  if (!wantCoffee) return;
  cof.pending = false; await kv.set('phase2', cof);
  setTimeout(() => { if (!$('.modal-wrap') && !$('#mix-ov')) phase2Popup({ love: true }); else { cof.pending = true; kv.set('phase2', cof); } }, wantA2 ? 700 : 0);
}
async function maybeInstallPrompt(force = false) {
  if (isStandalone()) { if (force) toast('BAZINGA! is already installed on this device ✓', 'ok'); return; }
  const st = (await kv.get('a2hs')) || {};
  const ios = isIOS(), ua = navigator.userAgent;
  // Samsung Internet wraps installed sites in its own outdated Android package, which Google Play
  // Protect blocks ("Unsafe app blocked"). Nothing on our side can change that package, so on
  // Samsung Internet we never use its installer and send people to Chrome to install instead.
  const samsung = /SamsungBrowser/i.test(ua) && /android/i.test(ua);
  const canPrompt = installEvt && !samsung;
  const chromeIntent = `intent://${location.host}${location.pathname}#Intent;scheme=https;package=com.android.chrome;end`;
  const shareIc = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 11v9h14v-9"/></svg>';
  const dots = '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="19" r="1.8" fill="currentColor"/></svg>';
  const steps = canPrompt ? '' : samsung ? `<p class="a2-warn">${icon('shield')}<span>Samsung Internet's installer makes an app that Google Play Protect blocks. Install BAZINGA! from another browser instead — <b>Chrome, Firefox, Microsoft Edge, Brave or Opera</b> all work.</span></p>
      <ol class="a2-steps"><li>Tap <b>Copy link</b>, open one of those browsers (get one free from the Play Store if you need to) and paste the link.</li><li>In that browser, open its menu <span class="a2-ic">${dots}</span> and tap <b>Install</b> or <b>Add to Home screen</b>.</li><li>Bring your music along: here, <b>Settings → Sync your devices → Link a device</b>, then open that link in the new browser.</li></ol>` : ios ? `<ol class="a2-steps"><li>Tap the <b>Share</b> button <span class="a2-ic">${shareIc}</span> ${/CriOS|FxiOS|EdgiOS/.test(ua) ? '(top or bottom of the screen)' : 'in the toolbar'}.</li><li>Scroll and tap <b>Add to Home Screen</b> <span class="a2-ic">${icon('plus')}</span>.</li><li>Tap <b>Add</b>. Done — BAZINGA! opens like an app.</li></ol>`
    : /Firefox/i.test(ua) ? `<ol class="a2-steps"><li>Tap the menu <span class="a2-ic">${dots}</span>.</li><li>Tap <b>Install</b> (or <b>Add to Home screen</b>).</li></ol>`
    : `<ol class="a2-steps"><li>Open your browser menu <span class="a2-ic">${dots}</span>.</li><li>Tap <b>Install app</b> or <b>Add to Home screen</b>.</li></ol>`;
  const r = await modal(`<div class="a2hs">
      <div class="a2-icon"><img src="${logoSrc('app-192')}" alt="BAZINGA! app icon" width="96" height="96"></div>
      <h3>Add BAZINGA! to your Home Screen</h3>
      <p class="muted">One tap away, full screen like a real app, and music keeps going better in the background.</p>
      ${steps}
      <div class="modal-actions center">${canPrompt ? `<button class="btn primary" data-resolve="install">${icon('plus')}Add to Home Screen</button>` : samsung ? `<button class="btn primary" type="button" data-copy-app>${icon('link')}Copy link</button><a class="btn" href="${esc(chromeIntent)}">Open in Chrome</a>` : `<button class="btn primary" data-resolve="later">Got it</button>`}</div>
      <button class="lnk tiny a2-never" data-resolve="never">Don't show this again</button>
    </div>`, { onMount: m => { const c = m.querySelector('[data-copy-app]'); if (c) c.onclick = async () => toast(await copyText(location.origin + location.pathname) ? 'Link copied — paste it into your other browser' : location.origin + location.pathname, 'ok'); } });
  if (r === 'install' && canPrompt) {
    installEvt.prompt();
    try { const c = await installEvt.userChoice; if (c.outcome === 'accepted') st.done = true; } catch { }
    installEvt = null;
  } else if (r === 'never') st.never = true;
  kv.set('a2hs', st);
}

// ================= WELCOME (no sign-up, no login) =================
// One tap to start. Name and photo are optional and can be set any time in Settings.
function welcome(joinReq = null) {
  $('#app').hidden = true;
  const ob = $('#onboarding'); ob.hidden = false;
  const canSync = sync.available();
  ob.innerHTML = `<div class="ob-card">
    <div class="ob-brand"><span class="logo-mark big"><img src="${logoSrc('icon-512')}" class="ob-logo" alt=""></span><h1 class="wordmark">BAZINGA!</h1></div>
    <p class="muted ob-sub">${joinReq ? 'Almost there! This browser will sync with your music from your other device.' : 'All your favorite songs from Spotify and Apple Music, playing as music videos and audio in one free player. No sign up, no login, just press play ⚡'}</p>
    ${!joinReq ? `<form id="ob-form" class="ob-form" novalidate>
      <label class="ob-pic" title="Add a profile picture (optional)"><input type="file" accept="image/*" id="ob-file" hidden><div class="avatar xl" id="ob-avatar">${icon('user')}</div><span>Add photo</span></label>
      <label class="fld"><span>Pick a username</span><input name="username" id="ob-name" maxlength="30" autocomplete="nickname" placeholder="e.g. thunderkid" enterkeyhint="go"></label>
      <div class="fld ob-theme"><span>Pick your color</span>${themePicker()}</div>
    </form>` : ''}
    <label class="agree ob-terms"><input type="checkbox" id="ob-terms"><span>I agree to the <a class="lnk" href="#" id="ob-legal">Privacy Policy & Terms of Use</a>. BAZINGA! is provided as-is and isn't liable for anything.</span></label>
    <button class="btn primary big" id="ob-go">${joinReq ? `${icon('link')}Sync this browser` : `Let's go ${icon('play')}`}</button>
    ${!joinReq && canSync ? `<button class="btn" id="ob-link">${icon('qr')}I use BAZINGA! on another device</button>` : ''}
    ${!joinReq ? `<button class="btn ghost" id="ob-restore">${icon('restore')}Restore from a backup file</button>` : ''}
    <p class="tiny muted">No email, no password — your name and music are saved on this device.</p>
    <p class="copyright">© 2026 Abbel Dawit · BAZINGA!</p>
  </div>`;
  $('#ob-legal').onclick = e => { e.preventDefault(); showLegal(); };
  hideSplash();
  const termsOk = () => {
    if ($('#ob-terms').checked) return true;
    $('.ob-terms').classList.add('shake'); setTimeout(() => $('.ob-terms')?.classList.remove('shake'), 600);
    toast('Please accept the Privacy Policy & Terms first', 'err'); return false;
  };
  let pic = '';
  const fileIn = $('#ob-file');
  if (fileIn) fileIn.onchange = async e => { const f = e.target.files[0]; if (!f) return; pic = await imageToDataURL(f, 256); $('#ob-avatar').innerHTML = `<img src="${pic}" alt="">`; };
  const nameOk = () => {
    const i = $('#ob-name'); if (!i) return true;
    if (i.value.trim()) return true;
    i.focus(); i.closest('.fld').classList.add('shake'); setTimeout(() => i.closest('.fld')?.classList.remove('shake'), 600);
    toast('Pick a username first', 'err'); return false;
  };
  $('#ob-form')?.addEventListener('submit', e => { e.preventDefault(); $('#ob-go').click(); });
  ob.addEventListener('click', e => { const b = e.target.closest('[data-theme]'); if (!b) return; applyTheme(b.dataset.theme); markThemePicks(b.dataset.theme); });
  const start = async (req, name = '') => {
    profile = { username: name || 'Listener', picture: name ? pic : '', createdAt: Date.now(), updatedAt: name ? Date.now() : 0, termsAccepted: TERMS_VERSION, termsAcceptedAt: new Date().toISOString() };
    await kv.set('profile', profile);
    emit('dirty', 'profile');
    await saveSettings({ theme: currentTheme() });
    location.hash = '#/home';
    await sync.restore();
    await showApp();
    if (req) joinFlow({ ...req, mode: 'replace' });
  };
  $('#ob-go').onclick = () => { if (!joinReq && !nameOk()) return; if (termsOk()) start(joinReq, joinReq ? '' : $('#ob-name').value.trim().slice(0, 30)); };
  const lk = $('#ob-link');
  if (lk) lk.onclick = async () => { if (!termsOk()) return; const req = await enterCodeDialog(); if (req) start(req); };
  const rs = $('#ob-restore');
  if (rs) rs.onclick = () => pickFile('.json,application/json', async f => {
    try { await backup.restoreFromFile(f); location.reload(); } catch (err) { toast(err.message, 'err'); }
  });
}

// ================= ROUTER =================
window.addEventListener('hashchange', () => profile && profile.termsAccepted === TERMS_VERSION && route());
const showLegal = () => modal(`<h3>${icon('shield')} Privacy Policy & Terms</h3><div class="legal-box">${LEGAL_HTML}</div>`, { wide: true });
// Browser tab title: "BAZINGA! - <page>"
const setTitle = x => { document.title = 'BAZINGA! - ' + (x || APP_TAGLINE); };
const TITLES = { new: 'New from your top artists', home: APP_TAGLINE, search: 'Search', import: 'Settings', offline: 'Offline', settings: 'Settings', queue: 'Queue', legal: 'Privacy & Terms', s: 'Shared music', support: 'Support' };
const LIB_TABS = { songs: 'Songs', liked: 'Liked Songs', playlists: 'Playlists', albums: 'Albums', artists: 'Artists' };
// Where "Back" goes when there's no in-app history (e.g. a shared link opened directly)
const BACK_TO = { new: ['#/home', 'Home'], artist: ['#/library/artists', 'Artists'], album: ['#/library/albums', 'Albums'], playlist: ['#/library/playlists', 'Playlists'], genre: ['#/home', 'Home'], s: ['#/home', 'Home'], legal: ['#/settings', 'Settings'], queue: ['#/home', 'Home'] };
const navStack = [];
function goBack() {
  const name = (location.hash.replace(/^#\/?/, '').split('/')[0]);
  if (navStack.length > 1) history.back();
  else location.hash = (BACK_TO[name] || ['#/home'])[0];
}

async function route() {
  if (/^#\/(link|c)\//.test(location.hash)) { const req = readJoinLink(); if (req) joinFlow(req); return route(); }
  const my = ++routeToken;
  const full = location.hash || '#/home';
  if (navStack[navStack.length - 2] === full) navStack.pop(); else if (navStack[navStack.length - 1] !== full) navStack.push(full);
  if (navStack.length > 50) navStack.shift();
  const h = location.hash.replace(/^#\/?/, '') || 'home';
  const [name, ...rest] = h.split('/');
  setTitle(name === 'library' ? (LIB_TABS[rest[0] || 'songs'] || 'Library') : (TITLES[name] || (name === 'genre' ? decodeURIComponent(rest[0] || '') : APP_TAGLINE)));
  const arg = rest.map(decodeURIComponent);
  lists.clear(); sections.clear(); pagers.clear();
  $$('.nav a, .tabbar a').forEach(a => a.classList.toggle('on', a.dataset.r === name || (name === 'import' && a.dataset.r === 'settings')));
  if (!restoreSpot?.np && document.body.classList.contains('np-open')) closeNP('nav');
  $('#modal-root').innerHTML = ''; $('#menu-root').innerHTML = '';
  closeQueueOnMobile();
  const v = view();
  v.scrollTop = 0; $('#main').scrollTop = 0;
  const routes = { new: vNewReleases, home: vHome, search: vSearch, library: vLibrary, playlist: vPlaylist, album: vAlbum, artist: vArtist, import: () => vSettings(['import']), offline: vOffline, settings: vSettings, s: vShared, queue: vQueue, genre: vGenre, legal: vLegal, support: vSupport };
  const fn = routes[name] || vHome;
  v.innerHTML = loader();
  // Back button on detail pages (artist, album, playlist, genre, shared, …) — added as soon as the
  // page appears, not after slow lookups finish
  const addBack = () => {
    const page = v.querySelector('.page');
    if (my !== routeToken || !page || !BACK_TO[name] || page.querySelector('.backbtn')) return;
    const prev = navStack[navStack.length - 2];
    const label = prev ? backLabel(prev) : BACK_TO[name][1];
    page.insertAdjacentHTML('afterbegin', `<button class="backbtn" data-act="go-back">${icon('back')}<span>${esc(label)}</span></button>`);
  };
  const run = (async () => fn(arg, my))();
  addBack(); requestAnimationFrame(addBack);
  try { await run; } catch (e) { console.error(e); if (my === routeToken) v.innerHTML = empty('Something went wrong', esc(e.message)); }
  if (my !== routeToken) return;
  addBack();
  markNow();
  // Coming back after a refresh: same scroll position, full-screen player open again if it was
  if (restoreSpot) {
    const sp = restoreSpot; restoreSpot = null;
    const y = sp.y || 0;
    if (y) { $('#main').scrollTop = y; setTimeout(() => { if ($('#main').scrollTop < y - 5) $('#main').scrollTop = y; }, 400); }
    if (sp.np && player.current()) openNP();
  }
  saveSpotSoon();
}
function backLabel(hash) {
  const [n, a] = hash.replace(/^#\/?/, '').split('/');
  if (n === 'library') return LIB_TABS[a || 'songs'] || 'Library';
  if (n === 'artist') return decodeURIComponent(a || 'Artist');
  if (n === 'playlist') return lib.playlists.get(a)?.name || 'Playlist';
  if (n === 'album') return 'Album';
  if (n === 'genre') return decodeURIComponent(a || 'Genre');
  return TITLES[n] === APP_TAGLINE ? 'Home' : (TITLES[n] || 'Back');
}
const stale = my => my !== routeToken;
const rerender = debounce(() => {
  // Re-render the current view softly when library changes (keeps scroll)
  const sc = $('#main').scrollTop;
  route().then(() => { $('#main').scrollTop = sc; });
}, 250);

// ================= TRACK LIST SECTIONS =================
const PAGE = 150;
function tracksSection(key, tracks, opts = {}) {
  sections.set(key, { tracks, opts });
  fstate[key] = fstate[key] || { sort: opts.defaultSort ?? 'added', open: false };
  return `<div class="tsec" data-tsec="${key}">${tracksSectionInner(key)}</div>`;
}
function tracksSectionInner(key) {
  const { tracks, opts } = sections.get(key);
  const f = fstate[key];
  const shown = opts.noFilter ? tracks : applyFilters(tracks, f);
  lists.set(key, shown.map(t => t.id));
  const cur = player.current()?.id;
  const head = opts.noFilter ? '' : filterBar(f, tracks, { keepOrder: opts.keepOrder, likedSort: opts.likedSort });
  const count = !opts.noFilter && shown.length !== tracks.length ? `<div class="muted tiny count">${shown.length} of ${tracks.length} songs</div>` : '';
  const rows = shown.slice(0, PAGE).map((t, i) => trackRow(t, i, { list: key, playlistId: opts.playlistId, numbered: opts.numbered }, cur)).join('');
  const more = shown.length > PAGE ? `<div class="more" data-more="${key}" data-at="${PAGE}"></div>` : '';
  return head + count + `<div class="rows">${rows || '<div class="muted pad">No songs match these filters.</div>'}</div>` + more;
}
function refreshSection(key, keepFocus) {
  const el = $(`[data-tsec="${key}"]`); if (!el) return;
  const active = document.activeElement?.dataset?.f;
  const pos = document.activeElement?.selectionStart;
  el.innerHTML = tracksSectionInner(key);
  markNow();
  if (keepFocus && active) { const i = el.querySelector(`[data-f="${active}"]`); i?.focus(); try { i.setSelectionRange(pos, pos); } catch { } }
  observeMore();
}
const moreObs = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const el = e.target, key = el.dataset.more, at = +el.dataset.at;
    const ids = lists.get(key) || [];
    const rowsEl = el.previousElementSibling;
    const cur = player.current()?.id;
    const { opts } = sections.get(key) || { opts: {} };
    rowsEl.insertAdjacentHTML('beforeend', ids.slice(at, at + PAGE).map((id, j) => trackRow(lib.tracks.get(id), at + j, { list: key, playlistId: opts.playlistId }, cur)).join(''));
    if (at + PAGE >= ids.length) { moreObs.unobserve(el); el.remove(); } else el.dataset.at = at + PAGE;
    markNow();
  }
}, { rootMargin: '600px' });
function observeMore() { $$('[data-more]').forEach(el => moreObs.observe(el)); }

// ================= VIEWS =================
function header(title, sub = '', art = '', actions = '', kind = '') {
  return `<header class="hero ${art ? 'has-art' : ''}">
    ${art ? `<div class="hero-art ${kind === 'artist' ? 'round' : ''}">${art}</div>` : ''}
    <div class="hero-txt">${kind ? `<div class="kicker">${kind}</div>` : ''}<h1>${title}</h1>${sub ? `<div class="hero-sub">${sub}</div>` : ''}</div>
  </header>${actions ? `<div class="actions">${actions}</div>` : ''}`;
}
const playBtns = (act, id = '') => `<button class="btn primary round-play" data-act="${act}" data-id="${esc(id)}" aria-label="Play">${icon('play')}</button>
  <button class="ib lg" data-act="${act}" data-id="${esc(id)}" data-shuffle="1" aria-label="Shuffle play" title="Shuffle">${icon('shuffle')}</button>
  <button class="ib lg" data-act="${act}" data-id="${esc(id)}" data-queue="1" aria-label="Add all to queue" title="Add to queue">${icon('queue')}</button>`;

// ---------- HOME ----------
async function vHome(_, my) {
  const all = store.saved();
  const hr = new Date().getHours();
  const greet = hr < 5 ? 'Late night vibes' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  if (!all.length) {
    view().innerHTML = `<div class="page home">
      <section class="home-hero empty-hero"><div class="hh-bg"></div><div class="hh-txt"><div class="kicker hh-when"><span data-date>${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span><span class="hh-time">${icon('clock')}<time data-clock>${clockText()}</time></span></div><h1>${greet}${profile.username && profile.username !== 'Listener' ? ', ' + esc(profile.username) : ''}</h1>
        <p>Bring in your Spotify, Apple Music or YouTube favourites and play them as music videos or audio.</p>
        <div class="row-btns">${bzBtn('primary')}<a class="btn" href="#/search">${icon('search')}Search</a><a class="btn" href="#/import">${icon('import')}Import music</a></div>
        <p class="tiny muted hh-note">You can import any time from Settings → Import music.${sync.available() && !sync.linked() ? ' Already using BAZINGA! somewhere else? <button class="lnk" data-act="enter-code">Link this device</button>.' : ''}</p></div></section></div>`;
    startClock();
    return;
  }
  const liked = all.filter(t => t.liked);
  const recent = all.filter(t => !t.mix || t.liked).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 12);
  // Top playlists: the ones you play most, then the newest
  const plays = (await kv.get('plPlays')) || {};
  if (stale(my)) return;
  const pls = [...lib.playlists.values()].sort((a, b) => ((plays[b.id]?.n || 0) - (plays[a.id]?.n || 0)) || ((plays[b.id]?.at || 0) - (plays[a.id]?.at || 0)) || ((b.createdAt || 0) - (a.createdAt || 0)));
  const albums = [...lib.albums.values()].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  const arts = store.artists().sort((a, b) => b.count - a.count).slice(0, 14);
  const gens = store.genres().slice(0, 10);
  const cur = player.current();
  const heroArt = cur?.artwork || liked.find(t => t.artwork)?.artwork || all.find(t => t.artwork)?.artwork || '';
  const collage = [...new Set([cur, ...liked, ...recent].filter(t => t?.artwork).map(t => t.artwork))].slice(0, 4);
  lists.set('recent', recent.map(t => t.id));
  if (cur) lists.set('cont', [cur.id]);
  view().innerHTML = `<div class="page home">
    <section class="home-hero">
      <div class="hh-bg" ${heroArt ? `style="background-image:url('${esc(sized(heroArt, 300))}')"` : ''}></div>
      <div class="hh-txt">
        <div class="kicker hh-when"><span data-date>${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span><span class="hh-time">${icon('clock')}<time data-clock>${clockText()}</time></span></div>
        <h1>${greet}${profile.username && profile.username !== 'Listener' ? ', ' + esc(profile.username) : ''}</h1>
        <p>${all.length} songs · ${lib.playlists.size} playlists · ${store.artists().length} artists</p>
        <div class="row-btns">
          ${bzBtn('primary')}
          ${liked.length ? `<button class="btn" data-act="play-list" data-id="home-liked">${icon('play')}Play Liked Songs</button>` : ''}
          <button class="btn" data-act="play-list" data-id="home-all" data-shuffle="1">${icon('shuffle')}Shuffle everything</button>
        </div>
      </div>
      ${collage.length >= 2 ? `<div class="hh-collage">${collage.map((src, i) => `<img src="${esc(sized(src, 300))}" alt="" style="--i:${i}" loading="lazy">`).join('')}</div>` : ''}
    </section>
    ${cur ? `<section class="jump" id="jump">${jumpInner(cur)}</section>` : ''}
    <section class="home-pls"><div class="sec-h"><h2>Your playlists</h2><a href="#/library/playlists" class="lnk">See all</a></div>
      <div class="pl-grid">
        <a class="card" href="#/library/liked"><div class="card-art">${likedCover()}<button class="fab-play" data-act="play-list" data-id="home-liked" aria-label="Play Liked Songs">${icon('play')}</button></div><div class="card-t">Liked Songs</div><div class="card-s">${liked.length} songs</div></a>
        ${pls.slice(0, 5).map(p => card({ href: `#/playlist/${p.id}`, img: plCover(p), title: p.name, sub: `${p.trackIds.length} songs`, act: 'play-playlist', id: p.id })).join('')}
        ${!pls.length ? `<button class="card card-new" data-act="new-playlist"><div class="card-art"><div class="cover noimg new-pl">${icon('plus')}</div></div><div class="card-t">New playlist</div><div class="card-s">Make your own mix</div></button>` : ''}
      </div></section>
    <section id="new-releases" class="shelf-sec"></section>
    <section class="home-recent"><div class="sec-h"><h2>Recently added</h2><a href="#/library/songs" class="lnk">See all</a></div>
      <div class="rows two">${recent.map((t, i) => trackRow(t, i, { list: 'recent' })).join('')}</div></section>
    <section class="shelf-sec"><div class="sec-h"><h2>Your artists</h2><a href="#/library/artists" class="lnk">See all</a></div>
      <div class="shelf">${arts.map(a => artistCard(a.name, a.artwork, `${a.count} song${a.count > 1 ? 's' : ''}`)).join('')}</div></section>
    ${gens.length ? `<section><div class="sec-h"><h2>Your genres</h2></div><div class="genre-tiles">${gens.map(([g, n]) => `<a class="gt" href="#/genre/${encodeURIComponent(g)}" style="--c:${genreColor(g)}"><b>${esc(g)}</b><small>${n} songs</small></a>`).join('')}</div></section>` : ''}
    ${albums.length ? `<section class="shelf-sec"><div class="sec-h"><h2>Your albums</h2><a href="#/library/albums" class="lnk">See all</a></div><div class="shelf">${albums.slice(0, 14).map(albumCard).join('')}</div></section>` : ''}
  </div>`;
  lists.set('home-liked', liked.sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0)).map(t => t.id));
  lists.set('home-all', all.map(t => t.id));
  fillArtistPics();
  startClock();
  newReleases(my);
}

// "Jump back in" — kept in sync with the player instantly (no page reload)
// The BAZINGA! button: one tap builds a fresh mix of new songs from your top artists and genres
const bzBtn = (cls = '') => `<button class="btn bz-btn ${cls}" data-act="bz-mix" aria-label="BAZINGA! Make me a fresh mix"><img src="${logoSrc()}" alt="" class="bz-bolt" width="22" height="22" decoding="sync" draggable="false">BAZINGA!</button>`;
const jumpBtn = (on = player.isOn()) => `${icon(on ? 'pause' : 'play')}<span>${on ? 'Pause' : 'Resume'}</span>`;
const jumpInner = t => `<div class="jump-art" data-jid="${esc(t.id)}">${cover(t.artwork, t.title)}</div><div class="jump-txt"><div class="kicker">Jump back in</div><h2>${esc(displayTitle(t))}</h2><p>${esc(t.artist)}</p>
  <div class="row-btns"><button class="btn primary" data-p-ext="toggle" id="jump-toggle" data-on="${player.isOn() ? 1 : 0}">${jumpBtn()}</button><button class="btn" data-p-ext="open">${icon('expand')}<span>Full screen</span></button></div></div>`;
function updateJump() {
  const box = $('#jump'); if (!box) return;
  const t = player.current(); if (!t) return;
  const art = box.querySelector('.jump-art');
  if (art?.dataset.jid !== t.id || (t.artwork && !art.querySelector('img'))) { box.innerHTML = jumpInner(t); return; }
  const b = $('#jump-toggle'), on = player.isOn() ? '1' : '0';
  if (b && b.dataset.on !== on) { b.dataset.on = on; b.innerHTML = jumpBtn(on === '1'); }
}

// "New from your artists": latest releases by the artists you listen to most.
// Cached for 12 hours; uses only a handful of lookups, paced by the rate limiter.
const releaseCard = a => {
  const days = a.releaseDate ? Math.round((Date.now() - Date.parse(a.releaseDate)) / 864e5) : 999;
  const when = days < 0 ? 'Coming soon' : days < 1 ? 'Today' : days < 7 ? `${days} day${days > 1 ? 's' : ''} ago` : days < 60 ? `${Math.round(days / 7)} weeks ago` : (a.year || '');
  return `<a class="card" href="#/album/it/${a.itunesAlbumId}"><div class="card-art">${cover(a.artwork, a.title)}${days <= 30 ? '<span class="new-badge">NEW</span>' : ''}<button class="fab-play" data-act="play-it-album" data-id="${a.itunesAlbumId}" aria-label="Play">${icon('play')}</button></div>
    <div class="card-t">${esc(a.title.replace(/ - (Single|EP)$/, ''))}</div><div class="card-s">${esc(a.artist)} · ${/ - Single$/.test(a.title) ? 'Single' : / - EP$/.test(a.title) ? 'EP' : 'Album'} · ${when}</div></a>`;
};
const NR_SHELF = 10, NR_PAGE = 25;
// "New from your top artists": newest albums, EPs and singles from the artists you have the most songs by.
// Home shows 10 in a sideways-scrolling row; "See more" opens the full list, 25 at a time.
// Your top 6 artists are looked up first (quick), the next 14 quietly in the background. Cached for 12 hours.
async function newReleases(my) {
  const box = $('#new-releases'); if (!box) return;
  const render = items => {
    if (stale(my) || !$('#new-releases')) return;
    if (!items.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="sec-h"><h2>New from your top artists</h2><a href="#/new" class="lnk">See more</a></div>
      <div class="shelf">${items.slice(0, NR_SHELF).map(releaseCard).join('')}</div>`;
  };
  const items = await loadNewReleases({ onUpdate: render, skeleton: () => { if (!stale(my)) box.innerHTML = `<div class="sec-h"><h2>New from your top artists</h2></div><div class="shelf">${'<div class="card skel"><div class="card-art"><div class="cover"></div></div><div class="card-t"></div><div class="card-s"></div></div>'.repeat(6)}</div>`; } });
  render(items);
}
async function loadNewReleases({ onUpdate = () => { }, skeleton = () => { } } = {}) {
  const top = store.artists().sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 20);
  const sig = 'v3|' + top.map(a => a.key).join('|');
  const c = await kv.get('newReleases');
  const fresh = c?.items?.length && c.sig === sig;
  if (fresh) onUpdate(c.items);
  if (c && c.sig === sig && Date.now() - c.ts < 12 * 36e5) return c.items || [];
  if (!navigator.onLine || !top.length) return fresh ? c.items : [];
  if (!fresh) skeleton();
  const have = new Set([...lib.albums.values()].map(a => a.itunesAlbumId));
  const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const byRank = new Map(), seen = new Set();
  // Newest releases of your #1 artist first, then #2, … (fresh ones from the last year preferred)
  const pickItems = () => {
    const out = [];
    for (let r = 0; r < top.length; r++) {
      const rel = (byRank.get(r) || []).filter(a => a.itunesAlbumId && !have.has(a.itunesAlbumId)).sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
      const recent = rel.filter(a => (a.releaseDate || '') >= yearAgo);
      out.push(...(recent.length ? recent.slice(0, 6) : rel.slice(0, 2)));
    }
    return out;
  };
  const take = async (a, rank, o) => {
    try {
      const id = a.itunesArtistId || await meta.findArtistId(a.name, o);
      if (!id) return;
      const rel = [];
      for (const al of await meta.artistLatest(id, o)) if (!seen.has(al.itunesAlbumId)) { seen.add(al.itunesAlbumId); rel.push(al); }
      byRank.set(rank, rel);
      if (!fresh && rank === 0) { const items = pickItems(); if (items.length) onUpdate(items); }
    } catch { }
  };
  await Promise.all(top.slice(0, 6).map((a, i) => take(a, i)));
  let items = pickItems();
  if (items.length) onUpdate(items);
  await Promise.all(top.slice(6).map((a, i) => take(a, i + 6, { bg: true })));
  items = pickItems();
  await kv.set('newReleases', { ts: Date.now(), sig, items });
  onUpdate(items);
  return items;
}
// Full list page (See more): 25 at a time, "Show more" until the end
async function vNewReleases(_, my) {
  let items = [], shown = NR_PAGE;
  const draw = () => {
    if (stale(my)) return;
    const left = items.length - shown;
    view().innerHTML = `<div class="page"><h1 class="page-h">New from your top artists</h1>
      <p class="muted">The latest albums, EPs and singles from the artists you listen to most.</p>
      ${items.length ? `<div class="cards">${items.slice(0, shown).map(releaseCard).join('')}</div>
        ${left > 0 ? `<div class="more-wrap"><button class="more-btn" id="nr-more">Show more <small>${left} more</small></button></div>` : ''}`
      : empty('Nothing new yet', 'New releases from your top artists show up here.')}</div>`;
    const b = $('#nr-more'); if (b) b.onclick = () => { const y = $('#main').scrollTop; shown += NR_PAGE; draw(); $('#main').scrollTop = y; };
  };
  // Shows what's ready straight away; more appears as the rest of your artists are looked up
  const update = v => { if (v.length === items.length && items.length) return; items = v; const y = $('#main').scrollTop; draw(); $('#main').scrollTop = y; };
  const got = await loadNewReleases({ onUpdate: update });
  update(got); if (!got.length && !items.length) draw();
}

// ================= BAZINGA! MIX =================
// One tap: a fresh playlist of songs you don't have yet from your top 50 artists (your #1 artist first,
// taking turns), then today's top songs in your favourite genres. Built for a fast start: the first few
// artists are fetched together and the music starts as soon as there's something to play; the rest of
// the mix keeps filling in behind it (queue + playlist).
const MIX_GENRES = ['Hip-Hop/Rap', 'Pop', 'R&B', 'Afrobeats', 'Rock', 'Electronic', 'Latin', 'Country', 'Soul', 'Reggae', 'Jazz', 'Gospel', 'K-Pop', 'Classical', 'Metal', 'Folk', 'Blues'];
const mixPlaylist = async () => { const id = await kv.get('mixPl'); return id && lib.playlists.get(id); };
// Songs that are only in the library because an earlier mix put them there
const isMixOnly = (t, mixId) => t.mix && !t.liked && ![...lib.playlists.values()].some(p => p.id !== mixId && p.trackIds.includes(t.id));
function libraryTaste(mixId) {
  const own = store.saved().filter(t => !isMixOnly(t, mixId));
  const am = new Map(), gm = new Map();
  for (const t of own) {
    const a = mainArtist(t.artist), k = norm(a);
    if (k) { const e = am.get(k) || { name: a, n: 0 }; e.n += t.liked ? 2 : 1; am.set(k, e); }
    const g = genreOf(t); if (g) gm.set(g, (gm.get(g) || 0) + 1);
  }
  return {
    artists: [...am.values()].sort((a, b) => b.n - a.n).map(a => a.name),
    genres: [...gm.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]),
    have: new Set(own.map(t => t.id)), haveTitles: new Set(own.map(t => norm(t.title) + '|' + norm(mainArtist(t.artist))))
  };
}
function mixOverlay() {
  $('#mix-ov')?.remove();
  const el = document.createElement('div');
  el.id = 'mix-ov'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
  el.innerHTML = `<div class="mo-bg" aria-hidden="true"><i></i><i></i><i></i></div><div class="mo-arts" aria-hidden="true"></div>
    <div class="mo-core"><div class="mo-orb"><span></span><span></span><span></span><img src="${logoSrc('icon-512')}" alt=""></div>
    <h2 class="wordmark">BAZINGA!</h2><p class="mo-step">Reading your vibe…</p><div class="mo-bar"><i></i></div></div>
    <button class="ib mo-x" type="button" aria-label="Cancel">${icon('close')}</button>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('on'));
  let arts = 0;
  const api = {
    cancelled: false,
    step(t, pct) { const s = el.querySelector('.mo-step'); if (s && s.textContent !== t) { s.textContent = t; s.classList.remove('in'); void s.offsetWidth; s.classList.add('in'); } if (pct != null) el.querySelector('.mo-bar i').style.width = Math.min(100, pct) + '%'; },
    art(src) {
      if (!src || arts >= 8) return;
      const i = arts++, img = new Image(); img.alt = ''; img.src = sized(src, 300); img.style.setProperty('--i', i);
      // covers float around the edges, never over the bolt in the middle
      const spots = [[6, 10], [74, 8], [10, 66], [76, 64], [40, 4], [42, 78], [2, 38], [82, 36]];
      img.style.left = spots[i][0] + '%'; img.style.top = spots[i][1] + '%';
      img.onload = () => el.querySelector('.mo-arts')?.appendChild(img);
    },
    close() { el.classList.remove('on'); el.classList.add('out'); setTimeout(() => el.remove(), 450); }
  };
  el.querySelector('.mo-x').onclick = () => { api.cancelled = true; api.close(); };
  return api;
}
// First time, with no music yet: pick favourite genres, then favourite artists in them
async function tastePicker() {
  let genres = [], artists = [];
  return modal(`<div class="taste"><div class="taste-step" data-s="1">
      <div class="taste-ic"><img src="${logoSrc()}" alt=""></div>
      <h3>What do you love listening to?</h3><p class="muted">Pick as many genres as you like. Your BAZINGA! mix starts here.</p>
      <div class="chips taste-genres">${MIX_GENRES.map(g => `<button type="button" class="chip" data-g="${esc(g)}" aria-pressed="false" style="--c:${genreColor(g)}">${esc(g)}</button>`).join('')}</div>
      <div class="modal-actions center"><button type="button" class="btn primary" data-next disabled>Next ${icon('play')}</button></div></div>
    <div class="taste-step" data-s="2" hidden>
      <h3>Now your favorite artists</h3><p class="muted">Top artists in the genres you picked. Choose any you like, or skip.</p>
      <div class="taste-artists"></div>
      <div class="modal-actions center"><button type="button" class="btn ghost" data-back>Back</button><button type="button" class="btn primary" data-go>${icon('sparkle')}Make my mix</button></div></div></div>`, {
    wide: true,
    onMount: (m, close) => {
      m.classList.add('taste-modal');
      const s1 = m.querySelector('[data-s="1"]'), s2 = m.querySelector('[data-s="2"]'), next = m.querySelector('[data-next]');
      m.querySelector('.taste-genres').onclick = e => {
        const b = e.target.closest('[data-g]'); if (!b) return;
        const g = b.dataset.g, on = !genres.includes(g);
        genres = on ? [...genres, g] : genres.filter(x => x !== g);
        b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); next.disabled = !genres.length;
      };
      next.onclick = async () => {
        s1.hidden = true; s2.hidden = false;
        const box = m.querySelector('.taste-artists');
        box.innerHTML = genres.map(g => `<div class="ta-group"><div class="fp-h">${esc(g)}</div><div class="ta-row" data-genre="${esc(g)}">${loader('', 'sm inline')}</div></div>`).join('');
        await Promise.all(genres.map(async g => {
          const list = await meta.deezerGenreArtists(g, 10).catch(() => []);
          const row = box.querySelector(`[data-genre="${CSS.escape(g)}"]`); if (!row) return;
          row.innerHTML = list.length ? list.map(a => `<button type="button" class="ta ${artists.includes(a.name) ? 'on' : ''}" data-a="${esc(a.name)}" aria-pressed="${artists.includes(a.name)}">${cover(a.picture, a.name, 'round')}<span>${esc(a.name)}</span><i>${icon('check')}</i></button>`).join('')
            : '<span class="muted tiny">Couldn\'t load artists for this one, but its top songs still go in your mix.</span>';
        }));
      };
      m.querySelector('.taste-artists').onclick = e => {
        const b = e.target.closest('[data-a]'); if (!b) return;
        const a = b.dataset.a, on = !artists.includes(a);
        artists = on ? [...artists, a] : artists.filter(x => x !== a);
        $$(`.ta[data-a="${CSS.escape(a)}"]`, m).forEach(x => { x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
      };
      m.querySelector('[data-back]').onclick = () => { s2.hidden = true; s1.hidden = false; };
      m.querySelector('[data-go]').onclick = () => close({ genres, artists });
    }
  });
}
let mixBusy = false;
async function bazingaMix() {
  if (mixBusy) return;
  if (!navigator.onLine) return toast('Your BAZINGA! mix needs an internet connection', 'err');
  const oldPl = await mixPlaylist();
  const lt = libraryTaste(oldPl?.id);
  const saved = (await kv.get('taste')) || {};
  if (lt.artists.length < 3 && !saved.artists?.length && !saved.genres?.length) {
    const picked = await tastePicker();
    if (!picked?.genres?.length) return;
    Object.assign(saved, picked, { at: Date.now() }); await kv.set('taste', saved);
  }
  mixBusy = true;
  const ov = mixOverlay();
  try {
    const uniq = a => [...new Map(a.filter(Boolean).map(x => [norm(x), x])).values()];
    const libFirst = lt.artists.length >= 3;
    const artists = uniq(libFirst ? [...lt.artists.slice(0, 50), ...(saved.artists || [])] : [...(saved.artists || []), ...lt.artists]).slice(0, 50);
    const genres = uniq([...(saved.genres || []), ...lt.genres]).filter(g => MIX_GENRES.includes(g)).slice(0, 5);
    const per = artists.length > 30 ? 2 : artists.length > 12 ? 3 : 5;
    const seen = new Set(), seenTitle = new Set();
    const fresh = s => {
      const k = norm(s.title) + '|' + norm(mainArtist(s.artist));
      if (!s.title || !s.artist || lt.have.has(s.id) || lt.haveTitles.has(k) || seen.has(s.id) || seenTitle.has(k)) return false;
      if (/\b(karaoke|instrumental|8d audio|sped up|slowed)\b/i.test(s.title)) return false;
      seen.add(s.id); seenTitle.add(k); return true;
    };
    // a little shuffle inside each artist's top songs, so every mix feels new
    const jiggle = list => list.map((x, i) => [x, i + Math.random() * 4]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
    const picks = new Array(artists.length).fill(null);
    const fetchArtist = async i => {
      if (ov.cancelled) return;
      const top = await meta.withTimeout(meta.deezerArtistTop(artists[i], 12).catch(() => []), 6000, []);
      picks[i] = jiggle(top).filter(fresh).slice(0, per);
      if (picks[i][0]?.artwork) ov.art(picks[i][0].artwork);
    };
    const roundRobin = () => { const out = [], max = Math.max(0, ...picks.map(p => p?.length || 0)); for (let r = 0; r < max; r++) for (const p of picks) if (p?.[r]) out.push(p[r]); return out; };
    const save = list => store.upsertTracks(list.map(t => ({ ...t, mix: 1 })));

    // 1) Fast start: your top few artists at once
    ov.step(artists.length ? `Digging into ${artists[0]}…` : 'Finding the hottest songs in your genres…', 12);
    const first = Math.min(6, artists.length);
    await Promise.all([...Array(first).keys()].map(fetchArtist));
    if (ov.cancelled) return;
    let startList = roundRobin();
    let genreSongs = null;
    const fetchGenres = async () => {
      const lists = await Promise.all(genres.map(g => meta.withTimeout(meta.deezerGenreTop(g, 30).catch(() => []), 7000, [])));
      const out = [], n = Math.max(0, ...lists.map(l => l.length));
      for (let r = 0; r < n && out.length < 45; r++) for (const l of lists) if (l[r] && fresh(l[r])) out.push(l[r]);
      return out;
    };
    if (startList.length < 3) {
      ov.step('Mixing in the top songs from your genres…', 40);
      genreSongs = await fetchGenres();
      if (ov.cancelled) return;
      startList = [...startList, ...genreSongs.splice(0, 8)];
    }
    if (!startList.length) { ov.close(); return toast('Couldn\'t build a mix right now. Try again in a moment', 'err'); }
    ov.step('Your mix is ready. Here we go ⚡', 70);
    const firstSaved = await save(startList);
    const startIds = firstSaved.map(t => t.id);
    player.prefetch(startIds[0]);
    let pl = await mixPlaylist();
    const name = 'BAZINGA! Mix';
    const meta2 = { source: 'Made for you ⚡', image: startList.find(t => t.artwork)?.artwork || '', mix: 1 };
    if (pl) { Object.assign(pl, { name, ...meta2 }); await store.replacePlaylistTracks(pl.id, startIds); }
    else { pl = await store.createPlaylist(name, startIds, meta2); await kv.set('mixPl', pl.id); }
    renderSidebarPlaylists();
    nowCtx = { list: null };
    player.playList(startIds, 0, { shuffle: false, origin: 'mix' });
    // Keep the overlay up until the music actually starts (or a few seconds pass)
    const t0 = Date.now();
    const waitStart = setInterval(() => { if (ov.cancelled || P.playing || P.needsTap || P.error || Date.now() - t0 > 9000) { clearInterval(waitStart); ov.step('Enjoy ⚡', 100); setTimeout(() => ov.close(), 250); } }, 200);

    // 2) The rest of your top artists, then your genres, filled in behind the music
    const rest = [...Array(artists.length).keys()].slice(first);
    const queue = rest.slice();
    await Promise.all([...Array(Math.min(5, queue.length)).keys()].map(async () => { while (queue.length) await fetchArtist(queue.shift()); }));
    if (!genreSongs) genreSongs = await fetchGenres();
    const already = new Set(startIds);
    const more = [...roundRobin().filter(t => !already.has(t.id)).slice(0, 110), ...genreSongs].slice(0, 150);
    if (!more.length) return;
    const moreSaved = await save(more);
    const all = [...startIds, ...moreSaved.map(t => t.id)];
    await store.replacePlaylistTracks(pl.id, all);
    // still playing the mix? add the rest to the queue
    if (P.queue.some(q => q.id === startIds[0])) player.appendToQueue(moreSaved.map(t => t.id));
    toast(`Your BAZINGA! Mix is ready: ${all.length} songs ⚡`, 'ok');
  } catch (e) { console.warn(e); ov.close(); toast('Couldn\'t build a mix right now. Try again in a moment', 'err'); }
  finally { mixBusy = false; }
}

// Artist card with a real artist photo (loaded lazily from Deezer, cached on the device)
// Artist photo block: shows the remembered photo straight away; otherwise the library cover until
// the photo is found (then it's swapped in only once fully loaded, so nothing flashes).
function apic(name, fallback, cls, wrapCls = '') {
  const pic = meta.artistPictureNow(name);
  if (pic) return `<div class="${wrapCls}">${cover(pic, name, cls)}</div>`;
  return `<div class="${wrapCls}" data-apic="${esc(name)}" data-cls="${esc(cls)}">${cover(fallback, name, cls)}</div>`;
}
function swapPic(el, pic) {
  if (!pic || !el.isConnected) return;
  const img = new Image(); img.decoding = 'async';
  const px = /hero/.test(el.dataset.cls || '') ? 600 : /\bsm\b/.test(el.dataset.cls || '') ? 64 : 200;
  img.src = sized(pic, px);
  const put = () => { if (el.isConnected) { el.innerHTML = cover(pic, el.dataset.apic, el.dataset.cls || 'round'); el.removeAttribute('data-apic'); } };
  (img.decode ? img.decode() : Promise.resolve()).then(put, put);
}
function artistCard(name, fallback, sub) {
  return `<a class="card" href="#/artist/${encodeURIComponent(name)}">${apic(name, fallback, 'round', 'card-art round')}
    <div class="card-t">${esc(name)}</div><div class="card-s">${esc(sub || '')}</div></a>`;
}
const apicObs = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const el = e.target; apicObs.unobserve(el);
    meta.artistPicture(el.dataset.apic).then(pic => swapPic(el, pic));
  }
}, { rootMargin: '600px' }) : null;
function fillArtistPics(root = document) { if (apicObs) root.querySelectorAll('[data-apic]').forEach(el => apicObs.observe(el)); }

function genreColor(g) { let h = 7; for (const c of g) h = (h * 33 + c.charCodeAt(0)) % 360; return `hsl(${h} 70% 42%)`; }
const plCover = p => p.image || (p.trackIds.map(id => lib.tracks.get(id)?.artwork).find(Boolean) || '');
const albumCard = a => card({ href: albumHref(a), img: a.artwork, title: a.title, sub: [a.year, a.artist].filter(Boolean).join(' · '), act: 'play-album', id: a.id });
const albumHref = a => lib.albums.has(a.id) || !a.itunesAlbumId ? `#/album/${encodeURIComponent(a.id)}` : `#/album/it/${a.itunesAlbumId}`;

// ---------- GENRE ----------
async function vGenre([g]) {
  const tracks = store.saved().filter(t => genreOf(t) === g);
  view().innerHTML = `<div class="page">${header(esc(g), `${tracks.length} songs in your library`, '', playBtns('play-list', 'genre'), 'Genre')}
    ${tracksSection('genre', tracks)}</div>`;
  observeMore();
}

// ---------- LIBRARY ----------
async function vLibrary([tab = 'songs']) {
  const all = store.saved();
  const tabs = [['songs', 'Songs', all.length], ['liked', 'Liked', all.filter(t => t.liked).length], ['playlists', 'Playlists', lib.playlists.size], ['albums', 'Albums', lib.albums.size + store.implicitAlbums().length], ['artists', 'Artists', store.artists().length]];
  let body = '';
  if (tab === 'songs' || tab === 'liked') {
    const tracks = tab === 'liked' ? all.filter(t => t.liked) : all;
    body = tracks.length ? `<div class="actions">${playBtns('play-list', tab)}${matchBtn(tab, tab === 'liked' ? 'Liked Songs (BAZINGA!)' : 'My BAZINGA! songs', 'lib:' + tab)}</div>${tracksSection(tab, tracks, tab === 'liked' ? { defaultSort: 'liked', likedSort: true } : {})}`
      : empty(tab === 'liked' ? 'No liked songs yet' : 'No songs yet', 'Tap the heart on any song, or import your Spotify Liked Songs.', `<a class="btn primary" href="#/import">${icon('import')}Import</a>`);
  } else if (tab === 'playlists') {
    const pls = [...lib.playlists.values()].sort((a, b) => a.name.localeCompare(b.name));
    body = `<div class="actions"><button class="btn" data-act="new-playlist">${icon('plus')}New playlist</button>${pls.length ? `<button class="btn yt-save" data-act="yt-backup">${icon('upload')}Save playlists to YouTube</button>` : ''}</div>
      <div class="cards"><a class="card" href="#/library/liked"><div class="card-art">${likedCover()}<button class="fab-play" data-act="play-list" data-id="liked-all" aria-label="Play">${icon('play')}</button></div><div class="card-t">Liked Songs</div><div class="card-s">${all.filter(t => t.liked).length} songs</div></a>
      ${pls.map(p => card({ href: `#/playlist/${p.id}`, img: plCover(p), title: p.name, sub: `${p.trackIds.length} songs${p.source ? ' · ' + p.source : ''}`, act: 'play-playlist', id: p.id })).join('')}</div>`;
  } else if (tab === 'albums') {
    const saved = [...lib.albums.values()].sort((a, b) => a.title.localeCompare(b.title));
    const imp = store.implicitAlbums().sort((a, b) => b.trackIds.length - a.trackIds.length || a.title.localeCompare(b.title));
    body = `<div class="actions"><a class="btn" href="#/search/albums">${icon('search')}Find albums</a></div>
      ${saved.length ? `<h2>Saved albums</h2>${pagedGrid('alb-saved', saved.map(albumCard))}` : empty('No saved albums yet', 'Search any album, or open one from a song (⋯ → Go to album) and tap "Save album".')}
      ${imp.length ? `<h2>From your songs</h2><p class="muted tiny">Albums you have songs from. Open one to see and save the full album.</p>${pagedGrid('alb-imp', imp.map(a => card({ href: albumHref(a), img: a.artwork, title: a.title, sub: `${a.artist} · ${a.trackIds.length} in library`, act: 'play-album', id: a.id })))}` : ''}`;
  } else if (tab === 'artists') {
    const arts = store.artists();
    artistUI.limit = PAGE_N;
    body = arts.length ? `<div class="art-tools">
        <label class="searchbox sm art-search">${icon('search')}<input id="art-q" placeholder="Search your artists" value="${esc(artistUI.q)}" autocomplete="off" enterkeyhint="search"></label>
        <div class="seg art-sort" role="group" aria-label="Sort artists"><button data-act="art-sort" data-v="count" class="${artistUI.sort === 'count' ? 'on' : ''}">Most songs</button><button data-act="art-sort" data-v="az" class="${artistUI.sort === 'az' ? 'on' : ''}">A–Z</button></div>
      </div>
      <div class="az">${[...new Set(arts.map(a => letterOf(a.name)))].sort((a, b) => a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)).map(l => `<a href="#" data-act="az" data-l="${l}">${l}</a>`).join('')}</div>
      <div class="artist-list" id="artist-list">${artistRows(arts)}</div>`
      : empty('No artists yet', 'Artists from all your songs, playlists and albums show up here.');
  }
  lists.set('liked-all', all.filter(t => t.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0)).map(t => t.id));
  view().innerHTML = `<div class="page"><h1 class="page-h">Your Library</h1>
    <div class="tabs">${tabs.map(([k, l, n]) => `<a href="#/library/${k}" class="tab ${tab === k ? 'on' : ''}" data-tab="${k}">${l}<small>${n}</small></a>`).join('')}</div>${body}</div>`;
  observeMore();
  fillArtistPics();
  const aq = $('#art-q');
  if (aq) aq.addEventListener('input', debounce(() => { artistUI.q = aq.value; artistUI.limit = PAGE_N; redrawArtists(); }, 120));
}
// ---------- Long lists load 100 at a time, with a quiet "Show more" at the bottom ----------
const PAGE_N = 100;
const pagers = new Map();
function pagedGrid(key, items, cls = 'cards') {
  pagers.set(key, { items, at: PAGE_N });
  return `<div class="${cls}" data-pg="${key}">${items.slice(0, PAGE_N).join('')}</div>${moreBtn(key, items.length - PAGE_N)}`;
}
const moreBtn = (key, left) => left > 0 ? `<div class="more-wrap"><button class="more-btn" data-act="show-more" data-pg="${key}">Show more <small>${left} more</small></button></div>` : '';
function showMore(key) {
  const pg = pagers.get(key), grid = $(`[data-pg="${key}"]:not(button)`); if (!pg || !grid) return;
  grid.insertAdjacentHTML('beforeend', pg.items.slice(pg.at, pg.at + PAGE_N).join(''));
  pg.at += PAGE_N;
  const wrap = grid.nextElementSibling;
  if (wrap?.classList.contains('more-wrap')) wrap.outerHTML = moreBtn(key, pg.items.length - pg.at);
  fillArtistPics(grid);
}
// ---------- Artists list: most songs first (or A–Z), with search ----------
const artistUI = { sort: 'count', q: '', limit: PAGE_N };
const letterOf = n => (n[0] || '#').toUpperCase().replace(/[^A-Z]/, '#');
function artistRows(arts) {
  const q = norm(artistUI.q);
  let list = q ? arts.filter(a => norm(a.name).includes(q)) : arts;
  list = artistUI.sort === 'az' ? [...list].sort((a, b) => a.name.localeCompare(b.name)) : [...list].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  if (!list.length) return `<p class="muted pad">No artists match "${esc(artistUI.q)}".</p>`;
  const seen = new Set();
  const left = list.length - artistUI.limit;
  return list.slice(0, artistUI.limit).map(a => {
    const L = letterOf(a.name), first = artistUI.sort === 'az' && !seen.has(L); seen.add(L);
    return `<a class="artist-row" href="#/artist/${encodeURIComponent(a.name)}" ${first || artistUI.sort !== 'az' ? `data-letter="${L}"` : ''}>
      ${apic(a.name, a.artwork, 'round sm')}<div><b>${esc(a.name)}</b><small>${a.count} song${a.count > 1 ? 's' : ''}${a.genres.size ? ' · ' + esc([...a.genres].slice(0, 2).join(', ')) : ''}</small></div>
      <button class="ib art-play" data-act="play-artist" data-name="${esc(a.name)}" aria-label="Play ${esc(a.name)}">${icon('play')}</button></a>`;
  }).join('') + (left > 0 ? `<div class="more-wrap span-all"><button class="more-btn" data-act="art-more">Show more <small>${left} more</small></button></div>` : '');
}
function redrawArtists() {
  const el = $('#artist-list'); if (!el) return;
  el.innerHTML = artistRows(store.artists());
  $$('.art-sort button').forEach(b => b.classList.toggle('on', b.dataset.v === artistUI.sort));
  fillArtistPics(el);
}
// On phones these two fold into a ⋯ menu so the action row stays on one line
const matchBtn = (key, name = 'My BAZINGA! playlist', job = key, offline = '') => `<span class="yt-acts"><button class="btn ghost" data-act="match-list" data-list="${key}" title="Find YouTube versions for every song">${icon('yt')}Find YouTube matches</button>
  <button class="btn yt-save" data-act="yt-export" data-list="${key}" data-name="${esc(name)}" data-job="${esc(job)}">${icon('upload')}Save to YouTube</button></span>
  <button class="ib lg yt-more ${offline ? 'always' : ''}" data-act="yt-more" data-list="${key}" data-name="${esc(name)}" data-job="${esc(job)}" ${offline ? `data-offline="${esc(offline)}"` : ''} aria-label="More options" title="More">${icon('more')}</button>`;

// ---------- PLAYLIST ----------
async function vPlaylist([id]) {
  const p = lib.playlists.get(id);
  if (!p) { view().innerHTML = empty('Playlist not found', 'It may have been deleted.'); return; }
  const tracks = p.trackIds.map(i => lib.tracks.get(i)).filter(Boolean);
  setTitle(p.name);
  const dur = tracks.reduce((s, t) => s + (t.durationMs || 0), 0);
  fstate['pl'] = fstate['pl'] && fstate['pl']._id === id ? fstate['pl'] : { sort: '', open: false, _id: id };
  view().innerHTML = `<div class="page">
    ${header(esc(p.name), `${esc(profile.username)} · ${tracks.length} songs${dur ? ' · ' + fmtTime(dur / 1000) : ''}${p.source ? ' · from ' + esc(p.source) : ''}`, cover(plCover(p), p.name), '', 'Playlist')}
    <div class="actions">${playBtns('play-list', 'pl')}
      <button class="ib lg" data-act="share-playlist" data-id="${p.id}" title="Share">${icon('share')}</button>
      <button class="ib lg" data-act="playlist-menu" data-id="${p.id}" title="More">${icon('more')}</button>
      ${matchBtn('pl', p.name, p.id)}</div>
    ${tracks.length ? tracksSection('pl', tracks, { playlistId: p.id, keepOrder: true, defaultSort: '' }) : empty('This playlist is empty', 'Use ⋯ → "Add to playlist" on any song.')}
  </div>`;
  observeMore();
}

// ---------- ALBUM ----------
async function vAlbum(arg, my) {
  let album, tracks, savedA = null, remote = null;
  if (arg[0] === 'it') {
    const res = await meta.albumTracks(arg[1]);
    if (stale(my)) return;
    if (!res.album) { view().innerHTML = empty('Album not found', ''); return; }
    album = res.album; tracks = res.tracks;
    savedA = lib.albums.get(album.id);
  } else {
    const id = arg[0];
    savedA = lib.albums.get(id);
    album = savedA || store.implicitAlbums().find(a => a.id === id);
    if (!album) { view().innerHTML = empty('Album not found', ''); return; }
    tracks = (album.trackIds || []).map(i => lib.tracks.get(i)).filter(Boolean);
    if (!savedA && album.itunesAlbumId) { location.replace(`#/album/it/${album.itunesAlbumId}`); return; }
    if (!savedA && navigator.onLine) {
      // try to find the full album
      try { remote = await meta.findAlbum(album.artist, album.title); } catch { }
      if (stale(my)) return;
      if (remote) { location.replace(`#/album/it/${remote.itunesAlbumId}`); return; }
    }
  }
  // Use library versions of tracks where they exist (keeps likes, offline files, YouTube links)
  tracks = tracks.map(t => lib.tracks.get(t.id) || store.remember(t));
  const dur = tracks.reduce((s, t) => s + (t.durationMs || 0), 0);
  const offlineN = tracks.filter(t => t.localFileId).length;
  window.__album = { album, tracks };
  setTitle(album.title);
  const artistLink = `<a class="lnk" href="#/artist/${encodeURIComponent(mainArtist(album.artist))}">${esc(album.artist)}</a>`;
  view().innerHTML = `<div class="page">
    ${header(esc(album.title), `${artistLink} · ${album.year || ''} · ${tracks.length} songs${dur ? ' · ' + fmtTime(dur / 1000) : ''}${album.genre ? ' · ' + esc(album.genre) : ''}`, cover(album.artwork, album.title), '', 'Album')}
    <div class="actions">${playBtns('play-list', 'album')}
      ${savedA ? `<button class="btn save-alb" data-act="unsave-album" data-id="${esc(album.id)}">${icon('check')}<span>Saved</span></button>` : `<button class="btn primary-o save-alb" data-act="save-album">${icon('plus')}<span>Save<span class="hide-sm"> album</span></span></button>`}
      <button class="ib lg" data-act="share-album" title="Share">${icon('share')}</button>
      ${matchBtn('album', `${album.title} — ${album.artist}`, 'album:' + album.id, `Offline files${offlineN ? ` (${offlineN}/${tracks.length})` : ''}`)}</div>
    ${tracksSection('album', tracks, { noFilter: true, numbered: true })}
    ${album.releaseDate ? `<p class="muted tiny pad">Released ${new Date(album.releaseDate).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</p>` : ''}
  </div>`;
}

// ---------- ARTIST ----------
async function vArtist([name], my) {
  setTitle(name);
  const n = norm(name);
  const mine = store.saved().filter(t => (t.artists?.length ? t.artists : [mainArtist(t.artist)]).some(a => norm(a) === n) || norm(mainArtist(t.artist)) === n);
  const a = store.artists().find(x => x.key === n);
  view().innerHTML = `<div class="page">${header(esc(name), mine.length ? `${mine.length} song${mine.length === 1 ? '' : 's'} in your library` : 'Not in your library yet', apic(name, a?.artwork || mine[0]?.artwork, 'hero round'), '', 'artist')}
    <div class="actions">${mine.length ? playBtns('play-list', 'artist-mine') : ''}</div>
    ${mine.length ? `<h2>In your library</h2>${tracksSection('artist-mine', mine, { defaultSort: 'newest' })}`
      : `<div class="panel artist-empty">${icon('heart')}<div><b>No songs by ${esc(name)} in your library yet</b><p class="muted tiny">Tap the ♡ on any song below to add it, or <a class="lnk" href="#/search" data-artist-search="${esc(name)}">search for more</a>.</p></div></div>`}
    <div id="artist-top">${loader(mine.length ? 'Loading popular songs…' : `Finding the top songs by ${name}…`, 'sm')}</div>
    <div id="artist-topalb"></div>
    <div id="artist-albums"></div></div>`;
  // The big photo is fetched right now (ahead of anything else), not when it scrolls into view
  const heroPic = view().querySelector('.page [data-apic][data-cls="hero round"]');
  if (heroPic) meta.artistPicture(name, true).then(pic => swapPic(heroPic, pic));
  observeMore(); fillArtistPics();
  const $top = () => $('#artist-top'), $alb = () => $('#artist-albums');
  let id = a?.itunesArtistId || mine.find(t => t.itunesArtistId && norm(mainArtist(t.artist)) === n)?.itunesArtistId;
  const idP = id ? Promise.resolve(id) : meta.findArtistId(name).catch(() => null);
  // Top 10: Apple first, Deezer if Apple is slow; never more than ~10 s of loading
  const later = (ms, fn) => sleep(ms).then(fn).catch(() => []);
  const topP = meta.withTimeout(meta.firstFull([idP.then(i => i ? meta.artistTopSongs(i) : []).catch(() => []), later(2000, () => meta.deezerArtistTop(name, 10))]), 10000, []);
  topP.then(top => {
    if (stale(my) || !$top()) return;
    const topT = top.slice(0, 10).map(t => lib.tracks.get(t.id) || store.remember(t));
    lists.set('artist-top', topT.map(t => t.id));
    const cur = player.current()?.id;
    $top().innerHTML = topT.length
      ? `<div class="sec-h"><h2>${mine.length ? 'Popular songs' : `Top 10 songs by ${esc(name)}`}</h2><button class="btn sm ghost" data-act="play-list" data-id="artist-top">${icon('play')}Play all</button></div><div class="rows">${topT.map((t, i) => trackRow(t, i, { list: 'artist-top', numbered: true }, cur)).join('')}</div>`
      : `<div class="pad"><p class="muted">${navigator.onLine ? 'Couldn\'t load songs by this artist right now.' : 'You\'re offline — songs by this artist will show when you\'re back online.'}</p>${navigator.onLine ? `<button class="btn" data-act="retry-route">${icon('restore')}Try again</button>` : ''}</div>`;
    markNow();
  });
  // Albums (Apple only), loaded alongside
  idP.then(async i => {
    if (!i) return;
    const albums = await meta.withTimeout(meta.artistAlbums(i).catch(() => []), 12000, []);
    if (stale(my) || !$alb() || !albums.length) return;
    // Top 10 albums (card grid under the top songs): albums holding the artist's most popular songs
    // come first, then full albums in Apple's popularity order. Singles are left to the discography.
    const top = await Promise.race([topP, sleep(6000).then(() => [])]);
    if (stale(my) || !$('#artist-topalb')) return;
    const base = x => norm(String(x || '').replace(/\s*[\(\[].*?[\)\]]/g, '').replace(/\s*-\s*(single|ep)$/i, ''));
    const hit = new Map();
    top.slice(0, 10).forEach((t, r) => { for (const k of [t.itunesAlbumId && 'id:' + t.itunesAlbumId, t.album && 't:' + base(t.album)]) if (k && !hit.has(k)) hit.set(k, r); });
    const songRank = a => Math.min(hit.get('id:' + a.itunesAlbumId) ?? 99, hit.get('t:' + base(a.title)) ?? 99);
    const full = albums.filter(a => (a.trackCount || 0) >= 5 || songRank(a) < 99);
    const topAlb = [...full].sort((a, b) => (songRank(a) - songRank(b)) || ((a.rank ?? 0) - (b.rank ?? 0))).slice(0, 10);
    if (topAlb.length >= 2) $('#artist-topalb').innerHTML = `<div class="sec-h"><h2>Top 10 albums</h2></div><div class="cards top-albums">${topAlb.map(al => card({ href: `#/album/it/${al.itunesAlbumId}`, img: al.artwork, title: al.title, sub: [al.year, `${al.trackCount} songs`].filter(Boolean).join(' · ') })).join('')}</div>`;
    $alb().innerHTML = `<h2>Discography</h2>${pagedGrid('artist-alb', albums.map(al => card({ href: `#/album/it/${al.itunesAlbumId}`, img: al.artwork, title: al.title, sub: `${al.year || ''} · ${al.trackCount} songs` })))}`;
  });
  await Promise.race([topP, sleep(50)]);
}

// ---------- SEARCH ----------
let lastSearch = { q: '', tab: 'all' };
const SEARCH_TABS = [['all', 'All'], ['songs', 'Songs'], ['albums', 'Albums'], ['artists', 'Artists'], ['youtube', 'YouTube']];
async function vSearch([tab = lastSearch.tab]) {
  lastSearch.tab = tab;
  view().innerHTML = `<div class="page"><h1 class="page-h">Search</h1>
    <div class="search-row"><label class="searchbox big">${icon('search')}<input id="sq" placeholder="${tab === 'youtube' ? 'Search YouTube…' : 'Songs, albums, artists, YouTube…'}" value="${esc(lastSearch.q)}" autocomplete="off" enterkeyhint="search">
      <button type="button" class="ib sb-clear" aria-label="Clear" ${lastSearch.q ? '' : 'hidden'}>${icon('close')}</button></label>
      <button class="search-go" data-act="search-go" aria-label="Search" title="Search">${icon('search')}</button>
      <button class="mic-btn ghosty" data-act="voice" aria-label="Search by voice" title="Ask BAZINGA!">${icon('mic')}</button></div>
    <div class="tabs">${SEARCH_TABS.map(([k, l]) => `<a href="#/search/${k}" class="tab ${tab === k ? 'on' : ''}">${k === 'youtube' ? icon('yt') : ''}${l}</a>`).join('')}</div>
    <div id="sres"></div></div>`;
  const inp = $('#sq'), clr = $('.sb-clear');
  const run = debounce(() => doSearch(inp.value.trim(), tab), 400);
  inp.addEventListener('input', () => { clr.hidden = !inp.value; run(); });
  const go = () => { run.cancel(); doSearch(inp.value.trim(), tab); inp.blur(); };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  $('.search-go').onclick = e => { e.preventDefault(); if (!inp.value.trim()) { inp.focus(); return; } go(); };
  clr.onclick = () => { inp.value = ''; clr.hidden = true; doSearch('', tab); inp.focus(); };
  if (innerWidth > 700) inp.focus();
  if (lastSearch.q) doSearch(lastSearch.q, tab);
  else $('#sres').innerHTML = searchHints(tab);
}
function searchHints(tab) {
  const g = store.genres().slice(0, 12);
  return `<p class="muted">${tab === 'youtube' ? 'Search all of YouTube — tap a result to play it, or use ⋯ to queue it, like it or add it to a playlist.' : 'Search the whole music catalogue and YouTube for songs, full albums and artists — play them as videos or audio and save albums to your library.'}</p>
  ${g.length && tab !== 'youtube' ? `<h2>Browse your genres</h2><div class="genre-tiles">${g.map(([x, n]) => `<a class="gt" href="#/genre/${encodeURIComponent(x)}" style="--c:${genreColor(x)}"><b>${esc(x)}</b><small>${n} songs</small></a>`).join('')}</div>` : ''}`;
}
// Turn YouTube results into playable rows (each plays that exact video)
async function ytResultsToTracks(results) {
  const out = [];
  for (const r of results.filter(r => r.id && (!r.seconds || r.seconds < 1800)).slice(0, 20)) {
    const { artist, title } = yt.videoToSong(r);
    const id = 'yt_' + r.id;
    const t = lib.tracks.get(id) || store.remember({ id, title, artist, artists: [artist], artwork: yt.thumb(r.id), durationMs: (r.seconds || 0) * 1000, isVideo: true, ytTitle: r.title, enriched: true, coverTried: true, addedAt: Date.now() });
    if (!(await db.get('ytcache', id))) await db.put('ytcache', { video: r.id, audio: r.id, videoTitle: r.title, audioTitle: r.title, fromSearch: true }, id);
    out.push(t);
  }
  return out;
}
// ---------- Search relevance ----------
// Only keep results that actually match what was typed: every word must appear (as the start of a
// word in the title / artist / album), with one typo allowed in longer words. Best matches first.
const STOP = new Set(['the', 'a', 'an', 'by', 'and', 'of', 'feat', 'ft', 'with', 'x']);
function near(a, b) { // edit distance <= 1
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, d = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++d > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return d + (a.length - i) + (b.length - j) <= 1;
}
function relevance(q) {
  const nq = norm(q);
  const toks = nq.split(' ').filter(t => t && !STOP.has(t));
  const words = toks.length ? toks : nq.split(' ').filter(Boolean);
  return (...fields) => {
    const text = norm(fields.filter(Boolean).join(' '));
    if (!words.length) return 1;
    const tw = text.split(' ');
    let hits = 0, exact = 0;
    for (const t of words) {
      if (tw.some(w => w === t)) { hits++; exact++; }
      else if (tw.some(w => w.startsWith(t) || (t.length >= 5 && w.length >= 4 && near(t, w.slice(0, t.length + 1)) ) || (t.length >= 5 && near(t, w)))) hits++;
      else if (t.length >= 3 && text.replace(/ /g, '').includes(t)) hits += 0.8; // "acdc" vs "ac dc"
    }
    const need = words.length >= 4 ? words.length - 1 : words.length;
    if (hits < need) return null;
    let sc = hits + exact * 0.5;
    if (text.includes(nq)) sc += 3;
    if (norm(fields[0] || '').startsWith(nq)) sc += 2;
    return sc;
  };
}
function keepRelevant(list, q, fieldsOf) {
  const rel = relevance(q);
  return list.map((x, i) => ({ x, i, s: rel(...fieldsOf(x)) })).filter(o => o.s !== null)
    .sort((a, b) => (b.s - a.s) || (a.i - b.i)).map(o => o.x);
}

let searchSeq = 0;
async function doSearch(q, tab) {
  lastSearch.q = q;
  const my = ++searchSeq;
  const box = $('#sres'); if (!box) return;
  if (!q) { box.innerHTML = searchHints(tab); return; }
  const local = tab === 'youtube' ? [] : applyFilters(store.saved(), { q }).slice(0, 8);
  box.innerHTML = `${local.length && tab !== 'albums' && tab !== 'artists' ? `<h2>In your library</h2>${rowsFor('s-local', local)}` : ''}<div id="s-main">${loader(tab === 'youtube' ? 'Searching YouTube…' : 'Searching…', 'search')}</div>${tab === 'all' ? '<div id="s-yt"></div>' : ''}`;
  markNow();
  if (!navigator.onLine) { $('#s-main').innerHTML = '<p class="muted">Offline — only your library is searchable.</p>'; return; }
  const alive = () => my === searchSeq && $('#sres');
  // YouTube results (own tab, or a section under the music results on "All")
  const ytPart = async (target, limit) => {
    if (q.length < 2) return;
    try {
      const res = keepRelevant(await yt.rawSearch(q, { preferFree: true }), q, r => [r.title, r.author]);
      if (!alive()) return;
      const tracks = (await ytResultsToTracks(res)).slice(0, limit);
      prefetchTop(tracks, 2);
      const el = $(target); if (!el) return;
      el.innerHTML = tracks.length ? `<div class="sec-h"><h2>${icon('yt')} From YouTube</h2>${tab === 'all' && tracks.length >= limit ? '<a class="lnk" href="#/search/youtube">See all</a>' : ''}</div>${rowsFor('s-yt-list', tracks)}` : (tab === 'youtube' ? '<p class="muted">No YouTube results.</p>' : '');
      markNow();
    } catch (e) { const el = $(target); if (el && alive()) el.innerHTML = tab === 'youtube' ? `<p class="muted">${esc(e.message)}</p>` : ''; }
  };
  if (tab === 'youtube') return ytPart('#s-main', 20);
  if (tab === 'all') ytPart('#s-yt', 6);
  try {
    const want = t => tab === 'all' || tab === t;
    // Apple's catalogue first; if it's slow, Deezer steps in. Nothing waits more than ~9 seconds.
    const later = (ms, fn) => sleep(ms).then(fn).catch(() => []);
    const songsP = want('songs') ? meta.firstFull([meta.searchSongs(q, tab === 'songs' ? 40 : 10).catch(() => []), later(1800, () => meta.deezerSearchSongs(q, tab === 'songs' ? 40 : 10))]) : [];
    const artistsP = want('artists') ? meta.firstFull([meta.searchArtists(q, tab === 'artists' ? 20 : 6).catch(() => []), later(1800, () => meta.deezerSearchArtists(q, tab === 'artists' ? 20 : 6))]) : [];
    const albumsP = want('albums') ? meta.searchAlbums(q, tab === 'albums' ? 40 : 12).catch(() => []) : [];
    // Each section appears the moment its results arrive
    const box = () => $('#s-main');
    let shown = 0, settled = 0;
    const parts = { artists: '', albums: '', songs: '' };
    const paint = () => {
      if (!alive() || !box()) return;
      const html = parts.songs + parts.artists + parts.albums;
      if (html) { box().innerHTML = html + (settled < 3 ? `<div class="s-more">${loader('', 'sm inline')}</div>` : ''); fillArtistPics(box()); markNow(); }
      else if (settled === 3) box().innerHTML = `<p class="muted">No results from the music catalogue for "${esc(q)}". Check the spelling, or try the YouTube tab.</p>`;
    };
    const part = (p, fill) => meta.withTimeout(Promise.resolve(p), 9000, []).then(v => { if (alive()) { fill(v || []); settled++; shown++; paint(); } }, () => { settled++; paint(); });
    await Promise.all([
      part(artistsP.then?.(v => keepRelevant(v, q, a => [a.name])) ?? artistsP, v => { parts.artists = v.length ? `<h2>Artists</h2><div class="${tab === 'all' ? 'shelf' : 'cards'}">${v.map(a => artistCard(a.name, a.picture || '', a.genre)).join('')}</div>` : ''; }),
      part(albumsP.then?.(v => keepRelevant(v, q, a => [a.title, a.artist])) ?? albumsP, v => { parts.albums = v.length ? `<h2>Albums</h2><div class="${tab === 'all' ? 'shelf' : 'cards'}">${v.map(a => card({ href: `#/album/it/${a.itunesAlbumId}`, img: a.artwork, title: a.title, sub: `${a.artist} · ${a.year || ''}`, act: 'play-it-album', id: a.itunesAlbumId })).join('')}</div>` : ''; }),
      part(songsP.then?.(v => keepRelevant(v, q, t => [t.title, t.artist, t.album])) ?? songsP, v => { const st = v.map(t => lib.tracks.get(t.id) || store.remember(t)); prefetchTop(st, 3); parts.songs = st.length ? `<h2>Songs</h2>${rowsFor('s-songs', st)}` : ''; })
    ]);
  } catch (e) {
    if (alive()) $('#s-main').innerHTML = '<p class="muted">Music search is unavailable right now. Try again in a moment.</p>';
  }
}
// Look up the YouTube version of the top results right away, so tapping one starts instantly
function prefetchTop(tracks, n) { setTimeout(() => tracks.slice(0, n).forEach((t, k) => setTimeout(() => player.prefetch(t.id), k * 450)), 250); }
function rowsFor(key, tracks) {
  lists.set(key, tracks.map(t => t.id));
  const cur = player.current()?.id;
  return `<div class="rows">${tracks.map((t, i) => trackRow(t, i, { list: key }, cur)).join('')}</div>`;
}

// ---------- IMPORT ----------
// Import lives inside Settings (Settings → Import music); #/import jumps straight there.
async function importSection() {
  const connected = await sp.isConnected();
  const clientId = await kv.get('spotifyClientId', '');
  return `<section id="import" class="set-group"><h2 class="group-h">${icon('import')} Import music</h2>
    <p class="muted tiny group-sub">Bring in songs and playlists from Spotify, YouTube, Apple Music, CSV files, a pasted list, or music files on this device.</p>
    <div class="panel">
      <div class="panel-h">${icon('spotify', 'brand-sp')}<div><h2>From Spotify</h2><p class="muted tiny">Your Liked Songs and every playlist — no account setup, takes about a minute. Uses <b>Exportify</b>, a free, open-source tool that reads your Spotify library (read-only) right in your browser.</p></div></div>
      <ol class="steps">
        <li><b>Open Exportify</b> below → tap <b>Get Started</b> → log in to Spotify and allow access.</li>
        <li>Tap <b>Export All</b> to download everything (a <code>.zip</code>), or <b>Export</b> next to just the playlists you want (<code>.csv</code>).</li>
        <li>Come back here and choose the downloaded file. Liked Songs go to your Liked Songs, every playlist comes in as a playlist.</li>
      </ol>
      <div class="row-btns">
        <button class="btn primary" data-act="exportify">${icon('spotify')}Open Exportify</button>
        <label class="btn">${icon('import')}Choose downloaded file<input type="file" accept=".zip,.csv,application/zip,text/csv" multiple hidden data-act-change="exportify-file"></label>
      </div>
      <label class="drop" data-drop="csv">${icon('import')}<span>…or drop the .zip / .csv here</span><input type="file" accept=".zip,.csv,application/zip,text/csv" multiple hidden data-act-change="exportify-file"></label>
      <details class="howto sp-dev" ${connected ? 'open' : ''}><summary>Advanced: connect Spotify directly with a developer key</summary>
      ${connected ? `<div class="row-btns">
          <button class="btn primary" data-act="sp-liked">${icon('heartFill')}Import Liked Songs</button>
          <button class="btn" data-act="sp-playlists">${icon('library')}Choose playlists</button>
          <button class="btn ghost" data-act="sp-disconnect">Disconnect</button></div>`
      : `<p class="tiny muted">Imports straight from Spotify without downloading a file. Needs a free Spotify developer app (Spotify requires the developer account to have Premium).</p><ol>
          <li>Open <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener" class="lnk">developer.spotify.com/dashboard</a> and log in.</li>
          <li>Click <b>Create app</b>. Any name. Tick <b>Web API</b>.</li>
          <li>Under <b>Redirect URIs</b> add exactly: <code class="copy" data-act="copy" data-v="${esc(sp.redirectUri())}">${esc(sp.redirectUri())}</code></li>
          <li>Save, then copy the <b>Client ID</b> and paste it below.</li></ol>
        <form class="inline-form" id="sp-form"><input name="cid" placeholder="Spotify Client ID" value="${esc(clientId)}" required pattern="[A-Za-z0-9]{20,40}"><button class="btn">${icon('spotify')}Connect Spotify</button></form>`}
      </details>
    </div>
    <div class="panel">
      <div class="panel-h">${icon('yt', 'brand-yt')}<div><h2>From YouTube</h2><p class="muted tiny">Bring in your YouTube playlists and Liked videos — handy as a second backup of your music. Each song keeps the exact video from the playlist.</p></div></div>
      <div class="row-btns">${ya.configured() ? `<button class="btn primary" data-act="yt-import-mine">${icon('yt')}${ya.signedIn() ? 'Choose my YouTube playlists' : 'Sign in & choose my playlists'}</button>${ya.signedIn() ? '<button class="btn ghost" data-act="yt-signout">Disconnect</button>' : ''}` : ''}</div>
      <form class="inline-form" id="ytlink-form"><input name="u" placeholder="Paste any public or unlisted YouTube playlist link" required><button class="btn">${icon('import')}Import link</button></form>
      ${!ya.configured() ? '<p class="tiny muted">Public and unlisted playlist links work right away. To pick your private playlists and Liked videos, connect a YouTube account below (Settings → YouTube backup).</p>' : ''}
    </div>
    <div class="panel">
      <div class="panel-h">${icon('apple', 'brand-am')}<div><h2>From Apple Music</h2><p class="muted tiny">Import playlists, your whole library and Favorite (Loved) songs, with genres and years. No Apple account login needed.</p></div></div>
      <details class="howto"><summary>How to export from Apple Music</summary><ol>
        <li><b>Mac</b> (Music app) or <b>Windows</b> (Apple Music / iTunes app).</li>
        <li><b>Everything at once:</b> File → Library → <b>Export Library…</b> → save the <code>.xml</code> file.</li>
        <li><b>One playlist:</b> select it, then File → Library → <b>Export Playlist…</b> → format <b>Plain Text</b> (<code>.txt</code>).</li>
        <li>Drop the file below. On iPhone/Android the Apple Music app can't export — do it once on a computer, or use any converter that gives a CSV and the CSV option below.</li></ol></details>
      <label class="drop"><input type="file" accept=".xml,.txt,text/plain,text/xml,application/xml" multiple hidden data-act-change="apple">${icon('apple')}<span>Choose Apple Music export (.xml / .txt)</span></label>
    </div>
    <div class="panel">
      <div class="panel-h">${icon('file')}<div><h2>From a CSV file</h2><p class="muted tiny">No Spotify key needed. Export any playlist or your Liked Songs at <a class="lnk" href="https://exportify.net" target="_blank" rel="noopener">exportify.net</a> (or any CSV with title + artist columns), then drop the files here. Genres and release dates come along too.</p></div></div>
      <label class="drop" data-drop="csv"><input type="file" accept=".csv,text/csv" multiple hidden data-act-change="csv">${icon('import')}<span>Choose CSV files</span></label>
    </div>
    <div class="panel">
      <div class="panel-h">${icon('edit')}<div><h2>Paste a list</h2><p class="muted tiny">One song per line — "Artist - Title" or "Title by Artist".</p></div></div>
      <form id="paste-form"><textarea name="t" rows="5" placeholder="Daft Punk - One More Time&#10;Blinding Lights by The Weeknd"></textarea>
      <div class="row-btns"><input name="name" placeholder="Playlist name (optional)"><button class="btn">${icon('plus')}Add songs</button></div></form>
    </div>
    <div class="panel">
      <div class="panel-h">${icon('folder')}<div><h2>Music files on this device</h2><p class="muted tiny">MP3/M4A/FLAC/etc. that you own. They play fully offline and get grouped into albums from their tags. Songs already in your library get linked automatically.</p></div></div>
      <div class="row-btns"><button class="btn" data-act="add-files">${icon('file')}Add files</button><button class="btn" data-act="add-folder">${icon('folder')}Add a folder</button></div>
    </div>
  </section>`;
}
function wireImport() {
  $('#sp-form')?.addEventListener('submit', e => { e.preventDefault(); sp.login(new FormData(e.target).get('cid').trim()); });
  $('#paste-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const tracks = imp.tracksFromText(fd.get('t'));
    if (!tracks.length) return toast('Couldn\'t read any "Artist - Title" lines', 'err');
    const saved = await store.upsertTracks(tracks);
    if (fd.get('name')) { const p = await store.createPlaylist(fd.get('name'), saved.map(t => t.id), { source: 'pasted' }); location.hash = '#/playlist/' + p.id; }
    else { await Promise.all(saved.map(t => store.updateTrack(t.id, { liked: true }))); toast(`${saved.length} songs added to Liked`); location.hash = '#/library/liked'; }
  });
  $('[data-act-change="csv"]').addEventListener('change', e => { importCSVFiles([...e.target.files]); e.target.value = ''; });
  $$('[data-act-change="exportify-file"]').forEach(i => i.addEventListener('change', e => { exportifyWaiting = false; importCSVFiles([...e.target.files], { source: 'Spotify' }); e.target.value = ''; }));
  $('[data-act-change="apple"]').addEventListener('change', e => importAppleFiles([...e.target.files]));
  $('#ytlink-form').addEventListener('submit', e => { e.preventDefault(); ytImportLink(e.target.u.value.trim()); });
}

// CSV and ZIP files (Exportify, or any CSV with title + artist columns)
async function importCSVFiles(files, { source = 'CSV' } = {}) {
  const items = [];
  for (const f of files) {
    try {
      if (/\.zip$/i.test(f.name) || f.type === 'application/zip') items.push(...await imp.unzipText(f));
      else items.push({ name: f.name, text: await f.text() });
    } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
  }
  const csvs = items.filter(x => !imp.isAlbumCSV(x.text));
  if (!csvs.length) { if (items.length) toast('No songs found in that file', 'err'); return; }
  const prog = csvs.length > 1 ? progress(`Importing ${csvs.length} playlists…`) : null;
  let likedN = 0, pls = 0, songs = 0, firstPl = null;
  const usedNames = new Map(); // each file becomes its own playlist, even if two files share a name
  const report = [];
  for (let i = 0; i < csvs.length; i++) {
    const f = csvs[i];
    prog?.set(i + 1, csvs.length);
    if (prog?.cancelled) break;
    try {
      const tracks = imp.tracksFromCSV(f.text);
      if (!tracks.length) continue;
      const base = (f.name.split('/').pop() || 'Playlist').replace(/\.csv$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Imported playlist';
      // Only a file that is clearly your Liked Songs export goes into Liked Songs; everything else is a playlist
      if (/^(your |my )?liked( songs)?$/i.test(base)) {
        await store.upsertTracks(tracks.map(t => ({ ...t, liked: true, likedAt: t.addedAt || Date.now() })));
        likedN += tracks.length; songs += tracks.length; report.push(['Liked Songs', tracks.length]); continue;
      }
      const k = base.toLowerCase(), n = (usedNames.get(k) || 0) + 1; usedNames.set(k, n);
      const name = n > 1 ? `${base} (${n})` : base;
      const saved = await store.upsertTracks(tracks);
      // Re-importing the same playlist file updates it (only the first file with that name in this batch)
      const ex = n === 1 && [...lib.playlists.values()].find(x => x.name === name && (x.source === source || x.source === 'CSV' || x.source === 'Spotify'));
      let pl;
      if (ex) { ex.trackIds = saved.map(t => t.id); await store.savePlaylist(ex); pl = ex; }
      else pl = await store.createPlaylist(name, saved.map(t => t.id), { source });
      firstPl = firstPl || pl;
      pls++; songs += saved.length; report.push([name, saved.length]);
    } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
  }
  const msg = [pls ? `${pls} playlist${pls > 1 ? 's' : ''}` : '', likedN ? `${likedN} Liked Songs` : ''].filter(Boolean).join(' and ');
  if (report.length > 1) setTimeout(() => modal(`<h3>${icon('check')} Imported ${report.length} files</h3><div class="imp-report">${report.map(([n, c]) => `<div><span>${esc(n)}</span><b>${c} song${c === 1 ? "" : "s"}</b></div>`).join('')}</div><div class="modal-actions center"><button class="btn primary" data-close>Done</button></div>`), 400);
  if (prog) prog.done(msg ? `Imported ${msg} ✓` : 'Nothing to import'); else if (msg) toast(`Imported ${msg} ✓`, 'ok'); else toast('No songs found in that file', 'err');
  renderSidebarPlaylists();
  if (pls === 1 && !likedN && firstPl) location.hash = '#/playlist/' + firstPl.id;
  else if (likedN && !pls) location.hash = '#/library/liked';
  else if (pls || likedN) location.hash = '#/library/playlists';
}
// Spotify via Exportify: open it in a small window, then pick up the downloaded file when you're back
let exportifyWaiting = false;
function openExportify() {
  const narrow = innerWidth < 760;
  const w = narrow ? null : window.open('https://exportify.net/', 'exportify', `popup=yes,width=${Math.min(1000, screen.availWidth - 80)},height=${Math.min(800, screen.availHeight - 80)},left=60,top=40`);
  if (!w) window.open('https://exportify.net/', '_blank', 'noopener');
  exportifyWaiting = true;
  toast('Export from Exportify, then come back here and choose the file', 'info');
}
async function exportifyReturn() {
  if (!exportifyWaiting || document.hidden || !profile) return;
  exportifyWaiting = false;
  await sleep(400);
  if ($('.modal-wrap')) return;
  modal(`<div class="sp-back"><div class="sp-back-ic">${icon('spotify')}</div><h3>Got your Spotify file?</h3>
    <p class="muted">Choose the <b>.zip</b> (Export All) or <b>.csv</b> files you just downloaded from Exportify — usually in your <b>Downloads</b> folder.</p>
    <label class="btn primary big">${icon('import')}Choose file<input type="file" accept=".zip,.csv,application/zip,text/csv" multiple hidden id="sp-back-file"></label>
    <button class="btn ghost block" data-close>Not yet</button></div>`, {
    onMount: (m, close) => m.querySelector('#sp-back-file').addEventListener('change', e => { const fs = [...e.target.files]; close(null); if (fs.length) importCSVFiles(fs, { source: 'Spotify' }); })
  });
}
window.addEventListener('focus', () => setTimeout(exportifyReturn, 300));
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(exportifyReturn, 300); });

async function importAppleFiles(files) {
  let any = false;
  for (const f of files) {
    try {
      const text = await imp.readTextSmart(f);
      if (/^\s*<\?xml|<plist/i.test(text.slice(0, 400))) {
        const lib2 = imp.fromAppleXML(text);
        if (!lib2.tracks.length) { toast(`${f.name}: no songs found`, 'err'); continue; }
        const r = await modal(`<h3>Import from Apple Music</h3><p class="muted tiny">${lib2.tracks.length} songs found. Pick what to bring in.</p>
          <form><div class="pick-list">
            <label class="pick">${likedCover('sm')}<span><b>Favorite (Loved) songs → Liked</b><small>${lib2.loved.length} songs</small></span><input type="checkbox" name="loved" value="1" ${lib2.loved.length ? 'checked' : 'disabled'}></label>
            <label class="pick"><div class="cover sm noimg"><span>♪</span></div><span><b>All songs in my library</b><small>${lib2.tracks.length} songs</small></span><input type="checkbox" name="all" value="1"></label>
            ${lib2.playlists.map((p, i) => `<label class="pick">${cover('', p.name, 'sm')}<span><b>${esc(p.name)}</b><small>${p.trackIds.length} songs${p.smart ? ' · smart playlist' : ''}</small></span><input type="checkbox" name="p" value="${i}" ${p.smart ? '' : 'checked'}></label>`).join('')}
          </div><div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Import</button></div></form>`, { wide: true });
        if (!r) continue;
        const pick = [].concat(r.p || []).map(Number);
        const need = new Set([...(r.loved ? lib2.loved : []), ...pick.flatMap(i => lib2.playlists[i].trackIds), ...(r.all ? lib2.tracks.map(t => t.id) : [])]);
        const saved = await store.upsertTracks(lib2.tracks.filter(t => need.has(t.id)));
        if (r.loved) for (const id of lib2.loved) if (need.has(id)) await store.updateTrack(id, { liked: true });
        for (const i of pick) {
          const p = lib2.playlists[i];
          const ex = [...lib.playlists.values()].find(x => x.source === 'Apple Music' && x.name === p.name);
          if (ex) { ex.trackIds = p.trackIds; await store.savePlaylist(ex); } else await store.createPlaylist(p.name, p.trackIds, { source: 'Apple Music' });
        }
        toast(`Apple Music: ${saved.length} songs, ${pick.length} playlists imported`, 'ok'); any = true;
      } else {
        const tracks = imp.tracksFromAppleTxt(text);
        if (!tracks.length) { toast(`${f.name}: no songs found`, 'err'); continue; }
        const saved = await store.upsertTracks(tracks);
        const name = f.name.replace(/\.txt$/i, '');
        await store.createPlaylist(name, saved.map(t => t.id), { source: 'Apple Music' });
        toast(`Playlist "${name}" imported (${saved.length})`, 'ok'); any = true;
      }
    } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
  }
  renderSidebarPlaylists();
  if (any) location.hash = '#/library/playlists';
}

async function spImportLiked() {
  const prog = progress('Importing Liked Songs…');
  try {
    const tracks = await sp.likedSongs((n, total) => prog.set(n, total));
    await store.upsertTracks(tracks, { liked: true });
    prog.done(`${tracks.length} Liked Songs imported`);
    location.hash = '#/library/liked';
  } catch (e) { prog.fail(e.message); }
}
async function spChoosePlaylists() {
  let pls;
  const prog = progress('Loading your playlists…');
  try { pls = await sp.playlists(); prog.close(); } catch (e) { return prog.fail(e.message); }
  if (!pls.length) return toast('No playlists found on that account');
  const r = await modal(`<h3>Choose playlists to import</h3>
    <form><div class="pick-list">${pls.map(p => `<label class="pick">${cover(p.image, p.name, 'sm')}<span><b>${esc(p.name)}</b><small>${p.total ?? '?'} songs · ${esc(p.owner)}</small></span><input type="checkbox" name="p" value="${p.spotifyId}" checked></label>`).join('')}</div>
    <p class="tiny muted">Spotify only lets apps read songs in playlists you own or collaborate on.</p>
    <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Import</button></div></form>`, { wide: true });
  if (!r) return;
  const sel = [].concat(r.p || []);
  const picked = pls.filter(p => sel.includes(p.spotifyId));
  let ok = 0;
  for (const p of picked) {
    const pr = progress(`Importing "${p.name}"…`);
    try {
      const tracks = await sp.playlistTracks(p.spotifyId, (n, t) => pr.set(n, t));
      const saved = await store.upsertTracks(tracks);
      const existing = [...lib.playlists.values()].find(x => x.spotifyId === p.spotifyId);
      if (existing) { existing.trackIds = saved.map(t => t.id); existing.name = p.name; await store.savePlaylist(existing); }
      else await store.createPlaylist(p.name, saved.map(t => t.id), { source: 'Spotify', spotifyId: p.spotifyId, image: p.image });
      pr.done(`"${p.name}" — ${saved.length} songs`); ok++;
    } catch (e) { pr.fail(`"${p.name}": ${e.status === 403 ? 'Spotify doesn\'t allow reading this playlist (not yours)' : e.message}`); }
  }
  renderSidebarPlaylists();
  if (ok) location.hash = '#/library/playlists';
}

// ---------- OFFLINE ----------
async function vOffline() {
  const off = store.saved().filter(t => t.localFileId);
  let est = '';
  try { const e = await navigator.storage.estimate(); est = `${(e.usage / 1e6).toFixed(0)} MB used of ~${(e.quota / 1e9).toFixed(1)} GB available`; } catch { }
  const persisted = await navigator.storage?.persisted?.();
  view().innerHTML = `<div class="page">${header('Offline', `${off.length} songs playable without internet${est ? ' · ' + est : ''}`, '', '', '')}
    <div class="panel">
      <p class="muted">BAZINGA! plays offline from music files you own that are stored on this device. Add files or a whole folder — they're matched to songs in your library by their tags or by "Artist - Title" file names, and grouped into albums.</p>
      <div class="row-btns"><button class="btn primary" data-act="add-files">${icon('file')}Add music files</button><button class="btn" data-act="add-folder">${icon('folder')}Add a folder</button>
      <label class="toggle"><input type="checkbox" id="pref-off" ${P.preferOffline ? 'checked' : ''}><span></span>Prefer offline files when online too</label></div>
      ${persisted === false ? '<p class="tiny muted">Tip: install BAZINGA! (browser menu → Install / Add to Home Screen) so your browser keeps the files safe.</p>' : ''}
      <p class="tiny muted">YouTube streams themselves can't be saved — that's against YouTube's rules — so songs without a file need internet.</p>
    </div>
    ${off.length ? `<div class="actions">${playBtns('play-list', 'offline')}</div>${tracksSection('offline', off)}` : empty('Nothing offline yet', 'Add music files above to listen anywhere.')}</div>`;
  $('#pref-off').onchange = e => player.setPreferOffline(e.target.checked);
  observeMore();
}

async function addLocalFiles(files, { albumHint } = {}) {
  files = files.filter(f => imp.AUDIO_EXT.test(f.name) || f.type.startsWith('audio/'));
  if (!files.length) return toast('No audio files found', 'err');
  const prog = progress(`Adding ${files.length} files…`);
  let linked = 0, added = 0;
  const albums = new Map();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    prog.set(i + 1, files.length);
    try {
      const tag = await imp.readLocalFile(f);
      let id = trackKey(tag.artist, tag.title);
      // Album page: match by title against the album's tracks
      if (albumHint && !lib.tracks.has(id)) {
        const m = albumHint.find(t => norm(t.title) === norm(tag.title) || norm(f.name).includes(norm(t.title)));
        if (m) id = m.id;
      }
      const existing = lib.tracks.get(id);
      const fileId = 'f_' + id;
      await db.put('files', { id: fileId, blob: f, name: f.name, type: f.type, size: f.size, addedAt: Date.now() });
      let art = existing?.artwork || '';
      if (!art && tag.picture) { try { art = await imageToDataURL(tag.picture, 300); } catch { } }
      const t = {
        ...(existing || {}), id, title: existing?.title || tag.title, artist: existing?.artist || tag.artist,
        album: existing?.album || tag.album, genre: existing?.genre || tag.genre, year: existing?.year || tag.year,
        trackNumber: existing?.trackNumber || tag.trackNumber, artwork: art, localFileId: fileId
      };
      if (t.album && !t.albumId) t.albumId = albumKey(tag.albumArtist || t.artist, t.album);
      await store.upsertTracks([t]);
      existing && !existing.transient ? linked++ : added++;
      if (t.album) {
        const a = albums.get(t.albumId) || { id: t.albumId, title: t.album, artist: tag.albumArtist || mainArtist(t.artist), year: t.year, genre: t.genre, artwork: art, ids: [] };
        a.ids.push([t.trackNumber || 999, id]); if (!a.artwork) a.artwork = art;
        albums.set(t.albumId, a);
      }
    } catch (e) { console.warn('file failed', f.name, e); }
  }
  // Save albums found in the files (so they show up as albums on the device)
  for (const a of albums.values()) {
    const old = lib.albums.get(a.id);
    const ids = a.ids.sort((x, y) => x[0] - y[0]).map(x => x[1]);
    const merged = { ...(old || {}), updatedAt: Date.now(), id: a.id, title: old?.title || a.title, artist: old?.artist || a.artist, year: old?.year || a.year, genre: old?.genre || a.genre, artwork: old?.artwork || a.artwork, trackIds: [...new Set([...(old?.trackIds || []), ...ids])], savedAt: old?.savedAt || Date.now() };
    lib.albums.set(a.id, merged); await db.put('albums', merged);
  }
  store.notify('files');
  prog.done(`${added} new songs, ${linked} linked to your library${albums.size ? `, ${albums.size} albums` : ''} — available offline`);
}

// ---------- SETTINGS ----------
// Scroll so the section's title sits just under the sticky top bar + section tabs (nothing hidden)
function jumpToSection(id, smooth) {
  const el = document.getElementById(id), main = $('#main'); if (!el || !main) return;
  // where the tabs end once they've stuck under the top bar (they sit lower before you scroll)
  const tb = $('.topbar'), topEdge = Math.max(tb && getComputedStyle(tb).display !== 'none' ? tb.getBoundingClientRect().bottom : 0, main.getBoundingClientRect().top);
  const covered = topEdge + ($('.set-jump')?.offsetHeight || 0) - 6;
  const target = main.scrollTop + el.getBoundingClientRect().top - covered - 12;
  main.scrollTo({ top: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
  $$('.set-jump a').forEach(a => a.classList.toggle('on', a.dataset.jump === id));
}
async function vSettings([section] = []) {
  const lastB = await kv.get('lastBackup');
  const lastD = await kv.get('lastDownload');
  const snaps = await backup.listInternal();
  const fstate2 = backup.linkedFileState();
  const imports = await importSection();
  const ytPanel = await ytBackupPanel();
  view().innerHTML = `<div class="page settings-page"><h1 class="page-h">Settings</h1>
    <nav class="set-jump" aria-label="Settings sections">
      <a href="#account" data-jump="account">${icon('user')}You</a><a href="#sync" data-jump="sync">${icon('link')}Sync</a><a href="#import" data-jump="import">${icon('import')}Import music</a><a href="#yt-backup" data-jump="yt-backup">${icon('yt')}YouTube backup</a>
      <a href="#playback" data-jump="playback">${icon('play')}Playback</a><a href="#voice-set" data-jump="voice-set">${icon('mic')}Voice</a><a href="#backup" data-jump="backup">${icon('restore')}Backup</a></nav>
    <section class="acct-hero" id="account">
      <div class="ah-bg" ${profile.picture ? `style="background-image:url('${esc(profile.picture)}')"` : ''}></div>
      <label class="ah-pic" title="Change photo"><input type="file" accept="image/*" id="pf-file" hidden>
        <span class="avatar xl ah-av">${profile.picture ? `<img src="${esc(profile.picture)}" alt="" referrerpolicy="no-referrer">` : icon('user')}</span><span class="ah-cam">${icon('edit')}</span></label>
      <div class="ah-txt">
        <div class="kicker">${sync.linked() ? `${icon('cloud')} Synced across your devices` : 'On this device · no login needed'}</div>
        <h2 class="pf-name">${esc(profile.username)}</h2>
        <div class="ah-stats">${(() => { const all = store.saved(); return [[all.length, 'songs'], [all.filter(t => t.liked).length, 'liked'], [lib.playlists.size, 'playlists'], [store.artists().length, 'artists']].map(([n, l]) => `<span><b>${n}</b>${l}</span>`).join(''); })()}</div>
        <div class="row-btns"><button class="btn" data-act="rename-user">${icon('edit')}Change name</button>${profile.picture ? `<button class="btn ghost" data-act="remove-pic">Remove photo</button>` : ''}</div>
        <div class="ah-theme"><div class="kicker">Theme color</div>${themePicker(settings.theme || currentTheme())}</div>
      </div>
    </section>
    <div class="panel acct-panel" id="sync"><h2>${icon('link')} Sync your devices</h2>
      ${!sync.available() ? `<p class="muted">Device sync works on the online (GitHub Pages) version of BAZINGA!. Here, use <b>Download backup now</b> below and <b>Restore from file</b> on the other device.</p>`
      : sync.linked() ? `<p class="muted">This device is synced. Your library, likes, playlists, albums and name stay the same on every phone, computer and browser you link — no login. To add another, tap <b>Link a device</b> and scan the QR code (another browser on this phone counts as a device too).</p>
        <div id="sync-line">${syncLine()}</div>
        <div class="row-btns"><button class="btn primary" data-act="link-device">${icon('qr')}Link a device</button><button class="btn" data-act="sync-now">${icon('restore')}Sync now</button><button class="btn ghost" data-act="enter-code">I have a code</button></div>
        <details class="howto"><summary>Stop syncing</summary><div class="row-btns"><button class="btn ghost" data-act="sync-leave">Stop syncing this device</button><button class="btn ghost danger-t" data-act="sync-forget">Turn off sync everywhere</button></div><p class="tiny muted">Synced copies pass through the free ntfy.sh relay, encrypted on your device first. Keep BAZINGA! open on a device now and then (at least every few hours when you've made changes) so your other devices can pick them up.</p><div></div></details>`
      : `<p class="muted">Use your music on your phone, computer and every browser — no account, no password. Scan a QR code or open a link on the other device and everything stays in sync automatically. Your library is encrypted on your device before it's sent.</p>
        <div class="row-btns"><button class="btn primary" data-act="link-device">${icon('qr')}Link a device</button><button class="btn" data-act="enter-code">${icon('link')}I have a code or link</button></div>`}
    </div>
    <div class="panel support-panel only-m">${supportPanelInner()}</div>
    ${imports}
    ${ytPanel}
    <div class="panel" id="playback"><h2>${icon('play')} Playback</h2>
      <div class="fld"><span>When the queue finishes</span><div class="seg big choice" id="set-autoplay">
        ${[['liked', 'Play Liked Songs'], ['replay', 'Replay the queue'], ['off', 'Stop']].map(([v, l]) => `<label><input type="radio" name="autoplay" value="${v}" ${(settings.autoplay || 'liked') === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}
      </div></div>
      <p class="tiny muted">Autoplay keeps the music going: after the last song it starts your Liked Songs (shuffled), or plays the same queue again from the top. If the queue already was your Liked Songs, it replays them.</p>
      <label class="toggle"><input type="checkbox" id="set-prefoff" ${P.preferOffline ? 'checked' : ''}><span></span>Prefer offline files when online too</label>
      <label class="toggle"><input type="checkbox" id="set-awake" ${settings.keepAwake !== false ? 'checked' : ''}><span></span><div>Keep the screen on while BAZINGA! is open<small class="tiny muted" style="display:block">Phones stop web music when they lock — this keeps your songs playing.</small></div></label>
      <label class="toggle"><input type="checkbox" id="set-lock" ${settings.lockFeature !== false ? 'checked' : ''}><span></span><div>Screen lock<small class="tiny muted" style="display:block">Shows a lock button (top bar on phones, sidebar on computers), and tapping an empty spot 3 times quickly locks the app so pocket touches and accidental taps do nothing. Tap 3 times again to unlock — the music keeps playing.</small></div></label>
      <button class="btn" data-act="a2hs">${icon('plus')}Add BAZINGA! to your Home Screen</button>
      <p class="tiny muted">Lock screen & background: for now, keep BAZINGA! open to keep the music going — phones pause web players when they lock or you switch apps. Songs with an offline file keep playing. Lock-screen listening is Phase 2: <a class="lnk" href="#/support" data-act="phase2">help us unlock it ☕</a></p>
    </div>
    <div class="panel" id="voice-set"><h2>${icon('mic')} Voice assistant</h2>
      ${(() => {
        const vs = voiceOptions();
        if (!vs.length) return '<p class="muted tiny">This browser has no built-in voices, so the assistant answers on screen only.</p>';
        return `<div class="fld"><span>Voice</span><div class="voice-pick"><select id="set-voice" class="select">
          <option value="">Automatic — most natural voice (${esc(vs[0].name)})</option>
          ${vs.map(v => `<option value="${esc(v.name)}" ${settings.voiceName === v.name ? 'selected' : ''}>${esc(v.name)} · ${v.quality}</option>`).join('')}
          </select><button class="btn" id="voice-try" type="button">${icon('play')}Try it</button></div></div>
          `;
      })()}
      <p class="tiny muted">Tap a mic button to talk to BAZINGA!. The microphone is only on while the assistant is open, and the music stays quiet until it closes.</p>
      <div class="sub-panel"><b>🎶 Song recognition</b>
        <p class="tiny muted">Ask "What song is this?" (or tap <b>What song is playing around me?</b> in the assistant) and BAZINGA! listens to the music around you, like Shazam. It uses <a class="lnk" href="https://audd.io" target="_blank" rel="noopener">AudD</a>, a recognition service built for short, noisy phone recordings. ${window.BAZINGA_CONFIG?.auddToken ? 'It\'s already set up. Add your own key below only if you want your own allowance.' : 'Get an API token from AudD\'s dashboard and paste it here. It\'s kept on your devices and synced to your other devices.'}</p>
        <form id="recog-form" class="stack"><label class="fld"><span>AudD API token</span><input name="auddToken" value="${esc(settings.auddToken || '')}" autocomplete="off" spellcheck="false" placeholder="Paste your AudD token"></label><button class="btn">Save</button></form></div>
    </div>
    <div class="panel" id="backup"><h2>${icon('restore')} Backup & restore</h2>
      <p class="muted">BAZINGA! backs itself up automatically every time something changes. Last backup: <b>${lastB ? new Date(lastB).toLocaleString() : 'not yet'}</b>.</p>
      ${backup.fsSupported ? `<div class="sub-panel"><b>Auto-updating backup file</b>
        <p class="tiny muted">Pick a file on this device (e.g. in Documents or a synced folder). BAZINGA! keeps it up to date automatically — it survives even if browser data is cleared.</p>
        ${fstate2 === 'ok' ? `<p class="ok-line">${icon('check')} Linked and up to date.</p><button class="btn ghost" data-act="bk-unlink">Unlink file</button>`
          : fstate2 === 'needs-permission' ? `<button class="btn primary" data-act="bk-regrant">Resume auto-backup (allow access)</button>`
          : `<button class="btn primary" data-act="bk-link">${icon('file')}Choose backup file</button>`}</div>`
        : `<div class="sub-panel"><b>Backup file</b><p class="tiny muted">This browser can't write to a file automatically, so download a backup now and then (last: ${lastD ? new Date(lastD).toLocaleDateString() : 'never'}). We'll remind you weekly.</p></div>`}
      <div class="row-btns"><button class="btn" data-act="bk-download">${icon('import')}Download backup now</button><button class="btn" data-act="bk-restore-file">${icon('restore')}Restore from file</button></div>
      ${snaps.length ? `<details class="howto"><summary>Automatic snapshots on this device (${snaps.length})</summary>${snaps.map(s => `<div class="snap"><span>${new Date(s.ts).toLocaleString()} · ${s.counts.tracks} songs, ${s.counts.playlists} playlists, ${s.counts.albums} albums</span><button class="btn sm ghost" data-act="bk-restore-snap" data-id="${s.id}">Restore</button></div>`).join('')}</details>` : ''}
      <p class="tiny muted">Backups contain your library, playlists, albums, YouTube matches, profile and settings. Offline music files aren't copied (they're large) — keep the originals and re-add them after a restore.</p>
    </div>

    <div class="panel support-panel only-d">${supportPanelInner()}</div>

    <div class="panel"><h2>${icon('mic')} Lyrics (Genius)</h2>
      <p class="muted tiny">Lyrics come from Genius's official lyrics widget. If they don't load, add a free Genius access token: open <a class="lnk" href="https://genius.com/api-clients" target="_blank" rel="noopener">genius.com/api-clients</a> → New API Client (any name, any website) → Generate Access Token → paste it here. It's stored only on this device.</p>
      <form id="genius-form" class="stack"><label class="fld"><span>Genius access token (optional)</span><input name="geniusToken" value="${esc(settings.geniusToken || '')}" autocomplete="off"></label><button class="btn">Save</button></form>
    </div>

    <div class="panel"><h2>${icon('yt')} YouTube matching</h2>
      <p class="muted tiny">By default BAZINGA! finds videos through free public services — no key, no limits, but they're sometimes slow or down. For rock-solid matching add your own free YouTube Data API key (Google Cloud Console → YouTube Data API v3 → Credentials). It's stored only on this device.</p>
      <form id="yt-form" class="stack">
        <label class="fld"><span>Your YouTube API key (optional)</span><input name="ytKey" value="${esc(settings.ytKey)}" placeholder="AIza…" autocomplete="off"></label>
        <label class="fld"><span>Custom Invidious server (optional)</span><input name="customInstance" value="${esc(settings.customInstance)}" placeholder="https://your-invidious.example"></label>
        <button class="btn">Save</button></form>
      <button class="btn ghost" data-act="clear-ytcache">Forget all YouTube matches</button>
    </div>

    <div class="panel"><h2>${icon('sparkle')} Music info</h2>
      <label class="toggle"><input type="checkbox" id="set-enrich" ${settings.enrich !== false ? 'checked' : ''}><span></span>Automatically fill in genres, release dates & artwork</label>
      <label class="fld"><span>Music store region (for search & albums)</span><select id="set-country" class="select">${['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'ES', 'IT', 'NL', 'SE', 'BR', 'MX', 'JP', 'KR', 'IN', 'NG', 'ZA', 'KE', 'ET', 'EG', 'AE', 'TR', 'PL', 'IE', 'NZ'].map(c => `<option ${settings.country === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <p class="tiny muted" id="enrich-status"></p>
    </div>

    <div class="panel danger-zone"><h2>${icon('trash')} Erase this device</h2>
      <p class="muted">Erases your name, library, playlists, albums, offline files and on-device backups from this browser. ${sync.linked() ? 'Your other synced devices keep their music. ' : ''}A backup file you saved elsewhere is not touched.</p>
      <button class="btn danger" data-act="delete-account">Erase everything here</button></div>
    <p class="tiny muted center"><a class="lnk" href="#/legal">Privacy Policy & Terms</a></p>
  </div>`;
  $('#pf-file').onchange = async e => { const f = e.target.files[0]; if (!f) return; profile.picture = await imageToDataURL(f, 256); await profileChanged(); rerender(); };
  $('#gcid-form')?.addEventListener('submit', async e => { e.preventDefault(); await saveSettings({ googleClientId: e.target.cid.value.trim() }); await ya.signOut(); toast('Saved — now sign in with YouTube', 'ok'); rerender(); });
  wireImport();
  $$('#set-autoplay input').forEach(i => i.onchange = () => saveSettings({ autoplay: i.value }));
  $$('.ah-theme [data-theme]').forEach(b => b.onclick = async () => {
    const k = b.dataset.theme; markThemePicks(k); await saveSettings({ theme: k });
    toast(`${THEMES.find(t => t[0] === k)[1]} it is ⚡`, 'ok');
  });
  $('#set-prefoff').onchange = e => player.setPreferOffline(e.target.checked);
  $('#set-lock').onchange = e => { saveSettings({ lockFeature: e.target.checked }); applyLockSetting(); toast(e.target.checked ? 'Screen lock is on — tap 3 times or use the lock button' : 'Screen lock is off', e.target.checked ? 'ok' : 'info'); };
  $('#set-awake').onchange = e => { saveSettings({ keepAwake: e.target.checked }); toast(e.target.checked ? 'Your screen stays on while BAZINGA! is open ⚡' : 'Screen can lock again — music may stop when it does', e.target.checked ? 'ok' : 'info'); };
  $('#set-voice')?.addEventListener('change', e => { saveSettings({ voiceName: e.target.value }); setVoicePrefs({ name: e.target.value }); previewVoice(e.target.value); });
  $('#voice-try')?.addEventListener('click', () => previewVoice($('#set-voice').value));
  $$('.set-jump a').forEach(a => a.onclick = e => { e.preventDefault(); jumpToSection(a.dataset.jump, true); });
  if (section) requestAnimationFrame(() => jumpToSection(section, false));
  $('#recog-form').onsubmit = async e => { e.preventDefault(); await saveSettings({ auddToken: e.target.auddToken.value.trim() }); toast('Saved: ask "What song is this?" any time 🎶', 'ok'); };
  $('#genius-form').onsubmit = async e => { e.preventDefault(); await saveSettings({ geniusToken: e.target.geniusToken.value.trim() }); lyricsCache.clear(); toast('Saved', 'ok'); };
  $('#yt-form').onsubmit = async e => { e.preventDefault(); await saveSettings(Object.fromEntries(new FormData(e.target))); toast('Saved'); };
  $('#set-enrich').onchange = e => saveSettings({ enrich: e.target.checked });
  $('#set-country').onchange = e => saveSettings({ country: e.target.value });
  const st = () => { const el = $('#enrich-status'); if (el) { const n = store.enrichPending(); el.textContent = n ? `Filling in details for ${n} songs in the background…` : ''; } };
  st(); on('enrich', st);
}

// ---------- SHARED LINK ----------
async function vShared([data]) {
  let d;
  try { d = await unpackString(data); } catch { view().innerHTML = empty('This share link is broken', 'Ask your friend to share it again.'); return; }
  const tracks = (d.t || []).map(x => ({
    id: trackKey(x[1], x[0]), title: x[0], artist: x[1], artists: x[1].split(/\s*,\s*/), album: x[2] || '', year: x[3] || null, genre: x[4] || '', durationMs: x[5] || 0, artwork: x[6] || '', _yt: [x[7], x[8]]
  }));
  for (const t of tracks) { if (t._yt[0] || t._yt[1]) { const c = (await db.get('ytcache', t.id)) || {}; if (!c.video && t._yt[0]) c.video = t._yt[0]; if (!c.audio && t._yt[1]) c.audio = t._yt[1]; await db.put('ytcache', c, t.id); } delete t._yt; }
  const ts = tracks.map(t => lib.tracks.get(t.id) || store.remember(t));
  window.__shared = { d, tracks: ts };
  setTitle(d.n || 'Shared music');
  view().innerHTML = `<div class="page">${header(esc(d.n || 'Shared music'), `Shared by ${esc(d.by || 'a friend')} · ${ts.length} songs`, cover(d.a || ts[0]?.artwork, d.n), '', d.k === 'album' ? 'Album' : d.k === 'song' ? 'Song' : 'Playlist')}
    <div class="actions">${playBtns('play-list', 'shared')}<button class="btn primary-o" data-act="save-shared">${icon('plus')}Save to my library</button></div>
    ${tracksSection('shared', ts, { noFilter: true })}</div>`;
}

// ---------- LEGAL ----------
async function vLegal() {
  view().innerHTML = `<div class="page"><h1 class="page-h">Privacy Policy & Terms</h1><div class="panel legal">${LEGAL_HTML}
    <p class="ok-line">${icon('check')} You accepted version ${esc(profile.termsAccepted || '')}${profile.termsAcceptedAt ? ' on ' + new Date(profile.termsAcceptedAt).toLocaleDateString() : ''}.</p></div></div>`;
}

// ---------- QUEUE (full page on phones) ----------
async function vQueue() { view().innerHTML = `<div class="page"><h1 class="page-h">Queue</h1><div id="queue-page"></div></div>`; renderQueue($('#queue-page')); }

async function notePlaylistPlay(pid) {
  if (!pid || !lib.playlists.has(pid)) return;
  const m = (await kv.get('plPlays')) || {};
  m[pid] = { n: (m[pid]?.n || 0) + 1, at: Date.now() };
  kv.set('plPlays', m);
}
// What to play when the queue runs out (Settings → Playback)
function queueEnded(ids) {
  const mode = settings.autoplay || 'liked';
  if (mode === 'off') return null;
  const liked = store.saved().filter(t => t.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0)).map(t => t.id);
  const wasLiked = ids.length && ids.every(id => lib.tracks.get(id)?.liked) && ids.length >= Math.min(liked.length, 20);
  if (mode === 'liked' && liked.length && !wasLiked) { nowCtx = { list: null }; return { ids: liked, shuffle: true, msg: 'Queue finished — playing your Liked Songs' }; }
  return { ids, shuffle: P.shuffle, msg: 'Queue finished — playing it again' };
}

// ================= PROGRESS HELPER =================
function progress(label) {
  const root = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast prog';
  el.innerHTML = `<div class="pl">${esc(label)}</div><div class="bar"><i style="width:0%"></i></div><button class="ib sm" aria-label="Stop">${icon('close')}</button>`;
  root.appendChild(el);
  const ctl = { cancelled: false };
  el.querySelector('button').onclick = () => { ctl.cancelled = true; el.remove(); };
  const end = (msg, kind) => { el.remove(); if (msg) toast(msg, kind); };
  return Object.assign(ctl, {
    set(n, total) { el.querySelector('i').style.width = total ? (100 * n / total).toFixed(1) + '%' : '30%'; el.querySelector('.pl').textContent = `${label} ${n}${total ? '/' + total : ''}`; },
    done: m => end(m, 'ok'), fail: m => end(m, 'err'), close: () => end()
  });
}

// ================= YOUTUBE BATCH + EXPORT =================
async function ytMatches() {
  const keys = await db.keys('ytcache'), vals = await db.all('ytcache');
  const m = new Map(); keys.forEach((k, i) => m.set(k, vals[i])); return m;
}
async function matchList(ids) {
  const have = await ytMatches();
  const todo = ids.filter(id => { const c = have.get(id); return !c || (!c.video && !c.audio); }).map(id => lib.tracks.get(id)).filter(Boolean);
  if (!todo.length) return toast('All songs already have YouTube matches ✓', 'ok');
  const prog = progress('Finding YouTube versions…');
  try {
    const { found } = await yt.matchMany(todo, { onProgress: (n, t) => prog.set(n, t), isCancelled: () => prog.cancelled });
    if (!prog.cancelled) prog.done(`Matched ${found} of ${todo.length} songs`);
  } catch (e) { prog.fail(e.message); }
  emit('dirty', 'yt');
}
// Which YouTube playlist a BAZINGA! list was saved to before (so "update" adds only new songs)
async function ytLinkOf(key) { return lib.playlists.get(key)?.ytPlaylistId || ((await kv.get('ytLinks')) || {})[key] || null; }
async function setYtLink(key, ytId) {
  const pl = lib.playlists.get(key);
  if (pl) { pl.ytPlaylistId = ytId; await store.savePlaylist(pl); return; }
  const m = (await kv.get('ytLinks')) || {}; m[key] = ytId; await kv.set('ytLinks', m);
}
const ytNoSetup = () => `<p class="tiny muted">Creating playlists on your YouTube account needs a one-time Google key for this copy of BAZINGA! (Settings → YouTube backup). Until then, open the songs as a ready-made playlist on YouTube below.</p>`;

async function ytExport(ids, name = 'My BAZINGA! playlist', jobKey = 'list') {
  ids = ids.filter(id => lib.tracks.has(id));
  if (!ids.length) return toast('No songs here yet', 'err');
  const pending = (await ya.pendingJobs())[jobKey];
  const have = await ytMatches();
  const missing = ids.filter(id => { const c = have.get(id); return !c?.video && !c?.audio; }).length;
  const signed = ya.signedIn(), ready = ya.configured();
  const linked = await ytLinkOf(jobKey);
  const r = await modal(`<h3>${icon('yt')} Save to YouTube</h3>
    ${pending ? `<div class="sub-panel"><b>Upload paused — ${pending.videoIds.length - pending.done} songs left</b><p class="tiny muted">"${esc(pending.title)}" stopped at YouTube's daily limit.</p>
      <div class="row-btns"><button class="btn primary" data-resolve="resume">${icon('upload')}Resume upload</button><button class="btn ghost" data-resolve="drop">Discard</button></div></div>` : ''}
    ${ready ? `<form class="yt-form">
      <p class="muted tiny">Creates a real playlist on your YouTube account with ${ids.length === 1 ? 'this song' : `these ${ids.length} songs`}${missing ? ` (BAZINGA! first finds YouTube versions for the ${missing} without one)` : ''}.</p>
      <label class="fld"><span>Playlist name</span><input name="title" value="${esc(name)}" maxlength="150" required></label>
      ${ytChoiceFields(!!linked)}
      <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">${icon('upload')}${signed ? 'Save to YouTube' : 'Sign in & save'}</button></div>
    </form>` : ytNoSetup()}
    <details class="howto" ${ready ? '' : 'open'}><summary>No sign-in: open as a playlist on YouTube</summary><div class="yt-links"></div></details>`, {
    wide: true,
    onMount: m => {
      const d = m.querySelector('details');
      const fill = async () => {
        if (d.dataset.done) return; d.dataset.done = 1;
        m.querySelector('.yt-links').innerHTML = await ytLinksHTML([{ title: name, ids }], missing);
      };
      d.addEventListener('toggle', () => d.open && fill());
      if (d.open) fill();
    }
  });
  if (!r) return;
  if (r === 'resume') return resumeUpload(jobKey);
  if (r === 'drop') { await ya.dropJob(jobKey); return toast('Discarded'); }
  try { if (!ya.signedIn()) await ya.signIn(); } catch (e) { return toast(e.message, 'err'); }
  const res = await uploadList({ ids, title: r.title.trim() || name, jobKey, mode: r.mode, privacy: r.privacy, update: !!r.update });
  if (res?.url) ytDoneModal([res]);
}
const ytChoiceFields = (canUpdate, updateLabel = 'Update the YouTube playlist I made before (adds only new songs)') => `
  <div class="fld"><span>Which versions?</span><div class="seg big choice">
    <label><input type="radio" name="mode" value="video" ${P.mode === 'video' ? 'checked' : ''}><span>${icon('video')}Music videos</span></label>
    <label><input type="radio" name="mode" value="audio" ${P.mode !== 'video' ? 'checked' : ''}><span>${icon('audio')}Audio only</span></label></div></div>
  <label class="fld"><span>Who can see it on YouTube?</span><select name="privacy" class="select"><option value="private">Only me (private)</option><option value="unlisted">Anyone with the link (unlisted)</option><option value="public">Everyone (public)</option></select></label>
  ${canUpdate ? `<label class="toggle"><input type="checkbox" name="update" value="1" checked><span></span>${updateLabel}</label>` : ''}
  <p class="tiny muted">YouTube lets this app add about 200 songs a day for all users together. Bigger uploads pause and you can resume them later.</p>`;

// "Open on YouTube" links (no sign-in needed), 50 songs per link
async function ytLinksHTML(groups, missing = 0) {
  const have = await ytMatches();
  const part = (links, label) => links.map((l, i) => `<a class="btn ${i ? '' : 'primary'} block" href="${l}" target="_blank" rel="noopener">${icon('yt')}${esc(label)}${links.length > 1 ? ` — part ${i + 1}/${links.length}` : ''}</a>`).join('');
  let html = '';
  for (const g of groups) {
    const vids = [], auds = [];
    g.ids.forEach(id => { const c = have.get(id); if (c?.video || c?.audio) vids.push(c.video || c.audio); if (c?.audio || c?.video) auds.push(c.audio || c.video); });
    if (!vids.length) continue;
    html += `${groups.length > 1 ? `<h4>${esc(g.title)}</h4>` : ''}${part(yt.youtubePlaylistLinks(vids), groups.length > 1 ? 'Music videos' : 'Open music videos on YouTube')}${part(yt.youtubePlaylistLinks(auds), groups.length > 1 ? 'Audio versions' : 'Open audio versions on YouTube')}`;
  }
  return html ? `<p class="tiny muted">Opens YouTube with the songs lined up as a playlist (50 per link).${missing ? ` ${missing} songs don't have a YouTube match yet — use "Find YouTube matches" first to include them.` : ''}</p>${html}`
    : '<p class="tiny muted">No YouTube matches yet — tap "Find YouTube matches" first.</p>';
}

// Make sure every song has a YouTube version, then create/update the playlist on the user's account
async function uploadList({ ids, title, jobKey, mode, privacy, update, quiet = false }) {
  let have = await ytMatches();
  const todo = ids.filter(id => { const c = have.get(id); return !c?.video && !c?.audio; }).map(id => lib.tracks.get(id)).filter(Boolean);
  if (todo.length) {
    const pr = progress(`Finding YouTube versions for "${title}"…`);
    try { await yt.matchMany(todo, { onProgress: (n, t) => pr.set(n, t), isCancelled: () => pr.cancelled }); pr.close(); } catch (e) { pr.fail(e.message); return null; }
    if (pr.cancelled) return null;
    have = await ytMatches();
  }
  let videoIds = [...new Set(ids.map(id => { const c = have.get(id); return c?.[mode] || c?.video || c?.audio; }).filter(Boolean))];
  if (!videoIds.length) { toast(`"${title}": no YouTube versions found`, 'err'); return null; }
  let ytPlaylistId = null;
  const linked = await ytLinkOf(jobKey);
  if (update && linked) {
    try {
      const existing = await ya.existingVideoIds(linked);
      if (existing) { ytPlaylistId = linked; videoIds = videoIds.filter(v => !existing.has(v)); }
    } catch (e) { toast(e.message, 'err'); return null; }
    if (ytPlaylistId && !videoIds.length) { if (!quiet) toast(`"${title}" is already up to date on YouTube ✓`, 'ok'); return { title, url: 'https://www.youtube.com/playlist?list=' + ytPlaylistId, upToDate: true }; }
  }
  const job = { key: jobKey, title, ytPlaylistId, videoIds, done: 0, privacy, created: Date.now() };
  return runUploadJob(job);
}
async function runUploadJob(job) {
  const pr = progress(`Saving "${job.title}" to YouTube…`);
  try {
    const res = await ya.runUpload(job, { onProgress: (n, t) => pr.set(n, t), isCancelled: () => pr.cancelled });
    if (job.ytPlaylistId) await setYtLink(job.key, job.ytPlaylistId);
    if (pr.cancelled) { toast('Upload paused — resume it any time from Settings → YouTube backup'); return null; }
    pr.close();
    return { title: job.title, url: res.url, skipped: res.skipped };
  } catch (e) {
    pr.fail(e.message);
    if (job.ytPlaylistId) await setYtLink(job.key, job.ytPlaylistId);
    if (e.quota) modal(`<h3>Daily YouTube limit reached</h3><p class="muted">${esc(e.message)}</p><p class="tiny muted">${job.done} of ${job.videoIds.length} songs of "${esc(job.title)}" are already in the playlist.</p><div class="modal-actions"><button class="btn primary" data-close>OK</button></div>`);
    return e.quota ? { quota: true } : null;
  }
}
function ytDoneModal(results) {
  results = results.filter(r => r?.url);
  if (!results.length) return;
  modal(`<h3>${icon('check')} Saved to YouTube</h3>
    <p class="muted">${results.length === 1 ? `"${esc(results[0].title)}" is on your YouTube account${results[0].skipped ? ` (${results[0].skipped} videos YouTube wouldn't allow were skipped)` : ''}.` : `${results.length} playlists are on your YouTube account.`}</p>
    <div class="pick-list">${results.map(r => `<a class="pick" href="${r.url}" target="_blank" rel="noopener">${cover('', r.title, 'sm')}<span><b>${esc(r.title)}</b><small>${r.upToDate ? 'Already up to date' : 'Open on YouTube'}</small></span>${icon('yt')}</a>`).join('')}</div>
    <div class="modal-actions"><button class="btn primary" data-close>Done</button></div>`);
}
async function resumeUpload(key) {
  const job = (await ya.pendingJobs())[key];
  if (!job) return toast('Nothing to resume');
  try { if (!ya.signedIn()) await ya.signIn(); } catch (e) { return toast(e.message, 'err'); }
  const res = await runUploadJob(job);
  if (res?.url) ytDoneModal([res]);
}

// Settings → YouTube backup: pick any playlists (and Liked Songs) and create them on YouTube in one go
function backupLists() {
  const liked = store.saved().filter(t => t.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0)).map(t => t.id);
  return [
    ...(liked.length ? [{ key: 'lib:liked', title: 'Liked Songs (BAZINGA!)', ids: liked, liked: true }] : []),
    ...[...lib.playlists.values()].sort((a, b) => a.name.localeCompare(b.name)).filter(p => p.trackIds.length).map(p => ({ key: p.id, title: p.name, ids: p.trackIds.filter(id => lib.tracks.has(id)), img: plCover(p) }))
  ];
}
async function ytBackupPicker() {
  const all = backupLists();
  if (!all.length) return toast('Make a playlist or like some songs first', 'err');
  const ready = ya.configured();
  const links = await kv.get('ytLinks') || {};
  const r = await modal(`<h3>${icon('yt')} Save playlists to YouTube</h3>
    <p class="muted tiny">${ready ? 'Pick what to put on your YouTube account. Each one becomes a YouTube playlist; ones you saved before just get the new songs added.' : 'Pick what to open on YouTube.'}</p>
    <form><div class="pick-list">${all.map(l => `<label class="pick">${l.liked ? likedCover('sm') : cover(l.img, l.title, 'sm')}<span><b>${esc(l.title)}</b><small>${l.ids.length} songs${(lib.playlists.get(l.key)?.ytPlaylistId || links[l.key]) ? ' · on YouTube' : ''}</small></span><input type="checkbox" name="p" value="${esc(l.key)}" checked></label>`).join('')}</div>
      ${ready ? ytChoiceFields(true, 'Update playlists I saved before (adds only new songs)') : ytNoSetup()}
      <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">${icon(ready ? 'upload' : 'yt')}${ready ? (ya.signedIn() ? 'Save to YouTube' : 'Sign in & save') : 'Get YouTube links'}</button></div></form>`, { wide: true });
  if (!r) return;
  const pick = [].concat(r.p || []);
  const chosen = all.filter(l => pick.includes(l.key));
  if (!chosen.length) return toast('Nothing selected');
  if (!ready) {
    const have = await ytMatches();
    const todo = [...new Set(chosen.flatMap(l => l.ids))].filter(id => { const c = have.get(id); return !c?.video && !c?.audio; }).map(id => lib.tracks.get(id)).filter(Boolean);
    if (todo.length) {
      const pr = progress('Finding YouTube versions…');
      try { await yt.matchMany(todo, { onProgress: (n, t) => pr.set(n, t), isCancelled: () => pr.cancelled }); pr.close(); } catch (e) { pr.fail(e.message); }
      if (pr.cancelled) return;
    }
    return modal(`<h3>${icon('yt')} Open on YouTube</h3><div class="yt-links">${await ytLinksHTML(chosen)}</div>`, { wide: true });
  }
  try { if (!ya.signedIn()) await ya.signIn(); } catch (e) { return toast(e.message, 'err'); }
  const results = [];
  for (const l of chosen) {
    const res = await uploadList({ ids: l.ids, title: l.title, jobKey: l.key, mode: r.mode, privacy: r.privacy, update: !!r.update, quiet: true });
    if (res?.quota) break;
    if (res) results.push(res);
  }
  ytDoneModal(results);
  if (location.hash.startsWith('#/settings')) rerender();
}
async function ytBackupPanel() {
  const jobs = Object.values(await ya.pendingJobs());
  const ready = ya.configured(), signed = ya.signedIn();
  const keyForm = `<form id="gcid-form" class="inline-form"><input name="cid" value="${esc(settings.googleClientId || '')}" placeholder="…apps.googleusercontent.com" autocomplete="off"><button class="btn">Save key</button></form>`;
  const steps = `<ol class="tiny"><li>Open <a class="lnk" href="https://console.cloud.google.com/" target="_blank" rel="noopener">console.cloud.google.com</a> → create a project → enable <b>YouTube Data API v3</b>.</li>
      <li>OAuth consent screen → External → add yourself as a test user.</li>
      <li>Credentials → Create credentials → OAuth client ID → <b>Web application</b>. Under Authorized JavaScript origins add <code class="copy" data-act="copy" data-v="${esc(location.origin)}">${esc(location.origin)}</code></li>
      <li>Copy the Client ID and paste it here.</li></ol>`;
  return `<section class="panel yt-panel" id="yt-backup"><h2>${icon('yt', 'brand-yt')} YouTube backup</h2>
    <p class="muted tiny">Turn your BAZINGA! playlists and Liked Songs into real playlists on your YouTube account, and bring your YouTube playlists back in — a second copy of your music, just in case. The YouTube sign-in stays on this device and expires after about an hour.</p>
    <div class="yt-two">
      <div class="sub-panel"><b>${icon('upload')} BAZINGA! → YouTube</b><p class="tiny muted">Pick playlists and they're created on your YouTube account automatically.</p>
        <button class="btn primary" data-act="yt-backup">${icon('upload')}Save playlists to YouTube</button></div>
      <div class="sub-panel"><b>${icon('import')} YouTube → BAZINGA!</b><p class="tiny muted">Import your YouTube playlists and Liked videos, or any public playlist link (Import music → From YouTube).</p>
        ${ready ? `<button class="btn" data-act="yt-import-mine">${icon('yt')}Import my YouTube playlists</button>` : `<a class="btn" href="#/settings/import">${icon('import')}Import a playlist link</a>`}</div>
    </div>
    <div class="row-btns">${!ready ? '' : signed ? `<span class="ok-line">${icon('check')} YouTube connected</span><button class="btn ghost" data-act="yt-signout">Disconnect</button>` : `<button class="btn ghost" data-act="yt-signin">${icon('yt')}Connect YouTube account</button>`}</div>
    ${jobs.length ? `<div class="sub-panel"><b>Paused uploads</b>${jobs.map(j => `<div class="snap"><span>${esc(j.title)} · ${j.videoIds.length - j.done} songs left</span><span><button class="btn sm primary" data-act="yt-resume" data-job="${esc(j.key)}">Resume</button> <button class="btn sm ghost" data-act="yt-drop" data-job="${esc(j.key)}">Discard</button></span></div>`).join('')}</div>` : ''}
    ${ready ? `<details class="howto"><summary>Use your own Google key (for big uploads)</summary><p class="tiny muted">YouTube lets each Google key add about 200 songs a day. With your own free key you get your own daily allowance:</p>${steps}${keyForm}</details>`
      : `<details class="howto"><summary>Connect your YouTube account (one-time setup)</summary><p class="tiny muted">Creating playlists on YouTube needs a free Google sign-in key. Without it you can still open any playlist on YouTube as a ready-made playlist and import public playlist links.</p>${steps}${keyForm}</details>`}
  </section>`;
}

// ---------- import from YouTube ----------
async function importVideos(title, videos, { liked = false, source = 'YouTube', ytPlaylistId = null } = {}) {
  const tracks = [], seen = new Set();
  for (const v of videos) {
    const { artist, title: t, artists } = yt.videoToSong(v);
    if (!artist || !t) continue;
    const id = trackKey(artist, t);
    if (seen.has(id)) continue; seen.add(id);
    tracks.push({ id, title: t, artist, artists, durationMs: (v.seconds || 0) * 1000, addedAt: Date.now() });
    const c = await db.get('ytcache', id);
    if (!c?.video && !c?.audio) await db.put('ytcache', { video: v.id, audio: v.id, videoTitle: v.title, audioTitle: v.title, fromYouTube: true }, id);
  }
  if (!tracks.length) throw new Error('No playable videos found in that playlist.');
  const saved = await store.upsertTracks(tracks, liked ? { liked: true } : {});
  if (liked) return { count: saved.length, liked: true };
  const ex = [...lib.playlists.values()].find(x => ytPlaylistId && x.ytPlaylistId === ytPlaylistId);
  if (ex) { ex.trackIds = saved.map(t => t.id); ex.name = title; await store.savePlaylist(ex); return { count: saved.length, playlist: ex }; }
  const p = await store.createPlaylist(title, saved.map(t => t.id), { source, ytPlaylistId });
  return { count: saved.length, playlist: p };
}
async function ytImportMine() {
  let lists;
  const pr = progress('Loading your YouTube playlists…');
  try { if (!ya.signedIn()) await ya.signIn(); lists = await ya.myPlaylists(); pr.close(); } catch (e) { return pr.fail(e.message); }
  if (!lists.length) return toast('No playlists on that YouTube account');
  const r = await modal(`<h3>${icon('yt')} Import from YouTube</h3><form><div class="pick-list">${lists.map(p => `<label class="pick">${p.liked ? likedCover('sm') : cover(p.image, p.title, 'sm')}<span><b>${esc(p.title)}</b><small>${p.count ?? '?'} videos${p.liked ? ' · goes to your Liked Songs' : ''}</small></span><input type="checkbox" name="p" value="${esc(p.id)}" ${p.liked ? '' : 'checked'}></label>`).join('')}</div>
    <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Import</button></div></form>`, { wide: true });
  if (!r) return;
  const pick = [].concat(r.p || []);
  let n = 0;
  for (const id of pick) {
    const p = lists.find(x => x.id === id);
    const pg = progress(`Importing "${p.title}"…`);
    try { const vids = await ya.playlistVideos(id); const res = await importVideos(p.title, vids, { liked: !!p.liked, ytPlaylistId: p.liked ? null : id }); pg.done(`"${p.title}" — ${res.count} songs`); n++; }
    catch (e) { pg.fail(`"${p.title}": ${e.message}`); }
  }
  renderSidebarPlaylists();
  if (n) location.hash = '#/library/playlists';
}
async function ytImportLink(link) {
  const id = yt.parsePlaylistId(link);
  if (!id) return toast('Paste a YouTube playlist link (it contains "list=")', 'err');
  const pr = progress('Reading YouTube playlist…');
  try {
    let data;
    try { data = await yt.publicPlaylist(id); }
    catch (e) { if (ya.signedIn()) data = { title: 'YouTube playlist', videos: await ya.playlistVideos(id) }; else throw e; }
    const res = await importVideos(data.title, data.videos, { ytPlaylistId: id });
    pr.done(`"${data.title}" — ${res.count} songs imported`);
    renderSidebarPlaylists();
    location.hash = '#/playlist/' + res.playlist.id;
  } catch (e) { pr.fail(e.message); }
}

// ---------- Support (Buy Me a Coffee) ----------
const supportPanelInner = () => `<h2>${icon('coffee')} Support BAZINGA!</h2><p class="muted tiny">Free, no ads, made by one person. Tips keep it going.</p>${coffeeButton()}`;
const coffeeButton = (label = 'Buy me a coffee', cls = '') => `<a class="coffee-btn ${cls}" href="${BMC_URL}" target="_blank" rel="noopener">
  <span class="cb-cup"><i></i><i></i><i></i>${icon('coffee')}</span><span class="cb-txt"><b>${label}</b><small>buymeacoffee.com/bazinga.app</small></span><span class="cb-shine"></span></a>`;
async function vSupport() {
  view().innerHTML = `<div class="page support">
    <section class="sup-hero">
      <div class="sup-bg"></div>
      <div class="sup-txt">
        <div class="kicker">Support BAZINGA!</div>
        <h1>Keep the music free ⚡</h1>
        <p>BAZINGA! has no ads, no subscriptions and no tracking — it's built and kept alive by one person. If it makes your day a little louder, a coffee goes a long way.</p>
        ${coffeeButton('Buy me a coffee', 'big')}
        <p class="tiny muted">Payments are handled securely by Buy Me a Coffee. BAZINGA! never sees your card details.</p>
      </div>
      <div class="sup-qr"><div class="qr-card"><img src="icons/bmc-qr.png" alt="QR code for buymeacoffee.com/bazinga.app" width="240" height="240"><span>Scan to tip from your phone</span></div></div>
    </section>
    <section class="p2-sec" aria-label="Phase 2 goal">
      <div class="p2-sec-h"><div><div class="kicker">Phase 2 ⚡</div><h2>Lock-screen listening</h2><p class="muted">The license that lets everyone keep their music and streams playing on the lock screen. Every coffee counts toward it.</p></div>
      <button class="btn primary" data-act="phase2">${icon('coffee')}Support Phase 2</button></div>
      ${p2GoalHTML()}
    </section>
    <div class="sup-grid">
      <div class="panel"><h2>${icon('heart')} What your tip does</h2><p class="muted">Keeps the app free for everyone, pays for testing devices and time spent on new features like the voice assistant and YouTube sync.</p></div>
      <div class="panel"><h2>${icon('share')} Free ways to help</h2><p class="muted">Share a playlist with a friend, follow along, and tell people about BAZINGA!</p>
        <div class="row-btns"><a class="btn" href="https://www.instagram.com/bazinga.app" target="_blank" rel="noopener">${icon('instagram')}@bazinga.app</a><a class="btn" href="https://x.com/bazinga_app" target="_blank" rel="noopener">${icon('xsocial')}@bazinga_app</a></div></div>
    </div>
  </div>`;
}
// ---------- Phase 2 goal: lock-screen listening ----------
// Phase 2 is explained in the Support page and the coffee popup (no live totals — that would need a database).
const p2GoalHTML = () => '';
const animateP2 = () => { };

async function phase2Popup({ love = false } = {}) {
  const st = (await kv.get('phase2')) || {};
  st.lastShown = new Date().toISOString().slice(0, 10); await kv.set('phase2', st);
  // Step 1: a quick "do you love it?" — only people who do are asked for a coffee
  const loveQ = () => `
      <div class="love-ic"><img src="${logoSrc()}" alt=""></div>
      <h3>Do you love BAZINGA!?</h3>
      <p class="muted">Quick question, be honest!</p>
      <div class="love-btns"><button type="button" class="love-no" data-p2="no" aria-label="No, not really">${icon('thumbDown')}</button><button type="button" class="love-yes" data-p2="yes" aria-label="Yes, I love it">${icon('thumbUp')}</button></div>`;
  const yay = () => `
      <div class="p2-confetti" aria-hidden="true">${Array.from({ length: 24 }, (_, i) => `<i style="--x:${(i * 37) % 100}%;--d:${(i % 7) * 90}ms;--r:${(i * 53) % 360}deg;--c:${['var(--volt)', '#fff', 'var(--volt-2)', 'var(--volt)', '#7cf'][i % 5]}"></i>`).join('')}</div>
      <div class="p2-icon glow">${icon('heartFill')}</div>
      <h3>You just made my day! 🥹⚡</h3>
      <p>Hearing you love BAZINGA! honestly means the world. Want to help make it even better? Every coffee turns into new features, faster fixes and more music magic ⚡</p>
      <a class="coffee-btn big p2-support" href="${BMC_URL}" target="_blank" rel="noopener"><span class="cb-cup"><i></i><i></i><i></i>${icon('coffee')}</span><span class="cb-txt"><b>Buy me a coffee</b><small>Make BAZINGA! even better ☕</small></span><span class="cb-shine"></span></a>
      <div class="p2-btns"><button class="btn p2-notnow" data-p2="close">Not now</button><button class="btn ghost p2-never" data-p2="never">Don't show this again</button></div>`;
  const sad = () => `<div class="sad-face" aria-label="Sad face">${icon('sad')}</div>`;
  const ask = () => `
      <div class="kicker">Phase 2 ⚡ Lock-screen listening</div>
      <h3>Help unlock music on your lock screen</h3>
      <p>Right now your phone pauses BAZINGA! when the screen locks or you leave the app. To let everyone enjoy music and streams on the lock screen, BAZINGA! needs a music license — and that's what Phase 2 is for.</p>
      ${p2GoalHTML()}
      <a class="coffee-btn big p2-support" href="${BMC_URL}" target="_blank" rel="noopener"><span class="cb-cup"><i></i><i></i><i></i>${icon('coffee')}</span><span class="cb-txt"><b>Support Phase 2</b><small>Every coffee counts ☕</small></span><span class="cb-shine"></span></a>
      <div class="p2-btns"><button class="btn ghost p2-later" data-p2="later">Not now</button><button class="btn ghost p2-never" data-p2="never">Don't show this again</button></div>`;
  const later = () => `
      <div class="p2-icon">${icon('play')}</div>
      <h3>No worries — enjoy the music 💛</h3>
      <p>Just so you know: until Phase 2, <b>keep BAZINGA! open</b> to keep your music playing. Locking your phone or switching apps will pause it.</p>
      <p class="tiny muted">We'll keep your screen awake while you're in the app${settings.keepAwake === false ? ' (turn it on in Settings → Playback)' : ''}. You can support Phase 2 any time from the ☕ button.</p>
      <button class="btn primary" data-resolve="later">Got it</button>`;
  const waiting = () => `
      <div class="p2-icon spin">${icon('coffee')}</div>
      <h3>Finishing up on Buy Me a Coffee…</h3>
      <p class="muted">Come back here when you're done.</p>
      <button class="btn primary" data-p2="thanks">I'm done ✓</button>
      <button class="btn ghost" data-p2="back">I didn't support this time</button>`;
  const thanks = () => `
      <div class="p2-confetti" aria-hidden="true">${Array.from({ length: 28 }, (_, i) => `<i style="--x:${(i * 37) % 100}%;--d:${(i % 7) * 90}ms;--r:${(i * 53) % 360}deg;--c:${['var(--volt)', '#fff', 'var(--volt-2)', 'var(--volt)', '#7cf'][i % 5]}"></i>`).join('')}</div>
      <div class="p2-icon glow">${icon('heartFill')}</div>
      <h3>Thank you, legend! ⚡</h3>
      <p>You just helped bring BAZINGA! closer to Phase 2 — lock-screen listening for everyone. It means a lot.</p>
      ${p2GoalHTML()}
      <p class="p2-note">${icon('play')}<span>Until we reach the goal, please <b>keep the app open</b> to keep your music playing.</span></p>
      <button class="btn primary" data-resolve="thanks">Back to my music</button>`;
  let body = null, state = 'ask', onBack = null;
  const show = (k, html) => {
    state = k; body.dataset.step = k; body.innerHTML = html;
    body.classList.remove('in'); void body.offsetWidth; body.classList.add('in');
  };
  const r = await modal(`<div class="p2"><div class="p2-bg" aria-hidden="true"><i></i><i></i><i></i></div><div class="p2-body"></div></div>`, {
    onMount: (m, close) => {
      m.classList.add('p2-modal');
      body = m.querySelector('.p2-body'); if (love) show('love', loveQ()); else show('yay', yay());
      m.addEventListener('click', e => {
        if (e.target.closest('.p2-support')) {
          st.supportClickedAt = Date.now(); kv.set('phase2', st);
          setTimeout(() => show('wait', waiting()), 300);
          // When you come back from Buy Me a Coffee: thank you (and fetch the new total)
          onBack = () => { if (document.visibilityState === 'visible' && state === 'wait') thank(); };
          document.addEventListener('visibilitychange', onBack); window.addEventListener('focus', onBack);
          return;
        }
        const b = e.target.closest('[data-p2]'); if (!b) return;
        if (b.dataset.p2 === 'yes') { st.lovedAt = Date.now(); kv.set('phase2', st); show('yay', yay()); }
        if (b.dataset.p2 === 'no') { st.notLovedAt = Date.now(); kv.set('phase2', st); m.classList.add('sad'); show('sad', sad()); setTimeout(() => close(null), 1700); }
        if (b.dataset.p2 === 'close') close(null);
        if (b.dataset.p2 === 'later') show('later', later());
        if (b.dataset.p2 === 'never') { st.never = true; kv.set('phase2', st); toast('Got it — you won\'t see this again. The ☕ button is always in the top bar.'); m.closest('.modal-wrap')?.querySelector('[data-close]')?.click(); }
        if (b.dataset.p2 === 'thanks') thank();
        if (b.dataset.p2 === 'back') show('later', later());
      });
    }
  });
  async function thank() {
    if (state === 'thanks') return;
    st.supportedAt = Date.now(); kv.set('phase2', st);
    show('thanks', thanks());
  }
  if (onBack) { document.removeEventListener('visibilitychange', onBack); window.removeEventListener('focus', onBack); }
  if (state === 'later') { st.declinedAt = Date.now(); kv.set('phase2', st); }
}
// ================= SHARING =================
async function shareTracks(kind, name, tracks, artwork) {
  const t = [];
  for (const x of tracks.slice(0, 400)) {
    const c = await db.get('ytcache', x.id) || {};
    t.push([x.title, x.artist, x.album || '', x.year || yearOf(x.releaseDate) || 0, x.genre || '', x.durationMs || 0, (x.artwork || '').startsWith('data:') ? '' : x.artwork || '', c.video || '', c.audio || '']);
  }
  const packed = await packToString({ k: kind, n: name, by: profile.username, a: (artwork || '').startsWith('data:') ? '' : artwork, t });
  const url = location.href.split('#')[0] + '#/s/' + packed;
  modal(`<h3>Share "${esc(name)}"</h3><p class="muted tiny">Anyone with this link can open, play and save it in their own BAZINGA! app. The whole ${kind} is packed inside the link — nothing is uploaded anywhere.</p>
    <div class="copy-box"><input readonly value="${esc(url)}" aria-label="Share link"></div>
    <button class="btn primary big" data-act="copy" data-v="${esc(url)}">${icon('link')}Copy link</button>`);
}

// Copy that also works where the Clipboard API isn't available (e.g. opened from a file)
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch { }
  const ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { }
  ta.remove(); return ok;
}

// ================= TRACK MENU =================
async function trackMenu(btn, id, plId) {
  const t = lib.tracks.get(id); if (!t) return;
  const c = await db.get('ytcache', id) || {};
  const pls = [...lib.playlists.values()];
  const k = await menu(btn, [
    { header: `<b>${esc(displayTitle(t))}</b><small>${esc(t.artist)}</small>` },
    { k: 'next', label: 'Play next', icon: 'play' },
    { k: 'queue', label: 'Add to queue', icon: 'queue' },
    { k: 'addpl', label: 'Add to playlist…', icon: 'plus' },
    { k: 'like', label: t.liked ? 'Remove from Liked' : 'Add to Liked Songs', icon: 'heart' },
    '-',
    t.album || t.itunesAlbumId ? { k: 'album', label: 'Go to album', icon: 'disc' } : null,
    t.album || t.itunesAlbumId ? { k: 'savealbum', label: 'Save full album', icon: 'plus' } : null,
    { k: 'artist', label: 'Go to artist', icon: 'mic' },
    { k: 'share', label: 'Share song', icon: 'share' },
    '-',
    { k: 'ytv', label: c.video ? 'Change music video link' : 'Set music video link', icon: 'video' },
    { k: 'yta', label: c.audio ? 'Change audio link' : 'Set audio link', icon: 'audio' },
    c.video || c.audio ? { k: 'ytopen', label: 'Open on YouTube', icon: 'yt' } : null,
    { k: 'file', label: t.localFileId ? 'Replace offline file' : 'Attach offline file', icon: 'offline' },
    t.localFileId ? { k: 'unfile', label: 'Remove offline file', icon: 'cloudOff' } : null,
    '-',
    plId ? { k: 'unpl', label: 'Remove from this playlist', icon: 'trash', danger: true } : null,
    !t.transient ? { k: 'del', label: 'Remove from library', icon: 'trash', danger: true } : null
  ]);
  if (!k) return;
  if (k === 'next' || k === 'queue') player.addToQueue(id, k === 'next');
  if (k === 'addpl') addToPlaylistDialog([id]);
  if (k === 'like') likeClick(id);
  if (k === 'album') gotoAlbum(t);
  if (k === 'savealbum') saveAlbumOf(t);
  if (k === 'artist') location.hash = '#/artist/' + encodeURIComponent(mainArtist(t.artist));
  if (k === 'share') shareTracks('song', `${t.title} — ${t.artist}`, [t], t.artwork);
  if (k === 'ytv' || k === 'yta') setYTLink(t, k === 'ytv' ? 'video' : 'audio', c);
  if (k === 'ytopen') window.open('https://www.youtube.com/watch?v=' + (c[P.mode] || c.video || c.audio), '_blank', 'noopener');
  if (k === 'file') pickFile('audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav', f => attachFile(t, f));
  if (k === 'unfile') { await db.del('files', t.localFileId); await store.updateTrack(id, { localFileId: null }); toast('Offline file removed'); }
  if (k === 'unpl') { const r = await store.removeFromPlaylist(plId, id); toastUndo('Removed from playlist', async () => { await store.undoRemoveFromPlaylist(r); toast('Put back ✓'); }); }
  if (k === 'del' && await confirmBox('Remove from library?', `"${esc(t.title)}" will be removed from your library and all playlists.`, 'Remove', true)) { await store.deleteTrack(id); toast('Removed'); }
}

async function attachFile(t, f) {
  if (t.transient) await store.upsertTracks([t]);
  const fileId = 'f_' + t.id;
  await db.put('files', { id: fileId, blob: f, name: f.name, type: f.type, size: f.size, addedAt: Date.now() });
  await store.updateTrack(t.id, { localFileId: fileId });
  toast('Available offline ✓');
}

async function setYTLink(t, mode, c) {
  const r = await modal(`<h3>${mode === 'video' ? 'Music video' : 'Audio'} for "${esc(t.title)}"</h3>
    ${c[mode] ? `<p class="muted tiny">Current: ${esc(c[mode + 'Title'] || c[mode])}</p>` : ''}
    <form><label class="fld"><span>Paste a YouTube link</span><input name="u" placeholder="https://youtube.com/watch?v=…" required></label>
    <div class="modal-actions"><a class="btn ghost" target="_blank" rel="noopener" href="https://www.youtube.com/results?search_query=${encodeURIComponent(t.artist + ' ' + t.title + (mode === 'audio' ? ' audio' : ' official video'))}">${icon('search')}Search YouTube</a><button class="btn primary">Save</button></div></form>
    <button class="btn ghost block" data-resolve="research">${icon('restore')}Search again automatically</button>`);
  if (!r) return;
  if (r === 'research') {
    try { await yt.findForTrack(t, { force: true }); toast('Updated'); } catch (e) { toast(e.message, 'err'); }
  } else {
    const vid = yt.parseYouTubeId(r.u);
    if (!vid) return toast('That doesn\'t look like a YouTube link', 'err');
    await yt.setManual(t.id, mode, vid);
    toast('Saved ✓');
  }
  emit('dirty', 'yt');
  if (player.current()?.id === t.id && P.mode === mode) player.reloadCurrent();
}

async function addToPlaylistDialog(ids) {
  const pls = [...lib.playlists.values()].sort((a, b) => a.name.localeCompare(b.name));
  const r = await modal(`<h3>Add to playlist</h3><div class="pick-list">
    <button class="pick" data-resolve="__new">${'<div class="cover sm noimg"><span>+</span></div>'}<span><b>New playlist</b></span></button>
    ${pls.map(p => `<button class="pick" data-resolve="${p.id}">${cover(plCover(p), p.name, 'sm')}<span><b>${esc(p.name)}</b><small>${p.trackIds.length} songs</small></span></button>`).join('')}</div>`);
  if (!r) return;
  for (const id of ids) { const t = lib.tracks.get(id); if (t?.transient) await store.upsertTracks([t]); }
  if (r === '__new') {
    const name = await promptText('New playlist', '', 'Name', 'Create'); if (!name) return;
    await store.createPlaylist(name, ids); toast(`Added to "${name}"`);
  } else { const n = await store.addToPlaylist(r, ids); toast(n ? `Added to "${lib.playlists.get(r).name}"` : 'Already in that playlist'); }
  renderSidebarPlaylists();
}

async function resolveAlbum(t) {
  if (t.itunesAlbumId) return { href: `#/album/it/${t.itunesAlbumId}`, itunesAlbumId: t.itunesAlbumId };
  if (t.albumId && lib.albums.has(t.albumId)) return { href: `#/album/${encodeURIComponent(t.albumId)}` };
  if (!t.album) return null;
  const a = await meta.findAlbum(t.artist, t.album).catch(() => null);
  if (a) { store.updateTrack(t.id, { itunesAlbumId: a.itunesAlbumId }); return { href: `#/album/it/${a.itunesAlbumId}`, itunesAlbumId: a.itunesAlbumId }; }
  return { href: `#/album/${encodeURIComponent(t.albumId || albumKey(t.artist, t.album))}` };
}
async function gotoAlbum(t) {
  const r = await resolveAlbum(t);
  if (r) location.hash = r.href; else toast('Album not found', 'err');
}
async function saveAlbumOf(t) {
  const r = await resolveAlbum(t);
  if (!r?.itunesAlbumId) return toast('Couldn\'t find the full album', 'err');
  const { album, tracks } = await meta.albumTracks(r.itunesAlbumId);
  if (!album) return toast('Couldn\'t load that album', 'err');
  await store.saveAlbum(album, tracks.map(x => lib.tracks.get(x.id) ? { ...x, ...stripTransient(lib.tracks.get(x.id)) } : x));
  toast(`Saved album "${album.title}" (${tracks.length} songs)`);
}
const stripTransient = t => { const x = { ...t }; delete x.transient; return x; };

async function playlistMenu(btn, id) {
  const p = lib.playlists.get(id); if (!p) return;
  const k = await menu(btn, [
    { k: 'rename', label: 'Rename', icon: 'edit' },
    { k: 'cover', label: 'Change cover', icon: 'file' },
    { k: 'dup', label: 'Duplicate', icon: 'plus' },
    { k: 'csv', label: 'Export as CSV', icon: 'import' },
    p.spotifyId ? { k: 'resync', label: 'Re-sync from Spotify', icon: 'restore' } : null,
    '-', { k: 'del', label: 'Delete playlist', icon: 'trash', danger: true }
  ]);
  if (k === 'rename') { const n = await promptText('Rename playlist', p.name); if (n) { p.name = n; await store.savePlaylist(p); renderSidebarPlaylists(); } }
  if (k === 'cover') pickFile('image/*', async f => { p.image = await imageToDataURL(f, 400); await store.savePlaylist(p); });
  if (k === 'dup') { const np = await store.createPlaylist(p.name + ' (copy)', p.trackIds); renderSidebarPlaylists(); location.hash = '#/playlist/' + np.id; }
  if (k === 'csv') {
    const rows = [['Track Name', 'Artist Name(s)', 'Album Name', 'Release Date', 'Genres', 'Duration (ms)']];
    for (const tid of p.trackIds) { const t = lib.tracks.get(tid); if (t) rows.push([t.title, t.artist, t.album || '', t.releaseDate || t.year || '', t.genre || '', t.durationMs || '']); }
    downloadBlob(new Blob([rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' }), p.name + '.csv');
  }
  if (k === 'resync') {
    const pr = progress(`Syncing "${p.name}"…`);
    try { const tr = await sp.playlistTracks(p.spotifyId, (n, t) => pr.set(n, t)); const s = await store.upsertTracks(tr); p.trackIds = s.map(t => t.id); await store.savePlaylist(p); pr.done('Synced ✓'); }
    catch (e) { pr.fail(e.message); }
  }
  if (k === 'del' && await confirmBox('Delete playlist?', `"${esc(p.name)}" will be deleted. Songs stay in your library if they're liked or in other playlists/albums.`, 'Delete', true)) {
    await store.deletePlaylist(id); renderSidebarPlaylists(); location.hash = '#/library/playlists';
  }
}

// ================= LIKES =================
// The heart flips the moment you tap it (no page reload). On the Liked Songs page an un-liked song
// stays put for a few seconds (dimmed) so you can tap the heart again to keep it.
const LIKE_GRACE = 6000;
const likeTimers = new Map();
function setHeart(b, on) {
  if (!b) return;
  b.classList.toggle('on', on);
  b.innerHTML = icon(on ? 'heartFill' : 'heart');
  b.setAttribute('aria-pressed', on);
  b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
}
function likeClick(id, btn) {
  const t = lib.tracks.get(id); if (!t) return;
  const on = !(t.liked && !t.transient);
  if (btn) setHeart(btn, on);
  store.setLiked(id, on).catch(e => toast(e.message, 'err'));
  if (on) toast('Added to Liked Songs');
  else toastUndo('Removed from Liked Songs', () => store.setLiked(id, true));
}
function markUnliked() {
  for (const id of likeTimers.keys()) $$(`[data-tsec="liked"] .row[data-id="${CSS.escape(id)}"]`).forEach(r => r.classList.add('unliked'));
}
function onLikeChanged({ id, liked }) {
  const sel = CSS.escape(id);
  $$(`.like[data-id="${sel}"]`).forEach(b => { if (b.classList.contains('on') !== liked) setHeart(b, liked); });
  if (player.current()?.id === id) $$('#playerbar .like, #np .np-info .like').forEach(b => { if (b.classList.contains('on') !== liked) setHeart(b, liked); });
  const sec = sections.get('liked');
  if (sec) {
    clearTimeout(likeTimers.get(id)); likeTimers.delete(id);
    $$(`[data-tsec="liked"] .row[data-id="${sel}"]`).forEach(r => r.classList.toggle('unliked', !liked));
    if (!liked) likeTimers.set(id, setTimeout(() => {
      likeTimers.delete(id);
      if (lib.tracks.get(id)?.liked || sections.get('liked') !== sec) return;
      $$(`[data-tsec="liked"] .row[data-id="${sel}"]`).forEach(r => r.classList.add('leaving'));
      setTimeout(() => { if (sections.get('liked') !== sec) return; sec.tracks = sec.tracks.filter(t => t.id !== id); refreshSection('liked'); markUnliked(); likedCount(); }, 280);
    }, LIKE_GRACE));
    else if (!sec.tracks.some(t => t.id === id) && lib.tracks.get(id)) { sec.tracks = [lib.tracks.get(id), ...sec.tracks]; refreshSection('liked'); markUnliked(); }
  }
  likedCount();
}
function likedCount() {
  const n = store.saved().filter(t => t.liked).length;
  const el = $('.tab[data-tab="liked"] small'); if (el) el.textContent = n;
}

// ================= GLOBAL EVENTS =================
function pickFile(accept, cb, { multiple = false, dir = false } = {}) {
  const i = document.createElement('input');
  i.type = 'file'; i.accept = accept; i.multiple = multiple;
  if (dir) i.webkitdirectory = true;
  i.onchange = () => { const fs = [...i.files]; if (fs.length) cb(multiple || dir ? fs : fs[0]); };
  i.click();
}

function idsForPlayAct(el) {
  const key = el.dataset.id;
  if (lists.has(key)) return lists.get(key);
  return [];
}

function wireGlobal() {
  document.addEventListener('click', async e => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const act = a.dataset.act, id = a.dataset.id;
    switch (act) {
      case 'play-row': {
        if (e.target.closest('a')) return; // artist/album links
        if (a.dataset.list === 'pl') notePlaylistPlay(location.hash.split('/')[2]);
        const ids = lists.get(a.dataset.list) || [a.dataset.id];
        const i = +a.dataset.i;
        if (player.current()?.id === a.dataset.id && nowCtx.list === a.dataset.list && nowCtx.i === i) { player.toggle(); return; }
        nowCtx = { list: a.dataset.list, i, id: a.dataset.id };
        player.playList(ids, Math.min(i, ids.length - 1), { shuffle: false });
        break;
      }
      case 'like': e.stopPropagation(); likeClick(id, a); break;
      case 'track-menu': e.stopPropagation(); trackMenu(a, id, a.dataset.pl); break;
      case 'goto-album': e.preventDefault(); e.stopPropagation(); gotoAlbum(lib.tracks.get(id)); break;
      case 'play-list': {
        const ids = lists.get(id) || [];
        if (a.dataset.queue) player.addToQueue(ids);
        else if (a.dataset.shuffle) { nowCtx = { list: null }; player.playList(ids, a.dataset.shuffle ? Math.floor(Math.random() * ids.length) : 0, { shuffle: !!a.dataset.shuffle }); }
        else { nowCtx = { list: id, i: 0, id: ids[0] }; player.playList(ids, 0, { shuffle: false }); }
        if (id === 'pl') notePlaylistPlay(location.hash.split('/')[2]);
        break;
      }
      case 'play-playlist': e.preventDefault(); e.stopPropagation(); notePlaylistPlay(id); player.playList(lib.playlists.get(id)?.trackIds || [], 0, { shuffle: false }); break;
      case 'play-album': {
        e.preventDefault(); e.stopPropagation();
        const al = lib.albums.get(id) || store.implicitAlbums().find(x => x.id === id);
        player.playList(al?.trackIds || [], 0, { shuffle: false }); break;
      }
      case 'play-artist': {
        e.preventDefault(); e.stopPropagation();
        const n = norm(a.dataset.name);
        player.playList(store.saved().filter(t => (t.artists?.length ? t.artists : [t.artist]).some(x => norm(x) === n) || norm(mainArtist(t.artist)) === n).map(t => t.id), 0, { shuffle: true }); break;
      }
      case 'toggle-filters': { const key = a.closest('[data-tsec]').dataset.tsec; fstate[key].open = !fstate[key].open; if (fstate[key].open) fstate[key].sortOpen = false; refreshSection(key); break; }
      case 'toggle-sort': { const key = a.closest('[data-tsec]').dataset.tsec; fstate[key].sortOpen = !fstate[key].sortOpen; if (fstate[key].sortOpen) fstate[key].open = false; refreshSection(key); break; }
      case 'f-sort': { const key = a.closest('[data-tsec]').dataset.tsec; fstate[key].sort = a.dataset.v; fstate[key].sortOpen = false; refreshSection(key); break; }
      case 'f-genre': { const key = a.closest('[data-tsec]').dataset.tsec; const f = fstate[key]; const g = a.dataset.g; f.genres = f.genres?.includes(g) ? f.genres.filter(x => x !== g) : [...(f.genres || []), g]; refreshSection(key); break; }
      case 'f-year': { const key = a.closest('[data-tsec]').dataset.tsec; const f = fstate[key]; const y = +a.dataset.y; f.years = f.years?.includes(y) ? f.years.filter(x => x !== y) : [...(f.years || []), y]; refreshSection(key); break; }
      case 'f-flag': { const key = a.closest('[data-tsec]').dataset.tsec; fstate[key][a.dataset.k] = !fstate[key][a.dataset.k]; refreshSection(key); break; }
      case 'f-clear': { const key = a.closest('[data-tsec]').dataset.tsec; Object.assign(fstate[key], { genres: [], years: [], liked: false, offline: false, q: '' }); refreshSection(key); break; }
      case 'new-playlist': { const n = await promptText('New playlist', '', 'Name', 'Create'); if (n) { const p = await store.createPlaylist(n); renderSidebarPlaylists(); location.hash = '#/playlist/' + p.id; } break; }
      case 'playlist-menu': playlistMenu(a, id); break;
      case 'share-playlist': { const p = lib.playlists.get(id); shareTracks('playlist', p.name, p.trackIds.map(x => lib.tracks.get(x)).filter(Boolean), plCover(p)); break; }
      case 'share-album': { const { album, tracks } = window.__album; shareTracks('album', `${album.title} — ${album.artist}`, tracks, album.artwork); break; }
      case 'save-album': { const { album, tracks } = window.__album; await store.saveAlbum(album, tracks.map(stripTransient)); toast(`Album saved to your library`); break; }
      case 'unsave-album': if (await confirmBox('Remove album?', 'The album will be removed from your library. Liked songs and songs in playlists stay.', 'Remove', true)) { await store.removeAlbum(id); toast('Album removed'); } break;
      case 'album-offline': { const { tracks } = window.__album; pickFile('audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav', fs => addLocalFiles(fs, { albumHint: tracks }), { multiple: true }); break; }
      case 'save-shared': {
        const { d, tracks } = window.__shared;
        const saved = await store.upsertTracks(tracks.map(stripTransient));
        if (d.k === 'song') { await store.updateTrack(saved[0].id, { liked: true }); toast('Added to Liked Songs'); }
        else { const p = await store.createPlaylist(d.n, saved.map(t => t.id), { source: 'shared by ' + (d.by || 'friend'), image: d.a || '' }); renderSidebarPlaylists(); location.hash = '#/playlist/' + p.id; }
        break;
      }
      case 'match-list': matchList(lists.get(a.dataset.list) || []); break;
      case 'yt-export': ytExport(lists.get(a.dataset.list) || [], a.dataset.name, a.dataset.job); break;
      case 'yt-signin': try { await ya.signIn({ prompt: 'select_account' }); toast('YouTube connected ✓', 'ok'); rerender(); } catch (err) { toast(err.message, 'err'); } break;
      case 'yt-signout': await ya.signOut(); toast('Disconnected from YouTube'); rerender(); break;
      case 'yt-import-mine': ytImportMine(); break;
      case 'yt-resume': resumeUpload(a.dataset.job); break;
      case 'yt-drop': await ya.dropJob(a.dataset.job); rerender(); break;
      case 'support': e.preventDefault(); phase2Popup(); break;
      case 'phase2': e.preventDefault(); phase2Popup(); break;
      case 'exportify': openExportify(); break;
      case 'sp-liked': spImportLiked(); break;
      case 'sp-playlists': spChoosePlaylists(); break;
      case 'sp-disconnect': await sp.disconnect(); route(); break;
      case 'add-files': pickFile('audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav', fs => addLocalFiles(fs), { multiple: true }); break;
      case 'add-folder': pickFile('', fs => addLocalFiles(fs), { dir: true }); break;
      case 'go-back': goBack(); break;
      case 'voice': e.preventDefault(); openVoice(); break;
      case 'bz-mix': e.preventDefault(); bazingaMix(); break;
      case 'play-it-album': {
        e.preventDefault(); e.stopPropagation();
        try { const { tracks } = await meta.albumTracks(id); player.playList(tracks.map(t => (lib.tracks.get(t.id) || store.remember(t)).id), 0, { shuffle: false }); }
        catch { toast('Couldn\'t load that album right now', 'err'); }
        break;
      }
      case 'copy': copyText(a.dataset.v).then(ok => {
        toast(ok ? 'Link copied ✓' : 'Couldn\'t copy — select the link and copy it', ok ? 'ok' : 'err');
        if (ok && a.classList.contains('big')) { a.innerHTML = `${icon('check')}Copied!`; setTimeout(() => { if (a.isConnected) a.innerHTML = `${icon('link')}Copy link`; }, 2000); }
      }); break;
      case 'az': {
        e.preventDefault();
        // The letters always work alphabetically: switch the list to A–Z, then jump
        if (artistUI.sort !== 'az' || artistUI.q) { artistUI.sort = 'az'; artistUI.q = ''; const qi = $('#art-q'); if (qi) qi.value = ''; }
        { // make sure that letter is loaded (lists show 100 at a time)
          const sorted = store.artists().sort((x, y) => x.name.localeCompare(y.name));
          const idx = sorted.findIndex(x => letterOf(x.name) === a.dataset.l);
          artistUI.limit = Math.max(PAGE_N, idx + PAGE_N);
          redrawArtists();
        }
        $$('.az a').forEach(x => x.classList.toggle('on', x === a));
        $(`#artist-list [data-letter="${a.dataset.l}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }
      case 'retry-route': route(); break;
      case 'filter-go': { const i = a.closest('.fsearch')?.querySelector('input'); if (i) { if (!i.value) i.focus(); else { i.blur(); const key = a.closest('[data-tsec]')?.dataset.tsec; if (key) { fstate[key].q = i.value; refreshSection(key); } } } break; }
      case 'a2hs': maybeInstallPrompt(true); break;
      case 'art-more': artistUI.limit += PAGE_N; redrawArtists(); break;
      case 'show-more': showMore(a.dataset.pg); break;
      case 'art-sort': artistUI.sort = a.dataset.v; artistUI.limit = PAGE_N; redrawArtists(); $$('.az a').forEach(x => x.classList.remove('on')); break;
      case 'yt-backup': ytBackupPicker(); break;
      case 'yt-more': {
        const wide = innerWidth > 700; // on computers the YouTube buttons are already on the page
        const k = await menu(a, [a.dataset.offline ? { k: 'offline', label: a.dataset.offline, icon: 'offline' } : null, wide ? null : { k: 'match', label: 'Find YouTube matches', icon: 'yt' }, wide ? null : { k: 'save', label: 'Save to YouTube', icon: 'upload' }]);
        if (k === 'offline') { const { tracks } = window.__album; pickFile('audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav', fs => addLocalFiles(fs, { albumHint: tracks }), { multiple: true }); }
        if (k === 'match') matchList(lists.get(a.dataset.list) || []);
        if (k === 'save') ytExport(lists.get(a.dataset.list) || [], a.dataset.name, a.dataset.job);
        break;
      }
      case 'rename-user': { const n = await promptText('Change your name', profile.username, 'Name'); if (n) { profile.username = n; await profileChanged(); rerender(); } break; }
      case 'remove-pic': profile.picture = ''; await profileChanged(); rerender(); break;
      case 'lock': setLocked(true); break;
      case 'link-device': linkDeviceDialog(); break;
      case 'enter-code': { const req = await enterCodeDialog(); if (req) joinFlow(req); break; }
      case 'sync-leave': syncMenu('leave'); break;
      case 'sync-forget': syncMenu('forget'); break;
      case 'sync-now': withSyncProgress('Syncing your music', () => sync.syncNow({ interactive: true })).then(() => { const S = sync.state(); toast(S.cancelled ? 'Sync cancelled' : S.status === 'synced' ? 'Synced ✓' : S.error || 'Sync failed', S.cancelled ? 'info' : S.status === 'synced' ? 'ok' : 'err'); }); break;
      case 'bk-link': try { await backup.linkFile(); rerender(); } catch (err) { if (err.name !== 'AbortError') toast(err.message, 'err'); } break;
      case 'bk-regrant': await backup.regrant(); rerender(); renderBackupNag(); break;
      case 'bk-unlink': await backup.unlinkFile(); rerender(); break;
      case 'bk-download': await backup.download(); toast('Backup downloaded ✓'); renderBackupNag(); break;
      case 'bk-restore-file': pickFile('.json,application/json', async f => {
        if (!await confirmBox('Restore this backup?', 'Your current library will be replaced with the one in the backup file.', 'Restore')) return;
        try { await backup.restoreFromFile(f); toast('Restored ✓'); setTimeout(() => location.reload(), 600); } catch (err) { toast(err.message, 'err'); }
      }); break;
      case 'bk-restore-snap': if (await confirmBox('Restore snapshot?', 'Your current library will be replaced with this snapshot.', 'Restore')) { await backup.restoreInternal(id); location.reload(); } break;
      case 'clear-ytcache': if (await confirmBox('Forget YouTube matches?', 'Songs will be searched again next time they play.', 'Forget', true)) { await db.clear('ytcache'); yt.forget(); toast('Done'); } break;
      case 'delete-account': deleteAccount(); break;
      case 'bk-nag-dl': await backup.download(); renderBackupNag(); break;
      case 'bk-nag-x': await kv.set('lastDownload', Date.now()); renderBackupNag(); break;
    }
  });
  // Faster song switching: look a song up as soon as you rest on it / touch it
  let hoverT = null;
  document.addEventListener('pointerover', e => {
    const r = e.target.closest?.('.row[data-id], .qrow [data-qjump]'); if (!r) return;
    clearTimeout(hoverT);
    const id = r.dataset.id || P.queue[+r.dataset.qjump]?.id;
    if (id) hoverT = setTimeout(() => player.prefetch(id), e.pointerType === 'mouse' ? 220 : 0);
  }, { passive: true });
  document.addEventListener('pointerout', e => { if (e.target.closest?.('.row')) clearTimeout(hoverT); }, { passive: true });
  // Keyboard: Enter on a row plays it; space toggles playback
  document.addEventListener('keydown', e => {
    if (e.target.matches('input,textarea,select')) return;
    if (e.key === 'Enter' && e.target.matches('.row')) e.target.click();
    if (e.code === 'Space' && !e.target.matches('button,a,.row')) { e.preventDefault(); player.toggle(); }
  });
  // Filter inputs
  document.addEventListener('input', e => {
    const f = e.target.dataset.f; if (!f) return;
    const key = e.target.closest('[data-tsec]')?.dataset.tsec; if (!key) return;
    fstate[key][f] = e.target.value;
    if (f === 'q' || f === 'from' || f === 'to') debouncedRefresh(key);
    else refreshSection(key);
  });
  document.addEventListener('change', e => {
    if (e.target.dataset.f === 'sort') { const key = e.target.closest('[data-tsec]').dataset.tsec; fstate[key].sort = e.target.value; refreshSection(key); }
  });
  // Drag & drop CSV/audio anywhere
  document.addEventListener('dragover', e => { if (profile) e.preventDefault(); });
  document.addEventListener('drop', e => {
    if (!profile) return; e.preventDefault();
    const fs = [...e.dataTransfer.files];
    const csv = fs.filter(f => /\.(csv|zip)$/i.test(f.name)), aud = fs.filter(f => imp.AUDIO_EXT.test(f.name));
    const apple = fs.filter(f => /\.(xml|txt)$/i.test(f.name));
    if (csv.length) importCSVFiles(csv);
    if (apple.length) importAppleFiles(apple);
    if (aud.length) addLocalFiles(aud);
  });

  on('library', () => { renderSidebarPlaylists(); if (!document.querySelector('.modal-wrap') && !isTyping()) softRefresh(); });
  on('player', renderPlayer);
  on('like', onLikeChanged);
  on('needs-tap', () => { openNP(); requestAnimationFrame(placeDock); });
  on('track-art', ({ id, artwork }) => {
    $$(`.row[data-id="${CSS.escape(id)}"] .row-num .cover`).forEach(c => { c.outerHTML = cover(artwork, lib.tracks.get(id)?.title, 'sm'); });
    markNow();
    if (player.current()?.id === id) { renderPlayer(); if (document.body.classList.contains('np-open')) renderNP(true); }
  });
  on('time', renderTime);
  on('video-visible', v => document.body.classList.toggle('has-video', v));
  on('backup-state', renderBackupNag);
  window.addEventListener('online', () => document.body.classList.remove('is-offline'));
  window.addEventListener('offline', () => document.body.classList.add('is-offline'));
  if (!navigator.onLine) document.body.classList.add('is-offline');
  // Re-place the video on any size change (window, phone rotation, browser bars)
  const schedulePlace = () => requestAnimationFrame(() => requestAnimationFrame(placeDock));
  window.addEventListener('resize', schedulePlace);
  window.visualViewport?.addEventListener('resize', schedulePlace);
  if ('ResizeObserver' in window) new ResizeObserver(schedulePlace).observe($('#np'));
  // Yellow fill on every slider as it moves
  document.addEventListener('input', e => { const r = e.target; if (r.type === 'range') r.style.setProperty('--p', (100 * (r.value - (r.min || 0)) / ((r.max || 100) - (r.min || 0))).toFixed(2) + '%'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.classList.contains('np-open') && !$('.modal-wrap')) closeNP(); });
  wirePlayerUI();
}
const debouncedRefresh = debounce(k => refreshSection(k, true), 200);
const isTyping = () => document.activeElement?.matches('input,textarea');
// Lighter refresh: only re-render sections in place when possible
function softRefresh() {
  const h = location.hash;
  if (/^#\/(search|import|settings|s\/)/.test(h)) return;
  rerender();
}

async function deleteAccount() {
  const ok = await modal(`<h3>Erase this device?</h3>
    <p class="muted">This permanently erases everything BAZINGA! saved in this browser: library, playlists, albums, offline files and on-device backups.${sync.linked() ? ' Your other synced devices keep their music.' : ''} This can't be undone.</p>
    <form><label class="fld"><span>Type ERASE to confirm</span><input name="u" required autocomplete="off" autocapitalize="characters"></label>
    <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn danger">Erase everything</button></div></form>`);
  if (!ok) return;
  if (ok.u.trim().toUpperCase() !== 'ERASE') return toast('Nothing was erased — type ERASE to confirm', 'err');
  await sync.leave();
  await wipeDevice();
}

// ================= SIDEBAR / PROFILE =================
function renderProfileChip() {
  const S = sync.state();
  const dot = sync.linked() ? `<i class="sync-dot ${S.status}" title="${S.status === 'synced' ? 'Synced' : S.status === 'syncing' ? 'Syncing…' : S.status === 'error' ? 'Sync problem' : 'Synced device'}"></i>` : '';
  const html = `<div class="avatar">${profile.picture ? `<img src="${esc(profile.picture)}" alt="" referrerpolicy="no-referrer">` : esc(profile.username[0].toUpperCase())}${dot}</div><span>${esc(profile.username)}</span>`;
  $$('.profile-chip').forEach(el => el.innerHTML = html);
}
function renderSidebarPlaylists() {
  const el = $('#side-pl'); if (!el) return;
  const pls = [...lib.playlists.values()].sort((a, b) => a.name.localeCompare(b.name));
  el.innerHTML = `<a href="#/library/liked" class="spl">${likedCover('sm')}<span>Liked Songs</span></a>` +
    pls.map(p => `<a href="#/playlist/${p.id}" class="spl">${cover(plCover(p), p.name, 'sm')}<span>${esc(p.name)}</span></a>`).join('');
}
async function renderBackupNag() {
  const el = $('#nag'); if (!el || !profile) return;
  const st = backup.linkedFileState();
  const lastD = await kv.get('lastDownload');
  const n = store.saved().length;
  if (st === 'needs-permission') el.innerHTML = `<div class="nag">${icon('restore')}<span>Auto-backup to your file is paused.</span><button class="btn sm primary" data-act="bk-regrant">Resume</button></div>`;
  else if (!backup.fsSupported && n > 20 && (!lastD || Date.now() - lastD > 7 * 864e5)) el.innerHTML = `<div class="nag">${icon('restore')}<span>Keep your library safe — save a backup file to this device.</span><button class="btn sm primary" data-act="bk-nag-dl">Save backup</button><button class="ib sm nag-x" data-act="bk-nag-x" aria-label="Dismiss">${icon('close')}</button></div>`;
  else el.innerHTML = '';
}

// ================= PLAYER UI =================
function wirePlayerUI() {
  const bar = $('#playerbar'), np = $('#np');
  const handle = e => {
    const b = e.target.closest('[data-p]'); if (!b) return;
    const k = b.dataset.p;
    if (k === 'toggle') player.toggle();
    if (k === 'next') player.next();
    if (k === 'prev') player.prev();
    if (k === 'shuffle') player.setShuffle(!P.shuffle);
    if (k === 'repeat') player.cycleRepeat();
    if (k === 'mode') player.setMode(b.dataset.m);
    if (k === 'like') { const t = player.current(); if (t) likeClick(t.id, b); }
    if (k === 'queue') toggleQueue();
    if (k === 'npq') toggleNPQueue();
    if (k === 'lyrics') setLyrics(!document.body.classList.contains('np-lyr'));
    if (k === 'dock-min') { document.body.classList.toggle('dock-min'); dockMinLabel(); try { localStorage.setItem('bz_dock_min', document.body.classList.contains('dock-min') ? '1' : ''); } catch { } placeDock(); }
    if (k === 'open') openNP();
    if (k === 'close') closeNP();
    if (k === 'more') { const t = player.current(); if (t) trackMenu(b, t.id); }
    if (k === 'sleep') sleepMenu(b);
    if (k === 'mute') player.setVolume(P.volume > 0 ? 0 : 0.8);
    if (k === 'artist') { const t = player.current(); if (t) { closeNP('nav'); location.hash = '#/artist/' + encodeURIComponent(mainArtist(t.artist)); } }
    if (k === 'album') { const t = player.current(); if (t) { closeNP('nav'); gotoAlbum(t); } }
    if (k === 'dock-size') { document.body.classList.toggle('dock-big'); dockSizeLabel(); try { localStorage.setItem('bz_dock_big', document.body.classList.contains('dock-big') ? '1' : ''); } catch { } placeDock(); }
  };
  const head = $('#np-head');
  bar.addEventListener('click', handle); np.addEventListener('click', handle); head.addEventListener('click', handle);
  $('#yt-dock').addEventListener('click', handle);
  for (const r of $$('.seek')) wireSeek(r);
  $$('.vol').forEach(v => v.addEventListener('input', () => player.setVolume(+v.value)));
  wireSwipeClose();
  let headDark = false;
  window.addEventListener('scroll', () => { const d = scrollY > 8; if (d !== headDark) { headDark = d; head.classList.toggle('scrolled', d); } }, { passive: true });
  try { history.scrollRestoration = 'manual'; } catch { }
  try { if (localStorage.getItem('bz_dock_big')) document.body.classList.add('dock-big'); } catch { }
  dockSizeLabel();
  try { if (localStorage.getItem('bz_dock_min')) document.body.classList.add('dock-min'); if (localStorage.getItem('bz_npq') !== '0') document.body.classList.add('np-q'); if (localStorage.getItem('bz_lyr')) document.body.classList.add('np-lyr'); } catch { }
  dockMinLabel();
  // Buttons outside the player (e.g. "Jump back in" on Home)
  document.addEventListener('click', e => { const l = e.target.closest('[data-artist-search]'); if (l) { lastSearch.q = l.dataset.artistSearch; } });
  // About to open an artist? Start fetching their photo now, so it's there when the page opens
  const warmArtist = e => {
    const l = e.target.closest?.('a[href^="#/artist/"]'); if (!l) return;
    let name = ''; try { name = decodeURIComponent(l.getAttribute('href').slice(9)); } catch { return; }
    if (name && !meta.artistPictureNow(name)) meta.artistPicture(name, true).then(pic => { if (pic) { const i = new Image(); i.src = sized(pic, 600); } });
  };
  document.addEventListener('pointerover', warmArtist, { passive: true });
  document.addEventListener('touchstart', warmArtist, { passive: true });
  document.addEventListener('click', e => { const b = e.target.closest('[data-p-ext]'); if (!b) return; if (b.dataset.pExt === 'toggle') player.toggle(); if (b.dataset.pExt === 'open') openNP(); });
}
// Pull down to close the full-screen player (phones/tablets).
// Works from anywhere in the player while it's scrolled to the top: the top bar, the cover, the
// song info, the controls, and the upper part of the video (a touch strip over it, since the video
// frame itself swallows touches; tapping that strip plays/pauses like tapping the video).
// The player follows your finger; let go far enough (or flick) and it closes, otherwise it springs back.
// Sliders, the queue list (when scrolled), lyrics and text boxes keep their own gestures.
function wireSwipeClose() {
  const body = document.body;
  const dock = $('#yt-dock');
  if (!dock.querySelector('.np-grab')) dock.insertAdjacentHTML('beforeend', '<div class="np-grab" aria-hidden="true"></div>');
  let g = null;
  const setPull = y => body.style.setProperty('--np-pull', Math.max(0, y) + 'px');
  const skip = t => t.closest('.seek, .vol, input, textarea, select, .np-lyrics, .menu, .modal-wrap, .grip, .qrow')
    || (t.closest('.np-q-body') && t.closest('.np-q-body').scrollTop > 0)
    || (t.closest('#yt-dock') && !t.closest('.np-grab'));
  const atTop = () => (window.scrollY || document.documentElement.scrollTop || 0) <= 1;
  const start = e => {
    g = null;
    if (!body.classList.contains('np-open') || e.touches.length !== 1 || skip(e.target) || !atTop()) return;
    const t = e.touches[0];
    g = { x: t.clientX, y: t.clientY, t: Date.now(), dy: 0, on: false, grab: !!e.target.closest('.np-grab') };
  };
  const move = e => {
    if (!g) return;
    const t = e.touches[0], dx = t.clientX - g.x, dy = t.clientY - g.y;
    if (!g.on) {
      if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || !atTop()) { g = null; return; } // scrolling up / sideways: not ours
      g.on = true; body.classList.add('np-pulling'); body.classList.remove('np-springing');
    }
    if (e.cancelable) e.preventDefault(); // no page bounce / pull-to-refresh while pulling
    g.dy = dy; setPull(dy < 140 ? dy : 140 + (dy - 140) * 0.7);
  };
  const end = () => {
    if (!g) return;
    const was = g; g = null;
    if (!was.on) {
      if (was.grab) player.toggle(); // a plain tap on the video strip = tap on the video
      return;
    }
    const v = was.dy / Math.max(1, Date.now() - was.t); // px per ms
    body.classList.remove('np-pulling'); body.classList.add('np-springing');
    if (was.dy > 120 || (was.dy > 45 && v > 0.55)) {
      setPull(innerHeight);
      setTimeout(() => { closeNP(); body.classList.remove('np-springing'); setPull(0); }, 220);
    } else {
      setPull(0);
      setTimeout(() => body.classList.remove('np-springing'), 260);
    }
  };
  for (const el of [$('#np'), $('#np-head'), dock]) {
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end, { passive: true });
    el.addEventListener('touchcancel', () => { if (g?.on) { g.dy = 0; end(); } g = null; }, { passive: true });
  }
}
// The yellow progress bar pauses its updates only while a finger/mouse is actually dragging it.
// Before, a drag that never "finished" (the page scrolled instead, the bar was redrawn when the next
// song started, or the browser cancelled the touch) left it frozen while the music kept playing.
let seeking = null; // the slider being dragged, or null
let seekIdle = null;
function endSeek(r, commit) {
  if (seeking !== r) return;
  clearTimeout(seekIdle);
  seeking = null;
  if (commit && P.duration) player.seek(r.value * P.duration / 1000);
  renderTime();
}
function wireSeek(r) {
  if (!r || r._wired) return; r._wired = true;
  r.addEventListener('input', () => {
    seeking = r;
    const t = fmtTime(r.value * P.duration / 1000);
    (r.closest('.pb-seek, .np-seek')?.querySelectorAll('.t-now') || []).forEach(x => x.textContent = t);
    clearTimeout(seekIdle); seekIdle = setTimeout(() => endSeek(r, true), 1500); // safety net
  });
  r.addEventListener('change', () => endSeek(r, true));
  ['pointercancel', 'touchcancel', 'blur'].forEach(ev => r.addEventListener(ev, () => endSeek(r, false)));
  ['pointerup', 'touchend'].forEach(ev => r.addEventListener(ev, () => setTimeout(() => endSeek(r, true), 0)));
}
// Full-screen player. Opening it adds a history step, so the phone's Back button/gesture closes it
// instead of leaving the page. Any navigation closes it properly (the video goes back to its corner).
function openNP() {
  if (!player.current()) return;
  const was = document.body.classList.contains('np-open');
  if (!was) window.scrollTo(0, 0);
  document.body.classList.add('np-open'); renderNP(true); requestAnimationFrame(placeDock); setTimeout(placeDock, 320);
  if (!was && !history.state?.bzNP) { try { history.pushState({ bzNP: 1 }, ''); } catch { } }
  saveSpotSoon();
}
function closeNP(how = 'ui') {
  const was = document.body.classList.contains('np-open');
  document.body.classList.remove('np-open'); if (was) window.scrollTo(0, 0); placeDock(); saveSpotSoon();
  if (!was || how === 'pop' || !history.state?.bzNP) return;
  if (how === 'ui') history.back(); else { try { history.replaceState(null, ''); } catch { } }
}
window.addEventListener('popstate', e => { if (document.body.classList.contains('np-open') && !e.state?.bzNP) closeNP('pop'); });
function toggleQueue() {
  if (innerWidth < 1000) { location.hash = '#/queue'; return; }
  document.body.classList.toggle('queue-open');
  if (document.body.classList.contains('queue-open')) renderQueue($('#queue-panel .qp-body'));
  placeDock();
}
function dockMinLabel() {
  const b = $('[data-p="dock-min"]'); if (!b) return;
  const min = document.body.classList.contains('dock-min');
  b.setAttribute('aria-label', min ? 'Show video' : 'Minimize video'); b.title = min ? 'Show video' : 'Minimize';
}
// The resize arrow points up while the video is small (make it bigger) and down while it's big
function dockSizeLabel() {
  const b = $('[data-p="dock-size"]'); if (!b) return;
  const big = document.body.classList.contains('dock-big');
  b.setAttribute('aria-label', big ? 'Smaller video' : 'Bigger video'); b.title = big ? 'Smaller' : 'Bigger';
}
// ---------- Sleep timer (full-screen player, next to ⋯) ----------
// Pick a time and the music fades out gently and pauses, or stop at the end of the current song.
let sleepAt = 0, sleepT = null, sleepTick = null;
const sleepLeft = () => sleepAt ? Math.max(0, sleepAt - Date.now()) : 0;
const fmtLeft = ms => { const m = Math.ceil(ms / 60e3); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + ' min' : ''}`.trim() : `${m} min`; };
function sleepBtn() {
  const b = $('#np-head .sleep-np'); if (!b) return;
  const on = !!sleepAt || player.stopsAfterSong();
  b.classList.toggle('on', on);
  const label = sleepAt ? `Sleep timer: ${fmtLeft(sleepLeft())} left` : player.stopsAfterSong() ? 'Sleep timer: stops after this song' : 'Sleep timer';
  b.setAttribute('aria-label', label); b.title = label;
}
function clearSleep(quiet) {
  clearTimeout(sleepT); clearInterval(sleepTick); sleepAt = 0; player.setStopAfterSong(false); player.cancelFade(); sleepBtn();
  if (!quiet) toast('Sleep timer off');
}
function setSleep(min) {
  clearSleep(true);
  if (min === 'song') { player.setStopAfterSong(true); sleepBtn(); toast('Music stops after this song 🌙', 'ok'); return; }
  sleepAt = Date.now() + min * 60e3;
  // fade over the last 8 seconds, then pause
  sleepT = setTimeout(() => player.fadeOutAndPause(8000), Math.max(0, min * 60e3 - 8000));
  sleepTick = setInterval(sleepBtn, 30e3);
  sleepBtn();
  toast(`Sleep timer: music stops in ${fmtLeft(min * 60e3)} 🌙`, 'ok');
}
async function sleepMenu(btn) {
  const active = sleepAt ? `${fmtLeft(sleepLeft())} left` : player.stopsAfterSong() ? 'Stops after this song' : '';
  const k = await menu(btn, [
    { header: `${icon('moon')} Sleep timer${active ? ` · <b>${active}</b>` : ''}` },
    ...[5, 10, 15, 30, 45, 60, 90].map(m => ({ k: String(m), label: m >= 60 ? `${m / 60 === 1 ? '1 hour' : m / 60 + ' hours'}` : `${m} minutes`, icon: 'timer' })),
    { k: 'song', label: 'End of this song', icon: 'disc' },
    (sleepAt || player.stopsAfterSong()) ? '-' : null,
    (sleepAt || player.stopsAfterSong()) ? { k: 'off', label: 'Turn off sleep timer', icon: 'close', danger: true } : null
  ]);
  if (!k) return;
  if (k === 'off') clearSleep();
  else setSleep(k === 'song' ? 'song' : +k);
}
on('sleep-done', () => { clearTimeout(sleepT); clearInterval(sleepTick); sleepAt = 0; sleepBtn(); toast('Sleep timer: music paused. Good night 🌙'); });
function toggleNPQueue() {
  const on = !document.body.classList.contains('np-q');
  document.body.classList.toggle('np-q', on);
  try { localStorage.setItem('bz_npq', on ? '1' : '0'); } catch { }
  renderNP();
  if (on && npNarrow.matches) setTimeout(() => npScrollTo($('#np .np-queue')), 60);
}
function closeQueueOnMobile() { if (innerWidth < 1000) document.body.classList.remove('queue-open'); }

let lastPlayedId = null;
function renderPlayer() {
  const t = player.current();
  if (t && P.playing && t.id !== lastPlayedId) { lastPlayedId = t.id; kv.get('plays').then(n => kv.set('plays', (n || 0) + 1)); }
  document.body.classList.toggle('has-track', !!t);
  // Subtle loading veil over the video / cover while a song is starting
  document.body.classList.toggle('song-loading', !!t && !!P.loading && !P.error);
  document.body.classList.toggle('needs-tap', !!P.needsTap);
  const dl = $('#yt-dock .dl-art');
  if (dl && t && dl.dataset.src !== (t.artwork || '')) { dl.dataset.src = t.artwork || ''; dl.style.backgroundImage = t.artwork ? `url("${sized(t.artwork, 300).replace(/"/g, '%22')}")` : ''; }
  const bar = $('#playerbar');
  if (!t) { bar.innerHTML = ''; bar.dataset.key = ''; return; }
  // Play/pause/buffering only touch the play button — the rest of the bar is left alone (instant, no flicker)
  const key = [t.id, t.artwork, displayTitle(t), t.artist, t.liked && !t.transient, P.error, P.mode, P.source, P.shuffle, P.repeat, document.body.classList.contains('queue-open'), P.volume > 0].join('|');
  if (bar.dataset.key === key && bar.firstElementChild) { patchPlayButtons(); playerTail(t); return; }
  bar.dataset.key = key;
  const modeBtns = `<div class="seg" role="group" aria-label="Playback version">
    <button data-p="mode" data-m="video" class="${P.mode === 'video' ? 'on' : ''}" title="Music video">${icon('video')}<span>Video</span></button>
    <button data-p="mode" data-m="audio" class="${P.mode === 'audio' ? 'on' : ''}" title="Audio only">${icon('audio')}<span>Audio</span></button></div>`;
  bar.innerHTML = `<div class="pb-progress"><i></i></div>
    <div class="pb-left" data-p="open">
      ${cover(t.artwork, t.title, 'pb-art')}
      <div class="pb-meta"><div class="pb-title">${esc(displayTitle(t))}</div><div class="pb-artist">${P.error ? `<span class="err-text">${esc(P.error)}</span>` : esc(t.artist)}</div></div>
      <button class="ib like ${t.liked && !t.transient ? 'on' : ''}" data-p="like" aria-label="Like">${icon(t.liked && !t.transient ? 'heartFill' : 'heart')}</button>
    </div>
    <div class="pb-center">
      <div class="pb-ctrls">
        <button class="ib hide-sm ${P.shuffle ? 'on' : ''}" data-p="shuffle" aria-label="Shuffle">${icon('shuffle')}</button>
        <button class="ib pb-prev" data-p="prev" aria-label="Previous">${icon('prev')}</button>
        <button class="play-btn ${P.loading ? 'busy' : ''}" data-p="toggle" data-on="${player.isOn() ? 1 : 0}" aria-label="${player.isOn() ? 'Pause' : 'Play'}">${icon(player.isOn() ? 'pause' : 'play')}</button>
        <button class="ib" data-p="next" aria-label="Next">${icon('next')}</button>
        <button class="ib hide-sm ${P.repeat !== 'off' ? 'on' : ''}" data-p="repeat" aria-label="Repeat">${icon('repeat')}${P.repeat === 'one' ? '<b class="r1">1</b>' : ''}</button>
      </div>
      <div class="pb-seek hide-sm"><span class="t-now">${fmtTime(P.time)}</span><input type="range" class="seek" min="0" max="1000" value="0" aria-label="Seek"><span class="t-dur">${fmtTime(P.duration)}</span></div>
    </div>
    <div class="pb-right hide-sm">
      ${P.source === 'local' ? `<span class="badge">${icon('offline')}Offline file</span>` : modeBtns}
      <button class="ib ${document.body.classList.contains('queue-open') ? 'on' : ''}" data-p="queue" aria-label="Queue">${icon('queue')}</button>
      <button class="ib" data-p="mute" aria-label="Mute">${icon(P.volume > 0 ? 'volume' : 'mute')}</button>
      <input type="range" class="vol" min="0" max="1" step="0.01" value="${P.volume}" aria-label="Volume">
    </div>`;
  const s = bar.querySelector('.seek');
  if (s) wireSeek(s);
  bar.querySelector('.vol')?.addEventListener('input', e => player.setVolume(+e.target.value));
  bar.querySelector('.vol')?.style.setProperty('--p', (P.volume * 100) + '%');
  renderTime();
  playerTail(t);
}
// Flip every play button in place (player bar + full screen)
function patchPlayButtons() {
  const on = player.isOn() ? '1' : '0';
  for (const b of $$('.play-btn[data-p="toggle"]')) {
    b.classList.toggle('busy', !!P.loading);
    if (b.dataset.on !== on) { b.dataset.on = on; b.innerHTML = icon(on === '1' ? 'pause' : 'play'); b.setAttribute('aria-label', on === '1' ? 'Pause' : 'Play'); }
  }
}
function playerTail(t) {
  markNow();
  document.body.classList.toggle('is-playing', player.isOn());
  updateJump();
  if (document.body.classList.contains('np-open')) renderNP();
  if (document.body.classList.contains('queue-open')) renderQueue($('#queue-panel .qp-body'));
  if (location.hash === '#/queue') renderQueue($('#queue-page'));
  const dt = $('#yt-dock .dock-title'); if (dt) dt.textContent = `${displayTitle(t)} · ${t.artist}`;
  const da = $('#yt-dock .dock-art'); if (da && da.dataset.src !== (t.artwork || '')) { da.dataset.src = t.artwork || ''; da.innerHTML = cover(t.artwork, t.title, 'sm'); }
  placeDock();
}
// Highlight exactly ONE row for the playing song — the one the user tapped (or the
// one that follows it in that list), never every copy of the same song on the page.
let nowCtx = { list: null };
function markNow() {
  const cur = player.current();
  let el = null;
  if (cur) {
    const ids = nowCtx.list && lists.get(nowCtx.list);
    if (ids) {
      if (ids[nowCtx.i] !== cur.id) {
        let j = ids.indexOf(cur.id, (nowCtx.i ?? -1) + 1);
        if (j < 0) j = ids.indexOf(cur.id);
        nowCtx.i = j;
      }
      if (nowCtx.i >= 0) el = document.querySelector(`.row[data-list="${CSS.escape(nowCtx.list)}"][data-i="${nowCtx.i}"]`);
    }
    if (!el) el = document.querySelector(`.row[data-id="${CSS.escape(cur.id)}"]`);
  }
  $$('.row.now').forEach(r => { if (r !== el) { r.classList.remove('now'); r.querySelector('.eq')?.remove(); } });
  if (el && (!el.classList.contains('now') || !el.querySelector('.eq'))) { el.classList.add('now'); (el.querySelector('.row-num .cover') || el.querySelector('.row-num')).insertAdjacentHTML('beforeend', '<span class="eq"><i></i><i></i><i></i></span>'); }
}

function renderTime() {
  if (seeking && !seeking.isConnected) { clearTimeout(seekIdle); seeking = null; } // the bar was redrawn mid-drag
  const pct = P.duration ? Math.max(0, Math.min(1, (P.time || 0) / P.duration)) : 0;
  $$('.pb-progress i').forEach(i => i.style.width = (pct * 100) + '%');
  if (seeking) return;
  $$('.seek').forEach(s => { s.value = Math.round(pct * 1000); s.style.setProperty('--p', (pct * 100).toFixed(2) + '%'); });
  $$('.t-now').forEach(x => x.textContent = fmtTime(P.time));
  $$('.t-dur').forEach(x => x.textContent = fmtTime(P.duration));
}

let qDragging = false;
// Full-screen player. The first render builds the page; after that (play/pause, like,
// shuffle…) only the parts that changed are patched, so the video slot, the lyrics
// and your scroll position never jump or reload.
const npLike = t => `<button class="ib lg like ${t.liked && !t.transient ? 'on' : ''}" data-p="like" aria-label="Like">${icon(t.liked && !t.transient ? 'heartFill' : 'heart')}</button>`;
const npCtrls = () => `
      <button class="ib lg ${P.shuffle ? 'on' : ''}" data-p="shuffle" aria-label="Shuffle">${icon('shuffle')}</button>
      <button class="ib xl" data-p="prev" aria-label="Previous">${icon('prev')}</button>
      <button class="play-btn big ${P.loading ? 'busy' : ''}" data-p="toggle" data-on="${player.isOn() ? 1 : 0}" aria-label="${player.isOn() ? 'Pause' : 'Play'}">${icon(player.isOn() ? 'pause' : 'play')}</button>
      <button class="ib xl" data-p="next" aria-label="Next">${icon('next')}</button>
      <button class="ib lg ${P.repeat !== 'off' ? 'on' : ''}" data-p="repeat" aria-label="Repeat">${icon('repeat')}${P.repeat === 'one' ? '<b class="r1">1</b>' : ''}</button>`;
function npExtra() {
  const qOn = document.body.classList.contains('np-q'), lOn = document.body.classList.contains('np-lyr');
  const upNext = Math.max(0, P.queue.length - P.cursor - 1);
  return `${P.source === 'local' ? `<span class="badge">${icon('offline')}Playing offline file</span>` : `<div class="seg big" role="group">
        <button data-p="mode" data-m="video" class="${P.mode === 'video' ? 'on' : ''}">${icon('video')}<span>Music video</span></button>
        <button data-p="mode" data-m="audio" class="${P.mode === 'audio' ? 'on' : ''}">${icon('audio')}<span>Audio only</span></button></div>`}
      <div class="np-toggles">
        <button class="chip ${lOn ? 'on' : ''}" data-p="lyrics" aria-pressed="${lOn}">${icon('mic')}${lOn ? 'Hide lyrics' : 'Lyrics'}</button>
        <button class="chip ${qOn ? 'on' : ''}" data-p="npq" aria-pressed="${qOn}">${icon('queue')}${qOn ? 'Hide queue' : 'Queue'}${upNext ? ` <small>${upNext}</small>` : ''}</button>
      </div>`;
}
// Scroll ONLY the scrolling part of the full-screen player (scrollIntoView would also shift the
// fixed top bar and video frame, leaving the video floating in the wrong place)
function npScrollTo(el) {
  if (!el) return;
  const headH = $('#np-head')?.offsetHeight || 60;
  window.scrollTo({ top: Math.max(0, scrollY + el.getBoundingClientRect().top - headH - 8), behavior: 'smooth' });
}
const npNarrow = matchMedia('(max-width: 900px), (max-height: 520px) and (orientation: landscape)'); // queue below the video on small or sideways phones
npNarrow.addEventListener?.('change', () => { if (document.body.classList.contains('np-open')) renderNP(true); });
const npQueueHTML = () => `<aside class="np-queue"><div class="np-q-head"><h3>Up next</h3><span class="muted tiny">Drag ${icon('grip')} to reorder</span><button class="ib sm" data-p="npq" aria-label="Hide queue">${icon('close')}</button></div><div class="np-q-body"></div></aside>`;
function renderNP(full = false) {
  if (qDragging) return;
  const t = player.current(); if (!t) return closeNP('nav');
  const np = $('#np');
  const showVid = P.source === 'yt';
  const qOn = document.body.classList.contains('np-q');
  const narrow = npNarrow.matches;
  const key = `${t.id}|${showVid}|${qOn}|${narrow}|${t.artwork || ''}`;
  if (!full && np.dataset.key === key && np.querySelector('.np-layout')) {
    // only rewrite what actually changed; play/pause just flips its button
    const setIf = (el, html) => { if (el && el._html !== html) { el._html = html; el.innerHTML = html; } };
    const c = np.querySelector('.np-ctrls'), cs = `${P.shuffle}|${P.repeat}`;
    if (c.dataset.sig !== cs) { c.dataset.sig = cs; c.innerHTML = npCtrls(); }
    patchPlayButtons();
    setIf(np.querySelector('.np-extra'), npExtra());
    const lk = np.querySelector('.np-info .like'), liked = t.liked && !t.transient;
    if (lk && lk.classList.contains('on') !== !!liked) lk.outerHTML = npLike(t);
    const err = np.querySelector('.np-err'); err.textContent = P.error || ''; err.hidden = !P.error;
    if (qOn) renderQueue(np.querySelector('.np-q-body'));
    renderTime(); placeDock();
    return;
  }
  np.dataset.key = key;
  const keep = { sc: scrollY || 0, q: $('.np-q-body')?.scrollTop || 0 };
  $('#np-head').innerHTML = `<button class="ib" data-p="close" aria-label="Close">${icon('down')}</button><div class="np-ctx">Now playing</div><button class="ib lock-np" data-act="lock" aria-label="Lock screen" title="Lock screen">${icon('lock')}</button><span class="np-head-r"><button class="ib sleep-np" data-p="sleep" aria-label="Sleep timer" title="Sleep timer">${icon('timer')}</button><button class="ib" data-p="more" aria-label="More">${icon('more')}</button></span>`;
  sleepBtn();
  // Layout: the top bar and the video/cover stay put; everything below scrolls on its own.
  // On wide screens the queue is a panel on the right with its own scroll.
  np.innerHTML = `<div class="np-bg ${t.artwork ? '' : 'none'}" ${t.artwork ? `style="background-image:url('${esc(sized(t.artwork, 300))}')"` : ''}></div>
    <div class="np-layout ${qOn && !narrow ? 'with-q' : ''}">
    <div class="np-main">
      <div class="np-scroll"><div class="np-inner">
        <div class="np-media ${showVid ? 'vid' : 'art'}">${showVid ? '<div id="np-slot" class="np-slot"></div>' : cover(t.artwork, t.title, 'np-art')}</div>
        <div class="np-info"><div><h2>${esc(displayTitle(t))}</h2><button class="lnk np-artist" data-p="artist">${esc(t.artist)}</button>${t.album ? `<button class="lnk np-album" data-p="album">${icon('disc')}${esc(t.album)}</button>` : ''}</div>
          ${npLike(t)}</div>
        <p class="err-text np-err" ${P.error ? '' : 'hidden'}>${esc(P.error || '')}</p>
        <div class="np-seek"><input type="range" class="seek" min="0" max="1000" value="0" aria-label="Seek"><div class="np-times"><span class="t-now">0:00</span><span class="t-dur">0:00</span></div></div>
        <div class="np-ctrls" data-sig="${P.shuffle}|${P.repeat}">${npCtrls()}</div>
        <div class="np-extra">${npExtra()}</div>
        <div class="np-tags">${genreOf(t) ? `<span class="pill">${esc(genreOf(t))}</span>` : ''}${t.year ? `<span class="pill">${t.year}</span>` : ''}${t.durationMs ? `<span class="pill">${fmtDur(t.durationMs)}</span>` : ''}</div>
        ${qOn && narrow ? npQueueHTML() : ''}
        <section class="np-lyrics" aria-label="Lyrics"></section>
      </div></div>
    </div>
    ${qOn && !narrow ? npQueueHTML() : ''}
    </div>`;
  wireSeek(np.querySelector('.seek'));
  if (qOn) renderQueue(np.querySelector('.np-q-body'));
  if (document.body.classList.contains('np-lyr')) showLyrics(t);
  if (keep.sc) window.scrollTo(0, keep.sc);
  const qb = np.querySelector('.np-q-body'); if (qb) qb.scrollTop = keep.q;
  renderTime();
  placeDock();
}

// ---------- Lyrics (Genius) ----------
// Genius's official embed widget shows licensed lyrics. To use it we need the song's Genius id:
// we try Genius's search (with your free token if you added one). If Genius doesn't allow the
// lookup from this browser, you get a one-tap "Open lyrics on Genius" button instead.
const lyricsCache = new Map();
function setLyrics(on) {
  document.body.classList.toggle('np-lyr', on);
  try { localStorage.setItem('bz_lyr', on ? '1' : ''); } catch { }
  if (!document.body.classList.contains('np-open')) return;
  renderNP();
  const t = player.current();
  if (on && t) { showLyrics(t); setTimeout(() => npScrollTo($('#np .np-lyrics')), 80); }
  else { const el = $('.np-lyrics'); if (el) { el.innerHTML = ''; el.dataset.tid = ''; } }
}
async function geniusFind(t) {
  const q = `${t.artist} ${t.title.replace(/\s*[\(\[].*?[\)\]]/g, '')}`;
  const tries = [];
  if (settings.geniusToken) tries.push(async () => (await (await fetch(`https://api.genius.com/search?q=${encodeURIComponent(q)}&access_token=${encodeURIComponent(settings.geniusToken)}`)).json()).response.hits.map(h => h.result));
  tries.push(async () => (await (await fetch(`https://genius.com/api/search/song?per_page=5&q=${encodeURIComponent(q)}`)).json()).response.sections.flatMap(s => s.hits).map(h => h.result));
  for (const go of tries) {
    try {
      const res = (await go()).filter(Boolean);
      const na = norm(mainArtist(t.artist)), nt = norm(t.title.replace(/\s*[\(\[].*?[\)\]]/g, ''));
      const hit = res.find(r => norm(r.primary_artist?.name).includes(na) && norm(r.title).includes(nt))
        || res.find(r => norm(r.primary_artist?.name).includes(na) || norm(r.full_title || '').includes(na)) || null;
      if (hit) return { id: hit.id, url: hit.url };
      if (res.length) return null;
    } catch { }
  }
  return null;
}
async function showLyrics(t) {
  const el = $('.np-lyrics'); if (!el || !t) return;
  if (el.dataset.tid === t.id && el.innerHTML) return;
  el.dataset.tid = t.id;
  const searchUrl = `https://genius.com/search?q=${encodeURIComponent(`${t.artist} ${t.title}`)}`;
  el.innerHTML = `<div class="lyr-head"><h3>Lyrics</h3><span class="muted tiny">from Genius</span></div>${loader('Finding lyrics…', 'sm')}`;
  if (!lyricsCache.has(t.id)) lyricsCache.set(t.id, navigator.onLine ? geniusFind(t) : Promise.resolve(null));
  const g = await lyricsCache.get(t.id);
  if (el.dataset.tid !== t.id) return;
  if (g?.id) {
    const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>html,body{margin:0;background:#fff;font-family:system-ui,sans-serif}body{padding:4px}</style></head><body>
      <div id="rg_embed_link_${g.id}" class="rg_embed_link" data-song-id="${g.id}">Read <a href="${esc(g.url)}">${esc(t.title)}</a> on Genius</div>
      <script crossorigin src="https://genius.com/songs/${g.id}/embed.js"><\/script></body></html>`;
    el.innerHTML = `<div class="lyr-head"><h3>Lyrics</h3><a class="lnk tiny" href="${esc(g.url)}" target="_blank" rel="noopener">Open on Genius ↗</a></div>
      <iframe class="lyr-frame" title="Lyrics from Genius" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>`;
    el.querySelector('iframe').srcdoc = doc;
  } else {
    el.innerHTML = `<div class="lyr-head"><h3>Lyrics</h3></div><div class="lyr-empty">
      <p class="muted">${navigator.onLine ? 'Genius didn\'t let us load these lyrics here.' : 'Lyrics need an internet connection.'}</p>
      <a class="btn primary" href="${esc(g?.url || searchUrl)}" target="_blank" rel="noopener">${icon('link')}Open lyrics on Genius</a>
      ${!settings.geniusToken ? '<p class="tiny muted">Tip: add a free Genius token in Settings → Lyrics to load them right here.</p>' : ''}</div>`;
  }
}

// The YouTube player lives in one element at the top of the page (moving an iframe would reload it).
// In the full-screen player it is placed over the video slot as part of the page, so when the page
// scrolls the browser moves the video itself — perfectly in step, in every browser, no script per frame.
// Otherwise it sits in its corner mini-dock.
function placeDock() {
  const dock = $('#yt-dock');
  const vis = P.source === 'yt' && !!player.current();
  dock.classList.toggle('show', vis);
  if (!vis) return;
  const slot = document.body.classList.contains('np-open') ? $('#np-slot') : null;
  if (slot) {
    const r = slot.getBoundingClientRect();
    const st = dock.style, L = Math.round(r.left + scrollX) + 'px', T = Math.round(r.top + scrollY) + 'px', W = r.width + 'px', H = r.height + 'px';
    if (st.left !== L || st.top !== T || st.width !== W || st.height !== H) Object.assign(st, { left: L, top: T, width: W, height: H, right: 'auto', bottom: 'auto' });
    dock.classList.add('in-np');
  } else if (dock.classList.contains('in-np') || dock.hasAttribute('style')) {
    dock.classList.remove('in-np');
    dock.removeAttribute('style');
  }
  // the back-to-top button sits just to the left of the corner video (desktop)
  if (!slot) requestAnimationFrame(() => { const on = dock.classList.contains('show'); document.body.style.setProperty('--dockh', (on ? dock.offsetHeight : 0) + 'px'); document.body.style.setProperty('--dockw', (on ? dock.offsetWidth : 0) + 'px'); });
}

// Save the whole queue (BAZINGA! mix or a shuffled queue) as a new playlist, in the order it plays
async function saveQueueAsPlaylist() {
  const ids = P.queue.map(q => q.id).filter(id => lib.tracks.has(id));
  if (!ids.length) return;
  const day = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const name = await promptText('Save queue as a playlist', `${P.origin === 'mix' ? 'My BAZINGA! Mix' : 'Shuffle'} · ${day}`, 'Playlist name', 'Save');
  if (!name) return;
  const transient = ids.map(id => lib.tracks.get(id)).filter(t => t.transient);
  if (transient.length) await store.upsertTracks(transient.map(stripTransient));
  const pl = await store.createPlaylist(name, ids, { source: 'Saved from your queue' });
  renderSidebarPlaylists();
  toastUndo(`Saved "${name}" · ${ids.length} songs`, () => { closeNP('nav'); location.hash = '#/playlist/' + pl.id; }, 'Open');
}
function renderQueue(el, force = false) {
  if (!el || qDragging) return;
  const cur = player.current();
  if (!cur) { el.innerHTML = '<p class="muted pad">Nothing playing. Pick a song to start.</p>'; el.dataset.sig = ''; return; }
  // Skip the (expensive) rebuild when nothing in the queue changed — play/pause/buffering don't touch it
  const limit = +el.dataset.limit || 100;
  const canSave = player.queueIsNew();
  const sig = `${cur.id}|${P.cursor}|${P.queue.length}|${limit}|${canSave}|` + P.queue.slice(P.cursor, P.cursor + limit + 1).map(q => q.id + (q.user ? '*' : '')).join(',');
  if (!force && el.dataset.sig === sig && el.firstChild) return;
  el.dataset.sig = sig;
  const total = P.queue.length - P.cursor - 1;
  const after = P.queue.slice(P.cursor + 1).map((q, j) => ({ ...q, i: P.cursor + 1 + j })).slice(0, limit);
  const row = q => { const t = lib.tracks.get(q.id); if (!t) return ''; return `<div class="qrow ${q.user ? 'user' : ''}" data-qi="${q.i}">
      <span class="grip" title="Drag to reorder">${icon('grip')}</span>${cover(t.artwork, t.title, 'sm')}<div class="row-main" data-qjump="${q.i}"><div class="row-title">${esc(displayTitle(t))}${q.user ? '<span class="qtag">queued</span>' : ''}</div><div class="row-sub">${esc(t.artist)}</div></div>
      <button class="ib sm" data-qrm="${q.i}" aria-label="Remove from queue" title="Remove">${icon('close')}</button></div>`; };
  el.innerHTML = `<div class="q-h">Now playing${canSave ? `<button class="ib q-save" data-qsave aria-label="Save this queue as a new playlist" title="Save this queue as a playlist">${icon('plus')}</button>` : ''}</div><div class="qrow now">${cover(cur.artwork, cur.title, 'sm')}<div class="row-main"><div class="row-title">${esc(displayTitle(cur))}</div><div class="row-sub">${esc(cur.artist)}</div></div></div>
    ${after.length ? `<div class="q-h">Next up <span>${after.some(q => q.user) ? '<button class="lnk" data-qclear>Clear queued</button>' : ''}</span></div><div class="qlist">${after.map(row).join('')}</div>`
      : `<p class="muted tiny pad">Nothing after this song. ${settings.autoplay === 'off' ? 'Use ⋯ → "Add to queue" on any song.' : 'Autoplay picks up from here.'}</p>`}
    ${total > after.length ? `<button class="more-btn" data-qmore>Show more <small>${total - after.length} more</small></button>` : ''}`;
  el.onclick = e => {
    if (el._dragged) { el._dragged = false; return; }
    if (e.target.closest('[data-qmore]')) { el.dataset.limit = limit + 100; renderQueue(el, true); return; }
    const j = e.target.closest('[data-qjump]'); if (j) player.jumpTo(+j.dataset.qjump);
    const r = e.target.closest('[data-qrm]'); if (r) player.removeFromQueue(+r.dataset.qrm);
    if (e.target.closest('[data-qclear]')) player.clearUserQueue();
    if (e.target.closest('[data-qsave]')) saveQueueAsPlaylist();
  };
  // Drag to reorder — pointer events, so it works with mouse AND touch
  el.onpointerdown = e => {
    const g = e.target.closest('.grip'); if (!g) return;
    const rowEl = g.closest('.qrow'), list = el.querySelector('.qlist'); if (!rowEl || !list) return;
    e.preventDefault();
    const from = +rowEl.dataset.qi;
    const startOrder = [...list.children].map(r => +r.dataset.qi);
    rowEl.classList.add('dragging'); qDragging = true;
    g.setPointerCapture(e.pointerId);
    const scroller = el.closest('.np-q-body, .qp-body, #main, .np-scroll') || el;
    let raf = null, lastY = e.clientY;
    const autoscroll = () => {
      const r = scroller.getBoundingClientRect();
      if (lastY < r.top + 50) scroller.scrollTop -= 10; else if (lastY > r.bottom - 50) scroller.scrollTop += 10;
      raf = requestAnimationFrame(autoscroll);
    };
    raf = requestAnimationFrame(autoscroll);
    const move = ev => {
      lastY = ev.clientY;
      const sibs = [...list.children].filter(r => r !== rowEl);
      const before = sibs.find(r => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
      if (before) { if (rowEl.nextSibling !== before) list.insertBefore(rowEl, before); }
      else if (list.lastElementChild !== rowEl) list.appendChild(rowEl);
    };
    const up = () => {
      cancelAnimationFrame(raf);
      g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
      rowEl.classList.remove('dragging'); qDragging = false;
      const newPos = [...list.children].indexOf(rowEl);
      const to = startOrder[newPos];
      if (to !== from) { el._dragged = true; player.moveInQueue(from, to); } else emit('player', P);
    };
    g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
  };
}

boot().then(() => { const f = document.getElementById('boot-fail'); if (f) f.hidden = true; }).catch(e => {
  console.error(e); // details stay in the console; people just see a friendly "sorry" with Try again / Help
  const f = document.getElementById('boot-fail'); if (!f) return;
  f.hidden = false;
  const st = f.querySelector('.bf-status');
  if (st) st.textContent = /storage|indexeddb|private|blocked|quota/i.test(e?.message || '') ? 'This browser is blocking the storage BAZINGA! needs — Private mode or a full device can cause this.' : '';
});
