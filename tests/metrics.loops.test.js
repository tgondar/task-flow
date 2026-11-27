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

// --- 7. the join with each loop's transcript at the close (plan T4, RF-005..RF-008, SC-002) ----------
// A start event names a subagent; its transcript agent-<id>.jsonl, in the session's subagents/
// folder under ~/.claude/projects/<project slug>, says what it spent. The close joins the two.
const { joinLoops, closeRun, AGENT_EFFORT } = metrics;
check('T4: joinLoops, closeRun and AGENT_EFFORT exported', typeof joinLoops === 'function' && typeof closeRun === 'function' && AGENT_EFFORT !== null && typeof AGENT_EFFORT === 'object');
if (typeof joinLoops !== 'function' || !AGENT_EFFORT) { console.log(`\n${passed} passed, ${failures.length + 1} failed`); process.exit(1); }

const SUBAGENTS = path.join(TEST_HOME, '.claude', 'projects', PROJECT.replace(/[^A-Za-z0-9]/g, '-'), 'sess1', 'subagents');
const transcriptFile = (id) => path.join(SUBAGENTS, `agent-${id}.jsonl`);
const writeTranscript = (id, records) => put(transcriptFile(id), `${records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`);
const user = (ts) => ({ type: 'user', timestamp: ts, agentId: 'x', message: { role: 'user', content: 'do the thing' } });
const asst = (ts, requestId, usage, extra = {}) => ({ type: 'assistant', timestamp: ts, requestId, agentId: 'x', message: { model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: 'TRANSCRIPT TEXT' }] }, ...extra });
const usage = (input, output, cacheCreate = 0, cacheRead = 0) => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheCreate, cache_read_input_tokens: cacheRead });
const start = (agent, type, extra = {}) => ({ v: 1, kind: 'start', agent, type, phase: 'build', task: 'T4', at: '2026-01-01T10:00:00.000Z', ...extra });
const events = (...starts) => ({ starts, results: [], ignored: 0 });
const join = (starts, extra = {}) => joinLoops({ projectDir: PROJECT, slug: SLUG, events: events(...starts), deadline: Date.now() + 5000, ...extra });
const byId = (rows, id) => rows.find((row) => row.id === id);

