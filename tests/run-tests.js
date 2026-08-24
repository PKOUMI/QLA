/**
 * tests/run-tests.js — run with:  npm test
 *
 * These cover the logic that decides what a child is told about their work, so
 * they are worth keeping green. No test framework, no dependencies: plain Node.
 */

import assert from 'node:assert/strict';
import { newAssessment, newQuestion, newPupil, setMark, applyPaperType, resizeQuestions } from '../js/model.js';
import {
  totalPossible, gradeForMark, boundariesReady, pupilResult, allResults,
  questionAverages, classSummary, topicAverages, gradeDistribution,
  completedTotals, markProgress, formatMark,
} from '../js/grades.js';
import { buildPupilFeedback, pupilSendStatus } from '../js/feedback-engine.js';
import { validateMark, validateAssessment, isValidEmail, isValidUrl, csvSafeCell } from '../js/validation.js';
import { parsePupilCsv, parseCsv, toCsv } from '../js/csv.js';
import { buildLock, pinMatches, validatePin } from '../js/lock.js';
import { renderFeedbackEmail, DEFAULT_EMAIL_TEXT } from '../shared/email-template.js';
import { signInErrorMessage, normaliseEmail, looksLikeEmail } from '../js/auth.js';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed += 1; process.stdout.write('.'); }
  catch (error) { failed += 1; failures.push({ name, error }); process.stdout.write('F'); }
}

/* --- Fixture -------------------------------------------------------------
 * Higher tier, 6 questions, 30 marks. Designed so the boundary cases land
 * exactly on 80% and exactly 25%.
 * ----------------------------------------------------------------------- */
function fixture() {
  const a = newAssessment({ paperType: 'higher' });
  a.exam.name = 'Test Paper';
  a.questions = [
    { ...newQuestion('1', 5), topic: 'Algebra', reteachUrl: 'https://example.com/algebra' },
    { ...newQuestion('2', 5), topic: 'algebra', reteachUrl: 'https://example.com/algebra/' }, // dupe topic + dupe URL
    { ...newQuestion('3a', 6), topic: 'Geometry', reteachUrl: 'https://example.com/geometry' },
    { ...newQuestion('3b', 4), topic: 'Trigonometry', reteachUrl: 'https://example.com/trig' },
    { ...newQuestion('4(i)', 5), topic: 'Trigonometry', reteachUrl: 'https://example.com/trig' },
    { ...newQuestion('4(ii)', 5), topic: '', reteachUrl: '' }, // no topic on purpose
  ];
  a.gradeBoundaries = [
    { grade: 'U', minMark: 0 }, { grade: '3', minMark: 5 }, { grade: '4', minMark: 10 },
    { grade: '5', minMark: 15 }, { grade: '6', minMark: 20 }, { grade: '7', minMark: 24 },
    { grade: '8', minMark: 27 }, { grade: '9', minMark: 29 },
  ];
  a.pupils = [newPupil('John Smith', 'john@example.com', 'parent@example.com')];
  return a;
}

/* ============================ totals and grades ========================== */

test('totalPossible sums max marks', () => {
  assert.equal(totalPossible(fixture()), 30);
});

test('gradeForMark returns the highest grade reached', () => {
  const a = fixture();
  assert.equal(gradeForMark(a.gradeBoundaries, 0), 'U');
  assert.equal(gradeForMark(a.gradeBoundaries, 4), 'U');
  assert.equal(gradeForMark(a.gradeBoundaries, 5), '3');   // exactly on the boundary qualifies
  assert.equal(gradeForMark(a.gradeBoundaries, 23), '6');
  assert.equal(gradeForMark(a.gradeBoundaries, 30), '9');
});

test('a mark below every boundary still gets the lowest grade', () => {
  assert.equal(gradeForMark([{ grade: 'U', minMark: 0 }, { grade: '4', minMark: 20 }], 3), 'U');
});

test('a fully marked paper produces a total and a grade', () => {
  const a = fixture();
  const p = a.pupils[0].id;
  [5, 4, 5, 1, 2, 3].forEach((m, i) => setMark(a, p, a.questions[i].id, m)); // 20/30
  const r = pupilResult(a, p);
  assert.equal(r.achieved, 20);
  assert.equal(r.total, 20);
  assert.equal(r.possible, 30);
  assert.equal(r.grade, '6');
  assert.equal(r.isComplete, true);
});

test('no percentage is exposed anywhere in a result', () => {
  const a = fixture();
  const p = a.pupils[0].id;
  a.questions.forEach((q, i) => setMark(a, p, q.id, i));
  const r = pupilResult(a, p);
  assert.equal('percentage' in r, false);
  assert.equal('percentageOfMarked' in r, false);
});

/* ============================== blank marks ============================== */

test('a blank mark is not treated as zero', () => {
  const a = fixture();
  const p = a.pupils[0].id;
  setMark(a, p, a.questions[0].id, 5);
  // questions 2-6 left blank
  const r = pupilResult(a, p);
  assert.equal(r.achieved, 5);
  assert.equal(r.blankCount, 5);
  assert.equal(r.markedCount, 1);
  assert.equal(r.isComplete, false);
  // The whole point: an unfinished paper has no total and no grade.
  assert.equal(r.total, null, 'total must be withheld until every question is marked');
  assert.equal(r.grade, null, 'grade must be withheld until every question is marked');
});

