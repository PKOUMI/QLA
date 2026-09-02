/**
 * views/feedback.js — Stage 3: review and send.
 *
 * Nothing here sends anything until the teacher presses "Send feedback" AND
 * confirms the count. Every other action on this page is read-only.
 */

import { canManage } from '../roles.js';
import { buildPupilFeedback, pupilSendStatus } from '../feedback-engine.js';
import { allResults, formatMark } from '../grades.js';
import { validateAssessment, countUnreachable } from '../validation.js';
import { renderFeedbackEmail, DEFAULT_EMAIL_TEXT } from '../../shared/email-template.js';
import { newId } from '../model.js';
import { toCsv } from '../csv.js';
import { $, el, clear, toast, openModal, closeModal, confirmDialog, callout, plural, downloadFile } from '../ui.js';
import { state, update } from '../app.js';
import { sendFeedbackEmails, isConfigured, ApiNotConfiguredError } from '../api.js';

let isSending = false;      // guards against a second click while in flight
let lastResults = null;

export function init() {
  $('#btn-select-all').addEventListener('click', () => setSelection('all'));
  $('#btn-select-none').addEventListener('click', () => setSelection('none'));
  $('#check-all').addEventListener('change', (event) => setSelection(event.target.checked ? 'all' : 'none'));
  $('#check-all-parents').addEventListener('change', (event) => setParentSelection(event.target.checked));

  $('#btn-preview-edit').addEventListener('click', () => openPreview(examplePupil(state.assessment), 'class'));

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


  // On first visit, pre-select everyone who is ready. Pupils with unmarked
  // questions are deliberately left out until the teacher opts them in.
  if (assessment.feedback.selectedPupilIds.length === 0 && !hasEverSelected(assessment)) {
    assessment.feedback.selectedPupilIds = sendablePupils(assessment).map((p) => p.id);
  }

  renderEmailSummary(assessment);
  renderSendTable(assessment);
  renderApiStatus();
  renderSendResults();
  updateCounts(assessment);

  // Last, so it can disable controls the code above has just rebuilt.
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
      hasPersonalWording(assessment, pupil.id)
        ? el('span', { class: 'badge badge-brand', title: 'This pupil\'s email has been edited on its own', text: 'own wording' })
        : null,

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
            const parents = new Set(a.feedback.parentSelectedPupilIds);
            if (event.target.checked) {
              set.add(pupil.id);
            } else {
              // Dropping a pupil drops their parent too — emailing a parent
              // about feedback the pupil is not getting makes no sense.
              set.delete(pupil.id);
              parents.delete(pupil.id);
            }
            a.feedback.selectedPupilIds = [...set];
            a.feedback.parentSelectedPupilIds = [...parents];
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
          title: `Open and edit ${pupil.name || 'this pupil'}'s own email`,
          onclick: () => openPreview(pupil, 'pupil'),
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
  const parentCount = parentEligible(assessment).filter((p) => parentSelected.has(p.id)).length;

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
 * Wording for one pupil: the defaults, then any assessment-wide edits, then
 * anything edited for that pupil alone. Used for the preview AND for sending,
 * so what is previewed is what is sent.
 */
export function wordingFor(assessment, pupilId) {
  const shared = assessment.emailText || {};
  const personal = (assessment.pupilEmailText || {})[pupilId] || {};
  const merge = (audience) => ({
    ...DEFAULT_EMAIL_TEXT[audience],
    ...(shared[audience] || {}),
    ...(personal[audience] || {}),
  });
  return { pupil: merge('pupil'), parent: merge('parent') };
}

/** Has this pupil's email been reworded on its own? */
function hasPersonalWording(assessment, pupilId) {
  const personal = (assessment.pupilEmailText || {})[pupilId];
  if (!personal) return false;
  return ['pupil', 'parent'].some((a) => personal[a] && Object.keys(personal[a]).length > 0);
}

/**
 * One screen for both jobs: it shows the real email, built from a real pupil's
 * marks, and lets the wording be edited directly on it.
 *
 * Two scopes, and the difference matters enough to be stated on screen:
 *   scope 'class'  — opened from the button above; edits every pupil's email
 *   scope 'pupil'  — opened from a row's View; edits that pupil's email only
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
function openPreview(pupil, scope = 'class') {
  const assessment = state.assessment;
  if (!pupil) { toast('Add a pupil first.', 'warn'); return; }

  const data = buildPupilFeedback(assessment, pupil);
  if (!data.hasAnyMark && assessment.exam.blankPolicy !== 'zero') {
    toast(`No marks have been entered for ${data.pupilName || 'this pupil'} yet.`, 'warn');
    return;
  }

  // Wording is part of what goes out to a parent, so it is an admin's to
  // change. A teacher can still open the preview and read it.
  const editable = canManage();
  const perPupil = scope === 'pupil';
  const pupilName = data.pupilName || 'this pupil';
  let audience = 'pupil';
  let dirty = false;

  // Everything is edited on a copy, so Cancel really does cancel.
  const draft = wordingFor(assessment, pupil.id);
  // What the pupil would get with no personal edits — used to work out which
  // fields the teacher has actually changed for them.
  const baseline = wordingFor(assessment, null);

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
    $('#modal-title').textContent = perPupil
      ? `${pupilName}'s email`
      : (editable ? 'Preview and edit email' : 'Preview email');
    status.textContent = `Built from ${pupilName}'s real results — ${subject}`;
  };

  frame.addEventListener('load', () => {
    const doc = frame.contentDocument;
    if (!doc || !editable) return;

    // Injected from here rather than baked into the email, so a real email
    // never carries preview styling.
    const style = doc.createElement('style');
    style.textContent = `
      [data-qla-edit]{outline:1px dashed rgba(79,70,229,.35);outline-offset:3px;border-radius:3px;
        transition:background .12s;cursor:text;white-space:pre-wrap;display:block;min-height:1em;}
      [data-qla-edit]:hover{background:rgba(79,70,229,.06)}
      [data-qla-edit]:focus{outline:2px solid #4f46e5;background:#fff;}
      [data-qla-ph]{background:rgba(79,70,229,.12);border-radius:3px;padding:0 2px;display:inline;}
      [data-qla-edit]:empty::before{content:attr(data-placeholder);color:#94a3b8;font-style:italic;}
    `;
    doc.head.appendChild(style);

    for (const region of doc.querySelectorAll('[data-qla-edit]')) {
      region.contentEditable = 'true';
      region.spellcheck = true;
      region.addEventListener('input', () => {
        draft[audience][region.dataset.qlaEdit] = readBack(region).replace(/\u00a0/g, ' ');
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

  // The scope of an edit is not something to leave anyone guessing about.
  const scopeBanner = perPupil
    ? el('div', { class: 'callout callout-warn scope-banner' },
      el('span', { class: 'ico', 'aria-hidden': 'true', text: '⚠️' }),
      el('div', {},
        el('strong', { text: `You are editing ${pupilName}'s email only` }),
        el('span', { text: 'Nothing you change here affects any other pupil. To change the wording for the whole class, close this and use “Preview and edit email” at the top of the page.' })))
    : el('div', { class: 'callout callout-info scope-banner' },
      el('span', { class: 'ico', 'aria-hidden': 'true', text: 'ℹ️' }),
      el('div', {},
        el('strong', { text: 'You are editing the email for every pupil' }),
        el('span', { text: `Shown with ${pupilName}'s results as an example. Pupils whose email you have edited individually keep their own wording.` })));

  const toolbar = el('div', { class: 'preview-toolbar' },
    tabs,
    el('div', { class: 'field preview-subject' },
      el('label', { for: 'preview-subject', class: 'label', text: 'Subject line' }),
      subjectInput),
    scopeBanner,
    editable
      ? el('p', { class: 'hint preview-tip' },
        'Click any highlighted text on the email to change it. ',
        el('span', { class: 'ph-chip', text: 'Amelia' }),
        ' marks a detail filled in for each pupil — leave it in place and it stays personal.')
      : el('p', { class: 'hint preview-tip', text: 'Only an admin can change the wording of the feedback email.' }),
    status,
  );

  /** Keep only the fields that actually differ from the class-wide wording. */
  const personalDiff = () => {
    const out = {};
    for (const aud of ['pupil', 'parent']) {
      const changed = {};
      for (const [key, value] of Object.entries(draft[aud])) {
        if (value !== baseline[aud][key]) changed[key] = value;
      }
      if (Object.keys(changed).length) out[aud] = changed;
    }
    return out;
  };

  const saveButtons = perPupil
    ? [
      { label: 'Cancel' },
      ...(hasPersonalWording(assessment, pupil.id) ? [{
        label: 'Use the class wording',
        onClick: () => {
          update((a) => { delete a.pupilEmailText[pupil.id]; });
          toast(`${pupilName}'s email is back to the wording used for the class.`, 'ok');
        },
      }] : []),
      {
        label: `Save for ${pupilName.split(' ')[0] || 'this pupil'} only`,
        class: 'btn-primary',
        onClick: () => {
          const diff = personalDiff();
          update((a) => {
            if (Object.keys(diff).length) a.pupilEmailText[pupil.id] = diff;
            else delete a.pupilEmailText[pupil.id];
          });
          toast(dirty
            ? `Saved for ${pupilName} only. No other pupil's email has changed.`
            : 'No changes to save.', 'ok', 6000);
        },
      },
    ]
    : [
      { label: 'Cancel' },
      {
        label: 'Reset wording',
        onClick: () => {
          update((a) => { a.emailText = {}; });
          toast('Email wording reset to the default. Individual pupils keep their own wording.', 'ok', 6000);
        },
      },
      {
        label: 'Save for everyone',
        class: 'btn-primary',
        onClick: () => {
          update((a) => {
            a.emailText = { pupil: { ...draft.pupil }, parent: { ...draft.parent } };
          });
          toast(dirty ? 'Email wording saved for every pupil in this assessment.' : 'No changes to save.', 'ok');
        },
      },
    ];

  openModal({
    title: 'Preview',
    body: el('div', { class: 'preview-shell' }, toolbar, frame),
    wide: true,
    buttons: editable ? saveButtons : [{ label: 'Close' }],
  });
  paint();
}

