/**
 * views/analyse.js — step 3: what the class found hard.
 *
 * Everything here is read-only. It reads the same functions the marksheet and
 * feedback pages use, so a figure can never disagree between pages.
 *
 * Which cards appear is the teacher's choice and is saved with the assessment.
 */

import { state, update } from '../app.js';
import {
  totalPossible, questionAverages, topicAverages, gradeDistribution,
  completedTotals, classSummary, allResults, formatMark,
} from '../grades.js';
import { el, clear, $, plural } from '../ui.js';
import {
  mountChart, columnChart, donutChart, histogram, meterList,
  legend, dataTable, rampColour, binSizeOptions, autoBinSize,
} from '../charts.js';

/* --- Card scaffolding ---------------------------------------------------- */

/**
 * A chart card with a chart/table switch. The table view is not a nicety: it
 * is how the numbers stay reachable for anyone who cannot use the chart.
 */
function chartCard({ id, title, hint, drawChart, tableHeaders, tableRows, footer }) {
  const plot = el('div', { class: 'viz-plot' });
  const table = el('div', { class: 'viz-table', hidden: true });
  let tableBuilt = false;
  let showingTable = false;

  const toggle = el('button', {
    class: 'btn btn-quiet btn-sm', type: 'button', 'aria-pressed': 'false',
  }, 'Show as table');

  toggle.addEventListener('click', () => {
    showingTable = !showingTable;
    if (showingTable && !tableBuilt) {
      table.appendChild(dataTable(tableHeaders, tableRows()));
      tableBuilt = true;
    }
    plot.hidden = showingTable;
    table.hidden = !showingTable;
    toggle.textContent = showingTable ? 'Show as chart' : 'Show as table';
    toggle.setAttribute('aria-pressed', String(showingTable));
    if (!showingTable) repaint();
  });

  const card = el('section', { class: 'card viz-card', id: `card-${id}` },
    el('div', { class: 'viz-card-head' },
      el('div', {},
        el('h3', { text: title }),
        hint ? el('p', { class: 'muted small', text: hint }) : null),
      toggle),
    plot, table,
    footer || null,
  );

  // Draw once the card is in the document, so the container has a width.
  let repaint = () => {};
  queueMicrotask(() => { repaint = mountChart(plot, drawChart); });
  return card;
}

/* --- Customise panel ----------------------------------------------------- */

function customisePanel(assessment) {
  const prefs = assessment.settings.analyse;

  const chartToggle = (key, label) => {
    const input = el('input', { type: 'checkbox', id: `show-${key}`, checked: prefs.charts[key] });
    input.addEventListener('change', () => {
      update((a) => { a.settings.analyse.charts[key] = input.checked; });
    });
    return el('label', { class: 'check', for: `show-${key}` }, input, el('span', { text: label }));
  };

  const gradeType = el('select', { class: 'input input-sm', id: 'grade-chart-type' },
    el('option', { value: 'bar', text: 'Bar chart', selected: prefs.gradeChartType === 'bar' }),
    el('option', { value: 'donut', text: 'Pie / donut', selected: prefs.gradeChartType === 'donut' }));
  gradeType.addEventListener('change', () => {
    update((a) => { a.settings.analyse.gradeChartType = gradeType.value; });
  });

  const topicSort = el('select', { class: 'input input-sm', id: 'topic-sort' },
    el('option', { value: 'weakest', text: 'Weakest first', selected: prefs.topicSort === 'weakest' }),
    el('option', { value: 'strongest', text: 'Strongest first', selected: prefs.topicSort === 'strongest' }),
    el('option', { value: 'name', text: 'A to Z', selected: prefs.topicSort === 'name' }));
  topicSort.addEventListener('change', () => {
    update((a) => { a.settings.analyse.topicSort = topicSort.value; });
  });

  // Bar width on the mark distribution. Only offered when the paper is big
  // enough for the choice to mean anything, and only widths that fit.
  const possible = totalPossible(assessment);
  const steps = binSizeOptions(possible);
  let binSize = null;
  if (steps.length > 1) {
    const auto = autoBinSize(possible);
    binSize = el('select', { class: 'input input-sm', id: 'mark-bin-size' },
      el('option', {
        value: 'auto',
        text: `Automatic (${auto} ${auto === 1 ? 'mark' : 'marks'})`,
        selected: !steps.includes(Number(prefs.markBinSize)),
      }),
      steps.map((step) => el('option', {
        value: String(step),
        text: step === 1 ? 'Every mark' : `${step} marks`,
        selected: Number(prefs.markBinSize) === step,
      })));
    binSize.addEventListener('change', () => {
      update((a) => {
        a.settings.analyse.markBinSize = binSize.value === 'auto' ? 'auto' : Number(binSize.value);
      });
    });
  }

  return el('details', { class: 'customise', open: false },
    el('summary', {}, 'Customise this page'),
    el('div', { class: 'customise-body' },
      el('fieldset', { class: 'field-group' },
        el('legend', { text: 'Show' }),
        el('div', { class: 'check-row' },
          chartToggle('gradeDistribution', 'Grade distribution'),
          chartToggle('topicPerformance', 'Topic / AO performance'),
          chartToggle('questionAverages', 'Question breakdown'),
          chartToggle('markDistribution', 'Mark distribution'))),
      el('div', { class: 'customise-selects' },
        el('label', { class: 'field field-sm' },
          el('span', { class: 'label', text: 'Grade distribution as' }), gradeType),
        el('label', { class: 'field field-sm' },
          el('span', { class: 'label', text: 'Order topics by' }), topicSort),
        binSize ? el('label', { class: 'field field-sm' },
          el('span', { class: 'label', text: 'Marks per bar' }), binSize) : null),
    ));
}