test('zero and blank are different values', () => {
  const a = fixture();
  const p = a.pupils[0].id;
  setMark(a, p, a.questions[0].id, 0);
  const zero = pupilResult(a, p);
  assert.equal(zero.markedCount, 1);
  assert.equal(zero.blankCount, 5);

  setMark(a, p, a.questions[0].id, null);
  const blank = pupilResult(a, p);
  assert.equal(blank.markedCount, 0);
  assert.equal(blank.blankCount, 6);
});

test('blankPolicy "zero" counts blanks as zero and releases the total', () => {
  const a = fixture();
  a.exam.blankPolicy = 'zero';
  const p = a.pupils[0].id;
  setMark(a, p, a.questions[0].id, 5);
  const r = pupilResult(a, p);
  assert.equal(r.achieved, 5);
  assert.equal(r.total, 5);
  assert.equal(r.isComplete, true);
  assert.equal(r.grade, '3');
});

/* ====================== what went well / even better if ================== */

test('What went well needs STRICTLY more than 80% — 4/5 does not qualify', () => {
  const a = fixture();
  const p = a.pupils[0].id;
  setMark(a, p, a.questions[0].id, 4); // 4/5 = exactly 80%
  a.questions.slice(1).forEach((q) => setMark(a, p, q.id, 3));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  assert.deepEqual(fb.wentWell, [], '80% must not appear in What went well');
});

test('What went well includes anything above 80%', () => {
  const a = fixture();
  const p = a.pupils[0].id;
  setMark(a, p, a.questions[0].id, 5);       // 100% Algebra
  setMark(a, p, a.questions[2].id, 5);       // 5/6 = 83% Geometry
  [1, 3, 4, 5].forEach((i) => setMark(a, p, a.questions[i].id, 3));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  assert.deepEqual(fb.wentWell, ['Algebra', 'Geometry']);
});

test('Even better if needs STRICTLY less than 25% — 1/4 does not qualify', () => {
  const a = fixture();
  const p = a.pupils[0].id;
  setMark(a, p, a.questions[3].id, 1); // 1/4 = exactly 25%
  [0, 1, 2, 4, 5].forEach((i) => setMark(a, p, a.questions[i].id, 3));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  assert.deepEqual(fb.evenBetterIf, [], '25% must not appear in Even better if');
});

test('Even better if includes anything below 25%', () => {
  const a = fixture();
  const p = a.pupils[0].id;
  setMark(a, p, a.questions[3].id, 0);   // 0/4  Trigonometry
  setMark(a, p, a.questions[4].id, 1);   // 1/5 = 20%  Trigonometry (duplicate topic)
  setMark(a, p, a.questions[2].id, 1);   // 1/6 = 17%  Geometry
  [0, 1, 5].forEach((i) => setMark(a, p, a.questions[i].id, 3));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  assert.deepEqual(fb.evenBetterIf, ['Geometry', 'Trigonometry']);
});

test('topics are de-duplicated case-insensitively, keeping the first spelling', () => {
  const a = fixture();
  const p = a.pupils[0].id;
  setMark(a, p, a.questions[0].id, 5);   // "Algebra"
  setMark(a, p, a.questions[1].id, 5);   // "algebra"
  [2, 3, 4, 5].forEach((i) => setMark(a, p, a.questions[i].id, 3));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  assert.deepEqual(fb.wentWell, ['Algebra'], 'should keep the first-entered capitalisation');
});

test('a question with no topic never produces a blank bullet', () => {
  const a = fixture();
  const p = a.pupils[0].id;
  setMark(a, p, a.questions[5].id, 5);   // full marks, but topic is ''
  [0, 1, 2, 3, 4].forEach((i) => setMark(a, p, a.questions[i].id, 3));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  assert.deepEqual(fb.wentWell, []);
});

test('blank questions appear in neither list', () => {
  const a = fixture();
  const p = a.pupils[0].id;
  setMark(a, p, a.questions[0].id, 5);
  const fb = buildPupilFeedback(a, a.pupils[0]);
  assert.deepEqual(fb.evenBetterIf, [], 'unmarked questions must not become weaknesses');
  assert.equal(fb.rows.filter((r) => r.status === 'notMarked').length, 5);
});

test('the two lists never contradict each other', () => {
  const a = fixture();
  const p = a.pupils[0].id;
  // Alternating full marks / zero, so several topics are strong AND weak.
  a.questions.forEach((q, i) => setMark(a, p, q.id, i % 2 === 0 ? q.maxMarks : 0));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  const overlap = fb.wentWell.filter((t) => fb.evenBetterIf.some((u) => u.toLowerCase() === t.toLowerCase()));
  assert.deepEqual(overlap, [], 'a topic must not appear under both headings');
});

test('a mixed topic is resolved in favour of Even better if', () => {
  const a = fixture();
  const p = a.pupils[0].id;
  setMark(a, p, a.questions[0].id, 5);   // Algebra 5/5  -> strong
  setMark(a, p, a.questions[1].id, 0);   // algebra 0/5  -> weak
  setMark(a, p, a.questions[2].id, 6);   // Geometry 6/6 -> strong only
  [3, 4, 5].forEach((i) => setMark(a, p, a.questions[i].id, 2));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  assert.deepEqual(fb.wentWell, ['Geometry']);
  assert.deepEqual(fb.evenBetterIf, ['Algebra']);
});

