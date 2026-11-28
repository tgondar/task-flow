#!/usr/bin/env node
// Functional tests for `metrics.js backfill` (plan T13, spec 6.5, RF-050..RF-052): the subagent
// transcripts a project already has become loop rows with `backfill: true`. What these hold is the
// attribution - the run is the ONE run whose window (startedAt..phaseChangedAt) holds the loop's
// first record, else `unknown`; the phase comes from that run's phaseLog, else `unknown`; the
// agent type only from agent-<id>.meta.json's `agentType`, else `unknown`; task, round and result
// empty - and that it is idempotent (a second call, or a loop already measured at a close, adds
// nothing) and never touches a state.json. The hostile cases (links, giant or hostile meta files,
// hostile state.json, extra arguments, the exhausted budget) live in the security suite.
// Everything is synthetic under a throwaway HOME.
//
// Run: node tests/metrics.backfill.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-backfill-'));
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

const METRICS = path.resolve(__dirname, '../plugin/scripts/metrics.js');
const metrics = require(METRICS);
const { backfillLoops, readLoops, appendLoopRows, validateLoopRow, appendLoopEvent } = metrics;
check('backfillLoops is exported', typeof backfillLoops === 'function');
if (typeof backfillLoops !== 'function') { console.log(`\n${passed} passed, ${failures.length} failed`); process.exit(1); }

const PROJECT = path.join(TEST_HOME, 'work', 'proj');
const STATE = path.join(PROJECT, '.claude', 'task-flow');
const LOOPS = path.join(STATE, 'loops.jsonl');
const SUBAGENTS = path.join(TEST_HOME, '.claude', 'projects', PROJECT.replace(/[^A-Za-z0-9]/g, '-'), 'sess1', 'subagents');
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); };
const usage = (input, output, cacheCreate = 0, cacheRead = 0) => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheCreate, cache_read_input_tokens: cacheRead });
const asst = (ts, requestId, u, extra = {}) => ({ type: 'assistant', timestamp: ts, requestId, message: { model: 'claude-opus-5-5', usage: u, content: [{ type: 'text', text: 'TRANSCRIPT TEXT' }] }, ...extra });
const user = (ts) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: 'do the thing' } });
/** A loop: its transcript, and its meta.json when `type` is given (undefined: no meta file). */
function loop(id, records, type) {
  put(path.join(SUBAGENTS, `agent-${id}.jsonl`), `${records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`);
  if (type !== undefined) put(path.join(SUBAGENTS, `agent-${id}.meta.json`), { agentType: type, description: 'META DESCRIPTION', isBuiltIn: false });
}
const run = (name, state) => put(path.join(STATE, name, 'state.json'), { task: name, status: 'done', phase: 'done', created: '2026-01-01', ...state });
const stateBytes = () => fs.readdirSync(STATE).filter((n) => fs.existsSync(path.join(STATE, n, 'state.json'))).sort()
  .map((n) => `${n}:${fs.readFileSync(path.join(STATE, n, 'state.json'), 'utf8')}`).join('\n');
const rows = () => readLoops(PROJECT, STATE).rows;
const byId = (id) => rows().find((row) => row.id === id);

function setup() {
  fs.rmSync(PROJECT, { recursive: true, force: true });
  fs.rmSync(path.join(TEST_HOME, '.claude'), { recursive: true, force: true });
  put(path.join(PROJECT, '.claude', 'task-flow.json'), { docsDir: 'docs', language: 'PT-PT', tasksFile: 'tasks.md' });
  put(path.join(PROJECT, 'docs', 'tasks.md'), '# tasks\n');
  // run-a: a window and a phaseLog (spec and plan completed before 10:30, build after 11:30)
  run('run-a', {
    startedAt: '2026-01-01T10:00:00Z', phaseChangedAt: '2026-01-01T12:00:00Z',
    phaseLog: [{ phase: 'spec', at: '2026-01-01T10:10:00Z' }, { phase: 'plan', at: '2026-01-01T10:20:00Z' }, { phase: 'build', at: '2026-01-01T11:30:00Z' }],
  });
  // run-b: a window, no phaseLog
  run('run-b', { startedAt: '2026-01-02T10:00:00Z', phaseChangedAt: '2026-01-02T12:00:00Z' });
  // run-c and run-d: overlapping windows
  run('run-c', { startedAt: '2026-01-03T10:00:00Z', phaseChangedAt: '2026-01-03T12:00:00Z' });
  run('run-d', { startedAt: '2026-01-03T11:00:00Z', phaseChangedAt: '2026-01-03T13:00:00Z' });
}