{
  // RF-007: the table of the plugin's agents matches plugin/agents/*.md, both ways
  const dir = path.resolve(__dirname, '../plugin/agents');
  const expected = {};
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const head = fs.readFileSync(path.join(dir, name), 'utf8').split(/^---\s*$/m)[1] || '';
    const agent = (head.match(/^name:\s*(\S+)\s*$/m) || [])[1];
    const effort = (head.match(/^effort:\s*(\S+)\s*$/m) || [])[1];
    expected[`task-flow:${agent}`] = effort;
  }
  check('T4: AGENT_EFFORT has exactly one entry per plugin/agents/*.md, with its effort:', Object.keys(expected).length >= 7 && JSON.stringify(Object.entries(AGENT_EFFORT).sort()) === JSON.stringify(Object.entries(expected).sort()), `${JSON.stringify(AGENT_EFFORT)} vs ${JSON.stringify(expected)}`);
  check('T4: AGENT_EFFORT is frozen', Object.isFrozen(AGENT_EFFORT));
}
{
  setup();
  fs.rmSync(path.join(TEST_HOME, '.claude'), { recursive: true, force: true });
  // loop A: one request written in three records (only output grows) + one more request; no effort field
  writeTranscript('aaa1', [
    user('2026-01-01T10:00:01Z'),
    asst('2026-01-01T10:00:05Z', 'req_1', usage(5, 10, 100, 1000)),
    asst('2026-01-01T10:00:06Z', 'req_1', usage(5, 50, 100, 1000)),
    asst('2026-01-01T10:00:07Z', 'req_1', usage(5, 120, 100, 1000)),
    user('2026-01-01T10:01:00Z'),
    asst('2026-01-01T10:05:13Z', 'req_2', usage(7, 30, 0, 2000)),
  ]);
  // loop B: a general-purpose loop whose records carry effort high; models 2 vs 1
  writeTranscript('bbb2', [
    user('2026-01-01T11:00:00Z'),
    asst('2026-01-01T11:00:10Z', 'req_b1', usage(1, 1), { effort: 'high', message: { model: 'claude-sonnet-5', usage: usage(1, 1) } }),
    asst('2026-01-01T11:00:20Z', 'req_b2', usage(1, 1), { effort: 'high', message: { model: 'claude-sonnet-5', usage: usage(1, 1) } }),
    asst('2026-01-01T11:00:30Z', 'req_b3', usage(1, 1), { effort: 'low', message: { model: 'claude-haiku-5', usage: usage(1, 1) } }),
    asst('2026-01-01T11:00:40Z', 'req_b4', usage(500, 500), { message: { model: '<synthetic>', usage: usage(500, 500) } }),
  ]);
  const rows = join([start('aaa1', 'task-flow:code-reviewer'), start('bbb2', 'general-purpose', { phase: 'harden', task: '' })]);
  const a = byId(rows, 'aaa1');
  const b = byId(rows, 'bbb2');
  check('T4: two events, two transcripts -> two rows, in event order', rows.length === 2 && rows[0].id === 'aaa1' && rows[1].id === 'bbb2', JSON.stringify(rows.map((r) => r.id)));
  check('T4: every row passes validateLoopRow', rows.every((row) => validateLoopRow(row).ok));
  check('T4: a request repeated in three records counts once, with the max of each field (2026-09-29 regression)',
    a && JSON.stringify(a.tokens) === JSON.stringify({ input: 12, cacheCreate: 100, cacheRead: 3000, output: 150 }), JSON.stringify(a && a.tokens));
  check('T4: duration from the first to the last timestamp (seconds)', a && a.durationS === 312, String(a && a.durationS));
  check('T4: the model is the most frequent one', a && a.model === 'claude-opus-5-5' && b && b.model === 'claude-sonnet-5', `${a && a.model} ${b && b.model}`);
  check('T4: a <synthetic> record is not a request', b && b.tokens.input === 3 && b.tokens.output === 3, JSON.stringify(b && b.tokens));
  check('T4: general-purpose with effort high in its records -> high (most frequent)', b && b.effort === 'high', b && b.effort);
  check('T4: task-flow:code-reviewer without the field -> its definition (low)', a && a.effort === 'low', a && a.effort);
  check('T4: run, id, type, phase, task and startedAt come from the start event', a && a.run === SLUG && a.agentType === 'task-flow:code-reviewer' && a.phase === 'build' && a.task === 'T4' && a.startedAt === '2026-01-01T10:00:00.000Z' && b.phase === 'harden' && b.task === '');
  check('T4: a joined row is taskflow, not backfill, no cost, no reason, no result yet', rows.every((row) => row.source === 'taskflow' && row.backfill === false && row.costCents === null && row.reason === null && row.outcome === null && row.round === null && row.tests === null && row.critical === null && row.required === null));
  check('T4: nothing of the messages reaches a row', !JSON.stringify(rows).includes('TRANSCRIPT TEXT') && !JSON.stringify(rows).includes('do the thing'));
  // SC-002: no token of a loop with a start event is left without a phase
  const tokens = (list) => list.reduce((sum, row) => sum + (row.tokens ? row.tokens.input + row.tokens.cacheCreate + row.tokens.cacheRead + row.tokens.output : 0), 0);
  check('T4: SC-002 - 0 % of the loop tokens are without a phase', tokens(rows) > 0 && tokens(rows.filter((row) => row.phase === 'unknown')) === 0);

  writeTranscript('ccc3', [user('2026-01-01T12:00:00Z'), asst('2026-01-01T12:00:01Z', 'req_c', usage(1, 1))]);
  check('T4: general-purpose without the field -> unknown', byId(join([start('ccc3', 'general-purpose')]), 'ccc3').effort === 'unknown');
  writeTranscript('ddd4', [asst('2026-01-01T12:00:01Z', 'req_d', usage(1, 1), { effort: 'ultra' })]);
  check('T4: an effort outside the closed set is not taken (falls back to the definition)', byId(join([start('ddd4', 'task-flow:second-opinion-max')]), 'ddd4').effort === 'max');
}
{
  // RF-008: a missing transcript, an unreadable one and an exhausted budget each give a row with a reason
  fs.rmSync(transcriptFile('ccc3'), { force: true });
  writeTranscript('eee5', ['not json', '{"type":"assistant","requestId":"r","message":{"usage":{"input_tokens":"many"}}}']);
  const rows = join([start('ccc3', 'general-purpose'), start('aaa1', 'task-flow:code-reviewer'), start('eee5', 'general-purpose')]);
  const nulls = (row, reason) => row && row.tokens === null && row.durationS === null && row.model === null && row.effort === null && row.reason === reason;
  check('T4: deleted transcript -> null tokens, duration, model, effort and no-transcript', nulls(byId(rows, 'ccc3'), 'no-transcript'), JSON.stringify(byId(rows, 'ccc3')));
  check('T4: a failing loop never stops the others', byId(rows, 'aaa1') && byId(rows, 'aaa1').tokens !== null && byId(rows, 'aaa1').reason === null);
  check('T4: a transcript with no line in the known shape -> unreadable-format', nulls(byId(rows, 'eee5'), 'unreadable-format'), JSON.stringify(byId(rows, 'eee5')));
  check('T4: the rows with a reason still pass validateLoopRow', rows.every((row) => validateLoopRow(row).ok));
  const late = join([start('aaa1', 'task-flow:code-reviewer'), start('bbb2', 'general-purpose')], { deadline: Date.now() - 1 });
  check('T4: budget already spent -> every loop gets a row with timeout', late.length === 2 && late.every((row) => nulls(row, 'timeout')), JSON.stringify(late));
  const twice = join([start('aaa1', 'task-flow:code-reviewer'), start('aaa1', 'general-purpose')]);
  check('T4: the same agent id twice -> one row (the first start)', twice.length === 1 && twice[0].agentType === 'task-flow:code-reviewer');
  check('T4: no events -> no rows', join([]).length === 0);
  check('T4: bad arguments -> no rows, never throws', [undefined, null, {}, { projectDir: 'rel', slug: SLUG, events: events(start('aaa1', 'x')) }, { projectDir: PROJECT, slug: '../x', events: events(start('aaa1', 'x')) }].every((o) => Array.isArray(joinLoops(o)) && joinLoops(o).length === 0));
  check('T4: joinLoops writes nothing', !fs.existsSync(path.join(STATE, 'loops.jsonl')));
}
{
  // RF-005: closeRun joins the run's events and writes the loop rows, once, beside the metrics.jsonl line
  const LOOPS = path.join(STATE, 'loops.jsonl');
  const HISTORY = path.join(STATE, 'metrics.jsonl');
  const doneRun = (extra = {}) => {
    setup({ [SLUG]: {} });
    put(path.join(PROJECT, 'docs', 'plans', 'p.plan.md'), '# Plan\n\n## T1 · first\n- [x] **Done** — built\n');
    put(path.join(STATE, SLUG, 'state.json'), {
      task: SLUG, mode: 'auto', phase: 'done', status: 'done', approvedBy: 'x', created: '2026-01-01',
      updated: '2026-01-01T13:00:00Z', phaseChangedAt: '2026-01-01T13:00:00Z', startedAt: '2026-01-01T09:00:00Z',
      size: { points: 3 }, artifacts: { plan: 'plans/p.plan.md' }, ...extra,
    });
  };
  const writeEvents = (...starts) => put(EVENTS, `${starts.map((s) => JSON.stringify(s)).join('\n')}\n`);
  const rowsOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

  doneRun();
  writeEvents(start('aaa1', 'task-flow:code-reviewer'), start('bbb2', 'general-purpose'));
  const first = closeRun({ projectDir: PROJECT, slug: SLUG, env: {} });
  const loops = rowsOf(LOOPS);
  check('T4: closeRun with two events: closed, one metrics.jsonl line, two loop rows', first.ok === true && first.code === 'closed' && rowsOf(HISTORY).length === 1 && loops.length === 2, JSON.stringify({ first, loops: loops.length }));
  check('T4: the loop rows are the joined ones', loops[0] && loops[0].id === 'aaa1' && loops[0].tokens && loops[0].tokens.output === 150 && loops[1].effort === 'high');
  const second = closeRun({ projectDir: PROJECT, slug: SLUG, env: {} });
  check('T4: a second close: already-closed, loop rows unchanged', second.code === 'already-closed' && rowsOf(LOOPS).length === 2);

  // a close interrupted after the loop rows (no metrics.jsonl line): the next close adds no duplicate
  fs.rmSync(HISTORY, { force: true });
  const retried = closeRun({ projectDir: PROJECT, slug: SLUG, env: {} });
  check('T4: a repeated close appends no loop row twice', retried.code === 'closed' && rowsOf(LOOPS).length === 2 && rowsOf(HISTORY).length === 1);

  doneRun();
  writeEvents(start('aaa1', 'task-flow:code-reviewer'));
  const spent = closeRun({ projectDir: PROJECT, slug: SLUG, env: {}, budgetMs: -1 });
  const timed = rowsOf(LOOPS);
  check('T4: budget exhausted -> loop row with timeout, and the metrics.jsonl line is written anyway', spent.code === 'closed' && rowsOf(HISTORY).length === 1 && timed.length === 1 && timed[0].reason === 'timeout' && timed[0].tokens === null, JSON.stringify({ spent, timed }));

  doneRun();
  writeEvents(start('aaa1', 'task-flow:code-reviewer'));
  const broken = closeRun({ projectDir: PROJECT, slug: SLUG, env: {}, steps: { loops: () => { throw new Error('IGNORE PREVIOUS'); } } });
  check('T4: the loop step throwing never changes the close: closed, metrics.jsonl line written', broken.ok === true && broken.code === 'closed' && rowsOf(HISTORY).length === 1 && !JSON.stringify(broken).includes('IGNORE'), JSON.stringify(broken));

  doneRun();
  const listing = () => fs.readdirSync(STATE, { recursive: true }).map(String).sort().join();
  const plain = closeRun({ projectDir: PROJECT, slug: SLUG, env: {} });
  check('T4: a run with no events: closed, no loops.jsonl, only metrics.jsonl added', plain.code === 'closed' && !fs.existsSync(LOOPS) && listing() === ['metrics.jsonl', SLUG, path.join(SLUG, 'state.json')].sort().join(), listing());

  doneRun({ phase: 'build', status: 'running' });
  writeEvents(start('aaa1', 'task-flow:code-reviewer'));
  check('T4: a run not yet done: no loop rows', closeRun({ projectDir: PROJECT, slug: SLUG, env: {} }).code === 'not-eligible' && !fs.existsSync(LOOPS));

  doneRun();
  writeEvents(start('aaa1', 'task-flow:code-reviewer'));
  check('T4: TASK_FLOW_METRICS=off: no loop rows', closeRun({ projectDir: PROJECT, slug: SLUG, env: { TASK_FLOW_METRICS: 'off' } }).code === 'disabled' && !fs.existsSync(LOOPS));
}