/* --- Individual cards ---------------------------------------------------- */

function gradeCard(assessment) {
  const distribution = gradeDistribution(assessment);
  const prefs = assessment.settings.analyse;
  // Empty grades are dropped from the donut so colour has less work to do.
  const donutRows = distribution.rows.filter((r) => r.count > 0);
  const isDonut = prefs.gradeChartType === 'donut';

  return chartCard({
    id: 'grades',
    title: 'Grade distribution',
    hint: `${plural(distribution.graded, 'fully marked paper')} counted. Papers with a missing mark are not graded yet.`,
    drawChart: (width) => (isDonut
      ? donutChart(width, { data: donutRows.map((r) => ({ label: r.grade, value: r.count })) })
      : columnChart(width, { data: distribution.rows.map((r) => ({ label: r.grade, value: r.count })) })),
    tableHeaders: ['Grade', 'Boundary', 'Pupils'],
    tableRows: () => distribution.rows.map((r) => [r.grade, r.minMark ?? '—', r.count]),
    footer: isDonut && donutRows.length
      ? legend(donutRows.map((r, i) => ({ label: `Grade ${r.grade}`, colour: rampColour(i, donutRows.length) })))
      : null,
  });
}

function topicCard(assessment) {
  const prefs = assessment.settings.analyse;
  const topics = topicAverages(assessment);
  const sorted = [...topics].sort((a, b) => {
    if (prefs.topicSort === 'name') return a.topic.localeCompare(b.topic);
    return prefs.topicSort === 'strongest'
      ? b.proportion - a.proportion
      : a.proportion - b.proportion;
  });

  return chartCard({
    id: 'topics',
    title: 'Topic / AO performance',
    hint: 'Average marks the class achieved on each topic, across every question on that topic.',
    drawChart: () => meterList({
      rows: sorted.map((t) => ({
        label: t.topic,
        display: formatMark(t.averageMark),
        value: t.averageMark,
        max: t.maxMarks,
        sublabel: plural(t.questionCount, 'question'),
      })),
      emptyMessage: 'Add a topic to your questions on the Set up page to see this.',
    }),
    tableHeaders: ['Topic', 'Questions', 'Average mark', 'Out of'],
    tableRows: () => sorted.map((t) => [t.topic, t.questionCount, formatMark(t.averageMark), t.maxMarks]),
  });
}

/**
 * Questions: one card, not two.
 *
 * This used to be a bar list ("Question averages") sitting above a wide table
 * ("Question breakdown") that repeated the same numbers with a few more
 * columns. Reading it meant looking a question up twice. Now the bar carries
 * the average, a band behind it carries the range the class scored, and the
 * rest of the facts sit under each bar where that question already is.
 *
 * The table view keeps every column, because a table is still the right shape
 * for scanning forty questions at once — and for a screen reader.
 */
function questionCard(assessment) {
  const stats = questionAverages(assessment);

  return chartCard({
    id: 'questions',
    title: 'Question breakdown',
    hint: 'Every question in paper order, with the class average as a bar.',
    drawChart: () => meterList({
      rows: stats.map((stat) => {
        const question = assessment.questions.find((q) => q.id === stat.questionId);
        const facts = [];
        if (stat.lowest !== null) facts.push({ label: 'Lowest', value: formatMark(stat.lowest) });
        if (stat.highest !== null) facts.push({ label: 'Highest', value: formatMark(stat.highest) });
        if (stat.count) {
          facts.push({ label: 'Full marks', value: `${stat.scoredFull} of ${stat.count}` });
          facts.push({ label: 'Scored nothing', value: `${stat.scoredZero} of ${stat.count}` });
        }

        return {
          label: `Q${stat.number}${stat.topic ? ` · ${stat.topic}` : ''}`,
          display: formatMark(stat.average),
          value: stat.average,
          max: stat.maxMarks,
          low: stat.lowest,
          high: stat.highest,
          facts,
          sublabel: stat.notMarked ? `${stat.notMarked} not marked` : '',
          action: question && question.reteachUrl
            ? el('a', {
              href: question.reteachUrl, target: '_blank', rel: 'noopener noreferrer',
              text: 'Reteach resource',
            })
            : null,
        };
      }),
      emptyMessage: 'Enter some marks to see how the class did question by question.',
    }),
    tableHeaders: ['Question', 'Topic / AO', 'Out of', 'Class average', 'Lowest', 'Highest', 'Full marks', 'Scored nothing', 'Not marked', 'Reteach'],
    tableRows: () => stats.map((stat) => {
      const question = assessment.questions.find((q) => q.id === stat.questionId);
      return [
        `Q${stat.number}`,
        stat.topic || '—',
        stat.maxMarks,
        formatMark(stat.average),
        stat.lowest === null ? '—' : formatMark(stat.lowest),
        stat.highest === null ? '—' : formatMark(stat.highest),
        stat.count ? stat.scoredFull : '—',
        stat.count ? stat.scoredZero : '—',
        stat.notMarked || '—',
        question && question.reteachUrl ? question.reteachUrl : '—',
      ];
    }),
  });
}