// --- 1. one backfill over loops of every kind (RF-050, RF-051, SC-007) ----------------------------
{
  setup();
  // aaa1: in run-a, during build; a plugin agent with no effort field -> its definition's effort
  loop('aaa1', [
    user('2026-01-01T10:30:00Z'),
    asst('2026-01-01T10:30:05Z', 'req_1', usage(5, 10, 100, 1000)),
    asst('2026-01-01T10:30:06Z', 'req_1', usage(5, 120, 100, 1000)),
    asst('2026-01-01T10:32:00Z', 'req_2', usage(7, 30, 0, 2000)),
  ], 'task-flow:code-reviewer');
  // aaa2: in run-a, after build completed -> tests
  loop('aaa2', [asst('2026-01-01T11:45:00Z', 'req_3', usage(1, 1))], 'general-purpose');
  // bbb1: in run-b (no phaseLog); records carry effort high; another model once
  loop('bbb1', [
    asst('2026-01-02T10:00:00Z', 'req_4', usage(1, 1), { effort: 'high' }),
    asst('2026-01-02T10:00:10Z', 'req_5', usage(1, 1), { effort: 'high' }),
    asst('2026-01-02T10:00:20Z', 'req_6', usage(1, 1), { effort: 'low', message: { model: 'claude-haiku-5', usage: usage(1, 1) } }),
  ], 'general-purpose');
  loop('ccc1', [asst('2026-01-03T11:30:00Z', 'req_7', usage(2, 2))], 'Explore'); // inside run-c AND run-d
  loop('ddd1', [asst('2025-06-01T09:00:00Z', 'req_8', usage(3, 3))], 'task-flow:security-auditor'); // outside every window
  loop('eee1', [asst('2026-01-01T10:40:00Z', 'req_9', usage(4, 4))]); // no meta.json
  loop('fff1', [asst('2026-01-01T10:41:00Z', 'req_10', usage(4, 4))], 'not a type!'); // agentType out of shape
  loop('ggg1', ['not json', JSON.stringify(user('2026-01-01T10:42:00Z'))], 'general-purpose'); // no usage at all
  // an old transcript: no mtime filter
  const old = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(path.join(SUBAGENTS, 'agent-ddd1.jsonl'), old, old);
  const before = stateBytes();

  const r = backfillLoops({ projectDir: PROJECT });
  check('a backfill with new loops: code written, eight rows', r.code === 'written' && r.written === 8 && rows().length === 8, JSON.stringify(r));
  check('the result has only code and written', Object.keys(r).sort().join() === 'code,written', JSON.stringify(r));

  const a1 = byId('aaa1') || {};
  check('aaa1: run-a (the one window holding its first record), phase build from the phaseLog', a1.run === 'run-a' && a1.phase === 'build', JSON.stringify(a1));
  check('aaa1: tokens deduplicated by requestId with the max', JSON.stringify(a1.tokens) === JSON.stringify({ input: 12, cacheCreate: 100, cacheRead: 3000, output: 150 }), JSON.stringify(a1.tokens));
  check('aaa1: duration from first to last timestamp, startedAt the first record', a1.durationS === 120 && a1.startedAt === '2026-01-01T10:30:00.000Z', `${a1.durationS} ${a1.startedAt}`);
  check('aaa1: agentType from meta.json, effort from AGENT_EFFORT, model', a1.agentType === 'task-flow:code-reviewer' && a1.effort === 'low' && a1.model === 'claude-opus-5-5', JSON.stringify(a1));
  check('aaa1: backfill true, source taskflow; task, round and result empty', a1.backfill === true && a1.source === 'taskflow' && a1.task === ''
    && a1.round === null && a1.outcome === null && a1.tests === null && a1.critical === null && a1.required === null && a1.costCents === null && a1.reason === null, JSON.stringify(a1));
  check('aaa2: after the build completed -> phase tests', (byId('aaa2') || {}).phase === 'tests', JSON.stringify(byId('aaa2')));

  const b1 = byId('bbb1') || {};
  check('bbb1: run-b, phase unknown (no phaseLog)', b1.run === 'run-b' && b1.phase === 'unknown', JSON.stringify(b1));
  check('bbb1: effort from the records (most frequent), model most frequent', b1.effort === 'high' && b1.model === 'claude-opus-5-5', JSON.stringify(b1));
  check('bbb1: a loop starting exactly at the window start is inside it', b1.startedAt === '2026-01-02T10:00:00.000Z' && b1.run === 'run-b');

  check('ccc1: inside two windows -> run unknown, phase unknown', (byId('ccc1') || {}).run === 'unknown' && byId('ccc1').phase === 'unknown', JSON.stringify(byId('ccc1')));
  check('ddd1: outside every window (and an old mtime) -> run unknown, still measured', (byId('ddd1') || {}).run === 'unknown' && byId('ddd1').tokens !== null && byId('ddd1').effort === 'low', JSON.stringify(byId('ddd1')));
  check('eee1: no meta.json -> agentType unknown, effort unknown', (byId('eee1') || {}).agentType === 'unknown' && byId('eee1').effort === 'unknown' && byId('eee1').run === 'run-a', JSON.stringify(byId('eee1')));
  check('fff1: agentType out of shape -> unknown', (byId('fff1') || {}).agentType === 'unknown', JSON.stringify(byId('fff1')));
  const g1 = byId('ggg1') || {};
  check('ggg1: no usable record -> a row with tokens null and reason unreadable-format, run unknown', g1.tokens === null && g1.reason === 'unreadable-format'
    && g1.run === 'unknown' && g1.phase === 'unknown' && g1.startedAt === null && g1.durationS === null && g1.model === null && g1.effort === null && g1.agentType === 'general-purpose', JSON.stringify(g1));

  check('SC-007: every row passes the one loop validator', rows().every((row) => validateLoopRow(row).ok));
  const text = fs.readFileSync(LOOPS, 'utf8');
  check('nothing of the messages or of meta.json description in loops.jsonl', !/TRANSCRIPT TEXT|META DESCRIPTION|do the thing/.test(text));
  check('RF-052: every state.json byte for byte the same', stateBytes() === before);

  // --- 2. idempotent (RF-052) ---------------------------------------------------------------------
  const again = backfillLoops({ projectDir: PROJECT });
  check('a second backfill: up-to-date, nothing appended', again.code === 'up-to-date' && again.written === 0 && fs.readFileSync(LOOPS, 'utf8') === text, JSON.stringify(again));
  loop('hhh1', [asst('2026-01-02T11:00:00Z', 'req_11', usage(1, 1))], 'general-purpose');
  const more = backfillLoops({ projectDir: PROJECT });
  check('a new transcript later: only it is added', more.code === 'written' && more.written === 1 && rows().length === 9 && (byId('hhh1') || {}).run === 'run-b', JSON.stringify(more));
  check('the rows written before are unchanged', fs.readFileSync(LOOPS, 'utf8').startsWith(text));
  check('RF-052: state.json still the same after three calls', stateBytes() === before);
}

