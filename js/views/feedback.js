/**
 * views/feedback.js — Stage 3: review and send.
 *
 * Nothing here sends anything until the teacher presses "Send feedback" AND
 * confirms the count. Every other action on this page is read-only.
 */

import { buildPupilFeedback, pupilSendStatus } from '../feedback-engine.js';
import { allResults, round, formatPercent } from '../grades.js';
import { validateAssessment } from '../validation.js';
import { renderFeedbackEmail } from '../../shared/email-template.js';
import { newId } from '../model.js';
import { $, el, clear, toast, openModal, confirmDialog, callout, plural } from '../ui.js';
import { state, update } from '../app.js';
import { sendFeedbackEmails, isConfigured, ApiNotConfiguredError } from '../api.js';

let isSending = false;      // guards against a second click while in flight
let lastResults = null;

export function init() {
  $('#teacher-note').addEventListener('input', (event) => {
    update((a) => { a.feedback.teacherNote = event.target.value; }, { rerender: false });
  });

  $('#toggle-parents').addEventListener('change', (event) => {
    update((a) => { a.feedback.sendToParents = event.target.checked; });
  });

  $('#btn-select-all').addEventListener('click', () => setSelection('all'));
  $('#btn-select-none').addEventListener('click', () => setSelection('none'));
  $('#check-all').addEventListener('change', (event) => setSelection(event.target.checked ? 'all' : 'none'));

  $('#btn-preview-first').addEventListener('click', () => {
    const pupil = sendablePupils(state.assessment)[0] || state.assessment.pupils[0];
    if (!pupil) { toast('Add a pupil first.', 'warn'); return; }
    openPreview(pupil);
  });

  $('#btn-send').addEventListener('click', handleSend);
}

/** Select every pupil who can actually receive feedback, or none. */
function setSelection(mode) {
  update((a) => {
    a.feedback.selectedPupilIds = mode === 'all'
      ? sendablePupils(a).map((p) => p.id)
      : [];
  });
}

function sendablePupils(assessment) {
  return assessment.pupils.filter((p) => pupilSendStatus(assessment, p).canSend);
}

/* --- Render -------------------------------------------------------------- */

export function render(assessment) {
  const { bySection } = validateAssessment(assessment);
  const blockers = [...bySection.exam, ...bySection.questions, ...bySection.boundaries, ...bySection.pupils];
  const blockerNode = clear($('#feedback-blocker'));
  if (blockers.length) {
    blockerNode.append(callout('warn', 'Some set-up is incomplete', blockers.slice(0, 5)));
  }

  if ($('#teacher-note') !== document.activeElement) {
    $('#teacher-note').value = assessment.feedback.teacherNote;
  }
  $('#toggle-parents').checked = assessment.feedback.sendToParents;

  // On first visit, pre-select everyone who is ready. Pupils with unmarked
  // questions are deliberately left out until the teacher opts them in.
  if (assessment.feedback.selectedPupilIds.length === 0 && !hasEverSelected(assessment)) {
    assessment.feedback.selectedPupilIds = assessment.pupils
      .filter((p) => {
        const status = pupilSendStatus(assessment, p);
        return status.canSend && !status.result.isProvisional;
      })
      .map((p) => p.id);
  }

  renderSendTable(assessment);
  renderApiStatus();
  renderSendResults();
  updateCounts(assessment);
}

// Distinguish "nothing selected yet" from "teacher deliberately cleared it".
const everSelected = new WeakSet();
function hasEverSelected(assessment) {
  if (everSelected.has(assessment)) return true;
  if (assessment.sendLog.length > 0) return true;
  return false;
}

