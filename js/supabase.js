/**
 * supabase.js — a small, dependency-free client.
 *
 * Deliberately hand-written rather than pulling in supabase-js. The whole
 * front end is a static site with no build step and no external requests, and
 * loading a library from a CDN would break both of those — as well as adding a
 * third party to the list a school's data protection lead has to be told about.
 *
 * We only need a fraction of the API: send a sign-in code, exchange it for a
 * session, refresh it, and read and write rows.
 *
 * ON WHERE THE TOKEN LIVES
 * The session token is kept in localStorage, which is what any browser-to-
 * Supabase application does. An httpOnly cookie would be stronger against a
 * cross-site scripting bug, but that requires every request to be proxied
 * through our own server — a different architecture, and the one the SaaS plan
 * describes. Two things make this acceptable here: the app escapes every piece
 * of user content it renders (there are tests for it), and Row Level Security
 * means a stolen token exposes that one user's school and nothing else.
 */

const cfg = () => (typeof window !== 'undefined' && window.QLA_CONFIG) || {};

/** The project URL, with any trailing path or slash removed. */
export function projectUrl() {
  const raw = String(cfg().supabaseUrl || '').trim();
  // People paste the REST endpoint from the dashboard; take the origin.
  return raw.replace(/\/+$/, '').replace(/\/(rest|auth)\/v1$/, '');
}

export function anonKey() {
  return String(cfg().supabaseAnonKey || '').trim();
}

export function isConfigured() {
  return Boolean(projectUrl() && anonKey());
}

/* --- Session ------------------------------------------------------------- */

const SESSION_KEY = 'qla.session.v1';
let session = null;

function readStoredSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeSession(value) {
  session = value;
  try {
    if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* private browsing — the session lasts this tab only */ }
}

export function currentSession() {
  if (!session) session = readStoredSession();
  return session;
}

export function currentUser() {
  return currentSession()?.user || null;
}

/** Sessions are refreshed a minute early, so a request never races expiry. */
function isExpired(value) {
  if (!value?.expires_at) return true;
  return Date.now() >= (value.expires_at * 1000) - 60_000;
}

/* --- HTTP ---------------------------------------------------------------- */

class SupabaseError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'SupabaseError';
    this.status = status;
    this.details = details;
  }
}

