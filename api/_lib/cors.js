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

  // With no list configured, refuse browser calls rather than allowing all.
  const isAllowed = list.length > 0 && list.includes(origin);

  if (isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-QLA-Key');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(isAllowed ? 204 : 403).end();
    return { handled: true, isAllowed };
  }

  return { handled: false, isAllowed, origin, configured: list.length > 0 };
}

/** Shared-secret check. See ARCHITECTURE.md §6 — this is not real auth. */
export function checkSharedKey(req) {
  const expected = process.env.APP_SHARED_KEY || '';
  if (!expected) return { ok: true, skipped: true }; // not configured = open
  const provided = req.headers['x-qla-key'] || '';
  return { ok: timingSafeEqual(String(provided), expected), skipped: false };
}

/** Constant-time compare so the key can't be guessed a character at a time. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
