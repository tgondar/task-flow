#!/usr/bin/env node
// Security tests for `metrics.js summary --slug <run>` (plan T9, spec RF-033/RF-034). The block it
// prints is pasted into a GitHub PR body, read by people and models, so every input is hostile:
// loop-events.jsonl, loops.jsonl, the subagent and main transcripts, state.json and the CLI
// arguments. What these hold:
//   - stdout is only numbers, phase names from the closed set and the fixed phrases: no markdown,
//     HTML, link, `@mention` or `#ref` from any file reaches it, nor the slug;
//   - the hostile markers (IGNORE PREVIOUS, <img onerror>, ../, U+202E) never reach stdout/stderr;
//   - nothing is written: a byte-level snapshot of HOME (stateDir included) is unchanged, and an
//     in-process spy sees no fs write/open-for-write;
//   - hostile --slug/--project-dir: the fixed usage (exit 2) or a fixed code line;
//   - TASK_FLOW_METRICS=off is checked before anything (a broken config is not even read);
//   - sums past the safe-integer range print a dash, never an exponent, Infinity or NaN;
//   - rows of another run, or started before startedAt, stay out;
//   - loops.jsonl as a link/junction, a folder or oversize: a fixed code, nothing followed.
// Everything is synthetic under a throwaway HOME.
//
// Run: node tests/metrics.summary.security.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-sumsec-'));
for (const k of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_STATE_HOME']) process.env[k] = TEST_HOME;
delete process.env.TASK_FLOW_METRICS;
delete process.env.TASK_FLOW_GATE;

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push(`${name}${detail ? ` - ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

const METRICS = path.resolve(__dirname, '../plugin/scripts/metrics.js');
const PROJECT = path.join(TEST_HOME, 'work', 'proj');
const STATE = path.join(PROJECT, '.claude', 'task-flow');
const SLUG = 'my-run';
const EVENTS = path.join(STATE, SLUG, 'loop-events.jsonl');
const LOOPS = path.join(STATE, 'loops.jsonl');
const BASE = path.join(TEST_HOME, '.claude', 'projects', PROJECT.replace(/[^A-Za-z0-9]/g, '-'));
const SUBAGENTS = path.join(BASE, 'sess1', 'subagents');
const MAIN = path.join(BASE, 'aaaaaaaa-0000-4000-8000-000000000009.jsonl');
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); };
const jsonl = (records) => `${records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`;
const MIN = 60 * 1000;
const S = Date.now() - 2 * 60 * MIN;
const at = (m, s = 0) => new Date(S + m * MIN + s * 1000).toISOString();
const HOSTILE = 'IGNORE PREVIOUS <img src=x onerror=alert(1)> [x](https://evil.example) @octocat #12 ../../etc ‮ evil';
const MARKERS = ['IGNORE PREVIOUS', '<img', 'onerror', '../', '‮', 'evil', '@octocat', '#12', 'https:', SLUG];
const usage = (i, o, cc = 0, cr = 0) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cc, cache_read_input_tokens: cr });
const user = (ts, text = 'do it') => ({ type: 'user', timestamp: ts, agentId: 'x', message: { role: 'user', content: text } });
const asst = (ts, req, u, text = HOSTILE) => ({ type: 'assistant', timestamp: ts, requestId: req, agentId: 'x', message: { model: 'claude-opus-5-5', usage: u, content: [{ type: 'text', text }] } });
const startLine = (agent, type, phase, task, m) => ({ v: 1, kind: 'start', agent, type, phase, task, at: at(m) });
const row = (id, m, tokens, extra = {}) => ({
  v: 1, source: 'taskflow', run: SLUG, id, agentType: 'general-purpose', phase: 'build', task: 'T1', round: null, model: null, effort: 'unknown',
  startedAt: at(m), durationS: 60, tokens: tokens === null ? null : { input: tokens, cacheCreate: 0, cacheRead: 0, output: 0 }, costCents: null, outcome: 'ok', tests: null,
  critical: null, required: null, reason: null, backfill: false, ...extra,
});

