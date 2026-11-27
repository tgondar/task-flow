#!/usr/bin/env node
// Functional tests for the main-transcript reader and the `time` CLI in
// plugin/scripts/metrics.js (plan T8, spec RF-035..RF-037): readMainTranscripts
// reads the orchestrator's <session>.jsonl files at the top of
// ~/.claude/projects/<slug>, and `metrics.js time --slug <run>` prints the
// `## Registo de tempo` row of the run, with the session-time.ps1 rule: a session
// runs from its first to its last event; Claude hours are, for each real user
// message, the time up to the last event before the next one; sessions add up.
// What these hold: the hours match a hand count of that rule, a parallel loop
// (a subagent transcript) never adds to them, records outside the window or from
// another cwd do not count, and without data the CLI prints one fixed sentence,
// exit 0, writing nothing. The hostile cases are the security auditor's.
// Everything is synthetic under a throwaway HOME.
//
// Run: node tests/metrics.time.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-time-'));
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
const { readMainTranscripts } = metrics;
check('readMainTranscripts is exported', typeof readMainTranscripts === 'function');
if (typeof readMainTranscripts !== 'function') { console.log('\nnothing more to run'); process.exit(1); }

const PROJECT = path.join(TEST_HOME, 'work', 'proj');
const OTHER = path.join(TEST_HOME, 'work', 'other');
const STATE = path.join(PROJECT, '.claude', 'task-flow');
const SLUG = 'my-run';
const BASE = path.join(TEST_HOME, '.claude', 'projects', PROJECT.replace(/[^A-Za-z0-9]/g, '-'));
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); };
const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

// the run started six hours ago; t0 is ten minutes later
const S = Date.now() - 6 * 60 * MIN;
const T0 = S + 10 * MIN;
const at = (minutes) => iso(T0 + minutes * MIN);

function setup(state = {}, config = { docsDir: 'docs', language: 'PT-PT', tasksFile: 'tasks.md' }) {
  fs.rmSync(PROJECT, { recursive: true, force: true });
  put(path.join(PROJECT, '.claude', 'task-flow.json'), config);
  put(path.join(PROJECT, 'docs', 'tasks.md'), '# tasks\n');
  put(path.join(STATE, SLUG, 'state.json'), { task: SLUG, phase: 'build', status: 'running', startedAt: iso(S), ...state });
}

const user = (minutes, extra = {}) => ({ type: 'user', isSidechain: false, cwd: PROJECT, timestamp: at(minutes), message: { role: 'user', content: 'hello' }, ...extra });
const assistant = (minutes, requestId, extra = {}, usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 100 }) => ({
  type: 'assistant', isSidechain: false, cwd: PROJECT, timestamp: at(minutes), requestId, effort: 'high',
  message: { role: 'assistant', model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: 'ok' }] }, ...extra,
});
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** Session A: 90 min; Claude 7 + 10 + 0 = 17 min. Session B: 30 min, Claude 30 min. */
function transcripts() {
  fs.rmSync(path.join(TEST_HOME, '.claude'), { recursive: true, force: true });
  const sideModel = { model: 'zz-side', usage: { input_tokens: 1000, output_tokens: 1000 } };
  put(path.join(BASE, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl'), jsonl([
    user(-20), // before the run's start: out of the window
    { type: 'custom-title', title: 'no timestamp' },
    user(0), // real
    assistant(1, 'req1', {}, { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 100 }),
    assistant(1, 'req1'), // same request, a later content block: output grows to 5
    user(2, { toolUseResult: { stdout: 'x' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } }),
    assistant(5, 'req2'),
    user(6, { isMeta: true }),
    // four sidechain requests (a subagent written into the main transcript): events, never the orchestrator's
    ...['side1', 'side2', 'side3', 'side4'].map((id) => assistant(7, id, { isSidechain: true, effort: 'max', message: { role: 'assistant', ...sideModel } })),
    user(30), // real
    assistant(40, 'req3'),
    user(90), // real, the last event: no work after it
    user(200, { cwd: OTHER }), // another cwd: does not stretch the session
  ]));
  put(path.join(BASE, 'bbbbbbbb-0000-4000-8000-000000000002.jsonl'), jsonl([
    user(120),
    assistant(150, 'req4', { effort: 'medium', message: { role: 'assistant', model: 'claude-sonnet-x', usage: { input_tokens: 1, output_tokens: 1 } } }),
  ]));
  // a session run entirely in another project folder (cwd): nothing of it counts
  put(path.join(BASE, 'cccccccc-0000-4000-8000-000000000003.jsonl'), jsonl([user(10, { cwd: OTHER }), assistant(300, 'reqx', { cwd: OTHER })]));
  // a loop in parallel, five hours long: its own transcript never adds to the run's hours
  put(path.join(BASE, 'aaaaaaaa-0000-4000-8000-000000000001', 'subagents', 'agent-loop1.jsonl'), jsonl([
    { ...user(0), isSidechain: true },
    { ...assistant(300, 'loopreq'), isSidechain: true },
  ]));
}

