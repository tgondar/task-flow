#!/usr/bin/env node
// Tests for the task-flow Stop hook.
//
// The hook keeps a run going without the user re-typing the command. Its dangerous
// failure is not letting a turn end when it should: a Stop hook that always blocks
// locks the session in a loop, and nothing upstream is relied on to break it. So
// the loop protection - T21 and T22 - is the core of this file, not an extra.
//
// The other half is scope: the hook fires on EVERY turn in the repository,
// including conversations that have nothing to do with the pipeline. Every case
// that expects "allow" is guarding against the hook hijacking someone's chat.
//
// Run: node tests/stop.test.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STOP = path.join(__dirname, '..', 'plugin', 'hooks', 'stop.js');
const ALLOW = 0;
const BLOCK = 2;
const DEFAULT_STATE_DIR = '.claude/task-flow';

let passed = 0;
const failures = [];

/** A fresh session id per case, so one case's loop guard never leaks into another. */
let sessionCounter = 0;
const newSessionId = () => `test-session-${process.pid}-${Date.now()}-${sessionCounter++}`;

/**
 * Builds a project fixture holding one or more runs.
 * `runs` is a list of partial state.json objects; each becomes its own task dir.
 * `config` null builds a repository that never opted in, a string one whose
 * configuration is not valid JSON.
 */
function makeProject(
  runs = [{}],
  { withStateDir = true, rawState = null, stateDir = DEFAULT_STATE_DIR, config = stateDir === DEFAULT_STATE_DIR ? {} : { stateDir } } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-stop-'));
  if (config !== null) {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'task-flow.json'),
      typeof config === 'string' ? config : JSON.stringify(config)
    );
  }
  if (withStateDir) {
    runs.forEach((run, index) => {
      const task = run.task || `demo${index}`;
      const taskDir = path.join(root, ...stateDir.split('/'), task);
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(
        path.join(taskDir, 'state.json'),
        rawState !== null
          ? rawState
          : JSON.stringify({
              task,
              phase: 'build',
              status: 'running',
              approvedBy: 'user',
              buildCursor: 'T3',
              updated: '2026-09-08T10:00:00Z',
              ...run,
            })
      );
    });
  }
  return root;
}

/** The Stop payload shape: the common fields plus last_assistant_message. */
function payloadFor(root, { sessionId = newSessionId(), lastMessage = 'Spec written.' } = {}) {
  return JSON.stringify({
    session_id: sessionId,
    prompt_id: '77d66a23-6a6f-488b-bd67-e0d6cd7b89f1',
    transcript_path: path.join(os.tmpdir(), 'transcript.jsonl'),
    cwd: root.replace(/\//g, '\\'),
    permission_mode: 'acceptEdits',
    effort: { level: 'xhigh' },
    hook_event_name: 'Stop',
    last_assistant_message: lastMessage,
  });
}

function runStop(root, stdin, env = {}) {
  const result = spawnSync(process.execPath, [STOP], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, TASK_FLOW_GATE: '', CLAUDE_PROJECT_DIR: root.replace(/\\/g, '/'), ...env },
  });
  return { code: result.status, stderr: result.stderr || '', stdout: result.stdout || '' };
}

function check(name, expectedCode, actual, extraAssert) {
  const problems = [];
  if (actual.code !== expectedCode) {
    problems.push(
      `expected exit ${expectedCode} (${expectedCode === BLOCK ? 'keep going' : 'let it stop'}), got ${actual.code}`
    );
  }
  if (extraAssert) {
    const msg = extraAssert(actual);
    if (msg) problems.push(msg);
  }
  if (problems.length) {
    failures.push(`${name}: ${problems.join('; ')}`);
    console.log(`  FAIL  ${name} — ${problems.join('; ')}`);
  } else {
    passed++;
    console.log(`  ok    ${name}`);
  }
}

