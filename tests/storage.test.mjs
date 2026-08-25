/**
 * The database storage layer, against a real PostgreSQL with the real
 * policies from supabase/migrations applied.
 *
 *   node tests/storage.test.mjs
 *
 * Needs a local PostgreSQL 16 and psql. Skips politely if there is none, so
 * `npm test` on a machine without one is not a failure.
 *
 * What makes this worth writing rather than mocking: every "a teacher cannot
 * do X" below is answered by Postgres evaluating the policy, not by a stub
 * agreeing with me.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { start } from './browser/fake-postgrest.mjs';

const PSQL = process.env.PSQL || '/usr/lib/postgresql/16/bin/psql';
const DB = 'epstore';
const PORT = 5401;

const ORG = '11111111-1111-1111-1111-111111111111';
const ADMIN = 'a0000000-0000-0000-0000-000000000001';
const MARKER = 'b0000000-0000-0000-0000-000000000002';
const BYSTANDER = 'c0000000-0000-0000-0000-000000000003';

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try { await fn(); passed += 1; process.stdout.write('.'); }
  catch (error) { failed += 1; failures.push({ name, error }); process.stdout.write('F'); }
}

/* --- Build the database -------------------------------------------------- */

const psql = (args, input) => execFileSync(PSQL, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args],
  { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });

try {
  psql(['-d', 'postgres', '-c', 'select 1']);
} catch {
  console.log('No local PostgreSQL — skipping the storage tests.');
  process.exit(0);
}

execFileSync(PSQL.replace(/psql$/, 'dropdb'), ['--if-exists', DB], { stdio: 'ignore' });
execFileSync(PSQL.replace(/psql$/, 'createdb'), [DB], { stdio: 'ignore' });

psql(['-d', DB], `
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique);
  create or replace function auth.uid() returns uuid language sql stable as $fn$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
`);

for (const file of ['0001_schema', '0002_access', '0003_roles', '0004_staff']) {
  psql(['-d', DB, '-f', new URL(`../supabase/migrations/${file}.sql`, import.meta.url).pathname]);
  if (file === '0001_schema') {
    // Supabase grants these on every new public table. Reproduced so the test
    // runs against the same privileges a real project has.
    psql(['-d', DB, '-c',
      'grant usage on schema public to anon, authenticated; grant all on all tables in schema public to anon, authenticated;']);
  }
}

psql(['-d', DB], `
  insert into organisations (id, name) values ('${ORG}', 'Northgate High');
  insert into auth.users (id, email) values
    ('${ADMIN}', 'head@northgate.sch.uk'),
    ('${MARKER}', 'marker@northgate.sch.uk'),
    ('${BYSTANDER}', 'other@northgate.sch.uk');
  insert into memberships (user_id, org_id, role) values
    ('${ADMIN}', '${ORG}', 'admin'),
    ('${MARKER}', '${ORG}', 'teacher'),
    ('${BYSTANDER}', '${ORG}', 'teacher');
  insert into staff_invites (org_id, email, role) values
    ('${ORG}', 'head@northgate.sch.uk', 'owner'),
    ('${ORG}', 'marker@northgate.sch.uk', 'teacher'),
    ('${ORG}', 'other@northgate.sch.uk', 'teacher');
  update memberships set role = 'owner' where user_id = '${ADMIN}';
`);

const rows = (sql) => JSON.parse(psql(['-d', DB, '-A', '-t', '-c',
  `select coalesce(json_agg(t), '[]')::text from (${sql}) t`]).trim());

/* --- A browser, more or less --------------------------------------------- */

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = { QLA_CONFIG: { supabaseUrl: `http://localhost:${PORT}`, supabaseAnonKey: 'anon-key' } };

const server = start(PORT);

