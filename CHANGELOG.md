# Changelog

Every change to `plugin/` raises the `version` in
`plugin/.claude-plugin/plugin.json` and adds an entry here, newest first
(`scripts/check-version.js` checks both in CI). Compare the version `/plugin`
shows with the top entry to know whether your install is current.

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
