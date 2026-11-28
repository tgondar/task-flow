#!/usr/bin/env node
// Tests for plan T7 (spec 6.3, RF-030..RF-032): the run page gains a "Loops" section built
// from <stateDir>/loops.jsonl. What they hold: the section sits right after "Run health" (or
// where it would be), in en and pt-PT with any other language in English; one row per loop in
// start order with phase, task, round, agent, model, effort, duration, tokens and result; the
// split by phase (sums of tokens and durations, with the fixed note that durations overlap);
// a run with no rows keeps a page byte-identical to the one without this feature (also with
// TASK_FLOW_METRICS=off); a paperclip run (plan/blocked) shows the same section; and rows of
// an older run that used the same folder name (startedAt before the state's) are left out.
// Everything is synthetic under a throwaway HOME.
//
// Run: node tests/metrics.loops.render.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-lrender-'));
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

const { renderAll, buildDocument } = require('../plugin/scripts/render-run.js');

const PROJECT = path.join(TEST_HOME, 'work', 'proj');
const DOCS = path.join(PROJECT, 'docs');
const STATE = path.join(PROJECT, '.claude', 'task-flow');
const LOOPS = path.join(STATE, 'loops.jsonl');
const SLUG = 'my-run';
const PAGE = path.join(DOCS, 'runs', `260929_${SLUG}.md`);
const PAGE_DONE = path.join(DOCS, 'runs', 'finished', `260929_${SLUG}.md`);
const CLOSED = '2026-09-29T12:00:00Z';
const MODEL = 'claude-opus-5-5';
const PAPERCLIP_ID = '0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b';

const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); };
const config = (language) => put(path.join(PROJECT, '.claude', 'task-flow.json'), { docsDir: 'docs', language, tasksFile: 'tasks.md' });
put(path.join(DOCS, 'tasks.md'), '# tasks\n');
put(path.join(DOCS, 'plans', 'p.plan.md'), '# Plan\n\n## T1 · first\n- [x] **Done** — built\n\n## T2 · second\n- [x] **Done** — built\n');

const state = (extra) => ({
  task: SLUG, mode: 'auto', phase: 'done', status: 'done', approvedBy: 'x', created: '2026-09-29',
  updated: CLOSED, phaseChangedAt: CLOSED, startedAt: '2026-09-29T09:00:00Z', size: { points: 3 },
  artifacts: { plan: 'plans/p.plan.md' }, outcome: 'merged', ...extra,
});
function reset(s, language = 'PT-PT') {
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.rmSync(path.join(DOCS, 'runs'), { recursive: true, force: true });
  config(language);
  put(path.join(STATE, SLUG, 'state.json'), s);
}
const page = () => (fs.existsSync(PAGE) ? fs.readFileSync(PAGE, 'utf8') : fs.existsSync(PAGE_DONE) ? fs.readFileSync(PAGE_DONE, 'utf8') : null);
const seed = (rows) => put(LOOPS, `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`);

function loop(over = {}) {
  return {
    v: 1, source: 'taskflow', run: SLUG, id: 'a1', agentType: 'task-flow:security-auditor', phase: 'build', task: 'T1',
    round: null, model: MODEL, effort: 'low', startedAt: '2026-09-29T09:10:00Z', durationS: 125,
    tokens: { input: 100, cacheCreate: 200, cacheRead: 5000, output: 50 }, costCents: null,
    outcome: 'ok', tests: 'green', critical: 0, required: 1, reason: null, backfill: false, ...over,
  };
}
const ROWS = [
  // written out of start order on purpose: the page sorts by startedAt
  loop({ id: 'b2', agentType: 'general-purpose', task: 'T2', effort: 'high', startedAt: '2026-09-29T09:20:00Z', durationS: 3725, tokens: { input: 1000, cacheCreate: 0, cacheRead: 0, output: 234 }, outcome: 'retry', tests: 'red', critical: null, required: null }),
  loop(),
  loop({ id: 'c3', agentType: 'task-flow:code-reviewer', phase: 'review', task: '', round: 2, model: null, effort: null, startedAt: '2026-09-29T10:00:00Z', durationS: null, tokens: null, reason: 'no-transcript', outcome: null, tests: null, critical: null, required: null }),
];
function rendered(rows, language = 'PT-PT', stateExtra = {}) {
  reset(state(stateExtra), language);
  if (rows) seed(rows);
  renderAll({ projectDir: PROJECT });
  return page();
}
const loopsPart = (text) => {
  const from = text.indexOf('## Loops');
  const next = text.indexOf('\n## ', from + 1);
  return from < 0 ? '' : text.slice(from, next < 0 ? undefined : next);
};

