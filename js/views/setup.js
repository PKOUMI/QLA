/**
 * views/setup.js — Stage 1: define the assessment.
 *
 * Exam details, questions (dynamic), grade boundaries (tier-dependent) and the
 * pupil list (manual entry or CSV import).
 */

import { newQuestion, newPupil, resizeQuestions, applyPaperType, pruneMarks, GRADE_SETS } from '../model.js';
import { totalPossible } from '../grades.js';
import { validateAssessment, isValidUrl, isValidEmail } from '../validation.js';
import { parsePupilCsv, pupilTemplateCsv } from '../csv.js';
import { $, el, clear, toast, openModal, confirmDialog, renderMessages, downloadFile, readFileAsText, plural } from '../ui.js';
import { state, update } from '../app.js';

/* --- Wiring (runs once) -------------------------------------------------- */

export function init() {
  // Exam detail text fields: keep a light touch so typing is never interrupted.
  bindText('#exam-name', (a, v) => { a.exam.name = v; });
  bindText('#exam-subject', (a, v) => { a.exam.subject = v; });
  bindText('#exam-class', (a, v) => { a.exam.className = v; });
  bindText('#exam-teacher', (a, v) => { a.exam.teacherName = v; });
  bindText('#exam-teacher-email', (a, v) => { a.exam.teacherEmail = v; });
  bindText('#exam-date', (a, v) => { a.exam.date = v; });

  $('#question-count').addEventListener('change', (event) => {
    const requested = Number(event.target.value);
    const current = state.assessment.questions.length;
    // The browser fires `change` again on blur, so ignore no-op changes —
    // otherwise we would rebuild the table just as the teacher clicks into it.
    if (!Number.isFinite(requested) || requested === current) return;
    if (requested < current) {
      const losing = current - requested;
      confirmDialog({
        title: 'Remove questions?',
        message: `This removes the last ${plural(losing, 'question')} and any marks already entered against them. This cannot be undone.`,
        confirmLabel: 'Remove', danger: true,
      }).then((ok) => {
        if (ok) update((a) => resizeQuestions(a, requested));
        else render(state.assessment);
      });
    } else {
      update((a) => resizeQuestions(a, requested));
    }
  });

  $('#btn-add-question').addEventListener('click', () => {
    update((a) => { a.questions.push(newQuestion(String(a.questions.length + 1), 1)); });
    focusLast('#questions-body', 'input');
  });

  $('#paper-type').addEventListener('change', (event) => {
    update((a) => applyPaperType(a, event.target.value));
  });

  $('#btn-add-pupil').addEventListener('click', addPupil);
  $('#btn-add-pupil-empty').addEventListener('click', addPupil);

  $('#btn-download-template').addEventListener('click', () => {
    downloadFile('qla-pupil-template.csv', pupilTemplateCsv(), 'text/csv;charset=utf-8');
    toast('Template downloaded. Keep the header row exactly as it is.', 'info', 6000);
  });

  $('#btn-import-csv').addEventListener('click', () => $('#csv-file').click());
  $('#csv-file').addEventListener('change', handleCsvFile);
}

function bindText(selector, apply) {
  const node = $(selector);
  node.addEventListener('input', (event) => {
    // rerender:false — a light refresh only. Rebuilding the DOM mid-keystroke
    // would lose the caret and steal focus from wherever the teacher clicks next.
    update((a) => apply(a, event.target.value), { rerender: false });
  });
}

function addPupil() {
  update((a) => { a.pupils.push(newPupil()); });
  focusLast('#pupils-body', 'input');
}

function focusLast(bodySelector, childSelector) {
  const rows = $(bodySelector).querySelectorAll('tr');
  const last = rows[rows.length - 1];
  if (last) last.querySelector(childSelector)?.focus();
}

/* --- Render -------------------------------------------------------------- */

/**
 * Structural render — rebuilds the three tables. Called when the view is opened
 * and whenever rows are added or removed, never on a keystroke.
 */
