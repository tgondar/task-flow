#!/usr/bin/env node
// The task-flow approval gate: one check, on the one step that is hard to undo.
//
// No source code is written while the run is unapproved. It deliberately does
// NOT validate the pipeline's other transitions - every extra rule is another
// false stop and more surface for the gate itself to be wrong.
//
// Written in node rather than a shell script around jq: jq is not installed
// everywhere, and a gate that fails silently when a tool is missing is worse
// than no gate.
//
// This is a guardrail, not a security boundary. The agent has Bash: an `echo`
// into a file never reaches a hook matching Write|Edit|NotebookEdit. It stops
// code being written by drift, which is the failure that actually happens. It
// does not stop an agent set on getting around it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CONFIG_FILE, crossesLink, stateDirOf } = require('../scripts/config.js');

const ALLOW = 0;
const BLOCK = 2;

const allow = () => process.exit(ALLOW);

const block = (why, whatToDo) => {
  process.stderr.write(`GATE: ${why}\n      ${whatToDo}\n`);
  process.exit(BLOCK);
};

// A crash is not a verdict. Claude Code treats exit 1 as a non-blocking hook
// error, so an uncaught exception would let the write through: this gate fails
// closed, and that includes its own bugs.
process.on('uncaughtException', (error) => {
  process.stderr.write(
    `GATE: the gate itself failed (${error && error.message}), so the write is refused.\n` +
      '      Report it, or set TASK_FLOW_GATE=off deliberately.\n'
  );
  process.exit(BLOCK);
});

// Lower-cased, forward-slashed, and with '..' resolved. Windows paths arrive
// with backslashes in tool_input.file_path but with forward slashes in
// CLAUDE_PROJECT_DIR - comparing them raw never matches.
const normalise = (value) =>
  path.posix.normalize(String(value || '').replace(/\\/g, '/')).toLowerCase();

// --- the escape hatch comes first -----------------------------------------
// Deliberately an environment variable: it lives outside the repository, so it
// is not something the agent trips over while editing project files.
if (String(process.env.TASK_FLOW_GATE || '').toLowerCase() === 'off') {
  process.stderr.write('GATE: off (TASK_FLOW_GATE=off) - approval is not being checked.\n');
  allow();
}

let payload;
try {
  payload = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch (error) {
  payload = null;
}
if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
  // Fail closed. An unreadable payload must never become a silent pass.
  block(
    'the hook payload could not be parsed, so the write cannot be classified.',
    'Check the hook contract, or set TASK_FLOW_GATE=off deliberately.'
  );
}

const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};

// The file this call writes, read early because it decides which of the two
// project-root candidates below is the real one.
const fileRaw =
  typeof input.file_path === 'string' ? input.file_path
    : typeof input.notebook_path === 'string' ? input.notebook_path
      : '';

// --- only in a project that opted in --------------------------------------
// Installed as a plugin, this hook runs in every repository on the machine.
// .claude/task-flow.json is the opt-in; a project without one is none of the
// gate's business, and failing closed there would block every code edit in it.
//
// CLAUDE_PROJECT_DIR is tried first because it is meant to be a stable anchor
// for the session's project root. But it is fixed when the session starts and
// does not follow EnterWorktree: a background session that isolates its edits
// into a worktree keeps CLAUDE_PROJECT_DIR pointing at the original checkout,
// while every real tool call - and payload.cwd - targets the worktree. That
// stale value would make the gate look for approval in the wrong checkout and
// block every write forever, even an approved one. So when the file being
// written sits under payload.cwd but not under CLAUDE_PROJECT_DIR, payload.cwd
// is where the work is actually happening, and it wins.
const envProjectDir = process.env.CLAUDE_PROJECT_DIR || '';
const cwdProjectDir = payload.cwd || '';
const isUnder = (dir, file) => {
  if (!dir || !file) return false;
  const normDir = normalise(dir);
  const normFile = normalise(file);
  return normFile === normDir || normFile.startsWith(normDir + '/');
};
const projectDirRaw =
  path.isAbsolute(fileRaw) && !isUnder(envProjectDir, fileRaw) && isUnder(cwdProjectDir, fileRaw)
    ? cwdProjectDir
    : envProjectDir || cwdProjectDir || '';
if (!projectDirRaw) allow();

