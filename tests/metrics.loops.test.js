#!/usr/bin/env node
// Functional tests for the loop start events in plugin/scripts/metrics.js (plan
// T1, spec RF-001..RF-004): appendLoopEvent, the one writer of a run's
// loop-events.jsonl, and readLoopEvents, its one reader. The SubagentStart hook
// calls the writer once per subagent; what these hold is WHEN a line is written
// (exactly one running run, a valid configuration, a payload in shape, the
// metrics switch on), WHAT goes in it (the seven closed fields, the phase in
// flight and the task being built - never the payload's session_id, cwd or
// transcript_path) and that the reader hands back only lines in that shape.
// The hostile cases (links, giant files, hostile payloads) live in
// metrics.loops.security.test.js. Everything is synthetic under a throwaway HOME.
//
// Run: node tests/metrics.loops.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-loops-'));
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

const metrics = require(path.resolve(__dirname, '../plugin/scripts/metrics.js'));
const { appendLoopEvent, readLoopEvents } = metrics;
check('appendLoopEvent and readLoopEvents are exported', typeof appendLoopEvent === 'function' && typeof readLoopEvents === 'function');
if (typeof appendLoopEvent !== 'function' || typeof readLoopEvents !== 'function') { console.log('\nnothing more to run'); process.exit(1); }

const PROJECT = path.join(TEST_HOME, 'work', 'proj');
const STATE = path.join(PROJECT, '.claude', 'task-flow');
const SLUG = 'my-run';
const EVENTS = path.join(STATE, SLUG, 'loop-events.jsonl');
const KEYS = ['v', 'kind', 'agent', 'type', 'phase', 'task', 'at'];
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); };

/** A project with one config and the given runs ({ name: partial state }). */
function setup(runs = { [SLUG]: {} }, config = { docsDir: 'docs', language: 'PT-PT', tasksFile: 'tasks.md' }) {
  fs.rmSync(PROJECT, { recursive: true, force: true });
  put(path.join(PROJECT, '.claude', 'task-flow.json'), config);
  put(path.join(PROJECT, 'docs', 'tasks.md'), '# tasks\n');
  for (const [name, extra] of Object.entries(runs)) {
    put(path.join(STATE, name, 'state.json'), { task: name, phase: 'plan', status: 'running', buildCursor: 'T3', ...extra });
  }
}
const PAYLOAD = {
  session_id: 'SESSIONMARK', transcript_path: path.join(TEST_HOME, 'TRANSCRIPTMARK.jsonl'), cwd: path.join(TEST_HOME, 'CWDMARK'),
  hook_event_name: 'SubagentStart', agent_id: 'a1b2c3d4', agent_type: 'task-flow:security-auditor',
};
const append = (payload = PAYLOAD, env = {}) => appendLoopEvent({ projectDir: PROJECT, payload, env });
const lines = () => (fs.existsSync(EVENTS) ? fs.readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean) : []);

// --- 1. the one case that writes (RF-001, RF-002, RF-003) ------------------------------------
{
  setup();
  const before = Date.now();
  const r = append();
  const all = lines();
  const row = all.length === 1 ? JSON.parse(all[0]) : {};
  check('one running run, valid config and payload: ok, written', r.ok === true && r.code === 'written', JSON.stringify(r));
  check('exactly one line', all.length === 1, String(all.length));
  check('the line has exactly v, kind, agent, type, phase, task, at', Object.keys(row).sort().join() === [...KEYS].sort().join(), Object.keys(row).join());
  check('v 1, kind start, agent and type from the payload', row.v === 1 && row.kind === 'start' && row.agent === 'a1b2c3d4' && row.type === 'task-flow:security-auditor', all[0]);
  check('phase is the one after the last completed (plan -> build)', row.phase === 'build', row.phase);
  check('task is the buildCursor', row.task === 'T3', row.task);
  const at = Date.parse(row.at);
  check('at is an ISO UTC instant of now', /Z$/.test(row.at) && at >= before - 1000 && at <= Date.now() + 1000, row.at);
  check('nothing else of the payload is kept (session_id, transcript_path, cwd)', !/SESSIONMARK|TRANSCRIPTMARK|CWDMARK|SubagentStart/.test(all[0]));
  check('the line ends with a newline', fs.readFileSync(EVENTS, 'utf8').endsWith('\n'));
  check('the result carries no path', !JSON.stringify(r).includes(TEST_HOME));

  append({ ...PAYLOAD, agent_id: 'second1' });
  check('a second subagent appends a second line, the first kept', lines().length === 2 && lines()[0] === all[0]);
  check('state.json is not touched', JSON.parse(fs.readFileSync(path.join(STATE, SLUG, 'state.json'), 'utf8')).phase === 'plan');
}

