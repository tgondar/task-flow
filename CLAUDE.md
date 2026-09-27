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
claude plugin validate .
```

End-to-end probes start real `claude -p` sessions (slow, need the CLI on PATH, not part of any CI gate):

```sh
bash tests/gate.e2e.sh
bash tests/stop.e2e.sh
```

E2E rules from `tests/gate.e2e.sh`: always use `--permission-mode acceptEdits` (otherwise a refusal may come from the permission prompt, not the hook); keep scratch projects outside `~/.claude` (Claude Code refuses writes there before hooks run); assert on facts (file exists) never on reply wording.

Config helper used by the skill: `node plugin/scripts/config.js check|init [--project-dir <dir>] ...`. Renderer: `node plugin/scripts/render-run.js --quiet`.

## Architecture

The pipeline's **rules are prose** in `plugin/skills/task-flow/SKILL.md` (~1100 lines, sections §0–§8c). `HISTORY.md` beside it records *why* each rule exists; if they disagree, SKILL.md wins. The recurring design principle: any rule that drifted as prose gets an anchor in code (a hook or script). When changing a rule, update SKILL.md, add the reason to HISTORY.md, and check whether a hook/script enforces it.

Code pieces, all sharing one config reader:

- `plugin/scripts/config.js` — the **single** reader/validator of a target repo's `.claude/task-flow.json` (required: `docsDir`, `language`, `tasksFile`; optional `stateDir`, default `.claude/task-flow`). Hooks and renderer both go through it, so there is one definition of "valid configuration". Config is treated as untrusted input: every path is resolved and contained (e.g. `stateDir` may not be `.`/`..` or escape the project). A `docsDir` outside the project is ignored (not even `stat`-ed) until the `{project, docsDir}` pair is listed in `~/.claude/task-flow-trusted.json` (`config.js trust`, or `init`); UNC/device paths are always refused. Tests redirect `HOME`/`USERPROFILE` to a temp folder and call `trustDocsDir` in their fixtures.
- `plugin/hooks/gate.js` — PreToolUse on `Write|Edit|NotebookEdit`. Blocks writes of non-Markdown files unless some `<stateDir>/<task>/state.json` has a non-empty `approvedBy`. Writes inside `stateDir` are allowed, except any write that would *set* `approvedBy` on a not-yet-approved state.json (anti self-approval): the gate replays the Write/Edit/`edits[]` on the current file, `JSON.parse`s the result, and blocks if it would become approved (or if the edit can't be replayed). Only a non-empty string `approvedBy` counts. **Fails closed** (exit 2) on unparseable payload/config/state in an opted-in repo. It is a drift guardrail, not a security boundary (Bash bypasses it).
- `plugin/hooks/stop.js` — Stop hook that keeps a run with status `running` from ending its turn. **Fails open** on every error (a fail-closed Stop hook locks the session) and gives up after 3 pushes with no state change (signature stored in `os.tmpdir()`). It also re-renders all run pages as a backstop and pushes (max 2 times) if `tasksFile` mtime is older than a run's `phaseChangedAt`. The fail-closed/fail-open asymmetry between the two hooks is deliberate — preserve it.
- `plugin/scripts/render-run.js` — generates `runs/<yyMMdd>_<slug>.md` pages in `docsDir` purely from `state.json` + the plan's task headings (never hand-written). Page strings exist for `en` and `pt-PT`; other languages fall back to English. The `state.json` field contract it depends on (`phase` = last stage *completed*, `buildCursor`, `artifacts` relative to `docsDir`, ISO `updated`/`phaseChangedAt`, `pendingTasks`) is documented in SKILL.md §8.
- `plugin/agents/` — `security-auditor`, `code-reviewer` (effort low) and `second-opinion-{low,medium,high,xhigh,max}`: identical agents at rising effort, one per round of the question loop (SKILL.md §3). Keep the five in sync when editing one.

Hooks are inert in any repo without `.claude/task-flow.json` (the opt-in). `TASK_FLOW_GATE=off` disables both hooks — the escape hatch is checked first in each.

Installation pieces: `install.ps1` (marketplace add, install at user scope, auto-update via `scripts/enable-autoupdate.js`, copies `shim/task-flow.md` to `~/.claude/commands/`). The shim only forwards to `task-flow:task-flow` and must hold no rules.

## Conventions

- `plugin.json` intentionally has **no `version`**: the commit SHA is the version, so every commit on `main` ships as an update to installed users.
- Line endings: LF everywhere, CRLF for `*.ps1` (`.gitattributes`). `install.ps1` must stay ASCII-only (Windows PowerShell 5.1 reads BOM-less files as ANSI).
- Tests for the hooks are mostly security tests (path traversal, casing, backslash vs forward-slash paths on Windows, self-approval, malformed input) asserting on exit codes; new hook behavior needs cases of that kind.
- Comments explain *why* at length (see the file headers); match that style when editing.
