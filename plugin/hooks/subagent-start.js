#!/usr/bin/env node
// The task-flow SubagentStart hook: every subagent of a live run starts with the
// project's standing answers.
//
// Why this exists. A standing answer is a rule of the project the person already
// gave ("prices are always in EUR"). Putting it in each brief is prose, and prose
// drifts: a brief written in a hurry leaves it out, and the subagent asks again
// or decides the other way. So the orchestrator's memory is not relied on - the
// hook hands the page to every subagent itself, whatever the brief says.
//
// What it hands over is data someone else may have written: the page sits in the
// docs folder, which can come with the repository. So the hook never reads the
// page itself. It asks standing-answers.js, the one reader, and passes on only
// that reader's delimited block, labelled as data. Nothing else of the page is
// ever printed, and nothing at all goes to stderr.
//
// It stays silent - prints nothing, exit 0 - unless every one of these holds:
//   - TASK_FLOW_GATE is not "off" (the same escape hatch as the Stop hook);
//   - the project opted in (.claude/task-flow.json) and config.js accepts all of
//     its configuration, not only docsDir: a broken configuration is no time to
//     start putting text in front of subagents;
//   - a run there has status "running" (config.js hasRunningRun, the same test
//     the Stop hook uses), so an ordinary conversation in the repository, or a
//     run parked on a question, gets nothing;
//   - the reader accepts the page and it holds at least one entry.
//
// Which project. CLAUDE_PROJECT_DIR, as in stop.js - and payload.cwd when that is
// where the running run is, because CLAUDE_PROJECT_DIR does not follow a session
// into a worktree. Unlike stop.js, payload.cwd only counts when it is inside
// CLAUDE_PROJECT_DIR without going through a link (worktrees live under the
// project's .claude/worktrees/): a session in one repository whose cwd wanders
// into a cloned repository with a "running" state.json of its own must not be
// handed that clone's page. A network or device path is never examined at all.
//
// It FAILS OPEN on everything. The event cannot block a subagent, but a hook that
// throws would print a stack trace with paths in it; so every failure is silence.
//
//   stdin: { session_id, transcript_path, cwd, hook_event_name, agent_id, agent_type }
//   stdout: {"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"<block>"}}

'use strict';

const fs = require('fs');
const { crossesLink, hasRunningRun, isInside, isNetworkOrDevicePath, loadConfig } = require('../scripts/config.js');
const { read, formatBlock } = require('../scripts/standing-answers.js');

const usable = (dir) => typeof dir === 'string' && dir !== '' && !isNetworkOrDevicePath(dir);

function projectDirFor(payload, env) {
  const envDir = usable(env.CLAUDE_PROJECT_DIR) ? env.CLAUDE_PROJECT_DIR : '';
  const cwd = usable(payload.cwd) ? payload.cwd : '';
  if (!envDir) return cwd;
  const cwdCounts = cwd && isInside(envDir, cwd) && !crossesLink(envDir, cwd);
  return cwdCounts && !hasRunningRun(envDir) && hasRunningRun(cwd) ? cwd : envDir;
}

function output() {
  if (String(process.env.TASK_FLOW_GATE || '').toLowerCase() === 'off') return '';
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const projectDir = projectDirFor(payload, process.env);
  if (!projectDir || !hasRunningRun(projectDir)) return '';
  if (!loadConfig(projectDir).ok) return '';
  const result = read({ projectDir });
  if (result.refused || !result.entries.length) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: formatBlock(result) } });
}

let text = '';
try {
  text = output();
} catch {
  text = ''; // fail open: silence, never a stack trace
}
if (text) process.stdout.write(`${text}\n`);
process.exitCode = 0;
