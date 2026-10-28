#!/usr/bin/env node
// CI gate (.github/workflows/version.yml): a change that touches plugin/ must
// raise plugin.json's "version" above the base's, and CHANGELOG.md must carry a
// "## X.Y.Z" heading for it.
//
//   node scripts/check-version.js --base <40-hex commit SHA>
//
// Why this exists: plugin.json carries a semver "version", and Claude Code keys
// its plugin cache on it - a commit that changes plugin/ without raising the
// version never reaches installed users. Before 1.0.0 the commit SHA was the
// version and this could not happen; with a hand-written number it can, so the
// rule gets an anchor in code instead of living in prose (see CLAUDE.md).
//
// Only plugin/ counts: the marketplace ships ./plugin and nothing else, so a
// change to tests/, scripts/, README.md or install.ps1 is not an update.
//
// The base is a SHA handed over by the workflow (pull_request.base.sha, or the
// push's "before"). It is validated as 40 hex characters before reaching git, so
// it can never be read as an option; every git call is an argument array, never
// a shell string. An all-zero SHA (a branch's first push) means "no base": the
// head version must then just be valid and in the changelog. Messages name
// fields, never echo a value that failed validation - CI logs interpret
// "::command::" lines, so untrusted text does not go there.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PLUGIN_JSON = 'plugin/.claude-plugin/plugin.json';
const CHANGELOG = 'CHANGELOG.md';

/** "1.2.3" -> [1, 2, 3]; anything else (prerelease, "v1.2.3", leading zeros) -> null. */
function parseVersion(s) {
  const m = typeof s === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(s);
  return m ? m.slice(1).map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Pure part, so it is testable without git. `changedPaths` null means "no base
 * to diff against" (treated as touching the plugin). Returns a list of problems.
 */
function checkVersions({ changedPaths, baseVersion, headVersion, changelog }) {
  const touches = changedPaths === null || changedPaths.some((p) => p.startsWith('plugin/'));
  if (!touches) return [];
  const head = parseVersion(headVersion);
  if (!head) return [`${PLUGIN_JSON} "version" is missing or not plain X.Y.Z`];
  const problems = [];
  const base = parseVersion(baseVersion);
  if (base && compare(head, base) <= 0) {
    problems.push(`plugin/ changed but "version" ${headVersion} is not above the base's ${baseVersion}`);
  }
  // headVersion is digits and dots only here, so escaping the dots is enough.
  const heading = new RegExp(`^## ${headVersion.replace(/\./g, '\\.')}(?![\\d.])`, 'm');
  if (!heading.test(changelog || '')) problems.push(`${CHANGELOG} has no "## ${headVersion}" heading`);
  return problems;
}

function versionOf(text) {
  try { return JSON.parse(text).version; } catch { return undefined; }
}

function main(argv) {
  const i = argv.indexOf('--base');
  const baseSha = i >= 0 ? argv[i + 1] : undefined;
  if (!/^[0-9a-f]{40}$/.test(baseSha || '')) {
    console.error('check-version: --base must be a 40-character lowercase hex commit SHA');
    return 2;
  }
  const root = path.join(__dirname, '..');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const read = (p) => { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch { return ''; } };

  let changedPaths = null;
  let baseVersion;
  if (!/^0+$/.test(baseSha)) {
    try {
      git('cat-file', '-e', `${baseSha}^{commit}`);
    } catch {
      console.error('check-version: the base commit is not in this checkout (fetch-depth: 0?)');
      return 2;
    }
    changedPaths = git('diff', '--name-only', `${baseSha}...HEAD`).split('\n').filter(Boolean);
    try { baseVersion = versionOf(git('show', `${baseSha}:${PLUGIN_JSON}`)); } catch { /* no plugin.json at base */ }
  }

  const problems = checkVersions({
    changedPaths,
    baseVersion,
    headVersion: versionOf(read(PLUGIN_JSON)),
    changelog: read(CHANGELOG),
  });
  for (const p of problems) console.error(`check-version: ${p}`);
  if (!problems.length) console.log('check-version: ok');
  return problems.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { parseVersion, checkVersions };
