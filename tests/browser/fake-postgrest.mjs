/**
 * A stand-in for PostgREST that runs the real thing underneath.
 *
 * It speaks the small slice of the PostgREST protocol this app uses, and
 * translates each request into SQL that it executes against a local PostgreSQL
 * database through `psql` — as the `authenticated` role, with the signed-in
 * user's id set the way Supabase sets it.
 *
 * The point is what that makes testable. A mock that returns whatever the test
 * wants proves the client can parse JSON. This runs the actual policies from
 * supabase/migrations, so "a teacher cannot change the paper" is answered by
 * Postgres rather than by me.
 *
 * The HTTP layer is a stand-in. The database is not.
 */

import http from 'node:http';
import { execFileSync } from 'node:child_process';

const PSQL = process.env.PSQL || '/usr/lib/postgresql/16/bin/psql';
const DB = process.env.PGDATABASE || 'epstore';
const PORT = Number(process.env.PGRST_PORT || 5401);

/* --- Running SQL --------------------------------------------------------- */

export class SqlError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function statusFor(text) {
  if (/row-level security/i.test(text)) return 403;
  if (/duplicate key|unique constraint/i.test(text)) return 409;
  if (/permission denied/i.test(text)) return 401;
  if (/violates foreign key/i.test(text)) return 409;
  return 400;
}

/** @param {string|null} userId  null means signed out. */
function runSql(sql, userId, role = 'authenticated') {
  // The preamble is written so that it prints NOTHING: a DO block and SET both
  // produce no rows. That matters because json_agg puts a newline between
  // array elements, so the result is routinely several lines long and cannot
  // be picked out by taking the last one.
  const preamble = role === 'service'
    ? ''
    : `do $do$ begin perform set_config('request.jwt.claim.sub', '${userId || ''}', false); end $do$; set role ${role};`;
  try {
    const out = execFileSync(PSQL, [
      '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1',
      '-d', DB, '-c', `${preamble} ${sql}`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.trim();
  } catch (error) {
    const text = String(error.stderr || error.message);
    throw new SqlError(text.replace(/\s+/g, ' ').trim(), statusFor(text));
  }
}

/* --- Turning a PostgREST request into SQL -------------------------------- */

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const ident = (value) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new SqlError(`bad identifier: ${value}`, 400);
  return value;
};

/** `col=eq.x` and `col=in.("a","b")`. */
function whereFrom(params) {
  const clauses = [];
  for (const [key, raw] of params) {
    if (['select', 'order', 'limit', 'on_conflict'].includes(key)) continue;
    if (raw.startsWith('eq.')) {
      clauses.push(`${ident(key)} = ${quote(raw.slice(3))}`);
    } else if (raw.startsWith('in.(')) {
      const inner = raw.slice(4, raw.lastIndexOf(')'));
      const values = (inner.match(/"((?:[^"\\]|\\.)*)"/g) || [])
        .map((v) => v.slice(1, -1).replace(/\\"/g, '"'));
      if (!values.length) return ['false'];
      clauses.push(`${ident(key)} in (${values.map(quote).join(',')})`);
    } else {
      throw new SqlError(`unsupported filter: ${key}=${raw}`, 400);
    }
  }
  return clauses;
}

const asJson = (sql) => `select coalesce(json_agg(t), '[]'::json)::text from (${sql}) t`;
// A data-modifying statement cannot be a subquery, so RETURNING has to come
// back through a CTE.
const asJsonFromDml = (sql) => `with changed as (${sql}) select coalesce(json_agg(t), '[]'::json)::text from changed t`;
const dollars = (json) => `$qla$${json}$qla$`;

function selectSql(table, params) {
  const where = whereFrom(params);
  let sql = `select * from ${ident(table)}`;
  if (where.length) sql += ` where ${where.join(' and ')}`;

  const order = params.get('order');
  if (order) {
    const [column, direction] = order.split('.');
    sql += ` order by ${ident(column)} ${direction === 'desc' ? 'desc' : 'asc'}`;
  }
  const limit = params.get('limit');
  if (limit) sql += ` limit ${Number(limit)}`;
  return asJson(sql);
}

function insertSql(table, rows, params, prefer) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].map(ident);
  const list = columns.join(', ');
  // json_populate_recordset gives each value the column's real type, so a
  // jsonb column stays jsonb and a numeric stays numeric.
  let sql = `insert into ${ident(table)} (${list})
             select ${list} from json_populate_recordset(null::${ident(table)}, ${dollars(JSON.stringify(rows))})`;

  const conflict = params.get('on_conflict');
  if (conflict && /merge-duplicates/.test(prefer)) {
    const keys = conflict.split(',').map(ident);
    const updates = columns.filter((c) => !keys.includes(c)).map((c) => `${c} = excluded.${c}`);
    sql += ` on conflict (${keys.join(', ')}) do update set ${updates.join(', ')}`;
  } else if (conflict) {
    sql += ` on conflict (${conflict.split(',').map(ident).join(', ')}) do nothing`;
  }

  if (/return=representation/.test(prefer)) {
    return asJsonFromDml(`${sql} returning *`);
  }
  return `${sql}`;
}

