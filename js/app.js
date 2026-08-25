/**
 * app.js — application shell.
 *
 * Owns: the current assessment, saving, routing between the four views, and
 * the two utility dialogs (Settings and Saved assessments).
 *
 * The pattern is deliberately simple and framework-free:
 *   change data  ->  update(fn)  ->  save (debounced) + re-render the active view
 */

import { newAssessment } from './model.js';
import {
  repo, setRepo, setCurrentId, loadCurrentAssessment, getSettings, saveSettings,
  exportAssessmentJson, importAssessmentJson,
} from './storage.js';
import { createSupabaseRepo } from './storage-supabase.js';
import * as roles from './roles.js';
import { initStaffButton } from './staff.js';
import * as markers from './markers.js';
import { validateAssessment } from './validation.js';
import { $, el, toast, openModal, closeModal, confirmDialog, debounce, downloadFile, readFileAsText, plural } from './ui.js';
import * as setupView from './views/setup.js';
import * as marksheetView from './views/marksheet.js';
import * as analyseView from './views/analyse.js';
import * as feedbackView from './views/feedback.js';
import { checkHealth } from './api.js';
import { requireSignIn } from './auth.js';
import { isConfigured } from './supabase.js';

/* --- State --------------------------------------------------------------- */

export const state = {
  assessment: null,
  route: 'setup',
  /** Who is signed in, and which school they belong to. Null when the app is
   *  running without a database — see boot(). */
  session: null,
};

const VIEWS = {
  setup: setupView, marksheet: marksheetView, analyse: analyseView, feedback: feedbackView,
};

/** Re-render only the view the teacher is looking at. */
export function render() {
  VIEWS[state.route].render(state.assessment);
  updateStepStates();
  // The views rebuild their tables on every render, so the read-only state has
  // to be re-applied afterwards rather than once at start-up.
  roles.apply();

  // Who is marking this paper lives on the setup page and needs the network,
  // so it renders itself and then re-applies the read-only state when it
  // arrives. A failure here must not take the page down with it.
  if (state.route === 'setup') {
    markers.render(state.assessment, state.session)
      .then(() => roles.apply())
      .catch((error) => console.error('Could not show who is marking this paper', error));
  }
}

/**
 * Apply a change to the assessment, then save and update the screen.
 *
 * @param {Function} mutator receives the assessment and mutates it
 * @param {{rerender?: boolean}} options
 *
 * `rerender: true` (default) does a STRUCTURAL render: tables are rebuilt from
 * scratch. Use it when rows are added, removed or reordered.
 *
 * `rerender: false` does a LIGHT refresh: totals, badges and error messages are
 * updated, but no input is rebuilt. Use it on every keystroke. This matters —
 * rebuilding a table while someone is typing in it throws away their cursor and,
 * worse, throws away the field they were about to click into.
 */
export function update(mutator, { rerender = true } = {}) {
  mutator(state.assessment);
  scheduleSave();
  if (rerender) {
    render();
  } else {
    const view = VIEWS[state.route];
    if (view.refresh) view.refresh(state.assessment);
    updateStepStates();
  }
}

/* --- Saving -------------------------------------------------------------- */

function setSaveState(text, kind = '') {
  const node = $('#save-state');
  node.textContent = text;
  node.className = `save-state ${kind}`;
}

let saveFailed = false;

const scheduleSave = debounce(async () => {
  setSaveState('Saving…', 'is-saving');
  try {
    await repo.save(state.assessment);
    saveFailed = false;
    const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    setSaveState(`Saved ${time}`);
  } catch (error) {
    saveFailed = true;
    setSaveState('Not saved', 'is-error');
    toast(error.message, 'bad', 9000);
  }
}, 500);

// Last line of defence: warn before losing an unsaved change.
window.addEventListener('beforeunload', (event) => {
  if (saveFailed) { event.preventDefault(); event.returnValue = ''; }
});

/* --- Routing ------------------------------------------------------------- */

const ROUTES = ['setup', 'marksheet', 'analyse', 'feedback'];

