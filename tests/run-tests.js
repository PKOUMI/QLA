/**
 * tests/run-tests.js — run with:  npm test
 *
 * These cover the logic that decides what a child is told about their work, so
 * they are worth keeping green. No test framework, no dependencies: plain Node.
 */

import assert from 'node:assert/strict';
import { newAssessment, newQuestion, newPupil, setMark, applyPaperType, resizeQuestions } from '../js/model.js';
import { totalPossible, gradeForMark, pupilResult, questionAverages, classSummary } from '../js/grades.js';
import { buildPupilFeedback, pupilSendStatus } from '../js/feedback-engine.js';
import { validateMark, validateAssessment, isValidEmail, isValidUrl, csvSafeCell } from '../js/validation.js';
import { parsePupilCsv, parseCsv, toCsv } from '../js/csv.js';
import { renderFeedbackEmail } from '../shared/email-template.js';

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
  a.exam.teacherName = 'Ms Okafor';
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

test('pupilResult totals, percentage and grade', () => {
  const a = fixture();
  const p = a.pupils[0].id;
  [5, 4, 5, 1, 2, 3].forEach((m, i) => setMark(a, p, a.questions[i].id, m)); // 20/30
  const r = pupilResult(a, p);
  assert.equal(r.achieved, 20);
  assert.equal(r.possible, 30);
  assert.equal(Math.round(r.percentage), 67);
  assert.equal(r.grade, '6');
  assert.equal(r.isComplete, true);
  assert.equal(r.isProvisional, false);
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
  assert.equal(r.isProvisional, true, 'grade should be flagged provisional');
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

test('blankPolicy "zero" counts blanks as zero and clears the provisional flag', () => {
  const a = fixture();
  a.exam.blankPolicy = 'zero';
  const p = a.pupils[0].id;
  setMark(a, p, a.questions[0].id, 5);
  const r = pupilResult(a, p);
  assert.equal(r.achieved, 5);
  assert.equal(r.isProvisional, false);
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
  assert.equal(avg.percentage, 80);
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

test('a partly-marked pupil can be sent to, but is warned about', () => {
  const a = fixture();
  setMark(a, a.pupils[0].id, a.questions[0].id, 5);
  const status = pupilSendStatus(a, a.pupils[0]);
  assert.equal(status.canSend, true);
  assert.ok(status.warnings.some((w) => w.includes('not marked')));
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

test('a provisional result carries a visible warning in the email', () => {
  const a = fixture();
  setMark(a, a.pupils[0].id, a.questions[0].id, 5);
  const fb = buildPupilFeedback(a, a.pupils[0]);
  const { html, text } = renderFeedbackEmail(fb, { audience: 'pupil' });
  assert.ok(html.includes('provisional'));
  assert.ok(text.includes('provisional'));
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

/* ================================ report ================================ */

console.log('\n');
for (const { name, error } of failures) {
  console.log(`FAILED: ${name}\n  ${error.message}\n`);
}
console.log(`${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
