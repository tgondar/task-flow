#!/usr/bin/env node
// Tests for the task-flow approval gate.
//
// Most of these are security tests, not feature tests: the gate is an
// authorization control, so the cases that matter are the ones that try to get
// past it (path traversal, casing, self-approval, unparseable input).
//
// Run: node tests/gate.test.js
// No dependencies: each case builds a payload in the shape the hook really
// receives and asserts on the gate's exit code.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GATE = path.join(__dirname, '..', 'plugin', 'hooks', 'gate.js');
const ALLOW = 0;
const BLOCK = 2;
const DEFAULT_STATE_DIR = '.claude/task-flow';

let passed = 0;
const failures = [];

/** Builds a project fixture with a run state in the requested shape.
 *
 *  A task-flow project is one with .claude/task-flow.json (the opt-in); pass
 *  config: null for a repository that never opted in, or a string for one whose
 *  configuration is not valid JSON. */
function makeProject({
  approved = false,
  withStateDir = true,
  stateDir = DEFAULT_STATE_DIR,
  config = stateDir === DEFAULT_STATE_DIR ? {} : { stateDir },
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-gate-'));
  if (config !== null) {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'task-flow.json'),
      typeof config === 'string' ? config : JSON.stringify(config)
    );
  }
  if (withStateDir) {
    const taskDir = path.join(root, ...stateDir.split('/'), 'demo');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, 'state.json'),
      JSON.stringify({
        task: 'demo',
        phase: 'plan',
        status: 'ready',
        approvedBy: approved ? 'user' : '',
        approvedAt: approved ? '2026-09-07T11:40:00Z' : null,
      })
    );
  }
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  return root;
}

/** The payload shape a real PreToolUse hook receives. */
function payloadFor(root, filePath, { tool = 'Write', content = 'x', extra = {} } = {}) {
  return JSON.stringify({
    session_id: 'f3e6ecd6-4d73-45b2-901d-5b9b79063f68',
    transcript_path: path.join(os.tmpdir(), 'transcript.jsonl'),
    cwd: root.replace(/\//g, '\\'),
    prompt_id: '77d66a23-6a6f-488b-bd67-e0d6cd7b89f1',
    permission_mode: 'acceptEdits',
    effort: { level: 'xhigh' },
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: { file_path: filePath, content, ...extra },
    tool_use_id: 'toolu_01NTyNhp2tmFAXtpmn5MmvvP',
  });
}

function runGate(root, stdin, env = {}) {
  const result = spawnSync(process.execPath, [GATE], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, TASK_FLOW_GATE: '', CLAUDE_PROJECT_DIR: root.replace(/\\/g, '/'), ...env },
  });
  return { code: result.status, stderr: result.stderr || '' };
}

