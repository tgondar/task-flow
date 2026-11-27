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
  await t12();
  fs.rmSync(TEMP, { recursive: true, force: true });
  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
}

// --- plan T12: metrics.js paperclip --issue N (spec RF-040, RF-041, RF-043..RF-045) -------------
//
// A local paperclip with one issue, two sub-issues and five runs (four finished: Builder, Tester,
// Reviewer and an unknown role; one still running). The command must write four valid rows, map the
// roles through the closed table, never write a row twice, and send no request at all when it has
// no paperclip issue id to ask about.

const CO = '0c0c0c0c-0000-4000-8000-000000000001';
const PARENT = 'aaaaaaaa-0000-4000-8000-000000000001';
const SUB1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const SUB2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const STRAY = 'cccccccc-0000-4000-8000-000000000001';
const AGENT = { build: 'a0000000-0000-4000-8000-00000000000b', tests: 'a0000000-0000-4000-8000-00000000000c', review: 'a0000000-0000-4000-8000-00000000000d', other: 'a0000000-0000-4000-8000-00000000000e' };
const RUN = (n) => `d0000000-0000-4000-8000-00000000000${n}`;
const usage = (extra) => ({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 300, input_tokens: 100, output_tokens: 20, cached_input_tokens: 300, cache_read_input_tokens: 300, ...extra });
const finished = (n, agentId, extra) => ({
  runId: RUN(n), status: 'succeeded', agentId, adapterType: 'claude_local', startedAt: '2026-11-20T10:00:00.000Z', finishedAt: '2026-11-20T10:02:05.400Z',
  contextIssueId: PARENT, retryOfRunId: null, usageJson: usage({ costUsd: 0.1234, cost_usd: 0.1234, total_cost_usd: 0.1234 }), resultJson: { stopReason: 'end_turn', timeoutFired: false }, ...extra,
});

/** The fake paperclip API: routes by path; `fail` maps a path to a status to answer instead. */
function paperclipApi() {
  const seen = [];
  const fail = new Map();
  const routes = new Map([
    [`/api/issues/${PARENT}`, { id: PARENT, identifier: 'GON-7', parentId: null, status: 'in_progress' }],
    ['/api/issues/GON-7', { id: PARENT, identifier: 'GON-7', parentId: null, status: 'in_progress' }],
    [`/api/companies/${CO}/issues?parentId=${PARENT}`, [
      { id: SUB1, identifier: 'GON-8', parentId: PARENT, status: 'done' },
      { id: SUB2.toUpperCase(), identifier: 'GON-9', parentId: PARENT, status: 'done' },
      { id: STRAY, identifier: 'GON-99', parentId: null, status: 'done' }, // not a child: never asked about
    ]],
    [`/api/issues/${PARENT}/runs`, [finished(1, AGENT.build)]],
    [`/api/issues/${SUB1}/runs`, [
      finished(2, AGENT.tests, { runId: RUN(2).toUpperCase(), usageJson: usage({ costUsd: 1.005 }) }),
      { ...finished(3, AGENT.tests), status: 'running', finishedAt: null },
    ]],
    [`/api/issues/${SUB2}/runs`, [
      finished(4, AGENT.review, { usageJson: usage({ costUsd: 0.5, total_cost_usd: 0.7 }) }),
      finished(5, AGENT.other, { usageJson: usage({ costUsd: undefined, cost_usd: undefined, total_cost_usd: 0.25 }) }),
    ]],
    [`/api/issues/${STRAY}/runs`, [finished(6, AGENT.build)]],
    [`/api/agents/${AGENT.build}`, { name: 'Builder', role: 'engineer', title: 'x', adapterType: 'claude_local' }],
    [`/api/agents/${AGENT.tests}`, { name: 'QA bot', role: 'Tester', title: 'x', adapterType: 'claude_local' }],
    [`/api/agents/${AGENT.review}`, { name: 'reviewer', role: 'engineer', title: 'x', adapterType: 'claude_local' }],
    [`/api/agents/${AGENT.other}`, { name: 'Designer', role: 'designer', title: 'x', adapterType: 'claude_local' }],
  ]);
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (fail.has(req.url)) { res.statusCode = fail.get(req.url); return res.end('{}'); }
    if (!routes.has(req.url)) { res.statusCode = 404; return res.end('{}'); }
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(routes.get(req.url)));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, fail, url: `http://127.0.0.1:${server.address().port}` })));
}

