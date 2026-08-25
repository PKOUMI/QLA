/**
 * auth.js — the sign-in screen.
 *
 * A teacher types their school email address, receives a six-digit code, and
 * types it back. There is no password to forget, reset, reuse, or write on a
 * sticky note, and no password for us to store.
 *
 * WHO IS ALLOWED IN
 * Nothing here decides that. An address only works if somebody at the school
 * has put it on the staff list (see supabase/migrations/0002_access.sql), and
 * an account with no membership row can read nothing at all — Row Level
 * Security in Postgres sees to that, not this file. This screen's whole job is
 * to be clear about what happened.
 */

import {
  isConfigured, sendSignInCode, verifySignInCode, currentUser, currentSession,
  signOut as clearSession, rpc, SupabaseError,
} from './supabase.js';
import { el, clear, $ } from './ui.js';

/* --- Turning provider errors into something a teacher can act on ---------
 *
 * Exported so it can be tested without a network. Every branch here was a real
 * response from GoTrue; the default exists because there will be others.
 * ----------------------------------------------------------------------- */

export function signInErrorMessage(error, stage = 'send') {
  const status = error?.status || 0;
  const text = String(error?.message || '').toLowerCase();

  if (status === 0 && /failed to fetch|networkerror|load failed/.test(text)) {
    return 'Could not reach the server. Check your internet connection and try again.';
  }

  // The signup hook refused the address. Its message names who to ask, so it
  // is more useful than anything we could write here.
  if (status === 403 && stage === 'send' && error?.message && !/token/.test(text)) {
    return error.message;
  }

  if (/signups not allowed/.test(text)) {
    return 'That address is not on your school’s staff list. Check for a typo, or ask whoever set up EveryPupil at your school to add it.';
  }

  if (/unable to validate email|invalid format/.test(text)) {
    return 'That does not look like an email address. Check it and try again.';
  }

  if (status === 429 || /rate limit|only request this after|too many/.test(text)) {
    const seconds = Number((/after (\d+) seconds?/.exec(text) || [])[1]);
    if (seconds) return `Please wait ${seconds} second${seconds === 1 ? '' : 's'} before asking for another code.`;
    return 'Too many codes have been requested. Wait a few minutes and try again.';
  }

  if (stage === 'verify') {
    if (status === 403 || status === 401 || /expired|invalid/.test(text)) {
      return 'That code is wrong or has expired. Check the most recent email, or ask for a new code.';
    }
  }

  return error?.message || 'Something went wrong. Please try again.';
}

/** The address a teacher typed, tidied the way the database stores it. */
export function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/** Rough shape check only — the provider is the real judge. */
export function looksLikeEmail(value) {
  const address = normaliseEmail(value);
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(address);
}

/* --- The screen ---------------------------------------------------------- */

const RESEND_SECONDS = 60;

let gate = null;
let countdownTimer = null;

function gateRoot() {
  if (gate) return gate;
  gate = el('div', { class: 'auth-gate', id: 'auth-gate', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'auth-title' });
  document.body.append(gate);
  return gate;
}

function closeGate() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  if (gate) { gate.remove(); gate = null; }
  document.body.classList.remove('is-signed-out');
}

function panel(...children) {
  const root = clear(gateRoot());
  document.body.classList.add('is-signed-out');
  root.append(el('div', { class: 'auth-card' },
    el('div', { class: 'auth-brand' },
      el('span', { class: 'brand-mark', 'aria-hidden': 'true', text: 'EP' }),
      el('span', { class: 'auth-brand-name', text: 'EveryPupil' })),
    ...children,
  ));
  return root;
}

function errorBox() {
  return el('div', { class: 'auth-error', id: 'auth-error', role: 'alert', 'aria-live': 'assertive', hidden: true });
}

function showError(message) {
  const box = $('#auth-error');
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
}

function hideError() {
  const box = $('#auth-error');
  if (box) { box.hidden = true; box.textContent = ''; }
}