const { verifySignInCode, signOut } = await import('../js/supabase.js');
const { newAssessment, newQuestion, newPupil, setMark } = await import('../js/model.js');
const {
  createSupabaseRepo, reidentify, planWrites, diffMarks, describeWriteError, marksOnly,
} = await import('../js/storage-supabase.js');

/** Sign in as somebody, through the app's own code path. */
async function signInAs(userId, email) {
  await signOut();
  await verifySignInCode(email, userId);
  return createSupabaseRepo({ orgId: ORG, userId });
}

/** An assessment with two questions, two pupils, and one mark entered. */
function sampleDoc() {
  const doc = newAssessment({ paperType: 'higher' });
  doc.exam.name = 'Biology Paper 1';
  doc.exam.subject = 'Biology';
  doc.questions = [
    { ...newQuestion('01.1', 5), topic: 'Cells' },
    { ...newQuestion('01.2', 3), topic: 'Enzymes' },
  ];
  doc.pupils = [newPupil('Ada Khan', 'ada@school.invalid'), newPupil('Ben Rowe', 'ben@school.invalid')];
  setMark(doc, doc.pupils[0].id, doc.questions[0].id, 4);
  return doc;
}

/* ============================== the tests =============================== */

let adminRepo;
let saved;

await test('an admin can save a new assessment', async () => {
  adminRepo = await signInAs(ADMIN, 'head@northgate.sch.uk');
  saved = await adminRepo.save(sampleDoc());
  assert.equal(rows('select * from assessments').length, 1);
  assert.equal(rows('select * from questions').length, 2);
  assert.equal(rows('select * from pupils').length, 2);
  assert.equal(rows('select * from assessment_pupils').length, 2);
  assert.equal(rows('select * from marks').length, 1);
});

await test('reading it back gives the same document', async () => {
  const loaded = await adminRepo.get(saved.id);
  assert.equal(loaded.exam.name, 'Biology Paper 1');
  assert.equal(loaded.exam.subject, 'Biology');
  assert.equal(loaded.questions.length, 2);
  assert.equal(loaded.questions[0].number, '01.1');
  assert.equal(loaded.questions[0].topic, 'Cells');
  assert.equal(loaded.pupils.map((p) => p.name).join(','), 'Ada Khan,Ben Rowe');
  assert.equal(loaded.marks[saved.pupils[0].id][saved.questions[0].id], 4);
});

await test('a blank cell comes back blank, not zero', async () => {
  const loaded = await adminRepo.get(saved.id);
  const second = loaded.marks[loaded.pupils[1].id];
  assert.ok(!second || second[loaded.questions[0].id] === undefined,
    'a pupil who has not been marked must have no mark, not a zero');
});

await test('a cleared mark is stored as blank and stays distinct from zero', async () => {
  const doc = await adminRepo.get(saved.id);
  setMark(doc, doc.pupils[1].id, doc.questions[0].id, 0);
  setMark(doc, doc.pupils[0].id, doc.questions[0].id, null);
  await adminRepo.save(doc);

  const stored = rows('select pupil_id, mark from marks order by mark nulls last');
  const zero = stored.find((r) => r.pupil_id === doc.pupils[1].id);
  const blank = stored.find((r) => r.pupil_id === doc.pupils[0].id);
  assert.equal(Number(zero.mark), 0);
  assert.equal(blank.mark, null);
});

await test('changing one mark sends one row, not the whole marksheet', async () => {
  const doc = await adminRepo.get(saved.id);
  // Fill in every cell so there is plenty that could wrongly be resent.
  for (const pupil of doc.pupils) {
    for (const question of doc.questions) setMark(doc, pupil.id, question.id, 1);
  }
  await adminRepo.save(doc);

  const mark = server.log.length;
  setMark(doc, doc.pupils[0].id, doc.questions[1].id, 3);
  await adminRepo.save(doc);

  const writes = server.writesSince(mark);
  assert.equal(writes.length, 1, `expected one write, got ${JSON.stringify(writes)}`);
  assert.equal(writes[0].table, 'marks');
  assert.equal(writes[0].rows, 1);
});

