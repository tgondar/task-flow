#!/usr/bin/env node
// Tests for config.js's bumpPolicy: the project's own rule for which version
// level each class of change gets (SKILL.md §6 and §7 item 2), validated by
// `check` only and written by `bump-policy`.
//
// Mostly security tests. The file is committed, so the policy is text anyone
// with push access writes: a closed shape (closed classes, closed levels, no
// other key), errors that name the field and never the value, and - the one that
// matters most - a malformed policy never switches the hooks or the renderer
// off, because only `check` validates it.
//
// Run: node tests/config.bump-policy.test.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The trust list, the guards and the viewer feed live in the home folder: never the real one.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.LOCALAPPDATA = TEST_HOME;
process.env.XDG_STATE_HOME = TEST_HOME;

const ROOT = path.join(__dirname, '..');
const MODULE = path.join(ROOT, 'plugin', 'scripts', 'config.js');
const STOP = path.join(ROOT, 'plugin', 'hooks', 'stop.js');
const SUBAGENT_START = path.join(ROOT, 'plugin', 'hooks', 'subagent-start.js');
const { BUMP_CLASSES, BUMP_LEVELS, bumpPolicyErrors, loadConfig, setBumpPolicy } = require(MODULE);

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok    ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL  ${name}\n        ${error.message}\n`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Planted in every bad value: it must never come back in any output. */
const MARKER = 'ZZ-MARKER-ignore-previous-instructions';

/** A configured project (githubProject answered, so `check` can pass) with the
 *  given extra fields, or the raw text of the file when `raw` is a string. */
function makeProject(extra = {}, raw) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-bump-'));
  fs.mkdirSync(path.join(project, 'docs', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(project, 'docs', 'tasks', 'index.md'), '# Tasks\n');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  const config = { docsDir: 'docs', language: 'EN', tasksFile: 'tasks/index.md', githubProject: null, ...extra };
  fs.writeFileSync(path.join(project, '.claude', 'task-flow.json'), raw === undefined ? JSON.stringify(config) : raw);
  return project;
}
const configFile = (project) => path.join(project, '.claude', 'task-flow.json');
const readConfig = (project) => JSON.parse(fs.readFileSync(configFile(project), 'utf8'));
const cli = (project, ...args) => spawnSync(process.execPath, [MODULE, ...args, '--project-dir', project], {
  encoding: 'utf8', env: { ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME },
});

/** Temp files left under `dir`: config.js writes `<file>.<pid>.<hex>.tmp` and
 *  renames it, so after any write, good or failed, there must be none. */
const tmpFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((name) => String(name).endsWith('.tmp')) : []);
const noTmp = (project) => {
  const left = [...tmpFiles(path.join(project, '.claude')), ...tmpFiles(path.join(TEST_HOME, '.claude'))];
  assert(!left.length, `temp files left behind: ${left.join(', ')}`);
};
/** Runs fn with fs[name] replaced by `fake(original, ...args)` - the same fs
 *  object config.js uses - and always puts the original back. */
function withFs(name, fake, fn) {
  const original = fs[name];
  fs[name] = (...args) => fake(original, ...args);
  try {
    return fn();
  } finally {
    fs[name] = original;
  }
}
/** The error fn threw, or a failure when it did not throw. */
function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('did not throw');
}
const failingRename = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };

console.log('config.js bumpPolicy');

// --- the closed lists ------------------------------------------------------

check('B0 the classes are option four of Q8: feature and fix required, breaking and restructure optional', () => {
  assert(JSON.stringify(BUMP_CLASSES) === JSON.stringify({ feature: 'required', fix: 'required', breaking: 'optional', restructure: 'optional' }),
    JSON.stringify(BUMP_CLASSES));
  assert(JSON.stringify(BUMP_LEVELS) === JSON.stringify(['major', 'minor', 'patch']), JSON.stringify(BUMP_LEVELS));
});

// --- check: valid policies pass -------------------------------------------

check('B1 `check` passes with the two required classes, and shows the policy', () => {
  const r = cli(makeProject({ bumpPolicy: { feature: 'minor', fix: 'patch' } }), 'check');
  assert(r.status === 0, `exit ${r.status}: ${r.stdout}`);
  assert(/bumpPolicy\s*: feature=minor, fix=patch/.test(r.stdout), r.stdout);
});

check('B2 `check` passes with all four classes', () => {
  const r = cli(makeProject({ bumpPolicy: { feature: 'minor', fix: 'patch', breaking: 'major', restructure: 'minor' } }), 'check');
  assert(r.status === 0, `exit ${r.status}: ${r.stdout}`);
  assert(/restructure=minor/.test(r.stdout) && /breaking=major/.test(r.stdout), r.stdout);
});

check('B3 `check` without a policy passes as before, and shows none', () => {
  const r = cli(makeProject({ defaultBump: 'patch' }), 'check');
  assert(r.status === 0, `exit ${r.status}: ${r.stdout}`);
  assert(!/bumpPolicy/.test(r.stdout), r.stdout);
});

check('B3b a calendar project without a policy still passes', () => {
  const r = cli(makeProject({ defaultBump: 'calendar' }), 'check');
  assert(r.status === 0, `exit ${r.status}: ${r.stdout}`);
});

// --- check: every malformed shape fails, naming the field, never the value --

const BAD = [
  ['a string', { bumpPolicy: MARKER }, /bumpPolicy must be an object/],
  ['an array', { bumpPolicy: [MARKER] }, /bumpPolicy must be an object/],
  ['null', { bumpPolicy: null }, /bumpPolicy must be an object/],
  ['an empty object', { bumpPolicy: {} }, /bumpPolicy\.feature is missing or malformed[^]*bumpPolicy\.fix is missing or malformed/],
  ['feature missing', { bumpPolicy: { fix: 'patch' } }, /bumpPolicy\.feature is missing or malformed/],
  ['fix missing', { bumpPolicy: { feature: 'minor' } }, /bumpPolicy\.fix is missing or malformed/],
  ['an unknown level', { bumpPolicy: { feature: MARKER, fix: 'patch' } }, /bumpPolicy\.feature is missing or malformed/],
  ['a level in capitals', { bumpPolicy: { feature: 'MINOR', fix: 'patch' } }, /bumpPolicy\.feature is missing or malformed/],
  ['a level that is not text', { bumpPolicy: { feature: 'minor', fix: ['patch', MARKER] } }, /bumpPolicy\.fix is missing or malformed/],
  ['an optional class with a bad level', { bumpPolicy: { feature: 'minor', fix: 'patch', restructure: MARKER } }, /bumpPolicy\.restructure is malformed/],
  ['an optional class with null', { bumpPolicy: { feature: 'minor', fix: 'patch', breaking: null } }, /bumpPolicy\.breaking is malformed/],
  ['an unknown class', { bumpPolicy: { feature: 'minor', fix: 'patch', [MARKER]: 'minor' } }, /bumpPolicy has a key that is not a class/],
  ['calendar as a class', { bumpPolicy: { feature: 'minor', fix: 'patch', calendar: 'minor' } }, /bumpPolicy has a key that is not a class/],
];
for (const [label, extra, expected] of BAD) {
  check(`B4 \`check\` refuses ${label}, naming the field and not the value`, () => {
    const r = cli(makeProject(extra), 'check');
    assert(r.status === 1, `exit ${r.status}: ${r.stdout}`);
    assert(expected.test(r.stdout), r.stdout);
    assert(!r.stdout.includes(MARKER) && !r.stderr.includes(MARKER), 'the value was echoed');
  });
}

