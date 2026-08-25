/**
 * A teacher marking a paper — the whole way through.
 *
 *   node tests/browser/teacher-marking.test.mjs
 *
 * Real browser, real app, real PostgreSQL with the real policies. The only
 * stand-in is the HTTP layer between them, which translates each request into
 * SQL (tests/browser/fake-postgrest.mjs).
 *
 * This exists because everything below it passed while the thing itself did
 * not work: the storage layer was tested, the policies were tested, and a
 * teacher still could not enter a mark. What was missing was a test of the
 * app as a teacher actually meets it.
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { connect, until, sleep } from './cdp.mjs';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const PSQL = process.env.PSQL || '/usr/lib/postgresql/16/bin/psql';
const DB = 'epteacher';
const API_PORT = 5404;
const APP_PORT = 5314;

const ORG = '11111111-1111-1111-1111-111111111111';
const ADMIN = 'a0000000-0000-0000-0000-000000000001';
const TEACHER = 'b0000000-0000-0000-0000-000000000002';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};

/* --- The database -------------------------------------------------------- */

const psql = (args, input) => execFileSync(PSQL, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args],
  { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });

try { psql(['-d', 'postgres', '-c', 'select 1']); }
catch { console.log('No local PostgreSQL — skipping.'); process.exit(0); }

const CANDIDATES = [
  process.env.CHROME,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].filter(Boolean);
const binary = CANDIDATES.find((p) => fs.existsSync(p));
if (!binary) { console.log('No Chromium found. Set CHROME=/path/to/chrome.'); process.exit(0); }

execFileSync(PSQL.replace(/psql$/, 'dropdb'), ['--if-exists', DB], { stdio: 'ignore' });
execFileSync(PSQL.replace(/psql$/, 'createdb'), [DB], { stdio: 'ignore' });
psql(['-d', DB], `
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique);
  create or replace function auth.uid() returns uuid language sql stable as $fn$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
`);
for (const file of ['0001_schema', '0002_access', '0003_roles', '0004_staff']) {
  psql(['-d', DB, '-f', path.join(ROOT, `supabase/migrations/${file}.sql`)]);
  if (file === '0001_schema') {
    psql(['-d', DB, '-c',
      'grant usage on schema public to anon, authenticated; grant all on all tables in schema public to anon, authenticated;']);
  }
}
psql(['-d', DB], `
  insert into organisations (id, name) values ('${ORG}', 'Northgate High');
  insert into auth.users (id, email) values
    ('${ADMIN}', 'head@northgate.sch.uk'), ('${TEACHER}', 'teacher@northgate.sch.uk');
  insert into memberships (user_id, org_id, role) values
    ('${ADMIN}', '${ORG}', 'owner'), ('${TEACHER}', '${ORG}', 'teacher');
  insert into staff_invites (org_id, email, role) values
    ('${ORG}', 'head@northgate.sch.uk', 'owner'), ('${ORG}', 'teacher@northgate.sch.uk', 'teacher');
`);

const rows = (sql) => JSON.parse(psql(['-d', DB, '-A', '-t', '-c',
  `select coalesce(json_agg(t), '[]')::text from (${sql}) t`]).trim());

/* --- The two servers ----------------------------------------------------- */

process.env.PGDATABASE = DB;
const { start } = await import('./fake-postgrest.mjs');
const api = start(API_PORT);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const appServer = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(`window.QLA_CONFIG = { supabaseUrl: 'http://localhost:${API_PORT}', supabaseAnonKey: 'anon', apiBaseUrl: '', schoolName: '', batchSize: 8 };`);
  }
  const file = path.join(ROOT, p === '/' ? 'index.html' : p.slice(1));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
  res.end(fs.readFileSync(file));
});
appServer.listen(APP_PORT);

const chrome = spawn(binary, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--remote-debugging-port=9222', '--user-data-dir=/tmp/everypupil-teacher-test',
  'about:blank',
], { stdio: 'ignore' });
const stopAll = () => {
  try { chrome.kill(); } catch { /* already gone */ }
  try { api.close(); } catch { /* already closed */ }
  try { appServer.close(); } catch { /* already closed */ }
};
process.on('exit', stopAll);
await sleep(2500);

const page = await connect();

/**
 * Sign in without the sign-in screen. The stand-in accepts "user:<uuid>" as a
 * token, and the code box quite rightly refuses anything that is not digits.
 */