await test('saving with nothing changed sends nothing at all', async () => {
  const doc = await adminRepo.get(saved.id);
  const mark = server.log.length;
  await adminRepo.save(doc);
  assert.equal(server.writesSince(mark).length, 0);
});

await test('an unassigned teacher cannot change a mark, and is told why', async () => {
  const repo = await signInAs(BYSTANDER, 'other@northgate.sch.uk');
  const doc = await repo.get(saved.id);
  setMark(doc, doc.pupils[0].id, doc.questions[0].id, 5);

  await assert.rejects(() => repo.save(doc), (error) => {
    assert.match(error.message, /NOT saved/, 'it must not imply the marks are safe');
    assert.match(error.message, /Ask an admin/);
    return true;
  });
});

await test('an unassigned teacher can still read the paper and its marks', async () => {
  const repo = await signInAs(BYSTANDER, 'other@northgate.sch.uk');
  const doc = await repo.get(saved.id);
  assert.equal(doc.questions.length, 2);
  assert.ok(Object.keys(doc.marks).length > 0, 'analysis needs the marks');
});

await test('an assigned teacher can enter marks', async () => {
  psql(['-d', DB, '-c',
    `insert into assessment_teachers (assessment_id, user_id) values ('${saved.id}', '${MARKER}')`]);

  const repo = await signInAs(MARKER, 'marker@northgate.sch.uk');
  const doc = await repo.get(saved.id);
  setMark(doc, doc.pupils[1].id, doc.questions[1].id, 2);
  await repo.save(doc);

  const stored = rows(`select mark from marks where pupil_id = '${doc.pupils[1].id}' and question_id = '${doc.questions[1].id}'`);
  assert.equal(Number(stored[0].mark), 2);
});

await test('a teacher whose document has drifted still gets their marks in', async () => {
  // The situation this guards against: something other than the teacher has
  // left a change in their copy of the assessment — a normalised field, a
  // default filled in by a newer version — and their next mark entry would
  // otherwise be refused as an attempt to edit the paper.
  const repo = createSupabaseRepo({ orgId: ORG, userId: MARKER, canManage: () => false });
  await signInAs(MARKER, 'marker@northgate.sch.uk');
  const doc = await repo.get(saved.id);

  doc.exam.subject = 'Chemistry';                 // not theirs to change
  doc.settings.analyse.topicSort = 'name';        // nor this
  setMark(doc, doc.pupils[1].id, doc.questions[0].id, 1);   // this is

  await repo.save(doc);   // must not throw

  const stored = rows(`select mark from marks where pupil_id = '${doc.pupils[1].id}' and question_id = '${doc.questions[0].id}'`);
  assert.equal(Number(stored[0].mark), 1, 'the mark must be saved');
  assert.equal(rows(`select subject from assessments where id = '${saved.id}'`)[0].subject, 'Biology',
    'and the drift must not have been written');
});

await test('what a teacher may write is decided before anything is sent', () => {
  const before = sampleDoc();
  const after = structuredClone(before);
  after.exam.name = 'Renamed';
  after.questions.push(newQuestion('02', 4));
  setMark(after, after.pupils[0].id, after.questions[0].id, 5);

  const full = planWrites(before, after, { orgId: ORG, userId: MARKER });
  const { plan, dropped } = marksOnly(full);

  assert.equal(plan.assessment, null);
  assert.equal(plan.questions.insert.length, 0);
  assert.equal(plan.marks.changed.length, 1, 'the mark is kept');
  assert.deepEqual(dropped.sort(), ['assessment', 'questions']);
});

await test('an admin is never trimmed', () => {
  const before = sampleDoc();
  const after = structuredClone(before);
  after.exam.name = 'Renamed';
  const full = planWrites(before, after, { orgId: ORG, userId: ADMIN });
  assert.ok(full.assessment, 'an admin sends the whole difference');
});