/** A short summary of the email, shown on the Feedback page itself. */
function renderEmailSummary(assessment) {
  const node = clear($('#email-summary'));
  const customised = assessment.pupils.filter((p) => hasPersonalWording(assessment, p.id));
  const edited = Object.keys(assessment.emailText || {}).length > 0;

  node.append(el('p', { class: 'muted', style: 'margin:0 0 8px' },
    edited
      ? 'The wording of these emails has been edited for this assessment.'
      : 'These emails use the standard wording: results, a question-by-question breakdown, what went well, even better if, and focus on.'));

  if (customised.length) {
    node.append(callout('info', `${plural(customised.length, 'pupil')} ${customised.length === 1 ? 'has' : 'have'} an individually edited email`,
      customised.slice(0, 6).map((p) => p.name || 'Unnamed pupil')
        .concat(customised.length > 6 ? [`…and ${customised.length - 6} more.`] : [])));
  }
}

/* --- API status ---------------------------------------------------------- */

function renderApiStatus() {
  const node = clear($('#api-status'));
  if (isConfigured()) return;
  node.append(callout('info', 'Email sending is not switched on for this site',
    'Everything on this page works except actually sending. The address of the email service is set once in config.js when the app is deployed — see DEPLOYMENT.md. '
    + 'Nothing here pretends to send email that has not been sent.'));
}

