/**
 * views/marksheet.js — Stage 2: enter the marks.
 *
 * Built to feel like the QLA spreadsheet teachers already use — questions
 * across the top, pupils down the side, keyboard navigation between cells —
 * while validating every mark as it is typed.
 */

import { setMark, getMark } from '../model.js';
import { totalPossible, allResults, questionAverages, classSummary, round, formatPercent } from '../grades.js';
import { validateAssessment, validateMark } from '../validation.js';
import { marksheetCsv } from '../csv.js';
import { $, el, clear, toast, confirmDialog, downloadFile, plural, callout } from '../ui.js';
import { state, update } from '../app.js';

let showAverages = true;

export function init() {
  $('#toggle-averages').addEventListener('change', (event) => {
    showAverages = event.target.checked;
    render(state.assessment);
  });

  $('#btn-export-marks').addEventListener('click', () => {
    const assessment = state.assessment;
    const name = (assessment.exam.name || 'marksheet').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    downloadFile(`qla-${name}.csv`, marksheetCsv(assessment, allResults(assessment)), 'text/csv;charset=utf-8');
  });

  // Treating blanks as zero changes every total on the page, so it is explicit
  // and confirmed rather than a quiet toggle.
  $('#toggle-blank-policy').addEventListener('change', async (event) => {
    const wantsZero = event.target.checked;
    if (wantsZero) {
      const ok = await confirmDialog({
        title: 'Treat blanks as zero?',
        message: 'Every blank cell will count as a score of 0 for totals, percentages, grades, averages and feedback. Only do this once you have finished marking — otherwise pupils will be told they scored 0 on questions you simply have not marked yet.',
        confirmLabel: 'Yes, blanks are zeros',
      });
      if (!ok) { event.target.checked = false; return; }
    }
    update((a) => { a.exam.blankPolicy = wantsZero ? 'zero' : 'incomplete'; });
  });
}

export function render(assessment) {
  const { bySection } = validateAssessment(assessment);
  const blockers = [...bySection.questions, ...bySection.boundaries, ...bySection.pupils];
  const blockerNode = clear($('#marksheet-blocker'));

  if (blockers.length) {
    blockerNode.append(callout('warn', 'Finish setting up first', blockers.slice(0, 6)));
    blockerNode.append(el('div', { style: 'margin:-6px 0 18px' },
      el('button', { class: 'btn btn-sm', type: 'button', dataset: { goto: 'setup' } }, '← Go back to set up')));
  }

  if (assessment.pupils.length === 0 || assessment.questions.length === 0) {
    $('#marksheet-card').hidden = true;
    return;
  }
  $('#marksheet-card').hidden = false;

  $('#toggle-averages').checked = showAverages;
  $('#toggle-blank-policy').checked = assessment.exam.blankPolicy === 'zero';
  $('#marksheet-heading').textContent = assessment.exam.name || 'Marks';

  const results = allResults(assessment);
  renderStats(assessment, results);
  renderHead(assessment);
  renderBody(assessment, results);
  renderFoot(assessment);
  renderBlankSummary(assessment, results);
}

/* --- Stats strip --------------------------------------------------------- */

function renderStats(assessment, results) {
  const container = clear($('#marksheet-stats'));
  const summary = classSummary(assessment);
  const total = totalPossible(assessment);
  const cellCount = assessment.pupils.length * assessment.questions.length;
  const entered = results.reduce((sum, r) => sum + r.markedCount, 0);

  const stat = (value, label) => el('div', { class: 'stat' },
    el('div', { class: 'v', text: value }), el('div', { class: 'k', text: label }));

  container.append(
    stat(String(assessment.pupils.length), 'Pupils'),
    stat(String(assessment.questions.length), 'Questions'),
    stat(String(total), 'Marks available'),
    stat(cellCount ? `${Math.round((entered / cellCount) * 100)}%` : '0%', 'Marks entered'),
    stat(summary.averageMark === null ? '—' : String(round(summary.averageMark, 1)), 'Class average'),
    stat(summary.averagePercentage === null ? '—' : formatPercent(summary.averagePercentage), 'Average %'),
  );
}

/* --- Table head ---------------------------------------------------------- */

