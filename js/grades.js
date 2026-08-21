/**
 * grades.js — all the arithmetic. Pure functions, no DOM, no storage.
 *
 * Everything the marksheet, the Analyse page and the feedback page display
 * comes from here, so the numbers can never disagree between pages.
 *
 * A deliberate design rule: this app reports MARKS AND GRADES, not percentages.
 * Percentages are computed internally where a proportion is genuinely needed
 * (the >80% / <25% feedback rules, and the fill width of a bar) but they are
 * never surfaced as a figure to the teacher, because GCSE-style assessment is
 * read against grade boundaries rather than percentages.
 */

import { getMark } from './model.js';

/** Total marks available on the paper. */
export function totalPossible(assessment) {
  return assessment.questions.reduce(
    (sum, q) => sum + (Number.isFinite(q.maxMarks) ? q.maxMarks : 0), 0,
  );
}

/**
 * Grade for a raw mark, using the teacher's boundaries.
 * Boundaries are "minimum mark to achieve this grade", ascending.
 * Returns the highest grade whose boundary the mark reaches.
 */
export function gradeForMark(gradeBoundaries, mark) {
  if (!Number.isFinite(mark)) return null;
  let result = null;
  for (const boundary of gradeBoundaries) {
    if (boundary.minMark === null || boundary.minMark === '') continue;
    if (mark >= Number(boundary.minMark)) result = boundary.grade;
  }
  // Fall back to the lowest grade so a mark always resolves to something.
  return result ?? (gradeBoundaries[0] ? gradeBoundaries[0].grade : null);
}

/** True once every grade has a usable boundary. */
export function boundariesReady(assessment) {
  return assessment.gradeBoundaries.every(
    (b) => b.minMark !== null && b.minMark !== '' && Number.isFinite(Number(b.minMark)),
  );
}

/**
 * Everything about one pupil's performance.
 *
 * A total and a grade are only produced once EVERY question has a mark. A
 * part-marked paper cannot be totalled honestly — half a paper marked out of a
 * full-paper boundary would read as a fail — so `achievedIfComplete` and
 * `grade` stay null and the UI shows a dash instead.
 *
 * The one exception is exam.blankPolicy === 'zero', where the teacher has
 * explicitly confirmed that blank means the pupil scored nothing.
 */
export function pupilResult(assessment, pupilId) {
  const policy = assessment.exam.blankPolicy;
  const possible = totalPossible(assessment);

  let achieved = 0;
  let blankCount = 0;
  let markedCount = 0;

  for (const question of assessment.questions) {
    const mark = getMark(assessment, pupilId, question.id);
    if (mark === null) {
      blankCount += 1;
      continue;
    }
    achieved += mark;
    markedCount += 1;
  }

  // 'zero' policy means blanks are real zeros, so the paper counts as finished.
  const isComplete = blankCount === 0 || policy === 'zero';

  return {
    pupilId,
    // Running total of what has actually been marked. Used for averages and
    // for the feedback breakdown — NOT shown as the pupil's total until
    // the paper is complete.
    achieved,
    possible,
    blankCount,
    markedCount,
    hasAnyMark: markedCount > 0,
    isComplete,
    // Null until the paper is fully marked. The UI renders a dash for null.
    total: isComplete ? achieved : null,
    grade: isComplete ? gradeForMark(assessment.gradeBoundaries, achieved) : null,
  };
}

/** Results for every pupil, in list order. */
export function allResults(assessment) {
  return assessment.pupils.map((p) => pupilResult(assessment, p.id));
}

/** How many of the pupil x question cells have been filled in. */
export function markProgress(assessment) {
  const cells = assessment.pupils.length * assessment.questions.length;
  let entered = 0;
  for (const pupil of assessment.pupils) {
    for (const question of assessment.questions) {
      if (getMark(assessment, pupil.id, question.id) !== null) entered += 1;
    }
  }
  return { entered, cells, fraction: cells > 0 ? entered / cells : 0 };
}

/**
 * Class average for each question. Blank marks are excluded from both the
 * numerator and the count — an unmarked question tells us nothing.
 *
 * `proportion` (0-1) exists so a bar can be drawn to the right width. It is a
 * geometry value, not a figure for display.
 */