function renderSendTable(assessment) {
  const body = clear($('#send-body'));
  const results = allResults(assessment);
  const selected = new Set(assessment.feedback.selectedPupilIds);

  if (assessment.pupils.length === 0) {
    body.append(el('tr', {}, el('td', { colspan: '7' },
      el('div', { class: 'empty' },
        el('span', { class: 'ico', text: '✉️' }),
        el('h3', { text: 'No pupils yet' }),
        el('p', { text: 'Add your class on the set-up page and enter some marks first.' }),
        el('button', { class: 'btn btn-primary', type: 'button', dataset: { goto: 'setup' } }, 'Go to set up')))));
    return;
  }

  assessment.pupils.forEach((pupil, index) => {
    const status = pupilSendStatus(assessment, pupil);
    const result = results[index];
    const isSelected = selected.has(pupil.id);

    const badges = el('div', { class: 'reasons' },
      ...status.blockedReasons.map((reason) => el('span', { class: 'badge badge-bad', text: reason })),
      ...status.warnings.map((warning) => el('span', { class: 'badge badge-warn', text: warning })),
      (assessment.feedback.sendToParents && pupil.parentEmail)
        ? el('span', { class: 'badge badge-brand', text: '+ parent' })
        : null,
    );

    body.append(el('tr', { class: status.canSend ? '' : 'is-blocked' },
      el('td', { class: 'chk' }, el('input', {
        type: 'checkbox', checked: isSelected, disabled: !status.canSend,
        'aria-label': `Send feedback to ${pupil.name}`,
        onchange: (event) => {
          everSelected.add(state.assessment);
          update((a) => {
            const set = new Set(a.feedback.selectedPupilIds);
            if (event.target.checked) set.add(pupil.id); else set.delete(pupil.id);
            a.feedback.selectedPupilIds = [...set];
          });
        },
      })),
      el('td', {}, el('div', { class: 'nm', text: pupil.name || `Pupil ${index + 1}` }), badges),
      el('td', {}, el('span', { class: 'em', text: pupil.email || '—' })),
      el('td', { class: 'num', text: result.hasAnyMark ? `${round(result.achieved, 1)}/${result.possible}` : '—' }),
      el('td', { class: 'num', text: result.hasAnyMark ? formatPercent(result.percentage) : '—' }),
      el('td', { style: 'text-align:center' },
        el('span', {
          class: `grade-pill ${result.grade === 'U' ? 'is-u' : ''} ${result.isProvisional ? 'is-provisional' : ''} ${!result.hasAnyMark ? 'is-none' : ''}`.trim(),
          text: result.hasAnyMark ? (result.grade ?? '—') : '—',
        })),
      el('td', { style: 'text-align:center' },
        el('button', {
          class: 'btn btn-sm btn-ghost', type: 'button',
          disabled: !result.hasAnyMark,
          onclick: () => openPreview(pupil),
        }, 'View')),
    ));
  });
}

function updateCounts(assessment) {
  const selected = assessment.feedback.selectedPupilIds.filter((id) =>
    assessment.pupils.some((p) => p.id === id && pupilSendStatus(assessment, p).canSend));

  const parentCount = assessment.feedback.sendToParents
    ? selected.filter((id) => assessment.pupils.find((p) => p.id === id)?.parentEmail).length
    : 0;

  $('#selected-count').textContent = `${selected.length} selected`;
  $('#check-all').checked = selected.length > 0 && selected.length === sendablePupils(assessment).length;
  $('#check-all').indeterminate = selected.length > 0 && selected.length < sendablePupils(assessment).length;

  const totalEmails = selected.length + parentCount;
  $('#send-hint').textContent = totalEmails === 0
    ? 'Select at least one pupil.'
    : `${plural(totalEmails, 'email')} will be sent (${selected.length} to pupils${parentCount ? `, ${parentCount} to parents` : ''}).`;
  $('#btn-send').disabled = totalEmails === 0 || isSending;

  const withParent = assessment.pupils.filter((p) => p.parentEmail).length;
  $('#parent-count-note').textContent = withParent === 0
    ? 'No parent email addresses have been entered, so no parent emails can be sent.'
    : `${plural(withParent, 'pupil')} in this class ${withParent === 1 ? 'has' : 'have'} a parent email address.`;

  const missing = assessment.pupils.filter((p) => !p.email.trim());
  const node = clear($('#send-warnings'));
  if (missing.length) {
    node.append(callout('warn', `${plural(missing.length, 'pupil')} cannot be emailed`,
      [...missing.slice(0, 6).map((p) => `${p.name || 'Unnamed pupil'} — no email address`),
        missing.length > 6 ? `…and ${missing.length - 6} more.` : null].filter(Boolean)));
  }
}

