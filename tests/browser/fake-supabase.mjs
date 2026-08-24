/**
 * A stand-in for Supabase, so the sign-in screen can be driven in a real
 * browser without a real project, real email, or a real teacher's inbox.
 *
 * It serves the actual app files, and answers the three endpoints sign-in
 * uses: send a code, verify a code, and ask which school the account belongs
 * to. Started for you by tests/browser/sign-in.test.mjs.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// The real app, served from the repository root.
const ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const PORT = 5300;

const STAFF = {
  'a.teacher@northgate.sch.uk': { school_id: 'org-1', school_name: 'Northgate High', member_role: 'teacher' },
  'alice@northgate.sch.uk': { school_id: 'org-1', school_name: 'Northgate High', member_role: 'owner' },
  'nobody@northgate.sch.uk': null,          // signed in, but no school
};
let otpCount = 0;

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.csv':'text/csv' };

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const p = url.pathname;
    const payload = body ? JSON.parse(body) : null;

    if (p === '/auth/v1/otp') {
      otpCount += 1;
      const email = String(payload.email || '');
      if (!(email in STAFF)) {
        return send(403, { msg: "That address is not on your school's staff list. Ask whoever set up EveryPupil at your school to add it." });
      }
      if (email === 'ratelimited@northgate.sch.uk') {
        return send(429, { msg: 'For security purposes, you can only request this after 41 seconds.' });
      }
      return send(200, {});
    }

    if (p === '/auth/v1/verify') {
      if (payload.token !== '123456') return send(403, { msg: 'Token has expired or is invalid' });
      return send(200, {
        access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600,
        user: { id: 'user-1', email: payload.email },
      });
    }

    if (p === '/auth/v1/logout') return send(204, {});

    if (p === '/rest/v1/rpc/claim_membership') {
      const auth = req.headers.authorization || '';
      if (!auth.includes('access-token')) return send(401, { msg: 'JWT expired' });
      const email = globalThis.__signedInAs;
      const row = STAFF[email];
      return send(200, row ? [row] : []);
    }

    // config.js points the app at this stub instead of the real project.
    if (p === '/config.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end(`window.QLA_CONFIG = { supabaseUrl: 'http://localhost:${PORT}', supabaseAnonKey: 'anon-key', apiBaseUrl: '', schoolName: '', batchSize: 60 };`);
    }

    const file = path.join(ROOT, p === '/' ? 'index.html' : p.replace(/^\//, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
    res.end(fs.readFileSync(file));
  });
});

// The stub needs to know which address verified, to answer claim_membership.
const originalEmitter = server.listeners('request')[0];
server.removeAllListeners('request');
server.on('request', (req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  const onEnd = () => {
    if (req.url === '/auth/v1/verify' && raw) {
      try { globalThis.__signedInAs = JSON.parse(raw).email; } catch { /* ignore */ }
    }
  };
  req.on('end', onEnd);
  originalEmitter(req, res);
});

server.listen(PORT, () => console.log('stub on ' + PORT));