function busy(button, isBusy, labelWhenBusy) {
  button.disabled = isBusy;
  if (isBusy) {
    button.dataset.label = button.textContent;
    button.textContent = labelWhenBusy;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
}

/* --- Step 1: which address ----------------------------------------------- */

function askForEmail(prefill, onSent) {
  const input = el('input', {
    type: 'email', id: 'auth-email', autocomplete: 'username', autocapitalize: 'off',
    spellcheck: 'false', placeholder: 'you@yourschool.sch.uk', value: prefill || '',
  });

  const submit = el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Email me a code');

  const form = el('form', {
    class: 'auth-form', novalidate: true,
    onsubmit: async (event) => {
      event.preventDefault();
      hideError();
      const address = normaliseEmail(input.value);
      if (!looksLikeEmail(address)) {
        showError('Enter your school email address.');
        input.focus();
        return;
      }
      busy(submit, true, 'Sending…');
      try {
        await sendSignInCode(address);
        onSent(address);
      } catch (error) {
        showError(signInErrorMessage(error, 'send'));
        busy(submit, false);
        input.focus();
      }
    },
  },
    el('label', { for: 'auth-email', text: 'School email address' }),
    input,
    errorBox(),
    submit,
    el('p', { class: 'auth-note' },
      'We will email you a code. There is no password to remember. ',
      'Only addresses your school has added can sign in.'),
  );

  panel(
    el('h1', { id: 'auth-title', text: 'Sign in' }),
    el('p', { class: 'auth-lead', text: 'Marks and feedback are stored for your school, so you can start on one computer and finish on another.' }),
    form,
  );
  input.focus();
}

/* --- Step 2: the code ---------------------------------------------------- */

/*
 * HOW LONG IS THE CODE?
 * Six, usually. Eight, sometimes. GoTrue's MAILER_OTP_LENGTH is a server
 * setting, and which value a Supabase project is created with has changed over
 * time — so a client that hardcodes six is a client that will one day refuse
 * to accept the code it was just sent. Worse, `maxlength="6"` would make the
 * last two digits physically untypeable.
 *
 * So: take anything from six to ten digits, and let the server be the judge of
 * whether it is right. The check here only exists to catch a half-typed code
 * before it costs somebody an attempt.
 */
const MIN_CODE = 6;
const MAX_CODE = 10;

function askForCode(address, onVerified, onRestart) {
  const input = el('input', {
    type: 'text', id: 'auth-code', inputmode: 'numeric', autocomplete: 'one-time-code',
    maxlength: String(MAX_CODE), class: 'auth-code', placeholder: 'Code', 'aria-describedby': 'auth-sent-to',
  });

  const submit = el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Sign in');

  const attempt = async () => {
    hideError();
    const code = input.value.replace(/\D/g, '');
    if (code.length < MIN_CODE) {
      showError('That code looks too short. Copy the whole code from the email.');
      input.focus();
      return;
    }
    busy(submit, true, 'Checking…');
    try {
      const user = await verifySignInCode(address, code);
      onVerified(user);
    } catch (error) {
      showError(signInErrorMessage(error, 'verify'));
      busy(submit, false);
      input.select();
    }
  };

  // Codes are pasted as often as typed, and a paste is a whole code by
  // definition — so submit on paste and save a click. Typing never
  // auto-submits: we do not know how long this project's codes are, and
  // firing at six digits would spend an attempt on a truncated eight-digit
  // code, which is a maddening thing to have happen to you.
  input.addEventListener('input', (event) => {
    const digits = input.value.replace(/\D/g, '').slice(0, MAX_CODE);
    if (digits !== input.value) input.value = digits;
    if (event.inputType === 'insertFromPaste' && digits.length >= MIN_CODE) attempt();
  });

  const resend = el('button', { class: 'auth-link', type: 'button', disabled: true }, 'Send another code');
  resend.addEventListener('click', async () => {
    hideError();
    resend.disabled = true;
    try {
      await sendSignInCode(address);
      showResendCountdown(resend);
      input.value = '';
      input.focus();
    } catch (error) {
      showError(signInErrorMessage(error, 'send'));
      showResendCountdown(resend);
    }
  });

  const form = el('form', {
    class: 'auth-form', novalidate: true,
    onsubmit: (event) => { event.preventDefault(); attempt(); },
  },
    el('label', { for: 'auth-code', text: 'Code from the email' }),
    input,
    errorBox(),
    submit,
  );

  panel(
    el('h1', { id: 'auth-title', text: 'Check your email' }),
    el('p', { class: 'auth-lead', id: 'auth-sent-to' },
      'We sent a code to ', el('strong', { text: address }), '. It is valid for one hour.'),
    form,
    el('div', { class: 'auth-actions' },
      resend,
      el('button', { class: 'auth-link', type: 'button', onclick: onRestart }, 'Use a different address')),
    el('p', { class: 'auth-note', text: 'If it has not arrived after a minute, check your junk folder — school filters are strict about mail from new senders.' }),
  );

  showResendCountdown(resend);
  input.focus();
}

/** Supabase refuses a second code within a minute, so say so rather than
 *  letting somebody press a button that is guaranteed to fail. */
function showResendCountdown(button) {
  let left = RESEND_SECONDS;
  if (countdownTimer) clearInterval(countdownTimer);
  const tick = () => {
    if (left <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      button.disabled = false;
      button.textContent = 'Send another code';
      return;
    }
    button.disabled = true;
    button.textContent = `Send another code in ${left}s`;
    left -= 1;
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

/* --- Dead ends ----------------------------------------------------------- */

function showNoSchool(user, onSignOut) {
  panel(
    el('h1', { id: 'auth-title', text: 'Almost there' }),
    el('p', { class: 'auth-lead' },
      'You are signed in as ', el('strong', { text: user.email }),
      ', but that address is not linked to a school yet, so there is nothing to show you.'),
    el('p', { class: 'auth-note', text: 'Ask whoever set up EveryPupil at your school to add your address to the staff list, then sign in again. Nothing is wrong with your account.' }),
    el('button', { class: 'btn btn-block', type: 'button', onclick: onSignOut }, 'Sign out'),
  );
}

function showNotConfigured() {
  panel(
    el('h1', { id: 'auth-title', text: 'Not connected to a database' }),
    el('p', { class: 'auth-lead', text: 'This copy of the app has no database details in config.js, so there is nobody to sign in as.' }),
    el('p', { class: 'auth-note', text: 'Add supabaseUrl and supabaseAnonKey to config.js and reload. See supabase/README.md.' }),
  );
}

/* --- The account menu ---------------------------------------------------- */

/**
 * A single button in the corner. The email address and the role live inside
 * it, because a header that shows everything at once is a header that runs out
 * of room — which is exactly what happened when it did.
 */
function showAccountMenu(user, school, role, onSignOut) {
  const slot = $('#who');
  if (!slot) return;
  clear(slot);
  slot.hidden = false;

  const initials = String(user.email || '?').trim().slice(0, 2).toUpperCase();

  const panel = el('div', { class: 'account-panel', id: 'account-panel', hidden: true, role: 'menu' },
    el('div', { class: 'account-head' },
      el('span', { class: 'account-avatar big', 'aria-hidden': 'true', text: initials }),
      el('div', { class: 'account-who' },
        el('strong', { title: user.email, text: user.email }),
        el('span', { text: school || '' }))),
    el('dl', { class: 'account-facts' },
      el('dt', { text: 'Role' }),
      el('dd', {}, el('span', { class: 'badge badge-brand', text: ROLE_NAMES[role] || role || 'Signed in' })),
      el('dt', { text: 'Can' }),
      el('dd', { text: ROLE_SUMMARY[role] || '' }),
    ),
    el('button', { class: 'btn btn-block', type: 'button', onclick: onSignOut }, 'Sign out'),
  );

  const button = el('button', {
    class: 'account-button', type: 'button', id: 'btn-account',
    'aria-haspopup': 'true', 'aria-expanded': 'false',
    title: user.email,
  },
    el('span', { class: 'account-avatar', 'aria-hidden': 'true', text: initials }),
    el('span', { class: 'visually-hidden', text: `Your account: ${user.email}` }),
    el('span', { class: 'account-caret', 'aria-hidden': 'true' }),
  );

  const close = () => {
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onOutside, true);
    document.removeEventListener('keydown', onKey);
  };
  const onOutside = (event) => { if (!slot.contains(event.target)) close(); };
  const onKey = (event) => { if (event.key === 'Escape') { close(); button.focus(); } };

  button.addEventListener('click', () => {
    if (panel.hidden) {
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      // Capture phase, so a click on any control elsewhere closes this first.
      document.addEventListener('click', onOutside, true);
      document.addEventListener('keydown', onKey);
    } else {
      close();
    }
  });

  slot.append(button, panel);
}

const ROLE_NAMES = { owner: 'Owner', admin: 'Admin', teacher: 'Teacher' };
const ROLE_SUMMARY = {
  owner: 'Set up assessments, enter marks, send feedback, and manage staff.',
  admin: 'Set up assessments, enter marks, send feedback, and manage staff.',
  teacher: 'Enter marks on the assessments you have been given.',
};

/* --- The one function the rest of the app calls -------------------------- */

/**
 * Resolve once there is a signed-in teacher who belongs to a school.
 * Never resolves if they cannot get in — the screen stays up, which is the
 * correct behaviour for a gate.
 *
 * @returns {Promise<{user: {id, email}, org: {id, name, role}}>}
 */
export function requireSignIn() {
  return new Promise((resolve) => {
    if (!isConfigured()) { showNotConfigured(); return; }

    const signOutAndRestart = async () => {
      await clearSession();
      start();
    };

    /** Signed in — now find out which school, and link the invitation. */
    const afterSignIn = async (user) => {
      try {
        const rows = await rpc('claim_membership');
        const row = Array.isArray(rows) ? rows[0] : rows;
        if (!row?.school_id) { showNoSchool(user, signOutAndRestart); return; }
        closeGate();
        // Once the app is running behind us, signing out means reloading:
        // views are already built from this teacher's data and re-showing the
        // gate over the top would leave it on screen underneath.
        showAccountMenu(user, row.school_name, row.member_role, async () => {
          await clearSession();
          window.location.reload();
        });
        resolve({ user, org: { id: row.school_id, name: row.school_name, role: row.member_role } });
      } catch (error) {
        // A session that the database will not accept is not a session.
        if (error instanceof SupabaseError && (error.status === 401 || error.status === 403)) {
          await clearSession();
          start();
          showError(signInErrorMessage(error, 'verify'));
          return;
        }
        showNoSchool(user, signOutAndRestart);
      }
    };

    const start = () => {
      askForEmail(lastAddress, (address) => {
        lastAddress = address;
        askForCode(address, afterSignIn, start);
      });
    };

    let lastAddress = '';
    const existing = currentUser();
    if (existing && currentSession()) {
      lastAddress = existing.email || '';
      afterSignIn(existing);
      return;
    }
    start();
  });
}

export { clearSession as signOut };
