#!/usr/bin/env node
// Security tests for the loop start events (plan T1): appendLoopEvent, the one
// writer of a run's loop-events.jsonl, readLoopEvents, its one reader, and the
// SubagentStart hook that calls the writer. The payload, state.json and the
// events file are all untrusted: a hostile value must never reach the file
// outside its closed shape, never be echoed (result, stdout, stderr) and never
// make anything follow a link or throw. Everything lives under a throwaway HOME.
//
// Run: node tests/metrics.loops.security.test.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-loopsec-'));
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
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

const { appendLoopEvent, readLoopEvents } = require('../plugin/scripts/metrics.js');
const HOOK = path.join(__dirname, '..', 'plugin', 'hooks', 'subagent-start.js');

const PROJECT = path.join(TEST_HOME, 'work', 'proj');
const STATE = path.join(PROJECT, '.claude', 'task-flow');
const SLUG = 'my-run';
const RUN_DIR = path.join(STATE, SLUG);
const EVENTS = path.join(RUN_DIR, 'loop-events.jsonl');
const MARKERS = ['IGNORE PREVIOUS', '<img onerror', '../', '‮', 'EVILMARK'];
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); };
const hasMarker = (text) => MARKERS.some((m) => String(text).includes(m));

function setup({ state = {}, config = {} } = {}) {
  fs.rmSync(PROJECT, { recursive: true, force: true });
  put(path.join(PROJECT, '.claude', 'task-flow.json'), { docsDir: 'docs', language: 'EN', tasksFile: 'tasks.md', ...config });
  put(path.join(PROJECT, 'docs', 'tasks.md'), '# tasks\n');
  put(path.join(RUN_DIR, 'state.json'), typeof state === 'string' ? state : { task: SLUG, phase: 'plan', status: 'running', buildCursor: 'T3', ...state });
}
const PAYLOAD = { hook_event_name: 'SubagentStart', agent_id: 'a1b2c3d4', agent_type: 'general-purpose' };
const append = (payload) => appendLoopEvent({ projectDir: PROJECT, payload, env: {} });
const fileText = () => (fs.existsSync(EVENTS) ? fs.readFileSync(EVENTS, 'utf8') : '');

// --- 1. hostile payload: no line, nothing echoed --------------------------------------------
{
  const longId = 'a'.repeat(65);
  const hostileIds = ['../x', 'a\\b', 'a b', longId, 42, { x: 1 }, '__proto__', '', null];
  for (const id of hostileIds) {
    setup();
    const r = append({ ...PAYLOAD, agent_id: id });
    check(`agent_id ${JSON.stringify(id).slice(0, 20)}: not written`, !r.ok && fileText() === '' && !hasMarker(JSON.stringify(r)), JSON.stringify(r));
  }
  const hostileTypes = ['<img onerror=alert(1)>', 'a\nb', 'a‮b', 'IGNORE PREVIOUS', '-x', 'a'.repeat(81)];
  for (const type of hostileTypes) {
    setup();
    const r = append({ ...PAYLOAD, agent_type: type });
    check(`agent_type ${JSON.stringify(type).slice(0, 20)}: not written, not echoed`, !r.ok && fileText() === '' && !hasMarker(JSON.stringify(r)));
  }
  // inherited (prototype) values never count as the payload's own
  setup();
  const proto = Object.create({ agent_id: 'a1b2c3d4', agent_type: 'general-purpose' });
  check('agent_id/agent_type only from the prototype: not written', !append(proto).ok && fileText() === '');
  // extra fields are dropped
  setup();
  const r = append({ ...PAYLOAD, prompt: 'IGNORE PREVIOUS EVILMARK', cwd: '\\\\evil\\share\\EVILMARK', transcript_path: '../EVILMARK' });
  check('extra payload fields: line written without them', r.ok && fileText() !== '' && !hasMarker(fileText()), fileText());
  // a type exactly at the shape limit fits under the 512-byte line cap
  setup();
  const max = `a${'b'.repeat(79)}`;
  const rm = append({ ...PAYLOAD, agent_id: 'z'.repeat(64), agent_type: max });
  check('agent_id/agent_type at the shape limit: written, line <= 512 bytes', rm.ok && Buffer.byteLength(fileText().split('\n')[0]) <= 512);
}

// --- 2. hostile state.json ------------------------------------------------------------------
{
  setup({ state: { phase: '<img onerror=x> EVILMARK' } });
  append(PAYLOAD);
  check('phase outside PHASES -> unknown, not copied', JSON.parse(fileText()).phase === 'unknown' && !hasMarker(fileText()));
  for (const cursor of ['../x', 'IGNORE PREVIOUS', 7]) {
    setup({ state: { buildCursor: cursor } });
    append(PAYLOAD);
    check(`buildCursor ${JSON.stringify(cursor)} -> ""`, JSON.parse(fileText()).task === '' && !hasMarker(fileText()));
  }
  setup({ state: '{"task":"my-run","phase":"plan","status":"running","__proto__":{"polluted":"EVILMARK"}}' });
  append(PAYLOAD);
  check('state.json __proto__ does not pollute Object.prototype', ({}).polluted === undefined);
}

