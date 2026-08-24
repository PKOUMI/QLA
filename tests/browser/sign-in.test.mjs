/**
 * The sign-in screen, driven in a real browser.
 *
 *   node tests/browser/sign-in.test.mjs
 *
 * Needs Chromium and nothing else — no test framework, no npm packages. Set
 * CHROME to the browser binary if it is not in one of the usual places.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { connect, until, sleep } from './cdp.mjs';

/* --- Start Chromium and the fake Supabase -------------------------------- */

const CANDIDATES = [
  process.env.CHROME,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].filter(Boolean);

const binary = CANDIDATES.find((p) => fs.existsSync(p));
if (!binary) {
  console.log('No Chromium found. Set CHROME=/path/to/chrome and run again.');
  process.exit(0);      // not a failure: this machine simply cannot run it
}

const stub = spawn(process.execPath, [new URL('./fake-supabase.mjs', import.meta.url).pathname], { stdio: 'ignore' });
const chrome = spawn(binary, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--remote-debugging-port=9222', '--user-data-dir=/tmp/everypupil-browser-test',
  'about:blank',
], { stdio: 'ignore' });

const stopAll = () => { try { chrome.kill(); } catch {} try { stub.kill(); } catch {} };
process.on('exit', stopAll);

await sleep(2500);

const APP = 'http://localhost:5300/';
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};

const page = await connect();

const text = (sel) => page.evaluate(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent || ''`);
const visible = (sel) => page.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return false; const s = getComputedStyle(n); return s.display !== 'none' && s.visibility !== 'hidden'; })()`);
const type = (sel, value) => page.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); n.value = ${JSON.stringify(value)}; n.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText'})); return true; })()`);
const paste = (sel, value) => page.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); n.value = ${JSON.stringify(value)}; n.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertFromPaste'})); return true; })()`);
const submit = (sel) => page.evaluate(`(() => { document.querySelector(${JSON.stringify(sel)}).requestSubmit(); return true; })()`);
const err = () => page.evaluate(`(() => { const n = document.querySelector('#auth-error'); return n && !n.hidden ? n.textContent : ''; })()`);

console.log('\n1. A fresh visitor is stopped at the door');
await page.goto(APP);
await page.evaluate('localStorage.clear()');
await page.goto(APP);
await until(page, `!!document.querySelector('#auth-gate')`, 'the sign-in screen');
check('the sign-in screen is shown', (await text('#auth-title')).includes('Sign in'));
check('the app itself is hidden underneath', !(await visible('.app-main')));
check('the workflow header is hidden too', !(await visible('.app-header')));

console.log('\n2. The boot guard does not fire while somebody waits for a code');
check('the app reports that it loaded', await page.evaluate('window.__QLA_BOOTED === true'));

console.log('\n3. A typo is caught before the network is touched');
await type('#auth-email', 'alice@northgate');
await submit('.auth-form');
await sleep(200);
check('a malformed address is refused locally', (await err()).includes('school email address'));

console.log('\n4. An address that is not on the staff list');
await type('#auth-email', 'stranger@example.com');
await submit('.auth-form');
await until(page, `(() => { const n = document.querySelector('#auth-error'); return n && !n.hidden && /staff list/.test(n.textContent); })()`, 'the refusal');
const refusal = await err();
check("the school's own wording is shown", refusal.includes('staff list'), refusal);
check('it says who to ask', /ask whoever set up/i.test(refusal), refusal);
check('the button is usable again', await page.evaluate(`!document.querySelector('.auth-form button[type=submit]').disabled`));

console.log('\n5. An invited teacher gets to the code screen');
await type('#auth-email', 'Alice@Northgate.sch.uk ');
await submit('.auth-form');
await until(page, `/Check your email/.test(document.querySelector('#auth-title').textContent)`, 'the code screen');
check('the address is echoed back, normalised', (await text('#auth-sent-to')).includes('alice@northgate.sch.uk'));
check('resend is on a countdown, not simply broken', /Send another code in \d+s/.test(await text('.auth-link')));

console.log('\n6. A wrong code');
await paste('#auth-code', '00000000');
await until(page, `(() => { const n = document.querySelector('#auth-error'); return n && !n.hidden; })()`, 'the wrong-code message');
const wrong = await err();
check('it blames the code, not the address', /code is wrong or has expired/.test(wrong), wrong);
check('it does not mention the staff list', !/staff list/.test(wrong));

console.log('\n7. The code box does not assume six digits');
await type('#auth-code', '12ab34');
check('letters are stripped', (await page.evaluate(`document.querySelector('#auth-code').value`)) === '1234');
await type('#auth-code', '12345678');
check('an eight-digit code fits', (await page.evaluate(`document.querySelector('#auth-code').value`)) === '12345678');
// Typing must not fire a verify request at six digits: on a project whose
// codes are eight digits long that would spend an attempt on a truncated one.
await type('#auth-code', '123456');
await sleep(400);
check('typing six digits does not sign anybody in',
  await page.evaluate(`/Check your email/.test(document.querySelector('#auth-title').textContent)`));
check('and does not clear the box or move on',
  (await page.evaluate(`document.querySelector('#auth-code').value`)) === '123456');
await type('#auth-code', '1234');
await submit('.auth-form');
await sleep(200);
check('a half-typed code is caught before it costs an attempt', /too short/.test(await err()), await err());

console.log('\n8. The right code signs the teacher in');
await paste('#auth-code', '12345678');
await until(page, `!document.querySelector('#auth-gate')`, 'the gate to close');
check('the sign-in screen has gone', !(await page.evaluate(`!!document.querySelector('#auth-gate')`)));
check('the app is visible', await visible('.app-main'));
check('the school name is in the header', (await text('#who')).includes('Northgate High'));
check('the signed-in address is in the header', (await text('#who')).includes('alice@northgate.sch.uk'));

console.log('\n9. Coming back tomorrow');
await page.goto(APP);
await sleep(1200);
check('no second sign-in is demanded', !(await page.evaluate(`!!document.querySelector('#auth-gate')`)));
check('the school is still shown', (await text('#who')).includes('Northgate High'));

console.log('\n10. Signing out');
await page.evaluate(`document.querySelector('#who button').click()`);
await sleep(1500);
await until(page, `!!document.querySelector('#auth-gate')`, 'the gate to return');
check('the sign-in screen is back', (await text('#auth-title')).includes('Sign in'));
check('the stored session is gone', await page.evaluate(`localStorage.getItem('qla.session.v1') === null`));

console.log('\n11. Signed in, but nobody has linked the account to a school');
await type('#auth-email', 'nobody@northgate.sch.uk');
await submit('.auth-form');
await until(page, `/Check your email/.test(document.querySelector('#auth-title').textContent)`, 'the code screen');
await paste('#auth-code', '12345678');
await until(page, `/Almost there/.test((document.querySelector('#auth-title')||{}).textContent || '')`, 'the no-school screen');
check('it does not look like a rejection', /Almost there/.test(await text('#auth-title')));
check('it says nothing is wrong with the account', /Nothing is wrong with your account/.test(await text('.auth-gate')));
check('the app stays hidden', !(await visible('.app-main')));

console.log(`\n${pass} passed, ${fail} failed`);
page.close();
stopAll();
process.exit(fail === 0 ? 0 : 1);
