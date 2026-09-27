#!/usr/bin/env node
// Tests for plugin/scripts/config.js - the reader of .claude/task-flow.json.
//
// Half of these are security tests. The file is repository data: whoever can push
// to a repository writes it, and the hooks read it on every turn. The cases that
// matter most are the ones where a value tries to point the pipeline somewhere it
// was never meant to go - out of the docs folder, out of the project, or to a path
// that only exists because a variable expanded to nothing.
//
// Run: node tests/config.test.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE = path.join(__dirname, '..', 'plugin', 'scripts', 'config.js');
const {
  expandEnv,
  initConfig,
  loadConfig,
  normalizeLanguage,
  pageLanguage,
  stateDirOf,
} = require(MODULE);

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

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `taskflow-config-${prefix}-`));

/** A project with a docs folder outside it, a task list in it, and a config. */
function makeProject(config, { createDocs = true, createTasks = true } = {}) {
  const project = temp('project');
  const docs = temp('docs');
  if (!createDocs) fs.rmSync(docs, { recursive: true, force: true });
  if (createDocs && createTasks) {
    fs.mkdirSync(path.join(docs, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(docs, 'tasks', 'index.md'), '# Tasks\n');
  }
  if (config !== null) {
    const body = typeof config === 'function' ? config(docs) : config;
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.claude', 'task-flow.json'),
      typeof body === 'string' ? body : JSON.stringify(body)
    );
  }
  return { project, docs };
}

const valid = (docs) => ({ docsDir: docs, language: 'EN', tasksFile: 'tasks/index.md' });

console.log('config.js');

// --- the happy path ----------------------------------------------------------

check('C1 a complete configuration is valid and resolved', () => {
  const { project, docs } = makeProject(valid);
  const outcome = loadConfig(project);
  assert(outcome.ok, `expected ok, got ${outcome.errors.join('; ')}`);
  assertEqual(outcome.config.docsDir, path.resolve(docs), 'docsDir');
  assertEqual(outcome.config.tasksFile, path.join(path.resolve(docs), 'tasks', 'index.md'), 'tasksFile');
  assertEqual(outcome.config.language, 'en', 'language');
  assertEqual(outcome.config.stateDir, path.join(project, '.claude', 'task-flow'), 'default stateDir');
});

check('C2 a task list named without an extension is the .md file', () => {
  const { project, docs } = makeProject((d) => ({ docsDir: d, language: 'EN', tasksFile: 'tasks/index' }));
  const outcome = loadConfig(project);
  assert(outcome.ok, outcome.errors.join('; '));
  assertEqual(outcome.config.tasksFile, path.join(path.resolve(docs), 'tasks', 'index.md'), 'tasksFile');
});

check('C3 PT-PT is normalised to pt-PT and gets Portuguese pages', () => {
  const { project } = makeProject((d) => ({ ...valid(d), language: 'PT-PT' }));
  const outcome = loadConfig(project);
  assert(outcome.ok, outcome.errors.join('; '));
  assertEqual(outcome.config.language, 'pt-PT', 'language');
  assertEqual(outcome.config.pageLanguage, 'pt-PT', 'pageLanguage');
});

check('C4 a language with no page table writes documents in it and pages in English', () => {
  const { project } = makeProject((d) => ({ ...valid(d), language: 'fr' }));
  const outcome = loadConfig(project);
  assert(outcome.ok, outcome.errors.join('; '));
  assertEqual(outcome.config.language, 'fr', 'language');
  assertEqual(outcome.config.pageLanguage, 'en', 'pageLanguage');
  assertEqual(pageLanguage('pt-BR'), 'en', 'pt-BR is not guessed as pt-PT');
});