export function goTo(route) {
  if (!ROUTES.includes(route)) route = 'setup';

  // Let the view being left tidy up after itself. The marksheet uses this to
  // drop out of full-window mode: without it, using the browser's Back button
  // while expanded would land you on another page with the header still hidden.
  if (state.route !== route) VIEWS[state.route]?.onLeave?.();

  state.route = route;
  for (const name of ROUTES) {
    $(`#view-${name}`).classList.toggle('is-active', name === route);
  }
  for (const button of document.querySelectorAll('.step')) {
    const isCurrent = button.dataset.goto === route;
    if (isCurrent) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (window.location.hash !== `#${route}`) window.location.hash = route;
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

/** Tick the steps that are complete, so progress is visible at a glance. */
function updateStepStates() {
  const assessment = state.assessment;
  const { bySection } = validateAssessment(assessment);
  const setupDone = bySection.exam.length === 0 && bySection.questions.length === 0
    && bySection.boundaries.length === 0 && bySection.pupils.length === 0;
  const anyMarks = Object.values(assessment.marks).some((row) => Object.values(row).some((m) => m !== null && m !== undefined));

  document.querySelector('.step[data-goto="setup"]').classList.toggle('is-done', setupDone);
  document.querySelector('.step[data-goto="marksheet"]').classList.toggle('is-done', setupDone && anyMarks);
  document.querySelector('.step[data-goto="analyse"]').classList.toggle('is-done', setupDone && anyMarks);
  document.querySelector('.step[data-goto="feedback"]').classList.toggle('is-done', assessment.sendLog.length > 0);
}

/* --- Settings dialog ----------------------------------------------------- */

function openSettings() {
  const settings = getSettings();
  const form = el('div', { class: 'grid', style: 'gap:16px' },
    el('div', { class: 'callout callout-info' },
      el('span', { class: 'ico', 'aria-hidden': 'true', text: 'ℹ️' }),
      el('div', {},
        el('strong', { text: 'These settings stay in this browser' }),
        el('span', { text: 'They are not secrets. The email provider API key lives on the server and is never sent to your browser. See DEPLOYMENT.md for how to deploy the backend.' }),
      )),
    el('div', { class: 'field' },
      el('label', { for: 'set-api-url', text: 'Email API address' }),
      el('input', { type: 'url', id: 'set-api-url', value: settings.apiBaseUrl, placeholder: 'https://your-api.vercel.app' }),
      el('span', { class: 'hint', text: 'The URL of your deployed backend, with no trailing slash. Leave blank to use the app without email.' })),
    el('div', { class: 'field' },
      el('label', { for: 'set-api-key', text: 'Shared access key' }),
      el('input', { type: 'password', id: 'set-api-key', value: settings.apiKey, placeholder: 'Optional', autocomplete: 'off' }),
      el('span', { class: 'hint', text: 'Must match APP_SHARED_KEY on the server. This stops strangers using your endpoint. It is not full authentication — anyone using this browser can read it.' })),
    el('div', { id: 'health-result' }),
  );

  openModal({
    title: 'Email settings',
    body: form,
    buttons: [
      {
        label: 'Test connection', class: 'left', close: false, onClick: async () => {
          const target = $('#health-result');
          target.textContent = 'Checking…';
          saveSettings({ ...settings, apiBaseUrl: $('#set-api-url').value.trim(), apiKey: $('#set-api-key').value.trim() });
          try {
            const health = await checkHealth();
            const detail = health.dryRun
              ? `The server is in DRY_RUN mode: emails will be prepared and reported, but NOT delivered. Remove DRY_RUN to send for real.`
              : health.emailConfigured
                ? `Email provider configured. Sending from: ${health.fromAddress || 'not set — set FROM_EMAIL'}.`
                : 'The server has no RESEND_API_KEY, so it cannot send email yet.';
            target.replaceChildren(el('div', { class: `callout callout-${health.dryRun || !health.emailConfigured ? 'warn' : 'ok'}` },
              el('span', { class: 'ico', text: health.dryRun || !health.emailConfigured ? '⚠️' : '✅' }),
              el('div', {}, el('strong', { text: 'Backend reachable' }), el('span', { text: detail })),
            ));
          } catch (error) {
            target.replaceChildren(el('div', { class: 'callout callout-bad' },
              el('span', { class: 'ico', text: '⛔' }),
              el('div', {}, el('strong', { text: 'Could not reach the backend' }), el('span', { text: error.message })),
            ));
          }
        },
      },
      { label: 'Cancel' },
      {
        label: 'Save', class: 'btn-primary', onClick: () => {
          saveSettings({
            ...settings,
            apiBaseUrl: $('#set-api-url').value.trim(),
            apiKey: $('#set-api-key').value.trim(),
          });
          toast('Settings saved.', 'ok');
          render();
        },
      },
    ],
  });
}

/* --- Assessments dialog -------------------------------------------------- */

async function openAssessments() {
  const list = await repo.list();
  const body = el('div', {});

  body.append(el('div', { style: 'display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap' },
    el('button', {
      class: 'btn btn-primary btn-sm', type: 'button', onclick: async () => {
        const created = newAssessment();
        await repo.save(created);
        setCurrentId(created.id);
        state.assessment = created;
        closeModal();
        goTo('setup');
        toast('New assessment created.', 'ok');
      },
    }, '+ New assessment'),
    el('button', {
      class: 'btn btn-sm', type: 'button', onclick: () => {
        const name = (state.assessment.exam.name || 'assessment').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
        downloadFile(`qla-${name}.json`, exportAssessmentJson(state.assessment), 'application/json');
      },
    }, 'Export current as backup'),
    el('button', { class: 'btn btn-sm', type: 'button', onclick: () => $('#import-json').click() }, 'Restore from backup'),
    el('input', {
      type: 'file', id: 'import-json', accept: '.json,application/json', class: 'visually-hidden',
      onchange: async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        try {
          const doc = importAssessmentJson(await readFileAsText(file));
          await repo.save(doc);
          setCurrentId(doc.id);
          state.assessment = doc;
          closeModal();
          goTo('setup');
          toast(`Restored "${doc.exam.name || 'Untitled assessment'}".`, 'ok');
        } catch (error) {
          toast(error.message || 'That file could not be read.', 'bad');
        }
      },
    }),
  ));

  if (list.length === 0) {
    body.append(el('p', { class: 'hint', text: 'No saved assessments yet.' }));
  } else {
    const table = el('table', { class: 'data' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'Assessment' }), el('th', { text: 'Subject' }),
        el('th', { text: 'Pupils' }), el('th', { text: 'Last edited' }), el('th', {}))),
      el('tbody', {}, list.map((item) => el('tr', {},
        el('td', {}, el('strong', { text: item.name })),
        el('td', { text: item.subject || '—' }),
        el('td', { text: String(item.pupilCount) }),
        el('td', { text: new Date(item.updatedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) }),
        el('td', { style: 'text-align:right;white-space:nowrap' },
          item.id === state.assessment.id
            ? el('span', { class: 'badge badge-brand', text: 'Open' })
            : el('button', {
              class: 'btn btn-sm', type: 'button', onclick: async () => {
                const doc = await repo.get(item.id);
                if (!doc) return;
                state.assessment = doc;
                setCurrentId(doc.id);
                closeModal();
                goTo('setup');
              },
            }, 'Open'),
          el('button', {
            class: 'btn btn-sm btn-danger', type: 'button', style: 'margin-left:6px',
            onclick: async () => {
              const ok = await confirmDialog({
                title: 'Delete assessment?',
                message: `"${item.name}" and all its marks will be permanently deleted from this browser. This cannot be undone.`,
                confirmLabel: 'Delete', danger: true,
              });
              if (!ok) return;
              await repo.remove(item.id);
              if (item.id === state.assessment.id) {
                state.assessment = await loadCurrentAssessment();
                goTo('setup');
              }
              openAssessments();
              toast('Assessment deleted.', 'ok');
            },
          }, 'Delete')),
      ))),
    );
    body.append(el('div', { class: 'table-wrap' }, table));
  }

  openModal({ title: 'Saved assessments', body, wide: true, buttons: [{ label: 'Close' }] });
}