await test('a refused mark never claims the marks were saved', () => {
  const refusal = new Error('new row violates row-level security policy for table "marks"');
  refusal.status = 403;
  const message = describeWriteError(refusal, 'marks');
  assert.match(message, /NOT saved/);
  assert.doesNotMatch(message, /marks were saved/i,
    'the old wording told a teacher their marking was safe when it was not');
  assert.match(message, /Ask an admin/);
});

await test('an assigned teacher cannot change the paper — and their marks survive the attempt', async () => {
  const repo = await signInAs(MARKER, 'marker@northgate.sch.uk');
  const doc = await repo.get(saved.id);

  setMark(doc, doc.pupils[0].id, doc.questions[1].id, 3);   // allowed
  doc.exam.name = 'Renamed by a teacher';                   // not allowed

  await assert.rejects(() => repo.save(doc), (error) => {
    assert.match(error.message, /Your marks were saved/);
    assert.match(error.message, /only be changed by an admin/);
    return true;
  });

  const name = rows(`select name from assessments where id = '${saved.id}'`)[0].name;
  assert.equal(name, 'Biology Paper 1', 'the paper must not have been renamed');

  const mark = rows(`select mark from marks where pupil_id = '${doc.pupils[0].id}' and question_id = '${doc.questions[1].id}'`);
  assert.equal(Number(mark[0].mark), 3, 'the mark they were entitled to enter must be saved');
});

await test('an assigned teacher cannot add a question', async () => {
  const repo = await signInAs(MARKER, 'marker@northgate.sch.uk');
  const doc = await repo.get(saved.id);
  doc.questions.push(newQuestion('02', 4));
  await assert.rejects(() => repo.save(doc));
  assert.equal(rows('select * from questions').length, 2);
});

await test('two teachers marking at once do not overwrite each other', async () => {
  // Both load the paper, then each marks a different cell without reloading.
  const adminSide = await signInAs(ADMIN, 'head@northgate.sch.uk');
  const adminDoc = await adminSide.get(saved.id);
  const markerSide = await signInAs(MARKER, 'marker@northgate.sch.uk');
  const markerDoc = await markerSide.get(saved.id);

  setMark(markerDoc, markerDoc.pupils[0].id, markerDoc.questions[0].id, 5);
  await markerSide.save(markerDoc);

  // The admin's copy is now stale, but they only touched a different cell.
  setMark(adminDoc, adminDoc.pupils[1].id, adminDoc.questions[1].id, 1);
  await signInAs(ADMIN, 'head@northgate.sch.uk');
  await adminSide.save(adminDoc);

  const first = rows(`select mark from marks where pupil_id = '${saved.pupils[0].id}' and question_id = '${saved.questions[0].id}'`);
  const second = rows(`select mark from marks where pupil_id = '${saved.pupils[1].id}' and question_id = '${saved.questions[1].id}'`);
  assert.equal(Number(first[0].mark), 5, "the marker's cell survived");
  assert.equal(Number(second[0].mark), 1, "the admin's cell survived");
});

await test('removing a pupil takes only that paper\'s marks with them', async () => {
  const repo = await signInAs(ADMIN, 'head@northgate.sch.uk');

  // A second paper, with the same pupil on it.
  const other = sampleDoc();
  other.exam.name = 'Chemistry Paper 1';
  // The same child, sitting a second paper — the record is reused, not copied.
  // The marks left over from sampleDoc()'s own pupils are deliberately left in
  // place: a document can carry marks for somebody who is no longer on the
  // paper, and saving must cope rather than fail.
  other.pupils = [{ ...saved.pupils[0] }];
  setMark(other, other.pupils[0].id, other.questions[0].id, 2);
  await repo.save(other);

  const doc = await repo.get(saved.id);
  const removed = doc.pupils[0].id;
  doc.pupils = doc.pupils.filter((p) => p.id !== removed);
  delete doc.marks[removed];
  await repo.save(doc);

  assert.equal(rows(`select * from marks where assessment_id = '${saved.id}' and pupil_id = '${removed}'`).length, 0);
  assert.ok(rows(`select * from marks where assessment_id = '${other.id}' and pupil_id = '${removed}'`).length > 0,
    'their marks on the other paper must be untouched');
  assert.equal(rows(`select * from pupils where id = '${removed}'`).length, 1,
    'the pupil still exists at school level');
});

