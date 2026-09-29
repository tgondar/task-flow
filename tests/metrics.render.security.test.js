#!/usr/bin/env node
// Security tests for plan T8 (renderAll closes a finished run; the page gains "Run health").
// The page is generated truth, also read by the model and opened in an Obsidian vault, and
// metrics.jsonl is a file anyone can edit: only formatted numbers, fixed sentences and the
// validated model name (code span) may reach it. Also: a metrics failure never fails or
// alters a render, the viewer feed gains nothing, the Stop hook keeps its exit codes and
// messages, and closing a run of a hostile config writes nothing outside the project.
// Synthetic fixtures under a throwaway HOME.
//
// Run: node tests/metrics.render.security.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-mrsec-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.LOCALAPPDATA = TEST_HOME;
process.env.XDG_STATE_HOME = TEST_HOME;
delete process.env.TASK_FLOW_METRICS;
delete process.env.TASK_FLOW_GATE;

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push(`${name}${detail ? ` - ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

const RENDER = path.resolve(__dirname, '../plugin/scripts/render-run.js');
const { renderAll, buildDocument } = require(RENDER);
const metrics = require('../plugin/scripts/metrics.js');

const PROJECT = path.join(TEST_HOME, 'work', 'proj');
const DOCS = path.join(PROJECT, 'docs');
const STATE = path.join(PROJECT, '.claude', 'task-flow');
const HISTORY = path.join(STATE, 'metrics.jsonl');
const SLUG = 'my-run';
const CLOSED = '2026-09-29T12:00:00Z';
const MODEL = 'claude-opus-5-5';

const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); };
const state = (extra) => ({
  task: SLUG, mode: 'auto', phase: 'done', status: 'done', approvedBy: 'x', created: '2026-09-29',
  updated: CLOSED, phaseChangedAt: CLOSED, startedAt: '2026-09-29T09:00:00Z', size: { points: 3 },
  artifacts: { plan: 'plans/p.plan.md' }, outcome: 'merged', ...extra,
});
function reset(s, language = 'en') {
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.rmSync(path.join(DOCS, 'runs'), { recursive: true, force: true });
  put(path.join(PROJECT, '.claude', 'task-flow.json'), { docsDir: 'docs', language, tasksFile: 'tasks.md' });
  put(path.join(DOCS, 'tasks.md'), '# tasks\n');
  put(path.join(DOCS, 'plans', 'p.plan.md'), '# Plan\n\n## T1 · first\n- [x] **Done** — built\n');
  put(path.join(STATE, SLUG, 'state.json'), s);
}
const pageFile = () => [path.join(DOCS, 'runs', `260929_${SLUG}.md`), path.join(DOCS, 'runs', 'finished', `260929_${SLUG}.md`)].find((f) => fs.existsSync(f));
const page = () => { const f = pageFile(); return f ? fs.readFileSync(f, 'utf8') : null; };
const lines = () => (fs.existsSync(HISTORY) && fs.statSync(HISTORY).isFile() ? fs.readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean) : []);
function row(run, over = {}) {
  return {
    v: 1, run, created: '2026-09-29', closedAt: '2026-09-29T10:00:00Z', outcome: 'done', mode: 'auto',
    primaryModel: MODEL, models: [MODEL], sizePoints: 3,
    tasks: { total: 4, done: 4, skipped: 0, pending: 0, retries: 0, firstTime: 4 },
    tests: { greenFirstRun: true }, review: { critical: 0, required: 0, optional: 0, nit: 0 }, hardenFindings: 0,
    questions: { total: 0, open: 0, explained: 0, maxRound: 0 },
    code: { added: 100, removed: 10, files: 4, testAdded: 50, codeAdded: 50 },
    tokens: { input: 1000, cacheCreate: 8000, cacheRead: 90000, output: 1000, cacheHitRate: 0.9, byPhase: {} },
    tokensNull: null, agent: { requests: 40, toolCalls: 40, toolErrors: 0, contextPeak: 60000 }, ...over,
  };
}
const seed = (rows) => put(HISTORY, `${rows.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n')}\n`);
const base = (n) => Array.from({ length: n }, (_, i) => row(`base-${i}`, { closedAt: `2026-09-2${i}T10:00:00Z` }));
const own = (over) => row(SLUG, { closedAt: CLOSED, ...over });
const health = (text) => { if (typeof text !== 'string') return ''; const i = text.indexOf('## Run health'); return i < 0 ? '' : text.slice(i); };