check('C5 a docsDir inside the project may be relative', () => {
  const project = temp('relative');
  fs.mkdirSync(path.join(project, 'docs', 'task-flow', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(project, 'docs', 'task-flow', 'tasks', 'index.md'), '# Tasks\n');
  fs.mkdirSync(path.join(project, '.claude'));
  fs.writeFileSync(
    path.join(project, '.claude', 'task-flow.json'),
    JSON.stringify({ docsDir: 'docs/task-flow', language: 'EN', tasksFile: 'tasks/index.md' })
  );
  const outcome = loadConfig(project);
  assert(outcome.ok, outcome.errors.join('; '));
  assertEqual(outcome.config.docsDir, path.join(project, 'docs', 'task-flow'), 'docsDir');
});

check('C6 %VAR% and ${VAR} expand from the environment', () => {
  const docs = temp('env');
  const env = { TF_TEST_DOCS: docs };
  assertEqual(expandEnv('%TF_TEST_DOCS%/x', env), `${docs}/x`, '%VAR%');
  assertEqual(expandEnv('${TF_TEST_DOCS}/x', env), `${docs}/x`, '${VAR}');
});

check('C7 a leading ~ is the home folder', () => {
  assertEqual(expandEnv('~/notes', {}), `${os.homedir()}/notes`, '~');
});

// --- the three required fields: missing means "do not start" ----------------

check('C8 no configuration file: not opted in, not ok', () => {
  const { project } = makeProject(null);
  const outcome = loadConfig(project);
  assert(!outcome.exists, 'exists');
  assert(!outcome.ok, 'ok');
});

for (const field of ['docsDir', 'language', 'tasksFile']) {
  check(`C9 missing ${field} is an error that names it`, () => {
    const { project } = makeProject((d) => {
      const body = valid(d);
      delete body[field];
      return body;
    });
    const outcome = loadConfig(project);
    assert(!outcome.ok, 'ok');
    assert(outcome.errors.some((line) => line.startsWith(field)), outcome.errors.join('; '));
  });
}

check('C10 a docsDir that does not exist is not ok', () => {
  const { project } = makeProject((d) => valid(d), { createDocs: false });
  const outcome = loadConfig(project);
  assert(!outcome.ok, 'ok');
  assert(outcome.errors.some((line) => line.startsWith('docsDir')), outcome.errors.join('; '));
});

check('C11 a task list that does not exist is not ok', () => {
  const { project } = makeProject((d) => valid(d), { createTasks: false });
  const outcome = loadConfig(project);
  assert(!outcome.ok, 'ok');
  assert(outcome.errors.some((line) => line.startsWith('tasksFile')), outcome.errors.join('; '));
});

check('C12 a language that is not a tag is refused', () => {
  for (const bad of ['english', 'pt_PT', 'EN; rm -rf /', '', 'e', 42]) {
    assertEqual(normalizeLanguage(bad), null, `normalizeLanguage(${JSON.stringify(bad)})`);
  }
  const { project } = makeProject((d) => ({ ...valid(d), language: 'Portuguese please' }));
  assert(!loadConfig(project).ok, 'ok');
});

// --- security: values that try to go somewhere else ---------------------------

check('C13 SECURITY a task list climbing out of docsDir is refused', () => {
  for (const escape of ['../outside.md', 'tasks/../../outside.md', '..\\outside.md']) {
    const { project } = makeProject((d) => ({ ...valid(d), tasksFile: escape }));
    const outcome = loadConfig(project, { requireExisting: false });
    assert(!outcome.ok, `${escape} accepted`);
    assert(outcome.errors.some((line) => line.startsWith('tasksFile')), outcome.errors.join('; '));
  }
});

check('C14 SECURITY an absolute task list is refused even when it exists', () => {
  const elsewhere = path.join(temp('abs'), 'index.md');
  fs.writeFileSync(elsewhere, '# elsewhere\n');
  const { project } = makeProject((d) => ({ ...valid(d), tasksFile: elsewhere }));
  const outcome = loadConfig(project);
  assert(!outcome.ok, 'accepted an absolute tasksFile');
});

check('C15 SECURITY the task list must name a file, not docsDir or a folder', () => {
  for (const folder of ['.', '..', 'tasks/', 'tasks\\', 'tasks/..']) {
    const { project } = makeProject((d) => ({ ...valid(d), tasksFile: folder }));
    assert(!loadConfig(project, { requireExisting: false }).ok, `accepted ${JSON.stringify(folder)}`);
  }
});

check('C16 SECURITY an undefined variable never expands to empty', () => {
  let threw = false;
  try {
    expandEnv('%TF_SURELY_NOT_DEFINED_12345%/docs', {});
  } catch {
    threw = true;
  }
  assert(threw, 'undefined %VAR% expanded');
  threw = false;
  try {
    expandEnv('${TF_SURELY_NOT_DEFINED_12345}/docs', {});
  } catch {
    threw = true;
  }
  assert(threw, 'undefined ${VAR} expanded');
  const { project } = makeProject({ docsDir: '%TF_SURELY_NOT_DEFINED_12345%/docs', language: 'EN', tasksFile: 'x.md' });
  const outcome = loadConfig(project, { env: {} });
  assert(!outcome.ok, 'ok');
  assert(outcome.errors.some((line) => line.includes('not defined')), outcome.errors.join('; '));
});

check('C17 SECURITY a variable name with path syntax is refused', () => {
  let threw = false;
  try {
    expandEnv('%../../etc%/x', { '../../etc': '/tmp' });
  } catch {
    threw = true;
  }
  assert(threw, 'accepted a variable name with path syntax');
});

check('C18 SECURITY the root of a drive is refused as docsDir', () => {
  const root = path.parse(process.cwd()).root;
  const { project } = makeProject({ docsDir: root, language: 'EN', tasksFile: 'x.md' });
  const outcome = loadConfig(project, { requireExisting: false });
  assert(!outcome.ok, 'accepted a drive root');
});

check('C19 SECURITY a stateDir outside the project, or the project itself, is refused', () => {
  for (const stateDir of ['..', '.', '../elsewhere', path.parse(process.cwd()).root]) {
    const { project } = makeProject((d) => ({ ...valid(d), stateDir }));
    const outcome = loadConfig(project);
    assert(!outcome.ok, `stateDir ${stateDir} accepted`);
    let threw = false;
    try {
      stateDirOf(project);
    } catch {
      threw = true;
    }
    assert(threw, `stateDirOf accepted ${stateDir}`);
  }
});

check('C20 SECURITY invalid JSON, or JSON that is not an object, is an error and never throws', () => {
  for (const body of ['{ not json', 'null', '[1,2]', '"text"']) {
    const { project } = makeProject(body);
    const outcome = loadConfig(project);
    assert(outcome.exists && !outcome.ok, `accepted ${body}`);
  }
});

check('C21 SECURITY a backlogFile climbing out of docsDir is refused', () => {
  const { project } = makeProject((d) => ({ ...valid(d), backlogFile: '../../backlog.md' }));
  const outcome = loadConfig(project);
  assert(!outcome.ok, 'accepted');
  assert(outcome.errors.some((line) => line.startsWith('backlogFile')), outcome.errors.join('; '));
});

check('C22 a UTF-8 BOM at the top of the file is tolerated', () => {
  const { project } = makeProject((d) => '﻿' + JSON.stringify(valid(d)));
  assert(loadConfig(project).ok, 'BOM rejected');
});

// --- init --------------------------------------------------------------------

check('C23 init writes the three fields and keeps every other field', () => {
  const project = temp('init');
  const docs = temp('init-docs');
  fs.mkdirSync(path.join(project, '.claude'));
  fs.writeFileSync(path.join(project, '.claude', 'task-flow.json'), JSON.stringify({ defaultBump: 'patch' }));
  const outcome = initConfig(project, { docsDir: docs, language: 'PT-PT', tasksFile: 'tasks/index' });
  assert(outcome.ok, outcome.errors.join('; '));
  const written = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'task-flow.json'), 'utf8'));
  assertEqual(written.defaultBump, 'patch', 'kept field');
  assertEqual(written.language, 'PT-PT', 'language as written');
  assert(fs.existsSync(path.join(docs, 'tasks', 'index.md')), 'empty task list created');
});

