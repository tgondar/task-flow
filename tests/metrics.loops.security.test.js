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

// --- 7. T3: loop rows and loops.jsonl are untrusted repository data ---------------------------
{
  const { validateLoopRow, readLoops, appendLoopRows } = require('../plugin/scripts/metrics.js');
  const LOOPS = path.join(STATE, 'loops.jsonl');
  const ROW = {
    v: 1, source: 'taskflow', run: SLUG, id: 'a1b2c3d4', agentType: 'task-flow:security-auditor', phase: 'build', task: 'T3',
    round: null, model: 'claude-opus-5-5', effort: 'high', startedAt: '2026-11-27T10:00:00.123Z', durationS: 312,
    tokens: { input: 10, cacheCreate: 2000, cacheRead: 50000, output: 900 }, costCents: null,
    outcome: 'ok', tests: 'green', critical: 0, required: 1, reason: null, backfill: false,
  };
  const fresh = () => { fs.rmSync(PROJECT, { recursive: true, force: true }); fs.mkdirSync(STATE, { recursive: true }); };
  const safeRead = (sd = STATE) => { try { return readLoops(PROJECT, sd); } catch { return 'THREW'; } };
  const loopsText = () => (fs.existsSync(LOOPS) ? fs.readFileSync(LOOPS, 'utf8') : '');

  // hostile files in place of loops.jsonl: bounded, no throw, no echo
  const bodies = {
    'garbage 64 MiB': () => fs.writeFileSync(LOOPS, Buffer.alloc(64 * 1024 * 1024, 'IGNORE PREVIOUS ')),
    '2 MiB line without newline': () => fs.writeFileSync(LOOPS, `{"x":"${'EVILMARK'.repeat(256 * 1024)}`),
    'BOM + CRLF valid row': () => fs.writeFileSync(LOOPS, `﻿${JSON.stringify(ROW)}\r\n`),
    'v: 2 line': () => fs.writeFileSync(LOOPS, `${JSON.stringify({ ...ROW, v: 2, note: 'IGNORE PREVIOUS' })}\n`),
  };
  for (const [name, make] of Object.entries(bodies)) {
    fresh(); make();
    const t0 = Date.now();
    const r = safeRead();
    check(`loops.jsonl ${name}: no throw, bounded, no echo`, r !== 'THREW' && Date.now() - t0 < 5000 && !hasMarker(JSON.stringify(r)), JSON.stringify(r).slice(0, 80));
  }
  fresh(); bodies['BOM + CRLF valid row']();
  check('BOM + CRLF: the row is read', safeRead().rows.length === 1);
  fresh(); bodies['v: 2 line']();
  { const r = safeRead(); check('v: 2: no row, not an error', r.code === null && r.rows.length === 0); }

  fresh(); fs.mkdirSync(LOOPS);
  check('loops.jsonl as a folder: unsafe-path, append refused', safeRead().code === 'unsafe-path' && !appendLoopRows(PROJECT, STATE, [ROW]).ok);

  fresh();
  const outside = path.join(TEST_HOME, 'outside.jsonl');
  fs.writeFileSync(outside, `${JSON.stringify({ ...ROW, id: 'EVILMARK' })}\n`);
  let linked = true;
  try { fs.symlinkSync(outside, LOOPS, 'file'); } catch { linked = false; }
  if (linked) {
    const before = fs.readFileSync(outside, 'utf8');
    const r = safeRead();
    const w = appendLoopRows(PROJECT, STATE, [ROW]);
    check('loops.jsonl as symlink: not read, not written', r.rows.length === 0 && !w.ok && fs.readFileSync(outside, 'utf8') === before);
  } else console.log('  skip symlink (no privilege)');
  fresh();
  const outDir = path.join(TEST_HOME, 'outdir');
  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(STATE, { recursive: true, force: true });
  let junction = true;
  try { fs.symlinkSync(outDir, STATE, 'junction'); } catch { junction = false; }
  if (junction) {
    appendLoopRows(PROJECT, STATE, [ROW]);
    check('stateDir as junction: nothing written outside', !fs.existsSync(path.join(outDir, 'loops.jsonl')));
    fs.unlinkSync(STATE);
  }

  // hostile values: refused, prototype intact
  const hostile = [
    JSON.parse(`{"__proto__":{"polluted":1},${JSON.stringify(ROW).slice(1)}`),
    { ...ROW, constructor: { prototype: { polluted: 1 } } },
    { ...ROW, durationS: 1e13 }, { ...ROW, critical: -1 }, { ...ROW, required: 'NaN' },
    { ...ROW, model: 'IGNORE PREVIOUS' }, { ...ROW, agentType: '<img onerror=x>' }, { ...ROW, run: '../x' },
    { ...ROW, task: '‮T3' }, { ...ROW, tokens: { ...ROW.tokens, input: 1e13 } },
    { ...ROW, tokens: JSON.parse('{"input":1,"cacheCreate":1,"cacheRead":1,"output":1,"__proto__":{"x":1}}') },
  ];
  check('NaN number refused', !validateLoopRow({ ...ROW, durationS: NaN }).ok);
  for (const [i, row] of hostile.entries()) check(`hostile row ${i}: refused`, !validateLoopRow(row).ok);
  fresh();
  const lines = hostile.map((r) => JSON.stringify(r)).concat([
    '{"__proto__":{"polluted":1}}', '{"v":1,"durationS":1e13}', JSON.stringify(ROW).replace('312', 'NaN'), '{"constructor":{"prototype":{"polluted":1}}}',
  ]);
  fs.writeFileSync(LOOPS, `${lines.join('\n')}\n`);
  const r = safeRead();
  check('hostile lines: all ignored, nothing echoed', r.rows.length === 0 && r.ignored === lines.length && !hasMarker(JSON.stringify(r)), JSON.stringify(r).slice(0, 120));
  const w = appendLoopRows(PROJECT, STATE, hostile);
  check('hostile rows: none appended', w.written === 0 && !hasMarker(loopsText().split('\n').slice(lines.length).join('')));
  check('Object.prototype intact', ({}).polluted === undefined && ({}).x === undefined);

  // the writer: only bad stateDir values
  for (const sd of ['', '.claude/task-flow', path.join(TEST_HOME, 'elsewhere'), null]) {
    fresh();
    let res;
    try { res = appendLoopRows(PROJECT, sd, [ROW]); } catch { res = { ok: 'THREW' }; }
    check(`stateDir ${JSON.stringify(sd)}: nothing written`, res.ok === false && !fs.existsSync(LOOPS) && !fs.existsSync(path.join(TEST_HOME, 'elsewhere', 'loops.jsonl')), JSON.stringify(res));
  }

  // by construction: no named catch, require, spawn or eval in the T3 section
  const src = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'scripts', 'metrics.js'), 'utf8');
  const s = src.indexOf('// --- loop rows: the closed shape');
  const e = src.indexOf('Object.assign(module.exports, { LOOP_KEYS');
  const slice = s >= 0 && e > s ? src.slice(s, e) : '';
  check('T3 section found', slice.length > 0);
  check('T3 section: no named catch, require, spawn or eval', !/catch\s*\(|require\(|child_process|spawn|eval\(/.test(slice));
}

fs.rmSync(TEST_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