/* ================================ focus on ============================== */

test('Focus on pulls reteach links for weak questions and de-duplicates URLs', () => {
  const a = fixture();
  const p = a.pupils[0].id;
  setMark(a, p, a.questions[3].id, 0);   // Trig  -> https://example.com/trig
  setMark(a, p, a.questions[4].id, 0);   // Trig  -> same URL
  [0, 1, 2, 5].forEach((i) => setMark(a, p, a.questions[i].id, 3));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  assert.equal(fb.focusOn.length, 1, 'the same resource must not be listed twice');
  assert.equal(fb.focusOn[0].url, 'https://example.com/trig');
});

test('trailing slashes do not create duplicate resources', () => {
  const a = fixture();
  const p = a.pupils[0].id;
  setMark(a, p, a.questions[0].id, 0);   // https://example.com/algebra
  setMark(a, p, a.questions[1].id, 0);   // https://example.com/algebra/
  [2, 3, 4, 5].forEach((i) => setMark(a, p, a.questions[i].id, 3));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  assert.equal(fb.focusOn.length, 1);
});

test('a weak question with no reteach link is skipped in Focus on but kept in EBI', () => {
  const a = fixture();
  a.questions[3].reteachUrl = '';
  const p = a.pupils[0].id;
  setMark(a, p, a.questions[3].id, 0);
  [0, 1, 2, 4, 5].forEach((i) => setMark(a, p, a.questions[i].id, 3));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  assert.deepEqual(fb.evenBetterIf, ['Trigonometry']);
  assert.deepEqual(fb.focusOn, []);
});

test('a javascript: URL is never emitted as a resource', () => {
  const a = fixture();
  a.questions[3].reteachUrl = 'javascript:alert(1)';
  const p = a.pupils[0].id;
  setMark(a, p, a.questions[3].id, 0);
  [0, 1, 2, 4, 5].forEach((i) => setMark(a, p, a.questions[i].id, 3));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  assert.deepEqual(fb.focusOn, []);
});

/* =============================== averages =============================== */

test('question averages exclude blanks', () => {
  const a = fixture();
  a.pupils = [newPupil('A', 'a@x.com'), newPupil('B', 'b@x.com'), newPupil('C', 'c@x.com')];
  setMark(a, a.pupils[0].id, a.questions[0].id, 5);
  setMark(a, a.pupils[1].id, a.questions[0].id, 3);
  // pupil C left blank
  const avg = questionAverages(a)[0];
  assert.equal(avg.count, 2);
  assert.equal(avg.average, 4);
  assert.equal(avg.lowest, 3);
  assert.equal(avg.highest, 5);
  assert.equal(avg.notMarked, 1);
  // proportion is geometry for the bar width, never shown as a figure
  assert.equal(avg.proportion, 0.8);
  assert.equal('percentage' in avg, false);
});

test('class summary ignores pupils with no marks at all', () => {
  const a = fixture();
  a.pupils = [newPupil('A', 'a@x.com'), newPupil('B', 'b@x.com')];
  a.questions.forEach((q) => setMark(a, a.pupils[0].id, q.id, q.maxMarks));
  const summary = classSummary(a);
  assert.equal(summary.count, 1);
  assert.equal(summary.averageMark, 30);
});

/* ============================ mark validation =========================== */

test('validateMark accepts blank, 0, half marks and the maximum', () => {
  assert.equal(validateMark('', 5).ok, true);
  assert.equal(validateMark('', 5).value, null);
  assert.equal(validateMark('0', 5).value, 0);
  assert.equal(validateMark('2.5', 5).value, 2.5);
  assert.equal(validateMark('5', 5).value, 5);
});

test('validateMark rejects above maximum, negatives and thirds', () => {
  assert.equal(validateMark('6', 5).ok, false);
  assert.equal(validateMark('-1', 5).ok, false);
  assert.equal(validateMark('1.3', 5).ok, false);
  assert.equal(validateMark('abc', 5).ok, false);
});

/* ========================= assessment validation ======================== */

test('a zero-mark question is rejected', () => {
  const a = fixture();
  a.questions[0].maxMarks = 0;
  const { bySection } = validateAssessment(a);
  assert.ok(bySection.questions.some((e) => e.includes('at least 1 mark')));
});

test('grade boundaries must ascend', () => {
  const a = fixture();
  a.gradeBoundaries[3].minMark = 8; // below the grade beneath it
  const { bySection } = validateAssessment(a);
  assert.ok(bySection.boundaries.some((e) => e.includes('higher than the grade below')));
});

test('grade boundaries cannot exceed the total marks', () => {
  const a = fixture();
  a.gradeBoundaries[7].minMark = 99;
  const { bySection } = validateAssessment(a);
  assert.ok(bySection.boundaries.some((e) => e.includes('above the total marks')));
});