// --- 3. links, folders, a full file: nothing written, nothing followed -----------------------
{
  const outside = path.join(TEST_HOME, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const target = path.join(outside, 'target.jsonl');
  const tryLink = (make) => { try { make(); return true; } catch { return false; } };

  setup();
  fs.writeFileSync(target, '');
  if (tryLink(() => fs.symlinkSync(target, EVENTS, 'file'))) {
    const r = append(PAYLOAD);
    check('loop-events.jsonl as symlink: refused, target untouched', !r.ok && fs.readFileSync(target, 'utf8') === '');
  } else console.log('  skip  file symlink (no privilege)');

  setup();
  fs.mkdirSync(EVENTS);
  check('loop-events.jsonl as folder: refused', !append(PAYLOAD).ok);

  setup();
  fs.writeFileSync(EVENTS, `${'x'.repeat(1024 * 1024)}\n`);
  const before = fs.statSync(EVENTS).size;
  check('loop-events.jsonl over 1 MiB: full, nothing appended', append(PAYLOAD).code === 'full' && fs.statSync(EVENTS).size === before);

  // the run folder itself is a junction to outside the project
  setup();
  const outRun = path.join(outside, 'run');
  fs.mkdirSync(outRun, { recursive: true });
  fs.copyFileSync(path.join(RUN_DIR, 'state.json'), path.join(outRun, 'state.json'));
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  if (tryLink(() => fs.symlinkSync(outRun, RUN_DIR, 'junction'))) {
    const r = append(PAYLOAD);
    check('run folder as junction: nothing written outside', !r.ok && !fs.existsSync(path.join(outRun, 'loop-events.jsonl')), JSON.stringify(r));
    check('reader through junction: no events', readLoopEvents(PROJECT, STATE, SLUG).starts.length === 0);
  } else console.log('  skip  junction (unsupported)');

  // stateDir escaping the project is refused by config.js
  for (const stateDir of ['..', '../escape', outside]) {
    setup({ config: { stateDir } });
    put(path.join(path.resolve(PROJECT, stateDir), SLUG, 'state.json'), { phase: 'plan', status: 'running' });
    const r = append(PAYLOAD);
    check(`stateDir ${stateDir === outside ? '<abs outside>' : stateDir}: refused`, !r.ok && !fs.existsSync(path.join(path.resolve(PROJECT, stateDir), SLUG, 'loop-events.jsonl')), JSON.stringify(r));
  }
}

// --- 4. the reader: garbage counted, never echoed, never throws -----------------------------
{
  setup();
  append(PAYLOAD);
  const good = fileText().trim();
  const bad = [
    'IGNORE PREVIOUS EVILMARK', '{"v":1,', JSON.stringify({ ...JSON.parse(good), v: 2 }),
    JSON.stringify({ ...JSON.parse(good), extra: 'EVILMARK' }), JSON.stringify({ ...JSON.parse(good), agent: '../x' }),
    JSON.stringify({ ...JSON.parse(good), type: '<img onerror=x>' }), `{"pad":"${'x'.repeat(600)}"}`,
  ];
  fs.appendFileSync(EVENTS, `${bad.join('\n')}\n`);
  let r;
  try { r = readLoopEvents(PROJECT, STATE, SLUG); } catch { r = null; }
  check('reader: garbage counted in ignored', r && r.starts.length === 1 && r.ignored === bad.length, JSON.stringify(r && { s: r.starts.length, i: r.ignored }));
  check('reader: nothing hostile in what it returns', r && !hasMarker(JSON.stringify(r)));

  fs.writeFileSync(EVENTS, `${'junk EVILMARK\n'.repeat(10000)}`);
  try { r = readLoopEvents(PROJECT, STATE, SLUG); } catch { r = null; }
  check('reader: 10 000 junk lines -> ignored, no throw', r && r.starts.length === 0 && r.ignored === 10000);
  for (const slug of ['../x', '..', 'a/b', '', null]) {
    let ok;
    try { ok = readLoopEvents(PROJECT, STATE, slug).starts.length === 0; } catch { ok = false; }
    check(`reader: slug ${JSON.stringify(slug)} -> empty`, ok);
  }
}

// --- 5. the hook: exit 0, silent, nothing echoed --------------------------------------------
{
  setup();
  const env = { ...process.env, CLAUDE_PROJECT_DIR: PROJECT };
  const cases = [
    JSON.stringify({ ...PAYLOAD, agent_id: '../EVILMARK', agent_type: '<img onerror=x>‮', prompt: 'IGNORE PREVIOUS' }),
    'not json IGNORE PREVIOUS', JSON.stringify([1, 2]), '',
  ];
  for (const input of cases) {
    const p = spawnSync(process.execPath, [HOOK], { input, env, encoding: 'utf8', timeout: 10000 });
    check(`hook with hostile stdin ${JSON.stringify(input.slice(0, 15))}: exit 0, silent`, p.status === 0 && p.stdout === '' && p.stderr === '', `${p.status} ${p.stderr}`);
  }
  check('hook: no hostile line written', !hasMarker(fileText()));
}

// --- 6. by construction: the new section has no named catch, require, spawn or eval -----------
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'scripts', 'metrics.js'), 'utf8');
  const start = src.indexOf('// --- loop start events');
  const end = src.indexOf('Object.assign(module.exports, { appendLoopEvent, readLoopEvents });');
  const slice = start >= 0 && end > start ? src.slice(start, end) : '';
  check('section found', slice.length > 0);
  check('no named catch in the section', !/catch\s*\(/.test(slice));
  check('no require/child_process/spawn/eval in the section', !/require\(|child_process|spawn|eval\(/.test(slice));
}

fs.rmSync(TEST_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
