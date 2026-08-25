/**
 * views/marksheet.js — Stage 2: enter the marks.
 *
 * Built to feel like the QLA spreadsheet teachers already use — questions
 * across the top, pupils down the side, keyboard navigation between cells —
 * while validating every mark as it is typed.
 */

import { setMark, getMark } from '../model.js';
import { totalPossible, allResults, questionAverages, classSummary, round, formatMark } from '../grades.js';
import { validateAssessment, validateMark } from '../validation.js';
import { marksheetCsv } from '../csv.js';
import { $, el, clear, toast, confirmDialog, downloadFile, plural, callout } from '../ui.js';
import { state, update } from '../app.js';

let showAverages = true;
let isExpanded = false;

/**
 * Full-window mode.
 *
 * Entering marks for a whole class is the one job in this app that wants the
 * entire screen: the page header, the stats and the surrounding cards are
 * useful context right up until you are typing 200 numbers, at which point
 * they are just fewer pupils on screen.
 */
function setExpanded(expanded) {
  isExpanded = expanded;
  document.body.classList.toggle('marks-expanded', expanded);

  const button = $('#btn-expand-marks');
  button.textContent = expanded ? 'Exit full screen' : 'Expand';
  button.setAttribute('aria-pressed', String(expanded));
  button.classList.toggle('btn-primary', !expanded);

  const wrap = $('.marksheet-wrap');
  if (wrap) {
    // Expanded, the height comes from the flex layout, so the measured
    // max-height has to get out of the way.
    wrap.style.maxHeight = expanded ? '' : wrap.style.maxHeight;
  }
  if (!expanded) requestAnimationFrame(fitMarksheetHeight);

  // Put focus somewhere useful rather than leaving it on a button that has
  // just moved.
  if (expanded) document.querySelector('.mark-input')?.focus();
}

// Escape is what everyone tries first to get out of a full-screen view.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isExpanded && !document.querySelector('#modal-backdrop.is-open')) {
    setExpanded(false);
  }
});

/**
 * Called by the router when the teacher leaves this page.
 *
 * Full-window mode hides the site header, so it must not survive the marksheet
 * being left — including by the browser's Back button, which is how it was
 * found: Back took you to another page with no header and no way to get it
 * back short of reloading.
 */
export function onLeave() {
  if (isExpanded) setExpanded(false);
}

// A second line of defence. Some browsers fire popstate without a hashchange
// (a same-hash history entry, or a restored session), and the header going
// missing is bad enough to be worth guarding twice.
window.addEventListener('popstate', () => { if (isExpanded) setExpanded(false); });

export function init() {
  $('#btn-expand-marks').addEventListener('click', () => setExpanded(!isExpanded));

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
        message: 'Every blank cell will count as a score of 0 for totals, grades, averages and feedback. Only do this once you have finished marking — otherwise pupils will be told they scored 0 on questions you simply have not marked yet.',
        confirmLabel: 'Yes, blanks are zeros',
      });
      if (!ok) { event.target.checked = false; return; }
    }
    update((a) => { a.exam.blankPolicy = wantsZero ? 'zero' : 'incomplete'; });
  });
}

/**
 * Give the mark grid every pixel that is actually left on screen.
 *
 * A fixed max-height cannot work here: how much room is left depends on how
 * many stats wrap, whether a set-up warning is showing and how tall the
 * window is. So it is measured. Teachers mark whole classes in one sitting,
 * and scrolling a 30-name list four rows at a time is the difference between
 * this being usable and not.
 */
function fitMarksheetHeight() {
  const wrap = $('.marksheet-wrap');
  if (!wrap) return;

  // Distance from the top of the document, so the result does not change as
  // the page is scrolled.
  if (isExpanded) { wrap.style.maxHeight = ''; return; }   // flex owns the height

  const top = wrap.getBoundingClientRect().top + window.scrollY;
  const roomBelow = 44;              // legend, card edge and a little breathing space
  const available = window.innerHeight - top - roomBelow;
  wrap.style.maxHeight = `${Math.max(240, Math.round(available))}px`;
}

// Re-measure when the window changes shape (including a laptop being docked).
let resizeQueued = false;
window.addEventListener('resize', () => {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => { resizeQueued = false; fitMarksheetHeight(); });
});

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

  // After the table exists, so the measurement is of the real layout.
  requestAnimationFrame(fitMarksheetHeight);
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
    // The only percentage in the app: progress through marking, not attainment.
    stat(cellCount ? `${Math.round((entered / cellCount) * 100)}%` : '0%', 'Marks entered'),
    stat(summary.averageMark === null ? '—' : formatMark(summary.averageMark), 'Class average marks'),
    stat(summary.averageGrade || '—', 'Class average grade'),
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
    el('th', { scope: 'col', style: 'text-align:right;min-width:88px' }, el('div', { class: 'qhead', text: 'Total' })),
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
      el('td', { class: 'pupil-col' }, el('div', {
        class: 'pupil-cell',
        title: pupil.email || 'No email address — feedback cannot be sent to this pupil',
      },
      el('div', { class: 'nm', text: pupil.name || `Pupil ${rowIndex + 1}` }),
      pupil.email.trim() ? null : el('span', {
        class: 'warn-dot', 'aria-label': 'No email address', text: '⚠',
      }))),
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
        // The pupil and question are on the element so that anything reading
        // the grid — a test, a screen reader script — can tie a box to the
        // cell it stores, without counting rows and columns.
        dataset: { row: rowIndex, col: colIndex, pupil: pupil.id, question: question.id },
        oninput: (event) => onMarkInput(event, pupil, question, cell),
        onblur: (event) => onMarkBlur(event, pupil, question, cell),
        onkeydown: (event) => onMarkKey(event, rowIndex, colIndex),
        onfocus: (event) => event.target.select(),
      });

      cell.append(input);
      row.append(cell);
    });

    row.append(
      el('td', { class: 'total-col', dataset: { total: pupil.id } }, totalCellContent(result)),
      el('td', { class: 'grade-col', dataset: { grade: pupil.id } }, gradePill(result)),
    );

    body.append(row);
  });
}