function distributionCard(assessment) {
  const totals = completedTotals(assessment);
  const possible = totalPossible(assessment);
  const chosen = assessment.settings.analyse.markBinSize;
  const step = Number(chosen) > 0 ? Number(chosen) : autoBinSize(possible);
  return chartCard({
    id: 'spread',
    title: 'Mark distribution',
    hint: `Where the class landed, with your grade boundaries marked on. Each bar covers ${step === 1 ? '1 mark' : `${step} marks`} — change that under “Customise this page”.`,
    drawChart: (width) => histogram(width, {
      values: totals,
      totalMarks: possible,
      boundaries: assessment.gradeBoundaries,
      binSize: Number(chosen) > 0 ? Number(chosen) : null,
    }),
    tableHeaders: ['Pupil', 'Total', 'Grade'],
    tableRows: () => allResults(assessment)
      .filter((r) => r.isComplete)
      .map((r) => {
        const pupil = assessment.pupils.find((p) => p.id === r.pupilId);
        return [pupil ? pupil.name : '—', r.total, r.grade || '—'];
      }),
  });
}

/* --- Render -------------------------------------------------------------- */

export function render(assessment) {
  const root = $('#analyse-body');
  if (!root) return;
  clear(root);

  if (!assessment.pupils.length) {
    root.appendChild(el('div', { class: 'empty' },
      el('h3', { text: 'No pupils yet' }),
      el('p', { class: 'muted', text: 'Add your class on the Set up page, then enter marks. Analysis appears here automatically.' })));
    return;
  }

  const summary = classSummary(assessment);
  const results = allResults(assessment);
  const incomplete = results.filter((r) => !r.isComplete).length;

  root.appendChild(el('div', { class: 'stat-row' },
    el('div', { class: 'stat' },
      el('div', { class: 'stat-value', text: summary.averageMark === null ? '—' : formatMark(summary.averageMark) }),
      el('div', { class: 'stat-label', text: 'Class average marks' })),
    el('div', { class: 'stat' },
      el('div', { class: 'stat-value', text: summary.averageGrade || '—' }),
      el('div', { class: 'stat-label', text: 'Class average grade' })),
    el('div', { class: 'stat' },
      el('div', { class: 'stat-value', text: String(summary.count) }),
      el('div', { class: 'stat-label', text: 'Papers fully marked' })),
    el('div', { class: 'stat' },
      el('div', { class: 'stat-value', text: String(totalPossible(assessment)) }),
      el('div', { class: 'stat-label', text: 'Marks available' }))));

  if (incomplete > 0) {
    root.appendChild(el('div', { class: 'note note-warn' },
      el('strong', { text: `${plural(incomplete, 'paper')} not fully marked. ` }),
      el('span', { text: 'The question breakdown below uses every mark entered so far, but grade and mark distribution only count papers where every question has a mark.' })));
  }

  root.appendChild(customisePanel(assessment));

  const prefs = assessment.settings.analyse;

  // Full width, above the grid: forty question rows do not belong in a column
  // half the width of the page.
  if (prefs.charts.questionAverages) {
    root.appendChild(el('div', { class: 'viz-wide' }, questionCard(assessment)));
  }

  const cards = el('div', { class: 'viz-grid' });
  if (prefs.charts.gradeDistribution) cards.appendChild(gradeCard(assessment));
  if (prefs.charts.markDistribution) cards.appendChild(distributionCard(assessment));
  if (prefs.charts.topicPerformance) cards.appendChild(topicCard(assessment));
  root.appendChild(cards);

  // The question breakdown lives outside this grid, so "nothing is showing"
  // has to account for it or the message appears while a card is on screen.
  if (!cards.childElementCount && !prefs.charts.questionAverages) {
    root.appendChild(el('div', { class: 'empty' },
      el('h3', { text: 'All charts hidden' }),
      el('p', { class: 'muted', text: 'Use “Customise this page” above to turn charts back on.' })));
  }
}

export function refresh(assessment) { render(assessment); }
export function init() { /* nothing to bind: this view is rebuilt on render */ }