async function signInAs(userId, email) {
  await page.goto(`http://localhost:${APP_PORT}/`);
  await page.evaluate(`(() => {
    localStorage.clear();
    localStorage.setItem('qla.session.v1', JSON.stringify({
      access_token: 'user:${userId}',
      refresh_token: 'refresh:${userId}',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: '${userId}', email: '${email}' },
    }));
    return true;
  })()`);
}

/* --- The admin sets a paper up ------------------------------------------- */

console.log('\n1. An admin sets up an assessment in the app');
await signInAs(ADMIN, 'head@northgate.sch.uk');
await page.goto(`http://localhost:${APP_PORT}/?admin=1#setup`);
try {
  await until(page, `!document.querySelector('#auth-gate') && !!document.querySelector('#exam-name')`, 'the setup page');
} catch (error) {
  console.log('    gate on screen:', await page.evaluate(`(document.querySelector('#auth-title')||{}).textContent||'none'`));
  console.log('    page says:', (await page.evaluate(`document.body.innerText`)).slice(0, 200).replace(/\n/g, ' | '));
  console.log('    booted:', await page.evaluate(`window.__QLA_BOOTED === true`));
  console.log('    requests:', JSON.stringify(api.log.slice(0, 8)));
  throw error;
}
await sleep(600);

// Fill it in the way a person would: type into the fields, do not poke the model.
const fill = async (selector, value) => page.evaluate(`(() => {
  const n = document.querySelector(${JSON.stringify(selector)});
  n.value = ${JSON.stringify(value)};
  n.dispatchEvent(new Event('input', { bubbles: true }));
  n.dispatchEvent(new Event('change', { bubbles: true }));
  return n.value;
})()`);

