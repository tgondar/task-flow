#!/usr/bin/env bash
# End-to-end probe of the two assumptions the per-loop measurement rests on
# (spec 6.1, RF-010, SC-001; plan T2):
#
#   1. Claude Code fires SubagentStart for EVERY subagent the session starts,
#      background and synchronous alike - so the start events in the run's
#      loop-events.jsonl equal the Agent calls of the session. The transcripts
#      measured for the spec held a SubagentStart attachment only for background
#      subagents, never for synchronous ones, so this cannot be read off old files.
#   2. The payload's agent_id is the id in the subagent's transcript file name:
#      every start event has its agent-<agent_id>.jsonl, which is what the close
#      joins on.
#
# subagent-start.test.js and metrics.loops*.test.js prove the hook and the writer
# against synthetic payloads; only a real session can prove these two.
#
# Two sessions, three trivial subagents. Session A (default settings) starts one
# in the background and one that is asked to start a subagent of its own - that
# one is informational (spec edge case "a subagent started by another subagent"):
# a start event beyond the sessions' own Agent calls is reported as a nested
# extra, never failed on. Session B runs with CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
# and starts one subagent, so a SYNCHRONOUS one is measured too: measured on
# Claude Code 2.1.332, a session left alone ran every Agent call in the background
# even when asked not to, so asking is not enough to reach the synchronous path.
# Background or synchronous is read from the tool result (isAsync), never from
# what was asked.
#
# Run: bash tests/loops.e2e.sh
# Slow and paid (two Claude sessions, three or four subagents), so it is not part
# of any CI gate.
#
# The rules of tests/stop.e2e.sh hold here too: --permission-mode acceptEdits, the
# scratch project lives OUTSIDE ~/.claude, and every assertion is on a FACT - the
# events file, the transcripts' tool-result fields, which files exist - never on
# the wording of a reply. Nothing from a transcript is ever printed or copied:
# only counts. --setting-sources project keeps the user's settings, and with them
# an installed copy of this plugin (a second SubagentStart writer, a Stop hook that
# would push the probe's "running" run), out of the sessions.

set -u

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="${TMPDIR:-/tmp}/taskflow-loops-e2e-$$"

cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

if ! command -v claude >/dev/null 2>&1; then
  echo "SKIP: the claude CLI is not on PATH; the end-to-end probe needs it." >&2
  exit 0
fi

case "$SCRATCH" in
  *"/.claude/"*) echo "ABORT: scratch dir is under ~/.claude." >&2; exit 1 ;;
esac

RUNNER=""
if command -v timeout >/dev/null 2>&1; then RUNNER="timeout 420"; fi
if [ -z "$RUNNER" ]; then
  echo "NOTE: 'timeout' is not available - a hung session will hang this script." >&2
fi

