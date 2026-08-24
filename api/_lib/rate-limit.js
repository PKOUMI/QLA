/**
 * rate-limit.js — a token bucket held in the function's memory.
 *
 * LIMITATION, stated plainly: serverless instances are created and destroyed at
 * will and are not shared, so this limits each warm instance rather than the
 * whole service. It stops runaway loops and casual abuse; it is not a defence
 * against a determined attacker.
 *
 * Before commercial use, replace the Map with Upstash Redis — the interface
 * below is deliberately small so that swap is a few lines.
 */

const buckets = new Map();
const WINDOW_MS = 60 * 1000;

/** Also caps how many emails one deployment can send per hour, as a safety net. */
const hourly = { windowStart: Date.now(), count: 0 };

export function clientKey(req) {
  const forwarded = req.headers['x-forwarded-for'] || '';
  return String(forwarded).split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

/**
 * @returns {{ok: boolean, retryAfter: number, remaining: number}}
 */
export function checkRateLimit(key, limit = Number(process.env.RATE_LIMIT_PER_MINUTE || 40)) {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    buckets.set(key, { windowStart: now, count: 1 });
    cleanup(now);
    return { ok: true, retryAfter: 0, remaining: limit - 1 };
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    return {
      ok: false,
      retryAfter: Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000),
      remaining: 0,
    };
  }
  return { ok: true, retryAfter: 0, remaining: limit - bucket.count };
}

/** Hard ceiling on emails per hour for the whole deployment. */
export function checkHourlyEmailCap(count) {
  // A whole year group sitting a core subject is 400 pupils, and their
  // parents doubles it. 500 an hour refused that; 5000 does not.
  const cap = Number(process.env.MAX_EMAILS_PER_HOUR || 5000);
  const now = Date.now();
  if (now - hourly.windowStart > 60 * 60 * 1000) {
    hourly.windowStart = now;
    hourly.count = 0;
  }
  if (hourly.count + count > cap) {
    return { ok: false, cap, used: hourly.count };
  }
  hourly.count += count;
  return { ok: true, cap, used: hourly.count };
}

function cleanup(now) {
  if (buckets.size < 500) return;
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > WINDOW_MS * 5) buckets.delete(key);
  }
}

/* --- Idempotency --------------------------------------------------------- */

const seen = new Map();
const IDEMPOTENCY_TTL_MS = 30 * 60 * 1000;

/**
 * Remember the outcome of a request key so an accidental repeat (double click,
 * a retry after a timeout) returns the original result instead of sending again.
 * Same limitation as above: per-instance memory. Move to Redis for production.
 */
export function rememberIdempotency(key, value) {
  seen.set(key, { value, at: Date.now() });
  if (seen.size > 1000) {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [k, entry] of seen) if (entry.at < cutoff) seen.delete(k);
  }
}

export function recallIdempotency(key) {
  const entry = seen.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > IDEMPOTENCY_TTL_MS) { seen.delete(key); return null; }
  return entry.value;
}