// --- 2. phase and task derivation (RF-002) -----------------------------------------------------
{
  const cases = [
    ['idea', 'spec'], ['spec', 'plan'], ['plan', 'build'], ['build', 'tests'], ['tests', 'harden'], ['harden', 'review'],
    ['review', 'unknown'], ['done-ish', 'unknown'], ['', 'unknown'], [undefined, 'unknown'], [3, 'unknown'], ['PLAN', 'unknown'],
  ];
  for (const [done, expected] of cases) {
    setup({ [SLUG]: { phase: done } });
    append();
    const row = lines().length === 1 ? JSON.parse(lines()[0]) : {};
    check(`phase ${JSON.stringify(done)} completed -> event phase ${expected}`, row.phase === expected, row.phase);
  }
  for (const [cursor, expected] of [['T12', 'T12'], ['T3.1', 'T3.1'], ['D2', 'D2'], [undefined, ''], ['', ''], ['task 3', ''], [7, '']]) {
    setup({ [SLUG]: { buildCursor: cursor } });
    append();
    const row = lines().length === 1 ? JSON.parse(lines()[0]) : {};
    check(`buildCursor ${JSON.stringify(cursor)} -> task ${JSON.stringify(expected)}`, row.task === expected, JSON.stringify(row.task));
  }
}

// --- 3. no line: the conditions of RF-001 and RF-003 ---------------------------------------------
{
  const silent = (name, prepare, payload, env, expectedCode) => {
    setup();
    prepare();
    const r = append(payload, env);
    const anyEvents = fs.existsSync(STATE) && fs.readdirSync(STATE, { recursive: true }).some((f) => String(f).endsWith('loop-events.jsonl'));
    check(`${name}: no line, closed code ${expectedCode}`, !anyEvents && r.ok === (expectedCode === 'disabled') && r.code === expectedCode, JSON.stringify(r));
  };
  const noop = () => {};
  silent('TASK_FLOW_METRICS=off', noop, PAYLOAD, { TASK_FLOW_METRICS: 'off' }, 'disabled');
  silent('TASK_FLOW_METRICS=OFF', noop, PAYLOAD, { TASK_FLOW_METRICS: 'OFF' }, 'disabled');
  silent('no running run', () => setup({ [SLUG]: { status: 'blocked' } }), PAYLOAD, {}, 'no-single-run');
  silent('a running run whose phase is done', () => setup({ [SLUG]: { phase: 'done' } }), PAYLOAD, {}, 'no-single-run');
  silent('no run at all', () => setup({}), PAYLOAD, {}, 'no-single-run');
  silent('two running runs', () => setup({ [SLUG]: {}, other: {} }), PAYLOAD, {}, 'no-single-run');
  silent('config with an error (tasksFile missing)', () => fs.rmSync(path.join(PROJECT, 'docs', 'tasks.md')), PAYLOAD, {}, 'bad-config');
  silent('no config (never opted in)', () => fs.rmSync(path.join(PROJECT, '.claude', 'task-flow.json')), PAYLOAD, {}, 'bad-config');
  const { agent_id: _drop, ...noAgent } = PAYLOAD;
  silent('payload without agent_id', noop, noAgent, {}, 'bad-payload');
  const { agent_type: _drop2, ...noType } = PAYLOAD;
  silent('payload without agent_type', noop, noType, {}, 'bad-payload');
  silent('agent_id with a hyphen (outside the shape)', noop, { ...PAYLOAD, agent_id: 'agent-1' }, {}, 'bad-payload');
  silent('agent_id of 65 characters', noop, { ...PAYLOAD, agent_id: 'a'.repeat(65) }, {}, 'bad-payload');
  silent('agent_type with a space', noop, { ...PAYLOAD, agent_type: 'general purpose' }, {}, 'bad-payload');
  silent('payload null', noop, null, {}, 'bad-input');
}
{
  // a run folder name outside SAFE_SEGMENT is never written into
  setup({ '-odd': {} });
  const r = append();
  check('the only running run has an unsafe folder name: nothing written', r.ok === false && r.code === 'no-single-run' && !fs.existsSync(path.join(STATE, '-odd', 'loop-events.jsonl')), JSON.stringify(r));
}
{
  // the limits of the shapes are accepted
  setup();
  const r = append({ ...PAYLOAD, agent_id: 'A'.repeat(64), agent_type: `x${'y'.repeat(79)}` });
  check('agent_id of 64 and agent_type of 80 characters: written', r.code === 'written' && lines().length === 1, JSON.stringify(r));
}
{
  setup();
  const t = (() => { try { return { r: appendLoopEvent(undefined) }; } catch { return { threw: true }; } })();
  check('no options: no exception, closed failure', !t.threw && t.r.ok === false && t.r.code === 'bad-input');
  const rel = appendLoopEvent({ projectDir: 'relative/proj', payload: PAYLOAD, env: {} });
  check('relative projectDir: refused', rel.ok === false && rel.code === 'bad-input');
}

