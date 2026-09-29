#!/usr/bin/env node
// Cross-cutting hardening of the run-health close inside renderAll (harden phase).
// renderAll runs on every Stop-hook turn and visits EVERY finished run, so its cost is
// the sum over runs: (1) a close that keeps failing must not be retried for every run in
// the same render (the hook has 15 s), (2) a run already in the history must not cost a
// closeRun (and a second read of the history) each. Synthetic, under a throwaway HOME.
//
// Run: node tests/metrics.hardening.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-mhard-'));
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

const { renderAll } = require('../plugin/scripts/render-run.js');
const metrics = require('../plugin/scripts/metrics.js');

const PROJECT = path.join(TEST_HOME, 'work', 'proj');
const STATE = path.join(PROJECT, '.claude', 'task-flow');
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); };
const CLOSED = '2026-09-29T12:00:00Z';
const MODEL = 'claude-opus-5-5';
const RUNS = 8;

function setup() {
  fs.rmSync(PROJECT, { recursive: true, force: true });
  put(path.join(PROJECT, '.claude', 'task-flow.json'), { docsDir: 'docs', language: 'en', tasksFile: 'tasks.md' });
  put(path.join(PROJECT, 'docs', 'tasks.md'), '# tasks\n');
  for (let i = 0; i < RUNS; i += 1) {
    put(path.join(STATE, `run-${i}`, 'state.json'), {
      task: `run-${i}`, mode: 'auto', phase: 'done', status: 'done', approvedBy: 'x', created: '2026-09-29',
      updated: CLOSED, phaseChangedAt: CLOSED, startedAt: '2026-09-29T09:00:00Z',
    });
  }
}
const row = (run) => ({
  v: 1, run, created: '2026-09-29', closedAt: CLOSED, outcome: 'done', mode: 'auto', primaryModel: MODEL, models: [MODEL], sizePoints: null,
  tasks: null, tests: null, review: null, hardenFindings: null, questions: null, code: null,
  tokens: null, tokensNull: 'no-transcripts', agent: null,
});

const real = metrics.closeRun;
let calls = 0;

// 1. a close that fails slowly (unwritable history: collect ran, the append did not)
setup();
calls = 0;
metrics.closeRun = () => { calls += 1; const end = Date.now() + 1500; while (Date.now() < end); return { ok: false, code: 'write-failed' }; };
const t0 = Date.now();
const out = renderAll({ projectDir: PROJECT });
const spent = Date.now() - t0;
metrics.closeRun = real;
check('render still lists every run', out.rendered.length + out.archived.length === RUNS, JSON.stringify(out));
check('a permanently failing close is not retried for every run in one render', calls >= 1 && calls <= 3, `calls=${calls}`);
check('and the render stays far below the hook timeout', spent < 8000, `${spent} ms`);

// 2. runs already measured cost no closeRun at all
setup();
put(path.join(STATE, 'metrics.jsonl'), `${Array.from({ length: RUNS }, (_, i) => JSON.stringify(row(`run-${i}`))).join('\n')}\n`);
calls = 0;
metrics.closeRun = (...args) => { calls += 1; return real(...args); };
renderAll({ projectDir: PROJECT });
metrics.closeRun = real;
check('finished runs already in the history do not call closeRun', calls === 0, `calls=${calls}`);
const page = fs.readdirSync(path.join(PROJECT, 'docs', 'runs', 'finished')).map((f) => fs.readFileSync(path.join(PROJECT, 'docs', 'runs', 'finished', f), 'utf8'));
check('and their pages still show the health section', page.length === RUNS && page.every((p) => p.includes('## Run health')));

fs.rmSync(TEST_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
