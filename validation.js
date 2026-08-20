/**
 * validation.js — input validation and output escaping.
 *
 * Used by the browser AND (in escaping form) by the server, so it must stay
 * free of DOM references.
 */

/**
 * Pragmatic email check. Deliberately not RFC 5322 — that regex is famously
 * unreadable and rejects almost nothing extra in practice. This catches the
 * mistakes teachers actually make: missing @, missing domain, stray spaces.
 */
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[A-Za-z]{2,}$/;

export function isValidEmail(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 254 && EMAIL_RE.test(trimmed);
}

export function normaliseEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Only http/https. Rejects javascript: and data: URLs, which are XSS vectors. */
export function isValidUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Returns a safe URL string, or '' if the input is not a safe http(s) URL. */
export function safeUrl(value) {
  return isValidUrl(value) ? value.trim() : '';
}

/** Escape for insertion into HTML text or attribute values. */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Neutralise spreadsheet formula injection on CSV export.
 * A pupil named "=cmd|'/c calc'!A1" must not execute when opened in Excel.
 */
export function csvSafeCell(value) {
  const str = value === null || value === undefined ? '' : String(value);
  return /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
}

/**
 * Validate one mark against a question maximum.
 * Blank is valid and means "not marked".
 * @returns {{ok: boolean, value: number|null, error: string}}
 */
export function validateMark(raw, maxMarks) {
  if (raw === '' || raw === null || raw === undefined) {
    return { ok: true, value: null, error: '' };
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return { ok: false, value: null, error: 'Marks must be a number.' };
  if (value < 0) return { ok: false, value: null, error: 'Marks cannot be negative.' };
  if (value > maxMarks) return { ok: false, value: null, error: `Maximum for this question is ${maxMarks}.` };
  // Allow halves (some mark schemes use them) but nothing finer.
  if (Math.round(value * 2) !== value * 2) {
    return { ok: false, value: null, error: 'Use whole or half marks only.' };
  }
  return { ok: true, value, error: '' };
}

/**
 * Validate the whole assessment. Returns grouped problems so each page can show
 * only the ones it is responsible for.
 * @returns {{errors: string[], warnings: string[], bySection: object}}
 */
export function validateAssessment(assessment) {
  const errors = [];
  const warnings = [];
  const bySection = { exam: [], questions: [], boundaries: [], pupils: [] };

  // --- Exam details -------------------------------------------------------
  if (!assessment.exam.name.trim()) {
    bySection.exam.push('Give the assessment a name.');
  }
  if (assessment.exam.teacherEmail && !isValidEmail(assessment.exam.teacherEmail)) {
    bySection.exam.push('Your own email address does not look valid.');
  }

  // --- Questions ----------------------------------------------------------
  const seenNumbers = new Map();
  assessment.questions.forEach((q, i) => {
    const label = q.number.trim() || `row ${i + 1}`;
    if (!q.number.trim()) {
      bySection.questions.push(`Question ${i + 1} has no question number.`);
    } else {
      const key = q.number.trim().toLowerCase();
      if (seenNumbers.has(key)) {
        bySection.questions.push(`Question number "${q.number.trim()}" is used more than once.`);
      }
      seenNumbers.set(key, true);
    }
    // A zero-mark question would make mark/max a division by zero.
    if (!Number.isFinite(q.maxMarks) || q.maxMarks <= 0) {
      bySection.questions.push(`Question ${label} must be worth at least 1 mark.`);
    }
    if (!q.topic.trim()) {
      warnings.push(`Question ${label} has no topic — it cannot appear in feedback.`);
    }
    if (q.reteachUrl.trim() && !isValidUrl(q.reteachUrl)) {
      bySection.questions.push(`Question ${label}: the reteach link must start with http:// or https://`);
    }
  });

  // --- Grade boundaries ---------------------------------------------------
  const total = assessment.questions.reduce(
    (sum, q) => sum + (Number.isFinite(q.maxMarks) ? q.maxMarks : 0), 0,
  );
  const filled = assessment.gradeBoundaries.filter((b) => b.minMark !== null && b.minMark !== '');
  if (filled.length < assessment.gradeBoundaries.length) {
    bySection.boundaries.push('Enter a minimum mark for every grade.');
  }
  let previous = -1;
  assessment.gradeBoundaries.forEach((b, i) => {
    if (b.minMark === null || b.minMark === '') return;
    const mark = Number(b.minMark);
    if (!Number.isFinite(mark) || mark < 0) {
      bySection.boundaries.push(`Grade ${b.grade}: boundary must be 0 or more.`);
      return;
    }
    if (i === 0 && mark !== 0) {
      bySection.boundaries.push('The lowest grade (U) must start at 0 so every mark gets a grade.');
    }
    if (mark <= previous && i > 0) {
      bySection.boundaries.push(`Grade ${b.grade}: boundary must be higher than the grade below it.`);
    }
    if (total > 0 && mark > total) {
      bySection.boundaries.push(`Grade ${b.grade}: boundary (${mark}) is above the total marks available (${total}).`);
    }
    previous = mark;
  });

  // --- Pupils -------------------------------------------------------------
  const seenNames = new Map();
  const seenEmails = new Map();
  assessment.pupils.forEach((p, i) => {
    if (!p.name.trim()) {
      bySection.pupils.push(`Pupil ${i + 1} has no name.`);
    } else {
      const key = p.name.trim().toLowerCase();
      if (seenNames.has(key)) bySection.pupils.push(`"${p.name.trim()}" appears more than once.`);
      seenNames.set(key, true);
    }
    if (p.email.trim() && !isValidEmail(p.email)) {
      bySection.pupils.push(`${p.name.trim() || `Pupil ${i + 1}`}: "${p.email.trim()}" is not a valid email address.`);
    }
    if (p.email.trim()) {
      const key = normaliseEmail(p.email);
      if (seenEmails.has(key)) bySection.pupils.push(`The email ${key} is used by more than one pupil.`);
      seenEmails.set(key, true);
    } else {
      warnings.push(`${p.name.trim() || `Pupil ${i + 1}`} has no email address and cannot be sent feedback.`);
    }
    if (p.parentEmail.trim() && !isValidEmail(p.parentEmail)) {
      bySection.pupils.push(`${p.name.trim() || `Pupil ${i + 1}`}: parent email "${p.parentEmail.trim()}" is not valid.`);
    }
  });
  if (assessment.pupils.length === 0) {
    bySection.pupils.push('Add at least one pupil.');
  }

  for (const list of Object.values(bySection)) errors.push(...list);
  return { errors, warnings, bySection, isValid: errors.length === 0 };
}