export function questionAverages(assessment) {
  return assessment.questions.map((question) => {
    let sum = 0;
    let count = 0;
    let lowest = null;
    let highest = null;
    let notMarked = 0;

    for (const pupil of assessment.pupils) {
      const mark = getMark(assessment, pupil.id, question.id);
      if (mark === null) {
        notMarked += 1;
        if (assessment.exam.blankPolicy === 'zero') {
          count += 1;
          lowest = lowest === null ? 0 : Math.min(lowest, 0);
          highest = highest === null ? 0 : Math.max(highest, 0);
        }
        continue;
      }
      sum += mark;
      count += 1;
      lowest = lowest === null ? mark : Math.min(lowest, mark);
      highest = highest === null ? mark : Math.max(highest, mark);
    }

    const max = Number.isFinite(question.maxMarks) ? question.maxMarks : 0;
    const average = count > 0 ? sum / count : null;
    return {
      questionId: question.id,
      number: question.number,
      topic: question.topic,
      average,
      lowest,
      highest,
      notMarked,
      count,
      maxMarks: max,
      proportion: average !== null && max > 0 ? average / max : null,
    };
  });
}

/**
 * Average performance grouped by topic / assessment objective, so several
 * questions on the same topic are judged together. Case-insensitive grouping,
 * first-seen spelling kept for display.
 */
export function topicAverages(assessment) {
  const groups = new Map();

  for (const stat of questionAverages(assessment)) {
    const label = (stat.topic || '').trim();
    if (!label) continue;                      // untopiced questions are skipped
    const key = label.toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, { topic: label, achieved: 0, possible: 0, questionCount: 0 });
    }
    const group = groups.get(key);
    if (stat.average === null) continue;       // nothing marked on this question yet
    group.achieved += stat.average;
    group.possible += stat.maxMarks;
    group.questionCount += 1;
  }

  return [...groups.values()]
    .filter((g) => g.questionCount > 0 && g.possible > 0)
    .map((g) => ({
      topic: g.topic,
      averageMark: g.achieved,
      maxMarks: g.possible,
      questionCount: g.questionCount,
      proportion: g.achieved / g.possible,
    }));
}

/** How many pupils achieved each grade. Only fully-marked papers count. */
export function gradeDistribution(assessment) {
  const counts = new Map(assessment.gradeBoundaries.map((b) => [b.grade, 0]));
  let graded = 0;
  for (const result of allResults(assessment)) {
    if (!result.grade) continue;
    counts.set(result.grade, (counts.get(result.grade) || 0) + 1);
    graded += 1;
  }
  return {
    graded,
    rows: assessment.gradeBoundaries.map((b) => ({
      grade: b.grade,
      minMark: b.minMark,
      count: counts.get(b.grade) || 0,
    })),
  };
}

/** Every completed pupil total, for the mark-distribution histogram. */
export function completedTotals(assessment) {
  return allResults(assessment)
    .filter((r) => r.isComplete)
    .map((r) => r.achieved);
}

/**
 * Class-level summary for the marksheet header.
 * Only fully-marked papers are averaged — a half-marked paper would drag the
 * class average down for no reason.
 */
export function classSummary(assessment) {
  const results = allResults(assessment).filter((r) => r.isComplete);
  if (results.length === 0) {
    return { count: 0, averageMark: null, averageGrade: null, gradeCounts: {} };
  }
  const totalAchieved = results.reduce((sum, r) => sum + r.achieved, 0);
  const gradeCounts = {};
  for (const r of results) {
    if (r.grade) gradeCounts[r.grade] = (gradeCounts[r.grade] || 0) + 1;
  }
  const averageMark = totalAchieved / results.length;
  return {
    count: results.length,
    averageMark,
    // The grade the average mark itself would be awarded.
    averageGrade: gradeForMark(assessment.gradeBoundaries, averageMark),
    gradeCounts,
  };
}

/** Round for display without dragging in a formatting library. */
export function round(value, dp = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/** Marks, formatted. Whole numbers stay whole; halves keep one decimal. */
export function formatMark(value, dp = 1) {
  const rounded = round(value, dp);
  if (rounded === null) return '—';
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(dp);
}
