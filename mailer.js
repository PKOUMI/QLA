/**
 * mailer.js — the only file that knows which email provider you use.
 *
 * Swapping Resend for SES, Postmark or SendGrid later means rewriting
 * `sendOne` and nothing else.
 *
 * The RESEND_API_KEY is read from the environment. It is never sent to the
 * browser and must never be committed to the repository.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export function mailerStatus() {
  return {
    emailConfigured: Boolean(process.env.RESEND_API_KEY),
    fromAddress: process.env.FROM_EMAIL || '',
    fromName: process.env.FROM_NAME || 'Assessment Feedback',
    dryRun: process.env.DRY_RUN === 'true',
  };
}

/**
 * Send one email.
 * @returns {{status:'sent'|'failed', providerId?:string, error?:string, retryable?:boolean}}
 */
export async function sendOne({ to, subject, html, text, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.FROM_EMAIL;
  const fromName = process.env.FROM_NAME || 'Assessment Feedback';

  // DRY_RUN is an explicit, clearly-labelled simulation for testing the flow
  // before a domain is verified. It never claims an email was sent.
  if (process.env.DRY_RUN === 'true') {
    return { status: 'sent', providerId: `dryrun_${Math.random().toString(36).slice(2)}`, simulated: true };
  }

  if (!apiKey) {
    return { status: 'failed', error: 'The server has no RESEND_API_KEY set, so no email was sent.', retryable: false };
  }
  if (!from) {
    return { status: 'failed', error: 'The server has no FROM_EMAIL set, so no email was sent.', retryable: false };
  }

  const payload = {
    from: `${fromName} <${from}>`,
    to: [to],
    subject,
    html,
    text,
    ...(replyTo ? { reply_to: replyTo } : {}),
  };

  let response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return { status: 'failed', error: `Could not reach the email provider: ${error.message}`, retryable: true };
  }

  let result = null;
  try { result = await response.json(); } catch { /* provider returned no JSON */ }

  if (!response.ok) {
    // Report exactly what the provider said. Never claim success on an error.
    const message = result?.message || result?.error?.message || `Email provider returned ${response.status}.`;
    return {
      status: 'failed',
      error: message,
      retryable: response.status === 429 || response.status >= 500,
    };
  }

  return { status: 'sent', providerId: result?.id || null };
}

/**
 * Send a list of emails with bounded concurrency and one retry for transient
 * failures, so a class of 30 does not fire 30 simultaneous requests.
 */
export async function sendAll(items, { concurrency = 2, pauseMs = 120 } = {}) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];

      let outcome = await sendOne(item);
      if (outcome.status === 'failed' && outcome.retryable) {
        await sleep(600 + Math.random() * 400);
        outcome = await sendOne(item);
      }

      // Spread the outcome first so it can never overwrite our own message id.
      results[index] = { ...outcome, id: item.id, to: item.to, type: item.type };
      if (pauseMs) await sleep(pauseMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