// --- 3. a loop already measured at a close is not backfilled (RF-052, any run) ----------------------
{
  setup();
  loop('kkk1', [asst('2026-01-01T10:30:00Z', 'req_1', usage(1, 1))], 'general-purpose');
  loop('kkk2', [asst('2026-01-01T10:31:00Z', 'req_2', usage(1, 1))], 'general-purpose');
  const closed = {
    v: 1, source: 'taskflow', run: 'run-b', id: 'kkk1', agentType: 'general-purpose', phase: 'build', task: 'T1', round: null, model: 'claude-opus-5-5',
    effort: 'high', startedAt: '2026-01-01T10:30:00Z', durationS: 1, tokens: { input: 9, cacheCreate: 0, cacheRead: 0, output: 9 }, costCents: null,
    outcome: 'ok', tests: null, critical: null, required: null, reason: null, backfill: false,
  };
  appendLoopRows(PROJECT, STATE, [closed, { ...closed, source: 'paperclip', id: '0b1a2c3d-0000-4000-8000-000000000001', run: 'run-a' }]);
  const r = backfillLoops({ projectDir: PROJECT });
  check('a loop with a close row (even under another run) is skipped; the other one is added', r.code === 'written' && r.written === 1
    && rows().filter((row) => row.id === 'kkk1').length === 1 && byId('kkk1').backfill === false && (byId('kkk2') || {}).backfill === true, JSON.stringify(rows().map((x) => [x.id, x.run])));
  check('a paperclip row is never a reason to skip, nor touched', rows().some((row) => row.source === 'paperclip'));
}

