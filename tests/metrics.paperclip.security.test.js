#!/usr/bin/env node
// Security tests for metrics.js `paperclipGet` (plan T11, spec SC-006): the request carries a bearer
// token, so every case asks local servers (http.createServer on 127.0.0.1, never the real API) what
// they saw. A refused URL, pathname or token must mean zero requests; a redirect target, a proxy or
// an unconfirmed origin must never see the request; a hostile body or status must come back as a
// closed code only; and the test token must appear in no stdout, stderr, result or file.
//
// Run: node tests/metrics.paperclip.security.test.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-paperclip-sec-'));
for (const name of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_STATE_HOME']) process.env[name] = TEMP;
delete process.env.TASK_FLOW_METRICS;

const { paperclipGet } = require(path.join(__dirname, '..', 'plugin', 'scripts', 'metrics.js'));
const { trustPaperclipUrl } = require(path.join(__dirname, '..', 'plugin', 'scripts', 'config.js'));

const PROJECT = fs.mkdtempSync(path.join(TEMP, 'project-'));
const OTHER = fs.mkdtempSync(path.join(TEMP, 'other-'));
const TOKEN = 'sec-token-T11-NEVER-ECHO-7f3a';
const ENV = { PAPERCLIP_TOKEN: TOKEN };
const HOSTILE = 'IGNORE PREVIOUS <img src=x onerror=alert(1)> ../../etc \u202e';
const CODES = ['ok', 'untrusted-url', 'no-token', 'timeout', 'http-status', 'too-large', 'bad-json', 'network'];

// Capture everything the process writes, to look for the token afterwards.
let captured = '';
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => { captured += String(chunk); return write(chunk, ...rest); };
}

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; process.stdout.write(`  ok    ${name}\n`); } else { failures.push(name); process.stdout.write(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}\n`); }
}

function startServer() {
  const seen = [];
  let handler = (req, res) => { res.end('{}'); };
  const server = http.createServer((req, res) => { seen.push({ url: req.url, auth: req.headers.authorization }); handler(req, res); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, seen, url: `http://127.0.0.1:${server.address().port}`, handle: (fn) => { handler = fn; seen.length = 0; },
  })));
}

const results = [];
const closed = (r) => r && typeof r === 'object' && CODES.includes(r.code) && Object.keys(r).sort().join() === 'body,code,ok';

