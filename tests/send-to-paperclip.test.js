#!/usr/bin/env node
// Tests for plugin/scripts/send-to-paperclip.js (SKILL.md §0d).
//
// Mostly security tests. This script reads repository data (state.json, the
// artifacts it names) and a project's own config, and sends the result to a
// third-party service over the network with a bearer token attached. The cases
// that matter most are the ones where state.json or the config tries to point
// the script somewhere it must not go - outside docsDir, or into sending a
// request with no config/token validated first - never a case that reaches the
// network, since none of these tests may depend on one being reachable.
//
// Run: node tests/send-to-paperclip.test.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const MODULE = path.join(__dirname, '..', 'plugin', 'scripts', 'send-to-paperclip.js');
const { readArtifact, findProjectItemId, flipStatus } = require(MODULE);
const { trustPaperclipUrl } = require(path.join(__dirname, '..', 'plugin', 'scripts', 'config.js'));

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

const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `taskflow-s2p-${prefix}-`));

const VALID_PAPERCLIP = {
  paperclip: { url: 'http://127.0.0.1:1', companyId: 'c1', agentId: 'a1' },
  githubProject: {
    owner: 'o', repo: 'r', projectId: 'PVT_x', statusFieldId: 'PVTSSF_x', readyOptionId: 'opt1',
  },
};

/** A project with docsDir inside it, a minimal task list, and a run directory
 *  under stateDir, with a given state.json and (by default) real spec/plan
 *  artifacts. Returns the paths the CLI needs. */
function makeRun({
  slug = 'demo',
  state,
  extraConfig = {},
  writeSpec = true,
  writePlan = true,
  specPath = 'specs/260101_demo.md',
  planPath = 'plans/260101_demo.plan.md',
  trustUrl = true,
} = {}) {
  const project = temp('project');
  const docs = path.join(project, 'docs');
  fs.mkdirSync(path.join(docs, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(docs, 'tasks', 'index.md'), '# Tasks\n');
  if (writeSpec) {
    fs.mkdirSync(path.join(docs, path.dirname(specPath)), { recursive: true });
    fs.writeFileSync(path.join(docs, specPath), '# Spec\n\nBody.\n');
  }
  if (writePlan) {
    fs.mkdirSync(path.join(docs, path.dirname(planPath)), { recursive: true });
    fs.writeFileSync(path.join(docs, planPath), '# Plan\n\n## T1 · Do it\n\nBody.\n');
  }

  const config = { docsDir: 'docs', language: 'EN', tasksFile: 'tasks/index.md', ...extraConfig };
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'task-flow.json'), JSON.stringify(config, null, 2));

  const stateDir = path.join(project, '.claude', 'task-flow', slug);
  fs.mkdirSync(stateDir, { recursive: true });
  const finalState = {
    phase: 'plan',
    status: 'running',
    artifacts: { ...(writeSpec ? { spec: specPath } : {}), ...(writePlan ? { plan: planPath } : {}) },
    ...state,
  };
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify(finalState, null, 2));

  if (trustUrl && config.paperclip && config.paperclip.url) {
    trustPaperclipUrl(project, config.paperclip.url);
  }

  return { project, docs, slug };
}

function run(project, args, env = {}) {
  return spawnSync('node', [MODULE, '--project-dir', project, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env, HOME: TEST_HOME, USERPROFILE: TEST_HOME },
  });
}

// --- readArtifact: path containment ------------------------------------------

check('readArtifact refuses a relative path that escapes docsDir', () => {
  const docs = temp('docs-escape');
  let threw = false;
  try {
    readArtifact(docs, 'spec', '../../etc/passwd');
  } catch {
    threw = true;
  }
  assert(threw, 'escaping relative path must throw, not silently resolve');
});

check('readArtifact refuses an absolute path outside docsDir', () => {
  const docs = temp('docs-abs');
  const outside = temp('outside');
  const secret = path.join(outside, 'secret.md');
  fs.writeFileSync(secret, 'top secret');
  let threw = false;
  try {
    readArtifact(docs, 'spec', secret);
  } catch {
    threw = true;
  }
  assert(threw, 'absolute path outside docsDir must throw');
});

check('readArtifact refuses a path that reads as inside docsDir but crosses a symlink to outside it', () => {
  const docs = temp('docs-link');
  const outside = temp('outside-link');
  fs.writeFileSync(path.join(outside, 'secret.md'), 'top secret via symlink');
  const linkPath = path.join(docs, 'specs');
  let canSymlink = true;
  try {
    fs.symlinkSync(outside, linkPath, 'junction');
  } catch {
    canSymlink = false;
  }
  if (!canSymlink) {
    process.stdout.write('  skip  (no symlink/junction permission on this machine)\n');
    return;
  }
  let threw = false;
  try {
    readArtifact(docs, 'spec', 'specs/secret.md');
  } catch {
    threw = true;
  }
  assert(threw, 'a path that textually resolves inside docsDir but crosses a symlink to outside it must throw');
});

