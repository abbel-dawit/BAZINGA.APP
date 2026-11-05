// Auto-updating backups, all on the user's own device:
//  • Rolling snapshots inside the app's storage (last 5) — instant undo for mistakes.
//  • A linked backup FILE on the device (Chrome/Edge desktop): rewritten automatically on every change,
//    so it survives even if the browser's data is wiped.
//  • One-tap download / restore of a .json backup file on every browser.
import { db, kv } from './db.js';
import { emit, downloadBlob, on, toast } from './util.js';

const KEEP = 5;
export const fsSupported = 'showSaveFilePicker' in window;

export async function snapshot() {
  const [tracks, albums, playlists, ytKeys, ytVals, profile, settings, player] = await Promise.all([
    db.all('tracks'), db.all('albums'), db.all('playlists'), db.keys('ytcache'), db.all('ytcache'), kv.get('profile'), kv.get('settings'), kv.get('player')]);
  return {
    app: 'BAZINGA', version: 1, createdAt: new Date().toISOString(),
    profile, settings, player,
    tracks: tracks.map(t => ({ ...t, localFileId: undefined, hadLocalFile: !!t.localFileId || t.hadLocalFile })),
    albums, playlists,
    ytcache: ytKeys.map((k, i) => [k, ytVals[i]])
  };
}

export async function restore(data) {
  if (!data || data.app !== 'BAZINGA') throw new Error('That isn\'t a BAZINGA backup file.');
  // Keep links to offline files that still exist on this device
  const existing = new Map((await db.all('tracks')).filter(t => t.localFileId).map(t => [t.id, t.localFileId]));
  for (const s of ['tracks', 'albums', 'playlists', 'ytcache']) await db.clear(s);
  await db.putMany('tracks', (data.tracks || []).map(t => {
    const x = { ...t }; delete x.localFileId;
    if (existing.has(t.id)) x.localFileId = existing.get(t.id);
    return x;
  }));
  await db.putMany('albums', data.albums || []);
  await db.putMany('playlists', data.playlists || []);
  { const yc = data.ytcache || []; for (let i = 0; i < yc.length; i += 500) await putPairs('ytcache', yc.slice(i, i + 500)); }
  if (data.profile) await kv.set('profile', data.profile);
  if (data.settings) await kv.set('settings', data.settings);
  if (data.player) await kv.set('player', data.player);
}

const putPairs = (store, pairs) => Promise.all(pairs.map(([k, v]) => db.put(store, v, k)));
// The snapshot itself is kept apart from its summary, so listing snapshots (Settings) and keeping only the
// newest 5 never has to load every old copy of the library into memory.
const dataKey = id => 'bkdata:' + id;
async function writeInternal(snap, size) {
  const id = 'bk_' + Date.now();
  await kv.set(dataKey(id), snap);
  await db.put('backups', { id, ts: Date.now(), size, counts: { tracks: snap.tracks.length, playlists: snap.playlists.length, albums: snap.albums.length } });
  const ids = (await db.keys('backups')).sort((a, b) => (+String(b).slice(3) || 0) - (+String(a).slice(3) || 0));
  for (const old of ids.slice(KEEP)) { await db.del('backups', old); await kv.del(dataKey(old)); }
}

let fileState = 'none'; // none | ok | needs-permission | error
export const linkedFileState = () => fileState;

async function writeFile(json) {
  const h = await kv.get('backupHandle');
  if (!h) { fileState = 'none'; return; }
  const perm = await h.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') { fileState = 'needs-permission'; emit('backup-state'); return; }
  try {
    const w = await h.createWritable();
    await w.write(json);
    await w.close();
    fileState = 'ok';
  } catch (e) { fileState = 'error'; console.warn(e); }
}

let running = null, again = false;
export async function runBackup() {
  if (running) { again = true; return running; } // one at a time; a change during a backup gets one more pass
  running = (async () => {
    do {
      again = false;
      const profile = await kv.get('profile');
      if (!profile) return; // no account yet
      const snap = await snapshot();
      const json = JSON.stringify(snap); // once, for both the size and the linked file
      await writeInternal(snap, json.length);
      if (fsSupported) await writeFile(json);
      await kv.set('lastBackup', Date.now());
      emit('backup-state');
    } while (again);
  })().finally(() => { running = null; });
  return running;
}

// Backups wait for a quiet moment: a few seconds after you change something (a minute for background
// tidying like genres and covers), never more than 2 minutes behind, and only when the device is idle.
const idle = fn => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 200));
let dueAt = 0, firstDirty = 0, timer = 0;
function scheduled(why) {
  const now = Date.now();
  if (!firstDirty) firstDirty = now;
  const wait = why === 'enrich' || why === 'yt' ? 60e3 : 8e3;
  const at = Math.min(now + wait, firstDirty + 120e3);
  if (dueAt && dueAt <= at && timer) return;
  dueAt = at; clearTimeout(timer);
  timer = setTimeout(() => { timer = 0; dueAt = 0; firstDirty = 0; idle(() => runBackup().catch(e => console.warn('backup failed', e))); }, Math.max(0, at - now));
}
export function startAuto() {
  on('dirty', scheduled);
  // Also back up when the app is hidden/closed so nothing is lost
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') runBackup(); });
  // Check linked file permission on start
  kv.get('backupHandle').then(async h => {
    if (!h) return;
    fileState = (await h.queryPermission({ mode: 'readwrite' })) === 'granted' ? 'ok' : 'needs-permission';
    emit('backup-state');
  });
}

export async function linkFile() {
  const h = await window.showSaveFilePicker({
    suggestedName: 'BAZINGA-backup.json',
    types: [{ description: 'BAZINGA backup', accept: { 'application/json': ['.json'] } }]
  });
  await kv.set('backupHandle', h);
  fileState = 'ok';
  await runBackup();
  toast('Auto-backup file linked — it updates itself on every change');
}
export async function regrant() {
  const h = await kv.get('backupHandle'); if (!h) return;
  if ((await h.requestPermission({ mode: 'readwrite' })) === 'granted') { fileState = 'ok'; await runBackup(); toast('Auto-backup resumed'); }
}
export async function unlinkFile() { await kv.del('backupHandle'); fileState = 'none'; emit('backup-state'); }

export async function download() {
  const snap = await snapshot();
  const d = new Date().toISOString().slice(0, 10);
  downloadBlob(new Blob([JSON.stringify(snap)], { type: 'application/json' }), `BAZINGA-backup-${d}.json`);
  await kv.set('lastDownload', Date.now());
  emit('backup-state');
}

export const listInternal = async () => (await db.all('backups')).map(({ data, ...meta }) => meta).sort((a, b) => b.ts - a.ts);
export async function restoreInternal(id) { const b = await db.get('backups', id); if (!b) return; await restore(b.data || await kv.get(dataKey(id))); }
export async function restoreFromFile(file) { await restore(JSON.parse(await file.text())); }
