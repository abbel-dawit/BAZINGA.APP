// Optional BAZINGA! accounts, powered by Supabase (Auth + Database + Storage).
// A tiny built-in client for Supabase's documented REST APIs — no extra library to download.
// Sign-in methods: Google, Discord, email + password (with email verification and password reset).
// Uses the secure PKCE flow; sessions are kept on this device and refreshed automatically.
import { kv } from './db.js';
import { emit } from './util.js';

let URL_ = '', KEY = '';
let session = null; // {access_token, refresh_token, expires_at(ms), user}

export function configure(url, anonKey) { URL_ = (url || '').replace(/\/$/, ''); KEY = anonKey || ''; }
export const configured = () => !!(URL_ && KEY);
export const user = () => session?.user || null;
export const signedIn = () => !!session?.user;
export const redirectBase = () => location.origin + location.pathname;

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function newPkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  try { localStorage.setItem('bz_sb_verifier', verifier); } catch { }
  return challenge;
}

function errText(d, status) {
  const code = d?.error_code || d?.code || d?.error;
  const msg = d?.msg || d?.error_description || d?.message || '';
  const nice = {
    invalid_credentials: 'Wrong email or password.', invalid_grant: 'Wrong email or password.',
    email_not_confirmed: 'Please verify your email first — check your inbox (and spam folder).',
    user_already_exists: 'An account with this email already exists. Try logging in.', email_exists: 'An account with this email already exists. Try logging in.',
    weak_password: 'That password is too weak — use at least 8 characters with a mix of letters and numbers.',
    over_email_send_rate_limit: 'Too many emails were sent just now. Please wait a few minutes and try again.',
    over_request_rate_limit: 'Too many attempts. Please wait a minute and try again.',
    email_address_invalid: 'That email address doesn\'t look right.', validation_failed: msg || 'Please check the details you entered.',
    signup_disabled: 'New sign-ups are turned off right now.', provider_disabled: 'That sign-in method isn\'t turned on yet.',
    same_password: 'Your new password must be different from the old one.'
  };
  if (/invalid login credentials/i.test(msg)) return nice.invalid_credentials;
  if (/email not confirmed/i.test(msg)) return nice.email_not_confirmed;
  if (/already registered/i.test(msg)) return nice.user_already_exists;
  const e = new Error(nice[code] || msg || `Account service error (${status})`);
  e.code = code; e.status = status;
  return e.message;
}
async function req(method, path, { body, auth = false, query = {}, headers = {}, raw = false } = {}) {
  if (!configured()) throw new Error('Accounts aren\'t set up for this copy of BAZINGA! yet.');
  if (auth) await fresh();
  const q = new URLSearchParams(query).toString();
  const r = await fetch(`${URL_}${path}${q ? (path.includes('?') ? '&' : '?') + q : ''}`, {
    method,
    headers: { apikey: KEY, ...(auth && session ? { Authorization: 'Bearer ' + session.access_token } : { Authorization: 'Bearer ' + KEY }), ...(body !== undefined && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body)
  });
  if (raw) { if (!r.ok) { const d = await r.json().catch(() => ({})); const e = new Error(errText(d, r.status)); e.status = r.status; throw e; } return r; }
  const text = await r.text();
  let d = {}; try { d = text ? JSON.parse(text) : {}; } catch { d = { msg: text }; }
  if (!r.ok) { const e = new Error(errText(d, r.status)); e.status = r.status; e.code = d?.error_code || d?.code || d?.error; throw e; }
  return d;
}

async function setSession(d) {
  if (!d?.access_token) return;
  session = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in || 3600) * 1000 - 60e3, user: d.user || session?.user };
  if (!session.user) session.user = await req('GET', '/auth/v1/user', { auth: true });
  await kv.set('sbSession', session);
  emit('account', session.user);
}
let refreshing = null;
async function fresh() {
  if (!session) return;
  if (Date.now() < session.expires_at) return;
  if (!refreshing) refreshing = (async () => {
    try {
      const d = await fetch(`${URL_}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh_token }) });
      if (d.status === 400 || d.status === 401) { await clearSession(); throw new Error('Your session expired — please log in again.'); }
      if (!d.ok) throw new Error('offline');
      await setSession(await d.json());
    } finally { refreshing = null; }
  })();
  return refreshing;
}
async function clearSession() { session = null; await kv.del('sbSession'); emit('account', null); }

export async function restore() {
  const s = await kv.get('sbSession');
  if (s?.user) { session = s; emit('account', s.user); fresh().catch(() => { }); }
}

// ---------- sign-in methods ----------
export async function signInWithProvider(provider) { // 'google' | 'discord'
  if (!configured()) throw new Error('Accounts aren\'t set up for this copy of BAZINGA! yet.');
  if (!location.protocol.startsWith('http')) throw new Error('Signing in only works on the hosted (GitHub Pages) version of BAZINGA!.');
  const challenge = await newPkce();
  const p = new URLSearchParams({ provider, redirect_to: redirectBase() + '?auth=sb', code_challenge: challenge, code_challenge_method: 's256' });
  if (provider === 'google') p.set('scopes', 'email profile');
  if (provider === 'discord') p.set('scopes', 'identify email');
  location.href = `${URL_}/auth/v1/authorize?${p}`;
}
export async function signUp(email, password, username) {
  const challenge = await newPkce();
  const d = await req('POST', '/auth/v1/signup', { query: { redirect_to: redirectBase() + '?auth=sb' }, body: { email, password, data: { username }, code_challenge: challenge, code_challenge_method: 's256' } });
  if (d.access_token) { await setSession(d); return { needsVerify: false }; } // email confirmation turned off
  return { needsVerify: true };
}
export async function signInWithPassword(email, password) {
  await setSession(await req('POST', '/auth/v1/token?grant_type=password', { body: { email, password } }));
}
export async function resendVerification(email) {
  await req('POST', '/auth/v1/resend', { query: { redirect_to: redirectBase() + '?auth=sb' }, body: { type: 'signup', email } });
}
export async function sendPasswordReset(email) {
  const challenge = await newPkce();
  await req('POST', '/auth/v1/recover', { query: { redirect_to: redirectBase() + '?auth=sb&type=recovery' }, body: { email, code_challenge: challenge, code_challenge_method: 's256' } });
}
export async function updatePassword(password) {
  const u = await req('PUT', '/auth/v1/user', { auth: true, body: { password } });
  if (session) { session.user = u; await kv.set('sbSession', session); }
}
export async function signOut() {
  try { if (session) await req('POST', '/auth/v1/logout', { auth: true, query: { scope: 'local' } }); } catch { }
  await clearSession();
}

// Finish a sign-in that came back from Google/Discord or from an email link.
// Returns {kind: 'signin'|'recovery'|'verified'} or null if this page load isn't a sign-in return.
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (q.get('auth') !== 'sb') return null;
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const clean = () => history.replaceState(null, '', redirectBase() + (location.hash.startsWith('#/') ? location.hash : '#/home'));
  const err = q.get('error_description') || hash.get('error_description') || q.get('error') || hash.get('error');
  if (err) { clean(); throw new Error(/expired|invalid/i.test(err) ? 'That link has expired or was already used. Request a new one.' : err.replace(/\+/g, ' ')); }
  const code = q.get('code');
  const type = q.get('type');
  let verifier = null; try { verifier = localStorage.getItem('bz_sb_verifier'); } catch { }
  if (!code) {
    // Older-style link that puts the session in the URL hash
    if (hash.get('access_token')) { await setSession({ access_token: hash.get('access_token'), refresh_token: hash.get('refresh_token'), expires_in: +hash.get('expires_in') || 3600 }); clean(); return { kind: hash.get('type') === 'recovery' ? 'recovery' : 'signin' }; }
    clean(); return null;
  }
  try {
    if (!verifier) throw Object.assign(new Error('no verifier'), { noVerifier: true });
    const d = await req('POST', '/auth/v1/token?grant_type=pkce', { body: { auth_code: code, code_verifier: verifier } });
    try { localStorage.removeItem('bz_sb_verifier'); } catch { }
    await setSession(d);
    clean();
    return { kind: type === 'recovery' ? 'recovery' : 'signin' };
  } catch (e) {
    clean();
    // The email was verified, but the link was opened on a different device/browser than sign-up
    if (e.noVerifier || /verifier|flow state/i.test(e.message)) return { kind: 'verified' };
    throw e;
  }
}

// ---------- database (profiles) ----------
export async function getProfile() {
  const rows = await req('GET', '/rest/v1/profiles', { auth: true, query: { id: 'eq.' + user().id, select: '*' } });
  return rows[0] || null;
}
export async function saveProfile(patch) {
  const rows = await req('POST', '/rest/v1/profiles', { auth: true, headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: { id: user().id, ...patch, updated_at: new Date().toISOString() } });
  return rows[0];
}
// Public (signed-out) read, e.g. the tippers leaderboard
export async function publicRpc(fn, args = {}) { return req('POST', '/rest/v1/rpc/' + fn, { body: args }); }
export async function rpc(fn, args = {}) { return req('POST', '/rest/v1/rpc/' + fn, { auth: true, body: args }); }

// ---------- storage (the synced library file) ----------
export async function uploadFile(bucket, path, blob) {
  return req('POST', `/storage/v1/object/${bucket}/${path}`, { auth: true, body: blob, headers: { 'x-upsert': 'true', 'Content-Type': blob.type || 'application/octet-stream', 'cache-control': 'no-cache' } });
}
export async function downloadFile(bucket, path) {
  const r = await req('GET', `/storage/v1/object/authenticated/${bucket}/${path}`, { auth: true, raw: true });
  return r.blob();
}
export async function deleteFiles(bucket, paths) {
  if (!paths.length) return;
  return req('DELETE', `/storage/v1/object/${bucket}`, { auth: true, body: { prefixes: paths } });
}
export async function listFiles(bucket, prefix) {
  return req('POST', `/storage/v1/object/list/${bucket}`, { auth: true, body: { prefix, limit: 100, offset: 0 } });
}
