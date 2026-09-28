# task-flow — why the rules are the way they are

`SKILL.md` holds the rules. This file holds the reasons. Nothing here is an
instruction — if a line below seems to contradict `SKILL.md`, `SKILL.md` wins and
this file is out of date.

## Where it came from

task-flow started from a set of needs that kept coming back when running long,
multi-phase coding tasks with an agent: take a refined idea to a pull request in one
go; stop only where a person genuinely has to decide; keep a record of every
decision taken without asking; never let unapproved code be written; keep security
tests and positive/negative tests on every change; and be able to see, at a glance,
where each run is when several are in flight.

Before this skill existed, those needs had already been tried out in practice, in
earlier experiments on real projects. Those tests are what showed which rules held
and which ones drifted, and they are why the skill was written now, as one package.
Every rule below comes from something that went wrong, or nearly did, in them.

## Entering and leaving a run

- **One invocation per task.** Handing the turn back so the user has to re-type
  the command is the failure the whole pipeline exists to remove. A prose rule
  against it drifted, so the Stop hook (`stop.js`) became the anchor outside the
  prose — failing open, and giving up after three pushes that change nothing, so it
  can never trap a session.
- **The idea is an input, not a phase.** Shaping what to build is the user's
  (with idea-refine or interview-me); the command starts at the spec. A run with no
  idea artifact does not start.
- **Three required settings, checked by code.** The docs folder, the language and
  the task list differ from project to project and from person to person, and a
  pipeline that guessed them wrote to the wrong place. A rule in prose can be
  talked past; `config.js check` exits 1 and the skill stops on it.

## The gate and the stops

- **No source code while a run is unapproved** (`gate.js`). It is a guardrail
  against the careless `Write`, not a security boundary — an agent with Bash can
  always get around it. The real guarantee is that an `AskUserQuestion` answer
  cannot be fabricated.
- **The hooks are opt-in per repository.** A plugin enabled for the user runs its
  hooks in every project, and the gate fails closed; without the opt-in it would
  block code edits everywhere.
- **Auto mode.** For long runs the user starts and walks away from: everything is
  validated in the PR left open. Nothing else stops it; red tests become a draft PR,
  the shape of an exception, never a target.
- **The ceiling is three.** Three decisions waiting is when an attended run stops
  to ask — not five, and not rounded up because the run is going well.

## Deciding alone, and saying so

- **Every open question goes through a loop first.** Code questions are decided by
  the run on fixed criteria — protect the application, performance, best practices,
  clean code, KISS, DRY, YAGNI, no premature optimisation. Business questions are
  checked against the documents, task list first, with a second opinion from another
  agent; only what survives goes to the user.
- **Five rounds, rising effort, same model.** A subagent's effort comes only from its
  agent file, so there are five agent files, `second-opinion-low` to `-max`,
  identical but for `effort`.
- **Code decisions are logged ⚠️, not 🔹.** They do not count toward the three, but
  the user audits every one of them.
- **Only questions the loop could not settle count toward the three**, and in an
  auto run such a question parks its task instead of stopping the run — until
  nothing but pending tasks is left, because a PR without them would drop approved
  scope.
- **One questions file per run**, moved to `resolved/` once every item is answered.
  What sits directly under `questions/` is, by construction, only what still waits
  on the user. The move never overwrites another file of the same name, and never
  happens while the run is still building.

## Keeping the work small and visible

- **A fresh subagent per phase**, because a `/clear` between phases is what was
  wanted and an agent cannot clear itself mid-run.
- **The review is the `code-reviewer` persona**, split by area and run in parallel,
  with every blocking finding required to carry a concrete failure scenario that is
  checked before it is accepted.
- **Positive and negative tests on everything**; corner cases are added by the
  user as they show up in real use, not invented.
