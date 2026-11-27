# Changelog

Every change to `plugin/` raises the `version` in
`plugin/.claude-plugin/plugin.json` and adds an entry here, newest first
(`scripts/check-version.js` checks both in CI). Compare the version `/plugin`
shows with the top entry to know whether your install is current.

## 2.4.0 — 2026-11-27

- **Each loop is measured** (one execution of one agent): the SubagentStart hook
  writes a start event per subagent of a live run to
  `<stateDir>/<run>/loop-events.jsonl`, and the close joins it with the loop's
  transcript (`agent-<id>.jsonl`: tokens, duration, effort) into one closed-shape
  row in `<stateDir>/loops.jsonl`, the same shape for task-flow and paperclip.
- **`metrics.js loop-result`**: the orchestrator records each loop's result in
  closed values after every subagent (§1b); the phase and task of the result win
  over the start's. The **Stop hook asks** for the result of loops the run has
  moved past, at most twice per set of ids, then gives up — information, not a
  gate.
- **"Loops" section** on the run page: one line per loop, and tokens and
  durations per phase.
- **`metrics.js time`** computes the run's time row from the orchestrator's own
  transcripts (one row for the run window), and **`metrics.js summary`** prints
  the cost block for the PR body, written when the PR opens. Tokens only on the
  task-flow side; no price table.
- **Paperclip**: `send-to-paperclip.js` keeps the hand-off issue's id as
  `paperclipIssueId` in `state.json`. `metrics.js paperclip --issue N`, run by
  hand, reads the paperclip API through a bounded, read-only request and records
  its runs as loop rows (cost kept as US dollar cents, as the API reports it; no
  model, since the API reports none). The API's shape was measured on
  2026-11-27.
- **`metrics.js backfill`**, run by hand only, turns earlier subagent transcripts
  into loop rows (`backfill: true`, `unknown` where time alone cannot tell).
- Every new file and response is untrusted input: closed shapes, nothing echoed,
  every failure fails open. `TASK_FLOW_METRICS=off` switches all of it off. The
  `.gitignore` note (§8b) now also covers `loops.jsonl` and
  `*/loop-events.jsonl`; the script never edits a `.gitignore`.

## 2.3.0 — 2026-11-27

- **Security-harden and review always run** before the PR, unasked, in both
  modes (§4c). The performance pass is no longer asked either: it runs only
  when the spec or plan names a performance requirement, otherwise it is a fact
  under `## Found`. `/task-flow review <PR>` and paperclip mode are unchanged.
- Three warnings are **facts, not decisions** (§6): performance not run, a plan
  estimate above the pre-estimate, and task-split granularity go under
  `## Found`, never into `questions.json` or `## Needs you`. Each decision to
  review is listed in one place, `questions.json`; the `_log.md` cites `Q<n>`.
  Only a passage from a source this run did not write closes a question "by
  document".
- **Standing answers per project**: `<docsDir>/standing-answers.md`, one rule
  per line with the user's words, origin run and date.
  `scripts/standing-answers.js read` is its single reader (closed line shape,
  path containment, size and entry limits, control/invisible/bidi characters
  refused, URLs and delimiter imitations flagged, replaced entries dropped);
  `promote` is its single writer, only from an answered `questions.json` item
  (`promotedAs` records it). The §3 question loop reads the page first; new
  entries are listed under `## Needs you` with how to undo.
- New **SubagentStart hook** (`hooks/subagent-start.js`): while a run is
  `running`, every subagent starts with the page's valid entries as a delimited
  data block. Fails open, inert without the opt-in, off with
  `TASK_FLOW_GATE=off`.
- **`bumpPolicy`** (optional) in `.claude/task-flow.json`: a level per change
  class (`feature`, `fix` required; `breaking`, `restructure` optional). The
  run's bump is the highest level among the classes present; an uncovered class
  stops once and the user's answer is written with `config.js bump-policy`.
  Validated only by `check`; refused next to `defaultBump: "calendar"`.

## 2.2.0 — 2026-11-03

- Review (§4d): a finding on code the branch neither touches nor makes
  reachable is marked **Pre-existing**. It never blocks and is not fixed in the
  branch; it goes to the PR body and the `backlogFile`, and a pre-existing
  Critical is listed under `## Needs you`. The orchestrator checks the mark
  against the branch diff before accepting it.
- Review (§4d): when the target repository has a `REVIEW.md` at its root, every
  reviewer is told to read it first (what failure looks like there, paths to
  skip, what not to raise). It never lowers the evidence rule.
- PR body and closing summary (§8b): a fourth heading, `## How to revert`
  (`## Como reverter` in pt-PT) — by default "revert the merge commit", plus
  everything a revert does not undo (applied migrations, converted data,
  environment values, external state such as issues or Project statuses).

## 2.1.0 — 2026-10-30

- `paperclip.projectId` (optional) in `.claude/task-flow.json`: the paperclip
  project the hand-off issue is filed under. Its workspace is what tells
  paperclip's agents which repository to clone; without it the issue arrived
  with no repository. `send-to-paperclip.js` refuses a value that is not a UUID,
  before any request, without echoing it.

## 2.0.0 — 2026-10-28

**Breaking:** `config.js check` now also requires `githubProject` in
`.claude/task-flow.json`. Every configured repository is asked once, at its next
`/task-flow`, which GitHub Project board its tasks live on — or none, in which case
`/task-flow paperclip` is unavailable there. An `auto` run in a repository that has
not answered stops at §0 until it does.

- `config.js github-projects` lists the boards linked to the repository's
  `origin` (with their Status options); `config.js github-project <number>|none
  [--ready-option <name>]` writes the answer, reading every id from GitHub.
- The hooks and the renderer do not require it: run pages and the Stop hook keep
  working in a repository that has not answered yet.
- `send-to-paperclip.js` now shares config.js's validation and text cleaning, and
  stops with the fix when the repository answered "no board".
- Security: on Windows, `git`/`gh` are never looked up in the repository folder
  (a committed `git.exe` cannot run instead of the real one), and `init`/
  `github-project` refuse to write through a linked `.claude` folder or file.

## 1.1.0 — 2026-10-28

- `/task-flow paperclip <issue> [description]`: the text after the issue number
  is the description; with none, the slug comes from the issue's title
  (`send-to-paperclip.js --issue-title`, one cleaned line, read as data).
- The idea file that names `#<issue>` is preferred as the run's input.
- A paperclip run records `paperclipIssue` in `state.json`: it is found again by
  issue number, stays a paperclip run on any resume (never builds here), and
  `send-to-paperclip.js` refuses a different `--github-issue` than the recorded one.

## 1.0.1 — 2026-10-28

- The `/task-flow` description and argument hint now mention
  `paperclip <GitHub issue number>` (it was missing from both the skill and the
  `~/.claude/commands/task-flow.md` forwarder).

## 1.0.0 — 2026-10-28

First versioned release. Until now the commit SHA was the version; the last
unversioned commit was `217b70d`. Includes everything up to it, notably:

- `/task-flow paperclip <issue>`: spec and plan here, then hand the combined
  documents to a paperclip agent org and flip the GitHub Project item to Ready
  (`scripts/send-to-paperclip.js`, `config.js trust-paperclip`).
- The plan-approval gate (`gate.js`) removed; the pipeline's one planned stop is
  before security-harden and review.
- The local viewer (`plugin/viewer/`), decoupled from FluidPlan.