await fill('#exam-name', 'Biology Paper 1');
await fill('#exam-subject', 'Biology');
await fill('#question-count', '2');
await sleep(400);
await page.evaluate(`(() => {
  const maxes = [...document.querySelectorAll('#questions-body input')];
  return maxes.length;
})()`);
await page.evaluate(`(() => {
  const rows = [...document.querySelectorAll('#questions-body tr')];
  rows.forEach((row, i) => {
    const cells = row.querySelectorAll('input');
    cells[0].value = '0' + (i + 1) + '.1'; cells[0].dispatchEvent(new Event('input', { bubbles: true }));
    cells[1].value = String(i + 3);        cells[1].dispatchEvent(new Event('input', { bubbles: true }));
    cells[2].value = 'Topic ' + (i + 1);   cells[2].dispatchEvent(new Event('input', { bubbles: true }));
  });
  return true;
})()`);
await sleep(300);
await page.evaluate(`(() => {
  document.querySelectorAll('.boundary-list input').forEach((n, i) => {
    n.value = String(i * 2); n.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return true;
})()`);
await sleep(300);
await page.evaluate(`document.querySelector('#btn-add-pupil, #btn-add-pupil-empty').click()`);
await sleep(300);
await page.evaluate(`(() => {
  const row = document.querySelector('#pupils-body tr');
  const cells = row.querySelectorAll('input');
  cells[0].value = 'Ada Khan';           cells[0].dispatchEvent(new Event('input', { bubbles: true }));
  cells[1].value = 'ada@school.invalid'; cells[1].dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(1500);

const assessments = rows('select id, name from assessments');
check('the assessment reached the database', assessments.length === 1, JSON.stringify(assessments));
check('with its questions', rows('select * from questions').length === 2);
check('and its pupil', rows('select * from pupils').length === 1);

// Put the teacher on the paper, through the app's own screen.
await page.evaluate(`document.querySelector('#markers-card').scrollIntoView()`);
await until(page, `document.querySelectorAll('#markers-card input[type=checkbox]:not([disabled])').length > 0`, 'the marker list');
await page.evaluate(`(() => {
  const rows = [...document.querySelectorAll('#markers-card .marker-row')];
  const row = rows.find((r) => /teacher@northgate/.test(r.textContent));
  row.querySelector('input').click();
  return true;
})()`);
await sleep(1200);
check('the teacher was assigned through the app',
  rows(`select * from assessment_teachers where user_id = '${TEACHER}'`).length === 1);

/* --- The teacher marks it ------------------------------------------------ */

console.log('\n2. The teacher signs in on their own machine and enters a mark');
await signInAs(TEACHER, 'teacher@northgate.sch.uk');
await page.goto(`http://localhost:${APP_PORT}/?teacher=1#marksheet`);
await until(page, `!document.querySelector('#auth-gate')`, 'the app to load');
await until(page, `document.querySelectorAll('.mark-input').length > 0`, 'the marksheet');
await sleep(600);

check('the teacher can see the paper', await page.evaluate(`document.querySelectorAll('.mark-input').length >= 2`));

const from = api.log.length;
await page.evaluate(`(() => {
  const n = document.querySelector('.mark-input');
  n.dataset.probe = '1';
  n.focus();
  n.value = '2';
  n.dispatchEvent(new Event('input', { bubbles: true }));
  n.dispatchEvent(new Event('blur', { bubbles: true }));
  return true;
})()`);
await sleep(1600);

const writes = api.writesSince(from);
console.log('    the browser sent:', JSON.stringify(writes));
check('only the marks table was written to', writes.every((w) => w.table === 'marks'),
  writes.map((w) => `${w.method} ${w.table}`).join(', '));

const toast = await page.evaluate(`([...document.querySelectorAll('.toast')].pop()||{}).textContent || ''`);
check('no error was shown to the teacher', !/needs an admin/.test(toast), toast.slice(0, 90));

const stored = rows('select mark from marks');
check('the mark is in the database', stored.length === 1 && Number(stored[0].mark) === 2,
  JSON.stringify(stored));

console.log('\n3. A teacher whose copy has drifted still gets their marks in');
// Something other than the teacher leaves a change in their document — the
// situation that was stopping marks reaching the database at all.
const before2 = api.log.length;
await page.evaluate(`(() => {
  window.__EP_TEST_DRIFT = true;
  const app = document.querySelector('.mark-input');
  return true;
})()`);
await page.evaluate(`(async () => {
  const { state, update } = await import('/js/app.js');
  update((a) => { a.exam.subject = 'Chemistry'; }, { rerender: false });
  return true;
})()`);
await sleep(1200);
await page.evaluate(`(() => {
  const n = document.querySelectorAll('.mark-input')[1];
  n.dataset.probe2 = '1';
  n.focus(); n.value = '1';
  n.dispatchEvent(new Event('input', { bubbles: true }));
  n.dispatchEvent(new Event('blur', { bubbles: true }));
  return true;
})()`);
await sleep(1600);
const driftToast = await page.evaluate(`([...document.querySelectorAll('.toast')].pop()||{}).textContent || ''`);
check('the teacher is not told their marking failed', !/NOT saved/.test(driftToast), driftToast.slice(0, 90));
check('the second mark reached the database', rows('select * from marks').length === 2,
  JSON.stringify(rows('select mark from marks')));
check('and the drift was not written', rows('select subject from assessments')[0].subject === 'Biology',
  JSON.stringify(rows('select subject from assessments')));

console.log('\n4. The admin sees it');
await signInAs(ADMIN, 'head@northgate.sch.uk');
await page.goto(`http://localhost:${APP_PORT}/?admin=2#marksheet`);
await until(page, `document.querySelectorAll('.mark-input').length > 0`, 'the marksheet');
await sleep(500);
const seen = await page.evaluate(`document.querySelector('.mark-input').value`);
check("the teacher's mark is there when the admin opens it", seen === '2', `admin sees "${seen}"`);

console.log('\n5. The connection check page');
// Give it an empty cell to test with: both cells on this paper are marked.
psql(['-d', DB], `
  with p as (insert into pupils (org_id, name, email) values ('${ORG}', 'Cara Diaz', 'cara@school.invalid') returning id)
  insert into assessment_pupils (assessment_id, pupil_id, position)
  select (select id from assessments limit 1), id, 1 from p;
`);
await page.goto(`http://localhost:${APP_PORT}/diagnose.html`);
await until(page, `document.querySelectorAll('#steps .step').length >= 7`, 'the checks to finish', 15000);
await sleep(500);
const report = await page.evaluate(`document.querySelector('#report').value`);
console.log(report.split('\n').map((l) => '    ' + l).join('\n'));
check('every check passes on a working setup', !/^FAIL/m.test(report));
check('it names the school', /Northgate High/.test(report));
check('it proves a write reaches the database', /written and read back/.test(report));
check('and it puts the test mark back', /as you left it/.test(report));
check('the paper is unchanged afterwards', rows('select * from marks').length === 2,
  JSON.stringify(rows('select mark from marks')));

console.log(`\n${pass} passed, ${fail} failed`);
page.close();
stopAll();
process.exit(fail === 0 ? 0 : 1);
