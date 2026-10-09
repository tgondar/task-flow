#!/usr/bin/env node
// Tests for collect in plugin/scripts/metrics.js (plan T6, spec R1/R2/R4.4/R9).
//
// collect builds ONE closed-shape row for a finished run from files somebody else
// may have written (state.json, questions.json, the plan) and from the three
// readers (transcripts, git, health). It never writes: T7 appends. What these
// tests hold: the row is exact for a full fixture, a missing or hostile source
// makes ITS block null and nothing else, no free text or path can ride along,
// and nothing throws. Everything is synthetic under a throwaway HOME and a throwaway
// git repo; the real state and the real transcripts are never read.
//
// Run: node tests/metrics.collect.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-collect-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.LOCALAPPDATA = TEST_HOME;
process.env.XDG_STATE_HOME = TEST_HOME;
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const key of Object.keys(process.env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/i.test(key)) delete process.env[key];

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push(`${name}${detail ? ` - ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

const metrics = require('../plugin/scripts/metrics.js');
const { collect, validateRow } = metrics;
const render = require('../plugin/scripts/render-run.js');
const { loadConfig } = require('../plugin/scripts/config.js');

// --- fixture ---------------------------------------------------------------------------
const PROJECT = path.join(TEST_HOME, 'work', 'proj');
const DOCS = path.join(PROJECT, 'docs');
const STATE = path.join(PROJECT, '.claude', 'task-flow');
const SLUG = 'my-run';
const PROJ_SLUG = PROJECT.replace(/[^A-Za-z0-9]/g, '-');
const TRANSCRIPTS = path.join(TEST_HOME, '.claude', 'projects', PROJ_SLUG);

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const STARTED = iso(NOW - 3 * 3600e3);
const CLOSED = iso(NOW - 60e3);
const mid = (min) => new Date(NOW - 2 * 3600e3 + min * 60e3).toISOString();

const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); };
const git = (...args) => cp.execFileSync('git', args, { cwd: PROJECT, stdio: 'pipe' });

fs.mkdirSync(PROJECT, { recursive: true });
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'T'); git('config', 'user.email', 't@example.invalid'); git('config', 'commit.gpgsign', 'false');
put(path.join(PROJECT, 'src', 'a.js'), 'one\n');
git('add', 'src'); git('commit', '-q', '-m', 'base');
git('checkout', '-q', '-b', 'feat/x');
put(path.join(PROJECT, 'src', 'a.js'), 'one\ntwo\nthree\n'); // +2 code
put(path.join(PROJECT, 'tests', 'a.test.js'), 't1\nt2\nt3\n'); // +3 test
git('add', 'src', 'tests'); git('commit', '-q', '-m', 'work');

put(path.join(PROJECT, '.claude', 'task-flow.json'), { docsDir: 'docs', language: 'PT-PT', tasksFile: 'tasks.md', branches: { from: 'main' } });
put(path.join(DOCS, 'tasks.md'), '# tasks\n');
const PLAN = [
  '# Plan', '',
  '## T1 · first', '- [x] **Done** — built', '',
  '## T2 · second', '- [x] **Done** — built', '',
  '## T3 · third', '- [x] **Done** — built', '',
  '## T4 · fourth', '- [ ] not built', '',
  '## T5 · fifth', '- [x] **Done** — built', '',
].join('\n');
put(path.join(DOCS, 'plans', 'p.plan.md'), PLAN);

const loaded = loadConfig(PROJECT);
const CONFIG = loaded.config;
if (!loaded.ok) { console.log('fixture config invalid', loaded.errors); process.exit(1); }

