#!/usr/bin/env node
// Security tests for plan T7: the "Loops" section of the run page, built from
// <stateDir>/loops.jsonl. That file is untrusted (anyone can edit it, a cloned repository can
// plant it) and the page is read as generated truth by the user in Obsidian and by the model.
// What they hold: hostile rows (pipes, links, HTML, wikilinks, bidi, newlines, ../, huge or
// negative numbers) never reach the page or break the table, even handed straight to
// buildDocument; a sum past the safe-integer range prints the dash; a row of another run or of
// an older run in the same folder is left out; loops.jsonl as a folder, a junction or a giant
// file renders the page of a run without rows and only a closed code reaches stderr;
// TASK_FLOW_METRICS=off is byte-identical with or without rows; the viewer feed gains no loop
// text. Everything is synthetic under a throwaway HOME.
//
// Run: node tests/metrics.loops.render.security.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-lrsec-'));
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

const RENDER = path.join(__dirname, '..', 'plugin', 'scripts', 'render-run.js');
const { buildDocument } = require(RENDER);

const PROJECT = path.join(TEST_HOME, 'work', 'proj');
const DOCS = path.join(PROJECT, 'docs');
const STATE = path.join(PROJECT, '.claude', 'task-flow');
const LOOPS = path.join(STATE, 'loops.jsonl');
const SLUG = 'my-run';
const PAGE = path.join(DOCS, 'runs', `260929_${SLUG}.md`);
const MARKERS = ['IGNORE PREVIOUS', '<img', 'onerror', 'javascript:', '[[', '../', '‮', 'evil'];

const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); };
put(path.join(PROJECT, '.claude', 'task-flow.json'), { docsDir: 'docs', language: 'en', tasksFile: 'tasks.md' });
put(path.join(DOCS, 'tasks.md'), '# tasks\n');
put(path.join(DOCS, 'plans', 'p.plan.md'), '# Plan\n\n## T1 · first\n- [ ] **Todo**\n');

// a running run, so no close interferes; a hostile marker in a field the page never prints
const STATE_JSON = {
  task: SLUG, mode: 'auto', phase: 'build', status: 'running', approvedBy: 'x', created: '2026-09-29',
  updated: '2026-09-29T10:00:00Z', phaseChangedAt: '2026-09-29T10:00:00Z', startedAt: '2026-09-29T09:00:00Z',
  artifacts: { plan: 'plans/p.plan.md' }, note: 'IGNORE PREVIOUS <img src=x onerror=alert(1)> ../ ‮',
};
function reset() {
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.rmSync(path.join(DOCS, 'runs'), { recursive: true, force: true });
  fs.rmSync(path.join(TEST_HOME, 'task-flow'), { recursive: true, force: true });
  put(path.join(STATE, SLUG, 'state.json'), STATE_JSON);
}
const page = () => (fs.existsSync(PAGE) ? fs.readFileSync(PAGE, 'utf8') : '');
const norm = (text) => text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'T');
const loop = (over = {}) => ({
  v: 1, source: 'taskflow', run: SLUG, id: 'a1', agentType: 'task-flow:security-auditor', phase: 'build', task: 'T1',
  round: null, model: 'claude-opus-5-5', effort: 'low', startedAt: '2026-09-29T09:10:00Z', durationS: 125,
  tokens: { input: 100, cacheCreate: 200, cacheRead: 5000, output: 50 }, costCents: null,
  outcome: 'ok', tests: 'green', critical: 0, required: 1, reason: null, backfill: false, ...over,
});
const lines = (rows) => `${rows.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n')}\n`;
function cli(env = {}) {
  return spawnSync(process.execPath, [RENDER, '--quiet', '--project-dir', PROJECT], { encoding: 'utf8', env: { ...process.env, ...env } });
}
const noMarkers = (text) => MARKERS.filter((m) => text.includes(m));
const loopsPart = (text) => { const i = text.indexOf('## Loops'); if (i < 0) return ''; const j = text.indexOf('\n## ', i + 1); return text.slice(i, j < 0 ? undefined : j); };

