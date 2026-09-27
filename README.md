# task-flow

A Claude Code plugin that takes one refined idea to one pull request, in one
command: spec → plan → build → tests → harden → review, a fresh subagent per phase,
with an approval gate before any code is written, a continuation hook that keeps the
run going, and a generated page that shows where every run is.

```
/task-flow <the task, in your own words>
/task-flow auto <the task>          # unattended; read every decision in the PR
/task-flow                          # resume the run in flight
```

## What it does

- **Starts from a refined idea**, never from nothing: a run needs an idea document
  in the docs folder before it begins.
- **One planned stop** — the approval gate between plan and build. Everything else
  is decided, written into a decision log, and counted; after three decisions that
  only a person can take, an attended run stops and asks.
- **Auto mode** for long runs: nothing stops it, and the PR carries every decision
  it took without asking.
- **Security tests on every task**, written by a security-auditor subagent on that
  task's diff, and **positive and negative tests** on every changed behaviour.
- **A review before the PR exists**, split by area, where a blocking finding has to
  come with a concrete failure scenario.
- **A live page per run** (`runs/<date>_<slug>.md` in the docs folder), generated
  from the run's state, never written by hand.
- **Documents in your language**: `EN`, `PT-PT`, or any language tag.

## Requirements

- [Claude Code](https://code.claude.com) with the `claude` CLI on `PATH`.
- Node.js 20 or later (the hooks, the configuration check and the renderer are
  plain Node scripts with no dependencies).
- The [agent-skills](https://github.com/addyosmani/agent-skills) plugin, installed
  as `agent-skills@addy-agent-skills`: task-flow delegates the method (spec,
  planning, TDD, review personas) to it rather than reimplementing it.
- `gh`, authenticated, for opening pull requests.

## Install (once per machine)

```powershell
git clone https://github.com/tgondar/task-flow
powershell -ExecutionPolicy Bypass -File task-flow\install.ps1
```

Then open a new Claude Code session. `install.ps1` adds this repository as a
marketplace, installs the plugin at user scope, switches on auto-update for it, and
puts a small forwarder at `~/.claude/commands/task-flow.md` so the pipeline is
invoked as `/task-flow` (plugin skills can otherwise only be called with their
prefix, `/task-flow:task-flow`).

`install.ps1` is PowerShell. On macOS or Linux, the same three steps are
`claude plugin marketplace add tgondar/task-flow`,
`claude plugin install task-flow@task-flow`, and copying `shim/task-flow.md` to
`~/.claude/commands/`.

## Configure a repository

A repository opts in with a `.claude/task-flow.json`. Three values are
**required** — without them the skill does not start, and the first `/task-flow` in
the repository asks for them:

| Field | What it is | Example |
|---|---|---|
| `docsDir` | Base folder for specs, plans, logs, questions and run pages. Absolute, relative to the repository, or with an environment variable so one committed value works on every machine. | `docs/task-flow`, `%OneDrive%/notes/my-project`, `~/notes/my-project` |
| `language` | Language of every document, label and PR body the run writes. | `EN` (default), `PT-PT` |
| `tasksFile` | The project's task list, relative to `docsDir`. | `tasks/index.md` |

You can also set them yourself:

```sh
node <plugin>/scripts/config.js init --docs-dir docs/task-flow --language EN --tasks-file tasks/index.md
node <plugin>/scripts/config.js check
```

Optional fields: `stateDir` (where runs keep `state.json`, default
`.claude/task-flow`), `versionFiles`, `defaultBump`, `branches` (`from`, `prefix`,
`neverMerge`), `preflightSkill`, `commands`, `testProjects`, `backlogFile`.

```json
{
  "docsDir": "docs/task-flow",
  "language": "EN",
  "tasksFile": "tasks/index.md",
  "versionFiles": ["src/App/App.csproj"],
  "defaultBump": "patch",
  "branches": { "from": "origin/develop", "prefix": "feature/", "neverMerge": ["develop", "main"] },
  "commands": { "build": "dotnet build", "test": "dotnet test" },
  "testProjects": ["tests/App.UnitTests"]
}
```

Without that file the plugin's hooks do nothing in the repository, and `/task-flow`
says it is not configured.

A `docsDir` **outside the repository** has to be trusted once per machine, because
the configuration travels with the repository and the hooks write run pages there.
`init` trusts the folder you give it; for a configuration that came with a clone,
confirm the folder and run `node <plugin>/scripts/config.js trust`. Trusted
folders are listed in `~/.claude/task-flow-trusted.json`, one entry per repository
and folder, so pointing a repository somewhere else needs trusting again. Network
paths (`\\host\share`) are never accepted.

## Where things go

Inside `docsDir`:

```
ideas/yyMMdd_<slug>.md                  the refined idea (yours, before the run)
specs/yyMMdd_<slug>.md                  written by the run
plans/yyMMdd_<slug>.plan.md             the plan, and the run's own checklist
questions/yyMMdd_<slug>_questions.md    what is waiting for you
questions/resolved/                     answered, once the run closes
runs/yyMMdd_<slug>.md                   the live page (generated)
runs/finished/                          finished runs with nothing left open
```

Inside the repository: `.claude/task-flow.json`, the runs' `state.json` under
`stateDir`, and review reports under `.claude/reviews/`.

## How updates arrive

`plugin.json` deliberately has **no `version`**. Claude Code then uses the commit
SHA as the version, so every commit on `main` is an update; with auto-update on,
sessions pick it up in the background (or run `/plugin marketplace update task-flow`
to force it, and `/reload-plugins` inside a running session).

## Trust model

Know what you are installing:

- **The hooks run on every turn, in every repository**, as you. They act only where
  `.claude/task-flow.json` exists, but the code runs everywhere.
- **Every commit on `main` reaches you** through auto-update, with no release step
  in between. Installing task-flow means trusting this repository's `main` the way
  you trust any code you run. If you would rather review updates first, turn
  auto-update off for the marketplace (`autoUpdate` in `~/.claude/settings.json`)
  and update by hand with `/plugin marketplace update task-flow`.
- **The review personas come from a second plugin**, agent-skills, which updates
  on its own schedule. `agents/security-auditor.md` and `agents/code-reviewer.md`
  load its persona files at run time.
- **A repository's configuration is untrusted input.** Paths in
  `.claude/task-flow.json` are contained and checked; a `docsDir` outside the
  repository needs your per-machine trust; only folder variables (`HOME`,
  `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `OneDrive*`) expand in it; and nothing
  from a run's `state.json` is echoed back to the model by the hooks.
- **The approval gate is a guardrail, not a sandbox.** It stops code being written
  by drift before a plan is approved. It does not stop an agent determined to get
  around it (Bash is not gated), and it is not meant to.

## Layout

```
.claude-plugin/marketplace.json   this repository is its own marketplace
plugin/
  .claude-plugin/plugin.json
  skills/task-flow/SKILL.md       the pipeline (the rules)
  skills/task-flow/HISTORY.md     why each rule is the way it is
  agents/                         security-auditor, code-reviewer at effort: low;
                                  second-opinion-low..max, the question loop (SKILL.md §3)
  hooks/hooks.json, gate.js, stop.js
  scripts/config.js               reads and validates .claude/task-flow.json
  scripts/render-run.js           the run page in the docs folder
shim/task-flow.md                 the /task-flow forwarder install.ps1 deploys
scripts/enable-autoupdate.js      install.ps1's settings.json step
tests/                            unit tests (node) and end-to-end probes (claude -p)
```

## Tests

```sh
node tests/config.test.js
node tests/gate.test.js
node tests/stop.test.js
node tests/render-run.test.js
node tests/enable-autoupdate.test.js
bash tests/gate.e2e.sh     # real claude -p sessions; needs the CLI on PATH
bash tests/stop.e2e.sh
claude plugin validate .
```

## Escape hatch

`TASK_FLOW_GATE=off` disables both hooks for a session.

## Credits

- [agent-skills](https://github.com/addyosmani/agent-skills) by Addy Osmani — the
  skills and personas task-flow delegates the method to.
- [fluidplan](https://github.com/morganhub/fluidplan) by morganhub — the
  decision-card approach the planned run panel will build on.

## License

[MIT](LICENSE)
