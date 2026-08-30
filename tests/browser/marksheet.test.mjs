/**
 * The marksheet, driven in a real browser against real sample data.
 *
 *   node tests/browser/marksheet.test.mjs
 *
 * This exists for one reason: a mark that is wrong must never end up looking
 * like a mark somebody entered on purpose, because that number goes to a child
 * in an email.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { connect, until, sleep } from './cdp.mjs';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const PORT = 5312;

const CANDIDATES = [
  process.env.CHROME,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].filter(Boolean);
const binary = CANDIDATES.find((p) => fs.existsSync(p));
if (!binary) {
  console.log('No Chromium found. Set CHROME=/path/to/chrome and run again.');
  process.exit(0);
}

// Served with no database configured, so the app runs browser-only and the
// sample assessment can be dropped straight into localStorage.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end('window.QLA_CONFIG = {};');
  }
  const file = path.join(ROOT, p === '/' ? 'index.html' : p.slice(1));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
  res.end(fs.readFileSync(file));
});
server.listen(PORT);

const chrome = spawn(binary, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--remote-debugging-port=9222', '--user-data-dir=/tmp/everypupil-marksheet-test',
  'about:blank',
], { stdio: 'ignore' });
const stopAll = () => { try { chrome.kill(); } catch {} try { server.close(); } catch {} };
process.on('exit', stopAll);
await sleep(2500);

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};

const page = await connect();
const sample = fs.readFileSync(path.join(ROOT, 'sample-data/gcse-science-paper-90-pupils.json'), 'utf8');

await page.goto(`http://localhost:${PORT}/`);
await page.evaluate(`(() => {
  const parsed = JSON.parse(${JSON.stringify(sample)});
  localStorage.setItem('qla.assessments.v1', JSON.stringify({ [parsed.id]: parsed }));
  localStorage.setItem('qla.currentAssessmentId.v1', parsed.id);
  return true;
})()`);
await page.goto(`http://localhost:${PORT}/?run=1#marksheet`);
await until(page, `document.querySelectorAll('.mark-input').length > 0`, 'the marksheet');
await sleep(400);

/** The stored mark, read from the saved document rather than from the screen. */
const storedMark = () => page.evaluate(`(() => {
  const doc = Object.values(JSON.parse(localStorage.getItem('qla.assessments.v1')))[0];
  const n = document.querySelector('[data-probe]');
  return doc.marks[n.dataset.pupil]?.[n.dataset.question] ?? null;
})()`);

const setup = await page.evaluate(`(() => {
  const target = [...document.querySelectorAll('.mark-input')].find((i) => Number(i.max) >= 3);
  if (!target) return null;
  target.dataset.probe = '1';
  return { max: Number(target.max) };
})()`);
check('found a question worth more than one mark', setup !== null);

const typeInto = (text) => page.evaluate(`(() => {
  const n = document.querySelector('[data-probe]');
  n.focus();
  n.value = ${JSON.stringify(text)};
  n.dispatchEvent(new Event('input', { bubbles: true }));
  return n.value;
})()`);
const leaveCell = async () => {
  await page.evaluate(`document.querySelector('[data-probe]').dispatchEvent(new Event('blur', { bubbles: true }))`);
  // Saving is debounced by 500ms, and these checks read what was actually
  // saved rather than what is on screen. Waiting less would test nothing.
  await sleep(900);
};
const boxValue = () => page.evaluate(`document.querySelector('[data-probe]').value`);

console.log(`\n1. A mark that is too big (question is out of ${setup.max})`);
await typeInto('2');
await leaveCell();
check('a valid mark is accepted first', (await boxValue()) === '2');

await typeInto('33');
await leaveCell();
check('the box is left blank, not corrected', (await boxValue()) === '', `box shows "${await boxValue()}"`);
check('and the earlier mark is not silently restored', (await boxValue()) !== '2');
check('nothing is stored for that cell either', (await storedMark()) === null,
  `stored: ${JSON.stringify(await storedMark())}`);

console.log('\n2. It says what happened, in terms of the number that was typed');
await typeInto('33');
await leaveCell();
// The most recent toast: the welcome message from start-up is still on screen.
const toastText = await page.evaluate(`([...document.querySelectorAll('.toast')].pop()||{}).textContent || ''`);
check('the message quotes the number typed', /33/.test(toastText), toastText.slice(0, 80));
check('and says how many marks the question is worth', new RegExp(`${setup.max} marks`).test(toastText), toastText.slice(0, 80));
check('and says the box was left blank', /left blank/.test(toastText), toastText.slice(0, 80));