check('B4b `check` refuses a __proto__ key written straight into the file', () => {
  const raw = `{"docsDir":"docs","language":"EN","tasksFile":"tasks/index.md","githubProject":null,` +
    `"bumpPolicy":{"feature":"minor","fix":"patch","__proto__":{"${MARKER}":"major"}}}`;
  const r = cli(makeProject({}, raw), 'check');
  assert(r.status === 1, `exit ${r.status}: ${r.stdout}`);
  assert(/bumpPolicy has a key that is not a class/.test(r.stdout), r.stdout);
  assert(!r.stdout.includes(MARKER), 'the value was echoed');
});

// --- calendar stays outside the policy ------------------------------------

for (const calendar of ['calendar', ' Calendar ']) {
  check(`B5 \`check\` refuses a policy next to defaultBump ${JSON.stringify(calendar)}, naming both fields`, () => {
    const r = cli(makeProject({ defaultBump: calendar, bumpPolicy: { feature: 'minor', fix: 'patch' } }), 'check');
    assert(r.status === 1, `exit ${r.status}: ${r.stdout}`);
    assert(/bumpPolicy/.test(r.stdout) && /defaultBump/.test(r.stdout), r.stdout);
  });
}

check('B5b bumpPolicyErrors: valid policy and no policy have no errors', () => {
  assert(bumpPolicyErrors(undefined).length === 0, 'undefined');
  assert(bumpPolicyErrors({ feature: 'major', fix: 'minor' }).length === 0, 'valid');
  assert(bumpPolicyErrors(undefined, 'calendar').length === 0, 'calendar without a policy');
  assert(bumpPolicyErrors({ feature: 'minor', fix: 'patch' }, 'calendar').length === 1, 'calendar with a policy');
});

