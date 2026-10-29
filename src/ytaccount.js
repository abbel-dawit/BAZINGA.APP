// YouTube account sync: save BAZINGA! playlists to the user's YouTube account and
// import their YouTube playlists back (a second backup of their music).
//
// Uses Google's own sign-in popup (Google Identity Services) in the browser — no server.
// The access token lives only in memory/this device and expires after about an hour.
//
// YouTube limits (per Google sign-in key, per day): 10,000 "units".
//   create playlist = 50, add one song = 50, read 50 songs = 1.
//   → about 200 songs can be added per day per key. Uploads that hit the limit pause and
//     can be resumed the next day (Google resets the quota at midnight Pacific time).
import { kv } from './db.js';
import { sleep, emit } from './util.js';

const SCOPE = 'https://www.googleapis.com/auth/youtube';
const API = 'https://www.googleapis.com/youtube/v3/';
let clientId = '';
let token = null; // {access, expires}

export function setGoogleClientId(id) { clientId = (id || '').trim(); }
export const configured = () => !!clientId;
export const signedIn = () => !!token && Date.now() < token.expires;

let gisP = null;
function loadGIS() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisP) return gisP;
  gisP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => res(); s.onerror = () => { gisP = null; rej(new Error('Couldn\'t load Google sign-in. Check your connection.')); };
    document.head.appendChild(s);
  });
  return gisP;
}

export async function restoreSession() {
  const t = await kv.get('ytToken');
  if (t && Date.now() < t.expires) token = t;
}

// Must be called from a click (browsers block popups otherwise)
export async function signIn({ prompt = '' } = {}) {
  if (!clientId) throw new Error('YouTube sign-in isn\'t set up yet. See Settings → YouTube account.');
  if (!location.protocol.startsWith('http')) throw new Error('YouTube sign-in only works on the hosted (GitHub Pages) version of BAZINGA!.');
  await loadGIS();
  return new Promise((resolve, reject) => {
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: SCOPE,
      callback: async r => {
        if (r.error) return reject(new Error(r.error === 'access_denied' ? 'YouTube access was not allowed.' : 'Google sign-in failed: ' + r.error));
        token = { access: r.access_token, expires: Date.now() + (r.expires_in - 60) * 1000 };
        await kv.set('ytToken', token);
        emit('yt-account');
        resolve(token);
      },
      error_callback: e => reject(new Error(e?.type === 'popup_closed' ? 'Sign-in window was closed.' : e?.type === 'popup_failed_to_open' ? 'Your browser blocked the sign-in popup — allow popups for this site.' : 'Google sign-in failed.'))
    });
    tc.requestAccessToken({ prompt });
  });
}
export async function signOut() {
  try { if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token.access, () => { }); } catch { }
  token = null; await kv.del('ytToken'); emit('yt-account');
}

class QuotaError extends Error { constructor() { super('YouTube\'s daily limit for this app has been reached. Your upload is saved — tap "Resume" tomorrow (limits reset at midnight Pacific time), or add your own Google key in Settings for your own limit.'); this.quota = true; } }