// --- T14: a live run is pushed forward ------------------------------------
{
  const root = makeProject([{ status: 'running', phase: 'build' }]);
  check(
    'T14 a running run refuses to end the turn',
    BLOCK,
    runStop(root, payloadFor(root)),
    (r) => (r.stderr.trim() ? null : 'stderr should say why it is being pushed')
  );
}

// --- T15: waiting on the user is a legitimate stop -------------------------
{
  const root = makeProject([{ status: 'blocked', phase: 'spec' }]);
  check('T15 a blocked run lets the turn end', ALLOW, runStop(root, payloadFor(root)));
}

// --- T16: red tests stop the run, and the hook must not fight that --------
{
  const root = makeProject([{ status: 'failed', phase: 'build' }]);
  check('T16 a failed run lets the turn end', ALLOW, runStop(root, payloadFor(root)));
}

// --- T17: nothing left to do ----------------------------------------------
{
  const root = makeProject([{ status: 'running', phase: 'done' }]);
  check('T17 a finished run lets the turn end', ALLOW, runStop(root, payloadFor(root)));
}

// --- T18: no run state here, so this is somebody's ordinary conversation ---
// Fail OPEN, unlike the gate. A Stop hook that fails closed locks the session.
{
  const root = makeProject([], { withStateDir: false });
  check('T18 no run state fails open', ALLOW, runStop(root, payloadFor(root)));
}

// --- T19: an unreadable payload must never lock the session ---------------
{
  const root = makeProject([{ status: 'running' }]);
  check('T19 unparseable payload fails open', ALLOW, runStop(root, 'this is not json'));
}

// --- T20: one escape hatch for both hooks ---------------------------------
{
  const root = makeProject([{ status: 'running' }]);
  check(
    'T20 TASK_FLOW_GATE=off disables the stop hook and announces it',
    ALLOW,
    runStop(root, payloadFor(root), { TASK_FLOW_GATE: 'off' }),
    (r) => (/off|disabled/i.test(r.stderr) ? null : 'stderr should say the hook is off')
  );
}

// --- T21: the loop protection ---------------------------------------------
// Pushing is only worth doing if it produces work, and work moves state.json.
// With the signature unchanged, it gives up after three pushes and lets the
// session go. Without this the hook is a trap, not a guardrail.
{
  const root = makeProject([{ status: 'running' }]);
  const sessionId = newSessionId();
  const p = () => payloadFor(root, { sessionId });
  check('T21a first push', BLOCK, runStop(root, p()));
  check('T21b second push', BLOCK, runStop(root, p()));
  check('T21c third push', BLOCK, runStop(root, p()));
  check(
    'T21d gives up after three pushes with no progress',
    ALLOW,
    runStop(root, p()),
    (r) => (/progress|giving up|no longer/i.test(r.stderr) ? null : 'stderr should explain it gave up')
  );
}

// --- T22: progress resets the budget --------------------------------------
{
  const root = makeProject([{ status: 'running', buildCursor: 'T3' }]);
  const sessionId = newSessionId();
  const statePath = path.join(root, '.claude', 'task-flow', 'demo0', 'state.json');

  runStop(root, payloadFor(root, { sessionId }));
  runStop(root, payloadFor(root, { sessionId }));
  runStop(root, payloadFor(root, { sessionId }));

  // The run advanced a slice: the signature changes, so the budget starts over.
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.buildCursor = 'T4';
  state.updated = '2026-09-08T11:00:00Z';
  fs.writeFileSync(statePath, JSON.stringify(state));

  check('T22 progress resets the push budget', BLOCK, runStop(root, payloadFor(root, { sessionId })));
}

// --- T23: one live run among several is enough ----------------------------
{
  const root = makeProject([
    { task: 'old', status: 'done', phase: 'done' },
    { task: 'current', status: 'running', phase: 'plan' },
  ]);
  check('T23 one live run among finished ones still pushes', BLOCK, runStop(root, payloadFor(root)));
}

// --- T24: corrupt state must not lock the session -------------------------
{
  const root = makeProject([{}], { rawState: '{ this is not json' });
  check('T24 unreadable state.json fails open', ALLOW, runStop(root, payloadFor(root)));
}

