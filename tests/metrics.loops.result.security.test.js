#!/usr/bin/env node
// Security tests for the loop result (plan T5): the `metrics.js loop-result` CLI, whose
// every argument is untrusted text, the result event it appends to loop-events.jsonl, the
// reader that returns the results and the join that puts the last one per agent on its row.
// A hostile argument must exit 1 with the one fixed message, write nothing and never be
// echoed; a forged result line planted in the file must never reach a row outside its closed
// shape. Everything lives under a throwaway HOME.
//
// Run: node tests/metrics.loops.result.security.test.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-loopres-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.LOCALAPPDATA = TEST_HOME;
process.env.XDG_STATE_HOME = TEST_HOME;
delete process.env.TASK_FLOW_METRICS;
delete process.env.TASK_FLOW_GATE;
delete process.env.CLAUDE_PROJECT_DIR;

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

const { readLoopEvents, joinLoops } = require('../plugin/scripts/metrics.js');
const CLI = path.join(__dirname, '..', 'plugin', 'scripts', 'metrics.js');

const PROJECT = path.join(TEST_HOME, 'work', 'proj');
const STATE = path.join(PROJECT, '.claude', 'task-flow');
const SLUG = 'my-run';
const RUN_DIR = path.join(STATE, SLUG);
const EVENTS = path.join(RUN_DIR, 'loop-events.jsonl');
const MARKERS = ['IGNORE PREVIOUS', '<img onerror', '../', '‮', 'EVILMARK', '<script>'];
const hasMarker = (text) => MARKERS.some((m) => String(text).includes(m));
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); };
const SEED = '{"seed":1}\n';

function setup() {
  fs.rmSync(PROJECT, { recursive: true, force: true });
  put(path.join(PROJECT, '.claude', 'task-flow.json'), { docsDir: 'docs', language: 'EN', tasksFile: 'tasks.md' });
  put(path.join(PROJECT, 'docs', 'tasks.md'), '# tasks\n');
  put(path.join(RUN_DIR, 'state.json'), { task: SLUG, phase: 'build', status: 'running', buildCursor: 'T3' });
  fs.writeFileSync(EVENTS, SEED);
}
const run = (args, env = {}) => spawnSync(process.execPath, [CLI, 'loop-result', ...args], {
  encoding: 'utf8', cwd: TEST_HOME, env: { ...process.env, ...env },
});
const BASE = ['--slug', SLUG, '--agent', 'a1b2c3d4', '--outcome', 'ok', '--project-dir', PROJECT];
const INVALID = 'metrics: invalid loop-result\n';