/* --- Sending ------------------------------------------------------------- */

async function handleSend() {
  if (isSending) return;

  const assessment = state.assessment;
  const messages = buildMessages(assessment);
  if (messages.length === 0) { toast('Nothing to send.', 'warn'); return; }

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

  // Addresses at a reserved top level domain cannot arrive, and every one is a
  // hard bounce against the sending account that also carries the sign-in
  // codes. Say so before the send rather than in the results afterwards.
  const unreachable = countUnreachable(messages.map((m) => m.to));
  const bounceWarning = unreachable.count > 0
    ? el('div', { class: 'callout callout-warn', style: 'margin-top:12px' },
      el('span', { class: 'ico', text: '⚠️' }),
      el('div', {},
        el('strong', { text: `${plural(unreachable.count, 'address')} cannot receive email` }),
        el('span', {
          text: `${unreachable.examples.join(', ')}${unreachable.count > unreachable.examples.length ? ' and others' : ''} use a reserved domain that never resolves, so these will bounce. `
            + 'That is expected of the sample class. Send a few rather than the whole year group, because bounces count against the account that also sends your sign-in codes.',
        })))
    : null;

  const confirmed = await confirmDialog({
    title: 'Send feedback now?',
    message: el('div', {},
      el('p', { class: 'confirm-lead' },
        'You are about to email ',
        el('strong', { text: plural(pupilCount, 'pupil') }),
        parentCount ? ' and ' : '',
        parentCount ? el('strong', { text: plural(parentCount, 'parent') }) : '',
        '.'),
      el('p', { style: 'margin:0 0 10px', text: `That is ${plural(messages.length, 'email')} in total. Emails cannot be recalled once they are sent.` }),
      el('p', { class: 'hint', style: 'margin:0', text: 'Check the marks are final and that you are happy with the wording before continuing.' }),
      warning, bounceWarning),
    confirmLabel: `Yes, send ${plural(messages.length, 'email')}`,
  });
  if (!confirmed) return;

  // Only now check the backend: the teacher has confirmed their intent, so if
  // this fails they get a clear reason rather than a dialog that led nowhere.
  if (!isConfigured()) {
    clear($('#send-results')).append(callout('bad', 'Nothing was sent',
      'This copy of the app has no email service address in config.js. That is set once when the app is deployed, not by each teacher — see DEPLOYMENT.md.'));
    toast('Email sending is not switched on for this site — nothing was sent.', 'bad', 8000);
    return;
  }

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
      },
      ({ done, total, phase, waitSeconds }) => {
        bar.style.width = `${Math.round((done / total) * 100)}%`;
        label.textContent = phase === 'waiting'
          // A pause is not a failure, and the teacher should be able to see that.
          ? `Sent ${done} of ${total}. Pausing ${waitSeconds}s for the email provider, then continuing…`
          : `Sending ${Math.min(done + 1, total)} of ${total}…`;
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
    const status = pupilSendStatus(assessment, pupil);
    if (!status.canSend) continue;

    const wantsPupil = selected.has(pupil.id);
    const wantsParent = parentSelected.has(pupil.id) && pupil.parentEmail.trim();
    if (!wantsPupil && !wantsParent) continue;

    const data = buildPupilFeedback(assessment, pupil);
    // Sent with this pupil's own wording, so an individually edited email is
    // delivered exactly as it was previewed.
    const text = wordingFor(assessment, pupil.id);
    if (wantsPupil) {
      messages.push({ id: `${pupil.id}:pupil`, type: 'pupil', to: pupil.email.trim(), data, text });
    }

    // Independent of the pupil's own tick, so a parent email that bounced can
    // be re-sent on its own without giving the pupil a second copy.
    if (wantsParent) {
      messages.push({ id: `${pupil.id}:parent`, type: 'parent', to: pupil.parentEmail.trim(), data, text });
    }
  }
  return messages;
}