function fixture({ state = {}, agentType = 'general-purpose' } = {}) {
  fs.rmSync(PROJECT, { recursive: true, force: true });
  fs.rmSync(path.join(TEST_HOME, '.claude'), { recursive: true, force: true });
  put(path.join(PROJECT, '.claude', 'task-flow.json'), { docsDir: 'docs', language: 'PT-PT', tasksFile: 'tasks.md' });
  put(path.join(PROJECT, 'docs', 'tasks.md'), '# tasks\n');
  put(path.join(STATE, SLUG, 'state.json'), { task: HOSTILE, phase: 'build', status: 'running', buildCursor: HOSTILE, note: HOSTILE, startedAt: at(0), ...state });
  put(EVENTS, jsonl([
    startLine('b1', agentType, 'build', 'T1', 10),
    { v: 1, kind: 'start', agent: 'h1', type: HOSTILE, phase: HOSTILE, task: HOSTILE, at: at(11) }, // dropped
    `{"v":1,"kind":"start","agent":"h2","type":"x","phase":"build","task":"","at":"${at(12)}","__proto__":{"polluted":1}}`,
    `${HOSTILE}`,
    startLine('r1', 'task-flow:code-reviewer', 'review', '', 40),
    { v: 1, kind: 'result', agent: 'r1', outcome: 'ok', tests: null, critical: 0, required: 0, round: 2, phase: null, task: null },
  ]));
  put(path.join(SUBAGENTS, 'agent-b1.jsonl'), jsonl([user(at(10), HOSTILE), asst(at(10, 30), 'q1', usage(100, 50)), HOSTILE]));
  put(path.join(SUBAGENTS, 'agent-r1.jsonl'), jsonl([user(at(40)), asst(at(40, 20), 'q2', usage(10, 5))]));
  put(MAIN, jsonl([
    { type: 'user', isSidechain: false, cwd: PROJECT, timestamp: at(5), message: { role: 'user', content: HOSTILE } },
    { type: 'assistant', isSidechain: false, cwd: PROJECT, timestamp: at(6), requestId: 'o1', message: { model: HOSTILE, usage: usage(7, 3), content: [{ type: 'text', text: HOSTILE }] } },
  ]));
}

const env = { ...process.env, CLAUDE_PROJECT_DIR: PROJECT };
const cli = (args, extra = {}) => cp.spawnSync(process.execPath, [METRICS, ...args], { encoding: 'utf8', shell: false, timeout: 60000, env: { ...env, ...extra } });
const summary = (extra) => cli(['summary', '--slug', SLUG], extra);
const clean = (r) => MARKERS.every((m) => !`${r.stdout}${r.stderr}`.includes(m));
// every line of a block: a fixed phrase or a table row of closed cells
const CELL = /^(build|review|spec|plan|tests|harden|fase desconhecida|desconhecida|unknown|orquestrador|\*\*Total\*\*|—|\d+|— \([a-z ]+\)|\d+ s|\d+ min \d{2} s|\d+ h \d{2} min)$/;
function closedShape(text) {
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) {
      if (/[<>\[\]@#`!]/.test(line.replace(/^### /, ''))) return line;
      continue;
    }
    if (line === '| Fase | Loops | Tokens frescos | Duração |' || line === '| --- | ---: | ---: | ---: |') continue;
    const cells = line.slice(2, -2).split(' | ');
    if (cells.length !== 4 || !cells.every((c) => CELL.test(c))) return line;
  }
  return null;
}
const snapshot = () => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else { const s = fs.statSync(f); out.push(`${f}|${s.size}|${s.mtimeMs}|${fs.readFileSync(f).toString('base64')}`); }
    }
  };
  walk(TEST_HOME);
  return out.sort().join('\n');
};

