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
   * the endpoint directly regardless. The signed-in session is what actually
   * gates this API; CORS only stops OTHER websites using your browser session.
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