function renderHead(assessment) {
  const head = clear($('#marksheet-head'));
  const row = el('tr', {},
    el('th', { class: 'pupil-col', scope: 'col' },
      el('div', { class: 'pupil-cell', style: 'padding:8px 12px' }, 'Pupil')),
  );

  for (const question of assessment.questions) {
    row.append(el('th', { scope: 'col', title: question.topic || 'No topic set' },
      el('div', { class: 'qhead' },
        el('div', { class: 'qnum', text: `Q${question.number || '?'}` }),
        el('div', { class: 'qtopic', text: question.topic || '—' }),
        el('div', {}, el('span', { class: 'qmax', text: `/${question.maxMarks}` })),
      )));
  }

  row.append(
    el('th', { scope: 'col', style: 'text-align:right;min-width:78px' }, el('div', { class: 'qhead', text: 'Total' })),
    el('th', { scope: 'col', style: 'text-align:right;min-width:64px' }, el('div', { class: 'qhead', text: '%' })),
    el('th', { scope: 'col', style: 'text-align:center;min-width:70px' }, el('div', { class: 'qhead', text: 'Grade' })),
  );
  head.append(row);
}

/* --- Table body ---------------------------------------------------------- */

function renderBody(assessment, results) {
  const body = clear($('#marksheet-body'));

  assessment.pupils.forEach((pupil, rowIndex) => {
    const result = results[rowIndex];
    const row = el('tr', {},
      el('td', { class: 'pupil-col' }, el('div', { class: 'pupil-cell' },
        el('div', { class: 'nm', text: pupil.name || `Pupil ${rowIndex + 1}` }),
        el('div', { class: 'em', text: pupil.email || 'No email address' }))),
    );

    assessment.questions.forEach((question, colIndex) => {
      const mark = getMark(assessment, pupil.id, question.id);
      const cell = el('td', { class: 'mark-cell' });
      applyCellState(cell, mark, question.maxMarks);

      const input = el('input', {
        type: 'number', class: 'mark-input', min: '0', max: String(question.maxMarks), step: '0.5',
        value: mark === null ? '' : mark,
        inputmode: 'decimal',
        'aria-label': `${pupil.name || `Pupil ${rowIndex + 1}`}, question ${question.number}, out of ${question.maxMarks}`,
        dataset: { row: rowIndex, col: colIndex },
        oninput: (event) => onMarkInput(event, pupil, question, cell),
        onblur: (event) => onMarkBlur(event, pupil, question, cell),
        onkeydown: (event) => onMarkKey(event, rowIndex, colIndex),
        onfocus: (event) => event.target.select(),
      });

      cell.append(input);
      row.append(cell);
    });

    row.append(
      el('td', { class: 'total-col', dataset: { total: pupil.id } },
        result.hasAnyMark ? `${round(result.achieved, 1)} / ${result.possible}` : '—'),
      el('td', { class: 'pct-col', dataset: { pct: pupil.id } },
        result.hasAnyMark ? formatPercent(result.percentage) : '—'),
      el('td', { class: 'grade-col', dataset: { grade: pupil.id } }, gradePill(result)),
    );

    body.append(row);
  });
}

function gradePill(result) {
  if (!result.hasAnyMark && result.blankCount > 0 && !result.isComplete) {
    return el('span', { class: 'grade-pill is-none', text: '—', title: 'No marks entered' });
  }
  const classes = ['grade-pill'];
  if (result.grade === 'U') classes.push('is-u');
  if (result.isProvisional) classes.push('is-provisional');
  return el('span', {
    class: classes.join(' '),
    text: result.grade ?? '—',
    title: result.isProvisional
      ? `Provisional — ${plural(result.blankCount, 'question')} not marked yet`
      : `Grade ${result.grade}`,
  });
}

function applyCellState(cell, mark, maxMarks) {
  cell.classList.toggle('is-blank', mark === null);
  cell.classList.toggle('is-full', mark !== null && maxMarks > 0 && mark === maxMarks);
  cell.classList.toggle('is-zero', mark === 0);
}

/* --- Mark entry ---------------------------------------------------------- */

function onMarkInput(event, pupil, question, cell) {
  const input = event.target;
  const check = validateMark(input.value, question.maxMarks);

  input.classList.toggle('is-invalid', !check.ok);
  input.setAttribute('aria-invalid', check.ok ? 'false' : 'true');
  input.title = check.error;

  if (!check.ok) return; // invalid values never enter the data

  update((a) => setMark(a, pupil.id, question.id, check.value), { rerender: false });
  applyCellState(cell, check.value, question.maxMarks);
  refreshRowTotals(pupil.id);
  refreshAverages();
}

function onMarkBlur(event, pupil, question, cell) {
  const input = event.target;
  const check = validateMark(input.value, question.maxMarks);
  if (!check.ok) {
    // Put the field back to the last value we accepted, and say why.
    const stored = getMark(state.assessment, pupil.id, question.id);
    input.value = stored === null ? '' : stored;
    input.classList.remove('is-invalid');
    input.setAttribute('aria-invalid', 'false');
    applyCellState(cell, stored, question.maxMarks);
    toast(check.error, 'warn', 3500);
  }
}