async function call(path, { method = 'GET', body, headers = {}, auth = true, raw = false } = {}) {
  if (!isConfigured()) {
    throw new SupabaseError('The database is not configured. Add supabaseUrl and supabaseAnonKey to config.js.', 0);
  }

  const token = auth ? (await accessToken()) : null;
  const response = await fetch(`${projectUrl()}${path}`, {
    method,
    headers: {
      apikey: anonKey(),
      Authorization: `Bearer ${token || anonKey()}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return null;

  let payload = null;
  try { payload = await response.json(); } catch { /* empty body */ }

  if (!response.ok) {
    const message = payload?.msg || payload?.message || payload?.error_description
      || payload?.error || `The database returned ${response.status}.`;
    throw new SupabaseError(message, response.status, payload);
  }
  return raw ? { payload, response } : payload;
}

/* --- Authentication ------------------------------------------------------ */

/**
 * Send a one-time code to a school email address.
 *
 * `create_user: true` looks alarming and is not. It is what lets a teacher
 * sign in for the first time without an administrator creating their account
 * by hand — sixty of those is a job nobody will do, and a job nobody does is a
 * school that never starts using the tool.
 *
 * What actually decides who gets in is the Before User Created hook in
 * 0002_access.sql: an address that is not on the school's staff list is
 * refused before an account exists. And if that hook were switched off, an
 * account with no membership row still reads nothing, because every policy
 * goes through app_org_ids(). The gate is the staff list, in the database,
 * not this flag in the browser.
 */
export async function sendSignInCode(email) {
  await call('/auth/v1/otp', {
    method: 'POST',
    auth: false,
    body: { email: String(email).trim().toLowerCase(), create_user: true },
  });
  return true;
}

/** Exchange the emailed code for a session. */
export async function verifySignInCode(email, token) {
  const result = await call('/auth/v1/verify', {
    method: 'POST',
    auth: false,
    body: { email: String(email).trim().toLowerCase(), token: String(token).trim(), type: 'email' },
  });
  writeSession(normaliseSession(result));
  return currentUser();
}

function normaliseSession(result) {
  if (!result?.access_token) return null;
  return {
    access_token: result.access_token,
    refresh_token: result.refresh_token,
    // GoTrue returns expires_in on some paths and expires_at on others.
    expires_at: result.expires_at
      || Math.floor(Date.now() / 1000) + Number(result.expires_in || 3600),
    user: result.user ? { id: result.user.id, email: result.user.email } : null,
  };
}

let refreshing = null;

/** A valid access token, refreshing first if the current one is near expiry. */
export async function accessToken() {
  let value = currentSession();
  if (!value) return null;

  // Another tab may have refreshed already. Supabase rotates refresh tokens,
  // so spending ours when theirs is newer would invalidate one of the two and
  // sign that tab out mid-marksheet. Take whatever is in storage first.
  if (isExpired(value)) {
    const stored = readStoredSession();
    if (stored && !isExpired(stored)) { session = stored; value = stored; }
  }

  if (!isExpired(value)) return value.access_token;
  if (!value.refresh_token) { writeSession(null); return null; }

  // One refresh at a time, however many requests are waiting on it.
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const result = await call('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST', auth: false, body: { refresh_token: value.refresh_token },
        });
        writeSession(normaliseSession(result));
        return currentSession()?.access_token || null;
      } catch {
        writeSession(null);      // refresh failed: the user must sign in again
        return null;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

export async function signOut() {
  try { await call('/auth/v1/logout', { method: 'POST' }); } catch { /* going anyway */ }
  writeSession(null);
}

/* --- Rows ---------------------------------------------------------------- */

const encode = (value) => encodeURIComponent(String(value));

/**
 * @param {string} table
 * @param {object} options  { select, eq, order, limit, single }
 */
export async function selectRows(table, { select = '*', eq = {}, order, limit, single = false } = {}) {
  const params = [`select=${encode(select)}`];
  for (const [column, value] of Object.entries(eq)) {
    params.push(`${encode(column)}=eq.${encode(value)}`);
  }
  if (order) params.push(`order=${encode(order)}`);
  if (limit) params.push(`limit=${encode(limit)}`);

  const rows = await call(`/rest/v1/${encode(table)}?${params.join('&')}`);
  return single ? (Array.isArray(rows) ? rows[0] || null : rows) : (rows || []);
}

export async function insertRows(table, rows, { upsert = false, onConflict } = {}) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return [];
  const query = onConflict ? `?on_conflict=${encode(onConflict)}` : '';
  return call(`/rest/v1/${encode(table)}${query}`, {
    method: 'POST',
    body: list,
    headers: {
      Prefer: `return=representation${upsert ? ',resolution=merge-duplicates' : ''}`,
    },
  }) || [];
}

/**
 * Call a database function.
 *
 * Used for the things that must not be decided in the browser — linking a
 * sign-in to a school, for instance, which reads the address from auth.users
 * rather than trusting whatever the caller says it is.
 */
export async function rpc(name, args = {}) {
  return call(`/rest/v1/rpc/${encode(name)}`, { method: 'POST', body: args });
}

export async function updateRows(table, match, changes) {
  const params = Object.entries(match).map(([c, v]) => `${encode(c)}=eq.${encode(v)}`);
  return call(`/rest/v1/${encode(table)}?${params.join('&')}`, {
    method: 'PATCH', body: changes, headers: { Prefer: 'return=representation' },
  }) || [];
}

export async function deleteRows(table, match) {
  const params = Object.entries(match).map(([c, v]) => `${encode(c)}=eq.${encode(v)}`);
  await call(`/rest/v1/${encode(table)}?${params.join('&')}`, { method: 'DELETE' });
}

export { SupabaseError };
