/**
 * csv.js — CSV parsing, template generation and export.
 *
 * Written by hand rather than pulled from a library: it is ~60 lines, it is the
 * only place untrusted file content enters the app, and a dependency here would
 * be a dependency the teacher's browser has to trust.
 */

import { isValidEmail, normaliseEmail, csvSafeCell } from './validation.js';

/**
 * Parse CSV text into an array of string arrays.
 * Handles quoted fields, escaped quotes ("") and both \n and \r\n line endings.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, ''); // strip Excel's byte-order mark

  for (let i = 0; i < src.length; i += 1) {
    const char = src[i];
    if (inQuotes) {
      if (char === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; }
        else { inQuotes = false; }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }
  row.push(field);
  rows.push(row);

  // Drop trailing entirely-empty rows (Excel loves adding these).
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
  return rows;
}

export function toCsv(rows) {
  return rows
    .map((row) => row.map((cell) => {
      const safe = csvSafeCell(cell);
      return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    }).join(','))
    .join('\r\n');
}

export const PUPIL_TEMPLATE_HEADERS = ['Name', 'Pupil Email', 'Parent Email'];

export function pupilTemplateCsv() {
  return toCsv([
    PUPIL_TEMPLATE_HEADERS,
    ['John Smith', 'john.smith@example.sch.uk', 'parent.smith@example.com'],
    ['Sarah Jones', 'sarah.jones@example.sch.uk', ''],
    ['Amir Khan', 'amir.khan@example.sch.uk', 'k.khan@example.com'],
  ]);
}

/** Accept a few spellings of each column so teachers don't have to be exact. */
const HEADER_ALIASES = {
  name: ['name', 'pupil', 'pupil name', 'student', 'student name', 'full name', 'forename surname'],
  email: ['pupil email', 'email', 'student email', 'pupil e-mail', 'email address', 'pupil email address'],
  parentEmail: ['parent email', 'parent', 'guardian email', 'parent e-mail', 'parent/guardian email', 'parent email address'],
};

function matchHeader(headerCell) {
  const key = headerCell.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(key)) return field;
  }
  return null;
}

/**
 * Validate and convert an uploaded CSV into pupil rows.
 * Nothing malformed is allowed through silently: every problem is reported
 * with its row number, and rows with errors are excluded from `pupils`.
 *
 * @param {string} text raw file contents
 * @param {Array} existingPupils pupils already in the assessment, for dupe checks
 * @returns {{ok, pupils, errors, warnings, skipped}}
 */
export function parsePupilCsv(text, existingPupils = []) {
  const errors = [];
  const warnings = [];
  const pupils = [];
  let skipped = 0;

  const rows = parseCsv(text);
  if (rows.length === 0 || (rows.length === 1 && rows[0].every((c) => !c.trim()))) {
    return { ok: false, pupils, errors: ['The file is empty.'], warnings, skipped };
  }

  // --- Header row ---------------------------------------------------------
  const headerRow = rows[0];
  const columns = {};
  headerRow.forEach((cell, index) => {
    const field = matchHeader(cell);
    if (field && columns[field] === undefined) columns[field] = index;
  });

  if (columns.name === undefined) {
    errors.push('Could not find a "Name" column. The first row must be a header row containing: Name, Pupil Email, Parent Email.');
  }
  if (columns.email === undefined) {
    errors.push('Could not find a "Pupil Email" column.');
  }
  if (columns.parentEmail === undefined) {
    warnings.push('No "Parent Email" column found — parent emails will be left blank.');
  }
  if (errors.length) return { ok: false, pupils, errors, warnings, skipped };

  // --- Data rows ----------------------------------------------------------
  const seenNames = new Map(existingPupils.map((p) => [p.name.trim().toLowerCase(), 'the existing list']));
  const seenEmails = new Map(
    existingPupils.filter((p) => p.email).map((p) => [normaliseEmail(p.email), 'the existing list']),
  );

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const lineNo = i + 1;
    const get = (index) => (index === undefined || row[index] === undefined ? '' : row[index].trim());

    const name = get(columns.name);
    const email = get(columns.email);
    const parentEmail = get(columns.parentEmail);

    if (!name && !email && !parentEmail) continue; // blank line, ignore quietly

    const rowErrors = [];
    if (!name) rowErrors.push('missing name');
    if (name.length > 100) rowErrors.push('name is unreasonably long');
    if (email && !isValidEmail(email)) rowErrors.push(`"${email}" is not a valid email address`);
    if (parentEmail && !isValidEmail(parentEmail)) rowErrors.push(`parent email "${parentEmail}" is not valid`);

    const nameKey = name.toLowerCase();
    if (name && seenNames.has(nameKey)) {
      rowErrors.push(`duplicate pupil — "${name}" is already in ${seenNames.get(nameKey)}`);
    }
    const emailKey = normaliseEmail(email);
    if (email && seenEmails.has(emailKey)) {
      rowErrors.push(`duplicate email — ${emailKey} is already in ${seenEmails.get(emailKey)}`);
    }

    if (rowErrors.length) {
      errors.push(`Row ${lineNo}: ${rowErrors.join('; ')}.`);
      skipped += 1;
      continue;
    }

    if (!email) warnings.push(`Row ${lineNo}: ${name} has no email address and will not be able to receive feedback.`);

    seenNames.set(nameKey, `row ${lineNo}`);
    if (email) seenEmails.set(emailKey, `row ${lineNo}`);
    pupils.push({ name, email, parentEmail });
  }

  if (pupils.length === 0 && errors.length === 0) {
    errors.push('No pupil rows found below the header row.');
  }
  return { ok: pupils.length > 0, pupils, errors, warnings, skipped };
}

/** Marksheet export: pupils down, questions across, plus totals and grade. */
export function marksheetCsv(assessment, results) {
  const header = ['Pupil', 'Email', ...assessment.questions.map((q) => `Q${q.number}`), 'Total', 'Out of', 'Percentage', 'Grade'];
  const topics = ['Topic / AO', '', ...assessment.questions.map((q) => q.topic), '', '', '', ''];
  const maxes = ['Max marks', '', ...assessment.questions.map((q) => q.maxMarks), '', '', '', ''];
  const body = assessment.pupils.map((pupil) => {
    const result = results.find((r) => r.pupilId === pupil.id);
    const marks = assessment.questions.map((q) => {
      const value = assessment.marks[pupil.id]?.[q.id];
      return value === null || value === undefined ? '' : value;
    });
    return [
      pupil.name, pupil.email, ...marks,
      result.hasAnyMark ? result.achieved : '',
      result.possible,
      result.hasAnyMark ? `${Math.round(result.percentage)}%` : '',
      result.grade ?? '',
    ];
  });
  return toCsv([header, topics, maxes, ...body]);
}