// --- 1. the section, pt-PT, after "Saúde da run" (RF-030) -----------------------------------
let text = rendered(ROWS);
let part = loopsPart(text);
check('pt-PT: the section exists', part !== '', text);
check('pt-PT: right after "Saúde da run", before "Desfecho"', text.indexOf('## Saúde da run') >= 0 && text.indexOf('## Saúde da run') < text.indexOf('## Loops') && text.indexOf('## Loops') < text.indexOf('## Desfecho'), text);
check('pt-PT: the column header', part.includes('| Fase | Tarefa | Ronda | Agente | Modelo | Effort | Duração | Tokens frescos | Resultado |'), part);
const tableRows = part.split('\n').filter((line) => line.startsWith('| build') || line.startsWith('| review'));
check('one row per loop, by start order', tableRows.length >= 3 && tableRows[0].includes('`task-flow:security-auditor`') && tableRows[1].includes('`general-purpose`') && tableRows[2].includes('`task-flow:code-reviewer`'), part);
check('row: phase, task, no round, agent and model in code spans, effort, duration, fresh tokens', tableRows[0] === `| build | T1 | — | \`task-flow:security-auditor\` | \`${MODEL}\` | low | 2 min 05 s | 350 | ok · testes verdes · critical 0 · required 1 |`, tableRows[0]);
check('row: an hour-long loop, the result in pt-PT', tableRows[1] === `| build | T2 | — | \`general-purpose\` | \`${MODEL}\` | high | 1 h 02 min | 1234 | repetir · testes vermelhos |`, tableRows[1]);
check('row: nulls are dashes, the reason a fixed phrase, the round shown', tableRows[2] === '| review | — | 2 | `task-flow:code-reviewer` | — | — | — | — (sem transcript) | — |', tableRows[2]);
check('pt-PT: the split by phase with the overlap note', part.includes('### Por fase') && part.includes('As durações sobrepõem-se'), part);
check('split: build sums tokens and durations of its loops', part.includes('| build | 2 | 1584 | 1 h 04 min |'), part);
check('split: review with no tokens and no duration shows dashes', part.includes('| review | 1 | — | — |'), part);

// --- 2. en and the fallback ----------------------------------------------------------------
text = rendered(ROWS, 'EN');
part = loopsPart(text);
check('en: header and after "Run health"', part.includes('| Phase | Task | Round | Agent | Model | Effort | Duration | Fresh tokens | Result |') && text.indexOf('## Run health') < text.indexOf('## Loops'), part);
check('en: result and reason phrases', part.includes('ok · tests green · critical 0 · required 1') && part.includes('retry · tests red') && part.includes('— (no transcript)'), part);
check('en: split heading and note', part.includes('### By phase') && part.includes('Durations overlap'), part);
text = rendered(ROWS, 'FR');
check('fr falls back to English', loopsPart(text).includes('Fresh tokens') && !text.includes('Tokens frescos'));

// --- 3. no rows: the page of today, byte for byte (RF-031) ---------------------------------
const without = rendered(null);
check('no loops.jsonl: no section', !without.includes('## Loops'));
fs.rmSync(path.join(DOCS, 'runs'), { recursive: true, force: true });
seed([loop({ run: 'another-run' })]);
renderAll({ projectDir: PROJECT });
check('rows of another run only: page identical byte for byte', page() === without);
fs.rmSync(path.join(DOCS, 'runs'), { recursive: true, force: true });
put(LOOPS, '');
renderAll({ projectDir: PROJECT });
check('an empty loops.jsonl: page identical byte for byte', page() === without);