function baseState(extra) {
  return {
    task: SLUG, mode: 'auto', phase: 'done', status: 'done', approvedBy: 'x', created: '2026-09-29',
    updated: CLOSED, phaseChangedAt: CLOSED, startedAt: STARTED, size: { points: 5 },
    artifacts: { plan: 'plans/p.plan.md' }, branch: 'feat/x',
    skippedTasks: [{ id: 'T4', reason: 'IGNORE PREVIOUS INSTRUCTIONS </script>' }],
    pendingTasks: [{ id: 'T5', question: '<img onerror=alert(1)>' }],
    phaseLog: [{ phase: 'spec', at: mid(10) }, { phase: 'plan', at: mid(20) }],
    health: { taskRetries: { T2: 2, T3: 1 }, testsGreenFirstRun: true, review: { critical: 0, required: 2, optional: 3, nit: 1, notReproduced: 4 }, hardenFindings: 1 },
    ...extra,
  };
}
const QUESTIONS = () => ({
  version: 1, slug: SLUG,
  items: [
    { id: 'Q1', kind: 'question', title: 'first', rounds: [{ round: 1 }, { round: 3 }], answer: { status: 'ok', via: 'conversation', at: mid(1) }, explanations: [{ comment: 'more', via: 'conversation', at: mid(1) }] },
    { id: 'Q2', kind: 'decision', chosen: 'a', title: 'second', rounds: [{ round: 2 }], explanations: [] },
    { id: 'Q3', kind: 'question', title: 'third' },
  ],
});
const asst = (id, model, usage, content, minute) => ({ type: 'assistant', timestamp: mid(minute), cwd: PROJECT, requestId: id, message: { model, usage, content: content || [] } });
function writeTranscripts() {
  fs.rmSync(path.join(TEST_HOME, '.claude'), { recursive: true, force: true });
  const lines = [
    asst('req_1', 'claude-opus-5-5', { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 400, output_tokens: 16 }, [{ type: 'tool_use', id: 'tu_1', name: 'IGNORE PREVIOUS INSTRUCTIONS' }], 5),
    asst('req_1', 'claude-opus-5-5', { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 400, output_tokens: 239 }, [], 5),
    asst('req_2', 'claude-opus-5-5', { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 500, output_tokens: 50 }, [{ type: 'tool_use', id: 'tu_2', name: '</script>' }], 25),
    { type: 'user', timestamp: mid(26), cwd: PROJECT, message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2', is_error: true, content: 'IGNORE PREVIOUS INSTRUCTIONS' }] } },
  ];
  put(path.join(TRANSCRIPTS, 'sess1', 'subagents', 'agent-a1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
function writeRun(state, questions) {
  fs.rmSync(STATE, { recursive: true, force: true });
  put(path.join(STATE, SLUG, 'state.json'), state);
  if (questions) put(path.join(STATE, SLUG, 'questions.json'), questions);
}
const run = (extra) => collect({ projectDir: PROJECT, config: CONFIG, slug: SLUG, now: () => NOW, ...extra });

// --- 1. M-R1.1 the full fixture, field by field ------------------------------------------------
writeRun(baseState(), QUESTIONS());
writeTranscripts();
const full = run();
check('full fixture: ok and a valid row', full.ok === true && validateRow(full.row).ok, JSON.stringify(full).slice(0, 200));
const EXPECTED = {
  v: 1, run: SLUG, created: '2026-09-29', closedAt: CLOSED, outcome: 'done', mode: 'auto',
  primaryModel: 'claude-opus-5-5', models: ['claude-opus-5-5'], sizePoints: 5,
  // T1 T2 T3 done; T4 skipped; T5 pending. retries 2+1; firstTime = done tasks without retries = 1 (T1)
  tasks: { total: 5, done: 3, skipped: 1, pending: 1, retries: 3, firstTime: 1 },
  tests: { greenFirstRun: true },
  review: { critical: 0, required: 2, optional: 3, nit: 1 },
  hardenFindings: 1,
  questions: { total: 3, open: 2, explained: 1, maxRound: 3 },
  code: { added: 5, removed: 0, files: 2, testAdded: 3, codeAdded: 2 },
  tokens: {
    input: 30, cacheCreate: 100, cacheRead: 900, output: 289, cacheHitRate: 0.8738,
    // req_1 at minute 5 (before spec closed) -> spec; req_2 at minute 25 (after plan) -> tests? next phase after 'plan' is asserted below from PHASES
    byPhase: full.ok ? full.row.tokens.byPhase : null,
  },
  tokensNull: null,
  agent: { requests: 2, toolCalls: 2, toolErrors: 1, contextPeak: 520 },
};
check('full fixture: exactly the R2 object, field by field', full.ok && JSON.stringify(Object.keys(full.row)) === JSON.stringify(Object.keys(EXPECTED)) &&
  Object.keys(EXPECTED).every((k) => JSON.stringify(full.row[k]) === JSON.stringify(EXPECTED[k])),
  full.ok ? Object.keys(EXPECTED).filter((k) => JSON.stringify(full.row[k]) !== JSON.stringify(EXPECTED[k])).map((k) => `${k}=${JSON.stringify(full.row[k])}`).join(' ') : '');
const phases = render.PHASES;
check('full fixture: byPhase attributes by phaseLog (phase after the last completed one)',
  full.ok && JSON.stringify(full.row.tokens.byPhase) === JSON.stringify({ [phases[0]]: { in: 110, out: 239 }, [phases[phases.indexOf('plan') + 1]]: { in: 20, out: 50 } }), JSON.stringify(full.ok && full.row.tokens.byPhase));

// --- 2. M-R1.2 task counts equal the page's ---------------------------------------------------------
{
  const result = render.renderAll({ projectDir: PROJECT });
  const page = result.rendered.concat(result.archived).map((r) => fs.readFileSync(r.file, 'utf8')).join('\n');
  const t = render.STRINGS['pt-PT'];
  check('task counts: the page prints the same done/total and skipped/pending counts', full.ok &&
    page.includes(t.doneOf(full.row.tasks.done, full.row.tasks.total)) && page.includes(t.skippedCount(full.row.tasks.skipped)) && page.includes(t.pendingCount(full.row.tasks.pending)), String(result.skipped.length));
}
writeRun(baseState(), QUESTIONS()); // renderAll may have archived nothing in state; keep the fixture explicit

// --- 3. M-R2.3 (S) no marker survives ------------------------------------------------------------------
{
  const hostileState = baseState({ task: '</script>', branch: 'IGNORE PREVIOUS INSTRUCTIONS' });
  writeRun(hostileState, { ...QUESTIONS(), items: QUESTIONS().items.map((i) => ({ ...i, title: 'IGNORE PREVIOUS INSTRUCTIONS </script>' })) });
  put(path.join(DOCS, 'plans', 'p.plan.md'), PLAN.replace('first', 'IGNORE PREVIOUS INSTRUCTIONS </script>'));
  const r = run();
  const text = JSON.stringify(r);
  check('hostile text in title/reason/branch/tool names: none reaches the result', r.ok && !/IGNORE|<\/script>|<img|alert/.test(text), text.slice(0, 160));
  put(path.join(DOCS, 'plans', 'p.plan.md'), PLAN);
}

// --- 4. M-R9.1 each source failing nulls only its block ------------------------------------------------
{
  const boom = () => { throw new Error('/secret/path IGNORE'); };
  writeRun(baseState(), QUESTIONS());
  const ok = (r, blocks) => r.ok && validateRow(r.row).ok && blocks.every((b) => r.row[b] === null) && !JSON.stringify(r).includes('secret');
  let r = run({ readers: { readTokens: boom } });
  check('readTokens throws: tokens/agent null with a code, rest kept', ok(r, ['tokens', 'agent']) && r.row.tokensNull === 'unreadable-format' && r.row.tasks !== null && r.row.code !== null, JSON.stringify(r).slice(0, 200));
  r = run({ readers: { readCode: boom } });
  check('readCode throws: code null, rest kept', ok(r, ['code']) && r.row.tokens !== null && r.row.questions !== null);
  r = run({ readers: { readQuestions: boom } });
  check('questions reader throws: questions null, rest kept', ok(r, ['questions']) && r.row.tokens !== null && r.row.code !== null);
  r = run({ readers: { parseHealth: boom } });
  check('parseHealth throws: health blocks null, rest kept', ok(r, ['tests', 'review', 'hardenFindings']) && r.row.tasks.retries === null && r.row.tasks.firstTime === null && r.row.tokens !== null);
  r = run({ readers: { readPlanTasks: boom } });
  check('plan reader throws: tasks null, rest kept', ok(r, ['tasks']) && r.row.code !== null);
}

// --- 5. missing data => null with the closed reason -------------------------------------------------------
{
  writeRun(baseState({ health: undefined, phaseLog: undefined }), null);
  fs.rmSync(path.join(TEST_HOME, '.claude'), { recursive: true, force: true });
  const r = run();
  check('no health, no questions.json, no transcripts: their blocks are null, not zeros', r.ok && r.row.tests === null && r.row.review === null && r.row.hardenFindings === null &&
    r.row.tasks.retries === null && r.row.tasks.firstTime === null && r.row.questions === null && r.row.tokens === null && r.row.agent === null &&
    r.row.tokensNull === 'no-transcripts' && r.row.primaryModel === null && Array.isArray(r.row.models) && r.row.models.length === 0, JSON.stringify(r).slice(0, 300));
  const noPlan = baseState({ artifacts: {} });
  writeRun(noPlan, null);
  const r2 = run();
  check('no plan: tasks null, row still valid', r2.ok && r2.row.tasks === null);
  writeRun(baseState({ branch: 'a..b' }), null);
  const r3 = run();
  check('unsafe branch: code null (git is never asked)', r3.ok && r3.row.code === null);
  const noBase = { ...CONFIG, raw: { ...CONFIG.raw, branches: undefined } };
  writeRun(baseState(), null);
  const r4 = run({ config: noBase });
  check('no branches.from configured: code null, never a guessed base', r4.ok && r4.row.code === null);
  writeRun(baseState({ health: { testsGreenFirstRun: false } }), null);
  const r5 = run();
  check('health present without taskRetries: zero retries, all done tasks first time', r5.ok && r5.row.tasks.retries === 0 && r5.row.tasks.firstTime === 3 && r5.row.tests.greenFirstRun === false && r5.row.review === null);
  writeRun(baseState({ health: { taskRetries: { T1: 'x' } } }), null);
  const r6 = run();
  check('malformed taskRetries: retries/firstTime null, not invented', r6.ok && r6.row.tasks.retries === null && r6.row.tasks.firstTime === null);
}

// --- 6. M-R4.4 eligibility and outcome -------------------------------------------------------------------
{
  const eligible = (state) => { writeRun(state, null); return run(); };
  check('phase build + running: not eligible', eligible(baseState({ phase: 'build', status: 'running' })).ok === false);
  check('phase build + blocked: not eligible', eligible(baseState({ phase: 'build', status: 'blocked' })).ok === false);
  check('phase build + failed: not eligible (never measured)', eligible(baseState({ phase: 'build', status: 'failed' })).ok === false);
  const failed = eligible(baseState({ phase: 'done', status: 'failed' }));
  check('phase done + failed: outcome failed', failed.ok && failed.row.outcome === 'failed');
  const noStart = eligible(baseState({ startedAt: undefined }));
  check('done without startedAt: not eligible (run predates measurement)', noStart.ok === false && noStart.code === 'not-eligible');
  const badStart = eligible(baseState({ startedAt: '2026-09-29' }));
  check('done with a malformed startedAt: not eligible', badStart.ok === false);
}

// --- 7. header fields ---------------------------------------------------------------------------------------
{
  writeRun(baseState({ mode: undefined }), null);
  check('no mode: attended (SKILL.md: a run with no mode is attended)', run().row.mode === 'attended');
  writeRun(baseState({ mode: 'yolo' }), null);
  check('unknown mode: refused as bad-state', run().ok === false && run().code === 'bad-state');
  writeRun(baseState({ created: 'yesterday' }), null);
  check('malformed created: refused as bad-state', run().code === 'bad-state');
  writeRun(baseState({ phaseChangedAt: undefined }), null);
  check('no phaseChangedAt and a broken clock: falls back to the real clock, still a valid row', run({ now: 'x' }).ok === true);
  check('no phaseChangedAt: closedAt is the injected now', run().row.closedAt === iso(NOW));
  writeRun(baseState({ phaseChangedAt: '2026-09-29T11:00:00+01:00' }), null);
  check('phaseChangedAt with an offset is normalised to UTC Z', run().row.closedAt === '2026-09-29T10:00:00Z');
  writeRun(baseState({ size: { points: -3 } }), null);
  check('bad size.points: null', run().row.sizePoints === null);
  writeRun(baseState({ extraTopLevel: 'x', size: { points: 5, evil: 'y' } }), null);
  check('unknown state fields are not carried', !JSON.stringify(run().row).includes('evil') && !('extraTopLevel' in run().row));
}

// --- 8. overlap with another run of the project -----------------------------------------------------------------
{
  writeRun(baseState(), null);
  writeTranscripts();
  put(path.join(STATE, 'other-run', 'state.json'), baseState({ task: 'other-run', startedAt: iso(NOW - 2 * 3600e3), phaseChangedAt: iso(NOW - 600e3) }));
  const r = run();
  check('another run with an overlapping window: tokens null, overlap', r.ok && r.row.tokens === null && r.row.tokensNull === 'overlap');
  put(path.join(STATE, 'other-run', 'state.json'), '{ not json');
  put(path.join(STATE, 'third-run', 'state.json'), baseState({ startedAt: '2020-01-01T00:00:00Z', phaseChangedAt: '2020-01-02T00:00:00Z' }));
  check('an unreadable or non-overlapping other run does not block the measurement', run().row.tokens !== null);
}

// --- 9. never throws, untrusted inputs ------------------------------------------------------------------------
{
  const hostile = [undefined, null, 5, 'x', [], {}, { projectDir: PROJECT }, { projectDir: PROJECT, config: {}, slug: SLUG }, { projectDir: PROJECT, config: CONFIG, slug: '../x' },
    { projectDir: PROJECT, config: CONFIG, slug: '' }, { projectDir: PROJECT, config: CONFIG, slug: 'a'.repeat(101) }, { projectDir: PROJECT, config: CONFIG, slug: 'nope' },
    { projectDir: PROJECT, config: { ...CONFIG, stateDir: 'relative' }, slug: SLUG }, { projectDir: PROJECT, config: { ...CONFIG, stateDir: path.join(TEST_HOME, 'elsewhere') }, slug: SLUG },
    { projectDir: PROJECT, config: new Proxy({}, { get() { throw new Error('boom'); } }), slug: SLUG }];
  for (const [i, arg] of hostile.entries()) {
    let out; let threw = false;
    try { out = collect(arg); } catch { threw = true; }
    check(`hostile argument #${i}: no throw, closed failure`, !threw && out && out.ok === false && typeof out.code === 'string' && Object.keys(out).length === 2 && !('row' in out), String(threw));
  }
  for (const [name, body] of [['array', '[]'], ['null', 'null'], ['truncated', '{"phase": "do'], ['BOM + junk', '﻿\u0000\u0000'], ['huge', ' '.repeat(2 * 1024 * 1024) + '{}']]) {
    fs.rmSync(STATE, { recursive: true, force: true });
    put(path.join(STATE, SLUG, 'state.json'), body);
    let out; let threw = false;
    try { out = run(); } catch { threw = true; }
    check(`state.json ${name}: no throw, bad-state`, !threw && out.ok === false && out.code === 'bad-state', String(out && out.code));
  }
  // a state.json that is a folder, and a questions.json that is hostile
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.mkdirSync(path.join(STATE, SLUG, 'state.json'), { recursive: true });
  check('state.json is a folder: not ok, no throw', run().ok === false);
  writeRun(baseState(), null);
  put(path.join(STATE, SLUG, 'questions.json'), '{"items": [{"id": "Q1"}]}');
  const q = run();
  check('invalid questions.json: questions null, rest kept', q.ok && q.row.questions === null && q.row.tasks !== null);
  put(path.join(STATE, SLUG, 'questions.json'), JSON.stringify({ ...QUESTIONS(), slug: 'another' }));
  check('questions.json of another slug: questions null', run().row.questions === null);
}

// --- 10. M-R10.4 (S) no path, no home ---------------------------------------------------------------------------------
{
  writeRun(baseState(), QUESTIONS());
  writeTranscripts();
  const text = JSON.stringify(run());
  const needles = [PROJECT, DOCS, TEST_HOME, PROJECT.replace(/\\/g, '/'), PROJECT.replace(/\\/g, '\\\\'), os.homedir()];
  check('the result contains no homedir, projectDir or docsDir', needles.every((n) => !text.includes(n)), text.slice(0, 100));
  check('collect writes nothing: no metrics.jsonl appears', !fs.existsSync(path.join(STATE, 'metrics.jsonl')));
}

// --- 11b. T4: a different run (slug pr-999), no artifacts.plan, done -----------------------------------------------
{
  const prSlug = 'pr-999';
  fs.rmSync(path.join(STATE, prSlug), { recursive: true, force: true });
  put(path.join(STATE, prSlug, 'state.json'), baseState({ task: prSlug, artifacts: {} }));
  const r = collect({ projectDir: PROJECT, config: CONFIG, slug: prSlug, now: () => NOW });
  check('pr-999 without artifacts.plan: collect succeeds without throwing', r.ok === true, JSON.stringify(r).slice(0, 200));
  check('pr-999 without artifacts.plan: tasks block is null', r.ok && r.row.tasks === null);
  check('pr-999 without artifacts.plan: the row still validates', r.ok && validateRow(r.row).ok === true);
  fs.rmSync(path.join(STATE, prSlug), { recursive: true, force: true });
}

// --- 11. by construction ----------------------------------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.resolve(__dirname, '../plugin/scripts/metrics.js'), 'utf8');
  const a = src.indexOf('function collect(');
  const body = src.slice(a, src.indexOf('// --- transcript reader (spec R6)'));
  check('collect section has no write, spawn or eval', a > 0 && !/\b(writeFileSync|appendFileSync|writeSync|renameSync|mkdirSync|unlinkSync|rmSync|spawn|eval\(|new Function)\b/.test(body));
  check('collect never names a caught error (its message would quote a file)', !/catch\s*\(\s*\w+\s*\)/.test(body));
}

check('no prototype pollution after all cases', ({}).polluted === undefined && Object.keys(Object.prototype).length === 0);
try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