/**
 * The results of a send, in full.
 *
 * An earlier version showed ten failures and no successes, which left a
 * teacher with 120 failed emails and no way to work out who still needed one.
 * Everything is listed, everything is filterable, and the failures can be
 * retried in one click without touching the pupils who already received theirs.
 */
function renderSendResults() {
  const node = clear($('#send-results'));
  if (!lastResults) return;

  const results = lastResults.results || [];
  const failed = results.filter((r) => r.status === 'failed');
  const skipped = results.filter((r) => r.status === 'skipped');
  const sent = results.filter((r) => r.status === 'sent');
  const simulated = results.some((r) => r.simulated);

  /* --- Headline ------------------------------------------------------- */
  if (sent.length) {
    node.append(simulated
      // Never let a dry run look like a real send.
      ? callout('warn', 'Simulated only — no email was actually sent',
        `The backend is running with DRY_RUN=true, so ${plural(sent.length, 'email')} ${sent.length === 1 ? 'was' : 'were'} prepared but not delivered. Remove DRY_RUN from the server's environment variables to send for real.`)
      : callout(failed.length ? 'warn' : 'ok',
        failed.length ? 'Partly sent' : 'Feedback sent',
        `${plural(sent.length, 'email')} accepted by the email provider${failed.length ? `, ${failed.length} failed` : ''}.`));
  } else if (failed.length) {
    node.append(callout('bad', 'Nothing was sent', `All ${plural(failed.length, 'email')} failed. The reasons are listed below.`));
  }

  if (skipped.length) {
    node.append(callout('info', 'Some emails were skipped',
      skipped.map((r) => `${r.to} — ${r.error || 'already sent in this batch'}`).slice(0, 8)));
  }

  if (!results.length) return;

  /* --- Retry, without re-sending to anyone who got one ----------------- */
  if (failed.length) {
    const retryBar = el('div', { class: 'retry-bar' },
      el('div', {},
        el('strong', { text: `${plural(failed.length, 'email')} still to send` }),
        el('span', { class: 'hint', text: ' Everyone who already received theirs is left alone.' })),
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-sm btn-primary', type: 'button',
        onclick: () => {
          // Exactly the messages that failed — not the pupils they belong to.
          // A pupil whose own email arrived but whose parent's bounced is left
          // unticked, so they cannot receive a second copy.
          const failedPupilEmails = failed.filter((r) => r.type !== 'parent')
            .map((r) => String(r.id).split(':')[0]);
          const failedParentEmails = failed.filter((r) => r.type === 'parent')
            .map((r) => String(r.id).split(':')[0]);
          update((a) => {
            a.feedback.selectedPupilIds = failedPupilEmails.filter((id) => a.pupils.some((p) => p.id === id));
            a.feedback.parentSelectedPupilIds = failedParentEmails.filter((id) => a.pupils.some((p) => p.id === id));
          });
          toast(`Ready to re-send ${plural(failed.length, 'email')} — only the ones that failed.`, 'ok', 7000);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        },
      }, 'Select the failures only'),
    );
    node.append(retryBar);
  }

  /* --- The full list, filterable -------------------------------------- */
  const rows = el('tbody');
  const draw = (filter) => {
    clear(rows);
    const shown = filter === 'all' ? results : results.filter((r) => r.status === filter);
    for (const r of shown) {
      rows.append(el('tr', {},
        el('td', {}, el('span', {
          class: `pill ${r.status === 'sent' ? 'pill-ok' : r.status === 'failed' ? 'pill-bad' : 'pill-warn'}`,
          text: r.status === 'sent' ? (r.simulated ? 'simulated' : 'sent') : r.status,
        })),
        el('td', {}, el('span', { class: 'em', text: r.to || '—' })),
        el('td', { text: r.type === 'parent' ? 'Parent' : 'Pupil' }),
        el('td', { class: 'reason', text: r.error || '' }),
      ));
    }
    if (!shown.length) rows.append(el('tr', {}, el('td', { colspan: '4', class: 'muted', text: 'Nothing in this group.' })));
  };

  const tabs = el('div', { class: 'result-tabs' });
  const addTab = (key, label, count) => {
    if (!count && key !== 'all') return;
    tabs.append(el('button', {
      class: `btn btn-sm${key === (failed.length ? 'failed' : 'all') ? ' btn-primary' : ''}`,
      type: 'button', dataset: { filter: key },
      onclick: (event) => {
        draw(key);
        for (const b of tabs.querySelectorAll('button')) b.classList.toggle('btn-primary', b === event.currentTarget);
      },
    }, `${label} (${count})`));
  };
  addTab('all', 'All', results.length);
  addTab('failed', 'Failed', failed.length);
  addTab('sent', 'Sent', sent.length);
  addTab('skipped', 'Skipped', skipped.length);

  node.append(el('div', { class: 'results-panel' },
    el('div', { class: 'results-head' },
      tabs,
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: () => {
          const rowsOut = [['Status', 'Email', 'Recipient', 'Reason']]
            .concat(results.map((r) => [r.status, r.to || '', r.type === 'parent' ? 'Parent' : 'Pupil', r.error || '']));
          downloadFile('qla-send-results.csv', toCsv(rowsOut), 'text/csv;charset=utf-8');
        },
      }, 'Download results'),
    ),
    el('div', { class: 'table-wrap results-table' },
      el('table', { class: 'data-table compact' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'Status' }), el('th', { text: 'Email' }),
          el('th', { text: 'Recipient' }), el('th', { text: 'Reason' }))),
        rows)),
  ));

  // Open on the group that needs attention.
  draw(failed.length ? 'failed' : 'all');
}