// --- validated by check ONLY: the hooks and the renderer never switch off ---

const BROKEN_POLICY = { bumpPolicy: { feature: MARKER, [MARKER]: 'x' } };

check('B6 loadConfig (hooks, renderer, metrics) stays ok with a malformed policy', () => {
  for (const [, extra] of BAD) {
    const loaded = loadConfig(makeProject(extra));
    assert(loaded.ok, `not ok: ${loaded.errors.join('; ')}`);
    assert(loaded.config.bumpPolicy === undefined, 'a malformed policy reached the config');
  }
  const calendar = loadConfig(makeProject({ defaultBump: 'calendar', bumpPolicy: { feature: 'minor', fix: 'patch' } }));
  assert(calendar.ok, `calendar + policy: ${calendar.errors.join('; ')}`);
});

/** A running run in the project, for the two hooks. */
function withRunningRun(project) {
  const dir = path.join(project, '.claude', 'task-flow', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    task: 'demo', phase: 'build', status: 'running', buildCursor: 'T1', updated: '2026-11-27T10:00:00Z',
  }));
  return project;
}

check('B7 the Stop hook still holds a running run when the policy is malformed', () => {
  const project = withRunningRun(makeProject(BROKEN_POLICY));
  const r = spawnSync(process.execPath, [STOP], {
    input: JSON.stringify({ session_id: `bump-${process.pid}`, cwd: project, hook_event_name: 'Stop', last_assistant_message: 'x' }),
    encoding: 'utf8',
    env: { ...process.env, TASK_FLOW_GATE: '', CLAUDE_PROJECT_DIR: project },
  });
  assert(r.status === 2, `exit ${r.status}: ${r.stderr}`);
  assert(!r.stderr.includes(MARKER), 'the value was echoed');
});

check('B8 the SubagentStart hook still injects the standing answers when the policy is malformed', () => {
  const project = withRunningRun(makeProject(BROKEN_POLICY));
  fs.writeFileSync(path.join(project, 'docs', 'standing-answers.md'),
    '# Standing answers\n\n- **R1** · Prices are always in EUR · «sempre em euros» · demo-run · 2026-11-20\n');
  const r = spawnSync(process.execPath, [SUBAGENT_START], {
    input: JSON.stringify({ session_id: 'x', cwd: project, hook_event_name: 'SubagentStart', agent_type: 'general-purpose' }),
    encoding: 'utf8',
    env: { ...process.env, TASK_FLOW_GATE: '', CLAUDE_PROJECT_DIR: project },
  });
  assert(r.status === 0, `exit ${r.status}`);
  assert(r.stdout.includes('STANDING-ANSWERS'), `no block: ${r.stdout.slice(0, 200)}`);
  assert(!r.stdout.includes(MARKER), 'the value was echoed');
});

// --- bump-policy: writes the user's answer, and only that ------------------