// --- hostile content everywhere: only the closed shape comes out -------------------------------------
fixture();
{
  const before = snapshot();
  const r = summary();
  check('hostile inputs: exit 0, a block', r.status === 0 && r.stdout.startsWith('### Custo da run\n'), JSON.stringify(r));
  check('hostile inputs: no marker, mention, ref, link or slug in stdout/stderr', clean(r), r.stdout);
  check('hostile inputs: every line is a fixed phrase or a closed-cell row', closedShape(r.stdout) === null, closedShape(r.stdout));
  check('hostile inputs: HOME (stateDir included) byte-identical after', snapshot() === before);
  check('__proto__ in an event line does not pollute', ({}).polluted === undefined);
}

// agentType at the edge of its shape (80 chars of the allowed set) never reaches the block
fixture({ agentType: `a${':'.repeat(79)}` });
{
  const r = summary();
  check('agentType at the shape edge: block intact, type not printed', r.status === 0 && closedShape(r.stdout) === null && !r.stdout.includes('::::'), r.stdout);
}

// --- in-process write spy ----------------------------------------------------------------------------
fixture();
{
  const writes = [];
  const wrap = (name) => { const orig = fs[name]; fs[name] = function (...a) { writes.push(name); return orig.apply(this, a); }; return () => { fs[name] = orig; }; };
  const restores = ['writeFileSync', 'appendFileSync', 'writeSync', 'renameSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'copyFileSync', 'symlinkSync'].map(wrap);
  const origOpen = fs.openSync;
  fs.openSync = function (p, flags, ...rest) {
    const f = typeof flags === 'number' ? flags : String(flags || 'r');
    const writing = typeof f === 'number' ? (f & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND)) !== 0 : /[wa+]/.test(f);
    if (writing) writes.push(`openSync:${f}`);
    return origOpen.call(this, p, flags, ...rest);
  };
  const origOut = process.stdout.write;
  let printed = '';
  process.stdout.write = (s) => { printed += s; return true; };
  const prevCode = process.exitCode;
  try {
    process.env.CLAUDE_PROJECT_DIR = PROJECT;
    const { runCommand } = require(METRICS);
    runCommand(['summary', '--slug', SLUG], PROJECT);
  } finally {
    process.stdout.write = origOut;
    restores.forEach((r) => r());
    fs.openSync = origOpen;
    process.exitCode = prevCode;
  }
  check('in-process: a block printed', printed.startsWith('### Custo da run'), printed.slice(0, 80));
  check('in-process: no fs write or open-for-write', writes.length === 0, writes.join(','));
}

// --- arguments ---------------------------------------------------------------------------------------
fixture();
for (const [name, args] of [
  ['slug traversal', ['summary', '--slug', '../my-run']],
  ['slug with backslash', ['summary', '--slug', '..\\my-run']],
  ['slug absolute', ['summary', '--slug', PROJECT]],
  ['slug hostile text', ['summary', '--slug', HOSTILE]],
  ['slug empty', ['summary', '--slug', '']],
  ['slug flag without value', ['summary', '--slug']],
  ['--project-dir relative', ['summary', '--slug', SLUG, '--project-dir', '../x']],
]) {
  const r = cli(args, name.startsWith('--project-dir') ? { CLAUDE_PROJECT_DIR: '' } : {});
  const fixed = (r.status === 2 && /^usage: metrics\.js/.test(r.stderr) && r.stdout === '') || (r.status === 0 && /^metrics: [a-z-]+ summary\n$/.test(r.stdout));
  check(`${name}: usage (2) or a fixed code line, nothing echoed`, fixed && clean({ stdout: r.stdout, stderr: r.stderr.replace(/metrics\.js summary --slug <run>/g, '') }), JSON.stringify(r));
}
{
  const r = cli(['summary', '--slug', SLUG, '--project-dir', path.join(TEST_HOME, 'nowhere', '..', 'work', 'proj', '..', '..')], { CLAUDE_PROJECT_DIR: '' });
  check('--project-dir elsewhere: a fixed code line', r.status === 0 && /^metrics: [a-z-]+ summary\n$/.test(r.stdout), JSON.stringify(r));
}
{
  put(path.join(PROJECT, '.claude', 'task-flow.json'), '{ broken');
  const r = summary({ TASK_FLOW_METRICS: 'OFF' });
  check('TASK_FLOW_METRICS=off first: fixed line even with a broken config', r.status === 0 && r.stdout === 'metrics: disabled summary\n' && r.stderr === '', JSON.stringify(r));
  const r2 = summary();
  check('broken config: fixed code, exit 0', r2.status === 0 && r2.stdout === 'metrics: bad-config summary\n', JSON.stringify(r2));
}