await test('the assessment list shows each paper and how many sat it', async () => {
  const repo = await signInAs(ADMIN, 'head@northgate.sch.uk');
  const list = await repo.list();
  assert.equal(list.length, 2);
  const biology = list.find((item) => item.name === 'Biology Paper 1');
  assert.equal(biology.pupilCount, 1);
});

await test('deleting an assessment leaves the pupils on the school roll', async () => {
  const repo = await signInAs(ADMIN, 'head@northgate.sch.uk');
  const before = rows('select * from pupils').length;
  const list = await repo.list();
  const chemistry = list.find((item) => item.name === 'Chemistry Paper 1');
  await repo.remove(chemistry.id);
  assert.equal(rows(`select * from assessments where id = '${chemistry.id}'`).length, 0);
  assert.equal(rows('select * from pupils').length, before);
});

await test('work saved in the browser before the database existed can be brought in', async () => {
  const repo = await signInAs(ADMIN, 'head@northgate.sch.uk');

  // Exactly what an older version wrote: short ids, everywhere.
  const old = sampleDoc();
  old.id = 'asmt_lz3k1abc';
  old.questions[0].id = 'q_aaa';
  old.questions[1].id = 'q_bbb';
  old.pupils[0].id = 'p_111';
  old.pupils[1].id = 'p_222';
  old.marks = { p_111: { q_aaa: 4, q_bbb: null }, p_222: { q_aaa: 1 } };
  old.feedback.selectedPupilIds = ['p_111'];
  old.pupilEmailText = { p_111: { greeting: 'Hi' } };
  old.exam.name = 'Rescued from the browser';
  // Different children from the ones already on the school roll: the same
  // address twice would be a real duplicate, and the database is right to
  // refuse it. That is tested separately.
  old.pupils[0].name = 'Cara Diaz'; old.pupils[0].email = 'cara@school.invalid';
  old.pupils[1].name = 'Dan Evans'; old.pupils[1].email = 'dan@school.invalid';

  await repo.save(old);

  const loaded = await repo.get(old.id);
  assert.match(old.id, /^[0-9a-f-]{36}$/, 'the document itself was given a uuid');
  assert.equal(loaded.exam.name, 'Rescued from the browser');
  assert.equal(loaded.pupils.length, 2);
  assert.equal(loaded.marks[loaded.pupils[0].id][loaded.questions[0].id], 4,
    'the mark still points at the right pupil and question');
  assert.equal(loaded.feedback.selectedPupilIds[0], loaded.pupils[0].id,
    'the feedback selection followed the pupil');
  assert.equal(loaded.pupilEmailText[loaded.pupils[0].id].greeting, 'Hi');
});

/* ============================ staff and markers ========================= */

const people = await import('../js/people.js');

await test('the staff list shows who has signed in and who has not', async () => {
  await signInAs(ADMIN, 'head@northgate.sch.uk');
  await people.inviteStaff('  New.Starter@Northgate.sch.uk ', 'teacher');

  const staff = await people.listStaff();
  const starter = staff.find((person) => person.email === 'new.starter@northgate.sch.uk');
  assert.ok(starter, 'a pasted address is tidied up and appears on the list');
  assert.equal(starter.signedIn, false, 'they have not been in yet');
  assert.equal(starter.userId, null, 'and so have no account to attach to a paper');

  const head = staff.find((person) => person.email === 'head@northgate.sch.uk');
  assert.equal(head.signedIn, true);
  assert.equal(head.role, 'owner');
});