- **No task above 8 planning-poker points**, measured in joint time — the user's and
  the agent's together, never either alone. Long auto runs with very large tasks were
  hard to understand afterwards; smaller tasks are the ones both sides understand the
  same way. A task above 8 is split before the spec; splitting sizes the work, it
  does not cut it.
- **The security auditor and the reviewer run at low effort.** A published guide on
  getting the most out of recent Claude models relayed one tester's report that the
  lowest effort caught more bugs with fewer false alarms. That is a report, not a
  benchmark, and extending it to the security auditor is this pipeline's own bet —
  to be kept or reverted by what the first runs measure.
- **A message mid-run is folded in, not a restart**; the plan carries its own
  checklist and a discovered-tasks section; every brief says answered decisions are
  settled; every subagent reports what it could not confirm.

## The run page

- **Generated, never written.** A dashboard the agent updates by hand drifts the
  same way prose rules do, and a stale dashboard is worse than none because it is
  believed.
- **Rendered on every write to `state.json`**, with the Stop hook as a backstop for
  every run — including blocked and finished ones. A backstop that only rendered
  running runs left exactly the page people open, the one parked on a question,
  stale.
- **Ticks come from the plan's own state lines**, not from the cursor alone: a
  cursor parked on a discovered task (a list item, not a heading) once made a page
  show every task unticked while the plan held them all ticked.
- **Skipped and pending tasks are counted out.** Without `skippedTasks`, cancelled
  tasks read as done the moment a run closed.
- **Everything taken from `state.json` is text, not markup.** It is written by agents
  and edited by hand, and the page is read as generated truth, so no value from it
  may forge a heading, a link or a status line.
- **The task list follows every phase change, and the Stop hook checks it** — only
  the file's modification time, never its content — because whoever owns the task
  list reads it, not the PR, and the prose rule to update it was the one that got
  forgotten.

## A repository is untrusted input

A security review before the first public release looked at the plugin the way
an attacker would: someone who can commit to a repository the user later clones and
opens. The hooks run on every turn of every conversation there, so anything they
read from the repository is an input, never a fact.

- **A `docsDir` outside the repository needs the person's trust, per machine.** The
  Stop hook writes and deletes run pages under it on every turn; a committed
  configuration could otherwise point that at any folder, or at a network share that
  Windows would contact with the user's credentials. The trust is a project/folder
  pair kept in the home folder, so repointing `docsDir` needs trusting again, and
  network paths are refused outright.
- **Only folder variables expand.** The expansion is printed in messages the model
  reads, so an arbitrary variable was a way to show it a secret.
- **The renderer only deletes pages it generated**, and matches its own page names
  exactly: a suffix match let one run's name swallow another's.
- **The gate judges an edit by its result.** Checking the new text alone missed a
  key split across the old and new text, an escaped key, a renamed key and a
  non-string value; replaying the edit and parsing the file catches them all at
  once. Only an unfinished run's approval counts, because `state.json` stays in the
  repository and an old approval would otherwise keep the gate open for good.
- **Markdown that is instructions is not documentation.** Commands, agents and
  skills under a `.claude` folder, and a `CLAUDE.md` outside the project, need
  approval like code; the harness's own memory and plan folders do not.
- **A link is never "inside".** Containment was checked on the text of a path, and a
  committed link (a junction on Windows) makes an inside-looking path land anywhere.
  Links are detected without following them, so their target is never touched.
- **The hooks never echo `state.json`.** What a hook prints with exit 2 is read by
  the model as something to act on; a run is named by its folder, and phases and
  cursors only when they have the expected shape.
- **The gate fails closed on its own bugs too.** Exit 1 is a non-blocking hook error,
  so an uncaught exception would have let the write through.

## Questions as data, and the panel

A run's questions used to be a markdown page the agent wrote by hand. The only
thing a machine could read in it was a checkbox: no id per question, no options, no
answer as a field. That was enough to count what was open, and not enough for the
user to answer anywhere but the conversation - which meant finding the one session,
among several, that was waiting on them.

