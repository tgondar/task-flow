# Changelog

Every change to `plugin/` raises the `version` in
`plugin/.claude-plugin/plugin.json` and adds an entry here, newest first
(`scripts/check-version.js` checks both in CI). Compare the version `/plugin`
shows with the top entry to know whether your install is current.

## 1.0.0 — 2026-10-28

First versioned release. Until now the commit SHA was the version; the last
unversioned commit was `217b70d`. Includes everything up to it, notably:

- `/task-flow paperclip <issue>`: spec and plan here, then hand the combined
  documents to a paperclip agent org and flip the GitHub Project item to Ready
  (`scripts/send-to-paperclip.js`, `config.js trust-paperclip`).
- The plan-approval gate (`gate.js`) removed; the pipeline's one planned stop is
  before security-harden and review.
- The local viewer (`plugin/viewer/`), decoupled from FluidPlan.
