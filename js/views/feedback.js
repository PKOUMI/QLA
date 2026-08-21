/**
 * views/feedback.js — Stage 3: review and send.
 *
 * Nothing here sends anything until the teacher presses "Send feedback" AND
 * confirms the count. Every other action on this page is read-only.
 */

import { buildPupilFeedback, pupilSendStatus } from '../feedback-engine.js';
import { allResults, formatMark } from '../grades.js';
import { validateAssessment } from '../validation.js';
import { renderFeedbackEmail, DEFAULT_EMAIL_TEXT } from '../../shared/email-template.js';
import { newId } from '../model.js';
import { $, el, clear, toast, openModal, closeModal, confirmDialog, callout, plural } from '../ui.js';
import { canEdit } from '../lock.js';
import { renderLockBar, applyLockState } from '../lockbar.js';
import { state, update } from '../app.js';
import { sendFeedbackEmails, isConfigured, ApiNotConfiguredError } from '../api.js';

let isSending = false;      // guards against a second click while in flight
let lastResults = null;

export function init() {
  $('#btn-select-all').addEventListener('click', () => setSelection('all'));
  $('#btn-select-none').addEventListener('click', () => setSelection('none'));
  $('#check-all').addEventListener('change', (event) => setSelection(event.target.checked ? 'all' : 'none'));
  $('#check-all-parents').addEventListener('change', (event) => setParentSelection(event.target.checked));

  $('#btn-preview-edit').addEventListener('click', () => openPreview(examplePupil(state.assessment)));

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

/** Pupils who could receive a parent email: sendable AND have a parent address. */
function parentEligible(assessment) {
  return sendablePupils(assessment).filter((p) => p.parentEmail.trim());
}

/** Tick or clear the whole Parents column. */
function setParentSelection(on) {
  update((a) => {
    a.feedback.parentSelectedPupilIds = on ? parentEligible(a).map((p) => p.id) : [];
    a.feedback.sendToParents = on;
  });
}

/* --- Render -------------------------------------------------------------- */

export function render(assessment) {
  const { bySection } = validateAssessment(assessment);
  const blockers = [...bySection.exam, ...bySection.questions, ...bySection.boundaries, ...bySection.pupils];
  const blockerNode = clear($('#feedback-blocker'));
  if (blockers.length) {
    blockerNode.append(callout('warn', 'Some set-up is incomplete', blockers.slice(0, 5)));
  }

  renderLockBar($('#lockbar-feedback'), assessment, 'feedback');

  // On first visit, pre-select everyone who is ready. Pupils with unmarked
  // questions are deliberately left out until the teacher opts them in.
  if (assessment.feedback.selectedPupilIds.length === 0 && !hasEverSelected(assessment)) {
    assessment.feedback.selectedPupilIds = sendablePupils(assessment).map((p) => p.id);
  }

  renderSendTable(assessment);
  renderApiStatus();
  renderSendResults();
  updateCounts(assessment);

  // Last, so it can disable controls the code above has just rebuilt.
  applyFeedbackLock(assessment);
}

/**
 * When the assessment is locked, the Feedback page is read-only: nobody can
 * change who receives feedback, reword the email, or send it. The preview
 * still opens, because looking at it harms nothing.
 */
function applyFeedbackLock(assessment) {
  const locked = applyLockState(
    $('#view-feedback'),
    assessment,
    '#view-feedback .card input, #view-feedback .card button.btn',
  );
  // The preview button is the one control that stays live while locked.
  const preview = $('#btn-preview-edit');
  preview.disabled = false;
  delete preview.dataset.lockedBy;
  preview.textContent = locked ? 'Preview email' : 'Preview and edit email';
  $('#btn-send').title = locked ? 'Enter the PIN to send feedback' : '';
}

/** The pupil whose real data fills the preview. */
function examplePupil(assessment) {
  return sendablePupils(assessment)[0] || assessment.pupils[0] || null;
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
  const parentSelected = new Set(assessment.feedback.parentSelectedPupilIds);

  if (assessment.pupils.length === 0) {
    body.append(el('tr', {}, el('td', { colspan: '8' },
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

    );

    const hasParentEmail = Boolean(pupil.parentEmail.trim());
    const parentChecked = parentSelected.has(pupil.id) && hasParentEmail && status.canSend;

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
      // Separate parent tick, so a pupil can be emailed while their parents
      // deliberately are not — a safeguarding requirement, not a nicety.
      el('td', { class: 'chk' }, hasParentEmail
        ? el('input', {
          type: 'checkbox', checked: parentChecked, disabled: !status.canSend,
          'aria-label': `Also send feedback about ${pupil.name} to their parent or guardian`,
          onchange: (event) => {
            update((a) => {
              const set = new Set(a.feedback.parentSelectedPupilIds);
              if (event.target.checked) set.add(pupil.id); else set.delete(pupil.id);
              a.feedback.parentSelectedPupilIds = [...set];
              // Keep the master switch honest about what is actually ticked.
              a.feedback.sendToParents = set.size > 0;
            });
          },
        })
        : el('span', { class: 'muted', title: 'No parent email address', text: '—' })),
      el('td', {}, el('div', { class: 'nm', text: pupil.name || `Pupil ${index + 1}` }), badges),
      el('td', {}, el('span', { class: 'em', text: pupil.email || '—' })),
      el('td', {}, hasParentEmail
        ? el('span', { class: 'em', text: pupil.parentEmail.trim() })
        : el('span', { class: 'muted', text: '—' })),
      el('td', { class: 'num', text: result.total === null ? '—' : `${formatMark(result.total)}/${result.possible}` }),
      el('td', { style: 'text-align:center' },
        el('span', {
          class: `grade-pill ${result.grade === 'U' ? 'is-u' : ''} ${result.grade === null ? 'is-none' : ''}`.trim(),
          text: result.grade ?? '—',
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

  // A parent email is sent only when the pupil is selected AND their own tick
  // in the Parents column is on AND a parent address exists.
  const parentSelected = new Set(assessment.feedback.parentSelectedPupilIds);
  const parentCount = selected.filter((id) => {
    const pupil = assessment.pupils.find((p) => p.id === id);
    return pupil && pupil.parentEmail.trim() && parentSelected.has(id);
  }).length;

  const sendableCount = sendablePupils(assessment).length;
  $('#selected-count').textContent = `${selected.length} selected`;
  $('#check-all').checked = selected.length > 0 && selected.length === sendableCount;
  $('#check-all').indeterminate = selected.length > 0 && selected.length < sendableCount;

  const eligibleParents = parentEligible(assessment).length;
  const parentTicked = parentEligible(assessment).filter((p) => parentSelected.has(p.id)).length;
  $('#check-all-parents').checked = parentTicked > 0 && parentTicked === eligibleParents;
  $('#check-all-parents').indeterminate = parentTicked > 0 && parentTicked < eligibleParents;
  $('#check-all-parents').disabled = eligibleParents === 0;

  const totalEmails = selected.length + parentCount;
  $('#send-hint').textContent = totalEmails === 0
    ? 'Select at least one pupil.'
    : `${plural(totalEmails, 'email')} will be sent (${selected.length} to pupils${parentCount ? `, ${parentCount} to parents` : ''}).`;
  $('#btn-send').disabled = totalEmails === 0 || isSending;

  const missing = assessment.pupils.filter((p) => !p.email.trim());
  const node = clear($('#send-warnings'));
  if (missing.length) {
    node.append(callout('warn', `${plural(missing.length, 'pupil')} cannot be emailed`,
      [...missing.slice(0, 6).map((p) => `${p.name || 'Unnamed pupil'} — no email address`),
        missing.length > 6 ? `…and ${missing.length - 6} more.` : null].filter(Boolean)));
  }
}

/* --- Preview and edit ---------------------------------------------------- */

/**
 * One screen for both jobs: it shows the real email, built from a real pupil's
 * marks, and lets the wording be edited directly on it.
 *
 * Why edit on the email rather than in a list of fields: the teacher is
 * changing how the email READS, and the only way to judge that is to see it in
 * place, next to the results it wraps around.
 *
 * The mechanism: the template marks its editable text with `data-qla-edit` and
 * wraps every substituted {placeholder} in a `data-qla-ph` span. The preview
 * turns those into contenteditable regions. Reading an edited region back
 * turns the marker spans into {placeholders} again — so editing an email that
 * greets "Amelia" saves "Hi {firstName}," and not Amelia's name for the class.
 *
 * The iframe is sandboxed WITHOUT allow-scripts, so nothing in the email can
 * run. It keeps allow-same-origin only so this page can reach in and wire up
 * the editing.
 */
function openPreview(pupil) {
  const assessment = state.assessment;
  if (!pupil) { toast('Add a pupil first.', 'warn'); return; }

  const data = buildPupilFeedback(assessment, pupil);
  if (!data.hasAnyMark && assessment.exam.blankPolicy !== 'zero') {
    toast(`No marks have been entered for ${data.pupilName || 'this pupil'} yet.`, 'warn');
    return;
  }

  const editable = canEdit(assessment);
  let audience = 'pupil';
  let dirty = false;

  // Everything is edited on a copy, so Cancel really does cancel.
  const draft = {
    pupil: { ...DEFAULT_EMAIL_TEXT.pupil, ...(assessment.emailText?.pupil || {}) },
    parent: { ...DEFAULT_EMAIL_TEXT.parent, ...(assessment.emailText?.parent || {}) },
  };
  let teacherNote = assessment.feedback.teacherNote || '';

  const frame = el('iframe', {
    class: 'preview-frame',
    title: 'Email preview',
    sandbox: 'allow-same-origin',   // deliberately no allow-scripts
  });

  const subjectInput = el('input', {
    type: 'text', id: 'preview-subject', class: 'subject-input',
    value: draft[audience].subject, disabled: !editable,
  });
  subjectInput.addEventListener('input', () => {
    draft[audience].subject = subjectInput.value;
    dirty = true;
  });

  const tabs = el('div', { class: 'tabs' });
  const status = el('span', { class: 'hint' });

  /** Turn an edited region back into template text, placeholders restored. */
  const readBack = (node) => {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) out += child.nodeValue;
      else if (child.nodeName === 'BR') out += '\n';
      else if (child.dataset && child.dataset.qlaPh) out += `{${child.dataset.qlaPh}}`;
      else out += readBack(child);
    }
    return out;
  };

  const paint = () => {
    const { subject, html } = renderFeedbackEmail(data, {
      audience,
      schoolName: window.QLA_CONFIG?.schoolName || '',
      text: draft,
      editable,
    });
    frame.srcdoc = html;
    subjectInput.value = draft[audience].subject;
    for (const button of tabs.querySelectorAll('button')) {
      button.classList.toggle('btn-primary', button.dataset.audience === audience);
    }
    $('#modal-title').textContent = editable ? 'Preview and edit email' : 'Preview email';
    status.textContent = `Showing ${data.pupilName || 'the first pupil'}'s real results — ${subject}`;
  };

  // Wire up editing once the iframe has rendered its document.
  frame.addEventListener('load', () => {
    const doc = frame.contentDocument;
    if (!doc || !editable) return;

    // Injected from here rather than baked into the email, so a real email
    // never carries preview styling.
    const style = doc.createElement('style');
    style.textContent = `
      [data-qla-edit]{outline:1px dashed rgba(79,70,229,.35);outline-offset:3px;border-radius:3px;
        transition:background .12s;cursor:text;white-space:pre-wrap;}
      [data-qla-edit]:hover{background:rgba(79,70,229,.06)}
      [data-qla-edit]:focus{outline:2px solid #4f46e5;background:#fff;}
      [data-qla-ph]{background:rgba(79,70,229,.12);border-radius:3px;padding:0 2px;}
      [data-qla-edit]:empty::before{content:attr(data-placeholder);color:#94a3b8;font-style:italic;}
    `;
    doc.head.appendChild(style);

    for (const region of doc.querySelectorAll('[data-qla-edit]')) {
      region.contentEditable = 'true';
      region.spellcheck = true;
      region.addEventListener('input', () => {
        const key = region.dataset.qlaEdit;
        const value = readBack(region).replace(/\u00a0/g, ' ');
        if (key === 'teacherNote') teacherNote = value.trim();
        else draft[audience][key] = value;
        dirty = true;
      });
      // Keep line breaks simple: Enter inserts a <br>, never a new block.
      region.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          doc.execCommand('insertLineBreak');
        }
      });
    }
  });

  for (const [value, label] of [['pupil', 'Pupil version'], ['parent', 'Parent version']]) {
    tabs.append(el('button', {
      class: 'btn btn-sm', type: 'button', dataset: { audience: value },
      onclick: () => { audience = value; paint(); },
    }, label));
  }

  const toolbar = el('div', { class: 'preview-toolbar' },
    tabs,
    el('div', { class: 'field preview-subject' },
      el('label', { for: 'preview-subject', class: 'label', text: 'Subject line' }),
      subjectInput),
    editable
      ? el('p', { class: 'hint preview-tip' },
        'Click any highlighted text on the email to change it. ',
        el('span', { class: 'ph-chip', text: 'Amelia' }),
        ' marks a detail filled in for each pupil — leave it in place and it stays personal.')
      : el('p', { class: 'hint preview-tip', text: 'The assessment is locked, so the wording cannot be changed. Enter the PIN to edit it.' }),
    status,
  );

  openModal({
    title: 'Preview',
    body: el('div', { class: 'preview-shell' }, toolbar, frame),
    wide: true,
    buttons: editable
      ? [
        { label: 'Cancel' },
        {
          label: 'Reset wording',
          onClick: () => {
            update((a) => { a.emailText = {}; });
            toast('Email wording reset to the default.', 'ok');
          },
        },
        {
          label: 'Save wording',
          class: 'btn-primary',
          onClick: () => {
            update((a) => {
              a.emailText = { pupil: { ...draft.pupil }, parent: { ...draft.parent } };
              a.feedback.teacherNote = teacherNote;
            });
            toast(dirty ? 'Email wording saved for every pupil in this assessment.' : 'No changes to save.', 'ok');
          },
        },
      ]
      : [{ label: 'Close' }],
  });
  paint();
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
        schoolName: window.QLA_CONFIG?.schoolName || '',
        text: assessment.emailText,
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
  const parentSelected = new Set(assessment.feedback.parentSelectedPupilIds);

  for (const pupil of assessment.pupils) {
    if (!selected.has(pupil.id)) continue;
    const status = pupilSendStatus(assessment, pupil);
    if (!status.canSend) continue;

    const data = buildPupilFeedback(assessment, pupil);
    messages.push({ id: `${pupil.id}:pupil`, type: 'pupil', to: pupil.email.trim(), data });

    // Parent email only when this pupil's own Parents tick is on AND an
    // address exists. The master toggle only sets those ticks; it is never
    // consulted here, so an individual exclusion always wins.
    if (parentSelected.has(pupil.id) && pupil.parentEmail.trim()) {
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
