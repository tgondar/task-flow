#!/usr/bin/env node
// Tests for the task-flow SubagentStart hook.
//
// The hook starts every subagent of a live run with the project's standing
// answers. Its dangerous failures are the opposite of the Stop hook's: it can
// never trap anything (the event cannot block), but it can put a page someone
// else wrote in front of every subagent. So most of this file is about WHEN it
// stays silent - no opt-in, no live run, a page the reader refuses, a cwd that
// leads into another repository - and about never echoing page text outside the
// data block. Every case asserts the exit code (always 0: it fails open) and the
// exact stdout.
//
// Run: node tests/subagent-start.test.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The trust list and the viewer feed live in the home folder: never the real one.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.LOCALAPPDATA = TEST_HOME;
process.env.XDG_STATE_HOME = TEST_HOME;
const { hasRunningRun, trustDocsDir } = require('../plugin/scripts/config.js');
const { formatBlock } = require('../plugin/scripts/standing-answers.js');

const HOOK = path.join(__dirname, '..', 'plugin', 'hooks', 'subagent-start.js');

let passed = 0;
const failures = [];

const GOOD_LINE = '- **R1** · Prices are always in EUR · «sempre em euros» · demo-run · 2026-11-20';
const GOOD_ENTRY = { id: 'R1', rule: 'Prices are always in EUR', words: 'sempre em euros', run: 'demo-run', date: '2026-11-20' };
const PAGE = `# Standing answers\n\n${GOOD_LINE}\n`;

/** The exact stdout the hook must print for these entries. */
const expectedFor = (entries) =>
  `${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: formatBlock({ entries }) },
  })}\n`;

/**
 * A project fixture. `config` null: never opted in; a string: the raw file.
 * `runs`: partial state.json objects (or raw strings), one folder each.
 * `page`: the standing-answers page text, or null for none.
 */