console.log('\n3. Other impossible marks behave the same way');
for (const [value, what] of [['-2', 'a negative mark'], ['1.25', 'a quarter mark'], ['abc', 'letters']]) {
  await typeInto(value);
  await leaveCell();
  check(`${what} leaves the box blank`, (await boxValue()) === '', `box shows "${await boxValue()}"`);
  check(`${what} stores nothing`, (await storedMark()) === null);
}

console.log('\n4. Zero is a real mark and must survive all of this');
await typeInto('0');
await leaveCell();
check('a zero stays in the box', (await boxValue()) === '0');
check('and is stored as zero, not as blank', (await storedMark()) === 0,
  `stored: ${JSON.stringify(await storedMark())}`);

console.log('\n5. Half marks are still allowed');
await typeInto('1.5');
await leaveCell();
check('one and a half is accepted', (await boxValue()) === '1.5');
check('and stored', (await storedMark()) === 1.5);

console.log('\n6. The wheel scrolls the page, it does not change marks');
await typeInto('2');
await leaveCell();
check('a mark is in place to be disturbed', (await boxValue()) === '2');

const wheeled = await page.evaluate(`(() => {
  const n = document.querySelector('[data-probe]');
  n.focus();
  const before = n.value;
  const event = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });
  n.dispatchEvent(event);
  return { before, after: n.value, prevented: event.defaultPrevented };
})()`);
check('the wheel is refused over a focused mark box', wheeled.prevented === true);
check('and the mark is unchanged', wheeled.after === wheeled.before, JSON.stringify(wheeled));
await sleep(700);
check('and nothing was written to storage', (await storedMark()) === 2,
  `stored: ${JSON.stringify(await storedMark())}`);

console.log('\n7. Enter finishes the pupil; the down arrow moves down a column');

/** Press a key on a chosen cell and report where the focus ended up. */
const pressOn = (row, col, key, shift = false) => page.evaluate(`(() => {
  const from = document.querySelector('.mark-input[data-row="${row}"][data-col="${col}"]');
  if (!from) return { error: 'no such cell' };
  from.focus();
  const event = new KeyboardEvent('keydown', {
    key: ${JSON.stringify(key)}, shiftKey: ${shift}, bubbles: true, cancelable: true,
  });
  from.dispatchEvent(event);
  const now = document.activeElement;
  return {
    row: Number(now.dataset.row), col: Number(now.dataset.col),
    prevented: event.defaultPrevented,
  };
})()`);

const rows = await page.evaluate(`document.querySelectorAll('#marksheet-body tr').length`);
const cols = await page.evaluate(`document.querySelectorAll('#marksheet-body tr:first-child .mark-input').length`);
check('the grid has several pupils and several questions', rows > 2 && cols > 2, `${rows} x ${cols}`);

const entered = await pressOn(1, 2, 'Enter');
check('Enter lands on the next pupil', entered.row === 2, JSON.stringify(entered));
check('and on that pupil first question, not the column it started in',
  entered.col === 0, JSON.stringify(entered));
check('and the browser default is stopped', entered.prevented === true);

const back = await pressOn(2, 0, 'Enter', true);
check('Shift and Enter goes back to the pupil above', back.row === 1 && back.col === 0,
  JSON.stringify(back));

const down = await pressOn(1, 2, 'ArrowDown');
check('the down arrow still moves down its own column', down.row === 2 && down.col === 2,
  JSON.stringify(down));

const last = await pressOn(rows - 1, 1, 'Enter');
check('Enter on the last pupil stays put rather than losing focus',
  last.row === rows - 1 && last.col === 1, JSON.stringify(last));
check('and does not swallow the key when there is nowhere to go',
  last.prevented === false, JSON.stringify(last));

const first = await pressOn(0, 1, 'Enter', true);
check('Shift and Enter on the first pupil stays put too',
  first.row === 0 && first.col === 1, JSON.stringify(first));

console.log(`\n${pass} passed, ${fail} failed`);
page.close();
stopAll();
process.exit(fail === 0 ? 0 : 1);