check('B9 `bump-policy` writes one class and keeps every other field and class', () => {
  const project = makeProject({ defaultBump: 'patch', versionFiles: ['a.csproj'], bumpPolicy: { feature: 'minor', fix: 'patch' } });
  const r = cli(project, 'bump-policy', '--class', 'restructure', '--level', 'minor');
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  const after = readConfig(project);
  assert(JSON.stringify(after.bumpPolicy) === JSON.stringify({ feature: 'minor', fix: 'patch', restructure: 'minor' }), JSON.stringify(after.bumpPolicy));
  assert(after.defaultBump === 'patch' && after.versionFiles[0] === 'a.csproj' && after.githubProject === null && after.docsDir === 'docs',
    JSON.stringify(after));
  assert(cli(project, 'check').status === 0, 'check fails after the write');
  noTmp(project);
});

check('B10 `bump-policy` changes the level of a class already there', () => {
  const project = makeProject({ bumpPolicy: { feature: 'minor', fix: 'patch' } });
  assert(cli(project, 'bump-policy', '--class', 'feature', '--level', 'major').status === 0, 'refused');
  assert(readConfig(project).bumpPolicy.feature === 'major', JSON.stringify(readConfig(project)));
  noTmp(project);
});

check('B11 `bump-policy` writes a first policy when given feature and fix together', () => {
  const project = makeProject({ defaultBump: 'patch' });
  const r = cli(project, 'bump-policy', '--class', 'feature', '--level', 'minor', '--class', 'fix', '--level', 'patch');
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  assert(JSON.stringify(readConfig(project).bumpPolicy) === JSON.stringify({ feature: 'minor', fix: 'patch' }), JSON.stringify(readConfig(project)));
  noTmp(project);
});

/** Runs bump-policy and asserts it refused without touching the file. */
function refuses(project, args, expected) {
  const before = fs.readFileSync(configFile(project));
  const r = cli(project, 'bump-policy', ...args);
  assert(r.status !== 0, `exit ${r.status}: ${r.stdout}`);
  assert(expected.test(r.stderr), r.stderr);
  assert(!r.stderr.includes(MARKER) && !r.stdout.includes(MARKER), 'the value was echoed');
  assert(fs.readFileSync(configFile(project)).equals(before), 'the file changed');
}

const POLICY = { bumpPolicy: { feature: 'minor', fix: 'patch' } };
check('B12 `bump-policy` refuses an unknown class, untouched', () =>
  refuses(makeProject(POLICY), ['--class', MARKER, '--level', 'minor'], /--class must be one of feature, fix, breaking, restructure/));
check('B12b `bump-policy` refuses a class named like an Object property, untouched', () =>
  refuses(makeProject(POLICY), ['--class', '__proto__', '--level', 'minor'], /--class must be one of/));
check('B13 `bump-policy` refuses an unknown level, untouched', () =>
  refuses(makeProject(POLICY), ['--class', 'fix', '--level', MARKER], /--level must be one of major, minor, patch/));
check('B14 `bump-policy` refuses a class without a level, untouched', () =>
  refuses(makeProject(POLICY), ['--class', 'fix'], /--class and --level/));
check('B14b `bump-policy` refuses no pair at all, untouched', () =>
  refuses(makeProject(POLICY), [], /--class and --level/));
check('B15 `bump-policy` refuses a single class with no policy yet (feature and fix are required), untouched', () =>
  refuses(makeProject({ defaultBump: 'patch' }), ['--class', 'restructure', '--level', 'minor'], /bumpPolicy\.feature is missing/));
check('B16 `bump-policy` refuses a calendar project, untouched', () =>
  refuses(makeProject({ defaultBump: 'calendar' }), ['--class', 'feature', '--level', 'minor', '--class', 'fix', '--level', 'patch'], /defaultBump/));
check('B17 `bump-policy` refuses when the policy already there is malformed, untouched', () =>
  refuses(makeProject({ bumpPolicy: MARKER }), ['--class', 'fix', '--level', 'patch'], /bumpPolicy must be an object/));
check('B17b `bump-policy` refuses when the policy has an unknown class, untouched', () =>
  refuses(makeProject({ bumpPolicy: { feature: 'minor', fix: 'patch', [MARKER]: 'major' } }), ['--class', 'fix', '--level', 'patch'], /not a class/));