export function render(assessment) {
  setValue('#exam-name', assessment.exam.name);
  setValue('#exam-subject', assessment.exam.subject);
  setValue('#exam-class', assessment.exam.className);
  setValue('#exam-teacher', assessment.exam.teacherName);
  setValue('#exam-teacher-email', assessment.exam.teacherEmail);
  setValue('#exam-date', assessment.exam.date);
  setValue('#paper-type', assessment.exam.paperType);
  setValue('#question-count', String(assessment.questions.length));

  renderQuestions(assessment);
  renderBoundaries(assessment);
  renderPupils(assessment);
  refresh(assessment);
}

/**
 * Light refresh — totals, counts and messages only. Touches no input the
 * teacher might be using, so it is safe to call on every keystroke.
 */
export function refresh(assessment) {
  const { bySection, warnings } = validateAssessment(assessment);
  renderMessages($('#questions-errors'), { errors: bySection.questions });
  renderMessages($('#boundaries-errors'), { errors: bySection.boundaries });
  renderMessages($('#pupils-errors'), {
    errors: bySection.pupils,
    warnings: warnings.filter((w) => w.includes('no email address')),
  });

  updateQuestionTotal();
  updateBoundaryHints(assessment);
  $('#pupil-count-badge').textContent = plural(assessment.pupils.length, 'pupil');

  const total = totalPossible(assessment);
  const problems = bySection.exam.length + bySection.questions.length
    + bySection.boundaries.length + bySection.pupils.length;
  $('#setup-summary').textContent = problems === 0
    ? `Ready: ${plural(assessment.questions.length, 'question')}, ${total} marks, ${plural(assessment.pupils.length, 'pupil')}.`
    : `${plural(problems, 'thing')} still to fix before you can send feedback.`;
}

function setValue(selector, value) {
  const node = $(selector);
  if (node && document.activeElement !== node) node.value = value ?? '';
}

/* --- Questions table ----------------------------------------------------- */

function renderQuestions(assessment) {
  const body = clear($('#questions-body'));

  assessment.questions.forEach((question, index) => {
    const row = el('tr', {},
      el('td', { class: 'row-index', text: String(index + 1) }),
      el('td', {}, el('input', {
        type: 'text', value: question.number, placeholder: 'e.g. 3a', 'aria-label': `Question number, row ${index + 1}`,
        oninput: (e) => update((a) => { a.questions[index].number = e.target.value; }, { rerender: false }),
      })),
      el('td', {}, el('input', {
        type: 'number', min: '1', step: '0.5', value: question.maxMarks, class: 'num',
        'aria-label': `Maximum marks, question ${question.number || index + 1}`,
        'aria-invalid': !Number.isFinite(question.maxMarks) || question.maxMarks <= 0 ? 'true' : null,
        oninput: (e) => {
          const value = e.target.value === '' ? NaN : Number(e.target.value);
          e.target.setAttribute('aria-invalid', !Number.isFinite(value) || value <= 0 ? 'true' : 'false');
          update((a) => { a.questions[index].maxMarks = value; }, { rerender: false });
        },
      })),
      el('td', {}, el('input', {
        type: 'text', value: question.topic, placeholder: 'e.g. Algebra',
        'aria-label': `Topic, question ${question.number || index + 1}`,
        oninput: (e) => update((a) => { a.questions[index].topic = e.target.value; }, { rerender: false }),
      })),
      el('td', {}, el('input', {
        type: 'url', value: question.reteachUrl, placeholder: 'https://…',
        'aria-label': `Reteach link, question ${question.number || index + 1}`,
        'aria-invalid': question.reteachUrl.trim() && !isValidUrl(question.reteachUrl) ? 'true' : null,
        oninput: (e) => {
          const value = e.target.value.trim();
          e.target.setAttribute('aria-invalid', value && !isValidUrl(value) ? 'true' : 'false');
          update((a) => { a.questions[index].reteachUrl = e.target.value; }, { rerender: false });
        },
      })),
      el('td', {}, el('button', {
        class: 'btn btn-icon', type: 'button', title: 'Remove this question',
        'aria-label': `Remove question ${question.number || index + 1}`,
        disabled: assessment.questions.length === 1,
        onclick: () => update((a) => { a.questions.splice(index, 1); pruneMarks(a); }),
      }, '✕')),
    );
    body.append(row);
  });

  updateQuestionTotal();
}

