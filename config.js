/**
 * config.js — the only file you need to edit after deploying.
 *
 * This file is PUBLIC. Anyone can read it. Never put an email API key,
 * a password or any other secret in here.
 */
window.QLA_CONFIG = {
  /**
   * Supabase. Both of these are PUBLIC by design — the anon key is meant to
   * sit in a browser, and Row Level Security is what protects the data behind
   * it. The service_role key is a different thing entirely and must never
   * appear in this file.
   */
  supabaseUrl: 'https://zopuhireyvgwqvfzjafr.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpvcHVoaXJleXZnd3F2ZnpqYWZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2MDAyMTQsImV4cCI6MjEwMzE3NjIxNH0.aIh-5TtRdFbTYpZnSR6hbGKB-qFtYNgIzDy8-MrbA2M',

  /**
   * The address of your deployed backend, with no trailing slash.
   * Leave it empty and the app runs fine — it just cannot send email.
   *
   * Examples:
   *   'https://qla-api.vercel.app'
   *   'https://api.yourdomain.co.uk'
   */
  apiBaseUrl: 'https://api.everypupil.com',

  /** Shown in the email header. Optional. */
  schoolName: '',

  /**
   * Emails per request sent to the backend. Keep this modest so each
   * serverless invocation finishes well inside its timeout.
   */
  batchSize: 8,
};