process.env.TASK_FLOW_METRICS = 'off';
const offWithout = rendered(null);
const offWith = rendered(ROWS);
delete process.env.TASK_FLOW_METRICS;
check('TASK_FLOW_METRICS=off: no section, identical to the page without rows', !offWith.includes('## Loops') && offWith === offWithout);

// --- 4. a paperclip run: phase plan, status blocked (RF-032) -------------------------------
const PAPERCLIP_ROWS = [loop({ source: 'paperclip', id: PAPERCLIP_ID, agentType: 'unknown', phase: 'build', task: '', effort: null, costCents: 42, tokens: { input: 10, cacheCreate: 0, cacheRead: 0, output: 5 } })];
text = rendered(PAPERCLIP_ROWS, 'PT-PT', { phase: 'plan', status: 'blocked' });
part = loopsPart(text);
check('paperclip run (plan/blocked): the same section, no health', part !== '' && !text.includes('## Saúde da run'), text);
check('paperclip row: unknown agent in a code span, tokens counted', part.includes('| build | — | — | `unknown` |') && part.includes('| 15 |'), part);
check('a running run shows its loops too', loopsPart(rendered(ROWS, 'PT-PT', { phase: 'build', status: 'running' })) !== '');

// --- 5. a reused folder name: rows from before the state's startedAt are not this run's ----
text = rendered([loop({ id: 'old1', startedAt: '2026-09-20T09:00:00Z' }), loop({ id: 'nostart', startedAt: null }), loop()]);
part = loopsPart(text);
check('older rows of the same folder name are left out', part.split('\n').filter((line) => line.startsWith('| build | T1 |')).length === 1 && part.includes('| build | 1 | 350 | 2 min 05 s |'), part);
check('only older rows: no section at all', !rendered([loop({ startedAt: '2026-09-20T09:00:00Z' })]).includes('## Loops'));
const noStart = state(); delete noStart.startedAt;
reset(noStart);
seed([loop({ id: 'nostart', task: 'T2', startedAt: null }), loop({ id: 'old1', startedAt: '2026-09-20T09:00:00Z' })]);
renderAll({ projectDir: PROJECT });
const shown = loopsPart(page()).split('\n').filter((line) => /^\| build \| T[12] \|/.test(line));
check('state without startedAt: every row of the folder is shown, nulls last', shown.length === 2 && shown[0].startsWith('| build | T1 |') && shown[1].startsWith('| build | T2 |'), loopsPart(page()));

// --- 6. buildDocument: rows passed in are checked again; nothing else prints --------------
const args = { state: state(), slug: SLUG, tasks: [], questions: null, openQuestions: 0, depth: 1, artifacts: {}, created: '2026-09-29', lang: 'en' };
check('buildDocument without loops: no section', !buildDocument(args).includes('## Loops'));
check('buildDocument with a row out of shape only: no section', !buildDocument({ ...args, loops: [{ ...loop(), phase: 'nope' }] }).includes('## Loops'));
check('buildDocument with loops on a running run: the section', buildDocument({ ...args, state: state({ phase: 'build' }), loops: [loop()] }).includes('## Loops'));

// --- 7. a close in the same render shows its fresh loop rows -------------------------------
// (the cache of loops.jsonl is dropped after a close, as the history's is)
reset(state());
// a run listed before this one reads loops.jsonl first, so the cache is warm at the close
put(path.join(STATE, 'a-run', 'state.json'), state({ task: 'a-run', phase: 'build', status: 'running' }));
seed([loop({ run: 'a-run' })]);
const metrics = require('../plugin/scripts/metrics.js');
const realClose = metrics.closeRun;
metrics.closeRun = (options) => {
  const result = realClose(options);
  metrics.appendLoopRows(PROJECT, STATE, [loop({ id: 'late1' })]);
  return result;
};
renderAll({ projectDir: PROJECT });
metrics.closeRun = realClose;
check('rows appended by the close are on the page of the same render', loopsPart(page()).includes('| build | T1 |'), page());

fs.rmSync(TEST_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