await test('an admin can change what a colleague may do', async () => {
  await signInAs(ADMIN, 'head@northgate.sch.uk');
  await people.setStaffRole('other@northgate.sch.uk', 'admin');
  const staff = await people.listStaff();
  assert.equal(staff.find((p) => p.email === 'other@northgate.sch.uk').role, 'admin');
  await people.setStaffRole('other@northgate.sch.uk', 'teacher');
});

await test('the last owner cannot be demoted, and the message says why', async () => {
  await signInAs(ADMIN, 'head@northgate.sch.uk');
  await assert.rejects(() => people.setStaffRole('head@northgate.sch.uk', 'teacher'), (error) => {
    assert.match(error.message, /only owner/i);
    assert.doesNotMatch(error.message, /CONTEXT|PL\/pgSQL/, 'database machinery must not reach the screen');
    return true;
  });
});

await test('you cannot remove yourself by accident', async () => {
  await signInAs(ADMIN, 'head@northgate.sch.uk');
  await assert.rejects(() => people.removeStaff('head@northgate.sch.uk'),
    (error) => { assert.match(error.message, /cannot remove yourself/i); return true; });
});

await test('a teacher cannot add staff', async () => {
  await signInAs(MARKER, 'marker@northgate.sch.uk');
  await assert.rejects(() => people.inviteStaff('friend@northgate.sch.uk', 'admin'),
    (error) => { assert.match(error.message, /Only an admin can add staff/); return true; });
  const staff = await people.listStaff();
  assert.ok(!staff.some((person) => person.email === 'friend@northgate.sch.uk'));
});

await test('a teacher can still see who their colleagues are', async () => {
  await signInAs(MARKER, 'marker@northgate.sch.uk');
  const staff = await people.listStaff();
  assert.ok(staff.length >= 3);
});

await test('assigning a marker lets them mark, and only that paper', async () => {
  await signInAs(ADMIN, 'head@northgate.sch.uk');
  await people.setMarkers(saved.id, [BYSTANDER], ADMIN);
  assert.deepEqual(await people.listMarkers(saved.id), [BYSTANDER]);

  const repo = await signInAs(BYSTANDER, 'other@northgate.sch.uk');
  const doc = await repo.get(saved.id);
  setMark(doc, doc.pupils[0].id, doc.questions[0].id, 2);
  await repo.save(doc);
  assert.equal(Number(rows(`select mark from marks where pupil_id = '${doc.pupils[0].id}' and question_id = '${doc.questions[0].id}'`)[0].mark), 2);
});

await test('unassigning takes the ability away again', async () => {
  await signInAs(ADMIN, 'head@northgate.sch.uk');
  await people.setMarkers(saved.id, [], ADMIN);
  assert.deepEqual(await people.listMarkers(saved.id), []);

  const repo = await signInAs(BYSTANDER, 'other@northgate.sch.uk');
  const doc = await repo.get(saved.id);
  setMark(doc, doc.pupils[0].id, doc.questions[0].id, 1);
  await assert.rejects(() => repo.save(doc));
});

await test('changing one marker does not disturb the others', async () => {
  await signInAs(ADMIN, 'head@northgate.sch.uk');
  await people.setMarkers(saved.id, [MARKER, BYSTANDER], ADMIN);

  const mark = server.log.length;
  const result = await people.setMarkers(saved.id, [MARKER], ADMIN);
  assert.deepEqual(result, { added: 0, removed: 1 });

  const writes = server.writesSince(mark);
  assert.equal(writes.length, 1, 'one removal, not a clear-and-rebuild');
  assert.deepEqual(await people.listMarkers(saved.id), [MARKER]);
});

