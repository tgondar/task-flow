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

try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
