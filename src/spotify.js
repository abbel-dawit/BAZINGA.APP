// Spotify import (Liked Songs + playlists). Runs 100% in the browser using
// OAuth PKCE with the user's OWN free Spotify developer Client ID, so there is
// no shared server and no shared request limit. Tokens stay on the device.
import { kv } from './db.js';
import { trackKey, albumKey, yearOf, sleep } from './util.js';

const SCOPES = 'user-library-read playlist-read-private playlist-read-collaborative';
export const redirectUri = () => location.origin + location.pathname;

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function login(clientId) {
  if (!location.protocol.startsWith('http')) throw new Error('Spotify login only works on the hosted (GitHub Pages) version of BAZINGA.');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem('bz_sp_verifier', verifier);
  sessionStorage.setItem('bz_sp_state', state);
  await kv.set('spotifyClientId', clientId);
  const p = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri(),
    code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state
  });
  location.href = 'https://accounts.spotify.com/authorize?' + p;
}

// Call on startup: completes the login if we just came back from Spotify.
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (q.get('auth') === 'sb') return false; // that's a BAZINGA! account sign-in, not Spotify
  if (!q.get('code') && !q.get('error')) return false;
  const clean = () => history.replaceState(null, '', redirectUri() + location.hash);
  if (q.get('error')) { clean(); throw new Error('Spotify login was cancelled.'); }
  if (q.get('state') !== sessionStorage.getItem('bz_sp_state')) { clean(); throw new Error('Spotify login expired — please try again.'); }
  const clientId = await kv.get('spotifyClientId');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, grant_type: 'authorization_code', code: q.get('code'),
      redirect_uri: redirectUri(), code_verifier: sessionStorage.getItem('bz_sp_verifier')
    })
  });
  clean();
  if (!r.ok) throw new Error('Spotify login failed (' + r.status + '). Check the Redirect URI in your Spotify app.');
  await saveToken(await r.json());
  return true;
}

async function saveToken(t) {
  const prev = (await kv.get('spotifyToken')) || {};
  await kv.set('spotifyToken', {
    access: t.access_token, refresh: t.refresh_token || prev.refresh,
    expires: Date.now() + (t.expires_in - 60) * 1000
  });
}

async function token() {
  const t = await kv.get('spotifyToken');
  if (!t) throw new Error('Not connected to Spotify.');
  if (Date.now() < t.expires) return t.access;
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: await kv.get('spotifyClientId') })
  });
  if (!r.ok) { await kv.del('spotifyToken'); throw new Error('Spotify session expired — reconnect.'); }
  await saveToken(await r.json());
  return (await kv.get('spotifyToken')).access;
}

export const isConnected = async () => !!(await kv.get('spotifyToken'));
export const disconnect = () => kv.del('spotifyToken');

async function api(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(url.startsWith('http') ? url : 'https://api.spotify.com/v1' + url, {
      headers: { Authorization: 'Bearer ' + await token() }
    });
    if (r.status === 429) { await sleep((+r.headers.get('Retry-After') || 2) * 1000); continue; }
    if (!r.ok) { const e = new Error('Spotify ' + r.status); e.status = r.status; throw e; }
    return r.json();
  }
  throw new Error('Spotify is rate-limiting — try again in a minute.');
}

// Follow `next` links, trying a big page size first and smaller ones if Spotify refuses.
async function paged(path, onPage) {
  let out = [];
  for (const limit of [50, 20, 10]) {
    try {
      let url = path + (path.includes('?') ? '&' : '?') + 'limit=' + limit;
      out = [];
      while (url) {
        const d = await api(url);
        out.push(...(d.items || []));
        onPage?.(out.length, d.total);
        url = d.next;
      }
      return out;
    } catch (e) { if (e.status !== 400) throw e; }
  }
  return out;
}

export function toTrack(t, addedAt) {
  if (!t || t.type === 'episode' || !t.name) return null;
  const artists = (t.artists || []).map(a => a.name);
  const artist = artists[0] || '';
  const al = t.album || {};
  return {
    id: trackKey(artist, t.name),
    title: t.name, artist, artists,
    album: al.name || '',
    albumId: al.name ? albumKey((al.artists?.[0]?.name) || artists[0], al.name) : '',
    spotifyId: t.id || null, spotifyAlbumId: al.id || null,
    releaseDate: al.release_date || '', year: yearOf(al.release_date),
    durationMs: t.duration_ms || 0,
    artwork: al.images?.[0]?.url || '',
    explicit: !!t.explicit,
    trackNumber: t.track_number || 0,
    addedAt: addedAt ? Date.parse(addedAt) : Date.now()
  };
}

export async function likedSongs(onProgress) {
  const items = await paged('/me/tracks', onProgress);
  return items.map(i => toTrack(i.track || i.item, i.added_at)).filter(Boolean);
}

export async function playlists() {
  const items = await paged('/me/playlists');
  return items.filter(Boolean).map(p => ({
    spotifyId: p.id, name: p.name, image: p.images?.[0]?.url || '',
    total: (p.items || p.tracks)?.total ?? null, owner: p.owner?.display_name || ''
  }));
}

export async function playlistTracks(id, onProgress) {
  let items;
  try { items = await paged(`/playlists/${id}/items`, onProgress); }
  catch (e) {
    if (e.status === 404 || e.status === 403) items = await paged(`/playlists/${id}/tracks`, onProgress);
    else throw e;
  }
  return items.map(i => toTrack(i.item || i.track, i.added_at)).filter(Boolean);
}
