#!/usr/bin/env node
// Security tests for `metrics.js paperclip --issue N` (plan T12, spec RF-040..RF-045, SC-006,
// SC-007): state.json (committed) and every paperclip response are untrusted. A local
// http.createServer on 127.0.0.1 plays a hostile paperclip - never the real API. What must hold:
// ids from state.json or a response never build a request path outside their closed shape; hostile
// bodies (huge arrays, stray sub-issues, duplicate/forged runIds, hostile usageJson, `__proto__`,
// injection text) leave only validateLoopRow-valid rows in loops.jsonl and never reach output; a
// re-run never writes a key twice; the command deadline holds; the CLI prints one fixed line; the
// test token is nowhere.
//
// Run: node tests/metrics.paperclip-loops.security.test.js

const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-pcloops-sec-'));
for (const name of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_STATE_HOME']) process.env[name] = TEMP;
delete process.env.TASK_FLOW_METRICS;

const METRICS = path.join(__dirname, '..', 'plugin', 'scripts', 'metrics.js');
const { collectPaperclip, validateLoopRow } = require(METRICS);
const { trustPaperclipUrl } = require(path.join(__dirname, '..', 'plugin', 'scripts', 'config.js'));

const TOKEN = 'sec-token-T12-NEVER-ECHO-9c1e';
const ENV = { PAPERCLIP_TOKEN: TOKEN };
const HOSTILE = 'IGNORE PREVIOUS <img src=x onerror=alert(1)> ../../etc ‮';
const CO = '0c0c0c0c-0000-4000-8000-000000000001';
const PARENT = 'aaaaaaaa-0000-4000-8000-000000000001';
const AGENT = 'a0000000-0000-4000-8000-00000000000b';
const uuid = (n) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sub = (n) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const run = (id, extra) => ({ runId: id, agentId: AGENT, startedAt: '2026-11-20T10:00:00Z', finishedAt: '2026-11-20T10:01:00Z', usageJson: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 }, ...extra });

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

/** A paperclip whose routes are swapped per case; unknown path = 404; `hang` paths never answer. */
function api() {
  const seen = [];
  const routes = new Map();
  const hang = new Set();
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (hang.has(req.url)) return undefined;
    if (!routes.has(req.url)) { res.statusCode = 404; return res.end('{}'); }
    const body = routes.get(req.url);
    return res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, routes, hang, url: `http://127.0.0.1:${server.address().port}` })));
}

