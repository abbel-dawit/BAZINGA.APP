// Reusable UI pieces: icons, rows, cards, menus, modals, toasts, filters.
import { esc, fmtDur, hashColor, $, on, mainArtist, yearOf, displayTitle, genreOf, emit } from './util.js';

const I = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  library: '<path d="M4 4v16M9 4v16M14 5l5 15"/>',
  import: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
  offline: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  minus: '<path d="M5 12h14"/>',
  google: '<circle cx="12" cy="12" r="10" fill="#fff" stroke="none"/><text x="12" y="16.6" text-anchor="middle" font-size="13.5" font-weight="800" font-family="Arial, Helvetica, sans-serif" fill="#4285F4" stroke="none">G</text>',
  discord: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5z" fill="currentColor" stroke="none"/><circle cx="9.5" cy="10" r="1.4" fill="#5865F2" stroke="none"/><circle cx="14.5" cy="10" r="1.4" fill="#5865F2" stroke="none"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  coffee: '<path d="M10 5c0-1.3.7-2 2-2h2.2c1.2 0 1.8-.6 1.8-1.8"/><path d="M6.4 8.4h11.4a1.9 1.9 0 0 1 1.9 1.9v3.5a7.6 7.4 0 0 1-15.2 0v-3.5a1.9 1.9 0 0 1 1.9-1.9z"/><path d="M19.7 10.4h1a1.7 1.7 0 0 1 1.7 1.7v.4c0 1.9-1.4 3.5-3.3 3.8"/><path d="M1.4 21.6h21.2"/>',
  instagram: '<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H8l1.3-2h5.4L16 6h1.5A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z"/><circle cx="12" cy="12.5" r="3.5"/>',
  xsocial: '<path d="M5 4l14 16M19 4L5 20" stroke-width="2.6"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  cloud: '<path d="M7 18a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  apple: '<path d="M16.4 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.8-.8-3-.8-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.3 0 2.1-1.1 2.8-2.3.9-1.3 1.3-2.6 1.3-2.6s-2.5-1-2.5-3.8zM14.2 5.8c.6-.8 1.1-1.9 1-3-.9 0-2.1.6-2.7 1.4-.6.7-1.1 1.8-1 2.9 1 .1 2.1-.5 2.7-1.3z" fill="currentColor" stroke="none"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/>',
  next: '<path d="M5 5l10 7-10 7z" fill="currentColor"/><path d="M19 5v14"/>',
  prev: '<path d="M19 5L9 12l10 7z" fill="currentColor"/><path d="M5 5v14"/>',
  shuffle: '<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  repeat: '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
  heartFill: '<path fill="currentColor" d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  queue: '<path d="M3 6h13M3 12h13M3 18h8"/><path d="M17 15v6l5-3z" fill="currentColor"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  video: '<rect x="2" y="5" width="15" height="14" rx="2"/><path d="M17 10l5-3v10l-5-3"/>',
  audio: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M17 9l5 6M22 9l-5 6"/>',
  yt: '<rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9v6l5-3z" fill="currentColor"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  sparkle: '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>',
  cloudOff: '<path d="M3 3l18 18M8 8a5 5 0 0 0-2 9.6h10M18 17.3A4 4 0 0 0 16.5 10a6 6 0 0 0-6.4-4.6"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  spotify: '<circle cx="12" cy="12" r="10"/><path d="M7 9.5c3.5-1 7-.7 10 1M7.5 12.8c3-.8 5.6-.5 8 .9M8 16c2.3-.5 4.3-.3 6 .7"/>',
  grip: '<circle cx="9" cy="7" r="1.2" fill="currentColor"/><circle cx="15" cy="7" r="1.2" fill="currentColor"/><circle cx="9" cy="12" r="1.2" fill="currentColor"/><circle cx="15" cy="12" r="1.2" fill="currentColor"/><circle cx="9" cy="17" r="1.2" fill="currentColor"/><circle cx="15" cy="17" r="1.2" fill="currentColor"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  shrink: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.6" r="1.3" fill="currentColor"/>',
  unlock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 7.6-1.7"/><circle cx="12" cy="15.6" r="1.3" fill="currentColor"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM18 18h3v3h-3zM18 14h3M14 18v3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
};
export const icon = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n] || ''}</svg>`;

// Ask image servers for the size we actually show (a 42px row thumbnail doesn't need a 1000px image)
export function sized(src, px) {
  if (!src || src.startsWith('data:')) return src;
  const d = px <= 64 ? 120 : px <= 220 ? 300 : 600;
  return src
    .replace(/\/(\d+)x\1bb\./, `/${d}x${d}bb.`)                                   // Apple
    .replace(/\/(\d+)x\1-000000-80-0-0\.jpg$/, `/${Math.max(d, 250)}x${Math.max(d, 250)}-000000-80-0-0.jpg`) // Deezer
    .replace(/\/vi\/([\w-]{11})\/(hq|maxres|sd)default\.jpg$/, (m, id) => `/vi/${id}/${d <= 120 ? 'mqdefault' : 'hqdefault'}.jpg`); // YouTube
}
export function cover(src, label, cls = '') {
  const px = /\bsm\b|qt-art|pb-art/.test(cls) ? 64 : /np-art|hero/.test(cls) ? 600 : 200;
  const eager = /hero|np-art|pb-art/.test(cls);
  if (src) return `<div class="cover ${cls}"><img src="${esc(sized(src, px))}" alt="" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" onerror="this.parentNode.classList.add('noimg');this.remove()"><span>${esc((label || '?')[0])}</span></div>`;
  return `<div class="cover noimg ${cls}" style="--c:${hashColor(label)}"><span>${esc((label || '?')[0].toUpperCase())}</span></div>`;
}