// The state directory is where writes are allowed without approval, so it must
// be a real subfolder of the project: '..' or '.' would turn everything into
// "bookkeeping". config.js refuses both, and a stateDir reached through a link.
let stateDirRaw;
try {
  stateDirRaw = stateDirOf(projectDirRaw);
} catch (error) {
  // Fail closed: this project opted in, and we cannot tell where its runs live.
  block(
    `${CONFIG_FILE} is not usable (${error.message}), so the run state cannot be found.`,
    `Fix ${CONFIG_FILE}, or set TASK_FLOW_GATE=off deliberately.`
  );
}
if (stateDirRaw === null) allow();

// A relative path is resolved against the project before it is classified - as
// text it could pass for bookkeeping. A call with no path at all resolves to
// the project itself, which is code.
const targetRaw = path.resolve(projectDirRaw, fileRaw);
const projectDir = normalise(projectDirRaw);
const stateDir = normalise(stateDirRaw);
const target = normalise(targetRaw);
const insideProject = target.startsWith(projectDir + '/');

const relative = insideProject ? target.slice(projectDir.length + 1) : target;

// A link inside the project can point anywhere, so a path that goes through one
// gets no exemption. Only the project's own folders are walked: a repository
// cannot plant links anywhere else.
const throughLink = insideProject && crossesLink(projectDirRaw, targetRaw);

const STATE_PREFIX = stateDir.slice(projectDir.length + 1) + '/';
const isStateFile = insideProject && !throughLink && relative.startsWith(STATE_PREFIX);
const isMarkdown = relative.endsWith('.md');

// --- markdown that is really instructions ---------------------------------
// Documentation is not code, but some markdown is read by the agent as orders:
// commands, agents, skills and rules under any .claude folder, and a CLAUDE.md
// outside the project (a parent folder's is loaded into this session). Those
// need approval like code. The auto-memory and plan-mode folders are the
// harness's own notes, and stay open.
const home = normalise(os.homedir());
function isInstructionMarkdown() {
  if (/(^|\/)\.claude\//.test(target)) {
    if (target.startsWith(home + '/.claude/plans/')) return false;
    const projects = home + '/.claude/projects/';
    if (target.startsWith(projects)) {
      const parts = target.slice(projects.length).split('/');
      if (parts.length > 2 && parts[1] === 'memory') return false;
    }
    return true;
  }
  const base = path.posix.basename(target);
  return !insideProject && (base === 'claude.md' || base === 'claude.local.md');
}

/** Every run the state folder holds, as written on disk. */
function readRunStates() {
  const states = [];
  for (const task of fs.readdirSync(stateDirRaw)) {
    const statePath = path.join(stateDirRaw, task, 'state.json');
    if (!fs.existsSync(statePath)) continue;
    states.push({
      path: normalise(statePath),
      task,
      state: JSON.parse(fs.readFileSync(statePath, 'utf8')),
    });
  }
  return states;
}

// Only a non-empty string is an approval. `true`, `1` or an object in approvedBy
// is not something the approval gate ever writes, so it approves nothing.
const hasApproval = (state) =>
  Boolean(state && typeof state.approvedBy === 'string' && state.approvedBy.trim());

// A finished run approves nothing more. state.json stays in the repository, so
// without this an approval months old would keep the gate open for good.
// "Finished" is what the renderer and SKILL.md §8b/§8c call it.
const isFinished = (state) =>
  String(state.phase || '') === 'done' ||
  ['done', 'failed'].includes(String(state.status || '').toLowerCase());

const approvesNow = (state) => hasApproval(state) && !isFinished(state);

const parsedApproval = (text) => {
  try {
    return approvesNow(JSON.parse(text));
  } catch (error) {
    return false; // not JSON: no reader will take an approval from it
  }
};

/** The file as it will be after this tool call, or null when that cannot be
 *  worked out. Write replaces the file; Edit (and a MultiEdit-shaped `edits`
 *  list) replaces text in the current one. Judging the RESULT, not the fragment,
 *  is what closes split keys, escaped keys and renamed keys: JSON.parse sees
 *  exactly what the gate will read next time. */