/* --- Nothing to show yet ------------------------------------------------- */

function showNothingYet() {
  document.querySelector('.app-main').replaceChildren(
    el('section', { class: 'view is-active' },
      el('div', { class: 'empty', style: 'margin-top:40px' },
        el('span', { class: 'ico', 'aria-hidden': 'true', text: '📄' }),
        el('h3', { text: 'Nothing to mark yet' }),
        el('p', { text: 'No assessment has been shared with you. An admin at your school creates the assessment and chooses who marks it — once they have, it will appear here.' }),
      )),
  );
}

/* --- Boot ---------------------------------------------------------------- */

async function boot() {
  // Tell the boot guard in index.html that the JavaScript arrived. This has to
  // happen BEFORE the sign-in screen, not after it: someone waiting for a code
  // to reach their inbox will sit here for minutes, and the guard would
  // otherwise decide the app had failed to start and cover their screen with a
  // deployment error.
  window.__QLA_BOOTED = true;

  // With no database configured the app still runs, saving to this browser
  // only. That is what the public demo does, and it keeps the app usable while
  // a school is still deciding.
  if (isConfigured()) {
    state.session = await requireSignIn();
    setRepo(createSupabaseRepo({
      orgId: state.session.org.id,
      userId: state.session.user.id,
    }));
    roles.setRole(state.session.org.role);
  }

  state.assessment = await loadCurrentAssessment({ canCreate: roles.canManage() });

  // A teacher who has not been given anything to mark yet. Saying so is better
  // than an empty form they are not allowed to fill in.
  if (!state.assessment) {
    showNothingYet();
    return;
  }

  setupView.init();
  marksheetView.init();
  feedbackView.init();

  // Any element with data-goto navigates.
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-goto]');
    if (trigger) goTo(trigger.dataset.goto);
  });

  initStaffButton(state.session);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-assessments').addEventListener('click', openAssessments);

  window.addEventListener('hashchange', () => {
    const route = window.location.hash.replace('#', '');
    if (ROUTES.includes(route) && route !== state.route) goTo(route);
  });

  const initial = window.location.hash.replace('#', '');
  goTo(ROUTES.includes(initial) ? initial : 'setup');
  setSaveState('Saved');

  const pupils = state.assessment.pupils.length;
  if (pupils) toast(`Welcome back — ${plural(pupils, 'pupil')} loaded.`, 'info', 3000);
}

boot().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<div style="padding:40px;font-family:system-ui;max-width:60ch;margin:0 auto">
    <h1>Something went wrong starting the app</h1>
    <p>${error.message}</p>
    <p>If this keeps happening, open Settings in your browser and clear this site's data — note that this will delete any saved assessments.</p></div>`;
});