/** A project the renderer can actually draw: a full configuration, a docs folder,
 *  a task list and a plan. The other cases do not need one, because they only ever
 *  assert on the exit code. */
function makeRenderableProject(run = {}, { language = 'EN', tasksTime = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-stoprender-'));
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-stopdocs-'));
  const tasksFile = path.join(docs, 'tasks', 'index.md');
  fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
  fs.writeFileSync(tasksFile, '| # | Task | Status |\n');
  if (tasksTime) {
    const t = new Date(tasksTime);
    fs.utimesSync(tasksFile, t, t);
  }

  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude', 'task-flow.json'),
    JSON.stringify({ docsDir: docs, language, tasksFile: 'tasks/index.md' })
  );
  fs.mkdirSync(path.join(docs, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(docs, 'plans', '260908_demo.plan.md'), '## T1 · The first\n\n## T2 · The second\n');

  const taskDir = path.join(root, '.claude', 'task-flow', 'demo');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'state.json'),
    JSON.stringify({
      task: 'demo',
      phase: 'plan',
      status: 'running',
      created: '2026-09-08',
      buildCursor: 'T1',
      updated: '2026-09-08T10:00:00Z',
      artifacts: { plan: 'plans/260908_demo.plan.md' },
      ...run,
    })
  );
  return {
    root,
    docs,
    tasksFile,
    page: path.join(docs, 'runs', '260908_demo.md'),
    archived: path.join(docs, 'runs', 'finished', '260908_demo.md'),
  };
}

// --- T25: the page is redrawn for a run that STOPPED ----------------------
// A backstop that only fired for a "running" run would never redraw the run the
// user actually opens: the one parked on a question.
{
  const f = makeRenderableProject({ status: 'blocked' });
  check(
    'T25 a blocked run still lets the turn end, and its page is drawn',
    ALLOW,
    runStop(f.root, payloadFor(f.root)),
    () => (fs.existsSync(f.page) ? null : 'the run page was not rendered for a blocked run')
  );
}

// --- T26: and a finished one is filed away ---------------------------------
{
  const f = makeRenderableProject({ status: 'done', phase: 'done' });
  check(
    'T26 a finished run is filed away on the way out',
    ALLOW,
    runStop(f.root, payloadFor(f.root)),
    () => (fs.existsSync(f.archived) ? null : 'the finished run was not archived')
  );
}

// --- T26b: the page follows the configured language --------------------------
{
  const f = makeRenderableProject({ status: 'blocked' }, { language: 'PT-PT' });
  runStop(f.root, payloadFor(f.root));
  const body = fs.existsSync(f.page) ? fs.readFileSync(f.page, 'utf8') : '';
  check('T26b a PT-PT project gets its page in Portuguese', ALLOW, { code: ALLOW },
    () => (/parada — à espera de resposta/.test(body) ? null : 'the page is not in Portuguese'));
}

// --- T27: a repository that never opted in is left alone -------------------
// Installed as a plugin, this hook runs on every turn in every repository on the
// machine. A leftover state.json with status "running" in a project with no
// .claude/task-flow.json must not hijack that project's conversations.
{
  const root = makeProject([{ status: 'running' }], { config: null });
  check('T27 no .claude/task-flow.json: the turn ends untouched', ALLOW, runStop(root, payloadFor(root)));
}

// --- T28: stateDir comes from the configuration ------------------------------
{
  const root = makeProject([{ status: 'running' }], { stateDir: 'docs/pipeline' });
  check('T28 a live run under a custom stateDir is pushed', BLOCK, runStop(root, payloadFor(root)));
}

// --- T29: a stateDir outside the project is not followed -------------------
// Security: it would let one project's configuration read runs anywhere on disk
// and keep pushing a session on their behalf.
{
  const root = makeProject([], { withStateDir: false, config: { stateDir: '../elsewhere' } });
  const outside = path.join(path.dirname(root), 'elsewhere', 'demo');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'state.json'), JSON.stringify({ task: 'demo', phase: 'build', status: 'running' }));
  check('T29 a stateDir that climbs out of the project lets the turn end', ALLOW, runStop(root, payloadFor(root)));
  fs.rmSync(path.join(path.dirname(root), 'elsewhere'), { recursive: true, force: true });
}