await test('a teacher cannot put themselves on a paper', async () => {
  await signInAs(BYSTANDER, 'other@northgate.sch.uk');
  await assert.rejects(() => people.setMarkers(saved.id, [MARKER, BYSTANDER], BYSTANDER));
  await signInAs(ADMIN, 'head@northgate.sch.uk');
  assert.deepEqual(await people.listMarkers(saved.id), [MARKER], 'the list is unchanged');
});

await test('removing somebody takes them off the papers they were marking', async () => {
  await signInAs(ADMIN, 'head@northgate.sch.uk');
  await people.setMarkers(saved.id, [MARKER], ADMIN);
  await people.removeStaff('marker@northgate.sch.uk');

  assert.deepEqual(await people.listMarkers(saved.id), []);
  const staff = await people.listStaff();
  assert.ok(!staff.some((person) => person.email === 'marker@northgate.sch.uk'));
  assert.ok(rows('select * from marks').length > 0, 'their marking stays with the school');
});

/* --- Pure logic, no database needed -------------------------------------- */

await test('marks for a pupil who has left the paper are never sent', () => {
  const doc = sampleDoc();
  const goneId = doc.pupils[1].id;
  setMark(doc, goneId, doc.questions[0].id, 3);
  doc.pupils = doc.pupils.filter((pupil) => pupil.id !== goneId);

  const plan = planWrites(null, doc, { orgId: ORG, userId: ADMIN });
  assert.ok(!plan.marks.changed.some((row) => row.pupil_id === goneId),
    'a mark for a pupil not on the paper would be refused by the database');
});

await test('a duplicate pupil email is explained in terms of what it would do', () => {
  const error = new Error('duplicate key value violates unique constraint "pupils_org_email"');
  error.status = 409;
  assert.match(describeWriteError(error, 'saving'), /two feedback emails/);
});

await test('the difference between a blank and a zero is never lost in a diff', () => {
  const before = [{ pupil_id: 'p', question_id: 'q', mark: null }];
  const after = [{ pupil_id: 'p', question_id: 'q', mark: 0 }];
  assert.equal(diffMarks(before, after).changed.length, 1, 'blank -> 0 is a change');
  assert.equal(diffMarks(after, before).changed.length, 1, '0 -> blank is a change');
  assert.equal(diffMarks(after, after).changed.length, 0);
  assert.equal(diffMarks(before, before).changed.length, 0);
});

await test('a first save plans to write everything', () => {
  const plan = planWrites(null, sampleDoc(), { orgId: ORG, userId: ADMIN });
  assert.ok(plan.assessment);
  assert.equal(plan.questions.insert.length, 2);
  assert.equal(plan.pupils.insert.length, 2);
  assert.equal(plan.entries.insert.length, 2);
  assert.equal(plan.marks.changed.length, 1);
});

await test('reordering pupils is an update, not a delete and re-add', () => {
  const before = sampleDoc();
  const after = structuredClone(before);
  after.pupils.reverse();
  const plan = planWrites(before, after, { orgId: ORG, userId: ADMIN });
  assert.equal(plan.entries.remove.length, 0, 'nobody should be removed by a reorder');
  assert.equal(plan.entries.insert.length, 0);
  assert.equal(plan.entries.update.length, 2, 'both positions change');
});

await test('an expired session says so instead of blaming the teacher', () => {
  const error = new Error('JWT expired'); error.status = 401;
  assert.match(describeWriteError(error, 'saving'), /sign in again/);
  assert.match(describeWriteError(error, 'saving'), /nothing has been lost/);
});

await test('reidentify leaves a modern document completely alone', () => {
  const doc = sampleDoc();
  const copy = structuredClone(doc);
  reidentify(doc);
  assert.deepEqual(doc, copy);
});

/* --- Report -------------------------------------------------------------- */

server.close();
console.log('\n');
for (const { name, error } of failures) {
  console.log(`FAILED: ${name}\n  ${error.message}\n`);
}
console.log(`${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