/**
 * A paper is only totalled once every question has a mark. Showing a running
 * total against a full-paper grade boundary would read as a fail, so an
 * unfinished paper gets a dash and a tooltip saying what is outstanding.
 */
function totalCellContent(result) {
  if (result.total === null) {
    return el('span', {
      class: 'awaiting',
      text: '—',
      title: `${plural(result.blankCount, 'question')} still to mark`,
    });
  }
  return `${formatMark(result.total)} / ${result.possible}`;
}

function gradePill(result) {
  if (result.grade === null) {
    return el('span', {
      class: 'grade-pill is-none',
      text: '—',
      title: result.hasAnyMark
        ? `Not graded yet — ${plural(result.blankCount, 'question')} still to mark`
        : 'No marks entered yet',
    });
  }
  const classes = ['grade-pill'];
  if (result.grade === 'U') classes.push('is-u');
  return el('span', { class: classes.join(' '), text: result.grade, title: `Grade ${result.grade}` });
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

  // An impossible mark clears the cell rather than leaving the previous one
  // behind it. Otherwise the box says 33 while the data still says 3, and one
  // of the two is going to surprise somebody later.
  update((a) => setMark(a, pupil.id, question.id, check.ok ? check.value : null), { rerender: false });
  applyCellState(cell, check.ok ? check.value : null, question.maxMarks);
  refreshRowTotals(pupil.id);
  refreshAverages();
}

/**
 * What to say when a mark cannot be accepted. It names the number that was
 * typed, because "maximum is 6" on its own leaves a teacher wondering which
 * cell it is complaining about.
 */
function rejectionMessage(typed, question, error) {
  const value = String(typed).trim();
  const where = `question ${question.number}`;
  if (Number(value) > question.maxMarks) {
    return `${value} is more than the ${question.maxMarks} marks available for ${where}. `
      + 'The box has been left blank — enter the mark again.';
  }
  return `${error} (${where}) The box has been left blank — enter the mark again.`;
}

function onMarkBlur(event, pupil, question, cell) {
  const input = event.target;
  const check = validateMark(input.value, question.maxMarks);
  if (check.ok) return;

  /*
   * LEAVE IT BLANK. Not corrected to the maximum, and not quietly put back to
   * whatever was there before.
   *
   * Someone marking a 6-mark question who means 3 and types 33 must end up
   * looking at an empty box. Any value the app chooses for them — the maximum,
   * or the mark that was there a moment ago — looks exactly like a mark they
   * entered themselves, and would go out to a child in a feedback email
   * without anybody noticing. Blank is the one state the app already makes
   * loud: an empty cell, counted under "unmarked questions", and no total or
   * grade for that pupil until it is filled in.
   */
  const typed = input.value;
  input.value = '';
  input.classList.remove('is-invalid');
  input.setAttribute('aria-invalid', 'false');
  input.title = '';
  update((a) => setMark(a, pupil.id, question.id, null), { rerender: false });
  applyCellState(cell, null, question.maxMarks);
  refreshRowTotals(pupil.id);
  refreshAverages();
  toast(rejectionMessage(typed, question, check.error), 'warn', 6000);
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
  const gradeCell = document.querySelector(`[data-grade="${pupilId}"]`);
  if (!totalCell) return;

  const totalContent = totalCellContent(result);
  clear(totalCell).append(typeof totalContent === 'string'
    ? document.createTextNode(totalContent) : totalContent);
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
    el('td', { class: 'pupil-col' }, el('div', {
      class: 'pupil-cell',
      title: `${plural(summary.count, 'fully marked paper')} included`,
    }, el('div', { class: 'nm', text: 'Class average marks' }))),
  );

  averages.forEach((average) => {
    row.append(el('td', { class: 'avg-cell' },
      el('div', { class: 'avg-mark', text: average.average === null ? '—' : formatMark(average.average) }),
      el('div', { class: 'avg-outof', text: average.maxMarks ? `/ ${average.maxMarks}` : '' }),
    ));
  });

  row.append(
    el('td', { class: 'total-col', style: 'background:transparent' },
      summary.averageMark === null ? '—' : `${formatMark(summary.averageMark)} / ${totalPossible(assessment)}`),
    el('td', { class: 'grade-col', style: 'background:transparent' },
      summary.averageGrade
        ? el('span', { class: `grade-pill${summary.averageGrade === 'U' ? ' is-u' : ''}`, text: summary.averageGrade })
        : ''),
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
      'They cannot be selected for feedback.',
    ].filter(Boolean)));
}