// ---- 1. output injection: the section prints nothing but its own strings ------------------
const HOSTILE = [
  'a|b', 'a`b', '</script><script>alert(1)</script>', '<img src=x onerror=1>', '[x](http://e.example)', '![i](http://e.example/i.png)',
  'a\nb', 'a\r\n## forged', 'a\u0000b', 'a‮b', 'a​b', '[[wikilink]]', '---', '{{template}} ${x} <%= 1 %>', 'x'.repeat(5000), '', ' ',
  ' ## forged', 'a\u0085## forged',
];
const CTRL = new RegExp('[\u0000-\u0008\u000B-\u001F\u007F\u0085\u200B-\u200F\u2028-\u202E\u2066-\u2069]');
for (const evil of HOSTILE) {
  reset(state());
  seed([...base(5), own({ primaryModel: evil, models: [evil], tokensNull: evil, outcome: evil })]);
  renderAll({ projectDir: PROJECT });
  const t = page();
  const s = health(t);
  const tag = JSON.stringify(evil.slice(0, 20));
  check(`hostile model/reason ${tag}: section, if any, has no forged/HTML/link/wikilink text`, !/forged|<\/?script|<img|e\.example|wikilink|onerror|\$\{|<%=/.test(s), s);
  check(`hostile ${tag}: no control/bidi/zero-width chars in the section`, !CTRL.test(s));
  check(`hostile ${tag}: no page line starts with a forged heading`, !/^## forged/m.test(t));
  check(`hostile ${tag}: the render survived`, t !== null);
}
// numbers: NaN/Infinity/negative/huge never print anything but digits
const NUMS = [NaN, Infinity, -Infinity, -5, 1e21, 1e308, -1e21, 2 ** 53, 0.1 + 0.2, '7', null, {}, [], true];
const args = { state: state(), slug: SLUG, tasks: [], questions: null, openQuestions: 0, depth: 1, artifacts: {}, created: '2026-09-29' };
for (const lang of ['en', 'pt-PT', 'fr', 'zz', undefined]) {
  for (const value of NUMS) {
    const doc = buildDocument({ ...args, lang, health: {
      row: own({ code: { added: value, removed: value, files: value }, hardenFindings: value, sizePoints: value }),
      baseline: { hasVerdict: true, n: value, have: value, min: value, metrics: [
        { id: 'freshTokensPerTask', value, median: value, verdict: 'ok' }, { id: 'cacheHitRate', value, median: value, verdict: 'deviation' },
        { id: 'toolCallsPerTask', value, median: value, verdict: 'n/d' }] },
    } });
    const rowsOut = health(doc).split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---'));
    const cells = (l) => l.replace(/^\| /, '').replace(/ \|$/, '').split(' | ');
    const bad = rowsOut.slice(1).filter((l) => cells(l).slice(1, 3).some((c) => !/^(—|yes|no|sim|não|-?[0-9.,]+(e\+?-?[0-9]+)?%?)$/.test(c)));
    check(`numbers ${JSON.stringify(value)} (${lang}): only digits or a dash in value cells`, bad.length === 0, bad.join('\n'));
  }
}
check('unknown language falls back to English, no crash', buildDocument({ ...args, lang: 'fr', health: { row: own(), baseline: {} } }).includes('## Run health'));
check('fr via renderAll: English page', (() => { reset(state(), 'fr'); seed([...base(5), own()]); renderAll({ projectDir: PROJECT }); return page().includes('## Run health'); })());
// inherited keys as ids, reasons and verdicts
const protoDoc = buildDocument({ ...args, lang: 'en', health: { row: own({ tokens: null, tokensNull: 'constructor' }), baseline: { hasVerdict: true, n: 8, metrics: [
  { id: '__proto__', value: 1, median: 1, verdict: 'ok' }, { id: 'toString', value: 1, median: 1, verdict: 'constructor' }, { id: 'freshTokensPerTask', value: 1, median: 1, verdict: 'hasOwnProperty' }] } } });
check('inherited keys are never looked up as ids/reasons/verdicts', !/function|\[native|Object/.test(health(protoDoc)) && !/Tokens not measured/.test(health(protoDoc)), health(protoDoc));
// throwing getter / Proxy anywhere in health: the page keeps every other section
const boom = new Proxy({}, { get() { throw new Error('SECRET-BOOM'); }, has() { throw new Error('SECRET-BOOM'); }, ownKeys() { throw new Error('SECRET-BOOM'); } });
const flat = (x) => x.replace(/\n{2,}/g, '\n').trim();
const clean = buildDocument({ ...args, lang: 'en', health: null });
for (const h of [boom, { row: boom, baseline: {} }, { row: own(), baseline: boom }, { row: own(), baseline: { metrics: boom } }, { row: { get primaryModel() { throw new Error('SECRET-BOOM'); } }, baseline: {} }]) {
  let doc; let threw = false;
  try { doc = buildDocument({ ...args, lang: 'en', health: h }); } catch { threw = true; }
  check(`a Proxy/throwing getter in health never fails the page or leaks its message`, !threw && !doc.includes('SECRET-BOOM') && flat(doc.replace(/## Run health[\s\S]*?(?=\n## |$)/, '')) === flat(clean));
}

// ---- 2. a page the user hand-edited, and other runs' pages ------------------------------
reset(state()); seed([...base(5), own()]); renderAll({ projectDir: PROJECT });
fs.appendFileSync(pageFile(), '\nMY HAND NOTE\n');
const second = renderAll({ projectDir: PROJECT });
check('re-render of a hand-edited page succeeds and adds no second history line', second.skipped.length === 0 && lines().length === 6);
check('the page keeps exactly one health section', (page().match(/^## Run health/gm) || []).length === 1);
put(path.join(STATE, 'other-run', 'state.json'), state({ task: 'other-run', phase: 'build', status: 'running' }));
const otherPage = () => { const f = path.join(DOCS, 'runs', '260929_other-run.md'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };
process.env.TASK_FLOW_METRICS = 'off'; renderAll({ projectDir: PROJECT }); const otherOff = otherPage();
delete process.env.TASK_FLOW_METRICS; renderAll({ projectDir: PROJECT });
check("another run's page is identical with metrics on and off", otherOff !== null && otherOff === otherPage());
for (const v of ['off', 'OFF', 'Off']) {
  reset(state()); process.env.TASK_FLOW_METRICS = v; renderAll({ projectDir: PROJECT }); delete process.env.TASK_FLOW_METRICS;
  check(`TASK_FLOW_METRICS=${v}: no line, no section`, lines().length === 0 && !page().includes('Run health'));
}
for (const v of ['0', 'false', 'no']) {
  reset(state()); process.env.TASK_FLOW_METRICS = v; renderAll({ projectDir: PROJECT }); delete process.env.TASK_FLOW_METRICS;
  check(`TASK_FLOW_METRICS=${JSON.stringify(v)} is not the switch (exactly "off", any case)`, lines().length === 1);
}

// ---- 3. hostile metrics.jsonl: oversized, symlink, directory ----------------------------
reset(state());
put(HISTORY, `${'x'.repeat(3 * 1024 * 1024)}\n${'{"a":1}\n'.repeat(1000)}`);
const t0 = Date.now();
const big = renderAll({ projectDir: PROJECT });
check('huge/garbage history: render succeeds, page exists, bounded time', big.skipped.length === 0 && page() !== null && Date.now() - t0 < 15000, `${Date.now() - t0}ms`);
check('huge/garbage history leaks no garbage into the page', !/xxxx/.test(page()));
reset(state()); fs.mkdirSync(HISTORY, { recursive: true });
const asDir = renderAll({ projectDir: PROJECT });
check('history as a directory: render ok, closed metricsError, nothing written inside', asDir.skipped.length === 0 && /^[a-z-]+$/.test(asDir.metricsError || '') && fs.readdirSync(HISTORY).length === 0);
const OUTSIDE = path.join(TEST_HOME, 'outside'); fs.mkdirSync(OUTSIDE, { recursive: true });
const target = path.join(OUTSIDE, 'stolen.jsonl'); fs.writeFileSync(target, 'ORIG\n');
reset(state());
let linked = true;
try { fs.symlinkSync(target, HISTORY, 'file'); } catch { linked = false; }
if (linked) {
  const viaLink = renderAll({ projectDir: PROJECT });
  check('history as a symlink: nothing written through it, render ok, page without section', fs.readFileSync(target, 'utf8') === 'ORIG\n' && viaLink.skipped.length === 0 && !page().includes('Run health'));
} else console.log('  --  symlink not creatable here (no privilege): symlink case not exercised');
reset(state()); fs.mkdirSync(path.join(OUTSIDE, 'junc'), { recursive: true });
fs.rmSync(STATE, { recursive: true, force: true });
let junc = true;
try { fs.symlinkSync(path.join(OUTSIDE, 'junc'), STATE, 'junction'); } catch { junc = false; }
if (junc) {
  put(path.join(OUTSIDE, 'junc', SLUG, 'state.json'), state());
  let threw = false; try { renderAll({ projectDir: PROJECT }); } catch { threw = true; }
  check('stateDir through a junction: nothing metrics-related written outside', !fs.existsSync(path.join(OUTSIDE, 'junc', 'metrics.jsonl')), `threw=${threw}`);
  fs.rmSync(STATE, { recursive: true, force: true });
}

// ---- 4. metrics failure never fails the render; error carries a closed code -------------
const realClose = metrics.closeRun; const realRead = metrics.readHistory; const realBase = metrics.baseline;
const SECRET = 'SECRET-TEXT-FROM-A-FILE';
reset(state());
process.env.TASK_FLOW_METRICS = 'off'; renderAll({ projectDir: PROJECT }); delete process.env.TASK_FLOW_METRICS;
const plainPage = page();
const variants = {
  'closeRun throws': () => { metrics.closeRun = () => { throw new Error(SECRET); }; },
  'closeRun returns hostile code': () => { metrics.closeRun = () => ({ ok: false, code: `${SECRET} /etc/passwd` }); },
  'closeRun returns garbage': () => { metrics.closeRun = () => 42; },
  'readHistory throws': () => { metrics.readHistory = () => { throw new Error(SECRET); }; },
  'baseline throws': () => { seed([own()]); metrics.closeRun = () => ({ ok: true, code: 'already-closed' }); metrics.baseline = () => { throw new Error(SECRET); }; },
  'rows getter throws': () => { metrics.closeRun = () => ({ ok: true, code: 'closed' }); metrics.readHistory = () => ({ get rows() { throw new Error(SECRET); } }); },
};
for (const [name, install] of Object.entries(variants)) {
  reset(state()); install();
  let out; let threw = false;
  try { out = renderAll({ projectDir: PROJECT }); } catch { threw = true; }
  Object.assign(metrics, { closeRun: realClose, readHistory: realRead, baseline: realBase });
  check(`${name}: render succeeds, closed metricsError, no secret, page as without the feature`, !threw && out.skipped.length === 0 && /^[a-z-]{1,30}$/.test(out.metricsError || '') && !JSON.stringify(out).includes(SECRET) && page() === plainPage, `${threw} ${JSON.stringify(out)}`);
}
const Module = require('module'); const realLoad = Module._load;
Module._load = function (request, ...rest) { if (/metrics\.js$/.test(request)) { const e = new Error(`Cannot find ${SECRET}`); e.code = 'MODULE_NOT_FOUND'; throw e; } return realLoad.call(this, request, ...rest); };
reset(state()); let missing; let missingThrew = false;
try { missing = renderAll({ projectDir: PROJECT }); } catch { missingThrew = true; }
Module._load = realLoad;
check('metrics.js missing: render succeeds, closed code, no message echoed', !missingThrew && missing.skipped.length === 0 && missing.metricsError === 'internal' && page() === plainPage);
reset(state());
metrics.closeRun = (o) => { put(path.join(STATE, SLUG, 'state.json'), state({ status: 'failed', phase: 'build' })); return realClose(o); };
let flipThrew = false; try { renderAll({ projectDir: PROJECT }); } catch { flipThrew = true; }
metrics.closeRun = realClose;
check('state flips mid-render: no crash, no row for a run that is no longer done', !flipThrew && lines().length === 0);

// ---- 5. the viewer feed is unchanged by metrics ------------------------------------------
const feedText = () => { const dir = path.join(TEST_HOME, 'task-flow', 'feed'); const f = fs.existsSync(dir) ? fs.readdirSync(dir)[0] : null; return f ? fs.readFileSync(path.join(dir, f), 'utf8') : ''; };
const norm = (s) => s.replace(/"generatedAt": ?"[^"]*"/g, '');
reset(state()); process.env.TASK_FLOW_METRICS = 'off'; renderAll({ projectDir: PROJECT }); delete process.env.TASK_FLOW_METRICS;
const feedOff = norm(feedText());
reset(state()); seed([...base(5), own()]); renderAll({ projectDir: PROJECT });
const feedOn = norm(feedText());
check('a feed exists to compare', feedOff.length > 0);
check('feed identical with metrics on and off (no metrics data)', feedOff === feedOn);
check('feed carries no model, health, metrics or docsDir path', !/claude-opus|health|metric|freshTokens|tokens/i.test(feedOn) && !feedOn.includes(DOCS) && !feedOn.includes(JSON.stringify(DOCS).slice(1, -1)));

// ---- 6. concurrent renders of a finished run ---------------------------------------------
reset(state()); seed(base(5));
const runOne = () => new Promise((resolve) => { const c = cp.spawn(process.execPath, [RENDER, '--quiet', '--project-dir', PROJECT], { env: { ...process.env } }); c.on('close', (code) => resolve(code)); });
Promise.all([runOne(), runOne(), runOne()]).then((codes) => {
  check('concurrent renders: all exit 0', codes.every((c) => c === 0), JSON.stringify(codes));
  const mine = lines().filter((l) => { try { return JSON.parse(l).run === SLUG; } catch { return false; } });
  const hist = metrics.readHistory(PROJECT, STATE);
  check('concurrent renders: readers see exactly one row for the run (dedup backstop)', hist.rows.filter((r) => r.run === SLUG).length === 1 && mine.length >= 1, `${mine.length} lines`);
  const t = page();
  check('concurrent renders: page whole, one section, outcome present', (t.match(/^## Run health/gm) || []).length === 1 && /## Outcome/.test(t));
  check('concurrent renders: every history line is valid JSON', lines().every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
  stopHook();
});

// ---- 7. Stop hook -------------------------------------------------------------------------
function stopHook() {
  const STOP = path.resolve(__dirname, '../plugin/hooks/stop.js');
  const stop = (root, env = {}) => {
    const started = Date.now();
    const r = cp.spawnSync(process.execPath, [STOP], { input: JSON.stringify({ session_id: `mrsec-${process.pid}-${Date.now()}`, hook_event_name: 'Stop', cwd: root }), encoding: 'utf8', timeout: 30000, env: { ...process.env, TASK_FLOW_GATE: '', CLAUDE_PROJECT_DIR: root.replace(/\\/g, '/'), ...env } });
    return { code: r.status, stderr: r.stderr || '', ms: Date.now() - started };
  };
  const guards = path.join(TEST_HOME, '.claude', 'task-flow-guards');
  const guardCount = () => (fs.existsSync(guards) ? fs.readdirSync(guards).length : 0);

  reset(state()); seed([...base(5), own({ primaryModel: 'zz-model-zz' })]);
  const g0 = guardCount();
  const done = stop(PROJECT);
  check('Stop hook, finished run: exit 0 (never pushes on account of metrics)', done.code === 0, `${done.code} ${done.stderr}`);
  check('Stop hook: stderr has no metrics text or model name', !/zz-model|health|metrics/i.test(done.stderr), done.stderr);
  check('Stop hook: no guard file created for a finished run', guardCount() === g0);
  check('Stop hook: the page it re-rendered shows the section', page().includes('Run health'));

  reset(state({ phase: 'build', status: 'running', buildCursor: 'T1' }));
  seed([`{"run":"${SECRET}"}`, 'x'.repeat(200000)]);
  const running = stop(PROJECT);
  check('Stop hook, running run with hostile history: exit 2, message names no history text', running.code === 2 && !running.stderr.includes(SECRET) && !/metric/i.test(running.stderr), `${running.code} ${running.stderr}`);
  reset(state()); put(HISTORY, `${'y'.repeat(20 * 1024 * 1024)}\n`);
  const huge = stop(PROJECT);
  check('Stop hook, 20 MB history: exit 0 and bounded time (< 15 s)', huge.code === 0 && huge.ms < 15000, `${huge.code} ${huge.ms}ms ${huge.stderr}`);
  reset(state()); fs.mkdirSync(HISTORY, { recursive: true });
  const dirHist = stop(PROJECT);
  check('Stop hook, history is a directory: fails open (exit 0)', dirHist.code === 0, `${dirHist.code} ${dirHist.stderr}`);
  reset(state());
  const off = stop(PROJECT, { TASK_FLOW_METRICS: 'off' });
  check('Stop hook with METRICS=off: exit 0, no row', off.code === 0 && lines().length === 0);

  hostileConfig();
}

// ---- 8. hostile config: closing must not write outside the project ------------------------
function hostileConfig() {
  const snapshot = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).sort().join('|') : '');
  for (const cfg of [
    { docsDir: OUTSIDE, language: 'en', tasksFile: 'tasks.md' },
    { docsDir: 'docs', language: 'en', tasksFile: 'tasks.md', stateDir: '../../outside' },
    { docsDir: 'docs', language: 'en', tasksFile: 'tasks.md', stateDir: OUTSIDE },
    { docsDir: 'docs', language: 'en', tasksFile: '../../outside/tasks.md', stateDir: '.' },
  ]) {
    reset(state()); put(path.join(PROJECT, '.claude', 'task-flow.json'), cfg);
    put(path.join(OUTSIDE, SLUG, 'state.json'), state());
    const before = snapshot(OUTSIDE);
    let threw = false; try { renderAll({ projectDir: PROJECT }); } catch { threw = true; }
    const closed = metrics.closeRun({ projectDir: PROJECT, slug: SLUG });
    check(`hostile config ${JSON.stringify(cfg).slice(0, 70)}: nothing added outside the project, closed result`, snapshot(OUTSIDE) === before && !fs.existsSync(path.join(OUTSIDE, 'metrics.jsonl')) && typeof closed.code === 'string' && /^[a-z-]+$/.test(closed.code), `threw=${threw} ${JSON.stringify(closed)}`);
    fs.rmSync(path.join(OUTSIDE, SLUG), { recursive: true, force: true });
  }
  reset(state()); seed([...base(5), own()]); renderAll({ projectDir: PROJECT });
  check('page written inside the docs folder only', pageFile() && pageFile().startsWith(DOCS + path.sep));
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
}
