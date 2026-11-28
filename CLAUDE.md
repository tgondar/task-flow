# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

A Claude Code plugin (`/task-flow`) that takes one refined idea to one pull request: spec → plan → build → tests → harden → review, a fresh subagent per phase, with security-harden and review always run before the PR, unasked (SKILL.md §4c). The repository is its own marketplace (`.claude-plugin/marketplace.json` → `./plugin`). There is no build step and no npm dependencies: everything executable is plain Node (≥ 20) using only the standard library.

## Commands

Each unit test file is a standalone script (no test framework) — run one file to run one suite:

```sh
node tests/config.test.js
node tests/config.github-project.test.js
node tests/config.bump-policy.test.js
node tests/stop.test.js
node tests/subagent-start.test.js
node tests/render-run.test.js
node tests/enable-autoupdate.test.js
node tests/questions.test.js
node tests/answers.test.js
node tests/standing-answers.test.js
node tests/standing-answers.promote.test.js
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
node tests/metrics.hooks.test.js
node tests/metrics.loops.join.security.test.js
node tests/metrics.io.security.test.js
node tests/metrics.loops.test.js
node tests/metrics.loops.security.test.js
node tests/metrics.loops.result.security.test.js
node tests/metrics.loops.render.test.js
node tests/metrics.loops.render.security.test.js
node tests/metrics.paperclip.test.js
node tests/metrics.paperclip.security.test.js
node tests/metrics.paperclip-loops.security.test.js
node tests/metrics.backfill.test.js
node tests/metrics.backfill.security.test.js
node tests/metrics.render.security.test.js
node tests/metrics.render.test.js
node tests/metrics.security.test.js
node tests/metrics.summary.security.test.js
node tests/metrics.test.js
node tests/metrics.tokens.security.test.js
node tests/metrics.tokens.test.js
node tests/metrics.time.test.js
node tests/metrics.time.security.test.js
node tests/check-version.test.js
node tests/send-to-paperclip.test.js
node tests/shim.test.js
node tests/skill-rules.docs.test.js
node tests/viewer.smoke.js     # headless Edge/Chrome over CDP; skipped without one
claude plugin validate .
```

End-to-end probes start real `claude -p` sessions (slow, need the CLI on PATH, not part of any CI gate):

```sh
bash tests/stop.e2e.sh
bash tests/subagent-start.e2e.sh
bash tests/loops.e2e.sh
```

E2E rules from `tests/stop.e2e.sh`: always use `--permission-mode acceptEdits` (otherwise a refusal may come from the permission prompt, not the hook); keep scratch projects outside `~/.claude` (Claude Code refuses writes there before hooks run); assert on facts (file exists) never on reply wording.

Tests that touch the renderer, the answers or the viewer redirect `LOCALAPPDATA`/`XDG_STATE_HOME` (as well as `HOME`/`USERPROFILE`) to a temp folder, so they never write the real feed. In Git Bash, prefix commands that pass `/…` arguments (e.g. `#/run/...`) with `MSYS_NO_PATHCONV=1`.

Config helper used by the skill: `node plugin/scripts/config.js check|trust|init [--project-dir <dir>] ...`. Renderer: `node plugin/scripts/render-run.js --quiet`.

## Architecture

The pipeline's **rules are prose** in `plugin/skills/task-flow/SKILL.md` (~1100 lines, sections §0–§8c). `HISTORY.md` beside it records *why* each rule exists; if they disagree, SKILL.md wins. The recurring design principle: any rule that drifted as prose gets an anchor in code (a hook or script). When changing a rule, update SKILL.md, add the reason to HISTORY.md, and check whether a hook/script enforces it.

Code pieces, all sharing one config reader:

- `plugin/scripts/config.js` — the **single** reader/validator of a target repo's `.claude/task-flow.json` (required: `docsDir`, `language`, `tasksFile`, and — by `check` only, not by the hooks/renderer — `githubProject`, a board object or `null` for none, written by `config.js github-projects`/`github-project`; optional `stateDir`, default `.claude/task-flow`; optional `bumpPolicy`, the project's semver level per class of change — `feature`/`fix` required, `breaking`/`restructure` optional, each `major`|`minor`|`patch`, one constant `BUMP_CLASSES` — validated by `check` only, refused next to `defaultBump: "calendar"`, written by `config.js bump-policy`; the rule that uses it is prose in SKILL.md §6/§7). Hooks and renderer both go through it, so there is one definition of "valid configuration". Config is treated as untrusted input: every path is resolved and contained (e.g. `stateDir` may not be `.`/`..` or escape the project). A `docsDir` outside the project is ignored (not even `stat`-ed) until the `{project, docsDir}` pair is listed in `~/.claude/task-flow-trusted.json` (`config.js trust`, or `init`); UNC/device paths are always refused. Only folder variables (`HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `OneDrive*`) expand in `docsDir`. `crossesLink` (lstat-only, never follows) makes any path through a symlink/junction count as outside — used for `docsDir`, `stateDir`, `tasksFile` and the renderer. Tests redirect `HOME`/`USERPROFILE` to a temp folder and call `trustDocsDir` in their fixtures.
- `plugin/hooks/stop.js` — Stop hook that keeps a run with status `running` from ending its turn. **Fails open** on every error (a fail-closed Stop hook locks the session) and gives up after 3 pushes with no state change (guard files in `~/.claude/task-flow-guards/`). Its exit-2 messages reach the model, so they never echo `state.json` text: a run is named by its folder, `phase`/`buildCursor` only when they match closed shapes. It also re-renders all run pages as a backstop and pushes (max 2 times) if `tasksFile` mtime is older than a run's `phaseChangedAt`, and pushes (max 2 times per set of ids, guard `loops-<session>`) while the live run has moved past the phase or `buildCursor` a subagent started in and that loop still has no `loop-result` — which loops is `metrics.js` `loopsWithoutResult`'s call; the message holds only the run's folder, a count, up to 10 ids re-checked against the agent-id shape and the command. A bounded ask, never a gate: on giving up or any error it decides as it would without the check; off with `TASK_FLOW_METRICS=off`. There used to be a PreToolUse approval gate (`gate.js`) beside it, blocking `Write`/`Edit`/`NotebookEdit` until a plan's `approvedBy` was filled; it was removed (see `plugin/skills/task-flow/HISTORY.md`) so that the pipeline never stops to ask for approval. `state.json`'s `approvedBy`/`approvedAt` fields stay, but only as a record of which mode (`attended`/`auto`) a run was in — nothing reads them as permission any more.
- `plugin/scripts/render-run.js` — generates `runs/<yyMMdd>_<slug>.md` pages in `docsDir` purely from `state.json` + the plan's task headings (never hand-written). Page strings exist for `en` and `pt-PT`; other languages fall back to English. The `state.json` field contract it depends on (`phase` = last stage *completed*, `buildCursor`, `artifacts` relative to `docsDir`, ISO `updated`/`phaseChangedAt`, `pendingTasks`) is documented in SKILL.md §8.
- `plugin/scripts/metrics.js` — the run-health measurement. When `renderAll` closes a finished run it appends one closed-shape row (counts, ratios, a model name, never free text) to `<stateDir>/metrics.jsonl` and the page gets a "Run health" section comparing the run with the project's own recent runs (last 8 of the same project and model, at least 5 needed; these constants are unmeasured guesses named at the top of the file). It reads `state.json` (`startedAt`, `phaseLog`, `health`; SKILL.md §8), the plan and questions file, git and the session transcripts under `~/.claude/projects` (tokens, deduplicated by `requestId`), all as untrusted input: a wrong shape is dropped, never echoed. **Fails open** on everything: information, never a gate, a failure never fails the run or the render, and no hook gates it (deliberately; the Stop hook only asks, boundedly, for missing loop results). `TASK_FLOW_METRICS=off` disables it, checked first. `render-run.js` requires it lazily (it imports `PHASES` from there). The history is per project and not ignored by git by default; it never edits a `.gitignore` or runs `git add`, and the user can add `<stateDir>/metrics.jsonl` to their own. `node plugin/scripts/metrics.js close --slug <slug>` re-measures a run. It also measures **each loop** (one execution of one agent): `appendLoopEvent`, called by the SubagentStart hook, writes one start event per subagent of the single running run to `<stateDir>/<run>/loop-events.jsonl`; `loop-result --slug <run> --agent <id> --outcome ok|retry|failed|unknown [--tests …] [--critical n] [--required n] [--round n] [--phase P] [--task T]`, run by the orchestrator, appends a result event (last per agent wins; its phase/task win over the start's); at the close the join pairs each start with its `agent-<id>.jsonl` transcript and appends one closed-shape row per loop to `<stateDir>/loops.jsonl` (key `source`+`run`+`id`, first row of a key wins, never written twice), which `render-run.js` reads only for the page's "Loops" section. On-demand CLIs that print one fixed `metrics: <code> <command>` line when they have nothing: `time --slug <run>` (the plan's `## Registo de tempo` row for the whole run window, from the orchestrator's main transcripts, writes nothing), `summary --slug <run>` (the PR's run-cost block: fresh tokens per phase, orchestrator, total, review rounds; never money; writes nothing), `paperclip --issue <n> [--paperclip-issue <id>]` (manual: paperclip's finished runs for that issue and its sub-issues as `source: "paperclip"` rows, cost in USD cents as paperclip reports it, `model` null; one bounded GET at a time through `paperclipGet`, trusted `paperclip.url` origin only, token only from `PAPERCLIP_TOKEN`, no redirects, 10 s per request and 60 s per command) and `backfill` (manual: subagent transcripts with no row yet as `backfill: true` rows, idempotent, never touches a `state.json`). New subcommands are dispatched by `runCommand`, defined before `closeRun` so the security suites' source slices stay unchanged. `TASK_FLOW_METRICS=off` turns every one of them into a no-op.
- `plugin/scripts/questions.js` — a run's questions as data, `<stateDir>/<run>/questions.json`, which can exist from the spec phase on, before the plan is even written. Validation reports fields, never values; `render-run.js` generates the questions page from it (never overwriting a hand-written one) and moves it to `questions/resolved/` when the run is done with nothing open. Runs without a `questions.json` keep their hand-written page.
- `plugin/hooks/subagent-start.js` — SubagentStart hook: every subagent of a live run starts with the project's standing answers. It prints `{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":…}}` holding only `standing-answers.js`'s `formatBlock` (it never parses the page itself), and only when the project opted in, `loadConfig` is `ok`, a run is `running` (`config.js` `hasRunningRun`, shared with `stop.js`) and the page has an accepted entry. Registered with no matcher (every agent type) and a 5 s timeout. The project is `CLAUDE_PROJECT_DIR`, or `payload.cwd` when the running run is there — but, unlike `stop.js`, `payload.cwd` only counts inside `CLAUDE_PROJECT_DIR` without a link, so a cloned repository's `running` state.json cannot hand its page to a session in another project; network/device paths are never examined. **Fails open**: any error is silence and exit 0, and it never writes to stderr. Inert without `.claude/task-flow.json`; `TASK_FLOW_GATE=off` disables it, checked first. Once the configuration is accepted, and before the page is read, it also calls `metrics.js` `appendLoopEvent` (required lazily, in a try of its own) to record the subagent's start event; that writer makes every decision (`TASK_FLOW_METRICS`, exactly one running run via `config.js` `runningRuns`, `agent_id`/`agent_type` in shape, nothing else of the payload read) and nothing of it reaches stdout or stderr.
- `plugin/scripts/standing-answers.js` — the **single** reader of a project's standing-answers page, `<docsDir>/standing-answers.md` (fixed name, not configurable): one closed-format line per rule the user stated once (`- **R<n>** · <rule> · «<words>» · <run> · yyyy-MM-dd [· substitui|replaces R<m>]`). The page is repository data: only a docsDir `config.js` accepted counts, a link/junction or non-plain file in its place is refused before a byte is read (`crossesLink`, lstat), size, entry count and field length are capped, lines with `questions.js`'s `CONTROL` characters are rejected and entries with a URL, network path, link, forged block delimiter or checkbox are "suspicious" (not used). Reports name line numbers, ids and fields, never the text. `formatBlock` puts the accepted entries as escaped JSON in a `<<<STANDING-ANSWERS` … `STANDING-ANSWERS>>>` data block. No page or a refused page is one line and the run goes on (`node plugin/scripts/standing-answers.js read`, always exit 0). It is also the **single** writer: `standing-answers.js promote --slug <run> --item Q<n> --rule "<rule>" [--replaces R<m>]`, called by the orchestrator per answer it judges a project rule (never automatic). It writes only from an item of that run's `questions.json` (through `questions.js` `readQuestionsFile`) with a recorded `answer`: the words are the `comment`, else `chose:`/`escolheu: <label of the chosen option>`; a status-only answer, an unanswered decision and an item already carrying `promotedAs` are refused (exit 1, nothing written). The new line goes through `parsePage` field by field and as the whole new page, so nothing the reader would refuse, flag or truncate is written. The id is past both the `<!-- task-flow: next R<n> -->` marker and every id on the page; other lines stay byte for byte; the write is a temp file + rename after re-reading the page (changed → retried, 3 tries, then refused), and every try re-reads the item and refuses when the page already has a line of the same run with the same rule and the same words. Afterwards the item gets `promotedAs: "R<n>"` (validated by `questions.js` and, in lockstep, by the viewer's `feed-logic.js`).
- The **viewer feed**: every `renderAll` also writes `<home>/feed/<projectKey>.json` (`config.js` `homeDir`/`homePath`/`projectKey`; `<home>` = `%LOCALAPPDATA%\task-flow`), atomically, in closed shapes, without the absolute docsDir. A feed failure is a note, never a render failure.
- `plugin/scripts/answers.js consume` — takes the viewer's submissions (`<home>/answers/<projectKey>/<run>/<id>.json`) into `questions.json`: closed shape, open questions only, no extra fields (no `approvedBy`), idempotent through `consumedSubmissions`; never deletes the viewer's files; prints answers inside a data block.
- `plugin/scripts/send-to-paperclip.js` — the `/task-flow paperclip` hand-off (SKILL.md §0d): POSTs idea+spec+plan to paperclip as an issue (trusted `paperclip.url`, token only from `PAPERCLIP_TOKEN`), flips the GitHub Project status through `gh`, and leaves the run at `phase: "plan"`, `status: "blocked"`. It records the created issue as `state.json` `paperclipIssueId` — the response's UUID `id`, else its `GON-12`-style `identifier`, else nothing (`paperclipIssueIdOf`) — so `metrics.js paperclip` can find it without reading `outcomeNote`; only that closed-shape id is ever written or printed.
- `plugin/viewer/` — the local viewer: a static page (`index.html`) opened directly in a browser, no server, no install (the scheduled-task panel and its `server.mjs` this replaced are gone - see HISTORY.md for why). `js/feed-logic.js` is the pure, Node-testable half (parsing a feed, building cards, checking an outgoing answer batch - ported from the questions.json validator in `scripts/questions.js`, kept in lockstep by hand); `js/data.js` and `js/store.js` are the browser-only half, reading `<home>/feed/` and writing `<home>/answers/<projectKey>/<run>/<id>.json` through a `FileSystemDirectoryHandle` the user grants once (File System Access API) and IndexedDB remembers. Every file under `js/` is a classic script attaching its exports to `window.TFV`, never `type="module"` or `fetch()` - both are refused by Chrome/Edge when the page is opened as `file://`, which is the whole point of not needing a server (see `js/dom.js`'s own comment). **The viewer must never read or write a docsDir** - that is the design's central promise carried over from the panel it replaced.
- `plugin/agents/` — `security-auditor`, `code-reviewer` (effort low) and `second-opinion-{low,medium,high,xhigh,max}`: identical agents at rising effort, one per round of the question loop (SKILL.md §3). Keep the five in sync when editing one.

Both hooks are inert in any repo without `.claude/task-flow.json` (the opt-in). `TASK_FLOW_GATE=off` disables both — the escape hatch is checked first.

Installation pieces: `install.ps1` (marketplace add, install at user scope, auto-update via `scripts/enable-autoupdate.js`, copies `shim/task-flow.md` to `~/.claude/commands/`). The shim only forwards to `task-flow:task-flow` and must hold no rules, but its `description`/`argument-hint` are what `/task-flow` shows: when a mode is added to the skill's frontmatter, add it to the shim too (`tests/shim.test.js` checks it in CI) and re-copy it to `~/.claude/commands/`.

## Conventions

- `plugin.json` carries a semver **`version`**, and Claude Code only ships a change to installed users when it goes up. Any commit that touches `plugin/` must raise it and add a `## X.Y.Z — yyyy-MM-dd` entry to `CHANGELOG.md`; `scripts/check-version.js` enforces both in CI (`.github/workflows/version.yml`). Changes outside `plugin/` (tests, README, `install.ps1`, `scripts/`) need no bump.
- Line endings: LF everywhere, CRLF for `*.ps1` (`.gitattributes`). `install.ps1` must stay ASCII-only (Windows PowerShell 5.1 reads BOM-less files as ANSI).
- Tests for the hooks are mostly security tests (path traversal, casing, backslash vs forward-slash paths on Windows, self-approval, malformed input) asserting on exit codes; new hook behavior needs cases of that kind.
- Comments explain *why* at length (see the file headers); match that style when editing.