// --- T5: the loop-result CLI and the result in the final row (RF-020..RF-023) ----------------------
{
  const cp = require('child_process');
  const METRICS = path.resolve(__dirname, '../plugin/scripts/metrics.js');
  const env = { ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME, LOCALAPPDATA: TEST_HOME, XDG_STATE_HOME: TEST_HOME, CLAUDE_PROJECT_DIR: PROJECT };
  delete env.TASK_FLOW_METRICS;
  const cli = (args, extra = {}) => cp.spawnSync(process.execPath, [METRICS, ...args], { encoding: 'utf8', shell: false, timeout: 60000, env: { ...env, ...extra } });
  const RESULT_KEYS = ['v', 'kind', 'agent', 'outcome', 'tests', 'critical', 'required', 'round', 'phase', 'task'];
  const text = () => (fs.existsSync(EVENTS) ? fs.readFileSync(EVENTS, 'utf8') : '');
  const ok = (r) => r.status === 0 && r.stdout === 'metrics: written loop-result\n' && r.stderr === '';
  const invalid = (r) => r.status === 1 && r.stdout === '' && r.stderr === 'metrics: invalid loop-result\n';

  // a valid result: one fixed line, one event with the closed keys, read back by the one reader
  setup();
  append();
  const full = cli(['loop-result', '--slug', SLUG, '--agent', 'a1b2c3d4', '--outcome', 'retry', '--tests', 'red', '--critical', '2', '--required', '0', '--round', '3', '--phase', 'harden', '--task', 'T5']);
  check('T5: a valid loop-result: exit 0, one fixed stdout line, no argument echoed', ok(full), JSON.stringify(full));
  const written = lines().map((l) => JSON.parse(l));
  const result = written[1] || {};
  check('T5: the result is appended after the start, in the same loop-events.jsonl', written.length === 2 && written[0].kind === 'start' && result.kind === 'result', JSON.stringify(written));
  check('T5: the result event has exactly the closed keys', Object.keys(result).sort().join() === [...RESULT_KEYS].sort().join(), Object.keys(result).join());
  check('T5: the result event carries the validated values, numbers as numbers', result.v === 1 && result.agent === 'a1b2c3d4' && result.outcome === 'retry' && result.tests === 'red' && result.critical === 2 && result.required === 0 && result.round === 3 && result.phase === 'harden' && result.task === 'T5', JSON.stringify(result));
  const read = readLoopEvents(PROJECT, STATE, SLUG);
  check('T5: readLoopEvents hands the result back in results, the start in starts, nothing ignored', read.starts.length === 1 && read.results.length === 1 && read.ignored === 0 && JSON.stringify(read.results[0]) === JSON.stringify(result), JSON.stringify(read));

  const bare = cli(['loop-result', '--agent', 'zz9', '--outcome', 'ok', '--slug', SLUG]);
  const minimal = JSON.parse(lines()[2] || '{}');
  check('T5: only the required flags, in any order: the optional fields are null', ok(bare) && minimal.outcome === 'ok' && ['tests', 'critical', 'required', 'round', 'phase', 'task'].every((k) => minimal[k] === null), JSON.stringify(minimal));
  check('T5: no start event is required for a result', readLoopEvents(PROJECT, STATE, SLUG).results.length === 2);
  const viaFlag = cli(['loop-result', '--slug', SLUG, '--agent', 'pd1', '--outcome', 'unknown', '--project-dir', PROJECT], { CLAUDE_PROJECT_DIR: '' });
  check('T5: --project-dir is accepted like close does', ok(viaFlag) && lines().length === 4, JSON.stringify(viaFlag));

  // closed shapes, all-or-nothing: exit 1, the fixed message, nothing written
  const before = text();
  const base = ['loop-result', '--slug', SLUG, '--agent', 'a1b2c3d4', '--outcome', 'ok'];
  for (const [name, args] of [
    ['missing --outcome', ['loop-result', '--slug', SLUG, '--agent', 'a1b2c3d4']],
    ['missing --agent', ['loop-result', '--slug', SLUG, '--outcome', 'ok']],
    ['missing --slug', ['loop-result', '--agent', 'a1b2c3d4', '--outcome', 'ok']],
    ['an outcome outside the set', ['loop-result', '--slug', SLUG, '--agent', 'a1b2c3d4', '--outcome', 'done']],
    ['tests outside the set', [...base, '--tests', 'yellow']],
    ['a negative count', [...base, '--critical', '-1']],
    ['a count with a leading zero', [...base, '--required', '07']],
    ['round 0', [...base, '--round', '0']],
    ['round 100', [...base, '--round', '100']],
    ['a phase outside PHASES', [...base, '--phase', 'done']],
    ['a task outside the shape', [...base, '--task', 'task 5']],
    ['an unknown flag', [...base, '--note', 'x']],
    ['a repeated flag', [...base, '--outcome', 'retry']],
    ['a flag without a value', [...base, '--round']],
    ['a stray positional argument', [...base, 'extra']],
  ]) {
    check(`T5: ${name}: exit 1, fixed message, nothing written`, invalid(cli(args)) && text() === before);
  }
  check('T5: a run folder that does not exist: exit 1, a fixed code, nothing created', (() => {
    const r = cli(['loop-result', '--slug', 'no-such-run', '--agent', 'a1b2c3d4', '--outcome', 'ok']);
    return r.status === 1 && r.stdout === '' && r.stderr === 'metrics: write-failed loop-result\n' && !fs.existsSync(path.join(STATE, 'no-such-run'));
  })());
  const off = cli([...base, '--outcome', 'nonsense'], { TASK_FLOW_METRICS: 'off' });
  check('T5: TASK_FLOW_METRICS=off: exit 0, nothing done, even with bad arguments', off.status === 0 && off.stderr === '' && text() === before, JSON.stringify(off));

  // the usage error is unchanged for every other command
  for (const args of [['frobnicate'], [], ['LOOP-RESULT', '--slug', SLUG]]) {
    const r = cli(args);
    check(`T5: ${JSON.stringify(args[0] || '')} is still a usage error: exit 2, usage: metrics.js close...`, r.status === 2 && /^usage: metrics\.js close/.test(r.stderr) && r.stderr.includes('loop-result') && r.stdout === '', JSON.stringify(r.stderr));
  }

  // joinLoops: the LAST result per agent wins; its phase/task beat the start's; round only from it
  setup();
  fs.rmSync(path.join(TEST_HOME, '.claude'), { recursive: true, force: true });
  const res = (agent, extra = {}) => ({ v: 1, kind: 'result', agent, outcome: 'ok', tests: null, critical: null, required: null, round: null, phase: null, task: null, ...extra });
  const rows = joinLoops({
    projectDir: PROJECT, slug: SLUG, deadline: Date.now() + 5000,
    events: {
      starts: [start('aaa1', 'task-flow:security-auditor', { phase: 'build', task: 'T6' }), start('bbb2', 'general-purpose'), start('ccc3', 'general-purpose')],
      results: [res('aaa1', { outcome: 'failed' }), res('aaa1', { outcome: 'retry', tests: 'green', critical: 1, required: 4, round: 2, phase: 'harden', task: 'T5' }), res('bbb2'), res('orphan9', { outcome: 'failed' }), { ...res('ccc3'), outcome: 'DONE' }],
      ignored: 0,
    },
  });
  const a = byId(rows, 'aaa1');
  const b = byId(rows, 'bbb2');
  const c = byId(rows, 'ccc3');
  check('T5: one row per start, a result without a start adds none', rows.length === 3 && !byId(rows, 'orphan9'), JSON.stringify(rows.map((r) => r.id)));
  check('T5: the last result of an agent gives outcome, tests, critical, required, round', a && a.outcome === 'retry' && a.tests === 'green' && a.critical === 1 && a.required === 4 && a.round === 2, JSON.stringify(a));
  check('T5: the result\'s phase and task beat the start\'s', a && a.phase === 'harden' && a.task === 'T5', a && `${a.phase} ${a.task}`);
  check('T5: a result without --round, --phase, --task: round null, phase/task from the start', b && b.outcome === 'ok' && b.round === null && b.phase === 'build' && b.task === 'T4', JSON.stringify(b));
  check('T5: a result outside the closed shape is not taken (the row stays without result)', c && c.outcome === null, JSON.stringify(c));
  check('T5: the joined rows still pass validateLoopRow', rows.every((row) => validateLoopRow(row).ok));

  // end to end: start event (hook) -> loop-result (CLI) -> close -> the loop row carries the result
  const LOOPS = path.join(STATE, 'loops.jsonl');
  setup();
  append();
  put(path.join(PROJECT, 'docs', 'plans', 'p.plan.md'), '# Plan\n\n## T1 · first\n- [x] **Done** — built\n');
  check('T5: e2e loop-result written', ok(cli(['loop-result', '--slug', SLUG, '--agent', 'a1b2c3d4', '--outcome', 'ok', '--tests', 'green', '--phase', 'harden', '--task', 'T3'])));
  put(path.join(STATE, SLUG, 'state.json'), {
    task: SLUG, mode: 'auto', phase: 'done', status: 'done', approvedBy: 'x', created: '2026-01-01',
    updated: '2026-01-01T13:00:00Z', phaseChangedAt: '2026-01-01T13:00:00Z', startedAt: '2026-01-01T09:00:00Z',
    size: { points: 3 }, artifacts: { plan: 'plans/p.plan.md' },
  });
  const closed = closeRun({ projectDir: PROJECT, slug: SLUG, env: {} });
  const final = fs.existsSync(LOOPS) ? fs.readFileSync(LOOPS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  check('T5: e2e: the final loop row has the result, the result\'s phase and no round', closed.code === 'closed' && final.length === 1 && final[0].outcome === 'ok' && final[0].tests === 'green' && final[0].phase === 'harden' && final[0].task === 'T3' && final[0].round === null, JSON.stringify(final));
}

// --- T6: the loops the Stop hook asks a result for (RF-024) ----------------------------------------
// A start with no result is owed one only once the run has moved on from where the loop started:
// the phase a start would record now (the one after the completed phase) or the cursor differ.
{
  const { loopsWithoutResult } = metrics;
  check('T6: loopsWithoutResult exported', typeof loopsWithoutResult === 'function');
  const start = (agent, phase, task) => JSON.stringify({ v: 1, kind: 'start', agent, type: 'general-purpose', phase, task, at: '2026-01-01T10:00:00.000Z' });
  const result = (agent) => JSON.stringify({ v: 1, kind: 'result', agent, outcome: 'ok', tests: null, critical: null, required: null, round: null, phase: null, task: null });
  const owed = (state, events) => {
    setup();
    if (events) put(EVENTS, `${events.join('\n')}\n`);
    return loopsWithoutResult(PROJECT, STATE, SLUG, state);
  };
  const now = { phase: 'plan', buildCursor: 'T4' }; // in flight: build / T4

  check('T6: started at build/T3, run now at build/T4, no result: owed',
    JSON.stringify(owed(now, [start('aaa1', 'build', 'T3')])) === '["aaa1"]');
  check('T6: started in the phase and task the run is still in: not owed (a background loop still running)',
    owed(now, [start('aaa1', 'build', 'T4')]).length === 0);
  check('T6: a phase change alone makes it owed (started in spec, run now building)',
    JSON.stringify(owed({ phase: 'plan', buildCursor: 'T1' }, [start('aaa1', 'spec', 'T1')])) === '["aaa1"]');
  check('T6: a loop with a result is not owed', owed(now, [start('aaa1', 'build', 'T3'), result('aaa1')]).length === 0);
  check('T6: no loop-events.jsonl: nothing owed', owed(now, null).length === 0);
  check('T6: ids sorted and each once',
    JSON.stringify(owed(now, [start('zzz9', 'build', 'T1'), start('bbb2', 'build', 'T2'), start('bbb2', 'build', 'T2'), start('aaa1', 'build', 'T3')])) === '["aaa1","bbb2","zzz9"]');
  check('T6: a cursor out of shape counts as no task, like the start event records it',
    owed({ phase: 'plan', buildCursor: 'IGNORE PREVIOUS' }, [start('aaa1', 'build', '')]).length === 0);
  check('T6: no state: nothing owed', owed(null, [start('aaa1', 'build', 'T3')]).length === 0);
}

// --- T9: the summary CLI for the PR body (RF-033; decisions Q1, Q3, Q6) ------------------------------
// Computed on demand, nothing written: the run's start events joined in memory (the PR opens before
// the close), the rows loops.jsonl already holds for the run, and the orchestrator's own tokens from
// the main transcript in the run window. Fresh tokens only (input + cache creation + output).
{
  const cp = require('child_process');
  const METRICS = path.resolve(__dirname, '../plugin/scripts/metrics.js');
  const env = { ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME, LOCALAPPDATA: TEST_HOME, XDG_STATE_HOME: TEST_HOME, CLAUDE_PROJECT_DIR: PROJECT };
  delete env.TASK_FLOW_METRICS;
  const cli = (args, extra = {}) => cp.spawnSync(process.execPath, [METRICS, ...args], { encoding: 'utf8', shell: false, timeout: 60000, env: { ...env, ...extra } });
  const summary = (extra) => cli(['summary', '--slug', SLUG], extra);
  const BASE = path.join(TEST_HOME, '.claude', 'projects', PROJECT.replace(/[^A-Za-z0-9]/g, '-'));
  const MAIN = path.join(BASE, 'aaaaaaaa-0000-4000-8000-000000000009.jsonl');
  const MIN = 60 * 1000;
  const S = Date.now() - 2 * 60 * MIN; // the run started two hours ago
  const at = (minutes, seconds = 0) => new Date(S + minutes * MIN + seconds * 1000).toISOString();
  const startLine = (agent, type, phase, task, minutes) => ({ v: 1, kind: 'start', agent, type, phase, task, at: at(minutes) });
  const resultLine = (agent, round) => ({ v: 1, kind: 'result', agent, outcome: 'ok', tests: null, critical: 0, required: 0, round, phase: null, task: null });
  // a loop's transcript: its user turn at `minutes`, its last request `seconds` later
  const loop = (id, minutes, seconds, ...requests) => writeTranscript(id, [user(at(minutes)),
    ...requests.map(([req, u], i) => asst(at(minutes, i === requests.length - 1 ? seconds : 1), req, u))]);
  const orch = (minutes, requestId, u) => ({ type: 'assistant', isSidechain: false, cwd: PROJECT, timestamp: at(minutes), requestId, message: { model: 'claude-opus-5-5', usage: u, content: [{ type: 'text', text: 'ok' }] } });
  const snapshot = (dir) => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else { const s = fs.statSync(f); out.push(`${f}|${s.size}|${s.mtimeMs}|${fs.readFileSync(f, 'utf8')}`); }
      }
    };
    walk(dir);
    return out.sort().join('\n');
  };

  /** An open run with five loops: three in build (one with no transcript), two in review (rounds
   *  `rounds`), and the orchestrator's main transcript. */
  function fixture({ state = {}, config, rounds = [1, 2] } = {}) {
    setup({ [SLUG]: { phase: 'build', startedAt: at(0), ...state } }, config);
    fs.rmSync(path.join(TEST_HOME, '.claude'), { recursive: true, force: true });
    put(EVENTS, `${[
      startLine('b1', 'general-purpose', 'build', 'T1', 10),
      startLine('b2', 'task-flow:security-auditor', 'build', 'T1', 20),
      startLine('x1', 'general-purpose', 'build', 'T2', 30), // its transcript never appears
      startLine('r1', 'task-flow:code-reviewer', 'review', '', 40),
      startLine('r2', 'task-flow:code-reviewer', 'review', '', 50),
      resultLine('r1', rounds[0]),
      resultLine('r2', rounds[1]),
    ].map((l) => JSON.stringify(l)).join('\n')}\n`);
    loop('b1', 10, 60, ['q1', usage(100, 50, 20, 1000)]); // fresh 170, 60 s
    loop('b2', 20, 120, ['q2', usage(10, 5)], ['q3', usage(30, 10, 5, 500)]); // fresh 60, 120 s
    loop('r1', 40, 30, ['q4', usage(200, 100)]); // fresh 300, 30 s
    loop('r2', 50, 45, ['q5', usage(1, 1, 1)]); // fresh 3, 45 s
    put(MAIN, `${[
      { type: 'user', isSidechain: false, cwd: PROJECT, timestamp: at(5), message: { role: 'user', content: 'go' } },
      orch(6, 'o1', usage(10, 5, 2, 100)), // fresh 17
      orch(7, 'o2', usage(20, 10)), // fresh 30
      orch(-30, 'o0', usage(9999, 9999)), // before the run: not this run's
    ].map((r) => JSON.stringify(r)).join('\n')}\n`);
  }

  const PT = [
    '### Custo da run',
    '',
    'Tokens frescos = input + cache creation + output, sem cache reads.',
    '',
    '| Fase | Loops | Tokens frescos | Duração |',
    '| --- | ---: | ---: | ---: |',
    '| build | 3 | 230 | 3 min 00 s |',
    '| review | 2 | 303 | 1 min 15 s |',
    '| orquestrador | — | 47 | — |',
    '| **Total** | 5 | 580 | 4 min 15 s |',
    '',
    'As durações sobrepõem-se: os loops correm em paralelo, por isso uma soma não é tempo de relógio.',
    '',
    'Loops sem tokens medidos: 1 (fora das somas).',
    '',
    'Rondas de review: 2.',
    '',
  ].join('\n');

  fixture();
  const before = snapshot(STATE);
  const r = summary();
  check('T9: open run: exit 0, nothing on stderr', r.status === 0 && r.stderr === '', JSON.stringify(r));
  check('T9: open run: the block per phase, the orchestrator line and the total, in pt-PT', r.stdout === PT, `\n${r.stdout}`);
  check('T9: nothing in the state folder is created or changed', snapshot(STATE) === before);
  check('T9: no loops.jsonl is created by a summary', !fs.existsSync(path.join(STATE, 'loops.jsonl')));
  check('T9: nothing of a transcript reaches the block', !/TRANSCRIPT TEXT|9999|claude-opus|general-purpose/.test(r.stdout));

  fixture({ rounds: [null, null] });
  const noRounds = summary();
  check('T9: review loops without a round: their count, said as such',
    noRounds.status === 0 && noRounds.stdout.endsWith('Rondas de review: 2 loops de review, sem ronda registada.\n'), noRounds.stdout);

  fixture({ rounds: [1, null] });
  check('T9: the highest round of the review loops', summary().stdout.endsWith('Rondas de review: 1.\n'));

  fixture({ config: { docsDir: 'docs', language: 'en', tasksFile: 'tasks.md' } });
  const en = summary();
  check('T9: an English project gets the English block',
    en.status === 0 && en.stdout.startsWith('### Run cost\n\nFresh tokens = input + cache creation + output, without cache reads.\n\n| Phase | Loops | Fresh tokens | Duration |')
      && en.stdout.includes('| orchestrator | — | 47 | — |') && en.stdout.includes('Loops without measured tokens: 1 (not in the sums).')
      && en.stdout.endsWith('Review rounds: 2.\n'), `\n${en.stdout}`);
  fixture({ config: { docsDir: 'docs', language: 'fr', tasksFile: 'tasks.md' } });
  check('T9: another language falls back to English', summary().stdout.startsWith('### Run cost\n'));

  fixture();
  fs.rmSync(MAIN);
  const noMain = summary();
  check('T9: no main transcript: the orchestrator line says so, the total is the loops\'',
    noMain.status === 0 && noMain.stdout.includes('| orquestrador | — | — (sem transcript) | — |') && noMain.stdout.includes('| **Total** | 5 | 533 | 4 min 15 s |'), `\n${noMain.stdout}`);

  // a closed run: the row loops.jsonl recorded at the close wins over a fresh join of the same loop,
  // and a row of an older run that reused the folder name (started before startedAt) stays out
  const recorded = (id, startedMin, tokens) => ({
    v: 1, source: 'taskflow', run: SLUG, id, agentType: 'general-purpose', phase: 'build', task: 'T1', round: null, model: null, effort: 'unknown',
    startedAt: at(startedMin), durationS: 60, tokens: { input: tokens, cacheCreate: 0, cacheRead: 0, output: 0 }, costCents: null, outcome: 'ok', tests: null,
    critical: null, required: null, reason: null, backfill: false,
  });
  fixture({ state: { phase: 'done', status: 'done', phaseChangedAt: at(100) } });
  put(path.join(STATE, 'loops.jsonl'), `${[recorded('b1', 10, 1000), recorded('old1', -60, 5000)].map((l) => JSON.stringify(l)).join('\n')}\n`);
  const closed = summary();
  check('T9: closed run: the recorded row wins over the join, the older run\'s row stays out',
    closed.status === 0 && closed.stdout.includes('| build | 3 | 1060 | 3 min 00 s |') && closed.stdout.includes('| **Total** | 5 | 1410 | 4 min 15 s |'), `\n${closed.stdout}`);

  // no start events at all (a paperclip run), only rows in loops.jsonl
  fixture();
  fs.rmSync(EVENTS);
  put(path.join(STATE, 'loops.jsonl'), `${JSON.stringify(recorded('b1', 10, 1000))}\n`);
  const historyOnly = summary();
  check('T9: rows only in loops.jsonl still make a block', historyOnly.status === 0 && historyOnly.stdout.includes('| build | 1 | 1000 | 1 min 00 s |'), `\n${historyOnly.stdout}`);

  fixture();
  fs.rmSync(EVENTS);
  const none = summary();
  check('T9: no events and no rows: one fixed line, exit 0', none.status === 0 && none.stdout === 'metrics: no-loops summary\n' && none.stderr === '', JSON.stringify(none));
  check('T9: ...and still nothing written', !fs.existsSync(path.join(STATE, 'loops.jsonl')) && !fs.existsSync(EVENTS));

  fixture();
  const off = summary({ TASK_FLOW_METRICS: 'off' });
  check('T9: TASK_FLOW_METRICS=off: the fixed disabled line, exit 0', off.status === 0 && off.stdout === 'metrics: disabled summary\n', JSON.stringify(off));

  fixture({ state: { startedAt: undefined } });
  const noStart = summary();
  check('T9: a run without startedAt has no window: a fixed line, exit 0', noStart.status === 0 && noStart.stdout === 'metrics: no-window summary\n', JSON.stringify(noStart));
  const viaFlag = cli(['summary', '--slug', SLUG, '--project-dir', PROJECT], { CLAUDE_PROJECT_DIR: '' });
  check('T9: --project-dir is accepted', viaFlag.status === 0 && viaFlag.stdout === 'metrics: no-window summary\n', JSON.stringify(viaFlag));

  for (const [name, args] of [
    ['missing --slug', ['summary']],
    ['an unknown flag', ['summary', '--slug', SLUG, '--agent', 'b1']],
    ['a slug out of shape', ['summary', '--slug', '../x']],
    ['a repeated flag', ['summary', '--slug', SLUG, '--slug', SLUG]],
  ]) {
    const bad = cli(args);
    check(`T9: ${name}: exit 2 with the usage, nothing on stdout`, bad.status === 2 && /^usage: metrics\.js close/.test(bad.stderr) && bad.stderr.includes('metrics.js summary --slug') && bad.stdout === '', JSON.stringify(bad));
  }
}

try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