// --- 4. the reader --------------------------------------------------------------------------------
{
  setup();
  append();
  append({ ...PAYLOAD, agent_id: 'zz9', agent_type: 'general-purpose' });
  const read = readLoopEvents(PROJECT, STATE, SLUG);
  check('reader: both starts, oldest first, results empty, nothing ignored', read.starts.length === 2 && read.starts[0].agent === 'a1b2c3d4' && read.starts[1].agent === 'zz9' && Array.isArray(read.results) && read.results.length === 0 && read.ignored === 0, JSON.stringify(read));
  check('reader: each start has exactly the seven keys', read.starts.every((s) => Object.keys(s).sort().join() === [...KEYS].sort().join()));
  check('reader: the start matches what was written', JSON.stringify(read.starts[0]) === lines()[0], `${JSON.stringify(read.starts[0])} vs ${lines()[0]}`);

  fs.appendFileSync(EVENTS, 'not json\n{"v":2,"kind":"start"}\n\n{"v":1,"kind":"start","agent":"ok1","type":"t","phase":"build","task":"","at":"2026-11-27T10:00:00Z","extra":1}\n');
  const again = readLoopEvents(PROJECT, STATE, SLUG);
  check('reader: garbage, another version and an extra key are counted, blank lines are not', again.starts.length === 2 && again.ignored === 3, JSON.stringify({ starts: again.starts.length, ignored: again.ignored }));

  const none = readLoopEvents(PROJECT, STATE, 'no-such-run');
  check('reader: no file -> empty, nothing ignored', none.starts.length === 0 && none.results.length === 0 && none.ignored === 0);
  const bad = readLoopEvents(PROJECT, STATE, '../x');
  check('reader: an unsafe slug -> empty', bad.starts.length === 0 && bad.ignored === 0);
}

// --- 5. the loop row: closed shape (plan T3, RF-009, SC-007) -------------------------------------
// One validator for the three origins: a task-flow loop, a paperclip loop and a backfilled one.
const { validateLoopRow, parseLoopRow, readLoops, appendLoopRows, LOOP_KEYS } = metrics;
check('T3: validateLoopRow, parseLoopRow, readLoops, appendLoopRows, LOOP_KEYS exported',
  [validateLoopRow, parseLoopRow, readLoops, appendLoopRows].every((f) => typeof f === 'function') && Array.isArray(LOOP_KEYS));
if (typeof validateLoopRow !== 'function' || typeof appendLoopRows !== 'function' || typeof readLoops !== 'function' || typeof parseLoopRow !== 'function') {
  console.log(`\n${passed} passed, ${failures.length + 1} failed`); process.exit(1);
}