test('duplicate pupil names and emails are flagged', () => {
  const a = fixture();
  a.pupils.push(newPupil('john smith', 'JOHN@example.com'));
  const { bySection } = validateAssessment(a);
  assert.ok(bySection.pupils.some((e) => e.includes('appears more than once')));
  assert.ok(bySection.pupils.some((e) => e.includes('used by more than one pupil')));
});

test('duplicate question numbers are flagged', () => {
  const a = fixture();
  a.questions[1].number = '1';
  const { bySection } = validateAssessment(a);
  assert.ok(bySection.questions.some((e) => e.includes('used more than once')));
});

/* ============================ send eligibility ========================== */

test('a pupil with no email address cannot be sent to', () => {
  const a = fixture();
  a.pupils[0].email = '';
  a.questions.forEach((q) => setMark(a, a.pupils[0].id, q.id, 3));
  const status = pupilSendStatus(a, a.pupils[0]);
  assert.equal(status.canSend, false);
  assert.ok(status.blockedReasons.includes('No email address'));
});

test('a pupil with no marks cannot be sent to', () => {
  const a = fixture();
  const status = pupilSendStatus(a, a.pupils[0]);
  assert.equal(status.canSend, false);
  assert.ok(status.blockedReasons.includes('No marks entered'));
});

test('a partly-marked pupil cannot be sent to', () => {
  const a = fixture();
  setMark(a, a.pupils[0].id, a.questions[0].id, 5);
  const status = pupilSendStatus(a, a.pupils[0]);
  assert.equal(status.canSend, false, 'no honest total exists yet, so no feedback');
  assert.ok(status.blockedReasons.some((r) => r.includes('not marked')));
});

test('a fully marked pupil with an email can be sent to', () => {
  const a = fixture();
  a.questions.forEach((q) => setMark(a, a.pupils[0].id, q.id, 3));
  const status = pupilSendStatus(a, a.pupils[0]);
  assert.equal(status.canSend, true);
  assert.deepEqual(status.blockedReasons, []);
});

/* ================================== CSV ================================= */

test('CSV parser handles quotes, commas and CRLF', () => {
  const rows = parseCsv('Name,Email\r\n"Smith, John",j@x.com\r\n"He said ""hi""",b@x.com\r\n');
  assert.equal(rows.length, 3);
  assert.equal(rows[1][0], 'Smith, John');
  assert.equal(rows[2][0], 'He said "hi"');
});

test('pupil CSV import accepts the template', () => {
  const csv = 'Name,Pupil Email,Parent Email\nJohn Smith,john@x.com,p@x.com\nSarah Jones,sarah@x.com,\n';
  const result = parsePupilCsv(csv, []);
  assert.equal(result.ok, true);
  assert.equal(result.pupils.length, 2);
  assert.equal(result.pupils[1].parentEmail, '');
});

test('pupil CSV import rejects a missing Name column', () => {
  const result = parsePupilCsv('Pupil Email\njohn@x.com\n', []);
  assert.equal(result.ok, false);
  assert.ok(result.errors[0].includes('Name'));
});

test('pupil CSV import reports bad emails, blank names and duplicates by row', () => {
  const csv = [
    'Name,Pupil Email,Parent Email',
    'John Smith,john@x.com,',
    ',orphan@x.com,',            // no name
    'Amir Khan,not-an-email,',   // bad email
    'john smith,other@x.com,',   // duplicate name, different case
    'Beth Lee,john@x.com,',      // duplicate email
  ].join('\n');
  const result = parsePupilCsv(csv, []);
  assert.equal(result.pupils.length, 1);
  assert.equal(result.skipped, 4);
  assert.ok(result.errors.some((e) => e.startsWith('Row 3') && e.includes('missing name')));
  assert.ok(result.errors.some((e) => e.startsWith('Row 4') && e.includes('not a valid email')));
  assert.ok(result.errors.some((e) => e.startsWith('Row 5') && e.includes('duplicate pupil')));
  assert.ok(result.errors.some((e) => e.startsWith('Row 6') && e.includes('duplicate email')));
});

test('pupil CSV import detects clashes with pupils already in the list', () => {
  const existing = [newPupil('John Smith', 'john@x.com')];
  const result = parsePupilCsv('Name,Pupil Email\nJohn Smith,new@x.com\n', existing);
  assert.equal(result.pupils.length, 0);
  assert.ok(result.errors[0].includes('already in the existing list'));
});

test('CSV export neutralises formula injection', () => {
  assert.equal(csvSafeCell('=cmd|calc'), "'=cmd|calc");
  assert.equal(toCsv([['=1+1']]), "'=1+1");
  assert.equal(csvSafeCell('John Smith'), 'John Smith');
});

/* ============================ email rendering =========================== */

test('the email renders and includes the results', () => {
  const a = fixture();
  const p = a.pupils[0].id;
  [5, 4, 5, 0, 1, 3].forEach((m, i) => setMark(a, p, a.questions[i].id, m));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  const { subject, html, text } = renderFeedbackEmail(fb, { audience: 'pupil' });

  assert.ok(subject.includes('Test Paper'));
  assert.ok(html.includes('John Smith') || html.includes('John'));
  assert.ok(html.includes('What went well'));
  assert.ok(html.includes('Even better if'));
  assert.ok(html.includes('Focus on'));
  assert.ok(html.includes('18'), 'total marks should appear');
  assert.ok(text.includes('Grade:'));
  assert.ok(!html.includes('undefined'));
});