const env = { ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME, LOCALAPPDATA: TEST_HOME, XDG_STATE_HOME: TEST_HOME, CLAUDE_PROJECT_DIR: PROJECT };
delete env.TASK_FLOW_METRICS;
const cli = (args, extra = {}) => cp.spawnSync(process.execPath, [METRICS, ...args], { encoding: 'utf8', shell: false, timeout: 60000, env: { ...env, ...extra } });

/** Every file under a folder with its size and mtime: "nothing written" is this unchanged. */
function tree(dir) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const s = fs.statSync(p); out.push(`${p}:${s.size}:${s.mtimeMs}`); }
    }
  };
  walk(dir);
  return out.sort().join('\n');
}

const localDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// --- 1. the reader -----------------------------------------------------------------------------
{
  setup();
  transcripts();
  const r = readMainTranscripts({ projectDir: PROJECT, window: { startedAt: iso(S), closedAt: iso(Date.now()) } });
  check('reader: no reason with data', r.reason === null, JSON.stringify(r.reason));
  check('reader: two sessions with events in the window and cwd', Array.isArray(r.sessions) && r.sessions.length === 2, JSON.stringify(r.sessions && r.sessions.map((s) => s.events.length)));
  const counts = (r.sessions || []).map((s) => s.events.length).sort((a, b) => a - b);
  // A: user0, req1 x2, tool result, req2, meta, 4 sidechain, user30, req3, user90 = 13; B: 2
  check('reader: only events in the window and cwd (13 and 2)', counts.join() === '2,13', counts.join());
  const real = (r.sessions || []).map((s) => s.events.filter((e) => e.real).length).sort((a, b) => a - b);
  check('reader: real user messages by fields (3 in A, 1 in B)', real.join() === '1,3', real.join());
  check('reader: tokens deduplicated by requestId, sidechain left out', JSON.stringify(r.tokens) === JSON.stringify({ input: 31, cacheCreate: 6, cacheRead: 300, output: 16 }), JSON.stringify(r.tokens));
  check('reader: most frequent model of the orchestrator', r.model === 'claude-opus-5-5', r.model);
  check('reader: most frequent effort of the orchestrator', r.effort === 'high', r.effort);

  const none = readMainTranscripts({ projectDir: OTHER, window: { startedAt: iso(S), closedAt: iso(Date.now()) } });
  check('reader: a project without a transcript folder: no-transcripts', none.reason === 'no-transcripts', JSON.stringify(none));
  const bad = readMainTranscripts({ projectDir: PROJECT, window: { startedAt: 'yesterday', closedAt: iso(Date.now()) } });
  check('reader: a window out of shape: no-window', bad.reason === 'no-window', JSON.stringify(bad));
  const empty = readMainTranscripts({ projectDir: PROJECT, window: { startedAt: iso(S - 100 * 60 * MIN), closedAt: iso(S - 90 * 60 * MIN) } });
  check('reader: no event in the window: no-transcripts', empty.reason === 'no-transcripts', JSON.stringify(empty));
}

