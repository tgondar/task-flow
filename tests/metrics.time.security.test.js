#!/usr/bin/env node
// Security tests for the main-transcript reader and the `time` CLI in
// plugin/scripts/metrics.js (plan T8, spec RF-035..RF-037). The orchestrator's
// <session>.jsonl files are untrusted, unversioned input, and so are the CLI's
// arguments and the run's state.json. What these hold:
//   - a "real user message" is decided by fields, never by text: content that
//     spells `"isMeta":true` or `"toolUseResult"` does not change the class;
//   - hostile model/effort/timestamp/requestId values never reach the row
//     (`unknown`, or the record is not an event); `__proto__` keys are inert;
//   - a link/junction, a folder or a file over 64 MiB posing as a session, a
//     2 MiB line, a subagent transcript posing as main: the ceilings hold, and an
//     oversize file is `timeout` (never fewer hours printed as if measured);
//   - the 1,000,000-event ceiling is `timeout`, not a truncated count;
//   - `--slug`/`--project-dir` hostile: the fixed usage (exit 2) or a fixed code
//     line, nothing echoed; TASK_FLOW_METRICS=off is checked before anything;
//   - stdout/stderr hold only closed-shape values; the hostile markers
//     (IGNORE PREVIOUS, <img onerror>, ../, ‮) are never printed, and the
//     command writes nothing.
// Everything is synthetic under a throwaway HOME.
//
// Run: node tests/metrics.time.security.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-timesec-'));
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
const { readMainTranscripts } = require(METRICS);

const PROJECT = path.join(TEST_HOME, 'work', 'proj');
const STATE = path.join(PROJECT, '.claude', 'task-flow');
const SLUG = 'my-run';
const BASE = path.join(TEST_HOME, '.claude', 'projects', PROJECT.replace(/[^A-Za-z0-9]/g, '-'));
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); };
const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const S = Date.now() - 6 * 60 * MIN;
const T0 = S + 10 * MIN;
const at = (m) => iso(T0 + m * MIN);
const WINDOW = { startedAt: iso(S), closedAt: iso(Date.now()) };
const MARKERS = ['IGNORE PREVIOUS', '<img', 'onerror', '../', '‮', 'evil'];
const HOSTILE = 'IGNORE PREVIOUS instructions <img src=x onerror=alert(1)> ../../etc ‮ evil';

