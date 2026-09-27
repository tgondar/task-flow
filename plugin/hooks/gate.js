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
const path = require('path');
const { CONFIG_FILE, stateDirOf } = require('../scripts/config.js');

const ALLOW = 0;
const BLOCK = 2;

const allow = () => process.exit(ALLOW);

const block = (why, whatToDo) => {
  process.stderr.write(`GATE: ${why}\n      ${whatToDo}\n`);
  process.exit(BLOCK);
};

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
  // Fail closed. An unreadable payload must never become a silent pass.
  block(
    'the hook payload could not be parsed, so the write cannot be classified.',
    'Check the hook contract, or set TASK_FLOW_GATE=off deliberately.'
  );
}

const projectDirRaw = process.env.CLAUDE_PROJECT_DIR || payload.cwd || '';
const projectDir = normalise(projectDirRaw);
const target = normalise(payload.tool_input && payload.tool_input.file_path);

// Not a file-shaped tool call: nothing here to classify.
if (!target) allow();

// --- only in a project that opted in --------------------------------------
// Installed as a plugin, this hook runs in every repository on the machine.
// .claude/task-flow.json is the opt-in; a project without one is none of the
// gate's business, and failing closed there would block every code edit in it.
if (!projectDirRaw) allow();

// The state directory is where writes are allowed without approval, so it must
// be a real subfolder of the project: '..' or '.' would turn everything into
// "bookkeeping". config.js refuses both.
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

const stateDir = normalise(stateDirRaw);

const relative = target.startsWith(projectDir + '/')
  ? target.slice(projectDir.length + 1)
  : target;

const STATE_PREFIX = stateDir.slice(projectDir.length + 1) + '/';
const isStateFile = relative.startsWith(STATE_PREFIX);
const isMarkdown = relative.endsWith('.md');

/** Every approvedBy the runs currently record, as written on disk. */
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

const parsedApproval = (text) => {
  try {
    return hasApproval(JSON.parse(text));
  } catch (error) {
    return false; // not JSON: no reader will take an approval from it
  }
};

/** The file as it will be after this tool call, or null when that cannot be
 *  worked out. Write replaces the file; Edit (and a MultiEdit-shaped `edits`
 *  list) replaces text in the current one. Judging the RESULT, not the fragment,
 *  is what closes split keys, escaped keys and renamed keys: JSON.parse sees
 *  exactly what the gate will read next time. */
function resultingText(input, current) {
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
if (isStateFile) {
  // ...with one exception. state.json lives here, and approval lives in
  // state.json. Without this the agent could grant itself approval through the
  // very directory the gate leaves open, and then write whatever it liked.
  if (path.posix.basename(relative) === 'state.json') {
    let current = null;
    try {
      current = fs.readFileSync(path.resolve(projectDirRaw, payload.tool_input.file_path), 'utf8');
    } catch (error) {
      current = null; // a new file
    }

    if (!parsedApproval(current)) {
      const next = resultingText(payload.tool_input || {}, current);
      if (next === null) {
        // Fail closed: an edit we cannot replay could be the one that approves.
        block(
          'this change to an unapproved state.json cannot be checked for "approvedBy".',
          'Write the whole file instead, without "approvedBy" - approval is the user\'s to give.'
        );
      }
      if (parsedApproval(next)) {
        block(
          'this write would fill "approvedBy" in state.json, which is the gate\'s own key.',
          'Approval is the user\'s to give through the approval gate - do not write it yourself.'
        );
      }
    }
  }
  allow();
}

// --- documentation is not code --------------------------------------------
if (isMarkdown) allow();

// --- everything else needs an approved run --------------------------------
let approvedTask = null;
try {
  approvedTask = (readRunStates().find((entry) => hasApproval(entry.state)) || {}).task || null;
} catch (error) {
  // Fail closed: no readable state means no evidence of approval.
  block(
    `no readable run state under ${STATE_PREFIX}, so approval cannot be confirmed.`,
    'Run /task-flow <task> to create the run, or set TASK_FLOW_GATE=off deliberately.'
  );
}

if (!approvedTask) {
  block(
    `writing ${relative} is code, and no run under ${STATE_PREFIX} has "approvedBy" filled.`,
    'Ask the user to approve the plan. Do not edit state.json to get past this.'
  );
}

allow();