# --- the probe project: the hook and its scripts, in the plugin's layout -----
P="$SCRATCH/p"
mkdir -p "$P/.claude/hooks" "$P/.claude/scripts" "$P/.claude/task-flow/probe" "$P/docs"
cp "$ROOT_DIR/plugin/hooks/subagent-start.js" "$P/.claude/hooks/"
cp "$ROOT_DIR"/plugin/scripts/*.js "$P/.claude/scripts/"
echo '{ "docsDir": "docs", "language": "EN", "tasksFile": "tasks.md" }' > "$P/.claude/task-flow.json"
echo '# Tasks' > "$P/docs/tasks.md"
# phase = last stage COMPLETED, so every event should say phase "build", task "T1".
echo '{ "task": "probe", "phase": "plan", "status": "running", "buildCursor": "T1", "updated": "2026-11-27T10:00:00Z" }' \
  > "$P/.claude/task-flow/probe/state.json"
cat > "$P/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "SubagentStart": [
      { "hooks": [ { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/subagent-start.js\"", "timeout": 5 } ] }
    ]
  }
}
JSON

RULES='Do not read, search or list any file, and do not run commands.'
PROMPT_A="Use the Agent tool exactly twice, each time with a general-purpose subagent, in this order.
1. With run_in_background set to true, and this prompt, word for word: \"Reply with the single word: one. $RULES\"
2. With this prompt, word for word: \"If you have the Agent tool, use it exactly once to start a general-purpose subagent with the prompt 'Reply with the single word: three. $RULES' and wait for it; if you do not have it, skip that. Then reply with the single word: two. $RULES\"
$RULES Wait until both subagents have finished, then reply with the single word: done"
PROMPT_B="Use the Agent tool exactly once, with a general-purpose subagent and this prompt, word for word: \"Reply with the single word: four. $RULES\" $RULES When it returns, reply with the single word: done"

# $1 label, $2 prompt, then extra environment. The session's JSON output (its
# session_id) is kept for the measurement; nothing of it is printed.
session() {
  local label="$1" prompt="$2" rc=0
  shift 2
  ( cd "$P" && env "$@" $RUNNER claude -p "$prompt" --permission-mode acceptEdits --setting-sources project \
      --output-format json >"$SCRATCH/session-$label.json" 2>/dev/null ) || rc=$?
  if [ "$rc" -eq 124 ]; then echo "  FAIL  session $label never returned"; exit 1; fi
  echo "        session $label exit code $rc"
}

echo "Loop start-event end-to-end probe (two Claude sessions with subagents, so this is slow)"
session A "$PROMPT_A"
session B "$PROMPT_B" CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1

# --- measure: counts only, from closed fields --------------------------------
cat > "$SCRATCH/measure.js" <<'JS'
'use strict';
// argv: project dir, session output files. Prints closed-shape lines, exit 0 pass / 1 fail.
const fs = require('fs');
const os = require('os');
const path = require('path');
const [projectDir, ...sessionFiles] = process.argv.slice(2);
const scripts = path.join(projectDir, '.claude', 'scripts');
const { readLoopEvents } = require(path.join(scripts, 'metrics.js'));
const { loadConfig } = require(path.join(scripts, 'config.js'));

const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;
const AGENT_ID = /^[A-Za-z0-9]{1,64}$/;
const fail = (why) => { console.log(`  FAIL  ${why}`); process.exit(1); };
const isFile = (file) => { try { return fs.lstatSync(file).isFile(); } catch { return false; } };
const records = (file) => {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    try { const r = JSON.parse(line); if (r && typeof r === 'object') out.push(r); } catch { /* not a record */ }
  }
  return out;
};
const agentCalls = (recs) => recs.reduce((n, r) => n + (r.message && Array.isArray(r.message.content)
  ? r.message.content.filter((b) => b && b.type === 'tool_use' && b.name === 'Agent').length : 0), 0);

const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
let dirs = [];
try { dirs = fs.readdirSync(root); } catch { /* below */ }