async function t12() {
  const cp = require('child_process');
  const metrics = require(path.join(__dirname, '..', 'plugin', 'scripts', 'metrics.js'));
  const { collectPaperclip, validateLoopRow } = metrics;
  check('T12: collectPaperclip is exported', typeof collectPaperclip === 'function');
  if (typeof collectPaperclip !== 'function') return;

  const api = await paperclipApi();
  const project = path.join(TEMP, 'work', 'pc-project');
  const stateDir = path.join(project, '.claude', 'task-flow');
  const loopsFile = path.join(stateDir, 'loops.jsonl');
  const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const setup = (runs, paperclip = { url: api.url, companyId: CO, agentId: AGENT.build }) => {
    fs.rmSync(project, { recursive: true, force: true });
    put(path.join(project, '.claude', 'task-flow.json'), { docsDir: 'docs', language: 'en', tasksFile: 'tasks.md', paperclip });
    put(path.join(project, 'docs', 'tasks.md'), '# tasks\n');
    for (const [name, extra] of Object.entries(runs)) put(path.join(stateDir, name, 'state.json'), { task: name, phase: 'plan', status: 'blocked', outcome: 'handed-off', ...extra });
    trustPaperclipUrl(project, api.url);
    api.seen.length = 0;
    api.fail.clear();
  };
  const rows = () => (fs.existsSync(loopsFile) ? fs.readFileSync(loopsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const collect = (extra) => collectPaperclip({ projectDir: project, issue: '42', env: ENV, ...extra });
  const byId = (list, id) => list.find((row) => row.id === id) || {};

  // 1. the acceptance case: four finished runs of a parent and two sub-issues
  setup({ 'pc-run': { paperclipIssue: 42, paperclipIssueId: PARENT.toUpperCase() }, 'other-run': { paperclipIssue: 41 } });
  let r = await collect();
  let all = rows();
  check('T12: one issue, two sub-issues, five runs (four finished): written', r.code === 'written' && r.written === 4, JSON.stringify(r));
  check('T12: four rows, each valid by validateLoopRow', all.length === 4 && all.every((row) => validateLoopRow(row).ok), JSON.stringify(all));
  check('T12: every row is source paperclip, run pc-run, not a backfill', all.every((row) => row.source === 'paperclip' && row.run === 'pc-run' && row.backfill === false));
  check('T12: the running run and the stray issue\'s run are not written', !all.some((row) => row.id === RUN(3) || row.id === RUN(6)), all.map((row) => row.id).join());
  check('T12: the stray issue (not a child) is never asked about', !api.seen.some((u) => u.includes(STRAY)), api.seen.join(' '));
  check('T12: run ids are lower-case (an upper-case runId is folded)', byId(all, RUN(2)).id === RUN(2), all.map((row) => row.id).join());
  check('T12: Builder (by name) -> build, agentType Builder', byId(all, RUN(1)).phase === 'build' && byId(all, RUN(1)).agentType === 'Builder', JSON.stringify(byId(all, RUN(1))));
  check('T12: Tester (by role) -> tests, agentType Tester', byId(all, RUN(2)).phase === 'tests' && byId(all, RUN(2)).agentType === 'Tester', JSON.stringify(byId(all, RUN(2))));
  check('T12: "reviewer" (any case) -> review, agentType Reviewer', byId(all, RUN(4)).phase === 'review' && byId(all, RUN(4)).agentType === 'Reviewer', JSON.stringify(byId(all, RUN(4))));
  check('T12: an unknown role -> phase unknown, agentType unknown', byId(all, RUN(5)).phase === 'unknown' && byId(all, RUN(5)).agentType === 'unknown', JSON.stringify(byId(all, RUN(5))));
  check('T12: one agent request per distinct agentId', api.seen.filter((u) => u.startsWith('/api/agents/')).length === 3 + 1 && new Set(api.seen.filter((u) => u.startsWith('/api/agents/'))).size === 4, api.seen.join(' '));
  const one = byId(all, RUN(1));
  check('T12: tokens mapped (cacheRead from cachedInputTokens, no cache-creation field = 0)', JSON.stringify(one.tokens) === JSON.stringify({ input: 100, cacheCreate: 0, cacheRead: 300, output: 20 }), JSON.stringify(one.tokens));
  check('T12: startedAt as a UTC instant, durationS from finishedAt', one.startedAt === '2026-11-20T10:00:00Z' && one.durationS === 125, JSON.stringify(one));
  check('T12: model and effort null (paperclip reports neither), task "" and round null', one.model === null && one.effort === null && one.task === '' && one.round === null, JSON.stringify(one));
  check('T12: outcome/tests/critical/required/reason null', ['outcome', 'tests', 'critical', 'required', 'reason'].every((k) => one[k] === null), JSON.stringify(one));
  check('T12: costUsd 0.1234 (all three agree) -> 12 cents', one.costCents === 12, String(one.costCents));
  check('T12: costUsd 1.005 -> 101 cents (half up, float noise dropped)', byId(all, RUN(2)).costCents === 101, String(byId(all, RUN(2)).costCents));
  check('T12: costUsd and total_cost_usd disagree -> costCents null', byId(all, RUN(4)).costCents === null, String(byId(all, RUN(4)).costCents));
  check('T12: only total_cost_usd 0.25 -> 25 cents', byId(all, RUN(5)).costCents === 25, String(byId(all, RUN(5)).costCents));

  // 2. idempotent
  r = await collect();
  check('T12: run twice: up-to-date, no row duplicated', r.code === 'up-to-date' && r.written === 0 && rows().length === 4, JSON.stringify(r));

  // 3. a task-flow row already there is left alone and never gets a cost (RF-045)
  const tf = { v: 1, source: 'taskflow', run: 'pc-run', id: 'abc123', agentType: 'task-flow:code-reviewer', phase: 'review', task: '', round: null, model: null, effort: null, startedAt: null, durationS: null, tokens: null, costCents: null, outcome: null, tests: null, critical: null, required: null, reason: 'no-transcript', backfill: false };
  setup({ 'pc-run': { paperclipIssue: 42, paperclipIssueId: PARENT } });
  put(loopsFile, `${JSON.stringify(tf)}\n`);
  r = await collect();
  all = rows();
  check('T12: task-flow rows never carry costCents', r.code === 'written' && all.filter((row) => row.source === 'taskflow').every((row) => row.costCents === null) && JSON.stringify(all[0]) === JSON.stringify(tf), JSON.stringify(r));

  // 4. no id to ask about: no request at all
  setup({ 'pc-run': { paperclipIssue: 42 } });
  r = await collect();
  check('T12: no paperclipIssueId and no --paperclip-issue: no-issue-id, no request', r.code === 'no-issue-id' && api.seen.length === 0 && !fs.existsSync(loopsFile), JSON.stringify(r));

  // 5. --paperclip-issue for a run handed off before T10 (an identifier, resolved by the API)
  r = await collect({ paperclipIssue: 'GON-7' });
  check('T12: --paperclip-issue GON-7: written, the same four rows', r.code === 'written' && rows().length === 4 && api.seen[0] === '/api/issues/GON-7', `${JSON.stringify(r)} ${api.seen[0]}`);

  // 6. the flag and the recorded id disagree
  setup({ 'pc-run': { paperclipIssue: 42, paperclipIssueId: PARENT } });
  r = await collect({ paperclipIssue: SUB1 });
  check('T12: --paperclip-issue different from paperclipIssueId: id-mismatch, no request', r.code === 'id-mismatch' && api.seen.length === 0, JSON.stringify(r));

  // 7. finding the run
  setup({ 'pc-run': { paperclipIssue: 41, paperclipIssueId: PARENT } });
  r = await collect();
  check('T12: no run with paperclipIssue 42: no-run, no request', r.code === 'no-run' && api.seen.length === 0, JSON.stringify(r));
  setup({ 'pc-run': { paperclipIssue: '42', paperclipIssueId: PARENT } });
  r = await collect();
  check('T12: paperclipIssue "42" (a string) does not count: no-run', r.code === 'no-run' && api.seen.length === 0, JSON.stringify(r));
  setup({ a: { paperclipIssue: 42, paperclipIssueId: PARENT }, b: { paperclipIssue: 42, paperclipIssueId: PARENT } });
  r = await collect();
  check('T12: two runs with paperclipIssue 42: many-runs, no request', r.code === 'many-runs' && api.seen.length === 0, JSON.stringify(r));

  // 8. config without a usable paperclip block
  setup({ 'pc-run': { paperclipIssue: 42, paperclipIssueId: PARENT } }, { url: api.url, companyId: 'not-a-uuid', agentId: AGENT.build });
  r = await collect();
  check('T12: paperclip.companyId not a UUID: bad-config, no request', r.code === 'bad-config' && api.seen.length === 0, JSON.stringify(r));

  // 9. a failing agent lookup: those runs wait for the next call (never written as unknown)
  setup({ 'pc-run': { paperclipIssue: 42, paperclipIssueId: PARENT } });
  api.fail.set(`/api/agents/${AGENT.tests}`, 500);
  r = await collect();
  check('T12: one agent lookup fails: partial, its run not written', r.code === 'partial' && rows().length === 3 && !rows().some((row) => row.id === RUN(2)), JSON.stringify(r));
  api.fail.clear();
  r = await collect();
  check('T12: the next call writes the missing run only', r.code === 'written' && r.written === 1 && rows().length === 4, JSON.stringify(r));

  // 10. a failing sub-issue: the rest is written, the code says partial
  setup({ 'pc-run': { paperclipIssue: 42, paperclipIssueId: PARENT } });
  api.fail.set(`/api/issues/${SUB2}/runs`, 500);
  r = await collect();
  check('T12: one sub-issue\'s runs fail: partial, the others written', r.code === 'partial' && rows().length === 2, JSON.stringify(r));

  // 11. the parent issue itself fails: its paperclipGet code, nothing written
  setup({ 'pc-run': { paperclipIssue: 42, paperclipIssueId: PARENT } });
  api.fail.set(`/api/issues/${PARENT}`, 404);
  r = await collect();
  check('T12: the issue answers 404: http-status, nothing written', r.code === 'http-status' && !fs.existsSync(loopsFile), JSON.stringify(r));

  // 12. the CLI (a child process: the fake API answers from this one, so never spawnSync)
  const METRICS = path.join(__dirname, '..', 'plugin', 'scripts', 'metrics.js');
  const cli = (args, extra = {}) => new Promise((resolve) => {
    cp.execFile(process.execPath, [METRICS, ...args], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PAPERCLIP_TOKEN: TOKEN, ...extra } }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }));
  });
  setup({ 'pc-run': { paperclipIssue: 42, paperclipIssueId: PARENT } });
  let c = await cli(['paperclip', '--issue', '42', '--project-dir', project]);
  check('T12 CLI: exit 0, one line "metrics: written paperclip", four rows', c.status === 0 && c.stdout === 'metrics: written paperclip\n' && c.stderr === '' && rows().length === 4, JSON.stringify(c));
  c = await cli(['paperclip', '--issue', '42', '--project-dir', project]);
  check('T12 CLI: again: exit 0, "metrics: up-to-date paperclip"', c.status === 0 && c.stdout === 'metrics: up-to-date paperclip\n' && rows().length === 4, JSON.stringify(c));
  setup({ 'pc-run': { paperclipIssue: 42 } });
  c = await cli(['paperclip', '--issue', '42', '--project-dir', project]);
  check('T12 CLI: no id: exit 0, "metrics: no-issue-id paperclip", no request', c.status === 0 && c.stdout === 'metrics: no-issue-id paperclip\n' && api.seen.length === 0, JSON.stringify(c));
  c = await cli(['paperclip', '--issue', '42', '--paperclip-issue', PARENT.toUpperCase(), '--project-dir', project]);
  check('T12 CLI: --paperclip-issue (an upper-case UUID): written', c.status === 0 && c.stdout === 'metrics: written paperclip\n' && rows().length === 4, JSON.stringify(c));
  setup({ 'pc-run': { paperclipIssue: 42, paperclipIssueId: PARENT } });
  c = await cli(['paperclip', '--issue', '42', '--project-dir', project], { TASK_FLOW_METRICS: 'off' });
  check('T12 CLI: TASK_FLOW_METRICS=off: exit 0, disabled, no request, nothing written', c.status === 0 && c.stdout === 'metrics: disabled paperclip\n' && api.seen.length === 0 && !fs.existsSync(loopsFile), JSON.stringify(c));
  for (const args of [['--issue', '0'], ['--issue', '01'], ['--issue', '1;x'], [], ['--issue', '42', '--paperclip-issue', '../x'], ['--issue', '42', '--issue', '42'], ['--issue', '42', '--other', 'x']]) {
    c = await cli(['paperclip', ...args, '--project-dir', project]); // eslint-disable-line no-await-in-loop
    check(`T12 CLI: ${JSON.stringify(args)}: exit 2 with the usage, no request`, c.status === 2 && /^usage: metrics\.js close/.test(c.stderr) && c.stderr.includes('metrics.js paperclip --issue <n>') && c.stdout === '' && api.seen.length === 0, JSON.stringify(c));
  }

  api.server.close();
}

main().catch((error) => { process.stdout.write(`FAIL harness: ${error && error.message}\n`); process.exit(1); });