/** Arrow keys and Enter move around the grid, like a spreadsheet. */
function onMarkKey(event, rowIndex, colIndex) {
  const moves = {
    ArrowUp: [-1, 0], ArrowDown: [1, 0], Enter: [1, 0],
    ArrowLeft: [0, -1], ArrowRight: [0, 1],
  };
  const move = moves[event.key];
  if (!move) return;

  // Let left/right work normally while the caret is mid-number.
  const input = event.target;
  if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && input.value.length > 0) {
    // number inputs don't expose selectionStart, so we only trap it when empty
    if (input.value !== '' && input.selectionStart === null) { /* fall through to move */ }
    else return;
  }

  const target = document.querySelector(
    `.mark-input[data-row="${rowIndex + move[0]}"][data-col="${colIndex + move[1]}"]`,
  );
  if (target) {
    event.preventDefault();
    target.focus();
  }
}

/* --- Live totals without a full re-render -------------------------------- */

function refreshRowTotals(pupilId) {
  const assessment = state.assessment;
  const results = allResults(assessment);
  const result = results.find((r) => r.pupilId === pupilId);
  if (!result) return;

  const totalCell = document.querySelector(`[data-total="${pupilId}"]`);
  const pctCell = document.querySelector(`[data-pct="${pupilId}"]`);
  const gradeCell = document.querySelector(`[data-grade="${pupilId}"]`);
  if (!totalCell) return;

  totalCell.textContent = result.hasAnyMark ? `${round(result.achieved, 1)} / ${result.possible}` : '—';
  pctCell.textContent = result.hasAnyMark ? formatPercent(result.percentage) : '—';
  clear(gradeCell).append(gradePill(result));

  renderStats(assessment, results);
  renderBlankSummary(assessment, results);
}

function refreshAverages() {
  if (!showAverages) return;
  renderFoot(state.assessment);
}

/* --- Averages row -------------------------------------------------------- */

function renderFoot(assessment) {
  const foot = clear($('#marksheet-foot'));
  if (!showAverages) return;

  const averages = questionAverages(assessment);
  const summary = classSummary(assessment);

  const row = el('tr', { class: 'avg-row' },
    el('td', { class: 'pupil-col' }, el('div', { class: 'pupil-cell' },
      el('div', { class: 'nm', text: 'Class average' }),
      el('div', { class: 'em', text: `${plural(summary.count, 'pupil')} with marks` }))),
  );

  averages.forEach((average) => {
    row.append(el('td', { class: 'avg-cell' },
      el('div', { class: 'avg-mark', text: average.average === null ? '—' : String(round(average.average, 1)) }),
      el('div', { class: 'avg-pct', text: average.percentage === null ? '' : formatPercent(average.percentage) }),
    ));
  });

  row.append(
    el('td', { class: 'total-col', style: 'background:transparent' },
      summary.averageMark === null ? '—' : `${round(summary.averageMark, 1)} / ${totalPossible(assessment)}`),
    el('td', { class: 'pct-col', style: 'background:transparent' },
      summary.averagePercentage === null ? '—' : formatPercent(summary.averagePercentage)),
    el('td', { class: 'grade-col', style: 'background:transparent' }, ''),
  );

  foot.append(row);
}

/* --- Unmarked summary ---------------------------------------------------- */

function renderBlankSummary(assessment, results = allResults(assessment)) {
  const node = clear($('#blank-summary'));
  const incomplete = results.filter((r) => r.blankCount > 0);

  if (assessment.exam.blankPolicy === 'zero') {
    node.append(callout('warn', 'Blanks are being counted as zero',
      'Every empty cell is currently treated as a score of 0. Untick the box below to go back to treating them as "not marked yet".'));
    return;
  }

  if (incomplete.length === 0) {
    node.append(callout('ok', '', 'Every question has been marked for every pupil.'));
    return;
  }

  const names = incomplete
    .map((r) => {
      const pupil = assessment.pupils.find((p) => p.id === r.pupilId);
      return `${pupil?.name || 'Unnamed pupil'} (${r.blankCount})`;
    })
    .slice(0, 8);

  node.append(callout('warn',
    `${plural(incomplete.length, 'pupil')} still ${incomplete.length === 1 ? 'has' : 'have'} unmarked questions`,
    [
      ...names,
      incomplete.length > 8 ? `…and ${incomplete.length - 8} more.` : null,
      'Their grades are shown as provisional and they are not selected for feedback by default.',
    ].filter(Boolean)));
}