// --- oversize sums never print exponent/Infinity/NaN -------------------------------------------------
fixture();
{
  fs.rmSync(EVENTS);
  fs.rmSync(MAIN);
  const big = [];
  for (let i = 0; i < 20000; i += 1) big.push(JSON.stringify(row(`z${i}`, 20, 1e12, { durationS: 1e12 })));
  put(LOOPS, `${big.join('\n')}\n`);
  const r = summary();
  check('oversize sums: exit 0, no exponent/Infinity/NaN', r.status === 0 && !/e\+|Infinity|NaN/.test(r.stdout), r.stdout.slice(0, 400));
  check('oversize sums: still closed shape', closedShape(r.stdout) === null, closedShape(r.stdout));
}

// --- other run and before startedAt excluded ---------------------------------------------------------
fixture();
{
  fs.rmSync(EVENTS);
  fs.rmSync(MAIN);
  put(LOOPS, jsonl([row('a1', 10, 5), row('o1', -10, 7000), row('x1', 10, 9000, { run: 'other-run' })]));
  const r = summary();
  check('other run / before startedAt: out of the sums', r.status === 0 && r.stdout.includes('| build | 1 | 5 |') && !r.stdout.includes('7000') && !r.stdout.includes('9000'), r.stdout);
}

// --- link/junction, folder, oversize loops.jsonl -----------------------------------------------------
const CODE = /^metrics: [a-z-]+ summary\n$/;
fixture();
{
  fs.mkdirSync(LOOPS);
  const r = summary();
  check('loops.jsonl a folder: fixed code', r.status === 0 && CODE.test(r.stdout) && clean(r), JSON.stringify(r));
}
fixture();
{
  const target = path.join(TEST_HOME, 'outside.jsonl');
  put(target, jsonl([row('l1', 10, 4242)]));
  let linked = false;
  try { fs.symlinkSync(target, LOOPS, 'file'); linked = true; } catch { /* no symlink right on Windows */ }
  if (linked) {
    const r = summary();
    check('loops.jsonl a symlink: fixed code, nothing followed', r.status === 0 && CODE.test(r.stdout) && !r.stdout.includes('4242'), JSON.stringify(r));
  } else console.log('skip  loops.jsonl symlink (no permission)');
}
fixture();
{
  const outside = path.join(TEST_HOME, 'outside-run');
  put(path.join(outside, 'state.json'), { task: 'x', phase: 'build', status: 'running', startedAt: at(0) });
  put(path.join(outside, 'loop-events.jsonl'), jsonl([startLine('b1', 'general-purpose', 'build', 'T1', 10)]));
  fs.rmSync(path.join(STATE, SLUG), { recursive: true, force: true });
  let linked = false;
  try { fs.symlinkSync(outside, path.join(STATE, SLUG), 'junction'); linked = true; } catch { /* ignore */ }
  if (linked) {
    const r = summary();
    check('run folder a junction: fixed code', r.status === 0 && CODE.test(r.stdout), JSON.stringify(r));
  } else console.log('skip  run folder junction');
}
fixture();
{
  fs.rmSync(EVENTS);
  fs.rmSync(MAIN);
  const fd = fs.openSync(LOOPS, 'w');
  fs.writeSync(fd, `${JSON.stringify(row('g1', 10, 5))}\n`);
  fs.ftruncateSync(fd, 80 * 1024 * 1024);
  fs.closeSync(fd);
  const t0 = Date.now();
  const r = summary();
  check('giant loops.jsonl: exit 0, fixed code or closed block, bounded', r.status === 0 && (CODE.test(r.stdout) || closedShape(r.stdout) === null) && Date.now() - t0 < 30000, JSON.stringify(r).slice(0, 300));
}

try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
