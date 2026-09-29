#!/usr/bin/env node
// Tests for readTokens in plugin/scripts/metrics.js (plan T4, spec R6).
//
// The transcript format is NOT a public contract, so the reader must fail open:
// every odd input here has to end as `tokens: null` plus a closed reason code (or
// as a partial read that ignores the odd part), never as a throw and never with
// any transcript text in the result. Fixtures are synthetic and written under a
// throwaway HOME: the real ~/.claude/projects is never read by a test.
//
// Run: node tests/metrics.tokens.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-tokens-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.LOCALAPPDATA = TEST_HOME;
process.env.XDG_STATE_HOME = TEST_HOME;

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` - ${detail}` : ''}`);
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

const metrics = require('../plugin/scripts/metrics.js');
const { readTokens, validateRow } = metrics;

const PROJECT = path.join(TEST_HOME, 'work', 'my-proj');
const SLUG = PROJECT.replace(/[^A-Za-z0-9]/g, '-');
const BASE = path.join(TEST_HOME, '.claude', 'projects', SLUG);
const WINDOW = { startedAt: '2026-09-29T10:00:00Z', closedAt: '2026-09-29T12:00:00Z' };
const OPTS = { projectDir: PROJECT, window: WINDOW, cwd: PROJECT };
const T = (m) => `2026-09-29T11:${String(m).padStart(2, '0')}:00.000Z`;

let counter = 0;
function transcript(lines, { session = 's1', name } = {}) {
  counter += 1;
  const dir = path.join(BASE, session, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name || `agent-a${counter}`}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}
function assistant(requestId, usage, extra = {}) {
  return {
    type: 'assistant', timestamp: T(5), cwd: PROJECT, requestId,
    message: { model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: 'SECRET-TEXT' }] },
    ...extra,
  };
}
const u = (input, output, cc = 0, cr = 0) => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: cc, cache_read_input_tokens: cr });
const reset = () => fs.rmSync(BASE, { recursive: true, force: true });
const quiet = (fn) => { try { fn(); return true; } catch { return false; } };

// --- M-R6.1 dedupe by requestId -----------------------------------------------
reset();
transcript([assistant('req_1', u(10, 16, 100, 1000)), assistant('req_1', u(10, 100, 100, 1000)), assistant('req_1', u(10, 239, 100, 1000))]);
let r = readTokens(OPTS);
check('M-R6.1 a repeated request counts once with the largest output', r.tokens && r.tokens.output === 239 && r.tokens.input === 10 && r.tokens.cacheCreate === 100 && r.tokens.cacheRead === 1000 && r.agent.requests === 1, JSON.stringify(r));
check('M-R6.1 cacheHitRate = cacheRead / (input + cacheCreate + cacheRead)', r.tokens && r.tokens.cacheHitRate === Math.round((1000 / 1110) * 10000) / 10000);
check('M-R6.1 contextPeak is the biggest input+cacheCreate+cacheRead of one request', r.agent && r.agent.contextPeak === 1110);

// --- M-R6.2 two files, two models -----------------------------------------------
reset();
transcript([assistant('a', u(1, 2, 3, 4)), assistant('b', u(10, 20, 30, 40))]);
transcript([{ ...assistant('c', u(100, 200, 300, 400)), message: { model: 'claude-haiku-4-5', usage: u(100, 200, 300, 400), content: [] } }], { session: 's2' });
r = readTokens(OPTS);
check('M-R6.2 totals across files and models match the hand sum', r.tokens && r.tokens.input === 111 && r.tokens.output === 222 && r.tokens.cacheCreate === 333 && r.tokens.cacheRead === 444 && r.agent.requests === 3, JSON.stringify(r.tokens));
check('M-R6.2 models ordered by requests, primaryModel first', JSON.stringify(r.models) === '["claude-opus-5-5","claude-haiku-4-5"]' && r.primaryModel === 'claude-opus-5-5');
check('M-R6.2 the result fits a valid row', (() => {
  const row = { v: 1, run: 'x', created: '2026-09-29', closedAt: '2026-09-29T12:00:00Z', outcome: 'done', mode: 'attended', primaryModel: r.primaryModel, models: r.models, sizePoints: null, tasks: null, tests: null, review: null, hardenFindings: null, questions: null, code: null, tokens: r.tokens, tokensNull: null, agent: r.agent };
  return validateRow(row).ok;
})());

// --- tools, synthetic, no requestId, cacheHitRate null ---------------------------
reset();
transcript([
  { type: 'assistant', timestamp: T(1), cwd: PROJECT, requestId: 'r1', message: { model: 'claude-opus-5-5', usage: u(5, 5), content: [{ type: 'tool_use', id: 'tu1', name: 'SECRET-TOOL' }, { type: 'tool_use', id: 'tu2', name: 'x' }] } },
  { type: 'assistant', timestamp: T(1), cwd: PROJECT, requestId: 'r1', message: { model: 'claude-opus-5-5', usage: u(5, 9), content: [{ type: 'tool_use', id: 'tu1', name: 'SECRET-TOOL' }] } },
  { type: 'user', timestamp: T(2), cwd: PROJECT, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'SECRET' }, { type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }] } },
  { type: 'assistant', timestamp: T(3), cwd: PROJECT, requestId: 'syn', message: { model: '<synthetic>', usage: u(999, 999) } },
  { type: 'assistant', timestamp: T(3), cwd: PROJECT, message: { model: 'claude-opus-5-5', usage: u(999, 999) } },
]);
r = readTokens(OPTS);
check('tool_use counted distinct by id, is_error results counted', r.agent && r.agent.toolCalls === 2 && r.agent.toolErrors === 1, JSON.stringify(r.agent));
check('<synthetic> and requestId-less lines ignored', r.tokens && r.tokens.input === 5 && r.tokens.output === 9 && r.agent.requests === 1, JSON.stringify(r.tokens));
reset();
transcript([assistant('z', u(0, 7, 0, 0))]);
r = readTokens(OPTS);
check('cacheHitRate is null with a zero denominator', r.tokens && r.tokens.cacheHitRate === null);

// --- byPhase ------------------------------------------------------------------------
reset();
transcript([
  { ...assistant('p1', u(1, 1, 1, 0)), timestamp: T(1) },
  { ...assistant('p2', u(2, 2, 2, 0)), timestamp: T(20) },
  { ...assistant('p3', u(3, 3, 3, 0)), timestamp: T(40) },
]);
r = readTokens({ ...OPTS, phaseLog: [{ phase: 'idea', at: T(10) }, { phase: 'spec', at: T(30) }] });
check('byPhase: a request belongs to the phase after the last completed one', r.tokens && JSON.stringify(r.tokens.byPhase) === JSON.stringify({ idea: { in: 2, out: 1 }, spec: { in: 4, out: 2 }, plan: { in: 6, out: 3 } }), JSON.stringify(r.tokens && r.tokens.byPhase));
r = readTokens(OPTS);
check('byPhase without a phaseLog is only `other`', r.tokens && Object.keys(r.tokens.byPhase).join() === 'other' && r.tokens.byPhase.other.out === 6);
r = readTokens({ ...OPTS, phaseLog: [{ phase: 'review', at: T(0) }] });
check('byPhase after the last phase = other', r.tokens && Object.keys(r.tokens.byPhase).join() === 'other');

// --- M-R6.3 fail-open cases -----------------------------------------------------------
reset();
check('M-R6.3 missing folder -> no-transcripts', readTokens(OPTS).reason === 'no-transcripts' && readTokens(OPTS).tokens === null);
fs.mkdirSync(BASE, { recursive: true });
check('M-R6.3 empty folder -> no-transcripts', readTokens(OPTS).reason === 'no-transcripts');
transcript(['garbage', '{"a":', '', '[1,2]']);
r = readTokens(OPTS);
check('M-R6.3 a file of garbage -> unreadable-format', r.tokens === null && r.reason === 'unreadable-format', r.reason);
reset();
transcript([assistant('a', u(1, 1)), '{"type":"assistant","timest', assistant('b', u(2, 2))]);
r = readTokens(OPTS);
check('M-R6.3 broken JSON in the middle is skipped, the rest is read', r.tokens && r.tokens.input === 3 && r.skipped.lines >= 1, JSON.stringify(r));
reset();
const big = JSON.stringify({ ...assistant('big', u(50, 50)), pad: 'x'.repeat(2 * 1024 * 1024) });
transcript([assistant('a', u(1, 1)), big, assistant('b', u(2, 2))]);
r = readTokens(OPTS);
check('M-R6.3 a 2 MiB line is skipped and counted, the rest is read', r.tokens && r.tokens.input === 3 && r.skipped.lines >= 1 && r.agent.requests === 2, JSON.stringify(r));
reset();
transcript([assistant('a', { input_tokens: '5', output_tokens: 1 }), assistant('b', u(-1, 1)), assistant('c', { input_tokens: {}, output_tokens: 1 }), assistant('d', u(1e15, 1))]);
r = readTokens(OPTS);
check('M-R6.3 usage with strings/negatives/objects/huge numbers -> unreadable-format', r.tokens === null && r.reason === 'unreadable-format', r.reason);
reset();
transcript([{ ...assistant('a', u(1, 1)), timestamp: '2026-09-28T11:00:00.000Z' }, { ...assistant('b', u(1, 1)), timestamp: 'nope' }]);
r = readTokens(OPTS);
check('M-R6.3 lines outside the window -> no-transcripts (nothing belongs to this run)', r.tokens === null && r.reason === 'no-transcripts', r.reason);
reset();
transcript([{ ...assistant('a', u(1, 1)), cwd: path.join(TEST_HOME, 'other') }]);
check('M-R6.3 cwd of another project -> no-transcripts', readTokens(OPTS).reason === 'no-transcripts');
reset();
transcript([assistant('a', u(1, 1)), { ...assistant('b', u(2, 2)), cwd: PROJECT.toUpperCase() }]);
r = readTokens(OPTS);
check('cwd compare ignores case on Windows only', process.platform === 'win32' ? r.agent.requests === 2 : r.agent.requests === 1, JSON.stringify(r.agent));
check('M-R6.3 no startedAt -> no-window', readTokens({ ...OPTS, window: { closedAt: WINDOW.closedAt } }).reason === 'no-window' && readTokens({ ...OPTS, window: null }).reason === 'no-window' && readTokens({ ...OPTS, window: { startedAt: 'x', closedAt: WINDOW.closedAt } }).reason === 'no-window');
check('M-R6.3 an overlapping window of another run -> overlap', readTokens({ ...OPTS, otherWindows: [{ startedAt: '2026-09-29T11:30:00Z', closedAt: '2026-09-29T13:00:00Z' }] }).reason === 'overlap');
check('a disjoint other window does not matter', readTokens({ ...OPTS, otherWindows: [{ startedAt: '2026-09-28T00:00:00Z', closedAt: '2026-09-29T09:00:00Z' }, 'junk', null] }).tokens !== null);

// --- links -------------------------------------------------------------------------------
reset();
const outside = path.join(TEST_HOME, 'outside');
fs.mkdirSync(path.join(outside, 'subagents'), { recursive: true });
fs.writeFileSync(path.join(outside, 'subagents', 'agent-x1.jsonl'), JSON.stringify(assistant('o', u(9, 9))) + '\n');
fs.mkdirSync(BASE, { recursive: true });
let linked = true;
try { fs.symlinkSync(outside, path.join(BASE, 'sJ'), 'junction'); } catch { linked = false; }
if (linked) {
  r = readTokens(OPTS);
  check('M-R6.3 a session folder that is a junction is not followed', r.tokens === null, JSON.stringify(r));
}
reset();
const subOut = path.join(TEST_HOME, 'outside-sub');
fs.mkdirSync(subOut, { recursive: true });
fs.writeFileSync(path.join(subOut, 'agent-x2.jsonl'), JSON.stringify(assistant('o', u(9, 9))) + '\n');
fs.mkdirSync(path.join(BASE, 's3'), { recursive: true });
linked = true;
try { fs.symlinkSync(subOut, path.join(BASE, 's3', 'subagents'), 'junction'); } catch { linked = false; }
if (linked) check('M-R6.3 a subagents folder that is a junction is not followed', readTokens(OPTS).tokens === null);
reset();
const target = path.join(outside, 'subagents', 'agent-x1.jsonl');
fs.mkdirSync(path.join(BASE, 's4', 'subagents'), { recursive: true });
linked = true;
try { fs.symlinkSync(target, path.join(BASE, 's4', 'subagents', 'agent-l1.jsonl'), 'file'); } catch { linked = false; }
if (linked) check('M-R6.3 a .jsonl symlink is not followed', readTokens(OPTS).tokens === null);
else console.log('  --  file symlink not permitted here; skipped');
reset();
fs.mkdirSync(path.dirname(BASE), { recursive: true });
linked = true;
try { fs.symlinkSync(outside, BASE, 'junction'); } catch { linked = false; }
if (linked) check('M-R6.3 a project folder that is a junction is not followed', readTokens(OPTS).tokens === null);
fs.rmSync(BASE, { recursive: true, force: true });

// --- names, sizes, limits --------------------------------------------------------------
reset();
transcript([assistant('a', u(1, 1))], { name: 'agent-a.b' });
transcript([assistant('a', u(1, 1))], { name: 'notagent' });
transcript([assistant('a', u(1, 1))], { name: 'agent-' });
check('only agent-<alnum>.jsonl names are read', readTokens(OPTS).tokens === null);
reset();
const bigFile = transcript([assistant('a', u(1, 1))], { name: 'agent-big' });
fs.truncateSync(bigFile, 100 * 1024 * 1024);
const before = process.memoryUsage().rss;
r = readTokens(OPTS);
check('M-R6.5 a 100 MB file is rejected by size, without being loaded', r.tokens === null && r.skipped.files === 1 && process.memoryUsage().rss - before < 50 * 1024 * 1024, JSON.stringify(r));
reset();
for (let i = 0; i < 3; i += 1) transcript([assistant(`r${i}`, u(1, 1))], { name: `agent-n${i}` });
check('more files than the limit -> timeout', readTokens({ ...OPTS, limits: { maxFiles: 2 } }).reason === 'timeout');
check('more bytes than the total limit -> timeout', readTokens({ ...OPTS, limits: { maxTotalBytes: 10 } }).reason === 'timeout');
check('an exhausted time budget -> timeout', readTokens({ ...OPTS, budgetMs: -1 }).reason === 'timeout');
reset();
const old = transcript([assistant('a', u(1, 1))], { name: 'agent-old' });
fs.utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'));
check('a file last modified before the window is not even opened', readTokens(OPTS).tokens === null);

// --- M-R6.4 nothing from the transcripts comes out ------------------------------------------
reset();
transcript([assistant('a', u(1, 1)), { type: 'user', timestamp: T(2), cwd: PROJECT, message: { content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'SECRET-TEXT' }] } }, '{"broken": SECRET-TEXT']);
fs.writeFileSync(path.join(BASE, 's1', 'subagents', 'agent-a1.meta.json'), '{"description":"SECRET-TEXT"}');
r = readTokens(OPTS);
check('M-R6.4 no transcript text or path in the result', r.tokens !== null && !JSON.stringify(r).includes('SECRET') && !JSON.stringify(r).includes('taskflow-tokens'), JSON.stringify(r));
reset();
transcript([{ ...assistant('m', u(1, 1)), message: { model: 'bad model <script>', usage: u(1, 1) } }]);
r = readTokens(OPTS);
check('a model name that breaks the closed shape never comes out', r.tokens !== null && !JSON.stringify(r).includes('script') && r.models.length === 0 && r.primaryModel === null);

// --- hostile arguments -----------------------------------------------------------------------
reset();
const hostile = [undefined, null, 5, 'x', [], { projectDir: 5 }, { projectDir: '' }, { projectDir: PROJECT, window: 5 }, { projectDir: '..\\..\\x', window: WINDOW }, { projectDir: PROJECT, window: WINDOW, otherWindows: 'x' }, { projectDir: PROJECT, window: WINDOW, phaseLog: 'x' }, { projectDir: PROJECT, window: WINDOW, limits: 'x', budgetMs: 'x' }];
check('hostile arguments never throw and give a closed reason', hostile.every((h) => quiet(() => readTokens(h)) && readTokens(h).tokens === null && typeof readTokens(h).reason === 'string'));

fs.rmSync(TEST_HOME, { recursive: true, force: true });
const total = passed + failures.length;
console.log(`\n${passed}/${total} passed`);
if (failures.length) {
  console.log(`${failures.length} failing:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
