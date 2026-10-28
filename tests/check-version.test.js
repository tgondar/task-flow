#!/usr/bin/env node
// Tests for scripts/check-version.js, the CI gate that keeps plugin.json's
// "version" moving whenever plugin/ changes. The pure rule is tested directly;
// the git plumbing runs against a throwaway repository, including the cases a
// hostile pull request controls (the version string, the changelog) and the
// one the workflow hands over (--base).
//
// Run: node tests/check-version.test.js

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseVersion, checkVersions } = require('../scripts/check-version');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-version.js');

let passed = 0;
const failures = [];
function check(name, problem) {
  if (problem) {
    failures.push(`${name}: ${problem}`);
    console.log(`  FAIL  ${name} — ${problem}`);
  } else {
    passed++;
    console.log(`  ok    ${name}`);
  }
}
const expectProblems = (name, input, n) => {
  const got = checkVersions(input);
  check(name, got.length === n ? null : `expected ${n} problem(s), got ${JSON.stringify(got)}`);
};

// --- parseVersion -----------------------------------------------------------
check('parses plain X.Y.Z', JSON.stringify(parseVersion('1.10.0')) === '[1,10,0]' ? null : 'wrong parse');
for (const bad of ['v1.0.0', '1.0', '1.0.0-beta', '01.0.0', '1.0.0\n', ' 1.0.0', '1.0.0.0', '', null, 1, {}]) {
  check(`rejects version ${JSON.stringify(bad)}`, parseVersion(bad) === null ? null : 'accepted');
}

// --- checkVersions ----------------------------------------------------------
const CL = '# Changelog\n\n## 1.1.0 — 2026-10-28\n- x\n\n## 1.0.0 — 2026-10-01\n';
expectProblems('change outside plugin/ needs no bump',
  { changedPaths: ['README.md', 'tests/a.js'], baseVersion: '1.0.0', headVersion: '1.0.0', changelog: CL }, 0);
expectProblems('plugin change with bump and changelog passes',
  { changedPaths: ['plugin/x.js'], baseVersion: '1.0.0', headVersion: '1.1.0', changelog: CL }, 0);
expectProblems('plugin change without bump fails',
  { changedPaths: ['plugin/x.js'], baseVersion: '1.1.0', headVersion: '1.1.0', changelog: CL }, 1);
expectProblems('version going down fails',
  { changedPaths: ['plugin/x.js'], baseVersion: '1.1.0', headVersion: '1.0.0', changelog: CL }, 1);
expectProblems('numeric, not string, comparison (1.10.0 > 1.9.0)',
  { changedPaths: ['plugin/x.js'], baseVersion: '1.9.0', headVersion: '1.10.0', changelog: '## 1.10.0\n' }, 0);
expectProblems('bump without changelog heading fails',
  { changedPaths: ['plugin/x.js'], baseVersion: '1.0.0', headVersion: '1.2.0', changelog: CL }, 1);
expectProblems('changelog heading must match exactly (1.1.0 is not 1.1.0.1 / 1.1.00)',
  { changedPaths: ['plugin/x.js'], baseVersion: '1.0.0', headVersion: '1.1.0', changelog: '## 1.1.0.1\n## 1.1.00\n' }, 1);
expectProblems('a dot in the version is not a regex wildcard',
  { changedPaths: ['plugin/x.js'], baseVersion: '1.0.0', headVersion: '1.1.0', changelog: '## 1x1x0\n' }, 1);
expectProblems('removing the version fails',
  { changedPaths: ['plugin/.claude-plugin/plugin.json'], baseVersion: '1.0.0', headVersion: undefined, changelog: CL }, 1);
expectProblems('a non-semver version fails (and is the only problem reported)',
  { changedPaths: ['plugin/x.js'], baseVersion: '1.0.0', headVersion: '2.0.0-rc1', changelog: '## 2.0.0-rc1\n' }, 1);
expectProblems('a non-string version (object) fails without throwing',
  { changedPaths: ['plugin/x.js'], baseVersion: '1.0.0', headVersion: { toString: () => '9.9.9' }, changelog: '## 9.9.9\n' }, 1);
expectProblems('no base (first push): valid version in changelog passes',
  { changedPaths: null, baseVersion: undefined, headVersion: '1.0.0', changelog: CL }, 0);
expectProblems('first versioned commit (base had no version) passes with changelog',
  { changedPaths: ['plugin/.claude-plugin/plugin.json'], baseVersion: undefined, headVersion: '1.0.0', changelog: CL }, 0);

// --- CLI against a throwaway git repository ---------------------------------
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-version-'));
const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const write = (p, s) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), s); };
const commit = (msg) => { g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg); return g('rev-parse', 'HEAD'); };
const runCli = (...args) => spawnSync(process.execPath, [path.join(repo, 'scripts', 'check-version.js'), ...args], { cwd: repo, encoding: 'utf8' });

g('init', '-q');
g('config', 'core.autocrlf', 'false');
write('scripts/check-version.js', fs.readFileSync(SCRIPT, 'utf8'));
write('plugin/.claude-plugin/plugin.json', JSON.stringify({ name: 't', version: '1.0.0' }));
write('plugin/a.js', '1');
write('CHANGELOG.md', '## 1.0.0\n');
const base = commit('base');

write('README.md', 'docs only');
let r = runCli('--base', base);
check('CLI: docs-only change passes', r.status === 0 ? null : `exit ${r.status}: ${r.stderr}`);

write('plugin/a.js', '2');
commit('plugin change, no bump');
r = runCli('--base', base);
check('CLI: plugin change without bump exits 1', r.status === 1 ? null : `exit ${r.status}: ${r.stderr}`);

write('plugin/.claude-plugin/plugin.json', JSON.stringify({ name: 't', version: '1.0.1' }));
write('CHANGELOG.md', '## 1.0.1\n\n## 1.0.0\n');
commit('bump');
r = runCli('--base', base);
check('CLI: plugin change with bump and changelog passes', r.status === 0 ? null : `exit ${r.status}: ${r.stderr}`);

r = runCli('--base', '0'.repeat(40));
check('CLI: all-zero base (first push) checks head only', r.status === 0 ? null : `exit ${r.status}: ${r.stderr}`);

// The base reaches git; anything but a full SHA is refused before it does.
for (const bad of [undefined, 'HEAD~1', '--output=pwned', base.slice(0, 12), base.toUpperCase(), `${base} x`, `-${base.slice(1)}`]) {
  r = bad === undefined ? runCli() : runCli('--base', bad);
  check(`CLI: refuses --base ${JSON.stringify(bad && bad.slice(0, 20))}`,
    r.status === 2 && !fs.existsSync(path.join(repo, 'pwned')) ? null : `exit ${r.status}`);
}
r = runCli('--base', 'f'.repeat(40));
check('CLI: unknown base commit exits 2', r.status === 2 ? null : `exit ${r.status}`);

// A PR controls plugin.json; a version carrying a CI log command is refused
// and never echoed back into the log.
write('plugin/.claude-plugin/plugin.json', JSON.stringify({ name: 't', version: '::error::pwned' }));
commit('hostile version');
r = runCli('--base', base);
check('CLI: hostile version string fails and is not echoed',
  r.status === 1 && !(r.stdout + r.stderr).includes('::error::pwned') ? null : `exit ${r.status}: ${r.stderr}`);

write('plugin/.claude-plugin/plugin.json', '{ not json');
commit('broken json');
r = runCli('--base', base);
check('CLI: unparseable plugin.json fails, does not crash', r.status === 1 ? null : `exit ${r.status}: ${r.stderr}`);

fs.rmSync(repo, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
