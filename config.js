/**
 * config.js — the only file you need to edit after deploying.
 *
 * This file is PUBLIC. Anyone can read it. Never put an email API key,
 * a password or any other secret in here.
 */
window.QLA_CONFIG = {
  /**
   * The address of your deployed backend, with no trailing slash.
   * Leave it empty and the app runs fine — it just cannot send email.
   *
   * Examples:
   *   'https://qla-api.vercel.app'
   *   'https://api.yourdomain.co.uk'
   */
  apiBaseUrl: 'https://qla-virid.vercel.app',

  /** Shown in the email header. Optional. */
  schoolName: '',

  /**
   * Emails per request sent to the backend. Keep this modest so each
   * serverless invocation finishes well inside its timeout.
   */
  batchSize: 8,
};