// --- T30: an unreadable configuration fails open ----------------------------
{
  const root = makeProject([{ status: 'running' }], { config: '{ not json' });
  check('T30 unparseable task-flow.json lets the turn end', ALLOW, runStop(root, payloadFor(root)));
}

// --- T32-T37: the task list follows every phase change ------------------------
// Whoever owns the task list reads it, not the PR, and the rule to update it at
// every phase change is the one prose forgets. The hook checks one thing: that the
// task list was written after the run's last phase change. It reads only the mtime.
function withTaskList({ phaseChangedAt, tasksTime, status = 'blocked' }) {
  const run = { status, phase: 'spec' };
  if (phaseChangedAt) run.phaseChangedAt = phaseChangedAt;
  return makeRenderableProject(run, { tasksTime });
}

{
  const f = withTaskList({ phaseChangedAt: '2026-09-24T12:00:00Z', tasksTime: '2026-09-24T11:00:00Z' });
  check('T32 a task list older than the last phase change keeps the turn going', BLOCK, runStop(f.root, payloadFor(f.root)),
    (r) => (/tasks[\\/]index\.md/.test(r.stderr) ? null : 'stderr should name the task list'));
}
{
  const f = withTaskList({ phaseChangedAt: '2026-09-24T12:00:00Z', tasksTime: '2026-09-24T12:05:00Z' });
  check('T33 a task list written after the phase change lets it stop', ALLOW, runStop(f.root, payloadFor(f.root)));
}
{
  const f = withTaskList({ phaseChangedAt: null, tasksTime: '2020-01-01T00:00:00Z' });
  check('T34 a run without phaseChangedAt is not checked', ALLOW, runStop(f.root, payloadFor(f.root)));
}
{
  const f = withTaskList({ phaseChangedAt: '2026-09-24T12:00:00Z', tasksTime: '2026-09-24T11:00:00Z' });
  const sessionId = newSessionId();
  runStop(f.root, payloadFor(f.root, { sessionId }));
  runStop(f.root, payloadFor(f.root, { sessionId }));
  check('T35 it gives up after two pushes on the same phase change', ALLOW, runStop(f.root, payloadFor(f.root, { sessionId })),
    (r) => (/task list is still older/.test(r.stderr) ? null : 'stderr should say the task list is still behind'));
}
{
  const f = withTaskList({ phaseChangedAt: '2026-09-24T12:00:00Z', tasksTime: '2026-09-24T11:00:00Z' });
  fs.rmSync(f.tasksFile);
  check('T36 a missing task list is not the hook\'s to chase', ALLOW, runStop(f.root, payloadFor(f.root)));
}
{
  // Security: a tasksFile that climbs out of docsDir is repository data trying to
  // point the hook somewhere else; config.js refuses it, and the turn ends.
  const f = withTaskList({ phaseChangedAt: '2026-09-24T12:00:00Z', tasksTime: '2026-09-24T11:00:00Z' });
  const outside = path.join(path.dirname(f.docs), `outside-${process.pid}.md`);
  fs.writeFileSync(outside, 'x');
  const t = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(outside, t, t);
  fs.writeFileSync(
    path.join(f.root, '.claude', 'task-flow.json'),
    JSON.stringify({ docsDir: f.docs, language: 'EN', tasksFile: `../${path.basename(outside)}` })
  );
  check('T37 a tasksFile outside docsDir is not followed', ALLOW, runStop(f.root, payloadFor(f.root)));
  fs.rmSync(outside, { force: true });
}

// --- report ---------------------------------------------------------------
const total = passed + failures.length;
console.log(`\n${passed}/${total} passed`);
if (failures.length) {
  console.log(`${failures.length} failing:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