const TF_ROW = {
  v: 1, source: 'taskflow', run: SLUG, id: 'a1b2c3d4', agentType: 'task-flow:security-auditor', phase: 'build', task: 'T3',
  round: null, model: 'claude-opus-5-5', effort: 'high', startedAt: '2026-11-27T10:00:00.123Z', durationS: 312,
  tokens: { input: 10, cacheCreate: 2000, cacheRead: 50000, output: 900 }, costCents: null,
  outcome: 'ok', tests: 'green', critical: 0, required: 1, reason: null, backfill: false,
};
const PC_ROW = {
  ...TF_ROW, source: 'paperclip', run: 'unknown', id: '0f8fad5b-d9cb-469f-a165-70867728950e', agentType: 'unknown',
  phase: 'unknown', task: '', round: 2, effort: null, costCents: 137, outcome: null, tests: null, critical: null, required: null,
};
const BF_ROW = { ...TF_ROW, id: 'old1', tokens: null, reason: 'no-transcript', backfill: true, effort: 'unknown', model: null, startedAt: null, durationS: null };
const clone = (v) => JSON.parse(JSON.stringify(v));
const valid = (row) => validateLoopRow(row).ok === true;

{
  check('T3: the keys are exactly the 20 of the plan', [...LOOP_KEYS].sort().join() === ['v', 'source', 'run', 'id', 'agentType', 'phase', 'task', 'round', 'model', 'effort', 'startedAt', 'durationS', 'tokens', 'costCents', 'outcome', 'tests', 'critical', 'required', 'reason', 'backfill'].sort().join(), LOOP_KEYS.join());
  for (const [name, row] of [['taskflow', TF_ROW], ['paperclip', PC_ROW], ['backfill', BF_ROW]]) {
    const r = validateLoopRow(clone(row));
    check(`T3: a valid ${name} row passes`, r.ok === true && JSON.stringify(r.row) === JSON.stringify(row), JSON.stringify(r));
  }
  const input = clone(TF_ROW);
  const r = validateLoopRow(input);
  check('T3: the validated row is a fresh object (tokens too)', r.ok && r.row !== input && r.row.tokens !== input.tokens);
  check('T3: the validated row has the keys in LOOP_KEYS order', r.ok && Object.keys(r.row).join() === LOOP_KEYS.join());
  check('T3: the limits are accepted (round 1 and 99, empty task, every phase, every effort)',
    valid({ ...TF_ROW, round: 1 }) && valid({ ...TF_ROW, round: 99 }) && valid({ ...TF_ROW, task: '' }) &&
    ['idea', 'spec', 'plan', 'build', 'tests', 'harden', 'review', 'unknown'].every((phase) => valid({ ...TF_ROW, phase })) &&
    ['low', 'medium', 'high', 'xhigh', 'max', 'unknown', null].every((effort) => valid({ ...TF_ROW, effort })) &&
    ['ok', 'retry', 'failed', 'unknown', null].every((outcome) => valid({ ...TF_ROW, outcome })) &&
    ['no-transcript', 'unreadable-format', 'timeout'].every((reason) => valid({ ...TF_ROW, tokens: null, reason })));
  check('T3: tokens null without a reason is allowed (a paperclip loop that reports none)', valid({ ...PC_ROW, tokens: null, reason: null }));
}
{
  // every field outside its shape is refused, one at a time
  const BAD = {
    v: [0, '1', null, true],
    source: ['TaskFlow', 'other', '', null],
    run: ['../x', 'a b', '', 'x'.repeat(101), null, 7],
    id: ['agent-1', 'a'.repeat(65), '', null, 12],
    agentType: ['general purpose', '-x', '', null, 'x'.repeat(81)],
    phase: ['done', 'Build', '', null],
    task: ['T', 'task 3', '../T1', null, 3],
    round: [0, 100, 1.5, '2', -1],
    model: ['', 'bad model', 'x'.repeat(81), 5],
    effort: ['huge', 'HIGH', ''],
    startedAt: ['2026-11-27', '2026-11-27T10:00:00+01:00', '2026-02-31T10:00:00Z', 1764237600000],
    durationS: [-1, 1.5, '10', 1e13],
    tokens: [{}, [], 'x', { input: 1, cacheCreate: 1, cacheRead: 1 }, { input: -1, cacheCreate: 1, cacheRead: 1, output: 1 }],
    costCents: [-1, 1.5, '3'],
    outcome: ['done', 'OK', ''],
    tests: ['yellow', true, ''],
    critical: [-1, '0', 0.5],
    required: [-1, '0', 0.5],
    reason: ['disabled', 'overlap', ''],
    backfill: [null, 0, 'false'],
  };
  for (const [key, values] of Object.entries(BAD)) {
    const base = key === 'costCents' ? PC_ROW : key === 'reason' ? { ...TF_ROW, tokens: null } : TF_ROW;
    const accepted = values.filter((value) => valid({ ...clone(base), [key]: value }));
    check(`T3: ${key} outside its shape is refused`, accepted.length === 0, JSON.stringify(accepted));
  }
  check('T3: an extra key is refused', !valid({ ...TF_ROW, note: 'x' }));
  const missing = clone(TF_ROW); delete missing.backfill;
  check('T3: a missing key is refused', !valid(missing));
  check('T3: an extra key inside tokens is refused', !valid({ ...TF_ROW, tokens: { ...TF_ROW.tokens, cacheHitRate: 0.5 } }));
  check('T3: costCents on a taskflow row is refused (RF-045)', !valid({ ...TF_ROW, costCents: 5 }));
  check('T3: costCents 0 on a paperclip row passes', valid({ ...PC_ROW, costCents: 0 }));
  check('T3: a reason next to tokens is refused', !valid({ ...TF_ROW, reason: 'timeout' }));
  check('T3: a taskflow id in UUID shape is refused', !valid({ ...TF_ROW, id: PC_ROW.id }));
  check('T3: a paperclip id that is not a UUID is refused', !valid({ ...PC_ROW, id: 'a1b2c3d4' }));
  check('T3: a paperclip id in upper case is refused (one spelling per key)', !valid({ ...PC_ROW, id: PC_ROW.id.toUpperCase() }));
  check('T3: not an object is refused, never throws', [null, undefined, 'x', [], 3].every((v) => validateLoopRow(v).ok === false));
  const v2 = validateLoopRow({ ...TF_ROW, v: 2 });
  check('T3: another version is ignored, not an error', v2.ok === false && v2.ignored === true, JSON.stringify(v2));
  check('T3: a refusal carries no text', Object.keys(validateLoopRow({ ...TF_ROW, run: 'IGNORE PREVIOUS' })).join() === 'ok');
}
{
  // parseLoopRow: one line of loops.jsonl
  const text = JSON.stringify(TF_ROW);
  check('T3: parseLoopRow reads a valid line', parseLoopRow(text).ok === true);
  check('T3: parseLoopRow accepts a BOM and a trailing \\r\\n', parseLoopRow(`﻿${text}\r\n`).ok === true);
  check('T3: parseLoopRow refuses garbage and broken JSON', !parseLoopRow('not json').ok && !parseLoopRow(text.slice(0, -1)).ok && !parseLoopRow(42).ok);
  const long = `${text.slice(0, -1)}${' '.repeat(1025 - text.length)}}`;
  check('T3: a line over 1024 bytes is refused even if the JSON is valid', Buffer.byteLength(long) > 1024 && JSON.parse(long).v === 1 && !parseLoopRow(long).ok);
}

