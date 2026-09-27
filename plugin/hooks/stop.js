#!/usr/bin/env node
// The task-flow continuation hook: refuses to end the turn while a run is live.
//
// Why this exists. The skill says "chain every phase, stop only at the approval
// gate". That is an instruction, and instructions drift - the failure that
// actually happens is handing the turn back at the end of a phase because it
// looks like a good place to stop. The user then has to re-type the command,
// which is the whole thing this pipeline was supposed to remove. So the
// instruction gets an anchor outside the prose.
//
// It is the mirror of gate.js: the gate protects the step that is hard to undo,
// this one holds the automation up. Neither substitutes for the other.
//
// Two properties matter more than anything else here:
//
//   1. It FAILS OPEN. The gate fails closed, and that asymmetry is deliberate:
//      a gate that fails open lets unapproved code through, but a Stop hook that
//      fails closed locks the session. Unreadable payload, missing state,
//      corrupt JSON - every one of them lets the turn end.
//
//   2. It GIVES UP. Nothing upstream is relied on to break a loop, so the hook
//      tracks a signature of the run and stops pushing once three pushes in a row
//      have changed nothing. Pushing is only worth doing if it produces work, and
//      work moves state.json.
//
// It is also inert by default: it only pushes a run whose status is "running".
// Any other conversation in the repository ends its turn untouched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, stateDirOf } = require('../scripts/config.js');

const LET_IT_STOP = 0;
const KEEP_GOING = 2;

/** Pushes with an unchanged signature before the hook concedes the run is stuck. */
const MAX_PUSHES_WITHOUT_PROGRESS = 3;

const letItStop = (why) => {
  if (why) process.stderr.write(`STOP-HOOK: ${why}\n`);
  process.exit(LET_IT_STOP);
};

const keepGoing = (why, whatToDo) => {
  process.stderr.write(`STOP-HOOK: ${why}\n           ${whatToDo}\n`);
  process.exit(KEEP_GOING);
};

// --- the escape hatch comes first, and it is the same one as the gate ------
// One switch to remember, not two.
if (String(process.env.TASK_FLOW_GATE || '').toLowerCase() === 'off') {
  letItStop('off (TASK_FLOW_GATE=off) - the run is not being pushed.');
}

