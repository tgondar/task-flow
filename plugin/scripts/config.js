#!/usr/bin/env node
// The one reader of a project's .claude/task-flow.json.
//
// Why a module and not prose. The skill must not start in a repository that has
// not declared where its documentation lives, which language to write it in and
// where its task list is. A rule written only in SKILL.md is a rule an agent can
// talk itself past; `node config.js check` exits 1 and the skill stops on it.
// The hooks and the renderer read the same file through the same function, so
// there is exactly one definition of "a valid configuration".
//
// The file is repository data. Anyone who can push to a repository can write it,
// and the hooks run on every turn of every session in it. So every path in it is
// an INPUT: resolved, contained and checked here, never trusted.
//
// That includes docsDir. The hooks write and delete run pages under it on every
// turn, so a docsDir outside the project is only followed once the person has
// trusted it on this machine (a list kept in their home folder, which no
// repository writes), and a network or device path is never followed at all.
//
//   node config.js check [--project-dir <dir>]
//   node config.js init  --docs-dir <dir> --tasks-file <file> [--language <tag>] [--project-dir <dir>]
//   node config.js trust [--project-dir <dir>]

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_FILE = path.join('.claude', 'task-flow.json');
const DEFAULT_STATE_DIR = '.claude/task-flow';
const DEFAULT_LANGUAGE = 'EN';

/** The languages the generated pages are written in. Any other valid tag is
 *  accepted: the agent writes the documents in it, and the pages fall back to
 *  English. */
const PAGE_LANGUAGES = ['en', 'pt-PT'];

// --- small helpers ---------------------------------------------------------

const configPath = (projectDir) => path.join(projectDir, CONFIG_FILE);

const isDirectory = (candidate) => {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (candidate) => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

/** True when `candidate` is `root` or sits below it. Compared case-insensitively
 *  on Windows, where `C:\Docs` and `c:\docs` are the same folder. */
function isInside(root, candidate) {
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const base = fold(path.resolve(root));
  const target = fold(path.resolve(candidate));
  return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

/** `\\host\share`, `//host/share`, `\\?\C:\x`, `\\.\device`. Merely stat-ing one of
 *  these makes Windows contact the host, and offer it the user's credentials. */
const isNetworkOrDevicePath = (value) => /^[\\/]{2}/.test(String(value));

/** Looks a variable up the way the OS does: case-insensitively on Windows. */
function lookupEnv(env, name) {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  if (process.platform !== 'win32') return undefined;
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Expands `%NAME%`, `${NAME}` and a leading `~`.
 *
 *  An undefined variable is an error, never an empty string: `%DOCS%/notes`
 *  expanded to `/notes` would be an absolute path somewhere nobody chose, and
 *  expanded to `notes` would silently become a folder inside the repository. */
function expandEnv(value, env = process.env) {
  if (typeof value !== 'string') throw new Error('is not a string');
  let text = value.trim();
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) {
    text = os.homedir() + text.slice(1);
  }
  const replace = (whole, name) => {
    if (!ENV_NAME.test(name)) throw new Error(`${whole} is not a variable name`);
    const found = lookupEnv(env, name);
    if (found === undefined || found === '') throw new Error(`${whole} is not defined on this machine`);
    return found;
  };
  return text.replace(/%([^%]+)%/g, replace).replace(/\$\{([^}]+)\}/g, replace);
}

/** `EN` -> `en`, `pt-pt` -> `pt-PT`, `zh-hant-tw` -> `zh-Hant-TW`. Returns null for
 *  anything that is not a language tag: the value ends up in prompts and file
 *  headers, so it is a closed shape, not free text. */
function normalizeLanguage(value) {
  if (typeof value !== 'string') return null;
  const match = /^([A-Za-z]{2,3})(?:-([A-Za-z]{4}))?(?:-([A-Za-z]{2}|\d{3}))?$/.exec(value.trim());
  if (!match) return null;
  const [, language, script, region] = match;
  let tag = language.toLowerCase();
  if (script) tag += `-${script[0].toUpperCase()}${script.slice(1).toLowerCase()}`;
  if (region) tag += `-${region.toUpperCase()}`;
  return tag;
}

/** The page language for a document language: an exact match or English. `pt-BR`
 *  gets English, not European Portuguese - guessing a regional variant is worse
 *  than the neutral default. */
function pageLanguage(tag) {
  return PAGE_LANGUAGES.includes(tag) ? tag : 'en';
}

// --- reading ---------------------------------------------------------------

/** The file as written, or why it could not be read. Never throws. */
function readRaw(projectDir) {
  const file = configPath(projectDir);
  if (!isFile(file)) return { exists: false, file };
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const raw = JSON.parse(text);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { exists: true, file, error: 'does not hold a JSON object' };
    }
    return { exists: true, file, raw };
  } catch (error) {
    return { exists: true, file, error: `is not valid JSON (${error.message})` };
  }
}

