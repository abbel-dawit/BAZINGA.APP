// BAZINGA — on-device storage (IndexedDB). Nothing ever leaves the device.
const DB_NAME = 'bazinga';
const DB_VERSION = 2;
export const STORES = ['kv', 'tracks', 'albums', 'playlists', 'files', 'backups', 'ytcache', 'metacache'];
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) {
          db.createObjectStore(s, s === 'kv' || s === 'ytcache' || s === 'metacache' ? undefined : { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Storage is blocked in this browser (private mode?)'));
    req.onblocked = () => reject(new Error('Close other BAZINGA tabs and reload.'));
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const db = {
  get: (store, key) => open().then(d => reqP(d.transaction(store).objectStore(store).get(key))),
  all: (store) => open().then(d => reqP(d.transaction(store).objectStore(store).getAll())),
  keys: (store) => open().then(d => reqP(d.transaction(store).objectStore(store).getAllKeys())),
  put: (store, val, key) => tx(store, 'readwrite', s => { key === undefined ? s.put(val) : s.put(val, key); }),
  putMany: (store, vals) => tx(store, 'readwrite', s => { for (const v of vals) s.put(v); }),
  del: (store, key) => tx(store, 'readwrite', s => { s.delete(key); }),
  clear: (store) => tx(store, 'readwrite', s => { s.clear(); }),
  async destroy() {
    if (dbp) { (await dbp).close(); dbp = null; }
    await new Promise(res => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = r.onerror = r.onblocked = () => res(); });
  }
};

// Simple key/value helpers.
// Items in SYNC_KV travel to your other synced devices. Each change is time-stamped so devices can tell
// which copy is newer. Removing one only reaches your other devices when you asked for that
// (e.g. "Disconnect"); things that just expire on this device are never removed elsewhere.
export const SYNC_KV = ['spotifyClientId', 'spotifyToken', 'ytToken', 'ytLinks', 'ytUploads', 'taste', 'plPlays', 'mixPl'];
const SYNCED = new Set(SYNC_KV);
let stampsP = null, chain = Promise.resolve();
const kvHooks = [];
export const onSyncedKvChange = fn => kvHooks.push(fn); // sync.js: send the change to your other devices
const changedKv = k => kvHooks.forEach(f => { try { f(k); } catch { } });
const loadStamps = () => stampsP || (stampsP = db.get('kv', '__stamps').then(v => v || {}).catch(() => ({})));
function editStamps(fn) {
  chain = chain.then(async () => { const s = await loadStamps(); fn(s); await db.put('kv', s, '__stamps'); }).catch(() => { });
  return chain;
}
export const kv = {
  get: (k, dflt = null) => db.get('kv', k).then(v => v === undefined ? dflt : v),
  set: async (k, v) => { await db.put('kv', v, k); if (SYNCED.has(k)) { await editStamps(s => { s[k] = { ts: Date.now() }; }); changedKv(k); } },
  del: async (k, { everywhere = false } = {}) => {
    await db.del('kv', k);
    if (SYNCED.has(k)) { await editStamps(s => { if (everywhere) s[k] = { ts: Date.now(), del: true }; else delete s[k]; }); if (everywhere) changedKv(k); }
  },
  // for sync: read the time stamps, and write a value that came from another device (keeping its stamp)
  stamps: async () => ({ ...(await loadStamps()) }),
  putSynced: async (k, rec) => {
    if (rec.del) await db.del('kv', k); else await db.put('kv', rec.v, k);
    await editStamps(s => { s[k] = rec.del ? { ts: rec.ts, del: true } : { ts: rec.ts }; });
  }
};