// One song row. `ctx` = {list, index, playlistId}
export function trackRow(t, i, ctx = {}, playingId) {
  const isNow = false; // highlighting is done by markNow() so only ONE row lights up
  const main = t.artist || '';
  const artists = `<a href="#/artist/${encodeURIComponent(main)}" class="lnk">${esc(main)}</a>`;
  return `<div class="row ${isNow ? 'now' : ''} ${t.isVideo ? 'is-video' : ''}" data-act="play-row" data-list="${ctx.list}" data-i="${i}" data-id="${esc(t.id)}" role="button" tabindex="0">
    <div class="row-num">${isNow ? '<span class="eq"><i></i><i></i><i></i></span>' : (ctx.numbered ? (t.trackNumber || i + 1) : '')}${cover(t.artwork, t.title, t.isVideo ? 'sm wide' : 'sm')}</div>
    <div class="row-main">
      <div class="row-title"><span class="tt">${esc(displayTitle(t))}</span>${t.explicit ? '<span class="e">E</span>' : ''}${t.localFileId ? `<span class="off" title="Available offline">${icon('offline')}</span>` : ''}</div>
      <div class="row-sub">${artists}</div>
    </div>
    <div class="row-album hide-sm">${t.album ? `<a class="lnk" data-act="goto-album" data-id="${esc(t.id)}">${esc(t.album)}</a>` : ''}</div>
    <div class="row-meta hide-sm">${genreOf(t) ? `<span class="pill">${esc(genreOf(t))}</span>` : ''}${t.year || yearOf(t.releaseDate) || ''}</div>
    <button class="ib like ${t.liked ? 'on' : ''}" data-act="like" data-id="${esc(t.id)}" aria-label="Like">${icon(t.liked ? 'heartFill' : 'heart')}</button>
    <div class="row-dur hide-xs">${fmtDur(t.durationMs)}</div>
    <button class="ib" data-act="track-menu" data-id="${esc(t.id)}" data-pl="${ctx.playlistId || ''}" aria-label="More">${icon('more')}</button>
  </div>`;
}

export function card({ href, img, title, sub, round = false, act = '', id = '' }) {
  return `<a class="card" href="${href}">
    <div class="card-art ${round ? 'round' : ''}">${cover(img, title)}${act ? `<button class="fab-play" data-act="${act}" data-id="${esc(id)}" aria-label="Play">${icon('play')}</button>` : ''}</div>
    <div class="card-t">${esc(title)}</div><div class="card-s">${esc(sub || '')}</div></a>`;
}

// ---------- Toasts ----------
on('toast', ({ msg, kind, action, ms }) => {
  const root = $('#toasts'); if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind + (action ? ' has-act' : '');
  const txt = document.createElement('span'); txt.textContent = msg; el.appendChild(txt);
  const life = ms || (action ? 6500 : 3200);
  let t1, t2;
  const bye = () => { el.classList.add('out'); setTimeout(() => el.remove(), 350); };
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-act'; b.type = 'button'; b.textContent = action.label || 'Undo';
    b.onclick = () => { clearTimeout(t1); clearTimeout(t2); bye(); try { action.fn(); } catch (e) { console.warn(e); } };
    el.appendChild(b);
  }
  root.appendChild(el);
  t1 = setTimeout(bye, life);
});
// A toast with an "Undo" (or other) button
export const toastUndo = (msg, fn, label = 'Undo') => emit('toast', { msg, kind: 'info', action: { label, fn } });