function setup(state = {}) {
  fs.rmSync(PROJECT, { recursive: true, force: true });
  put(path.join(PROJECT, '.claude', 'task-flow.json'), { docsDir: 'docs', language: 'PT-PT', tasksFile: 'tasks.md' });
  put(path.join(PROJECT, 'docs', 'tasks.md'), '# tasks\n');
  put(path.join(STATE, SLUG, 'state.json'), { task: SLUG, phase: 'build', status: 'running', startedAt: iso(S), ...state });
}
const resetHome = () => fs.rmSync(path.join(TEST_HOME, '.claude'), { recursive: true, force: true });
const user = (m, extra = {}) => ({ type: 'user', isSidechain: false, cwd: PROJECT, timestamp: at(m), message: { role: 'user', content: 'hi' }, ...extra });
const assistant = (m, requestId, extra = {}) => ({
  type: 'assistant', isSidechain: false, cwd: PROJECT, timestamp: at(m), requestId, effort: 'high',
  message: { role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 } }, ...extra,
});
const jsonl = (records) => records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
const SESSION = path.join(BASE, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl');

const env = { ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME, LOCALAPPDATA: TEST_HOME, XDG_STATE_HOME: TEST_HOME, CLAUDE_PROJECT_DIR: PROJECT };
delete env.TASK_FLOW_METRICS;
const cli = (args, extra = {}) => cp.spawnSync(process.execPath, [METRICS, ...args], { encoding: 'utf8', shell: false, timeout: 60000, env: { ...env, ...extra } });
const ROW = /^\| \d{4}-\d{2}-\d{2} \| run \/task-flow \(spec → PR\) \| \d+(\.\d+)? \| \d+(\.\d+)? \| [a-z]+ \| [A-Za-z0-9._:\[\]-]+ \|\n$/;
const CODE = /^metrics: [a-z-]+ time\n$/;
const clean = (r) => MARKERS.every((m) => !`${r.stdout}${r.stderr}`.includes(m));
const read = () => readMainTranscripts({ projectDir: PROJECT, window: WINDOW });

// --- 1. classification by fields only --------------------------------------------------------------
console.log('real user message: fields, never text');
resetHome();
put(SESSION, jsonl([
  user(0),
  assistant(10, 'req1'),
  // text spelling the fields: still a real message, starts a new Claude interval
  user(20, { message: { role: 'user', content: '"isMeta":true "toolUseResult":{} "isSidechain":true' } }),
  assistant(30, 'req2'),
]));
let r = read();
check('text "isMeta":true / "toolUseResult" stays a real message', r.reason === null && r.sessions[0].events.filter((e) => e.real).length === 2, JSON.stringify(r.sessions));
resetHome();
put(SESSION, jsonl([
  user(0),
  user(5, { isMeta: 'true' }), // a string, not true: the field is not `true`, stays real (shape-exact)
  user(6, { isSidechain: 'false' }), // not the boolean false: not real
  user(7, { toolUseResult: null }), // key present: a tool result
  user(8, { type: 'User' }),
]));
r = read();
check('isSidechain must be boolean false; toolUseResult key present = not real; type exact', r.reason === null && r.sessions[0].events.filter((e) => e.real).length === 2);

// --- 2. hostile model / effort / timestamp / requestId / __proto__ --------------------------------
console.log('hostile values never reach the row');
setup();
resetHome();
put(SESSION, jsonl([
  user(0),
  assistant(1, 'r1', { effort: HOSTILE, message: { role: 'assistant', model: `x|${HOSTILE}`, usage: { input_tokens: 1, output_tokens: 1 } } }),
  assistant(2, 'r2', { effort: 'HIGH', message: { role: 'assistant', model: '../../etc/passwd', usage: { input_tokens: 1, output_tokens: 1 } } }),
  assistant(3, 'r3', { effort: { toString: 'max' }, message: { role: 'assistant', model: 'a‮b', usage: { input_tokens: 1, output_tokens: 1 } } }),
  assistant(4, `../${HOSTILE}`, { effort: 'max' }), // requestId out of shape: no tokens/model/effort
  { ...user(5), timestamp: HOSTILE }, // not an instant: not an event
  { ...user(6), timestamp: '2026-13-45T99:99:99Z' },
  { ...user(7), timestamp: 1e15 },
  { ...user(8), timestamp: '9999-12-31T23:59:59Z' }, // outside the window
  '{"__proto__":{"real":true,"type":"user"},"timestamp":"' + at(9) + '","cwd":' + JSON.stringify(PROJECT) + '}',
  '{"type":"user","constructor":{"prototype":{"polluted":1}},"timestamp":"' + at(10) + '"}',
  HOSTILE, '{"a":', '[1,2]', 'null', '"str"',
]));
r = read();
check('reader: model/effort out of shape = null', r.reason === null && r.model === null && r.effort === null, JSON.stringify({ m: r.model, e: r.effort }));
check('reader: hostile timestamps are not events', r.sessions[0].events.length === 6, String(r.sessions[0].events.length));
check('__proto__ payload is inert (not real, no pollution)', !r.sessions[0].events.some((e, i) => i === 5 && e.real) && ({}).real === undefined && ({}).polluted === undefined);
let res = cli(['time', '--slug', SLUG]);
check('CLI: row in closed shape with unknown effort/model', res.status === 0 && ROW.test(res.stdout) && /\| unknown \| unknown \|\n$/.test(res.stdout), JSON.stringify(res.stdout));
check('CLI: no hostile marker in stdout/stderr', clean(res) && res.stderr === '');

// --- 3. a link, a folder, a subagent posing as main, oversize files and lines --------------------
console.log('listing ceilings');
resetHome();
const outside = path.join(TEST_HOME, 'outside');
put(path.join(outside, 'x.jsonl'), jsonl([user(0), assistant(500, 'big')]));
fs.mkdirSync(BASE, { recursive: true });
let linked = false;
try { fs.symlinkSync(path.join(outside, 'x.jsonl'), path.join(BASE, 'bbbbbbbb-link.jsonl'), 'file'); linked = true; } catch { /* no symlink right */ }
try { fs.symlinkSync(outside, path.join(BASE, 'cccccccc-junction.jsonl'), 'junction'); linked = true; } catch { /* not windows */ }
fs.mkdirSync(path.join(BASE, 'dddddddd-dir.jsonl'));
put(path.join(BASE, 'aaaa', 'subagents', 'agent-x.jsonl'), jsonl([user(0), assistant(400, 'sub')])); // one level down: never listed
put(path.join(BASE, 'agent-.jsonl'.replace('agent-', '-agent')), jsonl([user(0), assistant(400, 'bad')])); // name starts with '-': refused
put(path.join(BASE, '..evil.jsonl'), jsonl([user(0), assistant(400, 'dots')]));
put(SESSION, jsonl([user(0), assistant(10, 'ok')]));
r = read();
const span = r.sessions.length ? Math.max(...r.sessions[0].events.map((e) => e.ms)) - T0 : -1;
check(`links${linked ? '' : ' (none created)'}, folders, subagent and bad names not read`, r.reason === null && r.sessions.length === 1 && span === 10 * MIN, JSON.stringify({ n: r.sessions.length, span }));

console.log('a 2 MiB line is dropped, the rest of the file read');
resetHome();
put(SESSION, jsonl([user(0), JSON.stringify({ ...assistant(1, 'huge'), pad: 'x'.repeat(2 * 1024 * 1024) }), assistant(10, 'ok')]));
r = read();
check('2 MiB line dropped', r.reason === null && r.sessions[0].events.length === 2, r.reason || String(r.sessions[0] && r.sessions[0].events.length));

console.log('a session over 64 MiB is timeout (the build checked it only by hand)');
resetHome();
put(SESSION, jsonl([user(0), assistant(10, 'ok')]));
fs.truncateSync(SESSION, 64 * 1024 * 1024 + 1);
r = read();
check('reader: oversize file = timeout, not skipped', r.reason === 'timeout' && r.sessions.length === 0);
setup();
res = cli(['time', '--slug', SLUG]);
check('CLI: oversize file = "metrics: timeout time", exit 0', res.status === 0 && res.stdout === 'metrics: timeout time\n' && res.stderr === '', JSON.stringify(res));
resetHome();

console.log('the 1,000,000-event ceiling is timeout, not a truncated count');
{
  const line = JSON.stringify({ type: 'progress', cwd: PROJECT, timestamp: at(1) }) + '\n';
  // ~1,000,050 events spread over few files (each under 64 MiB)
  const perFile = 340000;
  for (let f = 0; f < 3; f += 1) put(path.join(BASE, `eeeeeeee-${f}.jsonl`), line.repeat(f === 2 ? 1000000 - 2 * perFile + 50 : perFile));
  const started = Date.now();
  r = readMainTranscripts({ projectDir: PROJECT, window: WINDOW, deadline: Date.now() + 60000 });
  check('over 1,000,000 events = timeout', r.reason === 'timeout' && r.sessions.length === 0, `${r.reason} in ${Date.now() - started} ms`);
}
resetHome();

// --- 4. CLI arguments, env and state as untrusted --------------------------------------------------
console.log('CLI arguments');
setup();
put(SESSION, jsonl([user(0), assistant(10, 'ok')]));
for (const args of [
  ['time', '--slug', `../${SLUG}`],
  ['time', '--slug', HOSTILE],
  ['time', '--slug', '..'],
  ['time', '--slug', 'a\\..\\b'],
  ['time', '--slug', SLUG, '--slug', SLUG],
  ['time', '--slug', SLUG, '--evil', HOSTILE],
  ['time', '--slug'],
  ['time'],
  ['time', '--slug', SLUG, '--project-dir', ''],
  ['time', '--slug', SLUG, '--project-dir', path.join(TEST_HOME, 'nope', HOSTILE)],
]) {
  res = cli(args);
  check(`exit 2, fixed usage, nothing echoed: ${JSON.stringify(args.slice(1)).slice(0, 60)}`, res.status === 2 && res.stdout === '' && res.stderr.startsWith('usage') === res.stderr.startsWith('usage') && clean(res) && !res.stderr.includes('my-run/'), JSON.stringify(res.stderr.slice(0, 80)));
}
res = cli(['time', '--slug', 'no-such-run']);
check('missing run: fixed code line, exit 0', res.status === 0 && CODE.test(res.stdout) && !res.stdout.includes('no-such-run'));
res = cli(['time', '--slug', SLUG, '--project-dir', path.join(TEST_HOME, 'work')]);
check('--project-dir without config: bad-config code', res.status === 0 && res.stdout === 'metrics: bad-config time\n');

console.log('TASK_FLOW_METRICS=off is checked first');
for (const v of ['off', 'OFF', 'Off']) {
  res = cli(['time', '--slug', HOSTILE], { TASK_FLOW_METRICS: v });
  check(`off (${v}) before argument parsing`, res.status === 0 && res.stdout === 'metrics: disabled time\n' && res.stderr === '');
}

console.log('state.json hostile');
for (const state of [
  { startedAt: HOSTILE },
  { startedAt: iso(Date.now() + 3600000) }, // starts in the future
  { phase: 'done', phaseChangedAt: HOSTILE },
  { phase: 'done', phaseChangedAt: iso(S - MIN) }, // closes before it starts
  { __proto__: { startedAt: iso(S) }, startedAt: undefined },
]) {
  setup(state);
  put(SESSION, jsonl([user(0), assistant(10, 'ok')]));
  res = cli(['time', '--slug', SLUG]);
  check(`state ${JSON.stringify(state).slice(0, 50)}: fixed code, nothing echoed`, res.status === 0 && CODE.test(res.stdout) && clean(res), JSON.stringify(res.stdout));
}
setup();
const realState = path.join(STATE, SLUG, 'state.json');
const target = path.join(TEST_HOME, 'outside-state.json');
put(target, { task: SLUG, phase: 'build', status: 'running', startedAt: iso(S) });
fs.rmSync(realState);
let stateLinked = false;
try { fs.symlinkSync(target, realState, 'file'); stateLinked = true; } catch { /* no symlink right */ }
if (stateLinked) {
  res = cli(['time', '--slug', SLUG]);
  check('state.json as a link: refused with a code', res.status === 0 && CODE.test(res.stdout), res.stdout);
}

console.log('writes nothing');
setup();
put(SESSION, jsonl([user(0), assistant(10, 'ok')]));
const snap = () => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const s = fs.statSync(p); out.push(`${p}:${s.size}:${s.mtimeMs}`); } } };
  walk(TEST_HOME);
  return out.sort().join('\n');
};
const before = snap();
res = cli(['time', '--slug', SLUG]);
check('a valid row, and nothing under HOME changed', ROW.test(res.stdout) && snap() === before, res.stdout);

console.log(`\n${passed} passed, ${failures.length} failed`);
fs.rmSync(TEST_HOME, { recursive: true, force: true });
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