function updateQuestionTotal() {
  const total = totalPossible(state.assessment);
  $('#questions-total').textContent = String(total);
  $('#questions-total-note').textContent = total > 0
    ? 'Check this matches the total on the front of your exam paper.'
    : 'Enter the marks available for each question.';
}

/* --- Grade boundaries ---------------------------------------------------- */

function renderBoundaries(assessment) {
  const grid = clear($('#boundaries-grid'));
  const total = totalPossible(assessment);

  assessment.gradeBoundaries.forEach((boundary, index) => {
    const isU = index === 0;
    grid.append(el('div', { class: 'field' },
      el('label', { for: `boundary-${boundary.grade}` },
        `Grade ${boundary.grade}`,
        isU ? el('span', { class: 'hint', style: 'font-weight:400', text: ' (always 0)' }) : null),
      el('input', {
        type: 'number', id: `boundary-${boundary.grade}`, min: '0', max: String(total || 1000), step: '1',
        class: 'num', value: boundary.minMark === null ? '' : boundary.minMark,
        placeholder: 'min mark', disabled: isU,
        oninput: (e) => update((a) => {
          a.gradeBoundaries[index].minMark = e.target.value === '' ? null : Number(e.target.value);
        }, { rerender: false }),
      }),
      el('span', { class: 'hint', id: `boundary-hint-${boundary.grade}` }),
    ));
  });

  const grades = GRADE_SETS[assessment.exam.paperType];
  $('#paper-type').setAttribute('aria-describedby', 'boundaries-errors');
  $('#paper-type').title = `${assessment.exam.paperType} tier: grades ${grades.join(', ')}`;
  updateBoundaryHints(assessment);
}

/** Show each boundary as a percentage of the paper, without rebuilding inputs. */
function updateBoundaryHints(assessment) {
  const total = totalPossible(assessment);
  for (const boundary of assessment.gradeBoundaries) {
    const hint = $(`#boundary-hint-${boundary.grade}`);
    if (!hint) continue;
    const value = Number(boundary.minMark);
    hint.textContent = total > 0 && boundary.minMark !== null && boundary.minMark !== '' && Number.isFinite(value)
      ? `${Math.round((value / total) * 100)}% of ${total}`
      : '';
  }
}

/* --- Pupils -------------------------------------------------------------- */

function renderPupils(assessment) {
  const hasPupils = assessment.pupils.length > 0;
  $('#pupils-empty').hidden = hasPupils;
  $('#pupils-table-wrap').hidden = !hasPupils;
  $('#pupil-count-badge').textContent = plural(assessment.pupils.length, 'pupil');

  const body = clear($('#pupils-body'));
  assessment.pupils.forEach((pupil, index) => {
    body.append(el('tr', {},
      el('td', { class: 'row-index', text: String(index + 1) }),
      el('td', {}, el('input', {
        type: 'text', value: pupil.name, placeholder: 'Full name', 'aria-label': `Pupil name, row ${index + 1}`,
        oninput: (e) => update((a) => { a.pupils[index].name = e.target.value; }, { rerender: false }),
      })),
      el('td', {}, el('input', {
        type: 'email', value: pupil.email, placeholder: 'pupil@school.sch.uk', 'aria-label': `Pupil email, row ${index + 1}`,
        oninput: (e) => {
          e.target.setAttribute('aria-invalid', e.target.value.trim() && !isValidEmail(e.target.value) ? 'true' : 'false');
          update((a) => { a.pupils[index].email = e.target.value; }, { rerender: false });
        },
      })),
      el('td', {}, el('input', {
        type: 'email', value: pupil.parentEmail, placeholder: 'optional', 'aria-label': `Parent email, row ${index + 1}`,
        oninput: (e) => {
          e.target.setAttribute('aria-invalid', e.target.value.trim() && !isValidEmail(e.target.value) ? 'true' : 'false');
          update((a) => { a.pupils[index].parentEmail = e.target.value; }, { rerender: false });
        },
      })),
      el('td', {}, el('button', {
        class: 'btn btn-icon', type: 'button', title: 'Remove this pupil',
        'aria-label': `Remove ${pupil.name || `pupil ${index + 1}`}`,
        onclick: async () => {
          const ok = await confirmDialog({
            title: 'Remove pupil?',
            message: `${pupil.name || 'This pupil'} and any marks entered for them will be removed.`,
            confirmLabel: 'Remove', danger: true,
          });
          if (ok) update((a) => { a.pupils.splice(index, 1); pruneMarks(a); });
        },
      }, '✕')),
    ));
  });
}

