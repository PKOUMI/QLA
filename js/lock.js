/**
 * lock.js — the Setup lock.
 *
 * WHAT THIS IS: a way for whoever sets up an assessment to stop colleagues
 * changing questions, boundaries or the pupil list while marks are being
 * entered. Changing the maximum marks halfway through a marking session
 * silently invalidates every total, so this is a real safeguard against a
 * common and expensive mistake.
 *
 * WHAT THIS IS NOT: security. The PIN is checked in the browser, so anyone who
 * knows how to open developer tools can get past it. It protects against
 * accident, not against a determined person. Genuine per-user permissions
 * arrive with staff accounts and a server, where the check happens somewhere
 * the user cannot edit — see ARCHITECTURE.md.
 */

/** Whether Setup is currently editable in THIS browser session. */
let unlockedThisSession = true;

const encoder = new TextEncoder();

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Salted SHA-256. Salt stops two assessments with PIN 1234 sharing a hash. */
export async function hashPin(pin, salt) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${salt}:${pin}`));
  return toHex(digest);
}

export function randomSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return toHex(bytes.buffer);
}

export function isLockEnabled(assessment) {
  return Boolean(assessment?.settings?.lock?.enabled);
}

/**
 * Can the current user edit Setup (and the email wording)?
 * True when no lock is set, or when they have entered the PIN this session.
 */
export function canEdit(assessment) {
  return !isLockEnabled(assessment) || unlockedThisSession;
}

/** True when a lock exists and the user has not unlocked it. */
export function isLocked(assessment) {
  return isLockEnabled(assessment) && !unlockedThisSession;
}

export function setSessionUnlocked(value) {
  unlockedThisSession = Boolean(value);
}

/** Turn the lock on. Returns the fields to save on the assessment. */
export async function buildLock(pin) {
  const salt = randomSalt();
  return { enabled: true, salt, pinHash: await hashPin(pin, salt) };
}

export async function pinMatches(assessment, pin) {
  const lock = assessment?.settings?.lock;
  if (!lock?.enabled || !lock.pinHash || !lock.salt) return false;
  const candidate = await hashPin(pin, lock.salt);
  // Constant-ish time compare. Not meaningful client-side, but costs nothing.
  if (candidate.length !== lock.pinHash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i += 1) {
    diff |= candidate.charCodeAt(i) ^ lock.pinHash.charCodeAt(i);
  }
  return diff === 0;
}

export function validatePin(pin) {
  if (!/^\d{4,8}$/.test(String(pin || ''))) {
    return 'Choose a PIN of 4 to 8 digits.';
  }
  return null;
}
