/**
 * validate.js — server-side validation of the request body.
 *
 * The browser validates too, but browser validation is a convenience for the
 * user, not a security control: anyone can POST to this endpoint directly.
 * Everything is re-checked and re-bounded here.
 */

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[A-Za-z]{2,}$/;

export const LIMITS = {
  // A core-subject year group can be 400 pupils. The old limit of 25 turned
  // that into 32 requests, which the rate limiter then refused.
  maxMessagesPerRequest: 100,
  maxQuestions: 200,
  maxTopicLength: 120,
  maxNameLength: 100,
  maxNoteLength: 1000,
  maxListItems: 40,
  maxBodyBytes: 512 * 1024,
};

export function isEmail(value) {
  return typeof value === 'string' && value.trim().length <= 254 && EMAIL_RE.test(value.trim());
}

function str(value, maxLength) {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, maxLength).trim();
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function httpUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.href.slice(0, 500);
  } catch {
    return '';
  }
}

/**
 * Validate and normalise the whole request.
 * Returns { ok: true, value } or { ok: false, error }.
 *
 * Note what is NOT accepted: raw HTML, subject lines, sender addresses,
 * attachments or arbitrary recipients beyond the message list. That is what
 * keeps this endpoint from being usable as a general-purpose mail relay.
 */
export function validateRequest(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Request body must be JSON.' };

  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) return { ok: false, error: 'No messages supplied.' };
  if (messages.length > LIMITS.maxMessagesPerRequest) {
    return { ok: false, error: `Too many messages in one request (max ${LIMITS.maxMessagesPerRequest}).` };
  }

  const replyTo = isEmail(body.replyTo) ? String(body.replyTo).trim() : '';
  const clean = [];

  for (const [index, message] of messages.entries()) {
    if (!message || typeof message !== 'object') {
      return { ok: false, error: `Message ${index + 1} is not an object.` };
    }
    const type = message.type === 'parent' ? 'parent' : 'pupil';
    const to = String(message.to || '').trim();
    if (!isEmail(to)) return { ok: false, error: `Message ${index + 1}: "${to}" is not a valid email address.` };

    const data = message.data;
    if (!data || typeof data !== 'object') {
      return { ok: false, error: `Message ${index + 1} has no feedback data.` };
    }

    const rows = Array.isArray(data.rows) ? data.rows.slice(0, LIMITS.maxQuestions) : [];

    clean.push({
      id: str(message.id, 80) || `msg_${index}`,
      type,
      to,
      // Wording for THIS pupil only, when their email has been edited
      // individually. Falls back to the assessment-wide wording below.
      text: toWording(message.text),
      data: {
        pupilName: str(data.pupilName, LIMITS.maxNameLength) || 'Student',
        examName: str(data.examName, LIMITS.maxNameLength) || 'Assessment',
        subject: str(data.subject, LIMITS.maxNameLength),
        examDate: str(data.examDate, 30),
        totalMarks: num(data.totalMarks) ?? 0,
        totalPossible: num(data.totalPossible) ?? 0,
        grade: str(data.grade, 4),
        isComplete: data.isComplete !== false,
        blankCount: num(data.blankCount) ?? 0,
        rows: rows.map((row) => ({
          number: str(row?.number, 12),
          topic: str(row?.topic, LIMITS.maxTopicLength),
          mark: row?.mark === null || row?.mark === undefined ? null : num(row.mark),
          outOf: num(row?.outOf) ?? 0,
          status: ['strong', 'weak', 'developing', 'notMarked', 'neutral'].includes(row?.status) ? row.status : 'neutral',
        })),
        wentWell: toTopicList(data.wentWell),
        evenBetterIf: toTopicList(data.evenBetterIf),
        focusOn: (Array.isArray(data.focusOn) ? data.focusOn : [])
          .slice(0, LIMITS.maxListItems)
          .map((item) => ({ topic: str(item?.topic, LIMITS.maxTopicLength), url: httpUrl(item?.url) }))
          .filter((item) => item.url),
      },
    });
  }

  return {
    ok: true,
    value: {
      idempotencyKey: str(body.idempotencyKey, 120),
      assessmentId: str(body.assessmentId, 80),
      replyTo,
      schoolName: str(body.schoolName, LIMITS.maxNameLength),
      emailText: toWording(body.text),
      messages: clean,
    },
  };
}

/**
 * Admin-edited email wording. Only the known keys are accepted and each is
 * length-capped, so the endpoint cannot be used to push arbitrary content into
 * an email. The template HTML-escapes every one of these values when it renders,
 * so markup in them is displayed as text rather than executed.
 */
const WORDING_KEYS = [
  'subject', 'greeting', 'intro', 'wwwHeading', 'ebiHeading', 'focusHeading',
  'nothingFlagged', 'extraMessage', 'closing', 'signOff', 'signOffName',
];

function toWording(value) {
  if (!value || typeof value !== 'object') return undefined;
  const out = {};
  for (const audience of ['pupil', 'parent']) {
    const source = value[audience];
    if (!source || typeof source !== 'object') continue;
    const fields = {};
    for (const key of WORDING_KEYS) {
      if (typeof source[key] === 'string') fields[key] = str(source[key], LIMITS.maxNoteLength);
    }
    if (Object.keys(fields).length) out[audience] = fields;
  }
  return Object.keys(out).length ? out : undefined;
}

function toTopicList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, LIMITS.maxListItems)
    .map((item) => str(item, LIMITS.maxTopicLength))
    .filter(Boolean);
}