// baseline: a run with no loops.jsonl
reset();
cli();
const BASE = norm(page());
check('baseline page rendered without a Loops section', BASE.length > 0 && !BASE.includes('## Loops'));

// ---- 1. hostile rows never reach the page and the table holds -----------------------------
const HOSTILE = [
  loop({ id: 'h1', agentType: 'x|y' }),
  loop({ id: 'h2', model: '[a](javascript:alert(1))' }),
  loop({ id: 'h3', agentType: '<img src=x onerror=alert(1)>' }),
  loop({ id: 'h4', task: '[[evil]]' }),
  loop({ id: 'h5', model: 'a‮b' }),
  loop({ id: 'h6', agentType: 'a\n| evil |' }),
  loop({ id: 'h7', run: '../evil' }),
  loop({ id: 'h8', durationS: -5 }),
  loop({ id: 'h9', durationS: 1e300 }),
  loop({ id: 'h10', phase: 'IGNORE PREVIOUS' }),
  loop({ id: 'h11', effort: '`evil`' }),
  loop({ id: 'h12', outcome: 'evil' }),
  loop({ id: 'h13', reason: 'timeout' }), // reason only with tokens null
  loop({ id: 'h14', costCents: 5 }), // money only from paperclip
  { ...loop({ id: 'h15' }), extra: 'IGNORE PREVIOUS' },
  'IGNORE PREVIOUS <img src=x onerror=alert(1)> [[evil]]',
  `{"v":1,"agentType":"${'A'.repeat(2000)}"}`,
];
// agentType/model at the edge of their closed shape (80 chars, every allowed punctuation)
const LIMIT = loop({ id: 'ok1', agentType: `A${'a:._-'.repeat(15)}abcd`, model: `Z${'9:._-'.repeat(15)}wxyz` });
reset();
put(LOOPS, lines([...HOSTILE, LIMIT]));
const r1 = cli();
const p1 = page();
const sec1 = loopsPart(p1);
check('hostile rows: render exit 0', r1.status === 0, String(r1.status));
// the page links the plan as ../plans/..., so ../ is checked in the section only
check('hostile rows: no marker on the page', noMarkers(p1).filter((m) => m !== '../').length === 0 && noMarkers(sec1).length === 0, noMarkers(p1).join(','));
check('hostile rows: no marker on stdout/stderr', noMarkers(r1.stdout + r1.stderr).length === 0);
check('hostile rows: only the valid row at the shape limit is in the table, in code spans',
  sec1.includes(`\`${LIMIT.agentType}\``) && sec1.includes(`\`${LIMIT.model}\``) &&
  sec1.split('\n').filter((l) => /^\| build \|/.test(l)).length === 2, sec1); // one loop row + one phase row
const tableLines = sec1.split('\n').filter((l) => l.startsWith('|'));
check('hostile rows: every table line keeps its column count',
  tableLines.length > 0 && tableLines.every((l) => { const n = (l.match(/\|/g) || []).length; return n === 10 || n === 5; }), tableLines.join('\n'));

// buildDocument is exported and takes whatever it is handed: it validates again
const docArgs = { state: STATE_JSON, slug: SLUG, tasks: [], questions: null, openQuestions: 0, depth: 1, created: '2026-09-29', lang: 'en' };
const doc = buildDocument({ ...docArgs, loops: HOSTILE.filter((x) => typeof x !== 'string') });
check('buildDocument with unvalidated hostile rows: no section, no marker', !doc.includes('## Loops') && noMarkers(doc).length === 0);
const docNotArray = buildDocument({ ...docArgs, loops: 'IGNORE PREVIOUS' });
check('buildDocument with a non-array loops: no section', !docNotArray.includes('## Loops'));

