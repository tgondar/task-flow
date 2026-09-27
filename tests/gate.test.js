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

// The gate reads the home folder (the trust list, and where .claude instructions
// live). These tests get a home of their own; the hook inherits it.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

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
    runGate(root, payloadFor(root, win(root, '.claude', 'task-flow', 'demo', 'notes.md'))));
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
    runGate(root, payloadFor(root, win(root, 'docs', 'pipeline', 'demo', 'notes.md'))));
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

// --- T24: a finished run approves nothing -----------------------------------
// Security: state.json stays in the repository. Without this, one approval would
// keep the gate open long after its run closed - or come committed in a clone.
{
  const stateFile = (root, task = 'demo') => path.join(root, '.claude', 'task-flow', task, 'state.json');
  const put = (root, task, state) => {
    fs.mkdirSync(path.dirname(stateFile(root, task)), { recursive: true });
    fs.writeFileSync(stateFile(root, task), JSON.stringify(state));
  };
  let root = makeProject({ approved: false });
  put(root, 'demo', { task: 'demo', phase: 'done', status: 'done', approvedBy: 'user' });
  check('T24a an approved run that is done does not approve code', BLOCK, runGate(root, payloadFor(root, win(root, 'src', 'Foo.cs'))));

  root = makeProject({ approved: false });
  put(root, 'demo', { task: 'demo', phase: 'build', status: 'failed', approvedBy: 'user' });
  check('T24b an approved run that failed does not approve code', BLOCK, runGate(root, payloadFor(root, win(root, 'src', 'Foo.cs'))));

  root = makeProject({ approved: false });
  put(root, 'old', { task: 'old', phase: 'done', status: 'done', approvedBy: 'user' });
  put(root, 'demo', { task: 'demo', phase: 'plan', status: 'running', approvedBy: 'user' });
  check('T24c an unfinished approved run still approves code', ALLOW, runGate(root, payloadFor(root, win(root, 'src', 'Foo.cs'))));

  root = makeProject({ approved: false });
  put(root, 'demo', { task: 'demo', phase: 'done', status: 'done', approvedBy: 'user' });
  check('T24d reopening a finished approved run through Edit is blocked', BLOCK,
    runGate(root, payloadFor(root, win(root, '.claude', 'task-flow', 'demo', 'state.json'), {
      tool: 'Edit', content: null, extra: { old_string: '"phase":"done","status":"done"', new_string: '"phase":"plan","status":"running"' },
    })));
}

// --- T25: the gate fails closed on anything it did not expect ----------------
// Security: exit 1 is a non-blocking hook error in Claude Code, so a crash on a
// strange payload would let the write through.
{
  const root = makeProject({ approved: false });
  for (const stdin of ['null', '[1,2]', '"text"', '42']) {
    check(`T25 payload ${stdin} is refused, not crashed on`, BLOCK, runGate(root, stdin),
      (r) => (/GATE:/.test(r.stderr) ? null : 'stderr should carry the gate\'s own message'));
  }
  const odd = JSON.stringify({ cwd: root, tool_name: 'Write', tool_input: 'not an object' });
  check('T25 a tool_input that is not an object is treated as code', BLOCK, runGate(root, odd));
}

// --- T26: markdown that is really instructions needs approval ---------------
// Security: commands, agents, skills and a CLAUDE.md outside the project are read
// by the agent as orders; "documentation is not code" must not cover them.
{
  const root = makeProject({ approved: false });
  const home = (...parts) => [TEST_HOME, ...parts].join('\\');
  check('T26a a command under the project .claude/ is blocked', BLOCK,
    runGate(root, payloadFor(root, win(root, '.claude', 'commands', 'evil.md'))));
  check('T26b an agent under ~/.claude/ is blocked', BLOCK,
    runGate(root, payloadFor(root, home('.claude', 'agents', 'evil.md'))));
  check('T26c a CLAUDE.md in a parent folder is blocked', BLOCK,
    runGate(root, payloadFor(root, [path.dirname(root), 'CLAUDE.md'].join('\\'))));
  check('T26d the auto-memory folder stays open', ALLOW,
    runGate(root, payloadFor(root, home('.claude', 'projects', 'C--x', 'memory', 'note.md'))));
  check('T26e the plan-mode folder stays open', ALLOW,
    runGate(root, payloadFor(root, home('.claude', 'plans', 'plan.md'))));
  check('T26f other markdown outside the project stays open', ALLOW,
    runGate(root, payloadFor(root, [path.dirname(root), 'notes', 'idea.md'].join('\\'))));
  check('T26g the project CLAUDE.md stays open', ALLOW,
    runGate(root, payloadFor(root, win(root, 'CLAUDE.md'))));
}
{
  const root = makeProject({ approved: true });
  check('T26h with an approved run, a project command may be written', ALLOW,
    runGate(root, payloadFor(root, win(root, '.claude', 'commands', 'tool.md'))));
}

