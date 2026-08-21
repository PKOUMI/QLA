/**
 * lockbar.js — the lock banner and its dialogs, shared by Set up and Feedback.
 *
 * Both pages show the same bar and the same PIN, because they are the two
 * places where one person's change affects everybody else's work: altering the
 * paper mid-marking, or emailing a class before the marking is finished.
 *
 * The honest limits of this lock are documented in js/lock.js. It is a guard
 * against accidents, not security.
 */

import {
  canEdit, isLocked, isLockEnabled, buildLock, pinMatches, validatePin, setSessionUnlocked,
} from './lock.js';
import { el, clear, toast, openModal, closeModal } from './ui.js';
import { state, update, render as renderApp } from './app.js';

/** Wording that differs between the two pages. */
const COPY = {
  setup: {
    unlocked: 'Anyone using this browser can change the questions, boundaries and pupil list.',
    locked: 'Marks can still be entered on the marksheet. The PIN is needed to change '
      + 'questions, boundaries or the pupil list.',
  },
  feedback: {
    unlocked: 'Anyone using this browser can change who receives feedback and send it.',
    locked: 'The PIN is needed to change who receives feedback, edit the email or send it.',
  },
};

/**
 * Fill an empty `.lockbar` element for a page. Called on every render, so the
 * bar always reflects the current state.
 */
export function renderLockBar(bar, assessment, page) {
  if (!bar) return;
  const enabled = isLockEnabled(assessment);
  const locked = isLocked(assessment);
  const copy = COPY[page];

  bar.classList.toggle('is-locked', locked);
  bar.classList.toggle('is-armed', enabled && !locked);

  let title;
  if (locked) title = 'Locked';
  else if (enabled) title = 'Unlocked for this session';
  else title = 'Not locked';

  clear(bar).append(
    el('span', { class: 'lockbar-ico', 'aria-hidden': 'true', text: locked ? '🔒' : '🔓' }),
    el('div', { class: 'lockbar-text' },
      el('strong', { text: title }),
      el('span', { class: 'hint', text: locked ? copy.locked : copy.unlocked })),
    el('div', { class: 'spacer' }),
    locked
      ? el('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: openUnlockDialog },
        'Enter PIN to unlock')
      : el('button', { class: 'btn btn-sm', type: 'button', onclick: openLockDialog },
        enabled ? 'Change or remove PIN' : 'Lock set up and feedback'),
  );
}

/**
 * Disable everything matching `selector` inside `view` while the lock is on.
 * Returns whether the page is currently locked, so callers can adjust copy.
 */
export function applyLockState(view, assessment, selector) {
  if (!view) return false;
  const locked = isLocked(assessment);
  view.classList.toggle('is-locked', locked);
  for (const node of view.querySelectorAll(selector)) {
    // A control the page itself disabled for its own reasons stays disabled.
    if (locked) {
      node.dataset.lockedBy = 'lock';
      node.disabled = true;
    } else if (node.dataset.lockedBy === 'lock') {
      delete node.dataset.lockedBy;
      node.disabled = false;
    }
  }
  return locked;
}

/* --- Dialogs ------------------------------------------------------------- */

export function openLockDialog() {
  const assessment = state.assessment;
  const alreadySet = isLockEnabled(assessment);
  const pinInput = el('input', {
    type: 'password', id: 'lock-pin', inputmode: 'numeric', autocomplete: 'off',
    maxlength: '8', placeholder: '4 to 8 digits',
  });
  const error = el('div', { class: 'field-error', role: 'alert' });

  const body = el('div', { class: 'grid', style: 'gap:14px' },
    el('div', { class: 'callout callout-info' },
      el('span', { class: 'ico', 'aria-hidden': 'true', text: 'ℹ️' }),
      el('div', {},
        el('strong', { text: 'What this does' }),
        el('span', {
          text: 'Locking freezes the Set up page (questions, grade boundaries, pupil list) '
            + 'and the Feedback page (who receives feedback, the email wording, and sending). '
            + 'Entering marks on the marksheet is never affected. '
            + 'It guards against mistakes, not against someone determined — the check happens '
            + 'in the browser. Real staff permissions arrive with school accounts.',
        }))),
    el('div', { class: 'field' },
      el('label', { for: 'lock-pin', text: alreadySet ? 'New PIN' : 'Choose a PIN' }),
      pinInput,
      el('span', { class: 'hint', text: 'Anyone who needs to change the set up or send feedback will be asked for this. Write it down somewhere — it cannot be recovered.' })),
    error,
  );

  openModal({
    title: alreadySet ? 'Change the PIN' : 'Lock set up and feedback',
    body,
    buttons: [
      { label: 'Cancel' },
      ...(alreadySet ? [{
        label: 'Remove lock',
        onClick: () => {
          // Session state first: update() re-renders, and the render must
          // already see the new lock state or the screen lags a step behind.
          setSessionUnlocked(true);
          updateLock({ enabled: false, pinHash: null, salt: null });
          toast('Lock removed. Anyone can now edit the set up and send feedback.', 'ok');
        },
      }] : []),
      {
        label: alreadySet ? 'Save new PIN' : 'Lock',
        class: 'btn-primary',
        close: false,
        onClick: async () => {
          const problem = validatePin(pinInput.value);
          if (problem) { error.textContent = problem; pinInput.focus(); return; }
          const lock = await buildLock(pinInput.value);
          setSessionUnlocked(false);
          updateLock(lock);
          closeModal();
          toast('Locked. Set up and feedback are now read-only until the PIN is entered.', 'ok', 6000);
        },
      },
    ],
  });
}

export function openUnlockDialog() {
  const pinInput = el('input', {
    type: 'password', id: 'unlock-pin', inputmode: 'numeric', autocomplete: 'off',
    maxlength: '8', placeholder: 'PIN',
  });
  const error = el('div', { class: 'field-error', role: 'alert' });

  const attempt = async () => {
    if (await pinMatches(state.assessment, pinInput.value)) {
      setSessionUnlocked(true);
      closeModal();
      renderApp();
      toast('Unlocked for this session.', 'ok');
    } else {
      error.textContent = 'That PIN is not right.';
      pinInput.select();
    }
  };

  pinInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); attempt(); }
  });

  openModal({
    title: 'Unlock',
    body: el('div', { class: 'grid', style: 'gap:14px' },
      el('p', { text: 'Enter the PIN chosen when this assessment was locked.' }),
      el('div', { class: 'field' }, el('label', { for: 'unlock-pin', text: 'PIN' }), pinInput),
      error),
    buttons: [
      { label: 'Cancel' },
      { label: 'Unlock', class: 'btn-primary', close: false, onClick: attempt },
    ],
  });
}

function updateLock(lock) {
  update((a) => { a.settings.lock = lock; });
}

export { canEdit };