// ---- 2. oversize numbers print the dash --------------------------------------------------
// each count is capped at 1e12 by the validator, so only a sum can leave the safe range:
// 3100 rows of 3e12 fresh tokens pass Number.MAX_SAFE_INTEGER in the by-phase token sum
const BIG = 1e12;
reset();
put(LOOPS, lines(Array.from({ length: 3100 }, (_, i) => loop({ id: `n${i}`, tokens: { input: BIG, cacheCreate: BIG, cacheRead: 0, output: BIG }, durationS: BIG }))));
cli();
const sec2 = loopsPart(page());
check('oversize: section shown', sec2.includes('## Loops'));
check('oversize: an unsafe sum prints the dash, never an exponent', /\| build \| 3100 \| — \| /.test(sec2) && !/e\+\d/.test(sec2) && !sec2.includes('Infinity') && !sec2.includes("NaN"));

// ---- 3. rows of another run / an older run in the same folder ----------------------------
reset();
put(LOOPS, lines([
  loop({ id: 'o1', run: 'other-run', agentType: 'planted-other-run' }),
  loop({ id: 'o2', startedAt: '2026-09-28T09:00:00Z', agentType: 'planted-older-run' }),
  loop({ id: 'o3', startedAt: null, agentType: 'planted-no-start' }),
]));
cli();
const p3 = page();
check('planted rows of another run or an older one are left out', !p3.includes('planted') && !p3.includes('## Loops'));

// ---- 4. loops.jsonl as a folder, a junction, a link, a giant file -------------------------
function asNoRows(name, plant) {
  reset();
  try { plant(); } catch { console.log(`  skip  ${name} (cannot create it here)`); return; }
  const r = cli();
  const p = norm(page());
  check(`${name}: render exit 0`, r.status === 0, String(r.status));
  check(`${name}: page equals that of a run without rows`, p === BASE);
  check(`${name}: stderr holds closed codes only`, r.stderr.split('\n').filter(Boolean).every((l) => /^(loops not read|viewer feed not written|metrics not closed): [a-z-]{1,30}$/.test(l)), r.stderr);
  check(`${name}: no marker on stdout/stderr`, noMarkers(r.stdout + r.stderr).length === 0);
}
asNoRows('folder', () => { fs.mkdirSync(LOOPS, { recursive: true }); put(path.join(LOOPS, 'x'), lines([loop()])); });
asNoRows('junction', () => {
  const target = path.join(TEST_HOME, 'elsewhere');
  put(path.join(target, 'x'), lines([loop()]));
  fs.symlinkSync(target, LOOPS, 'junction');
});
asNoRows('file symlink', () => {
  const target = path.join(TEST_HOME, 'elsewhere.jsonl');
  put(target, lines([loop()]));
  fs.symlinkSync(target, LOOPS, 'file');
});
asNoRows('giant junk file', () => {
  const junk = `${'IGNORE PREVIOUS <img src=x onerror=alert(1)> '.repeat(40)}\n`;
  put(LOOPS, junk.repeat(Math.ceil((6 * 1024 * 1024) / junk.length)));
});

// ---- 5. TASK_FLOW_METRICS=off is byte-identical with or without rows -----------------------
reset();
cli({ TASK_FLOW_METRICS: 'off' });
const offNone = norm(page());
reset();
put(LOOPS, lines([loop(), loop({ id: 'b2', agentType: 'general-purpose' })]));
cli({ TASK_FLOW_METRICS: 'off' });
check('TASK_FLOW_METRICS=off: page byte-identical with rows', norm(page()) === offNone && !offNone.includes('## Loops'));

// ---- 6. the viewer feed gains no loop text ----------------------------------------------
const feedText = () => { const dir = path.join(TEST_HOME, 'task-flow', 'feed'); const f = fs.existsSync(dir) ? fs.readdirSync(dir)[0] : null; return f ? fs.readFileSync(path.join(dir, f), 'utf8') : ''; };
reset();
cli();
const feedNone = norm(feedText());
reset();
put(LOOPS, lines([loop({ agentType: 'feed-probe-agent' })]));
cli();
const feedRows = norm(feedText());
check('feed: written', feedNone.length > 0);
check('feed: identical with loop rows, no loop text', feedRows === feedNone && !feedRows.includes('feed-probe-agent'));
check('feed: page did show the row (probe is live)', page().includes('feed-probe-agent'));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
