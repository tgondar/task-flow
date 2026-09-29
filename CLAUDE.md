# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

A Claude Code plugin (`/task-flow`) that takes one refined idea to one pull request: spec → plan → build → tests → harden → review, a fresh subagent per phase, with a single planned stop (the approval gate). The repository is its own marketplace (`.claude-plugin/marketplace.json` → `./plugin`). There is no build step and no npm dependencies: everything executable is plain Node (≥ 20) using only the standard library.

## Commands

Each unit test file is a standalone script (no test framework) — run one file to run one suite:

```sh
node tests/config.test.js
node tests/gate.test.js
node tests/stop.test.js
node tests/render-run.test.js
node tests/enable-autoupdate.test.js
node tests/questions.test.js
node tests/answers.test.js
node tests/viewer-feed-logic.test.js
node tests/metrics.baseline.security.test.js
node tests/metrics.close.security.test.js
node tests/metrics.close.test.js
node tests/metrics.collect.security.test.js
node tests/metrics.collect.test.js
node tests/metrics.docs.test.js
node tests/metrics.e2e.test.js
node tests/metrics.git.security.test.js
node tests/metrics.git.test.js
node tests/metrics.hardening.test.js
node tests/metrics.hooks.security.test.js
node tests/metrics.hooks.test.js
node tests/metrics.io.security.test.js
node tests/metrics.render.security.test.js
node tests/metrics.render.test.js
node tests/metrics.security.test.js
node tests/metrics.test.js
node tests/metrics.tokens.security.test.js
node tests/metrics.tokens.test.js
node tests/viewer.smoke.js     # headless Edge/Chrome over CDP; skipped without one
claude plugin validate .
```

End-to-end probes start real `claude -p` sessions (slow, need the CLI on PATH, not part of any CI gate):

```sh
bash tests/gate.e2e.sh
bash tests/stop.e2e.sh
```

E2E rules from `tests/gate.e2e.sh`: always use `--permission-mode acceptEdits` (otherwise a refusal may come from the permission prompt, not the hook); keep scratch projects outside `~/.claude` (Claude Code refuses writes there before hooks run); assert on facts (file exists) never on reply wording.

Tests that touch the renderer, the answers or the viewer redirect `LOCALAPPDATA`/`XDG_STATE_HOME` (as well as `HOME`/`USERPROFILE`) to a temp folder, so they never write the real feed. In Git Bash, prefix commands that pass `/…` arguments (e.g. `#/run/...`) with `MSYS_NO_PATHCONV=1`.

Config helper used by the skill: `node plugin/scripts/config.js check|trust|init [--project-dir <dir>] ...`. Renderer: `node plugin/scripts/render-run.js --quiet`.

## Architecture

The pipeline's **rules are prose** in `plugin/skills/task-flow/SKILL.md` (~1100 lines, sections §0–§8c). `HISTORY.md` beside it records *why* each rule exists; if they disagree, SKILL.md wins. The recurring design principle: any rule that drifted as prose gets an anchor in code (a hook or script). When changing a rule, update SKILL.md, add the reason to HISTORY.md, and check whether a hook/script enforces it.

Code pieces, all sharing one config reader:

- `plugin/scripts/config.js` — the **single** reader/validator of a target repo's `.claude/task-flow.json` (required: `docsDir`, `language`, `tasksFile`; optional `stateDir`, default `.claude/task-flow`). Hooks and renderer both go through it, so there is one definition of "valid configuration". Config is treated as untrusted input: every path is resolved and contained (e.g. `stateDir` may not be `.`/`..` or escape the project). A `docsDir` outside the project is ignored (not even `stat`-ed) until the `{project, docsDir}` pair is listed in `~/.claude/task-flow-trusted.json` (`config.js trust`, or `init`); UNC/device paths are always refused. Only folder variables (`HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `OneDrive*`) expand in `docsDir`. `crossesLink` (lstat-only, never follows) makes any path through a symlink/junction count as outside — used for `docsDir`, `stateDir`, `tasksFile`, the gate and the renderer. Tests redirect `HOME`/`USERPROFILE` to a temp folder and call `trustDocsDir` in their fixtures.
- `plugin/hooks/gate.js` — PreToolUse on `Write|Edit|NotebookEdit`. Blocks writes unless some unfinished run (`phase` ≠ `done`, `status` ∉ `done`/`failed`) under `<stateDir>/<task>/state.json` has a non-empty `approvedBy`. Exempt without approval: `state.json` and `.md` inside `stateDir`, and other `.md` — except "instruction" markdown (anything under a `.claude/` folder other than `~/.claude/projects/*/memory/` and `~/.claude/plans/`, or a `CLAUDE.md` outside the project) and any path through a link inside the project. The `state.json` exemption excludes any write that would *set* `approvedBy` on a not-yet-approved state.json (anti self-approval): the gate replays the Write/Edit/`edits[]` on the current file, `JSON.parse`s the result, and blocks if it would become approved (or if the edit can't be replayed). Only a non-empty string `approvedBy` counts. **Fails closed** (exit 2) on unparseable payload/config/state in an opted-in repo, and on its own uncaught exceptions (exit 1 would be non-blocking). It is a drift guardrail, not a security boundary (Bash bypasses it).
- `plugin/hooks/stop.js` — Stop hook that keeps a run with status `running` from ending its turn. **Fails open** on every error (a fail-closed Stop hook locks the session) and gives up after 3 pushes with no state change (guard files in `~/.claude/task-flow-guards/`). Its exit-2 messages reach the model, so they never echo `state.json` text: a run is named by its folder, `phase`/`buildCursor` only when they match closed shapes. It also re-renders all run pages as a backstop and pushes (max 2 times) if `tasksFile` mtime is older than a run's `phaseChangedAt`. The fail-closed/fail-open asymmetry between the two hooks is deliberate — preserve it.
- `plugin/scripts/render-run.js` — generates `runs/<yyMMdd>_<slug>.md` pages in `docsDir` purely from `state.json` + the plan's task headings (never hand-written). Page strings exist for `en` and `pt-PT`; other languages fall back to English. The `state.json` field contract it depends on (`phase` = last stage *completed*, `buildCursor`, `artifacts` relative to `docsDir`, ISO `updated`/`phaseChangedAt`, `pendingTasks`) is documented in SKILL.md §8.
- `plugin/scripts/metrics.js` — the run-health measurement. When `renderAll` closes a finished run it appends one closed-shape row (counts, ratios, a model name, never free text) to `<stateDir>/metrics.jsonl` and the page gets a "Run health" section comparing the run with the project's own recent runs (last 8 of the same project and model, at least 5 needed; these constants are unmeasured guesses named at the top of the file). It reads `state.json` (`startedAt`, `phaseLog`, `health`; SKILL.md §8), the plan and questions file, git and the session transcripts under `~/.claude/projects` (tokens, deduplicated by `requestId`), all as untrusted input: a wrong shape is dropped, never echoed. **Fails open** on everything: information, never a gate, a failure never fails the run or the render, and no hook enforces it (deliberately). `TASK_FLOW_METRICS=off` disables it, checked first. `render-run.js` requires it lazily (it imports `PHASES` from there). The history is per project and not ignored by git by default; it never edits a `.gitignore` or runs `git add`, and the user can add `<stateDir>/metrics.jsonl` to their own. `node plugin/scripts/metrics.js close --slug <slug>` re-measures a run.
- `plugin/scripts/questions.js` — a run's questions as data, `<stateDir>/<run>/questions.json` (the gate lets exactly that path through before approval). Validation reports fields, never values; `render-run.js` generates the questions page from it (never overwriting a hand-written one) and moves it to `questions/resolved/` when the run is done with nothing open. Runs without a `questions.json` keep their hand-written page.
- The **viewer feed**: every `renderAll` also writes `<home>/feed/<projectKey>.json` (`config.js` `homeDir`/`homePath`/`projectKey`; `<home>` = `%LOCALAPPDATA%\task-flow`), atomically, in closed shapes, without the absolute docsDir. A feed failure is a note, never a render failure.
- `plugin/scripts/answers.js consume` — takes the viewer's submissions (`<home>/answers/<projectKey>/<run>/<id>.json`) into `questions.json`: closed shape, open questions only, no extra fields (no `approvedBy`), idempotent through `consumedSubmissions`; never deletes the viewer's files; prints answers inside a data block.
- `plugin/viewer/` — the local viewer: a static page (`index.html`) opened directly in a browser, no server, no install (the scheduled-task panel and its `server.mjs` this replaced are gone - see HISTORY.md for why). `js/feed-logic.js` is the pure, Node-testable half (parsing a feed, building cards, checking an outgoing answer batch - ported from the questions.json validator in `scripts/questions.js`, kept in lockstep by hand); `js/data.js` and `js/store.js` are the browser-only half, reading `<home>/feed/` and writing `<home>/answers/<projectKey>/<run>/<id>.json` through a `FileSystemDirectoryHandle` the user grants once (File System Access API) and IndexedDB remembers. Every file under `js/` is a classic script attaching its exports to `window.TFV`, never `type="module"` or `fetch()` - both are refused by Chrome/Edge when the page is opened as `file://`, which is the whole point of not needing a server (see `js/dom.js`'s own comment). **The viewer must never read or write a docsDir** - that is the design's central promise carried over from the panel it replaced.
- `plugin/agents/` — `security-auditor`, `code-reviewer` (effort low) and `second-opinion-{low,medium,high,xhigh,max}`: identical agents at rising effort, one per round of the question loop (SKILL.md §3). Keep the five in sync when editing one.

Hooks are inert in any repo without `.claude/task-flow.json` (the opt-in). `TASK_FLOW_GATE=off` disables both hooks — the escape hatch is checked first in each.

Installation pieces: `install.ps1` (marketplace add, install at user scope, auto-update via `scripts/enable-autoupdate.js`, copies `shim/task-flow.md` to `~/.claude/commands/`). The shim only forwards to `task-flow:task-flow` and must hold no rules.

## Conventions

- `plugin.json` intentionally has **no `version`**: the commit SHA is the version, so every commit on `main` ships as an update to installed users.
- Line endings: LF everywhere, CRLF for `*.ps1` (`.gitattributes`). `install.ps1` must stay ASCII-only (Windows PowerShell 5.1 reads BOM-less files as ANSI).
- Tests for the hooks are mostly security tests (path traversal, casing, backslash vs forward-slash paths on Windows, self-approval, malformed input) asserting on exit codes; new hook behavior needs cases of that kind.
- Comments explain *why* at length (see the file headers); match that style when editing.