- **The questions are data, and the page is generated.** `questions.json` beside
  `state.json` holds them; the renderer writes the page, for the same reason it
  writes the run page: a page transcribed by hand drifts, and a stale page is
  believed. It lives in `stateDir` because the first questions come in the spec,
  before approval, and the gate blocks every non-markdown write until then - the
  gate lets exactly `<stateDir>/<run>/questions.json` through, like `state.json`.
- **The renderer checks the file, and never overwrites a page written by hand.** An
  invalid file leaves the previous page alone and fails the render loudly, even with
  `--quiet`, so the agent sees it. A hand-written page holds answers nothing else
  holds; runs that started with one keep it. Answers are escaped rather than
  stripped: they are the user's own words.
- **The panel never touches the documentation - not even to read it.** It is a local
  page over every project's runs. Rather than give it a path into projects and docs
  folders, task-flow leaves it a summary per project in a folder outside all of them
  (the feed), and the panel reads nothing else. It writes only answer files in its
  own folder; task-flow takes them in (`answers.js consume`) at points of its
  choosing. One writer per file, so nothing is ever merged.
- **An answer is data, never an instruction.** Whoever can write a file in the
  answers folder can put text in front of the model. So a submission is checked
  against a closed shape and the run as it is - the right project and run, open
  questions only, a choice among the options, bounded text without control
  characters, no field beyond an answer - by one function, which the panel also
  runs before it writes. What reaches the model sits inside a block marked as data.
  Nothing on the panel's path can approve a run.
- **Answers are taken between tasks, never inside one.** An answer changes what a
  task should do; folding it into a task half built mixes two intentions in one
  commit. On resume, at every cursor move and at every phase boundary is enough.
- **A stopped run waits for the panel in the background, after it is `blocked`.** A
  background command that finishes wakes the session; the Stop hook only pushes a
  `running` run, so writing `blocked` first is what lets the turn end cleanly. The
  wait only wakes for a submission `consume` would take: one it would refuse would
  otherwise wake the session again and again. `claude -p` does not wake on a
  background command, so the end-to-end probes cannot show it; an ordinary session
  has to.
- **The home view lists open runs, not every run.** Long-lived projects finish
  many runs, and a page that keeps listing them all buries the ones that still
  need the user. A finished run (`status: "done"` and nothing waiting on it) is
  left off the home view entirely instead of being dropped in with the open
  ones. (An earlier version folded it into a collapsed "finished" accordion per
  project instead, reachable in one click since its PR link and branch are
  still worth finding - dropped after the user asked to see only the open
  runs; if this is revisited, the run's own page and its docs `runs/finished/`
  folder are still there.) A finished run that still has something waiting on
  it (feed.mjs `waitsOnUser`) stays in the open list - being done is not the
  same as being closed out.
- **`CLAUDE_PROJECT_DIR` is not trusted blindly against `payload.cwd` any more.**
  Both hooks tried `CLAUDE_PROJECT_DIR` first because it is meant to be a stable
  anchor for the session's project root. But a background session that isolates
  its edits with `EnterWorktree` keeps that env var pointing at the original
  checkout for the whole session - it does not follow the worktree - while
  every real tool call, and `payload.cwd`, correctly target the worktree. An
  approved, running run then lived only under the worktree's `stateDir`, which
  the stale env var never looked at: `gate.js` blocked every write forever
  ("no unfinished run... has approvedBy filled"), and `stop.js` saw no running
  run at all and let the turn end. Both hooks now look for positive evidence
  before trusting `CLAUDE_PROJECT_DIR` over `payload.cwd`: `gate.js` checks
  which of the two candidates actually contains the file this call is writing;
  `stop.js` checks which of the two actually has a running run under its
  `stateDir`. Either can still win - this is not "prefer cwd", it is "prefer
  whichever one the evidence points at" - so the ordinary case (both point at
  the same project) is unchanged.