/** Resolves the base documentation directory. Relative values are relative to the
 *  project; everything else must be absolute after expansion. */
function resolveDocsDir(value, projectDir, env) {
  const network = () => new Error('is a network or device path, which is never followed');
  if (isNetworkOrDevicePath(String(value).trim())) throw network();
  const expanded = expandEnv(value, env);
  if (!expanded) throw new Error('is empty');
  if (isNetworkOrDevicePath(expanded)) throw network();
  const resolved = path.resolve(projectDir, expanded);
  if (isNetworkOrDevicePath(resolved)) throw network();
  if (path.parse(resolved).root === resolved) throw new Error(`is the root of a drive (${resolved})`);
  return resolved;
}

/** Resolves the task list, which must sit inside the documentation directory: the
 *  skill writes to it, and a repository must not be able to point that write at a
 *  file of its choosing elsewhere on the machine. A value with no extension gets
 *  `.md`, so `tasks/index` and `tasks/index.md` name the same file. */
function resolveTasksFile(value, docsDir) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('is empty');
  const trimmed = value.trim();
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
    throw new Error('must be relative to docsDir, not absolute');
  }
  const base = path.basename(trimmed.replace(/[\\/]+$/, ''));
  if (/[\\/]$/.test(trimmed) || base === '.' || base === '..' || base === '') {
    throw new Error(`must name a file, not a folder (${trimmed})`);
  }
  const withExtension = path.extname(trimmed) ? trimmed : `${trimmed}.md`;
  const resolved = path.resolve(docsDir, withExtension);
  if (!isInside(docsDir, resolved) || resolved === path.resolve(docsDir)) {
    throw new Error(`leaves docsDir (${withExtension})`);
  }
  return resolved;
}

/** Resolves where the runs' state lives. It must be a real subfolder of the
 *  project: the gate lets writes there through without approval, so `.` or `..`
 *  would turn the whole disk into bookkeeping. */
function resolveStateDir(value, projectDir) {
  const setting = value === undefined ? DEFAULT_STATE_DIR : value;
  if (typeof setting !== 'string' || !setting.trim()) throw new Error('is empty');
  const resolved = path.resolve(projectDir, setting.trim());
  if (!isInside(projectDir, resolved) || path.resolve(projectDir) === resolved) {
    throw new Error(`is not a folder inside the project (${setting})`);
  }
  return resolved;
}

// --- trusting a docsDir outside the project ---------------------------------
//
// A repository can commit any docsDir it likes. Inside the project that is the
// repository's own business; outside it, it is the person's disk. So an outside
// docsDir counts only when this machine's list pairs it with this project - the
// pair, not the project alone, so a repository that later points docsDir
// somewhere else has to be trusted again.

/** Resolved on every call, never cached: the list lives in the person's home. */
const trustFile = () => path.join(os.homedir(), '.claude', 'task-flow-trusted.json');

const samePath = (a, b) => {
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  return fold(path.resolve(a)) === fold(path.resolve(b));
};

/** The trusted pairs. An unreadable list trusts nothing. */
function readTrusted() {
  try {
    const parsed = JSON.parse(fs.readFileSync(trustFile(), 'utf8').replace(/^﻿/, ''));
    return Array.isArray(parsed && parsed.trusted) ? parsed.trusted : [];
  } catch {
    return [];
  }
}

function isTrusted(projectDir, docsDir) {
  return readTrusted().some(
    (entry) =>
      entry && typeof entry.project === 'string' && typeof entry.docsDir === 'string' &&
      samePath(entry.project, projectDir) && samePath(entry.docsDir, docsDir)
  );
}

/** Adds the pair to the list. Refuses to overwrite a list it cannot read, rather
 *  than silently dropping the pairs already in it. */