test('the parent version is worded differently and has its own subject', () => {
  const a = fixture();
  const p = a.pupils[0].id;
  a.questions.forEach((q) => setMark(a, p, q.id, q.maxMarks));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  const pupilMail = renderFeedbackEmail(fb, { audience: 'pupil' });
  const parentMail = renderFeedbackEmail(fb, { audience: 'parent' });

  assert.notEqual(pupilMail.subject, parentMail.subject);
  assert.ok(parentMail.html.includes('Dear Parent / Guardian'));
  assert.ok(parentMail.html.includes('John Smith'));
  assert.ok(pupilMail.html.includes('Hi John'));
});

test('pupil names are escaped, so a name cannot inject HTML', () => {
  const a = fixture();
  a.pupils[0].name = '<script>alert(1)</script>';
  const p = a.pupils[0].id;
  a.questions.forEach((q) => setMark(a, p, q.id, 3));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  const { html } = renderFeedbackEmail(fb, { audience: 'parent' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('an unfinished paper says so in the preview instead of inventing a grade', () => {
  const a = fixture();
  setMark(a, a.pupils[0].id, a.questions[0].id, 5);
  const fb = buildPupilFeedback(a, a.pupils[0]);
  const { html, text } = renderFeedbackEmail(fb, { audience: 'pupil' });
  assert.equal(fb.totalMarks, null);
  assert.ok(html.includes('not been marked yet'));
  assert.ok(text.includes('not been marked yet'));
});

test('no percentage figure appears in a rendered email', () => {
  const a = fixture();
  a.questions.forEach((q) => setMark(a, a.pupils[0].id, q.id, 3));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  const { html, text } = renderFeedbackEmail(fb, { audience: 'pupil' });
  assert.equal(/\d+%/.test(text), false, 'plain-text email must contain no percentage');
  // In the HTML, "%" only ever appears inside layout attributes such as width="100%".
  const visibleText = html.replace(/<[^>]*>/g, ' ');
  assert.equal(/\d+\s*%/.test(visibleText), false, 'visible email text must contain no percentage');
  assert.equal(html.includes('Percentage'), false);
});

test('admin wording overrides are applied and placeholders filled', () => {
  const a = fixture();
  a.questions.forEach((q) => setMark(a, a.pupils[0].id, q.id, 3));
  a.pupils[0].name = 'Amelia Stone';
  const fb = buildPupilFeedback(a, a.pupils[0]);
  const { html, subject } = renderFeedbackEmail(fb, {
    audience: 'pupil',
    text: { pupil: { greeting: 'Morning {firstName}!', subject: '{examName} — how you did' } },
  });
  assert.ok(html.includes('Morning Amelia!'));
  assert.equal(subject, 'Test Paper — how you did');
});

test('wording overrides cannot inject markup into an email', () => {
  const a = fixture();
  a.questions.forEach((q) => setMark(a, a.pupils[0].id, q.id, 3));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  const { html } = renderFeedbackEmail(fb, {
    audience: 'pupil',
    text: { pupil: { greeting: '<img src=x onerror=alert(1)>' } },
  });
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img'));
});

/* ========================= analysis calculations ======================== */

test('topic averages group questions case-insensitively', () => {
  const a = fixture();
  a.pupils = [newPupil('A', 'a@x.com'), newPupil('B', 'b@x.com')];
  // Q1 "Algebra" (5) and Q2 "algebra" (5) must merge into one topic.
  setMark(a, a.pupils[0].id, a.questions[0].id, 4);
  setMark(a, a.pupils[1].id, a.questions[0].id, 2);   // Q1 average 3
  setMark(a, a.pupils[0].id, a.questions[1].id, 5);
  setMark(a, a.pupils[1].id, a.questions[1].id, 1);   // Q2 average 3

  const topics = topicAverages(a);
  const algebra = topics.find((t) => t.topic.toLowerCase() === 'algebra');
  assert.equal(topics.filter((t) => t.topic.toLowerCase() === 'algebra').length, 1);
  assert.equal(algebra.topic, 'Algebra', 'the first-seen spelling is kept');
  assert.equal(algebra.questionCount, 2);
  assert.equal(algebra.averageMark, 6);
  assert.equal(algebra.maxMarks, 10);
});

test('questions with no topic are left out of topic analysis', () => {
  const a = fixture();
  a.questions.forEach((q) => setMark(a, a.pupils[0].id, q.id, 2));
  assert.ok(topicAverages(a).every((t) => t.topic.trim() !== ''));
});

test('grade distribution counts only fully marked papers', () => {
  const a = fixture();
  a.pupils = [newPupil('A', 'a@x.com'), newPupil('B', 'b@x.com')];
  a.questions.forEach((q) => setMark(a, a.pupils[0].id, q.id, q.maxMarks)); // 30/30
  setMark(a, a.pupils[1].id, a.questions[0].id, 5);                        // part marked

  const distribution = gradeDistribution(a);
  assert.equal(distribution.graded, 1, 'the part-marked paper is not graded');
  assert.equal(distribution.rows.find((r) => r.grade === '9').count, 1);
  assert.equal(completedTotals(a).length, 1);
});

test('class summary reports an average mark and the grade it earns', () => {
  const a = fixture();
  a.pupils = [newPupil('A', 'a@x.com'), newPupil('B', 'b@x.com')];
  a.questions.forEach((q) => setMark(a, a.pupils[0].id, q.id, q.maxMarks)); // 30
  a.questions.forEach((q) => setMark(a, a.pupils[1].id, q.id, 0));          // 0

  const summary = classSummary(a);
  assert.equal(summary.count, 2);
  assert.equal(summary.averageMark, 15);
  assert.equal(summary.averageGrade, gradeForMark(a.gradeBoundaries, 15));
  assert.equal('averagePercentage' in summary, false);
});

test('class summary excludes part-marked papers from the average', () => {
  const a = fixture();
  a.pupils = [newPupil('A', 'a@x.com'), newPupil('B', 'b@x.com')];
  a.questions.forEach((q) => setMark(a, a.pupils[0].id, q.id, q.maxMarks));
  setMark(a, a.pupils[1].id, a.questions[0].id, 0);
  const summary = classSummary(a);
  assert.equal(summary.count, 1, 'only the finished paper counts');
  assert.equal(summary.averageMark, 30);
});

test('mark progress counts filled cells, not attainment', () => {
  const a = fixture();
  a.pupils = [newPupil('A', 'a@x.com')];
  setMark(a, a.pupils[0].id, a.questions[0].id, 0);
  const progress = markProgress(a);
  assert.equal(progress.cells, 6);
  assert.equal(progress.entered, 1, 'a mark of zero still counts as entered');
});

/* ============================ model behaviour =========================== */

test('resizing questions down removes their marks', () => {
  const a = fixture();
  const p = a.pupils[0].id;
  a.questions.forEach((q) => setMark(a, p, q.id, 1));
  resizeQuestions(a, 3);
  assert.equal(a.questions.length, 3);
  assert.equal(Object.keys(a.marks[p]).length, 3);
});

test('switching tier keeps boundaries for grades common to both', () => {
  const a = fixture();
  applyPaperType(a, 'foundation');
  assert.deepEqual(a.gradeBoundaries.map((b) => b.grade), ['U', '1', '2', '3', '4', '5']);
  assert.equal(a.gradeBoundaries.find((b) => b.grade === '4').minMark, 10, 'grade 4 boundary should survive');
  assert.equal(a.gradeBoundaries.find((b) => b.grade === '1').minMark, null);
});

/* ============================== small helpers =========================== */

test('email validation', () => {
  assert.equal(isValidEmail('a@b.co.uk'), true);
  assert.equal(isValidEmail('a@b'), false);
  assert.equal(isValidEmail('a b@c.com'), false);
  assert.equal(isValidEmail(''), false);
});

test('URL validation only allows http and https', () => {
  assert.equal(isValidUrl('https://x.com'), true);
  assert.equal(isValidUrl('http://x.com'), true);
  assert.equal(isValidUrl('javascript:alert(1)'), false);
  assert.equal(isValidUrl('data:text/html,x'), false);
  assert.equal(isValidUrl('example.com'), false);
});

/* ======================== editable email preview ======================== */

test('the editable preview adds edit hooks; a real email carries none', () => {
  const a = fixture();
  a.questions.forEach((q) => setMark(a, a.pupils[0].id, q.id, 3));
  const fb = buildPupilFeedback(a, a.pupils[0]);

  const real = renderFeedbackEmail(fb, { audience: 'pupil' });
  const preview = renderFeedbackEmail(fb, { audience: 'pupil', editable: true });

  assert.equal(/data-qla-edit/.test(real.html), false, 'a sent email must carry no editing hooks');
  assert.equal(/data-qla-ph/.test(real.html), false);
  assert.ok(/data-qla-edit/.test(preview.html));
});

test('the preview wraps each placeholder so it survives being edited', () => {
  const a = fixture();
  a.pupils[0].name = 'Amelia Stone';
  a.questions.forEach((q) => setMark(a, a.pupils[0].id, q.id, 3));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  const { html } = renderFeedbackEmail(fb, { audience: 'pupil', editable: true });

  // The greeting reads "Hi Amelia," with Amelia individually marked, which is
  // what lets the editor put {firstName} back when the text is read out again.
  assert.ok(html.includes('<span data-qla-ph="firstName">Amelia</span>'));
});

test('every heading is reachable in the preview even when its section is empty', () => {
  const a = fixture();
  // Middling marks everywhere: nothing qualifies as a strength or a weakness.
  a.questions.forEach((q) => setMark(a, a.pupils[0].id, q.id, q.maxMarks / 2));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  assert.deepEqual(fb.wentWell, []);
  assert.deepEqual(fb.evenBetterIf, []);

  const real = renderFeedbackEmail(fb, { audience: 'pupil' });
  const preview = renderFeedbackEmail(fb, { audience: 'pupil', editable: true });

  assert.equal(real.html.includes('What went well'), false, 'an empty section is not sent');
  assert.ok(preview.html.includes('What went well'), 'but it can still be reworded');
  assert.ok(preview.html.includes('Even better if'));
});

test('the optional message is left out of an email that has none', () => {
  const a = fixture();
  a.questions.forEach((q) => setMark(a, a.pupils[0].id, q.id, 3));
  const fb = buildPupilFeedback(a, a.pupils[0]);

  const real = renderFeedbackEmail(fb, { audience: 'pupil' });
  // No empty box, no stray heading, no leftover border.
  assert.equal(real.html.includes('data-placeholder'), false);
  assert.equal(real.html.includes('A note from'), false, 'the old teacher-note block is gone');

  const preview = renderFeedbackEmail(fb, { audience: 'pupil', editable: true });
  assert.ok(preview.html.includes('data-qla-edit="extraMessage"'), 'but it can be written in the preview');
});

test('the optional message appears once written, in the email and the plain text', () => {
  const a = fixture();
  a.questions.forEach((q) => setMark(a, a.pupils[0].id, q.id, 3));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  const { html, text } = renderFeedbackEmail(fb, {
    audience: 'pupil',
    text: { pupil: { extraMessage: 'Bring your corrections to Thursday.' } },
  });
  assert.ok(html.includes('Bring your corrections to Thursday.'));
  assert.ok(text.includes('Bring your corrections to Thursday.'));
});

test('the closing paragraph is gone from both versions of the email', () => {
  const a = fixture();
  a.questions.forEach((q) => setMark(a, a.pupils[0].id, q.id, 3));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  for (const audience of ['pupil', 'parent']) {
    const { html } = renderFeedbackEmail(fb, { audience });
    assert.equal(html.includes('contact the school'), false);
    assert.equal(html.includes('ask your teacher'), false);
  }
  assert.equal('closing' in DEFAULT_EMAIL_TEXT.pupil, false);
  assert.equal('closing' in DEFAULT_EMAIL_TEXT.parent, false);
});

test('exactly one editable box follows the Focus on section', () => {
  const a = fixture();
  a.questions.forEach((q) => setMark(a, a.pupils[0].id, q.id, 3));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  const { html } = renderFeedbackEmail(fb, { audience: 'pupil', editable: true });

  const afterFocus = html.slice(html.indexOf('Focus on'));
  const keys = [...afterFocus.matchAll(/data-qla-edit="(\w+)"/g)].map((m) => m[1]);
  // The sign-off is part of the letter's ending, not the message area.
  assert.deepEqual(keys, ['extraMessage', 'signOff', 'signOffName']);
  assert.equal(keys.filter((k) => k === 'nothingFlagged').length, 0,
    'the "nothing stood out" line is no longer a second box');
});

test('a name containing markup cannot escape the placeholder marker', () => {
  const a = fixture();
  a.pupils[0].name = '<b>Evil</b> Name';
  a.questions.forEach((q) => setMark(a, a.pupils[0].id, q.id, 3));
  const fb = buildPupilFeedback(a, a.pupils[0]);
  const { html } = renderFeedbackEmail(fb, { audience: 'pupil', editable: true });
  assert.equal(html.includes('<b>Evil</b>'), false);
  assert.ok(html.includes('&lt;b&gt;'));
});

/* ==================== per-pupil email wording =========================== */

// Mirrors wordingFor() in views/feedback.js: defaults, then the assessment's
// wording, then anything set for one pupil alone.
function mergedWording(assessment, pupilId) {
  const shared = assessment.emailText || {};
  const personal = (assessment.pupilEmailText || {})[pupilId] || {};
  const merge = (audience) => ({
    ...DEFAULT_EMAIL_TEXT[audience],
    ...(shared[audience] || {}),
    ...(personal[audience] || {}),
  });
  return { pupil: merge('pupil'), parent: merge('parent') };
}

test('a pupil with their own wording overrides the class wording', () => {
  const a = fixture();
  a.emailText = { pupil: { greeting: 'Hello {firstName},' } };
  a.pupilEmailText = { [a.pupils[0].id]: { pupil: { greeting: 'A word, {firstName}.' } } };

  assert.equal(mergedWording(a, a.pupils[0].id).pupil.greeting, 'A word, {firstName}.');
  assert.equal(mergedWording(a, 'someone_else').pupil.greeting, 'Hello {firstName},',
    'every other pupil keeps the class wording');
});

test('a pupil override only changes the fields it names', () => {
  const a = fixture();
  a.emailText = { pupil: { greeting: 'Hello {firstName},', closing: 'See me.' } };
  a.pupilEmailText = { p1: { pupil: { greeting: 'Hi.' } } };
  const merged = mergedWording(a, 'p1').pupil;
  assert.equal(merged.greeting, 'Hi.');
  assert.equal(merged.closing, 'See me.', 'untouched fields still come from the class wording');
  assert.equal(merged.wwwHeading, DEFAULT_EMAIL_TEXT.pupil.wwwHeading);
});

test('a pupil override reaches the rendered email', () => {
  const a = fixture();
  a.pupils[0].name = 'Amelia Stone';
  a.questions.forEach((q) => setMark(a, a.pupils[0].id, q.id, 3));
  a.pupilEmailText = { [a.pupils[0].id]: { pupil: { greeting: 'Amelia — a note for you.' } } };

  const fb = buildPupilFeedback(a, a.pupils[0]);
  const { html } = renderFeedbackEmail(fb, {
    audience: 'pupil',
    text: mergedWording(a, a.pupils[0].id),
  });
  assert.ok(html.includes('Amelia — a note for you.'));
});

test('clearing a pupil override returns them to the class wording', () => {
  const a = fixture();
  a.emailText = { pupil: { greeting: 'Hello {firstName},' } };
  a.pupilEmailText = { p1: { pupil: { greeting: 'Hi.' } } };
  delete a.pupilEmailText.p1;
  assert.equal(mergedWording(a, 'p1').pupil.greeting, 'Hello {firstName},');
});

/* ============================== setup lock ============================== */

// These are async because PIN hashing uses the Web Crypto API, so they run in
// their own pass before the report is printed.
async function asyncTest(name, fn) {
  try { await fn(); passed += 1; process.stdout.write('.'); }
  catch (error) { failed += 1; failures.push({ name, error }); process.stdout.write('F'); }
}

await asyncTest('the right PIN unlocks and a wrong one does not', async () => {
  const a = fixture();
  a.settings.lock = await buildLock('4821');
  assert.equal(await pinMatches(a, '4821'), true);
  assert.equal(await pinMatches(a, '4822'), false);
  assert.equal(await pinMatches(a, ''), false);
});

await asyncTest('the PIN itself is never stored, only a salted hash', async () => {
  const a = fixture();
  a.settings.lock = await buildLock('1234');
  const serialised = JSON.stringify(a.settings.lock);
  assert.equal(serialised.includes('1234'), false, 'the PIN must not be recoverable from the save file');
  assert.ok(a.settings.lock.salt, 'a salt is stored');
  assert.equal(a.settings.lock.pinHash.length, 64, 'SHA-256 hex digest');
});

await asyncTest('the same PIN on two assessments produces different hashes', async () => {
  const first = await buildLock('1234');
  const second = await buildLock('1234');
  assert.notEqual(first.pinHash, second.pinHash, 'salting must prevent hash reuse');
});

await asyncTest('PIN format is enforced', async () => {
  assert.equal(validatePin('1234'), null);
  assert.equal(validatePin('12345678'), null);
  assert.ok(validatePin('123'), 'too short is rejected');
  assert.ok(validatePin('12345a'), 'letters are rejected');
  assert.ok(validatePin(''), 'empty is rejected');
});

/* ============================== signing in ============================== */

/** The shape js/supabase.js throws. */
function providerError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

test('a pasted address is trimmed and lowercased the way the database stores it', () => {
  assert.equal(normaliseEmail('  A.Teacher@School.SCH.UK '), 'a.teacher@school.sch.uk');
  assert.equal(normaliseEmail(null), '');
});

test('an obviously malformed address is caught before a request is made', () => {
  assert.equal(looksLikeEmail('a.teacher@school.sch.uk'), true);
  assert.equal(looksLikeEmail('a.teacher@school'), false);   // no dot in the domain
  assert.equal(looksLikeEmail('a.teacher'), false);
  assert.equal(looksLikeEmail(''), false);
});

test('an address that is not on the staff list says who to ask', () => {
  const message = signInErrorMessage(providerError('Signups not allowed for otp', 422), 'send');
  assert.match(message, /staff list/);
  assert.match(message, /typo/);
});

test('the hook\'s own refusal is passed through, because it names the school', () => {
  const hook = providerError("That address is not on your school's staff list. Ask whoever set up EveryPupil at your school to add it.", 403);
  assert.equal(signInErrorMessage(hook, 'send'), hook.message);
});

test('a wrong code never suggests the address is at fault', () => {
  const message = signInErrorMessage(providerError('Token has expired or is invalid', 403), 'verify');
  assert.match(message, /code is wrong or has expired/);
  assert.doesNotMatch(message, /staff list/);
});

test('the rate limit tells you how long to wait when the provider says', () => {
  const message = signInErrorMessage(providerError('For security purposes, you can only request this after 41 seconds.', 429), 'send');
  assert.match(message, /wait 41 seconds/);
});

test('a rate limit with no number still gives an instruction', () => {
  const message = signInErrorMessage(providerError('email rate limit exceeded', 429), 'send');
  assert.match(message, /Wait a few minutes/);
});

test('one second is not "1 seconds"', () => {
  const message = signInErrorMessage(providerError('you can only request this after 1 seconds.', 429), 'send');
  assert.match(message, /wait 1 second\b/);
});

test('a dropped connection is not reported as a rejected account', () => {
  const message = signInErrorMessage(providerError('Failed to fetch', 0), 'send');
  assert.match(message, /internet connection/);
  assert.doesNotMatch(message, /staff list/);
});

test('an unrecognised provider error is passed on rather than swallowed', () => {
  const message = signInErrorMessage(providerError('Database error creating new user', 500), 'send');
  assert.equal(message, 'Database error creating new user');
});

test('an error with no message at all still says something useful', () => {
  assert.match(signInErrorMessage({}, 'send'), /Something went wrong/);
});

/* ================================ report ================================ */

console.log('\n');
for (const { name, error } of failures) {
  console.log(`FAILED: ${name}\n  ${error.message}\n`);
}

console.log(`${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