check('B18 `bump-policy` refuses a file that is not JSON, untouched', () =>
  refuses(makeProject({}, `{ "docsDir": "${MARKER}"`), ['--class', 'fix', '--level', 'patch'], /task-flow\.json/));
check('B18b `bump-policy` refuses a project that never opted in', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-bump-'));
  const r = cli(project, 'bump-policy', '--class', 'fix', '--level', 'patch');
  assert(r.status === 1 && /missing/.test(r.stderr), `exit ${r.status}: ${r.stderr}`);
  assert(!fs.existsSync(path.join(project, '.claude')), 'it created the configuration');
});

check('B19 `bump-policy` refuses to write through a linked .claude, untouched', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-bump-outside-'));
  fs.writeFileSync(path.join(outside, 'task-flow.json'), JSON.stringify({
    docsDir: 'docs', language: 'EN', tasksFile: 'tasks/index.md', bumpPolicy: { feature: 'minor', fix: 'patch' },
  }));
  const project = makeProject();
  fs.rmSync(path.join(project, '.claude'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(project, '.claude'), 'junction');
  } catch {
    process.stdout.write('  skip  (no symlink/junction permission on this machine)\n');
    return;
  }
  refuses(project, ['--class', 'fix', '--level', 'minor'], /symlink or junction/);
  assert(readConfig(project).bumpPolicy.fix === 'patch', 'the outside file changed');
});

// Security T8: the other Object-prototype name, a flag smuggled in as a level,
// and a __proto__ key already in the file reaching the merge in setBumpPolicy.
check('S1 `bump-policy` refuses `constructor` as a class, untouched', () =>
  refuses(makeProject(POLICY), ['--class', 'constructor', '--level', 'minor'], /--class must be one of/));
check('S2 `bump-policy` refuses a flag given as the level, untouched', () =>
  refuses(makeProject(POLICY), ['--class', 'fix', '--level', '--project-dir'], /--level must be one of/));
check('S3 `bump-policy` refuses a policy with a __proto__ key already in the file, untouched, no pollution', () => {
  const project = makeProject({}, `{"docsDir":"docs","language":"EN","tasksFile":"tasks/index.md",` +
    `"bumpPolicy":{"feature":"minor","fix":"patch","__proto__":{"${MARKER}":"major"}}}`);
  refuses(project, ['--class', 'fix', '--level', 'minor'], /not a class/);
  assert(({})[MARKER] === undefined, 'Object.prototype was polluted');
});

// --- the write is atomic: a failure leaves the old file whole --------------
//
// A rename that fails (an antivirus or an editor holding the file on Windows)
// or a disk that fills up mid-write must never leave a truncated or half-written
// task-flow.json behind: the error rises and the file is the one from before.

check('B20 a failed rename: the error rises, task-flow.json byte for byte, no temp file', () => {
  const project = makeProject(POLICY);
  const before = fs.readFileSync(configFile(project));
  const error = withFs('renameSync', failingRename, () => thrownBy(() => setBumpPolicy(project, { fix: 'minor' })));
  assert(error.code === 'EPERM', `another error rose: ${error.message}`);
  assert(fs.readFileSync(configFile(project)).equals(before), 'the file changed');
  noTmp(project);
});

check('B21 a disk full while writing the temp file: the error rises, task-flow.json byte for byte, no temp file', () => {
  const project = makeProject(POLICY);
  const before = fs.readFileSync(configFile(project));
  // Half the text reaches the temp file, then the disk is full: what a real
  // ENOSPC leaves, so the cleanup has something to remove.
  const fullDisk = (original, file, text, options) => {
    if (!String(file).endsWith('.tmp')) return original(file, text, options);
    original(file, String(text).slice(0, 10), options);
    throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
  };
  const error = withFs('writeFileSync', fullDisk, () => thrownBy(() => setBumpPolicy(project, { fix: 'minor' })));
  assert(error.code === 'ENOSPC', `another error rose: ${error.message}`);
  assert(fs.readFileSync(configFile(project)).equals(before), 'the file changed');
  noTmp(project);
});

console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length) process.exit(1);
