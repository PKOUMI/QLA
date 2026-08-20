/**
 * POST /api/send-feedback
 *
 * The one endpoint that can send email. Everything secret lives here, on the
 * server, in environment variables — never in the browser.
 *
 * Request body (all fields validated in _lib/validate.js):
 * {
 *   idempotencyKey: "batch_x:0",
 *   assessmentId:   "asmt_...",
 *   replyTo:        "teacher@school.sch.uk",
 *   schoolName:     "Example High School",
 *   messages: [ { id, type: "pupil"|"parent", to, data: { ...feedback } } ]
 * }
 *
 * Note what the client canNOT supply: HTML, a subject line, a sender address,
 * or attachments. The server renders a fixed template from structured data,
 * which is what stops this endpoint being usable as an open mail relay.
 */

import { applyCors, checkSharedKey } from './_lib/cors.js';
import { checkRateLimit, checkHourlyEmailCap, clientKey, rememberIdempotency, recallIdempotency } from './_lib/rate-limit.js';
import { validateRequest, LIMITS } from './_lib/validate.js';
import { sendAll, mailerStatus } from './_lib/mailer.js';
import { renderFeedbackEmail } from '../shared/email-template.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const cors = applyCors(req, res);
  if (cors.handled) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST.' });
  }
  if (!cors.configured) {
    return res.status(500).json({ error: 'The server has no ALLOWED_ORIGINS configured, so it refuses all requests. Set it in your environment variables.' });
  }
  if (!cors.isAllowed) {
    return res.status(403).json({ error: 'This origin is not allowed to use this API. Add it to ALLOWED_ORIGINS.' });
  }

  const key = checkSharedKey(req);
  if (!key.ok) {
    return res.status(401).json({ error: 'Invalid or missing access key. Check the key in the app\'s Settings matches APP_SHARED_KEY on the server.' });
  }

  // --- Rate limit -------------------------------------------------------
  const limit = checkRateLimit(clientKey(req));
  if (!limit.ok) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return res.status(429).json({ error: `Too many requests. Try again in ${limit.retryAfter} seconds.` });
  }

  // --- Parse and validate ----------------------------------------------
  let body = req.body;
  if (typeof body === 'string') {
    if (body.length > LIMITS.maxBodyBytes) return res.status(413).json({ error: 'Request too large.' });
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Body was not valid JSON.' }); }
  }

  const parsed = validateRequest(body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const request = parsed.value;

  // --- Duplicate protection --------------------------------------------
  // If the same key arrives twice (double click, or a client retry after a
  // timeout) we return the FIRST result rather than sending a second time.
  if (request.idempotencyKey) {
    const previous = recallIdempotency(request.idempotencyKey);
    if (previous) {
      return res.status(200).json({ ...previous, duplicate: true });
    }
  }

  // --- Deployment-wide safety net --------------------------------------
  const cap = checkHourlyEmailCap(request.messages.length);
  if (!cap.ok) {
    return res.status(429).json({
      error: `This deployment's hourly email limit (${cap.cap}) would be exceeded. Raise MAX_EMAILS_PER_HOUR if this is expected.`,
    });
  }

  const status = mailerStatus();
  if (!status.emailConfigured && !status.dryRun) {
    // Be explicit rather than pretending. A teacher must never be told an
    // email was sent when the server has no way to send it.
    return res.status(503).json({
      error: 'The email provider is not configured on the server (RESEND_API_KEY is missing). No emails were sent.',
    });
  }

  // --- Render on the server ---------------------------------------------
  const toSend = request.messages.map((message) => {
    const { subject, html, text } = renderFeedbackEmail(message.data, {
      audience: message.type,
      schoolName: request.schoolName,
    });
    return {
      id: message.id,
      type: message.type,
      to: message.to,
      subject,
      html,
      text,
      replyTo: request.replyTo || undefined,
    };
  });

  // --- Send --------------------------------------------------------------
  const results = await sendAll(toSend, { concurrency: 2 });

  const payload = {
    results: results.map((r) => ({
      id: r.id, to: r.to, type: r.type, status: r.status,
      messageId: r.providerId || null,
      error: r.error || null,
      simulated: r.simulated || undefined,
    })),
    sent: results.filter((r) => r.status === 'sent').length,
    failed: results.filter((r) => r.status !== 'sent').length,
    dryRun: status.dryRun || undefined,
  };

  if (request.idempotencyKey) rememberIdempotency(request.idempotencyKey, payload);

  return res.status(200).json(payload);
}