function updateSql(table, changes, params) {
  const where = whereFrom(params);
  if (!where.length) throw new SqlError('refusing an update with no filter', 400);
  const columns = Object.keys(changes).map(ident);
  const sql = `update ${ident(table)} set (${columns.join(', ')}) =
      (select ${columns.join(', ')} from json_populate_record(null::${ident(table)}, ${dollars(JSON.stringify(changes))}))
     where ${where.join(' and ')} returning *`;
  return asJsonFromDml(sql);
}

/** POST /rest/v1/rpc/<name> with the arguments as a JSON object. */
function rpcSql(name, args) {
  const named = Object.entries(args || {})
    .map(([key, value]) => `${ident(key)} => ${value === null ? 'null' : quote(value)}`);
  return asJson(`select * from ${ident(name)}(${named.join(', ')})`);
}

function deleteSql(table, params) {
  const where = whereFrom(params);
  if (!where.length) throw new SqlError('refusing a delete with no filter', 400);
  return `delete from ${ident(table)} where ${where.join(' and ')}`;
}

/* --- The server ---------------------------------------------------------- */

export function start(port = PORT) {
  /** Every request, so a test can assert that one changed mark sent one row
   *  rather than the whole marksheet. */
  const log = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const send = (code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };

      // Supabase puts the user id in a signed JWT. Here the test simply says
      // who it is: "Bearer user:<uuid>", or "Bearer service" for setup.
      const auth = String(req.headers.authorization || '');
      const asService = /Bearer service/.test(auth);
      const match = /Bearer user:([0-9a-f-]{36})/.exec(auth);
      const userId = match ? match[1] : null;
      const role = asService ? 'service' : (userId ? 'authenticated' : 'anon');

      const parts = url.pathname.split('/').filter(Boolean);   // rest v1 <table>

      // Standing in for GoTrue, so the test can sign in as a particular person
      // through the app's own code rather than by poking at its internals.
      // The "code" is simply the user's uuid.
      if (parts[0] === 'auth') {
        if (parts[2] === 'verify') {
          const id = String(JSON.parse(body || '{}').token || '').trim();
          return send(200, {
            access_token: `user:${id}`, refresh_token: `refresh:${id}`, expires_in: 3600,
            user: { id, email: JSON.parse(body).email },
          });
        }
        if (parts[2] === 'logout') return send(204, '');
        if (parts[2] === 'otp') return send(200, {});
        return send(404, { message: 'not found' });
      }

      log.push({ method: req.method, table: parts[2], rows: req.method === 'GET' ? 0 : (JSON.parse(body || 'null')?.length ?? 1) });
      if (parts[0] !== 'rest' || parts[1] !== 'v1') return send(404, { message: 'not found' });
      const table = parts[2];
      const prefer = String(req.headers.prefer || '');

      try {
        let sql;
        if (table === 'rpc') sql = rpcSql(parts[3], JSON.parse(body || '{}'));
        else if (req.method === 'GET') sql = selectSql(table, url.searchParams);
        else if (req.method === 'POST') sql = insertSql(table, JSON.parse(body), url.searchParams, prefer);
        else if (req.method === 'PATCH') sql = updateSql(table, JSON.parse(body), url.searchParams);
        else if (req.method === 'DELETE') sql = deleteSql(table, url.searchParams);
        else return send(405, { message: 'method not allowed' });

        const out = runSql(sql, userId, role);
        if (table === 'rpc') return send(200, out || '[]');
        if (req.method === 'DELETE') return send(204, '');
        if (!/return=representation/.test(prefer) && req.method === 'POST') return send(201, '[]');
        return send(req.method === 'POST' ? 201 : 200, out || '[]');
      } catch (error) {
        return send(error.status || 500, { message: error.message });
      }
    });
  });

  server.listen(port);
  server.log = log;
  server.writesSince = (from) => log.slice(from).filter((entry) => entry.method !== 'GET');
  return server;
}

if (process.argv[1] && process.argv[1].endsWith('fake-postgrest.mjs')) {
  start();
  console.log(`fake postgrest on ${PORT}, database ${DB}`);
}
