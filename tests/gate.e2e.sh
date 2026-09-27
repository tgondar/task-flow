#!/usr/bin/env bash
# End-to-end probes for the task-flow approval gate.
#
# gate.test.js proves the gate's logic against synthetic payloads. This proves
# the thing that actually matters: that Claude Code fires the hook on Windows
# and honours exit 2. The two are not the same claim.
#
# Run: bash tests/gate.e2e.sh
# Slow (each case starts a Claude session), so it is not part of any CI gate.
#
# Two rules learned the hard way:
#
#   1. --permission-mode acceptEdits is mandatory. Without it a refused write
#      proves nothing, because the refusal could have come from the permission
#      prompt rather than from the gate.
#   2. The scratch project must live OUTSIDE ~/.claude. Claude Code refuses
#      writes under that tree by its own policy, before any hook runs, so a
#      probe placed there reports a false positive.
#
# Each case asserts on the FACT — whether the file exists — never on the wording
# of the reply.

set -u

HOOK_DIR="$(cd "$(dirname "$0")/../plugin/hooks" && pwd)"
SCRATCH="${TMPDIR:-/tmp}/taskflow-gate-e2e-$$"
FAILURES=0

cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

if ! command -v claude >/dev/null 2>&1; then
  echo "SKIP: the claude CLI is not on PATH; the end-to-end probes need it." >&2
  exit 0
fi

case "$SCRATCH" in
  *"/.claude/"*) echo "ABORT: scratch dir is under ~/.claude — see rule 2 above." >&2; exit 1 ;;
esac

# --- build the probe project ----------------------------------------------
# The hook requires ../scripts/config.js, so the probe keeps the plugin's layout.
mkdir -p "$SCRATCH/.claude/hooks" "$SCRATCH/.claude/scripts" "$SCRATCH/docs/pipeline/demo" "$SCRATCH/src"
cp "$HOOK_DIR/gate.js" "$SCRATCH/.claude/hooks/gate.js"
cp "$HOOK_DIR/../scripts/config.js" "$SCRATCH/.claude/scripts/config.js"
echo '{ "stateDir": "docs/pipeline" }' > "$SCRATCH/.claude/task-flow.json"
cat > "$SCRATCH/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|NotebookEdit",
        "hooks": [
          { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/gate.js\"", "timeout": 15 }
        ]
      }
    ]
  }
}
JSON

write_state() {
  cat > "$SCRATCH/docs/pipeline/demo/state.json" <<JSON
{ "task": "demo", "phase": "plan", "status": "ready", "approvedBy": "$1", "approvedAt": null }
JSON
}

# $1 label · $2 prompt · $3 relative path · $4 "exists" | "absent"
probe() {
  local label="$1" prompt="$2" target="$3" expected="$4"
  rm -f "$SCRATCH/$target"
  ( cd "$SCRATCH" && claude -p "$prompt" --permission-mode acceptEdits >/dev/null 2>&1 )
  local actual="absent"
  [ -f "$SCRATCH/$target" ] && actual="exists"
  if [ "$actual" = "$expected" ]; then
    echo "  ok    $label ($target $actual)"
  else
    echo "  FAIL  $label — expected $target to be $expected, it is $actual"
    FAILURES=$((FAILURES + 1))
  fi
}

CODE_PROMPT="Create the file src/Foo.cs containing a public class Foo with a single method Bar that returns 42."
DOC_PROMPT="Create the file notes.md containing a single line: hello from markdown"

echo "Gate end-to-end probes (each one starts a Claude session, so this is slow)"

write_state ""
probe "A unapproved code is refused" "$CODE_PROMPT" "src/Foo.cs" "absent"

write_state "user"
probe "B approved code is written" "$CODE_PROMPT" "src/Foo.cs" "exists"

write_state ""
probe "C markdown needs no approval" "$DOC_PROMPT" "notes.md" "exists"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "3/3 probes passed"
  exit 0
fi
echo "$FAILURES of 3 probes failed"
exit 1
