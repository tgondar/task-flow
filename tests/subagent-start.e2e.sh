#!/usr/bin/env bash
# End-to-end probes for the task-flow SubagentStart hook.
#
# subagent-start.test.js proves the hook's logic against synthetic payloads.
# This proves the two claims that payloads cannot prove:
#
#   a. Claude Code really hands the hook's additionalContext to the subagent: a
#      subagent writes down a standing answer that only the page holds - the
#      prompt never pastes it, and the parent is told not to read any file.
#   b. A hook slower than its timeout does not stop the subagent from starting.
#      The hooks reference does not document what SubagentStart does on a
#      timeout, so this measures it: a test hook (not ours) sleeps 20 s with a
#      3 s timeout; the probe reports how long the subagent waited and whether
#      the sleeping hook was cut short.
#
# Run: bash tests/subagent-start.e2e.sh
# Slow and paid (each probe starts a Claude session with one subagent), so it
# is not part of any CI gate.
#
# The rules of tests/stop.e2e.sh hold here too: --permission-mode acceptEdits
# (a refusal must come from the hook, not from a permission prompt), the scratch
# projects live OUTSIDE ~/.claude, and every assertion is on a FACT - a file the
# subagent wrote and its content, file times - never on the wording of a reply.
#
# --setting-sources project keeps the user's own settings out, and with them an
# installed copy of this plugin: its Stop hook would otherwise push the probe's
# "running" run, and its SubagentStart hook would inject a second time.

set -u

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="${TMPDIR:-/tmp}/taskflow-subagent-e2e-$$"
FAILURES=0
TOTAL=0

cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

if ! command -v claude >/dev/null 2>&1; then
  echo "SKIP: the claude CLI is not on PATH; the end-to-end probes need it." >&2
  exit 0
fi

case "$SCRATCH" in
  *"/.claude/"*) echo "ABORT: scratch dir is under ~/.claude." >&2; exit 1 ;;
esac

RUNNER=""
if command -v timeout >/dev/null 2>&1; then RUNNER="timeout 300"; fi
if [ -z "$RUNNER" ]; then
  echo "NOTE: 'timeout' is not available - a hung session will hang this script." >&2
fi

mtime_ms() { node -e 'try{process.stdout.write(String(Math.round(require("fs").statSync(process.argv[1]).mtimeMs)))}catch(e){process.stdout.write("-1")}' "$1"; }

# $1 project dir · $2 prompt. Sets RC.
session() {
  RC=0
  ( cd "$1" && $RUNNER claude -p "$2" --permission-mode acceptEdits --setting-sources project \
      >"$1/.session.out" 2>&1 ) || RC=$?
}

SUBAGENT_RULES='Do not read, search or list any file yourself, and do not run commands.'

echo "SubagentStart end-to-end probes (each one starts a Claude session, so this is slow)"

# --- a: the page reaches the subagent --------------------------------------
A="$SCRATCH/a"
mkdir -p "$A/.claude/hooks" "$A/.claude/scripts" "$A/.claude/task-flow/probe" "$A/docs"
cp "$ROOT_DIR/plugin/hooks/subagent-start.js" "$A/.claude/hooks/"
cp "$ROOT_DIR"/plugin/scripts/*.js "$A/.claude/scripts/"
WORD="quokka-$RANDOM$RANDOM"
echo '{ "docsDir": "docs", "language": "EN", "tasksFile": "tasks.md" }' > "$A/.claude/task-flow.json"
echo '# Tasks' > "$A/docs/tasks.md"
cat > "$A/docs/standing-answers.md" <<EOF
# Standing answers

- **R1** · The probe word is $WORD · «use that word» · probe · 2026-11-27
EOF
echo '{ "task": "probe", "phase": "build", "status": "running", "buildCursor": "T1", "updated": "2026-11-27T10:00:00Z" }' \
  > "$A/.claude/task-flow/probe/state.json"
cat > "$A/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "SubagentStart": [
      { "hooks": [ { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/subagent-start.js\"", "timeout": 5 } ] }
    ]
  }
}
JSON

TOTAL=$((TOTAL + 1))
session "$A" "Use the Agent tool exactly once to start a general-purpose subagent with this prompt, word for word: \"If your context holds this project's standing answers, write the rule of entry R1, exactly as given, into the file probe-a.txt in the current directory; otherwise write NONE into it. $SUBAGENT_RULES\" $SUBAGENT_RULES When the subagent returns, reply with the single word: done"
if [ "$RC" -eq 124 ]; then
  echo "  FAIL  a the session never returned"; FAILURES=$((FAILURES + 1))
elif grep -q "$WORD" "$A/probe-a.txt" 2>/dev/null; then
  echo "  ok    a the subagent wrote the standing answer it was never shown (probe-a.txt holds $WORD)"
else
  echo "  FAIL  a probe-a.txt does not hold the probe word (content: $(head -c 200 "$A/probe-a.txt" 2>/dev/null || echo 'no file'))"
  FAILURES=$((FAILURES + 1))
fi

# --- b: a hook past its timeout does not hold the subagent back ------------
B="$SCRATCH/b"
mkdir -p "$B/.claude/hooks"
cat > "$B/.claude/hooks/sleep.js" <<'JS'
// Writes hook-start.txt, then hook-end.txt 20 s later - unless it is killed.
const fs = require('fs');
const path = require('path');
const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
fs.writeFileSync(path.join(dir, 'hook-start.txt'), 'x');
setTimeout(() => fs.writeFileSync(path.join(dir, 'hook-end.txt'), 'x'), 20000);
JS
cat > "$B/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "SubagentStart": [
      { "hooks": [ { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/sleep.js\"", "timeout": 3 } ] }
    ]
  }
}
JSON

TOTAL=$((TOTAL + 1))
START_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
session "$B" "Use the Agent tool exactly once to start a general-purpose subagent with this prompt, word for word: \"Write the word started into the file probe-b.txt in the current directory. $SUBAGENT_RULES\" $SUBAGENT_RULES When the subagent returns, reply with the single word: done"
END_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
# Wait out the sleeping hook, so hook-end.txt says whether it was killed.
node -e 'setTimeout(()=>{}, 22000)'
HOOK_START="$(mtime_ms "$B/hook-start.txt")"
PROBE_B="$(mtime_ms "$B/probe-b.txt")"
if [ -f "$B/hook-end.txt" ]; then KILLED="no (hook-end.txt was written)"; else KILLED="yes (no hook-end.txt)"; fi
if [ "$HOOK_START" -ge 0 ] && [ "$PROBE_B" -ge 0 ]; then WAIT="$(( (PROBE_B - HOOK_START) / 1000 )) s"; else WAIT="n/a"; fi
echo "        b measured: session $(( (END_MS - START_MS) / 1000 )) s; hook start to probe-b.txt $WAIT; sleeping hook cut short: $KILLED"
if [ "$RC" -eq 124 ]; then
  echo "  FAIL  b the session never returned"; FAILURES=$((FAILURES + 1))
elif [ "$HOOK_START" -lt 0 ]; then
  echo "  FAIL  b the test hook never ran (no hook-start.txt), so nothing was measured"; FAILURES=$((FAILURES + 1))
elif [ -f "$B/probe-b.txt" ]; then
  echo "  ok    b the subagent started despite a hook past its timeout"
else
  echo "  FAIL  b the subagent did not write probe-b.txt"; FAILURES=$((FAILURES + 1))
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "$TOTAL/$TOTAL probes passed"
  exit 0
fi
echo "$FAILURES of $TOTAL probes failed"
exit 1