// --- 1. hostile arguments: exit 1, fixed message, nothing written, nothing echoed ----------
{
  const swap = (flag, value) => { const a = BASE.slice(); const i = a.indexOf(flag); a[i + 1] = value; return a; };
  const cases = [
    ['--critical -1', [...BASE, '--critical', '-1']],
    ['--critical 1e3', [...BASE, '--critical', '1e3']],
    ['--critical 08', [...BASE, '--critical', '08']],
    ['--critical " 1"', [...BASE, '--critical', ' 1']],
    ['--required 0x10', [...BASE, '--required', '0x10']],
    ['--round 0', [...BASE, '--round', '0']],
    ['--round 100', [...BASE, '--round', '100']],
    ['--outcome DONE', swap('--outcome', 'DONE')],
    ['--outcome __proto__', swap('--outcome', '__proto__')],
    ['--tests yellow', [...BASE, '--tests', 'yellow']],
    ['--task ../x', [...BASE, '--task', '../x']],
    ['--task T1;rm', [...BASE, '--task', 'T1;rm']],
    ['--task IGNORE PREVIOUS', [...BASE, '--task', 'IGNORE PREVIOUS EVILMARK']],
    ['--agent a/b', swap('--agent', 'a/b')],
    ['--agent <img onerror>', swap('--agent', '<img onerror=x>')],
    ['--agent bidi', swap('--agent', 'a‮b')],
    ['--slug ../evil', swap('--slug', '../evil')],
    ['--slug ..\\evil', swap('--slug', '..\\evil')],
    ['--phase <script>', [...BASE, '--phase', '<script>']],
    ['--phase unknown', [...BASE, '--phase', 'unknown']],
    ['--phase constructor', [...BASE, '--phase', 'constructor']],
    ['flag without value', [...BASE, '--tests']],
    ['flag value is a flag', ['--slug', '--agent', 'a1b2c3d4', '--outcome', 'ok', '--project-dir', PROJECT]],
    ['repeated flag', [...BASE, '--outcome', 'retry']],
    ['repeated --project-dir', [...BASE, '--project-dir', PROJECT]],
    ['unknown flag', [...BASE, '--evil', 'EVILMARK']],
    ['__proto__ flag', [...BASE, '__proto__', 'x']],
    ['constructor flag', [...BASE, 'constructor', 'x']],
    ['missing --outcome', BASE.filter((_, i) => i !== 4 && i !== 5)],
    ['missing --agent', BASE.filter((_, i) => i !== 2 && i !== 3)],
    ['stray positional', [...BASE, 'EVILMARK']],
  ];
  for (const [name, args] of cases) {
    setup();
    const r = run(args);
    check(`${name}: exit 1, fixed message, file intact`,
      r.status === 1 && r.stdout === '' && r.stderr === INVALID && fs.readFileSync(EVENTS, 'utf8') === SEED,
      `${r.status} ${JSON.stringify(r.stdout)} ${JSON.stringify(r.stderr)}`);
  }
  // the slug never reaches a path outside the state folder
  check('--slug ../evil: no file outside the run folder', !fs.existsSync(path.join(STATE, 'evil')) && !fs.existsSync(path.join(PROJECT, '.claude', 'evil')));

  // a valid call never echoes even its own (valid) arguments
  setup();
  const ok = run([...BASE, '--task', 'T3', '--phase', 'build', '--round', '2']);
  check('valid call: exit 0, closed line, no argument echoed',
    ok.status === 0 && ok.stdout === 'metrics: written loop-result\n' && ok.stderr === '' && !ok.stdout.includes(SLUG) && !ok.stdout.includes('a1b2c3d4'),
    `${ok.status} ${ok.stdout} ${ok.stderr}`);
  const line = fs.readFileSync(EVENTS, 'utf8').split('\n')[1];
  check('valid call: the line is exactly the closed shape', /^\{"v":1,"kind":"result","agent":"a1b2c3d4","outcome":"ok","tests":null,"critical":null,"required":null,"round":2,"phase":"build","task":"T3"\}$/.test(line), line);

  // --project-dir: missing, empty, or a folder with no config writes nothing anywhere
  setup();
  const outside = path.join(TEST_HOME, 'other');
  fs.mkdirSync(outside, { recursive: true });
  for (const [name, dir] of [['missing', path.join(TEST_HOME, 'nope', '..', 'EVILMARK')], ['empty', ''], ['no config', outside]]) {
    const r = run(swap('--project-dir', dir));
    check(`--project-dir ${name}: exit 1, no echo, nothing written`,
      r.status === 1 && r.stdout === '' && /^metrics: [a-z-]+ loop-result\n$/.test(r.stderr) && !hasMarker(r.stderr)
      && fs.readFileSync(EVENTS, 'utf8') === SEED && fs.readdirSync(outside).length === 0,
      `${r.status} ${JSON.stringify(r.stderr)}`);
  }

  // TASK_FLOW_METRICS=off: nothing parsed, nothing written, even for hostile arguments
  setup();
  const off = run([...BASE, '--task', '../EVILMARK'], { TASK_FLOW_METRICS: 'off' });
  check('TASK_FLOW_METRICS=off: exit 0, nothing written, no echo', off.status === 0 && off.stdout === 'metrics: disabled loop-result\n' && fs.readFileSync(EVENTS, 'utf8') === SEED);
}

// --- 2. the events file as a link or folder: refused, nothing followed ---------------------
{
  const tryLink = (make) => { try { make(); return true; } catch { return false; } };
  const target = path.join(TEST_HOME, 'outside.jsonl');
  setup();
  fs.rmSync(EVENTS);
  fs.writeFileSync(target, '');
  if (tryLink(() => fs.symlinkSync(target, EVENTS, 'file'))) {
    const r = run(BASE);
    check('events file as symlink: exit 1, closed code, target untouched', r.status === 1 && /^metrics: [a-z-]+ loop-result\n$/.test(r.stderr) && fs.readFileSync(target, 'utf8') === '');
  } else console.log('  skip  file symlink (no privilege)');
  setup();
  fs.rmSync(EVENTS);
  fs.mkdirSync(EVENTS);
  const d = run(BASE);
  check('events file as folder: exit 1, closed code, nothing inside', d.status === 1 && /^metrics: [a-z-]+ loop-result\n$/.test(d.stderr) && fs.readdirSync(EVENTS).length === 0);
  const outRun = path.join(TEST_HOME, 'outrun');
  setup();
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(outRun, { recursive: true });
  if (tryLink(() => fs.symlinkSync(outRun, RUN_DIR, 'junction'))) {
    const r = run(BASE);
    check('run folder as junction: exit 1, nothing written outside', r.status === 1 && !fs.existsSync(path.join(outRun, 'loop-events.jsonl')));
  } else console.log('  skip  junction (unsupported)');
  // no run folder: not created from the argument
  setup();
  const nf = run(swap2('--slug', 'other-run'));
  check('slug with no run folder: exit 1, folder not created', nf.status === 1 && !fs.existsSync(path.join(STATE, 'other-run')));
}
function swap2(flag, value) { const a = BASE.slice(); a[a.indexOf(flag) + 1] = value; return a; }

