#!/usr/bin/env node
// Tests for readCode in plugin/scripts/metrics.js (plan T5, spec R9/R1).
//
// Real git against a throwaway repo created here (HOME redirected, identity set
// locally): the project's own history is never read. The hostile-ref cases put a
// FAKE `git` first on PATH that leaves a marker file when run, so "git was not
// invoked" is proven by the marker, not assumed.
//
// Run: node tests/metrics.git.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-git-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.LOCALAPPDATA = TEST_HOME;
process.env.XDG_STATE_HOME = TEST_HOME;
process.env.GIT_CONFIG_NOSYSTEM = '1';

// A spy on child_process.execFileSync, installed BEFORE metrics.js is loaded (it binds the
// function at load time). Portable proof of "git was not spawned": a fake git on PATH
// cannot work on Windows, where an execFile without a shell only runs real .exe files.
const cp = require('child_process');
const realExec = cp.execFileSync;
let spawned = 0;
cp.execFileSync = (...a) => { spawned += 1; return realExec(...a); };
const { readCode } = require('../plugin/scripts/metrics.js');
cp.execFileSync = realExec; // the test's own git helper stays unspied; metrics keeps the spy

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push(`${name}${detail ? ` - ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}
const git = (...args) => realExec('git', args, { cwd: REPO, stdio: 'pipe' });
const write = (rel, content) => {
  const file = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

const REPO = path.join(TEST_HOME, 'repo');
fs.mkdirSync(REPO);
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'T');
git('config', 'user.email', 't@example.invalid');
git('config', 'commit.gpgsign', 'false');
write('src/a.js', 'one\ntwo\nthree\n');
write('src/old-name.js', 'keep1\nkeep2\nkeep3\nkeep4\n');
git('add', '.'); git('commit', '-q', '-m', 'base');
git('checkout', '-q', '-b', 'feat/x');
write('src/a.js', 'one\nTWO\nthree\nfour\nfive\n');   // +3 -1 (code)
write('src/new.js', 'a\nb\n');                        // +2 (code)
write('tests/a.test.js', 't1\nt2\nt3\n');             // +3 (test)
write('lib/b.spec.ts', 's1\n');                        // +1 (test)
write('lib/__tests__/c.js', 'c1\nc2\n');               // +2 (test)
write('img/logo.png', Buffer.from([0, 1, 2, 3, 0, 255])); // binary
fs.renameSync(path.join(REPO, 'src/old-name.js'), path.join(REPO, 'src/renamed.js')); // pure rename: 0/0
git('add', '-A'); git('commit', '-q', '-m', 'work');
// something on main after the branch point must NOT show up (merge-base diff)
git('checkout', '-q', 'main'); write('src/main-only.js', 'x\ny\n'); git('add', '.'); git('commit', '-q', '-m', 'main moves');
git('checkout', '-q', 'feat/x');

const ok = readCode({ projectDir: REPO, branch: 'feat/x', base: 'main' });
check('counts are exact (added/removed/files/testAdded/codeAdded)', ok.code && ok.code.added === 11 && ok.code.removed === 1 && ok.code.files === 7 && ok.code.testAdded === 6 && ok.code.codeAdded === 5, JSON.stringify(ok));
check('reason is null on success', ok.reason === null);
check('result has numbers only (no path text)', !/src|tests|png|\.js/.test(JSON.stringify(ok)));

const bad = readCode({ projectDir: REPO, branch: 'nope', base: 'main' });
check('missing branch -> code null, git-failed', bad.code === null && bad.reason === 'git-failed');

// --- hostile refs: git must never be spawned -----------------------------------------------
spawned = 0;
let allNull = true;
const hostile = ['--output=x', '-x', 'main; rm -rf /', 'a..b', 'a\nb', 'x'.repeat(300), '', 'a b', '$(id)', 'a\0b', 'a/', 'a//b', 'x.lock', 5, null, undefined, {}, ['main']];
for (const h of hostile) {
  for (const o of [{ branch: h, base: 'main' }, { branch: 'feat/x', base: h }]) {
    const r = readCode({ projectDir: REPO, ...o });
    if (r.code !== null || r.reason !== 'bad-ref') allNull = false;
  }
}
check('hostile refs give code null and reason bad-ref', allNull);
check('git was never spawned for a hostile ref', spawned === 0);
check('nothing created by option injection', !fs.existsSync(path.join(REPO, 'x')) && !fs.existsSync(path.join(REPO, '--output=x')));
readCode({ projectDir: REPO, branch: 'feat/x', base: 'main' });
check('control: valid refs do spawn git (the spy counts it)', spawned === 1);

// --- fail-open on bad input / environment -------------------------------------------------
const junk = [undefined, null, 5, 'x', [], { projectDir: 5 }, { projectDir: '', branch: 'a', base: 'b' }, { projectDir: 'a\0b', branch: 'a', base: 'b' }, { projectDir: path.join(TEST_HOME, 'missing'), branch: 'a', base: 'b' }, { projectDir: TEST_HOME, branch: 'a', base: 'b' }];
check('junk arguments never throw and give code null', junk.every((j) => { try { const r = readCode(j); return r.code === null && typeof r.reason === 'string'; } catch { return false; } }));
const realPath = process.env.PATH;
process.env.PATH = path.join(TEST_HOME, 'empty-none');
process.env.Path = process.env.PATH;
const nogit = readCode({ projectDir: REPO, branch: 'feat/x', base: 'main' });
process.env.PATH = realPath;
check('git not installed -> code null, no throw', nogit.code === null && typeof nogit.reason === 'string');

// stderr is never echoed
const errs = [];
const origWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (c) => { errs.push(String(c)); return true; };
readCode({ projectDir: REPO, branch: 'nope', base: 'main' });
process.stderr.write = origWrite;
check('no stderr from a failing git', errs.length === 0);

fs.rmSync(TEST_HOME, { recursive: true, force: true });
const total = passed + failures.length;
console.log(`\n${passed}/${total} passed`);
if (failures.length) { console.log(`${failures.length} failing:`); for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