// ---------- Modal ----------
export function modal(html, { wide = false, onMount, locked = false, ownForms = false } = {}) {
  return new Promise(resolve => {
    const root = $('#modal-root');
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${locked ? '' : `<button class="ib modal-x" data-close aria-label="Close">${icon('close')}</button>`}${html}</div>`;
    root.appendChild(wrap);
    const close = v => { wrap.classList.add('out'); setTimeout(() => wrap.remove(), 180); document.removeEventListener('keydown', key); resolve(v); };
    const key = e => { if (e.key === 'Escape' && !locked) close(null); };
    document.addEventListener('keydown', key);
    wrap.addEventListener('click', e => {
      if ((e.target === wrap && !locked) || e.target.closest('[data-close]')) close(null);
      const r = e.target.closest('[data-resolve]');
      if (r) close(r.dataset.resolve);
    });
    if (!ownForms) wrap.querySelector('form')?.addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(e.target), o = {};
      for (const k of new Set(fd.keys())) { const v = fd.getAll(k); o[k] = v.length > 1 ? v : v[0]; }
      close(o);
    });
    onMount?.(wrap.querySelector('.modal'), close);
    setTimeout(() => wrap.querySelector('input:not([type=file]),button.primary')?.focus(), 50);
  });
}
export async function promptText(title, value = '', label = 'Name', okText = 'Save') {
  const r = await modal(`<h3>${esc(title)}</h3><form><label class="fld"><span>${esc(label)}</span><input name="v" value="${esc(value)}" required maxlength="100"></label>
    <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">${esc(okText)}</button></div></form>`);
  return r ? r.v.trim() : null;
}
export async function confirmBox(title, body, okText = 'Confirm', danger = false) {
  const r = await modal(`<h3>${esc(title)}</h3><p class="muted">${body}</p>
    <div class="modal-actions"><button class="btn ghost" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-resolve="ok">${esc(okText)}</button></div>`);
  return r === 'ok';
}

// ---------- Popup menu (bottom sheet on phones) ----------
export function menu(anchor, items) {
  closeMenu();
  const root = $('#menu-root');
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = items.filter(Boolean).map(it => it === '-' ? '<hr>' :
    it.header ? `<div class="menu-h">${it.header}</div>` :
    `<button data-k="${it.k}" class="${it.danger ? 'danger' : ''}">${icon(it.icon || 'plus')}<span>${esc(it.label)}</span></button>`).join('');
  const back = document.createElement('div'); back.className = 'menu-back';
  root.append(back, m);
  const mobile = innerWidth < 700;
  if (mobile) m.classList.add('sheet');
  else {
    const r = anchor.getBoundingClientRect();
    const mw = 260, mh = Math.min(m.scrollHeight, innerHeight - 20);
    m.style.left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8)) + 'px';
    m.style.top = (r.bottom + mh + 8 > innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
  }
  return new Promise(resolve => {
    m.addEventListener('click', e => { const b = e.target.closest('button[data-k]'); if (b) { closeMenu(); resolve(b.dataset.k); } });
    back.addEventListener('click', () => { closeMenu(); resolve(null); });
  });
}
export function closeMenu() { const r = $('#menu-root'); if (r) r.innerHTML = ''; }

// ---------- Filters (genre + release date + sort + text) ----------
export function applyFilters(list, f) {
  let out = list;
  if (f.q) {
    const q = f.q.toLowerCase();
    out = out.filter(t => (t.title + ' ' + t.artist + ' ' + (t.album || '')).toLowerCase().includes(q));
  }
  if (f.genres?.length) out = out.filter(t => f.genres.includes(genreOf(t)));
  const y = t => t.year || yearOf(t.releaseDate);
  if (f.years?.length) out = out.filter(t => f.years.includes(y(t)));
  if (f.liked) out = out.filter(t => t.liked);
  if (f.offline) out = out.filter(t => t.localFileId);
  const by = {
    added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    liked: (a, b) => (b.likedAt || b.addedAt || 0) - (a.likedAt || a.addedAt || 0),
    title: (a, b) => a.title.localeCompare(b.title),
    artist: (a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title),
    newest: (a, b) => (b.releaseDate || String(y(b) || '')).localeCompare(a.releaseDate || String(y(a) || '')),
    oldest: (a, b) => (y(a) || 9999) - (y(b) || 9999) || (a.releaseDate || '').localeCompare(b.releaseDate || ''),
    album: (a, b) => (a.album || '').localeCompare(b.album || '') || (a.trackNumber || 0) - (b.trackNumber || 0)
  }[f.sort];
  if (by) out = [...out].sort(by);
  return out;
}

export function filterBar(f, tracks, { showSort = true, keepOrder = false, likedSort = false } = {}) {
  // Top 10 broad genres in this list (never "Unknown"), plus any you already picked
  const gm = new Map();
  for (const t of tracks) { const g = genreOf(t); if (g) gm.set(g, (gm.get(g) || 0) + 1); }
  let genres = [...gm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const g of f.genres || []) if (!genres.some(x => x[0] === g)) genres.push([g, gm.get(g) || 0]);
  // Every year in the list, newest first — tap as many as you like
  const ym = new Map();
  for (const t of tracks) { const y = t.year || yearOf(t.releaseDate); if (y) ym.set(y, (ym.get(y) || 0) + 1); }
  const years = [...ym.entries()].sort((a, b) => b[0] - a[0]);
  const active = (f.genres?.length || 0) + (f.years?.length || 0) + (f.liked ? 1 : 0) + (f.offline ? 1 : 0);
  return `<div class="filters">
    <div class="filter-top">
      <div class="fsearch"><label class="searchbox sm">${icon('search')}<input data-f="q" placeholder="Filter songs" value="${esc(f.q || '')}" enterkeyhint="search" aria-label="Filter songs"></label>
        <button class="round-search" data-act="filter-go" aria-label="Search these songs" title="Search">${icon('search')}</button></div>
      <div class="fctl"><button class="chip ${f.open ? 'on' : ''}" data-act="toggle-filters">${icon('filter')}Filters${active ? ` <b>${active}</b>` : ''}</button>
      ${showSort ? (() => {
        const opts = [...(keepOrder ? [['', 'Custom order']] : []), ...(likedSort ? [['liked', 'Recently liked']] : []),
          ['added', 'Recently added'], ['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['newest', 'Year: newest'], ['oldest', 'Year: oldest']];
        const cur = opts.find(([v]) => v === (f.sort || '')) || opts.find(([v]) => v === 'added');
        // The label + arrow are drawn centred together; the real <select> sits invisibly on top to open the list
        return `<label class="sort-pick"><span class="sort-face"><span class="sort-lbl">${esc(cur[1])}</span>${icon('down')}</span>
          <select data-f="sort" aria-label="Sort">${opts.map(([v, l]) => `<option value="${v}" ${cur[0] === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
      })() : ''}</div>
    </div>
    ${f.open ? `<div class="filter-panel">
      <div class="fp-sec"><div class="fp-h">Top genres</div><div class="chips">
        ${genres.length ? genres.map(([g, n]) => `<button class="chip ${f.genres?.includes(g) ? 'on' : ''}" data-act="f-genre" data-g="${esc(g)}">${esc(g)} <small>${n}</small></button>`).join('') : '<span class="muted">Genres appear as songs get matched.</span>'}
      </div></div>
      ${years.length ? `<div class="fp-sec"><div class="fp-h">Year <span class="fp-note">pick one or more</span></div>
        <div class="chips years-chips">${years.map(([y, n]) => `<button class="chip ${f.years?.includes(y) ? 'on' : ''}" data-act="f-year" data-y="${y}" aria-pressed="${!!f.years?.includes(y)}">${y} <small>${n}</small></button>`).join('')}</div>
      </div>` : ''}
      <div class="fp-sec"><div class="chips">
        <button class="chip ${f.liked ? 'on' : ''}" data-act="f-flag" data-k="liked">${icon('heart')}Liked only</button>
        <button class="chip ${f.offline ? 'on' : ''}" data-act="f-flag" data-k="offline">${icon('offline')}Offline only</button>
        ${active ? '<button class="chip ghost" data-act="f-clear">Clear all</button>' : ''}
      </div></div>
    </div>` : ''}
  </div>`;
}

export function empty(title, body, cta = '') {
  return `<div class="empty"><img src="icons/icon-192.png" alt="" class="empty-bolt"><h3>${title}</h3><p class="muted">${body}</p>${cta}</div>`;
}

// Liked Songs cover: a proper, full-size heart
export const likedCover = (cls = '') => `<div class="cover liked-cover heart-cover ${cls}">${icon('heartFill')}</div>`;

// Big, centered, animated loader
export function loader(text = '', cls = '') {
  return `<div class="bz-loader ${cls}" role="status" aria-live="polite"><div class="bz-orb"><span></span><span></span><span></span><img src="icons/icon-192.png" alt=""></div>${text ? `<p>${esc(text)}</p>` : ''}</div>`;
}
