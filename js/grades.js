/**
 * grades.js — all the arithmetic. Pure functions, no DOM, no storage.
 *
 * Everything the marksheet and the feedback page display comes from here, so
 * the numbers can never disagree between pages.
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
 * Blank marks are never silently counted as zero. Which denominator is used
 * depends on exam.blankPolicy:
 *   'incomplete' (default) - blanks excluded from the achieved total, pupil
 *                            flagged, grade reported as provisional.
 *   'zero'                 - teacher has explicitly said blanks mean zero.
 */
export function pupilResult(assessment, pupilId) {
  const policy = assessment.exam.blankPolicy;
  const possible = totalPossible(assessment);

  let achieved = 0;
  let markedPossible = 0;   // total available on the questions actually marked
  let blankCount = 0;
  let markedCount = 0;

  for (const question of assessment.questions) {
    const mark = getMark(assessment, pupilId, question.id);
    const max = Number.isFinite(question.maxMarks) ? question.maxMarks : 0;
    if (mark === null) {
      blankCount += 1;
      if (policy === 'zero') markedPossible += max; // counts as an answered 0
      continue;
    }
    achieved += mark;
    markedPossible += max;
    markedCount += 1;
  }

  const hasAnyMark = markedCount > 0;
  const isComplete = blankCount === 0;
  // 'zero' policy means blanks are real zeros, so the pupil is treated as complete.
  const treatAsComplete = isComplete || policy === 'zero';

  const percentage = possible > 0 ? (achieved / possible) * 100 : 0;
  const percentageOfMarked = markedPossible > 0 ? (achieved / markedPossible) * 100 : 0;

  return {
    pupilId,
    achieved,
    possible,
    markedPossible,
    percentage,
    percentageOfMarked,
    blankCount,
    markedCount,
    hasAnyMark,
    isComplete: treatAsComplete,
    // A grade from a partly-marked paper is not trustworthy — say so.
    isProvisional: !treatAsComplete && hasAnyMark,
    grade: hasAnyMark || policy === 'zero' ? gradeForMark(assessment.gradeBoundaries, achieved) : null,
  };
}

/** Results for every pupil, in list order. */
export function allResults(assessment) {
  return assessment.pupils.map((p) => pupilResult(assessment, p.id));
}

/**
 * Class average for each question. Blank marks are excluded from both the
 * numerator and the count — an unmarked question tells us nothing.
 */
export function questionAverages(assessment) {
  return assessment.questions.map((question) => {
    let sum = 0;
    let count = 0;
    for (const pupil of assessment.pupils) {
      const mark = getMark(assessment, pupil.id, question.id);
      if (mark === null) {
        if (assessment.exam.blankPolicy === 'zero') { count += 1; }
        continue;
      }
      sum += mark;
      count += 1;
    }
    const max = Number.isFinite(question.maxMarks) ? question.maxMarks : 0;
    const average = count > 0 ? sum / count : null;
    return {
      questionId: question.id,
      average,
      percentage: average !== null && max > 0 ? (average / max) * 100 : null,
      count,
      maxMarks: max,
    };
  });
}

/** Class-level summary for the marksheet header. */
export function classSummary(assessment) {
  const results = allResults(assessment).filter((r) => r.hasAnyMark);
  if (results.length === 0) {
    return { count: 0, averageMark: null, averagePercentage: null, gradeCounts: {} };
  }
  const totalAchieved = results.reduce((sum, r) => sum + r.achieved, 0);
  const gradeCounts = {};
  for (const r of results) {
    if (r.grade) gradeCounts[r.grade] = (gradeCounts[r.grade] || 0) + 1;
  }
  const possible = totalPossible(assessment);
  const averageMark = totalAchieved / results.length;
  return {
    count: results.length,
    averageMark,
    averagePercentage: possible > 0 ? (averageMark / possible) * 100 : null,
    gradeCounts,
  };
}

/** Round for display without dragging in a formatting library. */
export function round(value, dp = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

export function formatPercent(value, dp = 0) {
  const rounded = round(value, dp);
  return rounded === null ? '—' : `${rounded}%`;
}
