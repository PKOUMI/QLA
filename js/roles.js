/**
 * roles.js — showing a teacher what is theirs to change.
 *
 * IMPORTANT: nothing here is a security measure. The permissions live in
 * Postgres (supabase/migrations/0003_roles.sql) and are enforced whether this
 * file runs or not. What this does is stop somebody filling in a form for ten
 * minutes only to be told at the end that it was never theirs to fill in.
 *
 * A greyed-out control with no explanation is its own kind of rude, so each
 * read-only area gets a sentence saying who to ask.
 */

import { $, $$, el } from './ui.js';

let currentRole = null;

export function setRole(role) {
  currentRole = role;
  apply();
}

export function canManage() {
  return currentRole === null || currentRole === 'admin' || currentRole === 'owner';
}

export function role() {
  return currentRole;
}

/** Areas a teacher may look at but not change, and what to say about each. */
const READ_ONLY_FOR_TEACHERS = [
  {
    view: '#view-setup',
    note: 'You can see how this assessment is set up, but only an admin can change it. '
        + 'Ask whoever created it if a question, a boundary or a pupil needs correcting.',
  },
  {
    view: '#view-feedback',
    note: 'Feedback is sent by an admin. You can check the wording and see who would receive it.',
  },
];

function banner(text) {
  return el('div', { class: 'callout callout-info role-note' },
    el('span', { class: 'ico', 'aria-hidden': 'true', text: 'ℹ️' }),
    el('div', {}, el('strong', { text: 'Read only' }), el('span', { text })),
  );
}

/**
 * Disable the controls in each read-only view. Re-run after every render,
 * because the views rebuild their own tables from scratch.
 */
export function apply() {
  if (typeof document === 'undefined') return;    // running in a test, not a page
  const readOnly = !canManage();

  for (const area of READ_ONLY_FOR_TEACHERS) {
    const view = $(area.view);
    if (!view) continue;

    const existing = $('.role-note', view);
    if (readOnly && !existing) {
      view.querySelector('.view-head')?.after(banner(area.note));
    } else if (!readOnly && existing) {
      existing.remove();
    }

    for (const control of $$('input, select, textarea, button', view)) {
      // Navigation still works: a teacher can move between steps, they just
      // cannot alter what they find there.
      if (control.dataset.goto || control.closest('.view-nav') || control.closest('.role-note')) continue;
      if (readOnly) {
        control.disabled = true;
        control.setAttribute('data-role-disabled', '');
      } else if (control.hasAttribute('data-role-disabled')) {
        control.disabled = false;
        control.removeAttribute('data-role-disabled');
      }
    }
  }
}