check('readArtifact accepts a path that resolves inside docsDir', () => {
  const docs = temp('docs-ok');
  fs.mkdirSync(path.join(docs, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(docs, 'specs', 'a.md'), 'hello');
  const body = readArtifact(docs, 'spec', 'specs/a.md');
  assert(body === 'hello', 'a legitimate in-folder path must be read');
});

check('readArtifact returns null for a missing file, never throws', () => {
  const docs = temp('docs-missing');
  const body = readArtifact(docs, 'spec', 'specs/nope.md');
  assert(body === null, 'a missing artifact is null, not an error - callers decide if it is required');
});

// --- findProjectItemId/flipStatus: every value validated before `gh` sees it -

check('findProjectItemId refuses an owner value that is not a valid GitHub name', () => {
  let threw = false;
  try {
    findProjectItemId({ owner: '@evil', repo: 'r', issueNumber: '1', projectId: 'PVT_x' });
  } catch {
    threw = true;
  }
  assert(threw, 'an owner starting with @ (gh\'s @file syntax on some versions) must never reach `gh`');
});

check('findProjectItemId refuses a repo value that is not a valid GitHub name', () => {
  let threw = false;
  try {
    findProjectItemId({ owner: 'o', repo: '../../etc/passwd', issueNumber: '1', projectId: 'PVT_x' });
  } catch {
    threw = true;
  }
  assert(threw, 'a path-shaped repo value must never reach `gh`');
});

check('findProjectItemId refuses a non-numeric issue number', () => {
  let threw = false;
  try {
    findProjectItemId({ owner: 'o', repo: 'r', issueNumber: '1 && rm -rf /', projectId: 'PVT_x' });
  } catch {
    threw = true;
  }
  assert(threw, 'a shell-metacharacter-bearing issue number must never reach `gh`, even via execFileSync argv');
});

check('flipStatus refuses an invalid field or option id', () => {
  let threw = false;
  try {
    flipStatus({ projectId: 'PVT_x', itemId: 'ITEM_x', fieldId: '@secrets.txt', optionId: 'opt1' });
  } catch {
    threw = true;
  }
  assert(threw, 'an @-prefixed field id must never reach `gh`');
});

// --- CLI: validation stops before any network call ---------------------------

check('rejects a slug with path-traversal characters', () => {
  const { project } = makeRun({ slug: 'demo' });
  const result = run(project, ['--slug', '../evil', '--github-issue', '1']);
  assert(result.status !== 0, 'must exit non-zero');
  assert(/safe name/.test(result.stderr), `expected a safe-name complaint, got: ${result.stderr}`);
});

check('rejects a non-numeric github issue', () => {
  const { project } = makeRun({ slug: 'demo' });
  const result = run(project, ['--slug', 'demo', '--github-issue', '1; rm -rf /']);
  assert(result.status !== 0, 'must exit non-zero');
  assert(/positive integer/.test(result.stderr), `expected an issue-number complaint, got: ${result.stderr}`);
});

check('stops when .claude/task-flow.json has no paperclip config at all', () => {
  const { project } = makeRun({ slug: 'demo' });
  const result = run(project, ['--slug', 'demo', '--github-issue', '1']);
  assert(result.status !== 0, 'must exit non-zero');
  assert(/paperclip\./.test(result.stderr), `expected a missing-field complaint, got: ${result.stderr}`);
});

check('stops when githubProject config is missing a field', () => {
  const { project } = makeRun({
    slug: 'demo',
    extraConfig: {
      paperclip: VALID_PAPERCLIP.paperclip,
      githubProject: { ...VALID_PAPERCLIP.githubProject, readyOptionId: undefined },
    },
  });
  const result = run(project, ['--slug', 'demo', '--github-issue', '1']);
  assert(result.status !== 0, 'must exit non-zero');
  assert(/githubProject\.readyOptionId/.test(result.stderr), `expected the specific missing field named, got: ${result.stderr}`);
});

check('stops when paperclip.url is not trusted on this machine yet', () => {
  const { project } = makeRun({ slug: 'demo', extraConfig: VALID_PAPERCLIP, trustUrl: false });
  const result = run(project, ['--slug', 'demo', '--github-issue', '1'], { PAPERCLIP_TOKEN: 'x' });
  assert(result.status !== 0, 'must exit non-zero');
  assert(/not trusted on this machine/.test(result.stderr), `expected a not-trusted complaint, got: ${result.stderr}`);
  assert(/trust-paperclip/.test(result.stderr), `expected the fix command named, got: ${result.stderr}`);
});

check('a committed paperclip.url pointing somewhere else than what was trusted is still refused', () => {
  const { project } = makeRun({ slug: 'demo', extraConfig: VALID_PAPERCLIP }); // trusts VALID_PAPERCLIP.paperclip.url
  const statePath = path.join(project, '.claude', 'task-flow.json');
  const config = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  config.paperclip.url = 'http://attacker.example:9/'; // never trusted for this project
  fs.writeFileSync(statePath, JSON.stringify(config, null, 2));
  const result = run(project, ['--slug', 'demo', '--github-issue', '1'], { PAPERCLIP_TOKEN: 'x' });
  assert(result.status !== 0, 'must exit non-zero');
  assert(/not trusted on this machine/.test(result.stderr), `expected a not-trusted complaint, got: ${result.stderr}`);
});

check('stops when the token env var is not set', () => {
  const { project } = makeRun({ slug: 'demo', extraConfig: VALID_PAPERCLIP });
  const result = run(project, ['--slug', 'demo', '--github-issue', '1'], { PAPERCLIP_TOKEN: '' });
  assert(result.status !== 0, 'must exit non-zero');
  assert(/PAPERCLIP_TOKEN/.test(result.stderr), `expected the env var name, got: ${result.stderr}`);
  assert(!/Bearer/.test(result.stderr), 'must never print a token or an Authorization header value');
});

check('config cannot choose which environment variable the token comes from', () => {
  // Even if a committed config tried to name a different variable, the
  // script only ever reads PAPERCLIP_TOKEN - there is no field left for it
  // to redirect. A run with an unrelated "valuable" secret present but no
  // PAPERCLIP_TOKEN must still fail, and must never read the other one.
  const { project } = makeRun({ slug: 'demo', extraConfig: VALID_PAPERCLIP });
  const result = run(project, ['--slug', 'demo', '--github-issue', '1'], {
    PAPERCLIP_TOKEN: '',
    SOME_OTHER_VALUABLE_SECRET: 'do-not-send-this-anywhere',
  });
  assert(result.status !== 0, 'must exit non-zero');
  assert(!result.stdout.includes('do-not-send-this-anywhere') && !result.stderr.includes('do-not-send-this-anywhere'),
    'an unrelated secret in the environment must never be read or echoed');
});

check('never leaks a configured token into stdout or stderr, even on a later failure', () => {
  const { project } = makeRun({
    slug: 'demo',
    extraConfig: {
      paperclip: { ...VALID_PAPERCLIP.paperclip, url: 'http://127.0.0.1:1' },
      githubProject: VALID_PAPERCLIP.githubProject,
    },
  });
  const secretToken = 'super-secret-token-value';
  const result = run(project, ['--slug', 'demo', '--github-issue', '1'], { PAPERCLIP_TOKEN: secretToken });
  assert(!result.stdout.includes(secretToken), 'token must never appear in stdout');
  assert(!result.stderr.includes(secretToken), 'token must never appear in stderr');
});

check('stops when the run is not at phase "plan"', () => {
  const { project } = makeRun({ slug: 'demo', state: { phase: 'build' }, extraConfig: VALID_PAPERCLIP });
  const result = run(project, ['--slug', 'demo', '--github-issue', '1'], { PAPERCLIP_TOKEN: 'x' });
  assert(result.status !== 0, 'must exit non-zero');
  assert(/phase "build", not "plan"/.test(result.stderr), `expected a phase complaint, got: ${result.stderr}`);
});

check('stops when the run has no plan artifact', () => {
  const { project } = makeRun({ slug: 'demo', writePlan: false, extraConfig: VALID_PAPERCLIP });
  const result = run(project, ['--slug', 'demo', '--github-issue', '1'], { PAPERCLIP_TOKEN: 'x' });
  assert(result.status !== 0, 'must exit non-zero');
  assert(/no plan artifact/.test(result.stderr), `expected a missing-plan complaint, got: ${result.stderr}`);
});

check('stops when state.json.artifacts.plan escapes docsDir, never reads it', () => {
  const { project, docs } = makeRun({ slug: 'demo', writePlan: false, extraConfig: VALID_PAPERCLIP });
  const outsideSecret = path.join(temp('outside-plan'), 'leak.md');
  fs.writeFileSync(outsideSecret, 'SHOULD NEVER BE SENT ANYWHERE');
  const statePath = path.join(project, '.claude', 'task-flow', 'demo', 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.artifacts.plan = outsideSecret;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  const result = run(project, ['--slug', 'demo', '--github-issue', '1'], { PAPERCLIP_TOKEN: 'x' });
  assert(result.status !== 0, 'must exit non-zero');
  assert(/escapes docsDir/.test(result.stderr), `expected an escape complaint, got: ${result.stderr}`);
  assert(!result.stdout.includes('SHOULD NEVER BE SENT') && !result.stderr.includes('SHOULD NEVER BE SENT'),
    'the escaping file\'s contents must never be read or echoed');
  void docs;
});

check('rejects a missing required flag instead of defaulting it', () => {
  const { project } = makeRun({ slug: 'demo', extraConfig: VALID_PAPERCLIP });
  const result = run(project, ['--github-issue', '1'], { PAPERCLIP_TOKEN: 'x' });
  assert(result.status !== 0, 'must exit non-zero without --slug');
});

// --- summary -----------------------------------------------------------------

// readArtifact's own fail() sets process.exitCode as a side effect when called
// directly (in-process, not spawned) above; it must not leak into this file's
// own exit code once every check has actually passed.
process.exitCode = failures.length ? 1 : 0;
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