async function api(method, path, { params = {}, body } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!signedIn()) await signIn();
    const r = await fetch(API + path + '?' + new URLSearchParams(params), {
      method, headers: { Authorization: 'Bearer ' + token.access, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (r.status === 401) { token = null; await kv.del('ytToken'); continue; }
    const d = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (r.ok) return d;
    const reason = d?.error?.errors?.[0]?.reason || '';
    if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded/.test(reason)) {
      if (reason === 'rateLimitExceeded' && attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
      throw new QuotaError();
    }
    if (r.status === 409 && attempt < 2) { await sleep(800); continue; } // YouTube busy with the previous insert
    if (reason === 'youtubeSignupRequired') throw new Error('This Google account doesn\'t have a YouTube channel yet. Open youtube.com, create your channel, then try again.');
    if (reason === 'videoNotFound' || reason === 'forbidden' && path === 'playlistItems') { const e = new Error('skip'); e.skip = true; throw e; }
    throw new Error(d?.error?.message || `YouTube error ${r.status}`);
  }
  throw new Error('Couldn\'t sign in to YouTube.');
}

async function allPages(path, params, map) {
  const out = []; let pageToken = '';
  do {
    const d = await api('GET', path, { params: { ...params, maxResults: 50, ...(pageToken ? { pageToken } : {}) } });
    out.push(...(d.items || []).map(map).filter(Boolean));
    pageToken = d.nextPageToken || '';
  } while (pageToken && out.length < 5000);
  return out;
}

// ---------- reading ----------
export async function myPlaylists() {
  const lists = await allPages('playlists', { part: 'snippet,contentDetails', mine: true }, p => ({
    id: p.id, title: p.snippet.title, count: p.contentDetails?.itemCount ?? null, image: p.snippet.thumbnails?.medium?.url || ''
  }));
  try {
    const ch = await api('GET', 'channels', { params: { part: 'contentDetails', mine: true } });
    const likes = ch.items?.[0]?.contentDetails?.relatedPlaylists?.likes;
    if (likes) lists.unshift({ id: likes, title: 'Liked videos', count: null, image: '', liked: true });
  } catch { }
  return lists;
}
export async function playlistVideos(id) {
  return allPages('playlistItems', { part: 'snippet,contentDetails', playlistId: id }, it => {
    const vid = it.contentDetails?.videoId || it.snippet?.resourceId?.videoId;
    if (!vid || /^(Deleted|Private) video$/.test(it.snippet?.title || '')) return null;
    return { id: vid, title: it.snippet.title, author: it.snippet.videoOwnerChannelTitle || '' };
  });
}

// ---------- writing ----------
export async function createPlaylist(title, description, privacy = 'private') {
  const d = await api('POST', 'playlists', { params: { part: 'snippet,status' }, body: { snippet: { title: title.slice(0, 150), description: description.slice(0, 4900) }, status: { privacyStatus: privacy } } });
  return d.id;
}
export async function existingVideoIds(playlistId) {
  try { return new Set((await playlistVideos(playlistId)).map(v => v.id)); }
  catch (e) { if (/not ?found/i.test(e.message)) return null; throw e; }
}

// Upload job, resumable. job = {key, title, ytPlaylistId, videoIds, done, privacy, created}
export async function runUpload(job, { onProgress, isCancelled } = {}) {
  if (!job.ytPlaylistId) {
    job.ytPlaylistId = await createPlaylist(job.title, 'Made with BAZINGA! ⚡', job.privacy);
    await saveJob(job);
  }
  let skipped = job.skipped || 0;
  while (job.done < job.videoIds.length) {
    if (isCancelled?.()) break;
    const videoId = job.videoIds[job.done];
    try {
      await api('POST', 'playlistItems', { params: { part: 'snippet' }, body: { snippet: { playlistId: job.ytPlaylistId, resourceId: { kind: 'youtube#video', videoId } } } });
    } catch (e) {
      if (!e.skip) { await saveJob(job); throw e; }
      skipped++; job.skipped = skipped;
    }
    job.done++;
    if (job.done % 5 === 0) await saveJob(job);
    onProgress?.(job.done, job.videoIds.length);
    await sleep(120); // YouTube rejects inserts into the same playlist that arrive too close together
  }
  if (job.done >= job.videoIds.length) await clearJob(job.key); else await saveJob(job);
  return { url: 'https://www.youtube.com/playlist?list=' + job.ytPlaylistId, skipped, finished: job.done >= job.videoIds.length };
}
export const pendingJobs = async () => (await kv.get('ytUploads')) || {};
async function saveJob(job) { const all = await pendingJobs(); all[job.key] = job; await kv.set('ytUploads', all); emit('yt-account'); }
async function clearJob(key) { const all = await pendingJobs(); delete all[key]; await kv.set('ytUploads', all); emit('yt-account'); }
export const dropJob = clearJob;

// Units this upload will use (so we can tell the user before starting)
export const unitsFor = (n, newPlaylist) => n * 50 + (newPlaylist ? 50 : 0);
