/**
 * api.js — the client half of the email system.
 *
 * The browser never talks to Resend. It talks to OUR backend, which holds the
 * API key. This file also owns batching, retries and duplicate-send protection
 * on the client side; the server enforces its own limits independently, because
 * anything enforced only in a browser is a suggestion, not a rule.
 */

import { getSettings } from './storage.js';

export class ApiNotConfiguredError extends Error {}

function baseUrl() {
  const url = (getSettings().apiBaseUrl || '').trim().replace(/\/$/, '');
  if (!url) {
    throw new ApiNotConfiguredError(
      'No email backend is configured yet. Open Settings and enter the address of your deployed API.',
    );
  }
  return url;
}

export function isConfigured() {
  return Boolean((getSettings().apiBaseUrl || '').trim());
}

async function request(path, { method = 'POST', body, timeoutMs = 45000 } = {}) {
  const settings = getSettings();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(settings.apiKey ? { 'X-QLA-Key': settings.apiKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    let payload = null;
    try { payload = await response.json(); } catch { /* non-JSON error page */ }

    if (!response.ok) {
      const message = payload?.error || `The server returned ${response.status} ${response.statusText}.`;
      const error = new Error(message);
      error.status = response.status;
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('The request timed out. Your emails may or may not have been sent — check the results before resending.');
      timeoutError.retryable = false;
      throw timeoutError;
    }
    if (error instanceof TypeError) {
      // fetch throws TypeError for network failure and for blocked CORS.
      const networkError = new Error('Could not reach the email backend. Check the API address in Settings, that it is deployed, and that this site is on its allowed-origins list.');
      networkError.retryable = true;
      throw networkError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Cheap check that the backend is alive and configured. */
export async function checkHealth() {
  return request('/api/health', { method: 'GET', timeoutMs: 12000 });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send one batch, retrying only on errors that are genuinely transient
 * (rate limits and server errors). Exponential backoff with jitter so that
 * several teachers hitting the limit at once do not retry in lockstep.
 */
async function sendBatchWithRetry(batch, { maxAttempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await request('/api/send-feedback', { body: batch });
    } catch (error) {
      lastError = error;
      if (!error.retryable || attempt === maxAttempts) throw error;
      const wait = Math.min(8000, 700 * 2 ** (attempt - 1)) + Math.random() * 400;
      await sleep(wait);
    }
  }
  throw lastError;
}

/**
 * Send all messages, in batches, reporting progress as it goes.
 *
 * @param {Array} messages   [{ id, type: 'pupil'|'parent', to, data }]
 * @param {object} context   { assessmentId, batchId, replyTo, schoolName, text }
 * @param {Function} onProgress ({ done, total, phase })
 * @returns {{results: Array, sent: number, failed: number}}
 */
export async function sendFeedbackEmails(messages, context, onProgress = () => {}) {
  const size = Math.max(1, Math.min(25, (window.QLA_CONFIG?.batchSize) || 8));
  const results = [];
  let done = 0;

  for (let start = 0; start < messages.length; start += size) {
    const slice = messages.slice(start, start + size);
    onProgress({ done, total: messages.length, phase: 'sending' });

    try {
      const response = await sendBatchWithRetry({
        // The idempotency key makes a duplicate POST a no-op server-side.
        idempotencyKey: `${context.batchId}:${start}`,
        assessmentId: context.assessmentId,
        replyTo: context.replyTo || '',
        text: context.text || undefined,
        schoolName: context.schoolName || '',
        messages: slice.map((message) => ({
          id: message.id,
          type: message.type,
          to: message.to,
          data: message.data,
          // Only present when this pupil's email has been edited on its own.
          text: message.text || undefined,
        })),
      });
      results.push(...(response.results || []));
    } catch (error) {
      // A whole-batch failure is reported per recipient so nothing is silently lost.
      results.push(...slice.map((message) => ({
        id: message.id, to: message.to, type: message.type,
        status: 'failed', error: error.message,
      })));
    }

    done += slice.length;
    onProgress({ done, total: messages.length, phase: 'sending' });

    // Gentle pacing between batches keeps us inside provider rate limits.
    if (start + size < messages.length) await sleep(400);
  }

  return {
    results,
    sent: results.filter((r) => r.status === 'sent').length,
    failed: results.filter((r) => r.status !== 'sent').length,
  };
}