// --- T27: only state.json and notes are bookkeeping in the stateDir ---------
// Security: a stateDir of "src" would otherwise make the source tree bookkeeping.
{
  let root = makeProject({ approved: false });
  check('T27a a script in the stateDir is code', BLOCK,
    runGate(root, payloadFor(root, win(root, '.claude', 'task-flow', 'demo', 'x.js'))));

  root = makeProject({ approved: false, withStateDir: true, stateDir: 'src', config: { stateDir: 'src' } });
  check('T27b stateDir "src" does not open the source tree', BLOCK,
    runGate(root, payloadFor(root, win(root, 'src', 'app.js'))));

  root = makeProject({ approved: false });
  check('T27c a relative path is resolved before it is classified', BLOCK,
    runGate(root, payloadFor(root, '.claude/task-flow/demo/x.js')));
  check('T27d a relative state.json still gets the self-approval check', BLOCK,
    runGate(root, payloadFor(root, '.claude/task-flow/demo/state.json', { content: JSON.stringify({ task: 'demo', approvedBy: 'me' }) })));
}

// --- T28: a path through a link inside the project gets no exemption ---------
// Security: a repository can commit a link (a junction on Windows) that makes an
// inside-looking path land in src/ or in ~/.claude.
{
  const root = makeProject({ approved: false });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-gate-link-'));
  fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
  check('T28a markdown through a link in the project is not free', BLOCK,
    runGate(root, payloadFor(root, win(root, 'linked', 'notes.md'))));

  fs.symlinkSync(path.join(root, 'src'), path.join(root, '.claude', 'task-flow', 'evil'), 'junction');
  check('T28b a file in a linked run folder is code', BLOCK,
    runGate(root, payloadFor(root, win(root, '.claude', 'task-flow', 'evil', 'notes.md'))));
  check('T28c a state.json in a linked run folder is code', BLOCK,
    runGate(root, payloadFor(root, win(root, '.claude', 'task-flow', 'evil', 'state.json'), { content: '{}' })));
}

