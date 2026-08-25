/**
 * GET /api/health
 *
 * Says whether this deployment can send email and whether it can check who is
 * signed in. Nothing sensitive: it reports whether things are configured,
 * never what they are set to.
 */

import { applyCors } from './_lib/cors.js';
import { sessionConfigured, verifySession } from './_lib/session.js';
import { mailerStatus } from './_lib/mailer.js';

export default async function handler(req, res) {
  const cors = applyCors(req, res);
  if (cors.handled) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET.' });
  if (!cors.isAllowed) {
    // Say enough to fix it. `allowedOriginsConfigured: 0` means the variable
    // is not present in the RUNNING deployment — almost always because it was
    // added or edited in Vercel without redeploying afterwards.
    return res.status(403).json({
      error: cors.allowedCount === 0
        ? 'ALLOWED_ORIGINS is empty in the running deployment. If you have set it in Vercel, redeploy: Deployments -> the latest one -> ... -> Redeploy. Environment variables only apply to deployments created after they were saved.'
        : `This origin is not allowed. The server received "${cors.origin || '(none)'}" and it is not in ALLOWED_ORIGINS.`,
      originReceived: cors.origin || null,
      allowedOriginsConfigured: cors.allowedCount,
    });
  }

  const status = mailerStatus();

  // Check the session here too, and REPORT rather than reject. A health check
  // that passes while sending fails on authentication is worse than no health
  // check: it says everything is ready when it is not.
  const session = await verifySession(req);

  return res.status(200).json({
    ok: true,
    time: new Date().toISOString(),
    emailConfigured: status.emailConfigured,
    fromAddress: status.fromAddress,   // safe: it is the public sender address
    dryRun: status.dryRun,
    signInCheckConfigured: sessionConfigured(),
    signedInAs: session.ok ? session.user.email : null,
    sessionProblem: session.ok ? null : session.reason,
  });
}