// --- 2. the time CLI: the hours of the session-time.ps1 rule -----------------------------------
{
  setup();
  transcripts();
  const before = tree(TEST_HOME);
  const r = cli(['time', '--slug', SLUG]);
  // A: 90 min, Claude 17 min; B: 30 min, Claude 30 min -> 2 h and 47 min = 0.78 h
  const want = `| ${localDate(T0)} | run /task-flow (spec → PR) | 2 | 0.78 | high | claude-opus-5-5 |\n`;
  check('time: open run: exit 0, the row by the ps1 rule', r.status === 0 && r.stdout === want && r.stderr === '', JSON.stringify(r));
  check('time: never the sum of loop durations (the 5 h loop is not in it)', !/\| [3-9][.0-9]* \|/.test(r.stdout), r.stdout);
  check('time: nothing written', tree(TEST_HOME) === before);

  setup({ phase: 'done', status: 'done', phaseChangedAt: at(130) });
  const done = cli(['time', '--slug', SLUG]);
  // window ends at 130 min: B keeps only its user message (0 h); A unchanged
  const wantDone = `| ${localDate(T0)} | run /task-flow (spec → PR) | 1.5 | 0.28 | high | claude-opus-5-5 |\n`;
  check('time: done run: the window ends at phaseChangedAt', done.status === 0 && done.stdout === wantDone, JSON.stringify(done));

  setup({}, { docsDir: 'docs', language: 'en', tasksFile: 'tasks.md' });
  const en = cli(['time', '--slug', SLUG]);
  check('time: English project: the English phrase', en.status === 0 && en.stdout === `| ${localDate(T0)} | /task-flow run (spec → PR) | 2 | 0.78 | high | claude-opus-5-5 |\n`, JSON.stringify(en));

  const viaFlag = cli(['time', '--slug', SLUG, '--project-dir', PROJECT], { CLAUDE_PROJECT_DIR: '' });
  check('time: --project-dir accepted', viaFlag.status === 0 && viaFlag.stdout.startsWith('| '), JSON.stringify(viaFlag));
}

// --- 3. without data: one fixed sentence, exit 0, nothing written ------------------------------
{
  setup();
  fs.rmSync(path.join(TEST_HOME, '.claude'), { recursive: true, force: true });
  const before = tree(TEST_HOME);
  const r = cli(['time', '--slug', SLUG]);
  check('time: no transcripts: fixed sentence, exit 0', r.status === 0 && r.stdout === 'metrics: no-transcripts time\n' && r.stderr === '', JSON.stringify(r));
  check('time: no transcripts: nothing written', tree(TEST_HOME) === before);

  transcripts();
  setup({ startedAt: undefined });
  const noStart = cli(['time', '--slug', SLUG]);
  check('time: no startedAt: no-window', noStart.status === 0 && noStart.stdout === 'metrics: no-window time\n', JSON.stringify(noStart));
  setup({ phase: 'done', phaseChangedAt: 'later' });
  const noEnd = cli(['time', '--slug', SLUG]);
  check('time: done without a phaseChangedAt: no-window', noEnd.status === 0 && noEnd.stdout === 'metrics: no-window time\n', JSON.stringify(noEnd));
  setup();
  const noRun = cli(['time', '--slug', 'no-such-run']);
  check('time: a run without state.json: bad-state', noRun.status === 0 && noRun.stdout === 'metrics: bad-state time\n' && !fs.existsSync(path.join(STATE, 'no-such-run')), JSON.stringify(noRun));
  const off = cli(['time', '--slug', SLUG], { TASK_FLOW_METRICS: 'off' });
  check('time: TASK_FLOW_METRICS=off: disabled, exit 0', off.status === 0 && off.stdout === 'metrics: disabled time\n', JSON.stringify(off));
  fs.rmSync(path.join(PROJECT, '.claude', 'task-flow.json'));
  const noConfig = cli(['time', '--slug', SLUG]);
  check('time: no configuration: bad-config, exit 0', noConfig.status === 0 && noConfig.stdout === 'metrics: bad-config time\n', JSON.stringify(noConfig));
}

// --- 4. arguments: all or nothing, the fixed usage, exit 2 -------------------------------------
{
  setup();
  for (const [name, args] of [
    ['missing --slug', ['time']],
    ['--slug without a value', ['time', '--slug']],
    ['an unknown flag', ['time', '--slug', SLUG, '--agent', 'x']],
    ['--slug twice', ['time', '--slug', SLUG, '--slug', SLUG]],
    ['a slug out of shape', ['time', '--slug', '../x']],
  ]) {
    const r = cli(args);
    check(`time: ${name}: exit 2 with the usage`, r.status === 2 && /^usage: metrics\.js close/.test(r.stderr) && r.stderr.includes('metrics.js time --slug') && r.stdout === '', JSON.stringify(r));
  }
}

fs.rmSync(TEST_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