// --- T29: a run's questions.json is bookkeeping, and only that exact file ------
// The questions are written from the spec on, before any approval, so the gate
// lets <stateDir>/<run>/questions.json through. Everything that merely looks like
// it must still count as code.
{
  const root = makeProject({ approved: false });
  // A valid questions file for run "demo" (makeProject gives it a state.json).
  const VALID = JSON.stringify({ version: 1, slug: 'demo', items: [{ id: 'Q1', kind: 'question', title: 'Which currency?' }] });
  const q = (...parts) => payloadFor(root, win(root, '.claude', 'task-flow', ...parts), { content: VALID });

  check('T29a an unapproved run may write its questions.json', ALLOW, runGate(root, q('demo', 'questions.json')));
  check('T29b in any casing, with forward slashes', ALLOW,
    runGate(root, payloadFor(root, `${root.replace(/\\/g, '/')}/.claude/Task-Flow/DEMO/Questions.JSON`, { content: VALID })));
  check('T29c a relative path to it', ALLOW,
    runGate(root, payloadFor(root, '.claude/task-flow/demo/questions.json', { content: VALID })));
  fs.writeFileSync(path.join(root, '.claude', 'task-flow', 'demo', 'questions.json'), VALID);
  check('T29d an Edit of it that keeps it valid', ALLOW,
    runGate(root, payloadFor(root, win(root, '.claude', 'task-flow', 'demo', 'questions.json'), {
      tool: 'Edit', content: null, extra: { old_string: 'Which currency?', new_string: 'Which currency on invoices?' },
    })));

  check('T29e SECURITY stateDir/questions.json (no run folder) is code', BLOCK, runGate(root, q('questions.json')));
  check('T29f SECURITY a deeper questions.json is code', BLOCK, runGate(root, q('demo', 'sub', 'questions.json')));
  check('T29g SECURITY a questions.json outside stateDir is code', BLOCK,
    runGate(root, payloadFor(root, win(root, 'src', 'demo', 'questions.json'), { content: '{}' })));
  check('T29h SECURITY .. that climbs out of stateDir is code', BLOCK,
    runGate(root, payloadFor(root, win(root, '.claude', 'task-flow', 'demo', '..', '..', '..', 'src', 'questions.json'), { content: '{}' })));
  check('T29i SECURITY a run folder starting with a dot is code', BLOCK, runGate(root, q('.hidden', 'questions.json')));
  check('T29j SECURITY a similar name is code', BLOCK, runGate(root, q('demo', 'questions.json.js')));
  check('T29k SECURITY another JSON file in the run folder is code', BLOCK, runGate(root, q('demo', 'answers.json')));

  fs.symlinkSync(path.join(root, 'src'), path.join(root, '.claude', 'task-flow', 'evil'), 'junction');
  check('T29l SECURITY a questions.json in a linked run folder is code', BLOCK, runGate(root, q('evil', 'questions.json')));

  check('T29m SECURITY the questions.json exemption does not open state.json to self-approval', BLOCK,
    runGate(root, payloadFor(root, win(root, '.claude', 'task-flow', 'demo', 'state.json'), {
      content: JSON.stringify({ task: 'demo', phase: 'plan', status: 'ready', approvedBy: 'me' }),
    })));
  check('T29n SECURITY and writing code still needs approval after a questions.json write', BLOCK,
    runGate(root, payloadFor(root, win(root, 'src', 'app.js'))));

  // The content is judged too: the path alone would let any JSON through.
  const at = win(root, '.claude', 'task-flow', 'demo', 'questions.json');
  check('T29o SECURITY text that is not JSON is blocked', BLOCK, runGate(root, payloadFor(root, at, { content: 'module.exports = 1;' })));
  check('T29p SECURITY JSON of another shape is blocked', BLOCK, runGate(root, payloadFor(root, at, { content: '{"name":"app","dependencies":{}}' })));
  check('T29q SECURITY a questions file naming another run is blocked', BLOCK,
    runGate(root, payloadFor(root, at, { content: VALID.replace('"slug":"demo"', '"slug":"other"') })));
  check('T29r SECURITY an approvedBy smuggled into questions.json is blocked', BLOCK,
    runGate(root, payloadFor(root, at, { content: VALID.replace('"version":1', '"version":1,"approvedBy":"me"') })));
  check('T29s SECURITY an Edit that would break it is blocked', BLOCK,
    runGate(root, payloadFor(root, at, { tool: 'Edit', content: null, extra: { old_string: '"version":1', new_string: '"version":2' } })));
  check('T29t SECURITY an Edit that cannot be replayed is blocked', BLOCK,
    runGate(root, payloadFor(root, at, { tool: 'Edit', content: null, extra: { old_string: 'not in the file', new_string: 'x' } })));
  fs.mkdirSync(path.join(root, '.claude', 'task-flow', 'nostate'), { recursive: true });
  check('T29u SECURITY a run folder without a state.json is not a run', BLOCK,
    runGate(root, payloadFor(root, win(root, '.claude', 'task-flow', 'nostate', 'questions.json'), { content: VALID.replace('"slug":"demo"', '"slug":"nostate"') })));

  // A stateDir among code: the exemption must not open it to other JSON.
  const code = makeProject({ approved: false, stateDir: 'src' });
  check('T29v SECURITY with stateDir "src", a JSON file named questions.json that is not one is still code', BLOCK,
    runGate(code, payloadFor(code, win(code, 'src', 'demo', 'questions.json'), { content: '{"i18n":{"en":"Hello"}}' })));
}

// --- report ---------------------------------------------------------------
const total = passed + failures.length;
console.log(`\n${passed}/${total} passed`);
if (failures.length) {
  console.log(`${failures.length} failing:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
