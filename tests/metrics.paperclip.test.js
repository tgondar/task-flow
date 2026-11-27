#!/usr/bin/env node
// Functional tests for metrics.js `paperclipGet` (plan T11, spec RF-042, RF-060): the one bounded,
// read-only request to paperclip's API. Every case runs against a local http.createServer on
// 127.0.0.1 - never the real API - whose origin is confirmed with config.js `trustPaperclipUrl`
// in a temporary HOME. Each failure must come back as its own closed code, and a request that is
// not allowed (origin not confirmed, no token) must never leave the process: the server is asked
// how many requests it saw.
//
// Run: node tests/metrics.paperclip.test.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-paperclip-'));
for (const name of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_STATE_HOME']) process.env[name] = TEMP;
delete process.env.TASK_FLOW_METRICS;

const { paperclipGet, CONSTANTS } = require(path.join(__dirname, '..', 'plugin', 'scripts', 'metrics.js'));
const { trustPaperclipUrl } = require(path.join(__dirname, '..', 'plugin', 'scripts', 'config.js'));

const PROJECT = fs.mkdtempSync(path.join(TEMP, 'project-'));
const TOKEN = 'test-token-T11-do-not-echo';
const ENV = { PAPERCLIP_TOKEN: TOKEN };

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; process.stdout.write(`  ok    ${name}\n`); } else { failures.push(name); process.stdout.write(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}\n`); }
}

/** A local server whose handler is swapped per case; it counts and keeps the requests it saw. */
function startServer() {
  const seen = [];
  let handler = (req, res) => { res.end('{}'); };
  const server = http.createServer((req, res) => { seen.push({ method: req.method, url: req.url, auth: req.headers.authorization }); handler(req, res); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, seen, url: `http://127.0.0.1:${server.address().port}`, handle: (fn) => { handler = fn; seen.length = 0; },
  })));
}

const shape = (r) => JSON.stringify(r && { ok: r.ok, code: r.code, body: r.body === null ? null : typeof r.body });

async function main() {
  const s = await startServer();
  trustPaperclipUrl(PROJECT, s.url);
  const get = (extra) => paperclipGet({ projectDir: PROJECT, url: s.url, pathname: '/api/issues/abc/runs', env: ENV, ...extra });

  check('constants: 10 s timeout and a 1 MiB body cap', CONSTANTS.PAPERCLIP_TIMEOUT_MS === 10000 && CONSTANTS.PAPERCLIP_MAX_BODY_BYTES === 1024 * 1024);

  s.handle((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('[{"runId":"r1","status":"succeeded"}]'); });
  let r = await get();
  check('200 with JSON: ok, the parsed body', r.ok === true && r.code === 'ok' && Array.isArray(r.body) && r.body[0].runId === 'r1', shape(r));
  check('the request is one GET of the pathname, with the bearer token', s.seen.length === 1 && s.seen[0].method === 'GET' && s.seen[0].url === '/api/issues/abc/runs' && s.seen[0].auth === `Bearer ${TOKEN}`, JSON.stringify(s.seen.map((x) => [x.method, x.url])));

  s.handle((req, res) => res.end('{"a":1}'));
  r = await get({ pathname: '/api/companies/c1/issues?parentId=p1' });
  check('a query string in the pathname is kept', r.ok === true && s.seen[0].url === '/api/companies/c1/issues?parentId=p1', shape(r));

  const other = fs.mkdtempSync(path.join(TEMP, 'other-'));
  s.handle((req, res) => res.end('{}'));
  r = await paperclipGet({ projectDir: other, url: s.url, pathname: '/api/x', env: ENV });
  check('origin not confirmed for this project: untrusted-url, no request', !r.ok && r.code === 'untrusted-url' && r.body === null && s.seen.length === 0, shape(r));

  r = await get({ env: {} });
  check('no PAPERCLIP_TOKEN: no-token, no request', !r.ok && r.code === 'no-token' && s.seen.length === 0, shape(r));
  r = await get({ env: { PAPERCLIP_TOKEN: '' } });
  check('empty PAPERCLIP_TOKEN: no-token, no request', !r.ok && r.code === 'no-token' && s.seen.length === 0, shape(r));

  for (const pathname of ['/api/../x', '/api/%2e%2e/x', 'api/x', '/other/x', '//evil.example/api/x', '/api/x#frag', '/api/a b', 42]) {
    r = await get({ pathname }); // eslint-disable-line no-await-in-loop
    check(`pathname ${JSON.stringify(pathname)} outside the closed shape: untrusted-url, no request`, !r.ok && r.code === 'untrusted-url' && s.seen.length === 0, shape(r));
  }

  for (const status of [404, 500, 302, 301]) {
    s.handle((req, res) => { res.statusCode = status; if (status >= 300 && status < 400) res.setHeader('Location', 'http://127.0.0.1:1/api/x'); res.end('{"error":"x"}'); });
    r = await get(); // eslint-disable-line no-await-in-loop
    check(`${status}: http-status, nothing followed`, !r.ok && r.code === 'http-status' && r.body === null && s.seen.length === 1, shape(r));
  }

  s.handle((req, res) => res.end('not json {'));
  r = await get();
  check('invalid JSON: bad-json', !r.ok && r.code === 'bad-json' && r.body === null, shape(r));

  s.handle((req, res) => res.end(`"${'a'.repeat(CONSTANTS.PAPERCLIP_MAX_BODY_BYTES)}"`));
  r = await get();
  check('a body over 1 MiB: too-large', !r.ok && r.code === 'too-large' && r.body === null, shape(r));

  s.handle((req, res) => res.end(`"${'a'.repeat(CONSTANTS.PAPERCLIP_MAX_BODY_BYTES - 2)}"`));
  r = await get();
  check('a body of exactly 1 MiB: ok', r.ok === true && typeof r.body === 'string', shape(r));

  s.handle((req, res) => { res.write('['); }); // never ends
  let t0 = Date.now();
  r = await get({ deadline: Date.now() + 300 });
  check('a response that never ends: timeout at the deadline', !r.ok && r.code === 'timeout' && Date.now() - t0 < 3000, `${shape(r)} ${Date.now() - t0} ms`);

  s.handle(() => {}); // never answers
  t0 = Date.now();
  r = await get({ deadline: Date.now() + 300 });
  check('a server that never answers: timeout at the deadline', !r.ok && r.code === 'timeout' && Date.now() - t0 < 3000, `${shape(r)} ${Date.now() - t0} ms`);

  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const deadUrl = `http://127.0.0.1:${closed.address().port}`;
  await new Promise((resolve) => closed.close(resolve));
  trustPaperclipUrl(PROJECT, deadUrl);
  r = await paperclipGet({ projectDir: PROJECT, url: deadUrl, pathname: '/api/x', env: ENV });
  check('nothing listening: network', !r.ok && r.code === 'network' && r.body === null, shape(r));

  let threw = false;
  try { r = await paperclipGet(); } catch { threw = true; }
  check('no options at all: a closed code, never a throw', !threw && r && r.ok === false && r.code === 'untrusted-url', shape(r));

  s.server.close();
  fs.rmSync(TEMP, { recursive: true, force: true });
  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => { process.stdout.write(`FAIL harness: ${error && error.message}\n`); process.exit(1); });