/* --- Preview ------------------------------------------------------------- */

function openPreview(pupil) {
  const assessment = state.assessment;
  const data = buildPupilFeedback(assessment, pupil);

  if (!data.hasAnyMark && assessment.exam.blankPolicy !== 'zero') {
    toast(`No marks have been entered for ${data.pupilName || 'this pupil'} yet.`, 'warn');
    return;
  }

  const container = el('div', {});
  const tabs = el('div', { style: 'display:flex;gap:6px;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--panel)' });
  const frame = el('iframe', { class: 'preview-frame', title: 'Email preview', sandbox: 'allow-same-origin' });
  container.append(tabs, frame);

  const show = (audience) => {
    const { subject, html } = renderFeedbackEmail(data, {
      audience,
      schoolName: window.QLA_CONFIG?.schoolName || '',
    });
    // srcdoc + a sandbox with no allow-scripts: the preview cannot run anything.
    frame.srcdoc = html;
    for (const button of tabs.querySelectorAll('button')) {
      button.classList.toggle('btn-primary', button.dataset.audience === audience);
    }
    $('#modal-title').textContent = `Preview — ${subject}`;
  };

  for (const [audience, label] of [['pupil', 'Pupil version'], ['parent', 'Parent version']]) {
    tabs.append(el('button', {
      class: 'btn btn-sm', type: 'button', dataset: { audience },
      onclick: () => show(audience),
    }, label));
  }

  openModal({
    title: 'Preview',
    body: container,
    wide: true,
    buttons: [
      { label: 'Close' },
    ],
  });
  show('pupil');
}

/* --- API status ---------------------------------------------------------- */

function renderApiStatus() {
  const node = clear($('#api-status'));
  if (isConfigured()) return;
  node.append(callout('info', 'Email backend not configured',
    'Everything on this page works except actually sending. Deploy the API (see DEPLOYMENT.md), then add its address under Settings. Nothing here pretends to send email that has not been sent.'));
}

/* --- Sending ------------------------------------------------------------- */

async function handleSend() {
  if (isSending) return;

  const assessment = state.assessment;
  const messages = buildMessages(assessment);
  if (messages.length === 0) { toast('Nothing to send.', 'warn'); return; }

  // Fail fast and clearly rather than reporting the same error once per pupil.
  if (!isConfigured()) {
    clear($('#send-results')).append(callout('bad', 'Nothing was sent',
      'No email backend is configured. Open Settings and enter the address of your deployed API — see DEPLOYMENT.md for how to deploy it.'));
    toast('No email backend configured — nothing was sent.', 'bad', 8000);
    return;
  }

  const pupilCount = messages.filter((m) => m.type === 'pupil').length;
  const parentCount = messages.filter((m) => m.type === 'parent').length;

  // Warn if this class has been sent to before — the most likely accident.
  const previous = assessment.sendLog.length;
  const warning = previous > 0
    ? el('div', { class: 'callout callout-warn', style: 'margin-top:12px' },
      el('span', { class: 'ico', text: '⚠️' }),
      el('div', {}, el('strong', { text: 'Feedback has already been sent for this assessment' }),
        el('span', { text: `Last sent ${new Date(assessment.sendLog[previous - 1].at).toLocaleString('en-GB')}. Sending again will deliver a second copy.` })))
    : null;

  const confirmed = await confirmDialog({
    title: 'Send feedback?',
    message: el('div', {},
      el('p', { style: 'margin:0 0 8px', text: `You are about to send feedback to ${plural(pupilCount, 'pupil')}${parentCount ? ` and ${plural(parentCount, 'parent')}` : ''}.` }),
      el('p', { style: 'margin:0;color:var(--muted);font-size:13.5px', text: `That is ${plural(messages.length, 'email')} in total. This cannot be undone.` }),
      warning),
    confirmLabel: `Send ${plural(messages.length, 'email')}`,
  });
  if (!confirmed) return;

  isSending = true;
  const button = $('#btn-send');
  button.disabled = true;
  clear($('#send-results'));
  button.replaceChildren(el('span', { class: 'spinner' }), document.createTextNode('Sending…'));

  const progressBox = $('#send-progress');
  progressBox.hidden = false;
  const bar = $('#progress-bar');
  const label = $('#progress-label');
  bar.style.width = '0%';
  label.textContent = `Preparing ${plural(messages.length, 'email')}…`;

  const batchId = newId('batch');

  try {
    const outcome = await sendFeedbackEmails(
      messages,
      {
        assessmentId: assessment.id,
        batchId,
        replyTo: assessment.exam.teacherEmail,
        replyToName: assessment.exam.teacherName,
        schoolName: window.QLA_CONFIG?.schoolName || '',
      },
      ({ done, total }) => {
        bar.style.width = `${Math.round((done / total) * 100)}%`;
        label.textContent = `Sending ${Math.min(done + 1, total)} of ${total}…`;
      },
    );

    lastResults = outcome;
    update((a) => {
      a.sendLog.push({
        at: new Date().toISOString(), batchId,
        sent: outcome.sent, failed: outcome.failed, total: messages.length,
      });
    });

    label.textContent = `Finished — ${outcome.sent} sent, ${outcome.failed} failed.`;
    bar.style.width = '100%';
    toast(outcome.failed === 0
      ? `Feedback sent successfully to ${plural(outcome.sent, 'recipient')}.`
      : `${outcome.sent} sent, ${outcome.failed} failed. See the details below.`,
    outcome.failed === 0 ? 'ok' : 'warn', 9000);
  } catch (error) {
    lastResults = null;
    progressBox.hidden = true;
    const message = error instanceof ApiNotConfiguredError
      ? error.message
      : `Sending failed: ${error.message}`;
    clear($('#send-results')).append(callout('bad', 'Nothing was sent', message));
    toast(message, 'bad', 10000);
  } finally {
    isSending = false;
    button.textContent = 'Send feedback';
    render(state.assessment);
  }
}