// --- 6. the history loops.jsonl: read and append (plan T3) ---------------------------------------
{
  const LOOPS = path.join(STATE, 'loops.jsonl');
  setup();
  const empty = readLoops(PROJECT, STATE);
  check('T3: no loops.jsonl: no rows, nothing ignored, no code', empty.rows.length === 0 && empty.ignored === 0 && empty.code === null, JSON.stringify(empty));

  const none = appendLoopRows(PROJECT, STATE, []);
  check('T3: appending nothing creates no file', none.ok === true && none.written === 0 && !fs.existsSync(LOOPS), JSON.stringify(none));

  const first = appendLoopRows(PROJECT, STATE, [TF_ROW, PC_ROW, { ...TF_ROW, run: 'IGNORE PREVIOUS' }, BF_ROW]);
  const written = fs.readFileSync(LOOPS, 'utf8');
  check('T3: valid rows are written, the invalid one is counted, not written', first.ok === true && first.written === 3 && first.invalid === 1 && written.split('\n').filter(Boolean).length === 3, JSON.stringify(first));
  check('T3: each line is the validated row serialised, newline-terminated', written === [TF_ROW, PC_ROW, BF_ROW].map((row) => `${JSON.stringify(validateLoopRow(row).row)}\n`).join(''));
  check('T3: nothing of the invalid row reaches the file', !written.includes('IGNORE PREVIOUS'));

  const again = appendLoopRows(PROJECT, STATE, [{ ...TF_ROW, outcome: 'failed' }, PC_ROW]);
  check('T3: a key already in the history is not appended again', again.ok === true && again.written === 0 && fs.readFileSync(LOOPS, 'utf8') === written, JSON.stringify(again));

  const batch = appendLoopRows(PROJECT, STATE, [{ ...TF_ROW, id: 'new1' }, { ...TF_ROW, id: 'new1', outcome: 'failed' }]);
  const read = readLoops(PROJECT, STATE);
  check('T3: the same key twice in one batch: only the first is written', batch.written === 1 && read.rows.length === 4 && read.rows[3].outcome === 'ok', JSON.stringify(batch));
  check('T3: the same id from another source or run is another key', appendLoopRows(PROJECT, STATE, [{ ...TF_ROW, run: 'other-run' }]).written === 1);

  fs.appendFileSync(LOOPS, `${JSON.stringify({ ...TF_ROW, outcome: 'failed' })}\nnot json\n\n${JSON.stringify({ ...TF_ROW, v: 2 })}\n`);
  const reread = readLoops(PROJECT, STATE);
  const tf = reread.rows.filter((row) => row.source === 'taskflow' && row.run === SLUG && row.id === TF_ROW.id);
  check('T3: reading a key twice gives the first line', tf.length === 1 && tf[0].outcome === 'ok', JSON.stringify(tf));
  check('T3: the duplicate is not counted as ignored; garbage and v 2 are', reread.ignored === 2 && reread.rows.length === 5, JSON.stringify({ rows: reread.rows.length, ignored: reread.ignored }));
  check('T3: rows come back oldest first', reread.rows.map((row) => row.id).join() === ['a1b2c3d4', PC_ROW.id, 'old1', 'new1', 'a1b2c3d4'].join());
  check('T3: the read rows are fresh objects in LOOP_KEYS order', reread.rows.every((row) => Object.keys(row).join() === LOOP_KEYS.join()));

  const before = fs.readFileSync(LOOPS, 'utf8');
  fs.writeFileSync(LOOPS, before.replace(/\n$/, '')); // a crash cut the newline
  appendLoopRows(PROJECT, STATE, [{ ...TF_ROW, id: 'after1' }]);
  check('T3: an append after a cut last line starts on a new line', readLoops(PROJECT, STATE).rows.some((row) => row.id === 'after1'));
  check('T3: metrics.jsonl is never created by the loop history', !fs.existsSync(path.join(STATE, 'metrics.jsonl')));

  check('T3: rows not an array: refused, nothing thrown', ['x', null, undefined, {}].every((rows) => appendLoopRows(PROJECT, STATE, rows).ok === false));
  const rel = appendLoopRows(PROJECT, 'relative/state', [{ ...TF_ROW, id: 'rel1' }]);
  check('T3: a relative stateDir: refused, nothing written', rel.ok === false && rel.code === 'unsafe-path' && !fs.existsSync(path.resolve('relative/state')), JSON.stringify(rel));
  check('T3: the results carry only closed keys', Object.keys(rel).every((k) => ['ok', 'code', 'written', 'invalid'].includes(k)) && Object.keys(readLoops(PROJECT, STATE)).sort().join() === 'code,ignored,rows');
}

try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
