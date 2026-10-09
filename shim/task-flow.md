---
description: Run the task-flow pipeline (spec -> plan -> build -> tests -> harden -> review -> PR). Forwards to the task-flow plugin, where everything lives.
argument-hint: [auto] [the refined idea, in your own words, or leave empty to resume] | review <PR number>
---

This file only forwards. It holds no rules, so it never needs updating: the
pipeline lives in the `task-flow` plugin, which updates itself.

Load the skill `task-flow:task-flow` with the Skill tool, passing exactly this as its
arguments, unchanged: `$ARGUMENTS`

Then follow that skill for the rest of the run.

If `task-flow:task-flow` is not available in this session, do nothing else: say that
the task-flow plugin is not installed or not enabled, and that `install.ps1` in the
task-flow repository (https://github.com/tgondar/task-flow) sets it up.