let payload;
try {
  payload = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch (error) {
  // Fail open. A payload we cannot read is no reason to trap the session.
  letItStop('the hook payload could not be parsed; letting the turn end.');
}

const projectDir = process.env.CLAUDE_PROJECT_DIR || payload.cwd || '';
if (!projectDir) letItStop();

// --- only in a project that opted in --------------------------------------
// Installed as a plugin, this hook runs on every turn of every repository on the
// machine. .claude/task-flow.json is the opt-in; without it, this turn is
// somebody's ordinary conversation.
//
// Runs are only read from inside the project: config.js refuses a stateDir that
// climbs out of it, which would let one repository's configuration push sessions
// on another's behalf.
let stateDir;
try {
  stateDir = stateDirOf(projectDir);
} catch (error) {
  // Fail open, like everything else in this hook.
  letItStop(`the task-flow configuration is not usable (${error.message}); this turn is not part of a run.`);
}
if (stateDir === null) letItStop();

/** Every run the pipeline currently knows about. Any failure here means "no runs". */
function readRuns() {
  const runs = [];
  for (const task of fs.readdirSync(stateDir)) {
    const statePath = path.join(stateDir, task, 'state.json');
    if (!fs.existsSync(statePath)) continue;
    try {
      runs.push(JSON.parse(fs.readFileSync(statePath, 'utf8')));
    } catch (error) {
      // One corrupt state.json must not hide the others, and must not block.
      continue;
    }
  }
  return runs;
}

let runs;
try {
  runs = readRuns();
} catch (error) {
  letItStop('no readable run state; this turn is not part of a run.');
}

// --- the safety net for the run's live view --------------------------------
// The skill tells the agent to re-render after every write to state.json, and
// that is the real trigger. This is the backstop for the turn where it forgot.
//
// It runs BEFORE the hook decides whether a run is live, and that ordering is the
// whole point. A run parked on a question is not "running", and it is exactly the
// run whose page the user opens: rendering only live runs would leave the one page
// that matters stale, advertising the wrong phase and no open questions.
//
// It must never change what this hook decides, so it stays wrapped: a renderer that
// throws, or that is missing entirely, leaves the hook exactly as it was.
try {
  require(path.join(__dirname, '..', 'scripts', 'render-run.js')).renderAll({ projectDir });
} catch (error) {
  process.stderr.write(`STOP-HOOK: the run view was not refreshed (${error.message}); carrying on.\n`);
}

// --- the task list must follow every phase change -------------------------
// Whoever owns the task list reads it, not the PR. SKILL.md makes updating it part
// of every phase change, and as prose that rule is the one that gets forgotten.
//
// The check is deliberately narrow. A run that records `phaseChangedAt` (ISO)
// promises the task list was written after it; if the file is older, the turn goes
// on until it is. Only the file's mtime is read - never its content, which belongs
// to the user - and a run without the field is not checked.
//
// It runs for any run, not only a "running" one: the approval gate and a block are
// phase changes the owner reads about too. It gives up after two pushes on the same
// phase change, because a task list another session keeps rewriting, or a clock
// that disagrees, must never trap the session. It cannot see WHICH row changed:
// another run writing the same file satisfies it. That is the price of not parsing
// a document the pipeline does not own.
const TASKS_SYNC_MAX_PUSHES = 2;
try {
  const loaded = loadConfig(projectDir);
  const tasksFile = loaded.ok ? loaded.config.tasksFile : null;
  if (tasksFile) {
    for (const run of runs) {
      const changedAt = Date.parse(String(run.phaseChangedAt || ''));
      if (!Number.isFinite(changedAt)) continue;
      let tasksTime;
      try {
        tasksTime = fs.statSync(tasksFile).mtimeMs;
      } catch (error) {
        continue; // the task list is gone: config.js reports that, not this hook
      }
      if (tasksTime >= changedAt) continue;

      const sessionKey = String(payload.session_id || 'nosession').replace(/[^A-Za-z0-9_-]/g, '');
      const guardPath = path.join(os.tmpdir(), `task-flow-tasks-${sessionKey}.json`);
      const signature = `${run.task}|${run.phaseChangedAt}`;
      let guard = { signature: null, consecutive: 0 };
      try {
        guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
      } catch (error) {
        // no guard yet
      }
      if (guard.signature !== signature) guard = { signature, consecutive: 0 };
      if (guard.consecutive >= TASKS_SYNC_MAX_PUSHES) {
        process.stderr.write(
          `STOP-HOOK: the task list is still older than the last phase change of "${run.task}"; ` +
            'not pushing again. Say so in the reply.\n'
        );
        break;
      }
      fs.writeFileSync(guardPath, JSON.stringify({ signature, consecutive: guard.consecutive + 1 }));
      keepGoing(
        `the task list was not updated after the last phase change of run "${run.task}".`,
        `Update this run's entry in ${tasksFile} now (its detail and the document links; its status only ` +
          'if this run created the entry), as SKILL.md §8b requires at every phase change, then carry on.'
      );
    }
  }
} catch (error) {
  // Fail open, like everything else in this hook.
  process.stderr.write(`STOP-HOOK: the task list was not checked (${error.message}); carrying on.\n`);
}

// A run is live when the skill said so. "running" is written when a run starts
// and cleared at each of its legitimate stops - the approval gate, a red test
// run, a genuine block - so the hook never has to guess.
const live = runs.find(
  (run) => String(run.status || '').toLowerCase() === 'running' && String(run.phase || '') !== 'done'
);

if (!live) letItStop();

// --- loop protection -------------------------------------------------------
// The signature is what a phase of real work necessarily changes. If it has not
// moved, the push did nothing, and pushing again will do nothing either.
const signature = [live.task, live.phase, live.buildCursor, live.updated].join('|');

const sessionKey = String(payload.session_id || 'nosession').replace(/[^A-Za-z0-9_-]/g, '');
const guardPath = path.join(os.tmpdir(), `task-flow-stop-${sessionKey}.json`);

let guard = { signature: null, consecutive: 0 };
try {
  guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
} catch (error) {
  // No guard yet, or an unreadable one: start the budget over.
}

if (guard.signature !== signature) guard = { signature, consecutive: 0 };

if (guard.consecutive >= MAX_PUSHES_WITHOUT_PROGRESS) {
  letItStop(
    `giving up: ${MAX_PUSHES_WITHOUT_PROGRESS} pushes made no progress on "${live.task}" ` +
      `(still ${live.phase}/${live.buildCursor || 'no cursor'}). Letting the turn end so the ` +
      'session is not trapped. Look at why the run is not advancing.'
  );
}

try {
  fs.writeFileSync(guardPath, JSON.stringify({ signature, consecutive: guard.consecutive + 1 }));
} catch (error) {
  // If the budget cannot be persisted, the hook cannot count - and a hook that
  // cannot count is exactly the trap this file exists to avoid.
  letItStop('the loop guard could not be written, so pushing would risk a loop.');
}

keepGoing(
  `run "${live.task}" is still ${live.phase} and its status is "running".`,
  'Carry on to the next phase. Do not hand the turn back: the only stops are the approval gate, ' +
    'a red test run, and a genuine block - and each of those takes status out of "running" first.'
);