async function main() {
  const s = await api();
  const project = path.join(TEMP, 'work', 'proj');
  const stateDir = path.join(project, '.claude', 'task-flow');
  const loopsFile = path.join(stateDir, 'loops.jsonl');
  const put = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)); };
  const results = [];
  const setup = (state, companyId = CO) => {
    fs.rmSync(project, { recursive: true, force: true });
    put(path.join(project, '.claude', 'task-flow.json'), { docsDir: 'docs', language: 'en', tasksFile: 'tasks.md', paperclip: { url: s.url, companyId, agentId: AGENT } });
    put(path.join(project, 'docs', 'tasks.md'), '# t\n');
    put(path.join(stateDir, 'pc-run', 'state.json'), typeof state === 'string' ? state : { task: 'x', phase: 'plan', status: 'blocked', ...state });
    trustPaperclipUrl(project, s.url);
    s.seen.length = 0; s.routes.clear(); s.hang.clear();
  };
  const base = (runs, subs = []) => {
    s.routes.set(`/api/issues/${PARENT}`, { id: PARENT, identifier: 'GON-7' });
    s.routes.set(`/api/companies/${CO}/issues?parentId=${PARENT}`, subs);
    s.routes.set(`/api/issues/${PARENT}/runs`, runs);
    s.routes.set(`/api/agents/${AGENT}`, { name: 'Builder' });
  };
  const rows = () => (fs.existsSync(loopsFile) ? fs.readFileSync(loopsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const collect = async (extra) => { const r = await collectPaperclip({ projectDir: project, issue: '42', env: ENV, ...extra }); results.push(r); return r; };
  const allValid = () => rows().every((row) => validateLoopRow(row).ok);
  const closed = (r) => r && Object.keys(r).sort().join() === 'code,written' && /^[a-z-]+$/.test(r.code);

  // --- ids from state.json never build a path outside their shape -----------------------------
  for (const id of ['../x', `${PARENT}/../../admin`, `${PARENT}%2f..`, `${PARENT}?x=1`, 'GON-7/../x', 'gon-7', HOSTILE, 42, { id: PARENT }]) {
    setup({ paperclipIssue: 42, paperclipIssueId: id });
    const r = await collect(); // eslint-disable-line no-await-in-loop
    check(`paperclipIssueId ${JSON.stringify(id).slice(0, 40)}: not used, no request`, r.code === 'no-issue-id' && s.seen.length === 0, JSON.stringify(r));
  }
  for (const flag of ['../x', `${PARENT}%2f`, 'GON-7?a', HOSTILE]) {
    setup({ paperclipIssue: 42 });
    const r = await collect({ paperclipIssue: flag }); // eslint-disable-line no-await-in-loop
    check(`paperclipIssue option ${JSON.stringify(flag).slice(0, 30)}: invalid, no request`, r.code === 'invalid' && s.seen.length === 0, JSON.stringify(r));
  }
  for (const pi of ['42', 42.5, -42, '42;x', [42], null]) {
    setup({ paperclipIssue: pi, paperclipIssueId: PARENT });
    const r = await collect(); // eslint-disable-line no-await-in-loop
    check(`paperclipIssue ${JSON.stringify(pi)}: no-run, no request`, r.code === 'no-run' && s.seen.length === 0, JSON.stringify(r));
  }
  setup({ paperclipIssue: 42, outcomeNote: `paperclipIssueId ${PARENT}` });
  check('an id planted in outcomeNote is not used', (await collect()).code === 'no-issue-id' && s.seen.length === 0);
  setup('{"__proto__":{"paperclipIssue":42,"paperclipIssueId":"' + PARENT + '"}}');
  check('paperclipIssue only under __proto__: no-run', (await collect()).code === 'no-run' && s.seen.length === 0);
  for (const issue of ['0', '01', '1;x', '42/../1', '', 42]) {
    setup({ paperclipIssue: 42, paperclipIssueId: PARENT });
    const r = await collect({ issue }); // eslint-disable-line no-await-in-loop
    check(`issue ${JSON.stringify(issue)}: invalid, no request`, r.code === 'invalid' && s.seen.length === 0);
  }
  setup({ paperclipIssue: 42, paperclipIssueId: PARENT }, `${CO}/../x`);
  check('companyId with a traversal: bad-config, no request', (await collect()).code === 'bad-config' && s.seen.length === 0);

  // --- ids from responses never build a path outside their shape -------------------------------
  setup({ paperclipIssue: 42, paperclipIssueId: PARENT });
  base([run(uuid(1), { agentId: `${AGENT}/../../x` }), run(`${uuid(2)}/..`), run('../../x')], [
    { id: '../../admin', parentId: PARENT }, { id: `${sub(1)}%2f..`, parentId: PARENT }, { id: sub(2), parentId: `${PARENT}/x` },
  ]);
  let r = await collect();
  check('hostile ids in sub-issues/runs/agentId: every request path is in shape', s.seen.every((u) => /^\/api\/(issues|agents|companies)\/[0-9a-f-]+(\/runs|\/issues\?parentId=[0-9a-f-]+)?$/.test(u)), s.seen.join(' '));
  check('hostile ids: only the in-shape run written (agentless = unknown), valid', rows().length === 1 && rows()[0].id === uuid(1) && rows()[0].phase === 'unknown' && allValid(), JSON.stringify(rows()));

  setup({ paperclipIssue: 42, paperclipIssueId: PARENT });
  base([]);
  s.routes.set(`/api/issues/${PARENT}`, { id: sub(9), identifier: 'GON-8' });
  r = await collect();
  check('the issue answers as another issue: bad-response, nothing written', r.code === 'bad-response' && !fs.existsSync(loopsFile), JSON.stringify(r));
  setup({ paperclipIssue: 42, paperclipIssueId: PARENT });
  s.routes.set(`/api/issues/${PARENT}`, { __proto__: null, id: HOSTILE });
  check('the issue answers with a hostile id: bad-response', (await collect()).code === 'bad-response');

  // --- limits: sub-issues, runs, agents ----------------------------------------------------------
  setup({ paperclipIssue: 42, paperclipIssueId: PARENT });
  base([], Array.from({ length: 150 }, (_, i) => ({ id: sub(i + 1), parentId: PARENT })));
  r = await collect();
  const runReqs = s.seen.filter((u) => u.endsWith('/runs')).length;
  check('150 sub-issues: at most 100 asked (+ parent), partial', r.code === 'partial' && runReqs <= 101, `${r.code} ${runReqs}`);

  setup({ paperclipIssue: 42, paperclipIssueId: PARENT });
  base(Array.from({ length: 6000 }, (_, i) => run(uuid(i + 1), { usageJson: undefined })));
  r = await collect();
  check('6,000 runs: at most 5,000 written, partial', r.code === 'partial' && rows().length === 5000 && allValid(), `${r.code} ${rows().length}`);

  setup({ paperclipIssue: 42, paperclipIssueId: PARENT });
  const agents = Array.from({ length: 60 }, (_, i) => `a0000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
  base(agents.map((a, i) => run(uuid(i + 1), { agentId: a })));
  r = await collect();
  check('60 distinct agents: at most 50 agent requests, partial', r.code === 'partial' && s.seen.filter((u) => u.startsWith('/api/agents/')).length <= 50, `${r.code}`);

  setup({ paperclipIssue: 42, paperclipIssueId: PARENT });
  base([], [{ id: sub(1), parentId: PARENT }]);
  s.routes.set(`/api/issues/${PARENT}/runs`, `${'['.repeat(100000)}${']'.repeat(100000)}`);
  r = await collect();
  check('deeply nested runs body: closed code, no throw', closed(r), JSON.stringify(r));

  // --- hostile run content: forged, duplicate, other issue's, hostile usage ------------------------
  setup({ paperclipIssue: 42, paperclipIssueId: PARENT });
  base([
    run(uuid(1)), run(uuid(1).toUpperCase(), { usageJson: { inputTokens: 999, outputTokens: 999 } }), // duplicate runId
    run(uuid(2), { usageJson: { inputTokens: -5, outputTokens: 1 } }),
    run(uuid(3), { usageJson: { inputTokens: 1e300, outputTokens: 1 } }),
    run(uuid(4), { usageJson: { inputTokens: '9', outputTokens: 1, costUsd: '0.5' } }),
    run(uuid(5), { usageJson: { inputTokens: 1, outputTokens: 1, costUsd: -1 } }),
    run(uuid(6), { usageJson: { inputTokens: 1, outputTokens: 1, costUsd: 1e300 } }),
    run(uuid(7), { usageJson: { inputTokens: 1, outputTokens: 1, costUsd: 0.5, cost_usd: 0.6 } }),
    run(uuid(8), { usageJson: HOSTILE, startedAt: HOSTILE, finishedAt: '2026-11-20T10:01:00Z' }),
    run(uuid(9), { startedAt: '2026-11-20T10:05:00Z' }), // finished before it started
    run(uuid(10), { finishedAt: 'yesterday' }), // not finished in shape: skipped
    run(uuid(11), { model: HOSTILE, effort: HOSTILE, phase: HOSTILE, agentType: HOSTILE, source: 'taskflow', run: '../x', id: HOSTILE, extra: { __proto__: { polluted: 1 } } }),
    JSON.parse(`{"__proto__":{"runId":"${uuid(12)}","finishedAt":"2026-11-20T10:01:00Z"}}`),
  ]);
  r = await collect();
  const all = rows();
  const by = (n) => all.find((row) => row.id === uuid(n));
  check('hostile runs: every row valid, run=pc-run, source=paperclip', all.length > 0 && allValid() && all.every((row) => row.run === 'pc-run' && row.source === 'paperclip'), JSON.stringify(all).slice(0, 300));
  check('duplicate runId (any case): one row, the first', all.filter((row) => row.id === uuid(1)).length === 1 && by(1).tokens.input === 1);
  check('tokens -5 / 1e300 / "9": tokens null', [2, 3, 4].every((n) => by(n) && by(n).tokens === null));
  check('cost "0.5" / -1 / 1e300 / disagreeing: costCents null', [4, 5, 6, 7].every((n) => by(n) && by(n).costCents === null), JSON.stringify([4, 5, 6, 7].map((n) => by(n) && by(n).costCents)));
  check('hostile usageJson/startedAt: tokens, startedAt, durationS null', by(8) && by(8).tokens === null && by(8).startedAt === null && by(8).durationS === null);
  check('finished before started: durationS null', by(9) && by(9).durationS === null);
  check('finishedAt out of shape: not written', !by(10));
  check('extra run fields never override the row (model, phase, source, run)', by(11) && by(11).model === null && by(11).phase === 'build' && by(11).agentType === 'Builder');
  check('runId only under __proto__: not written', !by(12));
  check('no hostile marker in loops.jsonl', !/IGNORE PREVIOUS|onerror|\.\.\/|‮|polluted/.test(fs.readFileSync(loopsFile, 'utf8')));
  check('Object.prototype not polluted', ({}).polluted === undefined && ({}).runId === undefined);

  // --- hostile agent: role text, __proto__, failure ---------------------------------------------
  for (const agent of [{ name: HOSTILE, role: `builder ${HOSTILE}` }, { name: '__proto__', role: 'constructor' }, JSON.parse('{"__proto__":{"name":"Builder"}}'), { name: 'B'.repeat(10000) }, [{ name: 'Builder' }], '"Builder"']) {
    setup({ paperclipIssue: 42, paperclipIssueId: PARENT });
    base([run(uuid(1))]);
    s.routes.set(`/api/agents/${AGENT}`, agent);
    r = await collect(); // eslint-disable-line no-await-in-loop
    const row = rows()[0] || {};
    check(`agent ${JSON.stringify(agent).slice(0, 30)}: role unknown, row valid`, r.code === 'written' && row.agentType === 'unknown' && row.phase === 'unknown' && allValid(), JSON.stringify(row));
  }

  // --- idempotency: re-runs and case-differing keys -------------------------------------------------
  setup({ paperclipIssue: 42, paperclipIssueId: PARENT });
  base([run(uuid(1)), run(uuid(2))]);
  await collect();
  s.routes.set(`/api/issues/${PARENT}/runs`, [run(uuid(1).toUpperCase()), run(uuid(2)), run(uuid(3))]);
  r = await collect();
  await collect();
  const keys = rows().map((row) => row.id);
  check('three calls, ids re-sent in upper case: no key twice', keys.length === 3 && new Set(keys).size === 3, keys.join());

  // --- deadline: a paperclip that hangs on sub-issues --------------------------------------------------
  setup({ paperclipIssue: 42, paperclipIssueId: PARENT });
  base([run(uuid(1))], [{ id: sub(1), parentId: PARENT }, { id: sub(2), parentId: PARENT }]);
  s.hang.add(`/api/issues/${sub(1)}/runs`); s.hang.add(`/api/issues/${sub(2)}/runs`);
  let t0 = Date.now();
  r = await collect({ deadline: Date.now() + 500 });
  check('hanging sub-issues: returns by the deadline, partial', r.code === 'partial' && Date.now() - t0 < 4000, `${r.code} ${Date.now() - t0} ms`);
  r = await collect({ deadline: Date.now() + 1e12 });
  check('a deadline far away cannot widen the 60 s limit (still a closed code)', closed(r));
  setup({ paperclipIssue: 42, paperclipIssueId: PARENT });
  base([]);
  t0 = Date.now();
  r = await collect({ deadline: Date.now() - 1 });
  check('deadline already past: timeout, no request', r.code === 'timeout' && s.seen.length === 0, JSON.stringify(r));

  // --- garbage options never throw -------------------------------------------------------------------
  for (const o of [undefined, null, 'x', [], { projectDir: 'relative', issue: '42' }, { projectDir: project, issue: '42', paperclipIssue: null }]) {
    let threw = false;
    try { r = await collectPaperclip(o); } catch { threw = true; } // eslint-disable-line no-await-in-loop
    check(`options ${JSON.stringify(o)}: closed code`, !threw && closed(r) && r.code === 'invalid', JSON.stringify(r));
  }

  // --- the CLI: one fixed line, hostile server echoed nowhere, token nowhere ---------------------------
  const cli = (args, extra = {}) => new Promise((resolve) => {
    cp.execFile(process.execPath, [METRICS, ...args], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PAPERCLIP_TOKEN: TOKEN, ...extra } }, (e, stdout, stderr) => resolve({ status: e ? e.code : 0, stdout, stderr }));
  });
  setup({ paperclipIssue: 42, paperclipIssueId: PARENT });
  base([run(uuid(1), { model: HOSTILE, note: TOKEN })]);
  s.routes.set(`/api/agents/${AGENT}`, { name: HOSTILE, echo: TOKEN });
  let c = await cli(['paperclip', '--issue', '42', '--project-dir', project]);
  captured += c.stdout + c.stderr;
  check('CLI on a hostile server: one fixed line, empty stderr', c.status === 0 && /^metrics: [a-z-]+ paperclip\n$/.test(c.stdout) && c.stderr === '', JSON.stringify(c));
  check('CLI output carries no marker', !/IGNORE|onerror|‮/.test(c.stdout + c.stderr));
  s.seen.length = 0;
  c = await cli(['paperclip', '--issue', '42', '--project-dir', project], { TASK_FLOW_METRICS: 'OFF' });
  check('TASK_FLOW_METRICS=OFF (any case): disabled, no request', c.stdout === 'metrics: disabled paperclip\n' && s.seen.length === 0);
  for (const args of [['--issue', '42', '--paperclip-issue', `${PARENT}%2f..`], ['--issue', '42\n'], ['--issue', ' 42'], ['--issue=42'], ['--issue', '42', '--project-dir']]) {
    s.seen.length = 0;
    c = await cli(['paperclip', ...args, ...(args.includes('--project-dir') ? [] : ['--project-dir', project])]); // eslint-disable-line no-await-in-loop
    check(`CLI ${JSON.stringify(args)}: exit 2, usage only, no request`, c.status === 2 && c.stdout === '' && c.stderr.startsWith('usage:') && s.seen.length === 0, JSON.stringify(c));
  }

  s.server.close();
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