// Each session's own Agent calls, one per tool_use id. Its tool result says what
// came of it: an agentId (a subagent started; isAsync says background), an error
// (no subagent), or nothing usable. Only these closed fields are read.
const ids = new Set();
const folders = [];
const total = { calls: 0, background: 0, sync: 0, errored: 0, other: 0 };
let nestedCalls = 0;
sessionFiles.forEach((sessionFile, index) => {
  let session = '';
  try { session = JSON.parse(fs.readFileSync(sessionFile, 'utf8')).session_id; } catch { /* below */ }
  if (typeof session !== 'string' || !SESSION_ID.test(session)) fail('no session id in a session output (did the session run?)');
  const dir = dirs.find((d) => isFile(path.join(root, d, `${session}.jsonl`)));
  if (!dir) fail('a session transcript was not found under the projects folder');
  const base = path.join(root, dir);
  const main = records(path.join(base, `${session}.jsonl`));
  const blocks = (r) => (r.message && Array.isArray(r.message.content) ? r.message.content.filter((b) => b && typeof b === 'object') : []);
  const callIds = new Set();
  for (const r of main) for (const b of blocks(r)) if (b.type === 'tool_use' && b.name === 'Agent') callIds.add(b.id);
  const outcome = new Map();
  for (const r of main) {
    for (const b of blocks(r)) {
      if (b.type !== 'tool_result' || !callIds.has(b.tool_use_id) || outcome.has(b.tool_use_id)) continue;
      const t = r.toolUseResult;
      if (t && typeof t === 'object' && typeof t.agentId === 'string' && AGENT_ID.test(t.agentId)) {
        ids.add(t.agentId);
        outcome.set(b.tool_use_id, t.isAsync === true ? 'background' : 'sync');
      } else {
        outcome.set(b.tool_use_id, b.is_error === true ? 'errored' : 'other');
      }
    }
  }
  const counts = { calls: callIds.size, background: 0, sync: 0, errored: 0, other: 0 };
  for (const id of callIds) counts[outcome.get(id) || 'other'] += 1;
  for (const key of Object.keys(total)) total[key] += counts[key];
  const label = String.fromCharCode(65 + index);
  console.log(`        measured: session ${label} Agent calls ${counts.calls}: background ${counts.background}, sync ${counts.sync}, errored ${counts.errored}, other ${counts.other}`);
  const subagents = path.join(base, session, 'subagents');
  folders.push(subagents);
  try {
    for (const name of fs.readdirSync(subagents)) {
      if (/^agent-[A-Za-z0-9]+.jsonl$/.test(name)) nestedCalls += agentCalls(records(path.join(subagents, name)));
    }
  } catch { /* no subagents folder: counted as zero */ }
});
const { calls, background, sync } = total;
const hasTranscript = (id) => folders.some((dir) => isFile(path.join(dir, `agent-${id}.jsonl`)));

const loaded = loadConfig(projectDir);
if (!loaded.ok) fail('the probe configuration is not valid');
const events = readLoopEvents(projectDir, loaded.config.stateDir, 'probe');
const starts = events.starts;
const started = new Set(starts.map((e) => e.agent));
const withTranscript = starts.filter((e) => hasTranscript(e.agent)).length;
const missingStart = [...ids].filter((id) => !started.has(id)).length;
const extras = starts.filter((e) => !ids.has(e.agent)).length;
const offShape = starts.filter((e) => e.phase !== 'build' || e.task !== 'T1').length;

console.log(`        measured: Agent calls ${calls}, subagents started ${ids.size} (background ${background}, sync ${sync}), errored ${total.errored}, other ${total.other}`);
console.log(`        measured: start events ${starts.length} (ignored lines ${events.ignored}); calls without a start event ${missingStart}`);
console.log(`        measured: start events with agent-<id>.jsonl ${withTranscript}/${starts.length}; not phase build/T1 ${offShape}`);
console.log(`        measured: nested Agent calls in subagent transcripts ${nestedCalls}; start events beyond the sessions' calls ${extras}`);

let failed = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failed += 1; };
check(background >= 1 && sync >= 1, 'the sessions ran at least one background and one synchronous subagent');
check(total.other === 0, 'every Agent call of the sessions either started a subagent (agentId) or is a tool error');
check(missingStart === 0, 'assumption 1: every Agent call (background and sync) has a start event');
check(starts.length > 0 && withTranscript === starts.length, 'assumption 2: every start event has its agent-<agent_id>.jsonl');
check(offShape === 0, 'every start event carries the fixture run phase and task');
process.exit(failed === 0 ? 0 : 1);
JS

node "$SCRATCH/measure.js" "$P" "$SCRATCH/session-A.json" "$SCRATCH/session-B.json"
RESULT=$?
echo
if [ "$RESULT" -eq 0 ]; then echo "probe passed"; else echo "probe failed"; fi
exit "$RESULT"