/** Turn the selection into the exact list of emails to send. */
function buildMessages(assessment) {
  const messages = [];
  const selected = new Set(assessment.feedback.selectedPupilIds);

  for (const pupil of assessment.pupils) {
    if (!selected.has(pupil.id)) continue;
    const status = pupilSendStatus(assessment, pupil);
    if (!status.canSend) continue;

    const data = buildPupilFeedback(assessment, pupil);
    messages.push({ id: `${pupil.id}:pupil`, type: 'pupil', to: pupil.email.trim(), data });

    // Parent email only when the toggle is on AND an address exists.
    if (assessment.feedback.sendToParents && pupil.parentEmail.trim()) {
      messages.push({ id: `${pupil.id}:parent`, type: 'parent', to: pupil.parentEmail.trim(), data });
    }
  }
  return messages;
}

function renderSendResults() {
  const node = clear($('#send-results'));
  if (!lastResults) return;

  const failures = lastResults.results.filter((r) => r.status !== 'sent');
  const skipped = lastResults.results.filter((r) => r.status === 'skipped');

  const simulated = lastResults.results.some((r) => r.simulated);
  if (lastResults.sent > 0) {
    node.append(simulated
      // Never let a dry run look like a real send.
      ? callout('warn', 'Simulated only — no email was actually sent',
        `The backend is running with DRY_RUN=true, so ${plural(lastResults.sent, 'email')} ${lastResults.sent === 1 ? 'was' : 'were'} prepared but not delivered. Remove DRY_RUN from the server's environment variables to send for real.`)
      : callout('ok', 'Feedback sent',
        `${plural(lastResults.sent, 'email')} accepted by the email provider.`));
  }
  if (skipped.length) {
    node.append(callout('info', 'Some emails were skipped',
      skipped.map((r) => `${r.to} — ${r.error || 'already sent in this batch'}`)));
  }
  const realFailures = failures.filter((r) => r.status === 'failed');
  if (realFailures.length) {
    node.append(callout('bad', `${plural(realFailures.length, 'email')} failed`,
      realFailures.slice(0, 10).map((r) => `${r.to} — ${r.error || 'unknown error'}`)));
    node.append(el('p', { class: 'hint', style: 'margin-top:-6px', text: 'Fix the addresses on the set-up page, deselect everyone who succeeded, and send again.' }));
  }
}
