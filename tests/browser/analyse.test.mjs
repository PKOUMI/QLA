/**
 * The analyse page, driven in a real browser against real sample data.
 *
 *   node tests/browser/analyse.test.mjs
 *
 * This exists because the mark distribution is the one chart a teacher changes
 * the shape of. A bar width that is silently ignored, or one that draws a
 * chart of hairlines, is worse than not offering the choice at all.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { connect, until, sleep } from './cdp.mjs';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const PORT = 5314;

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
  '--remote-debugging-port=9224', '--user-data-dir=/tmp/everypupil-analyse-test',
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

const page = await connect(9224);
const sample = fs.readFileSync(path.join(ROOT, 'sample-data/gcse-science-paper-90-pupils.json'), 'utf8');

await page.goto(`http://localhost:${PORT}/`);
await page.evaluate(`(() => {
  const parsed = JSON.parse(${JSON.stringify(sample)});
  localStorage.setItem('qla.assessments.v1', JSON.stringify({ [parsed.id]: parsed }));
  localStorage.setItem('qla.currentAssessmentId.v1', parsed.id);
  return true;
})()`);
await page.goto(`http://localhost:${PORT}/?run=1#analyse`);
await until(page, `document.querySelector('#card-spread .viz-bar') !== null`, 'the mark distribution');
await sleep(300);

const bars = () => page.evaluate(`document.querySelectorAll('#card-spread .viz-bar').length`);
const tips = () => page.evaluate(
  `[...document.querySelectorAll('#card-spread .viz-bar')].map((b) => (b.querySelector('title')||{}).textContent || b.getAttribute('aria-label') || '')`,
);
const chooseWidth = async (value) => {
  await page.evaluate(`(() => {
    const select = document.querySelector('#mark-bin-size');
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
  await until(page, `document.querySelector('#card-spread .viz-bar') !== null`, 'the redrawn chart');
  await sleep(250);
};

console.log('\n1. The control is there and describes the paper');
const control = await page.evaluate(`(() => {
  const select = document.querySelector('#mark-bin-size');
  if (!select) return null;
  return { options: [...select.options].map((o) => o.value), value: select.value };
})()`);
check('a bar width control exists', control !== null);
check('it offers automatic', control && control.options[0] === 'auto', JSON.stringify(control));
check('it starts on automatic', control && control.value === 'auto', JSON.stringify(control));
check('it offers something narrower than automatic',
  control && control.options.length > 2, JSON.stringify(control));

const autoBars = await bars();
check('the automatic chart draws a readable number of bars',
  autoBars > 0 && autoBars <= 14, `${autoBars} bars`);

console.log('\n2. Choosing a narrower bar actually redraws the chart');
const narrowest = control.options[1];
await chooseWidth(narrowest);
const narrowBars = await bars();
check(`bars of ${narrowest} give more of them than automatic`, narrowBars > autoBars,
  `${narrowBars} bars at width ${narrowest}, ${autoBars} on automatic`);
check('and the chart is still bars, not hairlines', narrowBars <= 80, `${narrowBars} bars`);

const narrowTips = await tips();
check('each bar still says how many pupils it holds',
  narrowTips.length > 0 && narrowTips.every((t) => /pupils?/.test(t)), narrowTips[0]);
if (narrowest === '1') {
  check('a one mark bar reads as a single mark, not a range',
    narrowTips.every((t) => !/–/.test(t)), narrowTips[0]);
}

console.log('\n3. The choice is remembered with the assessment');
await sleep(900); // saving is debounced, and this reads what was actually saved
const saved = await page.evaluate(`(() => {
  const doc = Object.values(JSON.parse(localStorage.getItem('qla.assessments.v1')))[0];
  return doc.settings?.analyse?.markBinSize ?? null;
})()`);
check('the width is saved', String(saved) === narrowest, `saved: ${JSON.stringify(saved)}`);

await page.goto(`http://localhost:${PORT}/?run=1#analyse`);
await until(page, `document.querySelector('#mark-bin-size') !== null`, 'the reloaded page');
await sleep(300);
const afterReload = await page.evaluate(`document.querySelector('#mark-bin-size').value`);
check('and survives a reload', afterReload === narrowest, `select shows ${afterReload}`);
check('with the same number of bars', (await bars()) === narrowBars);

console.log('\n4. Going back to automatic restores the tidy version');
await chooseWidth('auto');
check('automatic draws what it drew before', (await bars()) === autoBars,
  `${await bars()} now, ${autoBars} before`);

console.log('\n5. The card says how wide the bars are');
const hint = await page.evaluate(`document.querySelector('#card-spread .muted').textContent`);
check('the hint names the bar width', /bar covers \d+ marks?/.test(hint), hint);

console.log(`\n${pass} passed, ${fail} failed`);
page.close();
stopAll();
process.exit(fail === 0 ? 0 : 1);