// --- 3. flooding: the 1 MiB cap holds for result events too --------------------------------
{
  setup();
  fs.writeFileSync(EVENTS, `${'x'.repeat(1024 * 1024 + 10)}\n`);
  const before = fs.statSync(EVENTS).size;
  const r = run(BASE);
  check('full events file: exit 1, closed code, not grown', r.status === 1 && /^metrics: [a-z-]+ loop-result\n$/.test(r.stderr) && fs.statSync(EVENTS).size === before, `${r.stderr} ${fs.statSync(EVENTS).size}`);
}

// --- 4. forged result lines planted in the file: never reach a row out of shape -----------
{
  setup();
  const start = { v: 1, kind: 'start', agent: 'a1b2c3d4', type: 'task-flow:security-auditor', phase: 'build', task: 'T3', at: '2026-11-27T10:00:00.000Z' };
  const good = { v: 1, kind: 'result', agent: 'a1b2c3d4', outcome: 'ok', tests: 'green', critical: 0, required: 1, round: 1, phase: null, task: null };
  const forged = [
    { ...good, phase: '<script>', outcome: 'failed' },
    { ...good, task: '../EVILMARK', outcome: 'failed' },
    { ...good, critical: -1, outcome: 'failed' },
    { ...good, critical: 1.5, outcome: 'failed' },
    { ...good, round: 100, outcome: 'failed' },
    { ...good, outcome: 'IGNORE PREVIOUS' },
    { ...good, extra: 'EVILMARK', outcome: 'failed' },
  ];
  const lines = [start, good, ...forged].map((e) => JSON.stringify(e));
  lines.push(JSON.stringify(good).replace('{', '{"__proto__":{"outcome":"failed"},'));
  lines.push(`{"v":1,"kind":"result","agent":"a1b2c3d4","outcome":"failed","__proto__":null,"tests":null,"critical":null,"required":null,"round":null,"phase":null,"task":null}`);
  lines.push('x'.repeat(600));
  fs.writeFileSync(EVENTS, `${lines.join('\n')}\n`);
  const events = readLoopEvents(PROJECT, STATE, SLUG);
  check('reader: only the valid result kept, forged ones counted', events.results.length === 1 && events.ignored === forged.length + 3, JSON.stringify({ r: events.results.length, i: events.ignored }));
  check('reader: no marker in what it returns', !hasMarker(JSON.stringify(events)));
  const rows = joinLoops({ projectDir: PROJECT, slug: SLUG, events, deadline: Date.now() + 5000 });
  check('join: the row carries the valid result, start phase/task kept', rows.length === 1 && rows[0].outcome === 'ok' && rows[0].phase === 'build' && rows[0].task === 'T3' && rows[0].round === 1, JSON.stringify(rows));
  // results handed straight to the exported join (not via the reader) are checked again
  const hostile = joinLoops({ projectDir: PROJECT, slug: SLUG, events: { starts: events.starts, results: forged, ignored: 0 }, deadline: Date.now() + 5000 });
  check('join: hostile in-memory results ignored, row unchanged', hostile.length === 1 && hostile[0].outcome === null && hostile[0].phase === 'build' && !hasMarker(JSON.stringify(hostile)), JSON.stringify(hostile));
  const protoResult = Object.create(good);
  const inherited = joinLoops({ projectDir: PROJECT, slug: SLUG, events: { starts: events.starts, results: [protoResult], ignored: 0 }, deadline: Date.now() + 5000 });
  check('join: a result made only of prototype values ignored', inherited.length === 1 && inherited[0].outcome === null);
  // a result for another agent does not change this agent's row
  const other = joinLoops({ projectDir: PROJECT, slug: SLUG, events: { starts: events.starts, results: [{ ...good, agent: 'zzzz9999', phase: 'review', outcome: 'failed' }], ignored: 0 }, deadline: Date.now() + 5000 });
  check('join: another agent\'s result does not touch the row', other.length === 1 && other[0].outcome === null && other[0].phase === 'build');
}

// --- 5. source: the T5 section stays inside the source-slice rules -----------------------
{
  const src = fs.readFileSync(CLI, 'utf8');
  const s = src.indexOf('// --- the loop result: the loop-result CLI');
  const e = src.indexOf('Object.assign(module.exports, { runCommand });');
  const slice = s >= 0 && e > s ? src.slice(s, e) : '';
  check('T5 section found', slice.length > 0);
  check('T5 section: no named catch, require, spawn, eval or JSON.parse', !/catch\s*\(|require\(|child_process|spawn|eval\(|JSON\.parse/.test(slice));
  check('T5 section: no argv value used as an object key', !/\[\s*flag\s*\]/.test(slice));
  check('T5 section: stderr/stdout writes carry only closed codes', !/write\([^)]*(slug|agent|value|args)/.test(slice));
}

fs.rmSync(TEST_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