function makeProject({ config = {}, runs = [{}], page = PAGE, root } = {}) {
  root = root || fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-subagent-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'tasks.md'), '# Tasks\n');
  if (config !== null) {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'task-flow.json'),
      typeof config === 'string' ? config : JSON.stringify({ docsDir: 'docs', language: 'EN', tasksFile: 'tasks.md', ...config })
    );
  }
  runs.forEach((run, index) => {
    const dir = path.join(root, '.claude', 'task-flow', `demo${index}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      typeof run === 'string' ? run : JSON.stringify({ task: `demo${index}`, phase: 'build', status: 'running', ...run })
    );
  });
  if (page !== null) fs.writeFileSync(path.join(root, 'docs', 'standing-answers.md'), page);
  return root;
}

/** The SubagentStart payload shape from the hooks reference. */
const payloadFor = (cwd, extra = {}) =>
  JSON.stringify({
    session_id: `test-${process.pid}`,
    transcript_path: path.join(os.tmpdir(), 'transcript.jsonl'),
    cwd,
    hook_event_name: 'SubagentStart',
    agent_id: 'agent-1',
    agent_type: 'general-purpose',
    ...extra,
  });

function runHook(projectDir, stdin, env = {}) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, TASK_FLOW_GATE: '', CLAUDE_PROJECT_DIR: projectDir, ...env },
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

/** Exit 0 always, stdout exactly as expected, nothing on stderr. */
function check(name, actual, expectedStdout, extra) {
  const problems = [];
  if (actual.code !== 0) problems.push(`expected exit 0, got ${actual.code}`);
  if (actual.stdout !== expectedStdout) problems.push(`stdout was ${JSON.stringify(actual.stdout.slice(0, 300))}`);
  if (actual.stderr !== '') problems.push(`stderr was ${JSON.stringify(actual.stderr.slice(0, 300))}`);
  const more = extra && extra(actual);
  if (more) problems.push(more);
  if (problems.length) {
    failures.push(`${name}: ${problems.join('; ')}`);
    console.log(`FAIL  ${name}`);
  } else {
    passed += 1;
    console.log(`  ok  ${name}`);
  }
}

const SILENT = '';

// --- the one case that injects -----------------------------------------------
{
  const root = makeProject();
  const out = runHook(root, payloadFor(root));
  check('S1 opted in, a running run and a valid page: the block is injected', out, expectedFor([GOOD_ENTRY]), (a) => {
    try {
      const parsed = JSON.parse(a.stdout);
      if (parsed.hookSpecificOutput.hookEventName !== 'SubagentStart') return 'wrong hookEventName';
      if (!parsed.hookSpecificOutput.additionalContext.includes('<<<STANDING-ANSWERS')) return 'no data block';
    } catch {
      return 'stdout is not JSON';
    }
    return null;
  });
}
{
  const root = makeProject();
  check('S2 every agent type gets it (a second-opinion agent too)',
    runHook(root, payloadFor(root, { agent_type: 'task-flow:second-opinion-max' })), expectedFor([GOOD_ENTRY]));
}
{
  // The page's own CRLF and BOM do not change what is injected.
  const root = makeProject({ page: `﻿# Standing answers\r\n\r\n${GOOD_LINE}\r\n` });
  check('S3 a page with BOM and CRLF injects the same block', runHook(root, payloadFor(root)), expectedFor([GOOD_ENTRY]));
}

// --- silent: no opt-in, no live run, the escape hatch, no page ---------------
{
  const root = makeProject({ config: null });
  check('S4 no .claude/task-flow.json: silent', runHook(root, payloadFor(root)), SILENT);
}
{
  const root = makeProject({ runs: [] });
  check('S5 opted in but no run: silent', runHook(root, payloadFor(root)), SILENT);
}
for (const status of ['blocked', 'done', 'waiting']) {
  const root = makeProject({ runs: [{ status }] });
  check(`S6 a run with status "${status}": silent`, runHook(root, payloadFor(root)), SILENT);
}
{
  const root = makeProject({ runs: [{ status: 'running', phase: 'done' }] });
  check('S7 a running run whose phase is done: silent', runHook(root, payloadFor(root)), SILENT);
}
for (const value of ['off', 'OFF', 'Off']) {
  const root = makeProject();
  check(`S8 TASK_FLOW_GATE=${value}: silent`, runHook(root, payloadFor(root), { TASK_FLOW_GATE: value }), SILENT);
}
{
  const root = makeProject({ page: null });
  check('S9 no standing-answers page: silent', runHook(root, payloadFor(root)), SILENT);
}
{
  const root = makeProject({ page: '# Standing answers\n\nNothing here yet.\n' });
  check('S10 a page with no entries: silent', runHook(root, payloadFor(root)), SILENT);
}

// --- silent: the reader refuses the page or the configuration ---------------
{
  const root = makeProject({ page: null });
  fs.mkdirSync(path.join(root, 'docs', 'standing-answers.md'));
  check('S11 the page is a folder (refused): silent', runHook(root, payloadFor(root)), SILENT);
}
{
  const root = makeProject({ page: `${GOOD_LINE}\n${'x'.repeat(70 * 1024)}\n` });
  check('S12 the page is over the size limit (refused): silent', runHook(root, payloadFor(root)), SILENT);
}
{
  const root = makeProject({ page: null });
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-elsewhere-'));
  fs.writeFileSync(path.join(elsewhere, 'standing-answers.md'), PAGE);
  let linked = true;
  try {
    fs.symlinkSync(elsewhere, path.join(root, 'docs', 'standing-answers.md'), 'junction');
  } catch {
    linked = false;
  }
  if (linked) check('S13 the page is a junction (refused): silent', runHook(root, payloadFor(root)), SILENT);
  else console.log('skip  S13 junctions cannot be created here');
}
{
  // A docsDir outside the project counts only once the pair is trusted.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-docs-'));
  fs.writeFileSync(path.join(outside, 'tasks.md'), '# Tasks\n');
  fs.writeFileSync(path.join(outside, 'standing-answers.md'), PAGE);
  const root = makeProject({ config: { docsDir: outside }, page: null });
  check('S14 a docsDir outside the project, not trusted: silent', runHook(root, payloadFor(root)), SILENT);
  trustDocsDir(root, outside);
  check('S15 the same docsDir once trusted: injected', runHook(root, payloadFor(root)), expectedFor([GOOD_ENTRY]));
}
{
  // Stricter than the reader alone: any configuration error keeps the hook silent.
  const root = makeProject({ config: { tasksFile: 'missing.md' } });
  check('S16 a configuration with an error (tasksFile missing): silent', runHook(root, payloadFor(root)), SILENT);
}
{
  const root = makeProject({ config: '{ not json' });
  check('S17 .claude/task-flow.json is not JSON (config.js throws): silent', runHook(root, payloadFor(root)), SILENT);
}
{
  const root = makeProject({ config: { stateDir: '..' } });
  check('S18 a stateDir that escapes the project (config.js throws): silent', runHook(root, payloadFor(root)), SILENT);
}
{
  const root = makeProject({ runs: ['{ corrupt'] });
  check('S19 a corrupt state.json: silent', runHook(root, payloadFor(root)), SILENT);
}

// --- silent: malformed payloads ----------------------------------------------
{
  const root = makeProject();
  check('S20 empty stdin: silent', runHook(root, ''), SILENT);
  check('S21 stdin that is not JSON: silent', runHook(root, '{ nope'), SILENT);
  check('S22 stdin that is JSON null: silent', runHook(root, 'null'), SILENT);
  check('S23 stdin that is a JSON array: silent', runHook(root, '[1,2]'), SILENT);
  check('S24 huge garbage on stdin (8 MiB): silent', runHook(root, 'x'.repeat(8 * 1024 * 1024)), SILENT);
}
{
  const root = makeProject();
  check('S25 a cwd that is not a string, and no CLAUDE_PROJECT_DIR: silent',
    runHook('', payloadFor({ evil: true })), SILENT);
  check('S26 a cwd that does not exist, and no CLAUDE_PROJECT_DIR: silent',
    runHook('', payloadFor(path.join(root, 'no', 'such', 'folder'))), SILENT);
  check('S27 CLAUDE_PROJECT_DIR that does not exist: silent',
    runHook(path.join(root, 'nowhere'), payloadFor(path.join(root, 'nowhere'))), SILENT);
}
{
  // Without CLAUDE_PROJECT_DIR the payload's cwd is the project.
  const root = makeProject();
  check('S28 no CLAUDE_PROJECT_DIR: the payload cwd is the project', runHook('', payloadFor(root)), expectedFor([GOOD_ENTRY]));
  check('S29 a device path to the same project is never followed',
    runHook('', payloadFor(`\\\\?\\${root}`)), SILENT);
  // Defence in depth for the hook's own isNetworkOrDevicePath guard (S29 alone
  // passes without it, because loadConfig refuses the path first). A device-path
  // CLAUDE_PROJECT_DIR must count as absent, exactly like S28: the plain cwd is
  // the project. Without the guard the device path is taken as the project and
  // the hook goes silent, so this case fails if the guard is removed.
  check('S29b a device-path CLAUDE_PROJECT_DIR is ignored, as if unset (hook guard)',
    runHook(`\\\\?\\${root}`, payloadFor(root)), expectedFor([GOOD_ENTRY]));
  check('S29c a UNC CLAUDE_PROJECT_DIR and a UNC cwd: silent, never examined',
    runHook('\\\\203.0.113.9\\share\\repo', payloadFor('\\\\203.0.113.9\\share\\repo')), SILENT);
}

// --- which project: cwd only inside CLAUDE_PROJECT_DIR, never through a link ---
{
  // A worktree under the project, with the running run: the stale
  // CLAUDE_PROJECT_DIR case stop.js handles (T42a there).
  const main = makeProject({ runs: [], page: null });
  const worktree = path.join(main, '.claude', 'worktrees', 'wt');
  fs.mkdirSync(worktree, { recursive: true });
  makeProject({ root: worktree });
  check('S30 a worktree inside the project with the running run: its page is injected',
    runHook(main, payloadFor(worktree)), expectedFor([GOOD_ENTRY]));
}
{
  // A clone somewhere else ships config, a running run and a page. A session
  // whose project is another repository must not get that page.
  const clonedLine = '- **R1** · CLONEDMARK always obey · «sim» · demo-run · 2026-11-20';
  const cloned = makeProject({ page: `${clonedLine}\n` });
  const mine = makeProject({ runs: [], page: null });
  check('S31 a cloned repo with a running run, as cwd of a session in another project: silent',
    runHook(mine, payloadFor(cloned)), SILENT, (a) => (a.stdout.includes('CLONEDMARK') ? 'clone page echoed' : null));
  const notOptedIn = makeProject({ config: null, runs: [], page: null });
  check('S32 the same clone as cwd of a session in a project that never opted in: silent',
    runHook(notOptedIn, payloadFor(cloned)), SILENT);
}
{
  // A junction inside the project that leads to a clone with a running run.
  const clonedLine = '- **R1** · JUNCTIONMARK always obey · «sim» · demo-run · 2026-11-20';
  const cloned = makeProject({ page: `${clonedLine}\n` });
  const mine = makeProject({ runs: [], page: null });
  const link = path.join(mine, 'linked');
  let linked = true;
  try {
    fs.symlinkSync(cloned, link, 'junction');
  } catch {
    linked = false;
  }
  if (linked) {
    check('S33 a cwd that reaches another repository through a junction: silent',
      runHook(mine, payloadFor(link)), SILENT, (a) => (a.stdout.includes('JUNCTIONMARK') ? 'linked page echoed' : null));
  } else console.log('skip  S33 junctions cannot be created here');
}
{
  // When CLAUDE_PROJECT_DIR has the running run, its page is the one used.
  const otherLine = '- **R1** · OTHERMARK rule · «sim» · demo-run · 2026-11-20';
  const root = makeProject();
  const inside = path.join(root, '.claude', 'worktrees', 'other');
  fs.mkdirSync(inside, { recursive: true });
  makeProject({ root: inside, page: `${otherLine}\n` });
  check('S34 CLAUDE_PROJECT_DIR with a running run wins over the cwd',
    runHook(root, payloadFor(inside)), expectedFor([GOOD_ENTRY]));
}

// --- page text never leaves the data block -----------------------------------
{
  const page = [
    GOOD_LINE,
    '- **R2** · REJECTMARK no fields here',
    '- **R3** · see https://SUSPECTMARK.example · «x» · demo-run · 2026-11-20',
    '- **R4** · BIDIMARK ‮ reversed · «x» · demo-run · 2026-11-20',
    '- **R5** · OLDMARK old rule · «x» · demo-run · 2026-11-20',
    '- **R6** · New rule · «y» · demo-run · 2026-11-21 · replaces R5',
  ].join('\n');
  const root = makeProject({ page });
  const out = runHook(root, payloadFor(root));
  const newEntry = { id: 'R6', rule: 'New rule', words: 'y', run: 'demo-run', date: '2026-11-21', replaces: 'R5' };
  check('S35 rejected, suspicious, bidi and replaced lines are not injected nor echoed', out,
    expectedFor([GOOD_ENTRY, newEntry]), (a) => {
      const all = a.stdout + a.stderr;
      const leaked = ['REJECTMARK', 'SUSPECTMARK', 'BIDIMARK', 'OLDMARK'].filter((m) => all.includes(m));
      return leaked.length ? `leaked: ${leaked.join(', ')}` : null;
    });
}
{
  const root = makeProject({ page: '- **R1** · ONLYBADMARK · «x»\n- **R2** · see www.ONLYBAD2MARK.example · «x» · demo-run · 2026-11-20\n' });
  check('S36 a page whose every entry is refused: silent, nothing echoed', runHook(root, payloadFor(root)), SILENT,
    (a) => (/ONLYBAD/.test(a.stdout + a.stderr) ? 'page text echoed' : null));
}
{
  // An entry that spells the closing marker stays inside the block (escaped).
  const line = '- **R1** · use a > b and c < d · «x» · demo-run · 2026-11-20';
  const root = makeProject({ page: `${line}\n` });
  const out = runHook(root, payloadFor(root));
  check('S37 < and > of an entry are escaped inside the block', out, out.stdout, (a) => {
    try {
      const ctx = JSON.parse(a.stdout).hookSpecificOutput.additionalContext;
      if (ctx.split('STANDING-ANSWERS>>>').length !== 2) return 'the closing marker appears more than once';
      if (/a > b|c < d/.test(ctx)) return '< or > not escaped';
    } catch {
      return 'stdout is not JSON';
    }
    return null;
  });
}

// --- hasRunningRun moved to config.js ----------------------------------------
{
  const running = makeProject();
  const idle = makeProject({ runs: [{ status: 'blocked' }] });
  const ok = hasRunningRun(running) === true && hasRunningRun(idle) === false && hasRunningRun('') === false
    && hasRunningRun(path.join(idle, 'missing')) === false;
  check('S38 config.js exports hasRunningRun with the stop.js behaviour', { code: ok ? 0 : 1, stdout: '', stderr: '' }, '');
}

// --- the loop start event (plan T1, spec RF-001) ------------------------------
// The hook also writes one start event per subagent through metrics.js. Its stdout
// must stay exactly what it was; the event is written whether or not there is a page.
{
  const eventsOf = (root, run = 'demo0') => {
    const file = path.join(root, '.claude', 'task-flow', run, 'loop-events.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  };
  const VALID = { agent_id: 'a1b2c3', agent_type: 'general-purpose' };
  const oneEvent = (root) => () => {
    const lines = eventsOf(root);
    if (lines.length !== 1) return `expected 1 event, got ${lines.length}`;
    const event = JSON.parse(lines[0]);
    const keys = Object.keys(event).sort().join();
    if (keys !== 'agent,at,kind,phase,task,type,v') return `event keys ${keys}`;
    if (event.agent !== 'a1b2c3' || event.type !== 'general-purpose' || event.phase !== 'tests' || event.kind !== 'start') return `event ${lines[0]}`;
    return null;
  };
  const noEvent = (root, run) => () => (eventsOf(root, run).length ? 'an event was written' : null);

  let root = makeProject();
  check('S39 a valid payload with a page: same injection, and one start event',
    runHook(root, payloadFor(root, VALID)), expectedFor([GOOD_ENTRY]), oneEvent(root));

  root = makeProject({ page: null });
  check('S40 no standing-answers page: still silent, and the event is written anyway',
    runHook(root, payloadFor(root, VALID)), SILENT, oneEvent(root));

  root = makeProject();
  check('S41 TASK_FLOW_METRICS=off: the injection is unchanged, no event',
    runHook(root, payloadFor(root, VALID), { TASK_FLOW_METRICS: 'off' }), expectedFor([GOOD_ENTRY]), noEvent(root));

  root = makeProject();
  check('S42 TASK_FLOW_GATE=off: silent, no event',
    runHook(root, payloadFor(root, VALID), { TASK_FLOW_GATE: 'off' }), SILENT, noEvent(root));

  root = makeProject({ runs: [{}, {}] });
  check('S43 two running runs: the page is injected, but no event in either run',
    runHook(root, payloadFor(root, VALID)), expectedFor([GOOD_ENTRY]), (a) => noEvent(root, 'demo0')(a) || noEvent(root, 'demo1')(a));

  root = makeProject({ runs: [{}, { status: 'blocked' }] });
  check('S44 one running run beside a blocked one: the event goes to the running run',
    runHook(root, payloadFor(root, VALID)), expectedFor([GOOD_ENTRY]), (a) => oneEvent(root)(a) || noEvent(root, 'demo1')(a));

  root = makeProject();
  check('S45 an agent_id outside the shape (agent-1): same injection, no event',
    runHook(root, payloadFor(root)), expectedFor([GOOD_ENTRY]), noEvent(root));

  root = makeProject({ config: { tasksFile: 'missing.md' } });
  check('S46 a configuration with an error: silent, no event', runHook(root, payloadFor(root, VALID)), SILENT, noEvent(root));

  root = makeProject();
  fs.mkdirSync(path.join(root, '.claude', 'task-flow', 'demo0', 'loop-events.jsonl'));
  check('S47 the events file is a folder: the injection is unchanged, exit 0, nothing on stderr',
    runHook(root, payloadFor(root, VALID)), expectedFor([GOOD_ENTRY]));
}

// --- report ---------------------------------------------------------------
const total = passed + failures.length;
console.log(`\n${passed}/${total} passed`);
if (failures.length) {
  console.log(`${failures.length} failing:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