function trustDocsDir(projectDir, docsDir) {
  const file = trustFile();
  let current = { trusted: [] };
  if (isFile(file)) {
    try {
      current = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch (error) {
      throw new Error(`${file} is not valid JSON (${error.message}); fix or remove it first`);
    }
    if (!current || typeof current !== 'object' || !Array.isArray(current.trusted)) {
      throw new Error(`${file} does not hold a "trusted" list; fix or remove it first`);
    }
  }
  if (!isTrusted(projectDir, docsDir)) {
    current.trusted.push({ project: path.resolve(projectDir), docsDir: path.resolve(docsDir) });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
  }
  return file;
}

/**
 * The configuration of a project, validated.
 *
 * Returns `{ exists, file, ok, errors, config }`. `exists` false means the project
 * never opted in, which the hooks treat as "none of our business". `ok` false with
 * `exists` true means it opted in and the file is wrong; `errors` says how, one
 * line per field, in terms a person can act on.
 *
 * `requireExisting` (default true) also checks that docsDir and tasksFile exist;
 * `init` turns it off because creating them is its job.
 */
function loadConfig(projectDir, { env = process.env, requireExisting = true } = {}) {
  const read = readRaw(projectDir);
  const result = { exists: read.exists, file: read.file, ok: false, errors: [], config: null };
  if (!read.exists) {
    result.errors.push(`${CONFIG_FILE} is missing`);
    return result;
  }
  if (read.error) {
    result.errors.push(`${CONFIG_FILE} ${read.error}`);
    return result;
  }

  const raw = read.raw;
  const config = { raw };
  const fail = (field, message) => result.errors.push(`${field} ${message}`);

  if (raw.docsDir === undefined) fail('docsDir', 'is required: the base folder for specs, plans, questions and run pages');
  else {
    try {
      const docsDir = resolveDocsDir(raw.docsDir, projectDir, env);
      if (!isInside(projectDir, docsDir) && !isTrusted(projectDir, docsDir)) {
        // Decided before anything touches the folder: an untrusted path is not even stat-ed.
        fail('docsDir', `is outside the project and not trusted on this machine (${docsDir}); ` +
          'confirm the folder with the person, then run: config.js trust');
      } else {
        config.docsDir = docsDir;
        if (requireExisting && !isDirectory(config.docsDir)) fail('docsDir', `does not exist (${config.docsDir})`);
      }
    } catch (error) {
      fail('docsDir', error.message);
    }
  }

  if (raw.language === undefined) fail('language', `is required: the language documents are written in (for example ${DEFAULT_LANGUAGE} or PT-PT)`);
  else {
    const language = normalizeLanguage(raw.language);
    if (!language) fail('language', `is not a language tag (${JSON.stringify(raw.language)}); use for example EN or PT-PT`);
    else {
      config.language = language;
      config.pageLanguage = pageLanguage(language);
    }
  }

  if (raw.tasksFile === undefined) fail('tasksFile', 'is required: the task list, relative to docsDir (for example tasks/index.md)');
  else if (config.docsDir) {
    try {
      config.tasksFile = resolveTasksFile(raw.tasksFile, config.docsDir);
      if (requireExisting && !isFile(config.tasksFile)) fail('tasksFile', `does not exist (${config.tasksFile})`);
    } catch (error) {
      fail('tasksFile', error.message);
    }
  }

  try {
    config.stateDir = resolveStateDir(raw.stateDir, projectDir);
  } catch (error) {
    fail('stateDir', error.message);
  }

  if (raw.backlogFile !== undefined && config.docsDir) {
    try {
      config.backlogFile = resolveTasksFile(raw.backlogFile, config.docsDir);
    } catch (error) {
      fail('backlogFile', error.message);
    }
  }

  result.ok = result.errors.length === 0;
  result.config = config;
  return result;
}

/** Where the runs' state lives, for the hooks: they must work even when the three
 *  required fields are wrong, because a broken docsDir is no reason to let
 *  unapproved code through. Returns null when the project never opted in. Throws
 *  when it opted in and the location cannot be established. */
function stateDirOf(projectDir) {
  const read = readRaw(projectDir);
  if (!read.exists) return null;
  if (read.error) throw new Error(`${CONFIG_FILE} ${read.error}`);
  return resolveStateDir(read.raw.stateDir, projectDir);
}

// --- writing (init) --------------------------------------------------------

/**
 * Writes the three required fields, keeping every other field already in the file.
 * Creates docsDir only when it is inside the project (the default layout for a
 * repository with no external notes); an external folder must already exist, so a
 * typo in a path never creates a stray tree somewhere on the disk. Creates an empty
 * task list when there is none.
 */
function initConfig(projectDir, { docsDir, language = DEFAULT_LANGUAGE, tasksFile }, { env = process.env } = {}) {
  const read = readRaw(projectDir);
  if (read.exists && read.error) throw new Error(`${CONFIG_FILE} ${read.error}; fix or remove it first`);
  const next = { ...(read.raw || {}), docsDir, language, tasksFile };

  const resolvedDocs = resolveDocsDir(docsDir, projectDir, env);
  if (!isDirectory(resolvedDocs)) {
    if (!isInside(projectDir, resolvedDocs)) {
      throw new Error(`docsDir does not exist (${resolvedDocs}); create it first, outside folders are never created`);
    }
    fs.mkdirSync(resolvedDocs, { recursive: true });
  }
  if (!normalizeLanguage(language)) throw new Error(`language is not a language tag (${JSON.stringify(language)})`);
  const resolvedTasks = resolveTasksFile(tasksFile, resolvedDocs);
  if (!isFile(resolvedTasks)) {
    fs.mkdirSync(path.dirname(resolvedTasks), { recursive: true });
    fs.writeFileSync(resolvedTasks, '# Tasks\n', { flag: 'wx' });
  }

  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  fs.writeFileSync(configPath(projectDir), JSON.stringify(next, null, 2) + '\n');
  // The person just gave this folder, so it is trusted for this project.
  if (!isInside(projectDir, resolvedDocs)) trustDocsDir(projectDir, resolvedDocs);
  return loadConfig(projectDir, { env });
}

module.exports = {
  CONFIG_FILE,
  DEFAULT_STATE_DIR,
  PAGE_LANGUAGES,
  configPath,
  expandEnv,
  initConfig,
  isInside,
  isNetworkOrDevicePath,
  isTrusted,
  loadConfig,
  normalizeLanguage,
  pageLanguage,
  readRaw,
  resolveTasksFile,
  stateDirOf,
  trustDocsDir,
  trustFile,
};

// --- CLI -------------------------------------------------------------------

if (require.main === module) {
  const argv = process.argv.slice(2);
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const command = argv[0];
  const projectDir = path.resolve(value('--project-dir') || process.env.CLAUDE_PROJECT_DIR || process.cwd());

  const report = (outcome) => {
    if (outcome.ok) {
      const { config } = outcome;
      process.stdout.write(
        `task-flow is configured.\n` +
          `  docsDir   : ${config.docsDir}\n` +
          `  language  : ${config.language}\n` +
          `  tasksFile : ${config.tasksFile}\n` +
          `  stateDir  : ${config.stateDir}\n`
      );
      return 0;
    }
    process.stdout.write(`task-flow is NOT configured for ${projectDir}. It must not start.\n`);
    for (const line of outcome.errors) process.stdout.write(`  - ${line}\n`);
    process.stdout.write(
      'Set the three required values with:\n' +
        `  node "${__filename}" init --docs-dir <folder> --language <EN|PT-PT|...> --tasks-file <file relative to the folder>\n`
    );
    return 1;
  };

  if (command === 'check') {
    process.exitCode = report(loadConfig(projectDir));
  } else if (command === 'init') {
    const docsDir = value('--docs-dir');
    const tasksFile = value('--tasks-file');
    if (!docsDir || !tasksFile) {
      process.stderr.write('init needs --docs-dir and --tasks-file (and --language, default EN).\n');
      process.exitCode = 2;
    } else {
      try {
        process.exitCode = report(initConfig(projectDir, { docsDir, tasksFile, language: value('--language') || DEFAULT_LANGUAGE }));
      } catch (error) {
        process.stderr.write(`init failed: ${error.message}\n`);
        process.exitCode = 1;
      }
    }
  } else if (command === 'trust') {
    // The consent step: run only after the person has confirmed the folder.
    try {
      const read = readRaw(projectDir);
      if (!read.exists || read.error) throw new Error(`${CONFIG_FILE} ${read.error || 'is missing'}`);
      if (read.raw.docsDir === undefined) throw new Error('docsDir is not set');
      const docsDir = resolveDocsDir(read.raw.docsDir, projectDir, process.env);
      if (isInside(projectDir, docsDir)) {
        process.stdout.write(`docsDir is inside the project (${docsDir}); nothing to trust.\n`);
      } else {
        const file = trustDocsDir(projectDir, docsDir);
        process.stdout.write(`Trusted ${docsDir} for ${projectDir} on this machine (${file}).\n`);
      }
    } catch (error) {
      process.stderr.write(`trust failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  } else {
    process.stderr.write('usage: config.js check | trust | init --docs-dir <dir> --tasks-file <file> [--language <tag>]\n');
    process.exitCode = 2;
  }
}