function resultingText(current) {
  if (typeof input.content === 'string') return input.content;
  const edits = Array.isArray(input.edits)
    ? input.edits
    : typeof input.old_string === 'string' || typeof input.new_string === 'string'
      ? [input]
      : null;
  if (!edits) return null;

  let text = current;
  for (const edit of edits) {
    if (!edit || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') return null;
    if (edit.old_string === '') {
      if (text !== null) return null; // an empty old_string only ever creates a file
      text = edit.new_string;
      continue;
    }
    if (text === null || !text.includes(edit.old_string)) return null;
    text = edit.replace_all
      ? text.split(edit.old_string).join(edit.new_string)
      : text.replace(edit.old_string, () => edit.new_string);
  }
  return text;
}

// --- the pipeline's own bookkeeping ---------------------------------------
// The pipeline keeps state.json in stateDir, and markdown notes there are
// harmless. Any other file under stateDir is code like anywhere else, so a
// stateDir of "src" does not open the source tree.
if (isStateFile && path.posix.basename(relative) === 'state.json') {
  // Approval lives in state.json. Without this check the agent could grant
  // itself approval through the very directory the gate leaves open, and then
  // write whatever it liked. A finished run counts as unapproved here too, so
  // reopening one does not bring its old approval back to life.
  let current = null;
  try {
    current = fs.readFileSync(targetRaw, 'utf8');
  } catch (error) {
    current = null; // a new file
  }

  if (!parsedApproval(current)) {
    const next = resultingText(current);
    if (next === null) {
      // Fail closed: an edit we cannot replay could be the one that approves.
      block(
        'this change to an unapproved state.json cannot be checked for "approvedBy".',
        'Write the whole file instead, without "approvedBy" - approval is the user\'s to give.'
      );
    }
    if (parsedApproval(next)) {
      block(
        'this write would give state.json a live "approvedBy", which is the gate\'s own key.',
        'Approval is the user\'s to give through the approval gate - do not write it yourself.'
      );
    }
  }
  allow();
}

// A run's questions are data too, and the first ones come in the spec, before
// anything is approved - which is why they live in stateDir, beside state.json,
// and not in the docs folder the renderer writes. The exemption is for exactly
// <stateDir>/<run>/questions.json: not stateDir/questions.json, not a deeper
// folder, not another name, and never through a link (isStateFile already
// excludes those). The file cannot approve anything - approval is only ever
// read from state.json - and render-run.js validates it before a page is made
// from it.
//
// And it is judged by what it would contain, like state.json: the path alone
// would let a stateDir that sits among code (say "src") take any JSON named
// questions.json before approval. So the write is replayed on the current file
// and allowed only when the result is a valid questions file naming this very
// run, in a run folder that has a state.json. Anything else - an edit that
// cannot be replayed, JSON of another shape - is blocked: this gate fails closed.
const QUESTIONS_FILE = /^[a-z0-9][a-z0-9._-]*\/questions\.json$/; // `relative` is lower-cased
if (isStateFile && QUESTIONS_FILE.test(relative.slice(STATE_PREFIX.length))) {
  const { validateQuestions } = require('../scripts/questions.js');
  const runDir = path.dirname(targetRaw);
  let current = null;
  try {
    current = fs.readFileSync(targetRaw, 'utf8');
  } catch (error) {
    current = null; // a new file
  }
  const next = resultingText(current);
  let data = null;
  try {
    data = next === null ? null : JSON.parse(next.replace(/^\uFEFF/, ''));
  } catch (error) {
    data = null;
  }
  const valid =
    data !== null &&
    validateQuestions(data).ok &&
    String(data.slug).toLowerCase() === path.basename(runDir).toLowerCase() &&
    fs.existsSync(path.join(runDir, 'state.json'));
  if (!valid) {
    block(
      'this write would not leave a valid questions.json for this run.',
      'Write the whole file in the questions.json format (SKILL.md §8), with "slug" set to the run folder name, in a run folder that has a state.json.'
    );
  }
  allow();
}

// --- documentation is not code --------------------------------------------
if (isMarkdown && !throughLink && (isStateFile || !isInstructionMarkdown())) allow();

// --- everything else needs an approved run --------------------------------
let approvedTask = null;
try {
  approvedTask = (readRunStates().find((entry) => approvesNow(entry.state)) || {}).task || null;
} catch (error) {
  // Fail closed: no readable state means no evidence of approval.
  block(
    `no readable run state under ${STATE_PREFIX}, so approval cannot be confirmed.`,
    'Run /task-flow <task> to create the run, or set TASK_FLOW_GATE=off deliberately.'
  );
}

if (!approvedTask) {
  block(
    `writing ${relative} needs approval, and no unfinished run under ${STATE_PREFIX} has "approvedBy" filled.`,
    'Ask the user to approve the plan. Do not edit state.json to get past this.'
  );
}

allow();
