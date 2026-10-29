// Auto-updating backups, all on the user's own device:
//  • Rolling snapshots inside the app's storage (last 5) — instant undo for mistakes.
//  • A linked backup FILE on the device (Chrome/Edge desktop): rewritten automatically on every change,
//    so it survives even if the browser's data is wiped.
//  • One-tap download / restore of a .json backup file on every browser.
import { db, kv } from './db.js';
import { debounce, emit, downloadBlob, on, toast } from './util.js';

const KEEP = 5;
export const fsSupported = 'showSaveFilePicker' in window;

export async function snapshot() {
  const [tracks, albums, playlists] = await Promise.all([db.all('tracks'), db.all('albums'), db.all('playlists')]);
  const ytKeys = await db.keys('ytcache');
  const ytVals = await db.all('ytcache');
  return {
    app: 'BAZINGA', version: 1, createdAt: new Date().toISOString(),
    profile: await kv.get('profile'),
    settings: await kv.get('settings'),
    player: await kv.get('player'),
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
  for (const [k, v] of data.ytcache || []) await db.put('ytcache', v, k);
  if (data.profile) await kv.set('profile', data.profile);
  if (data.settings) await kv.set('settings', data.settings);
  if (data.player) await kv.set('player', data.player);
}

async function writeInternal(snap) {
  const id = 'bk_' + Date.now();
  await db.put('backups', { id, ts: Date.now(), size: JSON.stringify(snap).length, counts: { tracks: snap.tracks.length, playlists: snap.playlists.length, albums: snap.albums.length }, data: snap });
  const all = (await db.all('backups')).sort((a, b) => b.ts - a.ts);
  for (const old of all.slice(KEEP)) await db.del('backups', old.id);
}

let fileState = 'none'; // none | ok | needs-permission | error
export const linkedFileState = () => fileState;

async function writeFile(snap) {
  const h = await kv.get('backupHandle');
  if (!h) { fileState = 'none'; return; }
  const perm = await h.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') { fileState = 'needs-permission'; emit('backup-state'); return; }
  try {
    const w = await h.createWritable();
    await w.write(JSON.stringify(snap));
    await w.close();
    fileState = 'ok';
  } catch (e) { fileState = 'error'; console.warn(e); }
}

export async function runBackup() {
  const profile = await kv.get('profile');
  if (!profile) return; // no account yet
  const snap = await snapshot();
  await writeInternal(snap);
  if (fsSupported) await writeFile(snap);
  await kv.set('lastBackup', Date.now());
  emit('backup-state');
}

const scheduled = debounce(runBackup, 4000);
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

export const listInternal = async () => (await db.all('backups')).sort((a, b) => b.ts - a.ts);
export async function restoreInternal(id) { const b = await db.get('backups', id); if (b) await restore(b.data); }
export async function restoreFromFile(file) { await restore(JSON.parse(await file.text())); }