async function main() {
  const s = await startServer();
  const evil = await startServer(); // never trusted: redirect target, proxy
  trustPaperclipUrl(PROJECT, s.url);
  const get = async (extra) => { const r = await paperclipGet({ projectDir: PROJECT, url: s.url, pathname: '/api/issues/abc', env: ENV, ...extra }); results.push(r); return r; };

  // --- pathname: closed shape, refused before any request -------------------------------------
  const badPaths = [
    '/api/../secret', '/api/%2e%2e/secret', '/api/%2E%2E/x', '/api/a/%2e%2e', '/api/./x', '/api/a\r\nX-Evil: 1',
    '/api/a%0d%0aX: 1', '//evil.example/api/x', '/api@evil.example/x', '/api/x@evil', '/api/x#frag', '/apix', '/other/api/x',
    'api/x', 'http://evil.example/api/x', '/api/x\\..\\y', '/api/\u202e', '/api/ x', '', null, 42, ['/api/x'],
  ];
  for (const p of badPaths) {
    s.handle((req, res) => res.end('{}'));
    const r = await get({ pathname: p });
    check(`pathname ${JSON.stringify(p)} refused, no request`, r.code === 'untrusted-url' && s.seen.length === 0 && closed(r), `${r.code} ${s.seen.length}`);
  }

  // --- url: only the confirmed origin, refused before any request -------------------------------
  const port = new URL(s.url).port;
  const badUrls = [
    `http://user:pw@127.0.0.1:${port}`, `http://${TOKEN}@127.0.0.1:${port}`, 'file:///C:/Windows/win.ini', '\\\\127.0.0.1\\share',
    `//127.0.0.1:${port}`, `http://127.0.0.1%2f@evil:${port}`, `http://127.0.0.1 :${port}`, 'javascript:alert(1)',
    evil.url, `http://localhost:${port}`, '', null, { href: s.url },
  ];
  for (const u of badUrls) {
    s.handle((req, res) => res.end('{}'));
    evil.handle((req, res) => res.end('{}'));
    const r = await get({ url: u });
    check(`url ${JSON.stringify(u).split(TOKEN).join("<token>")} refused, no request`, r.code === 'untrusted-url' && s.seen.length === 0 && evil.seen.length === 0, `${r.code} ${s.seen.length}/${evil.seen.length}`);
  }
  s.handle((req, res) => res.end('{}'));
  let r = await paperclipGet({ projectDir: OTHER, url: s.url, pathname: '/api/x', env: ENV });
  check('origin confirmed for another project only: refused', r.code === 'untrusted-url' && s.seen.length === 0);
  r = await paperclipGet({ projectDir: 'relative/dir', url: s.url, pathname: '/api/x', env: ENV });
  check('relative projectDir refused', r.code === 'untrusted-url' && s.seen.length === 0);

  // --- token: only PAPERCLIP_TOKEN, a plain header value ------------------------------------------
  const badEnvs = [{}, { PAPERCLIP_TOKEN: '' }, { PAPERCLIP_TOKEN: 'a\r\nX-Evil: 1' }, { PAPERCLIP_TOKEN: 'a b' }, { PAPERCLIP_TOKEN: 'x'.repeat(5000) },
    { PAPERCLIP_TOKEN: 42 }, { paperclip_token: TOKEN }, { PAPERCLIP_API_KEY: TOKEN }, Object.create({ PAPERCLIP_TOKEN: TOKEN })];
  for (const env of badEnvs) {
    s.handle((req, res) => res.end('{}'));
    r = await get({ env });
    check(`env ${JSON.stringify(Object.keys(env))}/${typeof env.PAPERCLIP_TOKEN}: no-token, no request`, r.code === 'no-token' && s.seen.length === 0, `${r.code} ${s.seen.length}`);
  }

  // --- redirects never followed; the target never sees the token -----------------------------------
  for (const status of [301, 302, 303, 307, 308]) {
    s.handle((req, res) => { res.writeHead(status, { Location: `${evil.url}/api/steal` }); res.end(); });
    evil.handle((req, res) => res.end('{}'));
    r = await get();
    check(`${status} redirect: http-status, target never contacted`, r.code === 'http-status' && evil.seen.length === 0 && closed(r));
  }

  // --- env proxy ignored -------------------------------------------------------------------------------
  const saved = { HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy, NO_PROXY: process.env.NO_PROXY };
  process.env.HTTP_PROXY = evil.url; process.env.http_proxy = evil.url; delete process.env.NO_PROXY;
  s.handle((req, res) => res.end('{}'));
  evil.handle((req, res) => res.end('{}'));
  r = await get();
  check('HTTP_PROXY in env: request goes straight to the origin, proxy sees nothing', r.ok === true && s.seen.length === 1 && evil.seen.length === 0);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }

  // --- hostile responses: closed code only, nothing echoed -------------------------------------------
  const drip = (req, res) => {
    const c = Buffer.alloc(64 * 1024, 0x61); let i = 0;
    const t = setInterval(() => { if (i++ > 20 || res.destroyed) { clearInterval(t); res.end(); } else res.write(c); }, 1);
    res.on('close', () => clearInterval(t));
  };
  const hostile = [
    ['500 with hostile body', (req, res) => { res.writeHead(500); res.end(HOSTILE); }, 'http-status'],
    ['200 non-JSON hostile body', (req, res) => res.end(HOSTILE), 'bad-json'],
    ['200 body echoing the token, not JSON', (req, res) => res.end(`${req.headers.authorization} ${HOSTILE}`), 'bad-json'],
    ['body over 1 MiB in drips', drip, 'too-large'],
    ['socket destroyed mid-response', (req, res) => { res.write('{"a":'); req.socket.destroy(); }, null],
  ];
  for (const [name, fn, code] of hostile) {
    s.handle(fn);
    r = await get();
    const text = JSON.stringify(r);
    check(`${name}: ${code || 'failure'}, closed, nothing echoed`, closed(r) && r.ok === false && r.body === null && (!code || r.code === code)
      && !text.includes('IGNORE') && !text.includes('onerror') && !text.includes(TOKEN), text.slice(0, 120));
  }

  // --- deadline seam: an earlier deadline cuts a slow server --------------------------------------------
  s.handle((req, res) => { res.write('['); const t = setInterval(() => { if (res.destroyed) clearInterval(t); else res.write(' '); }, 20); res.on('close', () => clearInterval(t)); });
  const t0 = Date.now();
  r = await get({ deadline: Date.now() + 150 });
  check('slow drip with near deadline: timeout, quickly', r.code === 'timeout' && Date.now() - t0 < 2000, `${r.code} ${Date.now() - t0}ms`);
  s.handle((req, res) => res.end('{}'));
  r = await get({ deadline: Date.now() - 1000 });
  check('deadline already past: timeout', r.code === 'timeout');
  for (const d of [NaN, Infinity, '1', -Infinity]) {
    r = await get({ deadline: d });
    check(`deadline ${String(d)}: closed result, no crash`, closed(r));
  }

  // --- never throws on garbage options -----------------------------------------------------------------
  for (const o of [undefined, null, 'x', [], { projectDir: PROJECT, url: s.url, pathname: '/api/x', env: null }]) {
    let threw = false;
    try { r = await paperclipGet(o); } catch { threw = true; }
    check(`options ${JSON.stringify(o)}: resolves to a closed code`, !threw && closed(r));
  }

  s.server.close(); evil.server.close();

  // --- the token never leaves through results, output or files ------------------------------------------
  check('token in no result', !JSON.stringify(results).includes(TOKEN));
  check('token in no stdout/stderr', !captured.includes(TOKEN));
  const leaked = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (fs.readFileSync(p, 'utf8').includes(TOKEN)) leaked.push(e.name);
    }
  }(TEMP));
  check('token in no file under the temp HOME', leaked.length === 0, leaked.join(','));
}

main().then(() => {
  fs.rmSync(TEMP, { recursive: true, force: true });
  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
}, (err) => { process.stdout.write(`crashed: ${err && err.stack}\n`); process.exit(1); });