check('C24 init never overwrites an existing task list', () => {
  const project = temp('init2');
  const docs = temp('init2-docs');
  fs.mkdirSync(path.join(docs, 'backlog'));
  fs.writeFileSync(path.join(docs, 'backlog', 'index.md'), '| task | state |\n');
  initConfig(project, { docsDir: docs, language: 'EN', tasksFile: 'backlog/index.md' });
  assertEqual(fs.readFileSync(path.join(docs, 'backlog', 'index.md'), 'utf8'), '| task | state |\n', 'task list');
});

check('C25 init creates a docsDir inside the project', () => {
  const project = temp('init3');
  const outcome = initConfig(project, { docsDir: 'docs/task-flow', language: 'EN', tasksFile: 'tasks/index.md' });
  assert(outcome.ok, outcome.errors.join('; '));
  assert(fs.existsSync(path.join(project, 'docs', 'task-flow', 'tasks', 'index.md')), 'created');
});

check('C26 SECURITY init never creates a folder outside the project', () => {
  const project = temp('init4');
  const outside = path.join(temp('init4-parent'), 'typo', 'folder');
  let threw = false;
  try {
    initConfig(project, { docsDir: outside, language: 'EN', tasksFile: 'tasks/index.md' });
  } catch {
    threw = true;
  }
  assert(threw, 'init accepted a missing outside folder');
  assert(!fs.existsSync(outside), 'the outside folder was created');
});

check('C27 SECURITY init refuses a task list outside docsDir and writes nothing', () => {
  const project = temp('init5');
  const docs = temp('init5-docs');
  let threw = false;
  try {
    initConfig(project, { docsDir: docs, language: 'EN', tasksFile: '../escape.md' });
  } catch {
    threw = true;
  }
  assert(threw, 'accepted');
  assert(!fs.existsSync(path.join(path.dirname(docs), 'escape.md')), 'wrote outside');
  assert(!fs.existsSync(path.join(project, '.claude', 'task-flow.json')), 'wrote the config anyway');
});

// --- CLI -----------------------------------------------------------------------

check('C28 `check` exits 1 and says it must not start when a field is missing', () => {
  const { project } = makeProject((d) => ({ docsDir: d, language: 'EN' }));
  const run = spawnSync(process.execPath, [MODULE, 'check', '--project-dir', project], { encoding: 'utf8' });
  assertEqual(run.status, 1, 'exit code');
  assert(/must not start/.test(run.stdout), run.stdout);
  assert(/tasksFile/.test(run.stdout), run.stdout);
});

check('C29 `check` exits 0 on a valid configuration', () => {
  const { project } = makeProject(valid);
  const run = spawnSync(process.execPath, [MODULE, 'check', '--project-dir', project], { encoding: 'utf8' });
  assertEqual(run.status, 0, `exit code (${run.stdout})`);
});

check('C30 `check` exits 1 when the project never opted in', () => {
  const { project } = makeProject(null);
  const run = spawnSync(process.execPath, [MODULE, 'check', '--project-dir', project], { encoding: 'utf8' });
  assertEqual(run.status, 1, 'exit code');
});

console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length) process.exit(1);