/* --- CSV import ---------------------------------------------------------- */

async function handleCsvFile(event) {
  const file = event.target.files[0];
  event.target.value = ''; // allow re-selecting the same file
  if (!file) return;

  if (file.size > 2 * 1024 * 1024) {
    toast('That file is larger than 2 MB — it does not look like a class list.', 'bad');
    return;
  }

  let text;
  try {
    text = await readFileAsText(file);
  } catch (error) {
    toast(error.message, 'bad');
    return;
  }

  const result = parsePupilCsv(text, state.assessment.pupils);
  const body = el('div', {});

  if (result.errors.length) {
    body.append(el('div', { class: 'callout callout-bad' },
      el('span', { class: 'ico', text: '⛔' }),
      el('div', {},
        el('strong', { text: `${plural(result.errors.length, 'problem')} found` }),
        el('ul', {}, result.errors.slice(0, 12).map((e) => el('li', { text: e }))),
        result.errors.length > 12 ? el('p', { class: 'hint', style: 'margin:6px 0 0', text: `…and ${result.errors.length - 12} more.` }) : null,
        el('p', { style: 'margin:8px 0 0', text: 'Rows with problems will not be imported. Fix them in your spreadsheet and try again, or import the valid rows now.' }),
      )));
  }

  if (result.warnings.length) {
    body.append(el('div', { class: 'callout callout-warn' },
      el('span', { class: 'ico', text: '⚠️' }),
      el('div', {},
        el('strong', { text: 'Worth checking' }),
        el('ul', {}, result.warnings.slice(0, 8).map((w) => el('li', { text: w }))))));
  }

  if (result.pupils.length) {
    body.append(el('p', { text: `${plural(result.pupils.length, 'pupil')} ready to import${result.skipped ? `, ${result.skipped} skipped` : ''}:` }));
    const preview = el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, el('th', { text: 'Name' }), el('th', { text: 'Pupil email' }), el('th', { text: 'Parent email' }))),
      el('tbody', {}, result.pupils.slice(0, 10).map((p) => el('tr', {},
        el('td', { text: p.name }), el('td', { text: p.email || '—' }), el('td', { text: p.parentEmail || '—' })))),
    );
    body.append(el('div', { class: 'table-wrap', style: 'max-height:260px' }, preview));
    if (result.pupils.length > 10) {
      body.append(el('p', { class: 'hint', text: `…and ${result.pupils.length - 10} more.` }));
    }
  } else {
    body.append(el('p', { text: 'Nothing can be imported from this file.' }));
  }

  openModal({
    title: 'Import class list',
    body,
    wide: true,
    buttons: [
      { label: 'Cancel' },
      ...(result.pupils.length ? [{
        label: `Import ${plural(result.pupils.length, 'pupil')}`,
        class: 'btn-primary',
        onClick: () => {
          update((a) => {
            for (const p of result.pupils) a.pupils.push(newPupil(p.name, p.email, p.parentEmail));
          });
          toast(`${plural(result.pupils.length, 'pupil')} imported.`, 'ok');
        },
      }] : []),
    ],
  });
}