function check(name, expectedCode, actual, extraAssert) {
  const problems = [];
  if (actual.code !== expectedCode) {
    problems.push(
      `expected exit ${expectedCode} (${expectedCode === BLOCK ? 'block' : 'allow'}), got ${actual.code}`
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

/** A Windows-shaped absolute path inside the fixture, as tool payloads carry it. */
const win = (root, ...parts) => [root, ...parts].join('\\').replace(/\//g, '\\');

// --- T1: code with no approval is refused ---------------------------------
{
  const root = makeProject({ approved: false });
  check('T1 unapproved code is blocked', BLOCK, runGate(root, payloadFor(root, win(root, 'src', 'Foo.cs'))));
}

// --- T2: code with approval goes through ----------------------------------
{
  const root = makeProject({ approved: true });
  check('T2 approved code is allowed', ALLOW, runGate(root, payloadFor(root, win(root, 'src', 'Foo.cs'))));
}

// --- T3: markdown never needs approval ------------------------------------
{
  const root = makeProject({ approved: false });
  check('T3 markdown is allowed while unapproved', ALLOW, runGate(root, payloadFor(root, win(root, 'notes.md'))));
}

// --- T4: the pipeline's own bookkeeping is always writable ----------------
{
  const root = makeProject({ approved: false });
  check('T4 files under the stateDir are allowed', ALLOW,
    runGate(root, payloadFor(root, win(root, '.claude', 'task-flow', 'demo', 'notes.txt'))));
}

// --- T5: traversal must not masquerade as the state directory -------------
// Security: '.claude/task-flow/../../src/Foo.cs' starts with the allowed prefix as
// a string, but resolves to source code. Blocking this is the whole point of
// normalising before classifying.
{
  const root = makeProject({ approved: false });
  const raw = `${root.replace(/\//g, '\\')}\\.claude\\task-flow\\..\\..\\src\\Foo.cs`;
  check('T5 path traversal out of the stateDir is blocked', BLOCK, runGate(root, payloadFor(root, raw)));
}

// --- T6: separators differ inside one payload -----------------------------
// file_path arrives with backslashes, CLAUDE_PROJECT_DIR with forward slashes.
{
  const root = makeProject({ approved: false });
  check('T6 mixed path separators still classify as code', BLOCK,
    runGate(root, payloadFor(root, `${root.replace(/\//g, '\\')}\\src\\Foo.cs`)));
}

// --- T7: Windows paths are case-insensitive -------------------------------
{
  const root = makeProject({ approved: false });
  check('T7 uppercase path is still code', BLOCK,
    runGate(root, payloadFor(root, `${root.replace(/\//g, '\\')}\\SRC\\FOO.CS`)));
}

// --- T8: an unreadable payload must not become a silent pass --------------
{
  const root = makeProject({ approved: true });
  check('T8 unparseable payload fails closed', BLOCK, runGate(root, 'this is not json'));
}

// --- T9: no readable run state means no approval --------------------------
{
  const root = makeProject({ withStateDir: false });
  check('T9 missing run state fails closed', BLOCK, runGate(root, payloadFor(root, win(root, 'src', 'Foo.cs'))));
}

// --- T10: the gate must not approve itself --------------------------------
// Security: the stateDir is writable (T4), and state.json lives there. Without
// this rule the agent could grant itself approval and then write code.
{
  const root = makeProject({ approved: false });
  const selfApproval = JSON.stringify({
    task: 'demo', phase: 'plan', status: 'ready',
    approvedBy: 'user', approvedAt: '2026-09-07T00:00:00Z',
  });
  check('T10 self-approval via state.json is blocked', BLOCK,
    runGate(root, payloadFor(root, win(root, '.claude', 'task-flow', 'demo', 'state.json'), { content: selfApproval })));
}

// --- T10b: an Edit fragment cannot smuggle approval in either ---------------
{
  const root = makeProject({ approved: false });
  check('T10b self-approval via an Edit fragment is blocked', BLOCK,
    runGate(root, payloadFor(root, win(root, '.claude', 'task-flow', 'demo', 'state.json'), {
      tool: 'Edit', content: null, extra: { old_string: '"approvedBy": ""', new_string: '"approvedBy": "me"' },
    })));
}

// --- T11: other state.json edits are ordinary bookkeeping -----------------
{
  const root = makeProject({ approved: false });
  const progress = JSON.stringify({
    task: 'demo', phase: 'spec', status: 'ready',
    approvedBy: '', approvedAt: null, buildCursor: 'T2',
  });
  check('T11 non-approval state.json edits are allowed', ALLOW,
    runGate(root, payloadFor(root, win(root, '.claude', 'task-flow', 'demo', 'state.json'), { content: progress })));
}

// --- T12: the escape hatch works, and says so -----------------------------
{
  const root = makeProject({ approved: false });
  check(
    'T12 TASK_FLOW_GATE=off disables the gate and announces it',
    ALLOW,
    runGate(root, payloadFor(root, win(root, 'src', 'Foo.cs')), { TASK_FLOW_GATE: 'off' }),
    (r) => (/off|disabled/i.test(r.stderr) ? null : 'stderr should say the gate is off')
  );
}

// --- T13: the rule is the extension, and that is a deliberate choice ------
{
  const root = makeProject({ approved: false });
  check('T13 markdown inside src/ is allowed', ALLOW, runGate(root, payloadFor(root, win(root, 'src', 'README.md'))));
}

// --- T14: a repository that never opted in is none of the gate's business -
// The plugin's hooks run in every project on the machine (user scope). Failing
// closed there would block every code edit in every other repository.
{
  const root = makeProject({ approved: false, withStateDir: false, config: null });
  check('T14 no .claude/task-flow.json: the gate stays out of the way', ALLOW,
    runGate(root, payloadFor(root, win(root, 'src', 'Foo.cs'))));
}

// --- T15: stateDir comes from the configuration, not a hard-coded default ---
{
  const root = makeProject({ approved: false, stateDir: 'docs/pipeline' });
  check('T15a unapproved code is blocked under a custom stateDir', BLOCK,
    runGate(root, payloadFor(root, win(root, 'src', 'Foo.cs'))));
  check('T15b bookkeeping under the custom stateDir is allowed', ALLOW,
    runGate(root, payloadFor(root, win(root, 'docs', 'pipeline', 'demo', 'notes.txt'))));
  check('T15c the default stateDir is not special when stateDir says otherwise', BLOCK,
    runGate(root, payloadFor(root, win(root, '.claude', 'task-flow', 'demo', 'notes.txt'))));
}
{
  const root = makeProject({ approved: true, stateDir: 'docs/pipeline' });
  check('T15d approval is read from the custom stateDir', ALLOW,
    runGate(root, payloadFor(root, win(root, 'src', 'Foo.cs'))));
}

// --- T16: self-approval is refused under a custom stateDir too -------------
{
  const root = makeProject({ approved: false, stateDir: 'docs/pipeline' });
  const selfApproval = JSON.stringify({ task: 'demo', phase: 'plan', approvedBy: 'user' });
  check('T16 self-approval via a custom stateDir is blocked', BLOCK,
    runGate(root, payloadFor(root, win(root, 'docs', 'pipeline', 'demo', 'state.json'), { content: selfApproval })));
}

// --- T17: a stateDir that climbs out of the project is not trusted ---------
// Security: stateDir '..' would make the whole parent directory "bookkeeping"
// and let code be written anywhere under it.
{
  const root = makeProject({ approved: false, withStateDir: false, config: { stateDir: '..' } });
  check('T17 a stateDir outside the project fails closed', BLOCK,
    runGate(root, payloadFor(root, win(root, 'src', 'Foo.cs'))));
}
{
  const root = makeProject({ approved: false, withStateDir: false, config: { stateDir: '.' } });
  check('T17b a stateDir that is the project root itself fails closed', BLOCK,
    runGate(root, payloadFor(root, win(root, 'src', 'Foo.cs'))));
}

// --- T18: the configuration itself is not bookkeeping -----------------------
// Security: repointing stateDir, or dropping the opt-in by rewriting the file,
// must need an approved run like any other non-markdown write.
{
  const root = makeProject({ approved: false });
  check('T18 rewriting task-flow.json while unapproved is blocked', BLOCK,
    runGate(root, payloadFor(root, win(root, '.claude', 'task-flow.json'), { content: '{"stateDir":"src"}' })));
}

// --- T19: an unreadable configuration fails closed ---------------------------
{
  const root = makeProject({ approved: true, config: '{ not json' });
  check('T19 unparseable task-flow.json fails closed', BLOCK,
    runGate(root, payloadFor(root, win(root, 'src', 'Foo.cs'))));
}

// --- T20: missing required fields do not open the gate ------------------------
// Security: a configuration without docsDir/language/tasksFile stops the skill
// from starting, but it is still an opt-in - the gate keeps guarding the code.
{
  const root = makeProject({ approved: false, config: { stateDir: DEFAULT_STATE_DIR } });
  check('T20 an incomplete configuration still blocks unapproved code', BLOCK,
    runGate(root, payloadFor(root, win(root, 'src', 'Foo.cs'))));
}

// --- T22: self-approval through Edit is judged on the RESULT, not the fragment ---
// Security: each of these got past a check that only read new_string. The gate
// now replays the edit on the file and parses what would be written.
{
  const statePath = (root) => path.join(root, '.claude', 'task-flow', 'demo', 'state.json');
  const edit = (root, input, tool = 'Edit') =>
    runGate(root, payloadFor(root, win(root, '.claude', 'task-flow', 'demo', 'state.json'), { tool, content: null, extra: input }));
  const apply = (root, oldString, newString) => {
    const file = statePath(root);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(oldString, newString));
  };

  let root = makeProject({ approved: false });
  check('T22a a key split across old_string and new_string is blocked', BLOCK,
    edit(root, { old_string: 'y":""', new_string: 'y":"me"' }));

  root = makeProject({ approved: false });
  check('T22b a unicode-escaped approvedBy key is blocked', BLOCK,
    edit(root, { old_string: '"approvedBy":""', new_string: '"approvedBy":"","approved\\u0042y":"me"' }));

  root = makeProject({ approved: false });
  check('T22c renaming the empty approvedBy away is bookkeeping', ALLOW,
    edit(root, { old_string: '"approvedBy":""', new_string: '"note":""' }));
  apply(root, '"approvedBy":""', '"note":""');
  check('T22d ...and renaming another key to approvedBy is blocked', BLOCK,
    edit(root, { old_string: '"status"', new_string: '"approvedBy"' }));

  root = makeProject({ approved: false });
  check('T22e a MultiEdit-shaped list of edits is replayed too', BLOCK,
    edit(root, { edits: [
      { old_string: '"status":"ready"', new_string: '"status":"running"' },
      { old_string: '"approvedBy":""', new_string: '"approvedBy":"me"' },
    ] }, 'MultiEdit'));

  root = makeProject({ approved: false });
  check('T22f an edit the gate cannot replay on an unapproved state.json is blocked', BLOCK,
    edit(root, { old_string: 'text that is not in the file', new_string: '"approvedBy":"me"' }));

  root = makeProject({ approved: false });
  check('T22g an ordinary Edit of an unapproved state.json is allowed', ALLOW,
    edit(root, { old_string: '"status":"ready"', new_string: '"status":"running"' }));

  root = makeProject({ approved: true });
  check('T22h editing an already approved state.json is allowed', ALLOW,
    edit(root, { old_string: '"phase":"plan"', new_string: '"phase":"build"' }));

  root = makeProject({ approved: false });
  check('T22i a Write replacing the file with an approval is still blocked', BLOCK,
    runGate(root, payloadFor(root, win(root, '.claude', 'task-flow', 'demo', 'state.json'), {
      content: '{"task":"demo","approved\\u0042y":"me"}',
    })));
}

// --- T23: only a text approvedBy approves -----------------------------------
// Security: the approval gate writes a name. true, 1 or an object in approvedBy
// was never written by it, so it must not open the gate for code.
for (const value of [true, 1, { by: 'me' }, ['me']]) {
  const root = makeProject({ approved: false });
  const file = path.join(root, '.claude', 'task-flow', 'demo', 'state.json');
  fs.writeFileSync(file, JSON.stringify({ task: 'demo', phase: 'plan', approvedBy: value }));
  check(`T23 approvedBy ${JSON.stringify(value)} on disk does not approve code`, BLOCK,
    runGate(root, payloadFor(root, win(root, 'src', 'Foo.cs'))));
}

// --- report ---------------------------------------------------------------
const total = passed + failures.length;
console.log(`\n${passed}/${total} passed`);
if (failures.length) {
  console.log(`${failures.length} failing:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