// --- 4. a loop of a run still going is left to its close ---------------------------------------------
{
  setup();
  run('live', { status: 'running', phase: 'plan', buildCursor: 'T2', startedAt: '2026-01-05T10:00:00Z', phaseChangedAt: '2026-01-05T10:00:00Z' });
  // the start event, written by the hook's writer, as in a real run
  const w = appendLoopEvent({ projectDir: PROJECT, payload: { agent_id: 'lll1', agent_type: 'general-purpose' }, env: {} });
  loop('lll1', [asst('2026-01-05T11:00:00Z', 'req_1', usage(1, 1))], 'general-purpose');
  loop('lll2', [asst('2026-01-05T11:00:00Z', 'req_2', usage(1, 1))], 'general-purpose');
  const r = backfillLoops({ projectDir: PROJECT });
  check('a loop with a start event in a running run: skipped (its close will measure it)', w.ok === true && r.written === 1 && !byId('lll1') && !!byId('lll2'), JSON.stringify([w, r]));
}

// --- 5. nothing to do ------------------------------------------------------------------------------
{
  setup();
  const r = backfillLoops({ projectDir: PROJECT });
  check('no transcript folder: code no-transcripts, no loops.jsonl created', r.code === 'no-transcripts' && r.written === 0 && !fs.existsSync(LOOPS), JSON.stringify(r));
  fs.mkdirSync(SUBAGENTS, { recursive: true });
  const empty = backfillLoops({ projectDir: PROJECT });
  check('a transcript folder with no transcript: up-to-date, no file created', empty.code === 'up-to-date' && !fs.existsSync(LOOPS), JSON.stringify(empty));
  fs.rmSync(path.join(PROJECT, '.claude', 'task-flow.json'));
  check('no configuration: bad-config', backfillLoops({ projectDir: PROJECT }).code === 'bad-config');
  check('a relative projectDir: invalid', backfillLoops({ projectDir: 'work/proj' }).code === 'invalid');
}

// --- 6. the CLI ------------------------------------------------------------------------------------
{
  setup();
  loop('mmm1', [asst('2026-01-01T10:30:00Z', 'req_1', usage(1, 1))], 'general-purpose');
  const env = { ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME, LOCALAPPDATA: TEST_HOME, XDG_STATE_HOME: TEST_HOME, CLAUDE_PROJECT_DIR: path.join(TEST_HOME, 'work') };
  delete env.TASK_FLOW_METRICS;
  const cli = (args, extra = {}) => cp.spawnSync(process.execPath, [METRICS, ...args], { encoding: 'utf8', shell: false, timeout: 90000, env: { ...env, ...extra } });

  const off = cli(['backfill', '--project-dir', PROJECT], { TASK_FLOW_METRICS: 'off' });
  check('TASK_FLOW_METRICS=off: exit 0, one fixed line, nothing written', off.status === 0 && off.stdout === 'metrics: disabled backfill\n' && off.stderr === '' && !fs.existsSync(LOOPS), JSON.stringify(off));
  const first = cli(['backfill', '--project-dir', PROJECT]);
  check('backfill --project-dir: exit 0, metrics: written backfill', first.status === 0 && first.stdout === 'metrics: written backfill\n' && first.stderr === '' && !!byId('mmm1'), JSON.stringify(first));
  const second = cli(['backfill', '--project-dir', PROJECT]);
  check('again: exit 0, metrics: up-to-date backfill', second.status === 0 && second.stdout === 'metrics: up-to-date backfill\n' && rows().length === 1, JSON.stringify(second));
  const byEnv = cli(['backfill'], { CLAUDE_PROJECT_DIR: PROJECT });
  check('without --project-dir: CLAUDE_PROJECT_DIR is the project', byEnv.status === 0 && byEnv.stdout === 'metrics: up-to-date backfill\n', JSON.stringify(byEnv));
  const usage2 = cli(['frobnicate']);
  check('the usage text names backfill; an unknown command is still exit 2', usage2.status === 2 && /^usage: metrics\.js close/.test(usage2.stderr) && usage2.stderr.includes('metrics.js backfill [--project-dir <dir>]'), usage2.stderr);
}

fs.rmSync(TEST_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
