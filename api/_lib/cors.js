/**
 * CORS — an allowlist, not a wildcard.
 *
 * `Access-Control-Allow-Origin: *` would let any website on the internet make
 * a browser call your endpoint. Set ALLOWED_ORIGINS to your own sites only.
 */

function allowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export function applyCors(req, res) {
  const list = allowedOrigins();
  const origin = (req.headers.origin || '').replace(/\/$/, '');

  /*
   * No Origin header means this is NOT a cross-site browser request: either
   * same-origin (the app served from this same domain), or a non-browser
   * caller like curl. Blocking those adds no security — a browser cannot be
   * tricked into omitting Origin on a cross-origin fetch, and anyone can call
   * the endpoint directly regardless. The shared key is what actually gates
   * this API; CORS only stops OTHER websites using your browser session.
   *
   * It did add confusion: serving the app from the API's own domain failed
   * with "origin not allowed" while naming no origin at all.
   */
  const sameOriginOrDirect = origin === '';
  const isAllowed = sameOriginOrDirect || (list.length > 0 && list.includes(origin));

  // Only echo an Origin back when there was one. Nothing to allow otherwise.
  if (isAllowed && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  // Without this the browser hides Retry-After from cross-origin responses, so
  // the app cannot honour the wait a rate limiter asks for and backs off blindly.
  res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-QLA-Key');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(isAllowed ? 204 : 403).end();
    return { handled: true, isAllowed };
  }

  return {
    handled: false,
    isAllowed,
    origin,
    configured: list.length > 0,
    // The COUNT only, never the values. Enough to tell "the variable never
    // reached this deployment" apart from "the value is wrong", which is the
    // one distinction that matters when CORS is refusing you.
    allowedCount: list.length,
  };
}

/**
 * Shared-secret check. See ARCHITECTURE.md §6 — this is not real auth.
 *
 * Both sides are trimmed. Pasting a generated key into a dashboard field picks
 * up a trailing newline or space remarkably easily, and an invisible character
 * causing an authentication failure is a miserable thing to debug.
 */
export function checkSharedKey(req) {
  const expected = (process.env.APP_SHARED_KEY || '').trim();
  const provided = String(req.headers['x-qla-key'] || '').trim();

  if (!expected) return { ok: true, skipped: true, required: false }; // not configured = open

  return {
    ok: timingSafeEqual(provided, expected),
    skipped: false,
    required: true,
    provided: provided.length > 0,
    // The caller's own input, so echoing it reveals nothing they do not have.
    // Enough to spot a truncated or empty paste at a glance.
    providedLength: provided.length,
  };
}

/** Constant-time compare so the key can't be guessed a character at a time. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
