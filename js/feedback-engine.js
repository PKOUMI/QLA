/**
 * feedback-engine.js — turns marks into personalised feedback.
 *
 * The three rules, stated once:
 *   What went well  : mark / max  >  0.80   (strictly greater — 4/5 does NOT count)
 *   Even better if  : mark / max  <  0.25   (strictly less    — 1/4 does NOT count)
 *   Focus on        : the reteach links attached to the "even better if" questions
 *
 * Blank (unmarked) questions are excluded from all three. You cannot conclude
 * anything about a child from a question you have not marked.
 */

import { getMark, WWW_THRESHOLD, EBI_THRESHOLD } from './model.js';
import { pupilResult } from './grades.js';
import { safeUrl } from './validation.js';

/**
 * Case-insensitive, whitespace-insensitive de-duplication that keeps the FIRST
 * spelling the teacher typed. So "Algebra", "algebra" and " ALGEBRA " collapse
 * to one entry, displayed as "Algebra" because that is what was entered first.
 */
function dedupeByKey(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

const topicKey = (topic) => topic.trim().toLowerCase().replace(/\s+/g, ' ');

/** Normalise a URL for comparison so trailing slashes don't create duplicates. */
function urlKey(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Build the complete feedback object for one pupil.
 * This is the single source of truth for both the on-screen preview and the
 * payload sent to the email API.
 */
export function buildPupilFeedback(assessment, pupil) {
  const result = pupilResult(assessment, pupil.id);
  const policy = assessment.exam.blankPolicy;

  const rows = [];
  const strongQuestions = [];
  const weakQuestions = [];

  /*
   * Canonical spelling for each topic: the first way the teacher wrote it
   * anywhere in the question list. So if Q1 says "Algebra" and Q2 says
   * "algebra", both lists display "Algebra" regardless of which question
   * happened to trigger the entry.
   */
  const displayTopic = new Map();
  for (const question of assessment.questions) {
    const topic = question.topic.trim();
    if (!topic) continue;
    const key = topicKey(topic);
    if (!displayTopic.has(key)) displayTopic.set(key, topic);
  }
  const canonical = (topic) => displayTopic.get(topicKey(topic)) ?? topic;

  for (const question of assessment.questions) {
    const raw = getMark(assessment, pupil.id, question.id);
    const max = Number.isFinite(question.maxMarks) ? question.maxMarks : 0;

    // Under the 'zero' policy the teacher has confirmed blanks really are zeros.
    const mark = raw === null && policy === 'zero' ? 0 : raw;
    const isBlank = mark === null;

    rows.push({
      number: question.number,
      topic: question.topic.trim(),
      mark: isBlank ? null : mark,
      outOf: max,
      status: isBlank ? 'notMarked' : classify(mark, max),
    });

    if (isBlank || max <= 0) continue;               // guard against divide-by-zero
    const ratio = mark / max;
    if (ratio > WWW_THRESHOLD) strongQuestions.push(question);
    if (ratio < EBI_THRESHOLD) weakQuestions.push(question);
  }

  const evenBetterIf = dedupeByKey(
    weakQuestions.map((q) => canonical(q.topic.trim())).filter(Boolean),
    topicKey,
  );

  /*
   * A topic can legitimately be strong on one question and weak on another —
   * 5/5 on one algebra question and 0/5 on the next. Listing "Algebra" under
   * BOTH headings tells a pupil two contradictory things, so an overlapping
   * topic is resolved in favour of "Even better if": it is the actionable one,
   * and it is still true. This never hides a question from the results table,
   * which shows every mark exactly as it was entered.
   */
  const weakTopicKeys = new Set(evenBetterIf.map(topicKey));

  const wentWell = dedupeByKey(
    strongQuestions.map((q) => canonical(q.topic.trim())).filter(Boolean),
    topicKey,
  ).filter((topic) => !weakTopicKeys.has(topicKey(topic)));

  const focusOn = dedupeByKey(
    weakQuestions
      .map((q) => ({ topic: canonical(q.topic.trim()), url: safeUrl(q.reteachUrl) }))
      .filter((item) => item.url),
    (item) => urlKey(item.url),
  );

  return {
    pupilId: pupil.id,
    pupilName: pupil.name.trim(),
    pupilEmail: pupil.email.trim(),
    parentEmail: pupil.parentEmail.trim(),
    examName: assessment.exam.name.trim(),
    subject: assessment.exam.subject.trim(),
    examDate: assessment.exam.date,
    totalMarks: result.total,
    totalPossible: result.possible,
    grade: result.grade,
    isComplete: result.isComplete,
    blankCount: result.blankCount,
    hasAnyMark: result.hasAnyMark,
    rows,
    wentWell,
    evenBetterIf,
    focusOn,
    teacherNote: assessment.feedback.teacherNote.trim(),
  };
}

/** Band used only for the little coloured dot in the results table. */
function classify(mark, max) {
  if (max <= 0) return 'neutral';
  const ratio = mark / max;
  if (ratio > WWW_THRESHOLD) return 'strong';
  if (ratio < EBI_THRESHOLD) return 'weak';
  return 'developing';
}

/**
 * Work out, for every pupil, whether feedback can actually be sent — and if
 * not, exactly why. The Feedback page shows these reasons rather than failing
 * silently at send time.
 */
export function pupilSendStatus(assessment, pupil) {
  const reasons = [];
  const result = pupilResult(assessment, pupil.id);

  if (!pupil.email.trim()) reasons.push('No email address');
  if (!result.hasAnyMark && assessment.exam.blankPolicy !== 'zero') reasons.push('No marks entered');
  // A part-marked paper has no honest total or grade, so it cannot be sent.
  if (result.hasAnyMark && !result.isComplete) {
    reasons.push(`${result.blankCount} question${result.blankCount === 1 ? '' : 's'} not marked`);
  }

  const warnings = [];
  if (pupil.email.trim() && !pupil.parentEmail.trim()) warnings.push('No parent email');

  return {
    canSend: reasons.length === 0,
    blockedReasons: reasons,
    warnings,
    result,
  };
}
