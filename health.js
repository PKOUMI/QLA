/**
 * GET /api/health
 *
 * Lets the app's Settings dialog tell the teacher whether the backend is
 * reachable and configured, without exposing anything sensitive.
 * It reports WHETHER a key is set, never the key itself.
 */

import { applyCors } from './_lib/cors.js';
import { mailerStatus } from './_lib/mailer.js';

export default async function handler(req, res) {
  const cors = applyCors(req, res);
  if (cors.handled) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET.' });
  if (!cors.isAllowed) {
    return res.status(403).json({ error: 'This origin is not allowed. Add it to ALLOWED_ORIGINS.' });
  }

  const status = mailerStatus();
  return res.status(200).json({
    ok: true,
    time: new Date().toISOString(),
    emailConfigured: status.emailConfigured,
    fromAddress: status.fromAddress,   // safe: it is the public sender address
    dryRun: status.dryRun,
    sharedKeyRequired: Boolean(process.env.APP_SHARED_KEY),
  });
}
