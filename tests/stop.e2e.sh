#!/usr/bin/env bash
# End-to-end probes for the task-flow continuation hook.
#
# stop.test.js proves the hook's logic against synthetic payloads. This proves
# the two claims that payloads cannot prove:
#
#   1. Claude Code on Windows fires the Stop event and honours exit 2 — i.e. the
#      turn really does keep going.
#   2. The session is NOT trapped. The loop protection is the hook's own; a
#      hook that pushes forever is worse than no hook at all. Probe A fails if `claude -p` does not return.
#
# Run: bash tests/stop.e2e.sh
# Slow (each case starts a Claude session), so it is not part of any CI gate.
#
# The two rules from the gate probes hold here too: the scratch project lives
# OUTSIDE ~/.claude, and every assertion is on a FACT — the loop guard's own
# counter, and whether the process returned — never on the wording of a reply.

set -u

HOOK_DIR="$(cd "$(dirname "$0")/../plugin/hooks" && pwd)"
SCRATCH="${TMPDIR:-/tmp}/taskflow-stop-e2e-$$"
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

# The hook writes its loop guard under ~/.claude/task-flow-guards, as node sees
# the home folder. On Windows node reports a drive path; find needs the POSIX form.
GUARD_DIR_RAW="$(node -e 'const p=require("path").join(require("os").homedir(),".claude","task-flow-guards");require("fs").mkdirSync(p,{recursive:true});process.stdout.write(p)')"
if command -v cygpath >/dev/null 2>&1; then
  GUARD_DIR="$(cygpath -u "$GUARD_DIR_RAW")"
else
  GUARD_DIR="$GUARD_DIR_RAW"
fi
if [ ! -d "$GUARD_DIR" ]; then
  echo "ABORT: cannot reach the guard folder ($GUARD_DIR_RAW -> $GUARD_DIR)." >&2
  exit 1
fi

RUNNER=""
if command -v timeout >/dev/null 2>&1; then RUNNER="timeout 300"; fi
if [ -z "$RUNNER" ]; then
  echo "NOTE: 'timeout' is not available — a hung session will hang this script." >&2
fi

# --- build the probe project ----------------------------------------------
# The hook requires ../scripts/config.js, so the probe keeps the plugin's layout.
mkdir -p "$SCRATCH/.claude/hooks" "$SCRATCH/.claude/scripts" "$SCRATCH/docs/pipeline/probe"
cp "$HOOK_DIR/stop.js" "$SCRATCH/.claude/hooks/stop.js"
cp "$HOOK_DIR/../scripts/config.js" "$SCRATCH/.claude/scripts/config.js"
echo '{ "stateDir": "docs/pipeline" }' > "$SCRATCH/.claude/task-flow.json"
cat > "$SCRATCH/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/stop.js\"", "timeout": 15 }
        ]
      }
    ]
  }
}
JSON

write_state() {
  cat > "$SCRATCH/docs/pipeline/probe/state.json" <<JSON
{ "task": "probe", "phase": "build", "status": "$1", "approvedBy": "user",
  "buildCursor": "T1", "updated": "2026-09-08T10:00:00Z" }
JSON
}

# Counts how many pushes the hook recorded during the probe, by reading the
# guard files it created after the marker. -1 means "the session never returned".
guards_since_marker() {
  local best=0 file value
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    value="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).consecutive||0))}catch(e){process.stdout.write("0")}' "$file")"
    [ "$value" -gt "$best" ] && best="$value"
  done <<EOF
$(find "$GUARD_DIR" -maxdepth 1 -name 'stop-*.json' -newer "$SCRATCH/.marker" 2>/dev/null)
EOF
  echo "$best"
}

# $1 label · $2 status to write · $3 expected pushes ("3" | "0") · $4 extra env
probe() {
  local label="$1" status="$2" expected="$3" envvar="${4:-}"
  TOTAL=$((TOTAL + 1))
  write_state "$status"
  touch "$SCRATCH/.marker"
  sleep 1

  local rc=0
  if [ -n "$envvar" ]; then
    ( cd "$SCRATCH" && env "$envvar" $RUNNER claude -p "Reply with the single word: banana" \
        --permission-mode acceptEdits >/dev/null 2>&1 ) || rc=$?
  else
    ( cd "$SCRATCH" && $RUNNER claude -p "Reply with the single word: banana" \
        --permission-mode acceptEdits >/dev/null 2>&1 ) || rc=$?
  fi

  if [ "$rc" -eq 124 ]; then
    echo "  FAIL  $label — the session never returned: the hook trapped it."
    FAILURES=$((FAILURES + 1))
    return
  fi

  local pushes
  pushes="$(guards_since_marker)"
  if [ "$pushes" = "$expected" ]; then
    echo "  ok    $label (pushes recorded: $pushes, session returned)"
  else
    echo "  FAIL  $label — expected $expected pushes, the guard recorded $pushes"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "Stop-hook end-to-end probes (each one starts a Claude session, so this is slow)"

# A: a live run is pushed, and the cap releases the session. Both halves matter:
#    3 pushes proves exit 2 was honoured, returning proves the cap works.
probe "A a live run is pushed and then released" "running" "3"

# B: a run waiting on the user must not be pushed at all.
probe "B a blocked run is left alone" "blocked" "0"

# C: the escape hatch reaches this hook too.
probe "C TASK_FLOW_GATE=off disables the push" "running" "0" "TASK_FLOW_GATE=off"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "$TOTAL/$TOTAL probes passed"
  exit 0
fi
echo "$FAILURES of $TOTAL probes failed"
exit 1
