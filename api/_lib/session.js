/**
 * Who is calling?
 *
 * This replaces the shared access key. That key was always a speed bump: one
 * secret, typed into every teacher's browser by hand, that nobody could revoke
 * without visiting every teacher again. It also meant a Settings screen asking
 * a teacher to paste something they should never have had to know about.
 *
 * Now the caller sends the session they already have from signing in, and the
 * server asks Supabase whether it is real. Nothing to configure per browser,
 * nothing to copy, and access ends the moment somebody is removed from the
 * school's staff list.
 *
 * Verification is a call to Supabase rather than checking the token's
 * signature here. That costs one round trip per batch of up to fifty emails —
 * unmeasurable next to sending them — and it buys something worth having: a
 * token that has been revoked, or belongs to a deleted account, is refused,
 * which signature checking alone would happily accept until it expired.
 */

const SUPABASE_URL = () => (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_ANON_KEY = () => (process.env.SUPABASE_ANON_KEY || '').trim();

export function sessionConfigured() {
  return Boolean(SUPABASE_URL() && SUPABASE_ANON_KEY());
}

function bearer(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

/**
 * @returns {Promise<{ok: boolean, user?: {id, email}, reason?: string}>}
 */
export async function verifySession(req) {
  if (!sessionConfigured()) {
    return { ok: false, reason: 'server-not-configured' };
  }

  const token = bearer(req);
  if (!token) return { ok: false, reason: 'no-token' };

  let response;
  try {
    response = await fetch(`${SUPABASE_URL()}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY(), Authorization: `Bearer ${token}` },
    });
  } catch {
    // Supabase unreachable. Refusing is the only safe answer, but say which
    // side failed so nobody spends an afternoon on the wrong one.
    return { ok: false, reason: 'verifier-unreachable' };
  }

  if (!response.ok) return { ok: false, reason: 'invalid-session' };

  const user = await response.json().catch(() => null);
  if (!user?.id) return { ok: false, reason: 'invalid-session' };

  return { ok: true, user: { id: user.id, email: user.email } };
}

/** What to tell the caller, in words they can act on. */
export function describeSessionFailure(reason) {
  switch (reason) {
    case 'server-not-configured':
      return 'This server cannot check who is signed in: SUPABASE_URL and SUPABASE_ANON_KEY are not set on the API deployment. Add them and redeploy.';
    case 'no-token':
      return 'You are not signed in. Reload the page, sign in, and try again.';
    case 'verifier-unreachable':
      return 'The server could not reach Supabase to check your sign-in. Nothing was sent. Try again in a moment.';
    default:
      return 'Your sign-in has expired. Reload the page and sign in again — nothing was sent.';
  }
}
