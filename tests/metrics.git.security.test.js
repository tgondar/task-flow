#!/usr/bin/env node
// Security tests for readCode in plugin/scripts/metrics.js (plan T5, spec R9/R1/S cases).
//
// Real git against throwaway repos in a temp dir (HOME redirected, identity local, no network).
// A spy on child_process.execFileSync (installed before metrics.js loads) records every spawn:
// "git not run", "no shell", the argument array and the env are asserted on facts. Parser edge
// cases reload the module over a stubbed execFileSync so hostile git OUTPUT can be fed in.
//
// Run: node tests/metrics.git.security.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-gitsec-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.LOCALAPPDATA = TEST_HOME;
process.env.XDG_STATE_HOME = TEST_HOME;

const cp = require('child_process');
const realExec = cp.execFileSync;
const METRICS = require.resolve('../plugin/scripts/metrics.js');
const calls = [];
cp.execFileSync = (...a) => { calls.push(a); return realExec(...a); };
const { readCode } = require(METRICS);
cp.execFileSync = realExec;

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push(`${name}${detail ? ` - ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}
const REASONS = new Set(['bad-input', 'bad-ref', 'timeout', 'too-large', 'no-git', 'git-failed', 'unreadable-output', 'internal']);
const closed = (r) => !!r && typeof r === 'object' && (
  (r.code === null && REASONS.has(r.reason) && Object.keys(r).length === 2) ||
  (r.reason === null && !!r.code && Object.keys(r.code).sort().join() === 'added,codeAdded,files,removed,testAdded' &&
    Object.values(r.code).every(Number.isSafeInteger) && Object.keys(r).length === 2));
const run = (fn, o) => { try { return { r: fn(o) }; } catch (e) { return { threw: e }; } };

function mkRepo(name) {
  const dir = path.join(TEST_HOME, name);
  fs.mkdirSync(dir);
  const g = (...a) => realExec('git', a, { cwd: dir, stdio: 'pipe', maxBuffer: 256 * 1024 * 1024 });
  const w = (rel, c) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
  g('init', '-q', '-b', 'main'); g('config', 'user.name', 'T'); g('config', 'user.email', 't@example.invalid'); g('config', 'commit.gpgsign', 'false');
  w('a.js', '1\n2\n'); g('add', '.'); g('commit', '-q', '-m', 'base');
  g('checkout', '-q', '-b', 'feat/x');
  w('a.js', '1\n2\n3\n4\n'); g('add', '.'); g('commit', '-q', '-m', 'work');
  return { dir, g, w };
}
const R = mkRepo('repo');
const good = () => run(readCode, { projectDir: R.dir, branch: 'feat/x', base: 'main' });

// --- sanity ---------------------------------------------------------------------------------------
{
  calls.length = 0;
  const o = good();
  check('baseline: valid call measures', !o.threw && o.r.code && o.r.code.added === 2 && o.r.code.files === 1, JSON.stringify(o));
  check('spawned exactly one git', calls.length === 1);
}

// --- (1) hostile refs never reach git ----------------------------------------------------------------
const hostile = [
  '-x', '--output=/tmp/pwn', '--upload-pack=touch /tmp/x', '--exec=calc', '-', '--', '-c', '-C/x',
  'a b', 'a\nb', 'a\0b', 'a\tb', 'a;b', 'a&b', 'a|b', 'a$(id)', 'a`id`', 'a"b', "a'b", '%PATH%', '^a', 'a^', 'a~1', 'a:b', 'a\\b',
  'main..feat/x', 'a...b', 'a@{1}', '@{u}', 'a//b', 'a/', '/a', '.a', 'x.lock', '', ' ', '\u2010-x', 'ma\u0456n', 'a\u202eb',
  'a'.repeat(201), 'a'.repeat(100000), 'a?b', 'a*b', 'a[b', 'a>b', 'a<b', 'a!b', 'a#b', 'a,b', 'a=b', 'a+b',
];
for (const bad of hostile) {
  for (const side of ['branch', 'base']) {
    calls.length = 0;
    const o = run(readCode, { projectDir: R.dir, branch: 'feat/x', base: 'main', [side]: bad });
    check(`${side}=${JSON.stringify(bad.slice(0, 24))}: bad-ref, git not spawned, no throw`,
      !o.threw && o.r.reason === 'bad-ref' && o.r.code === null && calls.length === 0, o.threw ? String(o.threw) : JSON.stringify(o.r));
  }
}
{
  // same-named tag and branch, and a tag used as a ref: closed result, no crash
  R.g('branch', 'twin'); R.g('tag', 'twin'); R.g('tag', 'tag-x');
  const a = run(readCode, { projectDir: R.dir, branch: 'twin', base: 'main' });
  check('ambiguous tag/branch name: closed result, no throw', !a.threw && closed(a.r), JSON.stringify(a));
  const b = run(readCode, { projectDir: R.dir, branch: 'tag-x', base: 'main' });
  check('tag as ref: closed result', !b.threw && closed(b.r));
}

// --- (2) non-string / exotic inputs ---------------------------------------------------------------------
const exotic = [
  undefined, null, 0, 1, true, 'str', [], [R.dir], () => {}, Symbol('s'), 1n,
  {}, { projectDir: R.dir }, { projectDir: R.dir, branch: 'feat/x' }, { projectDir: R.dir, base: 'main' },
  { projectDir: R.dir, branch: ['feat/x'], base: 'main' }, { projectDir: R.dir, branch: { toString: () => 'feat/x' }, base: 'main' },
  { projectDir: R.dir, branch: new String('feat/x'), base: 'main' }, { projectDir: R.dir, branch: 1, base: 2 },
  { projectDir: R.dir, branch: null, base: null }, { projectDir: 5, branch: 'a', base: 'b' }, { projectDir: [R.dir], branch: 'a', base: 'b' },
  { projectDir: '', branch: 'a', base: 'b' }, { projectDir: 'x\0y', branch: 'a', base: 'b' },
  { get projectDir() { throw new Error('boom'); } },
  { projectDir: R.dir, get branch() { throw new Error('boom'); }, base: 'main' },
  new Proxy({}, { get() { throw new Error('boom'); } }),
];
for (const [i, e] of exotic.entries()) {
  calls.length = 0;
  const o = run(readCode, e);
  check(`exotic input #${i}: no throw, closed shape`, !o.threw && closed(o.r), o.threw ? String(o.threw) : JSON.stringify(o.r));
}
{
  calls.length = 0;
  run(readCode, { projectDir: R.dir, branch: { toString: () => 'feat/x' }, base: 'main' });
  run(readCode, { projectDir: R.dir, branch: ['feat/x'], base: 'main' });
  run(readCode, { projectDir: R.dir, branch: new String('feat/x'), base: 'main' });
  check('object/array/String-object refs never spawn git', calls.length === 0);
}

// --- (3) projectDir variants -----------------------------------------------------------------------------
{
  const file = path.join(TEST_HOME, 'afile'); fs.writeFileSync(file, 'x');
  const variants = [
    ['a file', file], ['nonexistent', path.join(TEST_HOME, 'nope')], ['relative', 'no/such/rel'],
    ['UNC', '\\\\127.0.0.1\\nope\\share'], ['not a repo', fs.mkdtempSync(path.join(TEST_HOME, 'plain-'))],
    ['NUL', `${R.dir}\0x`], ['very long', 'x'.repeat(50000)],
  ];
  for (const [n, d] of variants) {
    const o = run(readCode, { projectDir: d, branch: 'feat/x', base: 'main' });
    check(`projectDir ${n}: no throw, closed, no code`, !o.threw && closed(o.r) && o.r.code === null, o.threw ? String(o.threw) : JSON.stringify(o.r));
  }
  const link = path.join(TEST_HOME, 'lnk');
  let made = false;
  try { fs.symlinkSync(R.dir, link, 'junction'); made = true; } catch { /* no link privilege */ }
  if (made) { const o = run(readCode, { projectDir: link, branch: 'feat/x', base: 'main' }); check('projectDir junction/symlink: no throw, closed', !o.threw && closed(o.r)); }
  else check('projectDir link: could not create one here (skipped)', true);
}

// --- (4) spawn options: no shell, fixed argv, safe env ---------------------------------------------------
{
  const dirty = { GIT_EXTERNAL_DIFF: 'calc', GIT_PAGER: 'calc', GIT_SSH_COMMAND: 'calc', GIT_CONFIG_PARAMETERS: "'diff.external=calc'", GIT_DIR: '/nope', GIT_WORK_TREE: '/nope' };
  Object.assign(process.env, dirty);
  calls.length = 0;
  good();
  Object.keys(dirty).forEach((k) => delete process.env[k]);
  const [file, argv, opts] = calls[0] || [];
  check('spawns "git" by name', file === 'git');
  check('argv is an array', Array.isArray(argv));
  check('shell is false (never true, never a string)', !!opts && opts.shell === false);
  check('cwd is the project dir', !!opts && opts.cwd === R.dir);
  check('stdin/stderr ignored, never captured or inherited', !!opts && Array.isArray(opts.stdio) && opts.stdio[2] === 'ignore' && opts.stdio[0] === 'ignore');
  check('bounded: timeout and maxBuffer set', !!opts && opts.timeout > 0 && opts.timeout <= 10000 && opts.maxBuffer > 0 && opts.maxBuffer <= 16 * 1024 * 1024);
  check('config that runs programs is off on the command line',
    argv.includes('--no-ext-diff') && argv.includes('--no-textconv') && argv.includes('--no-pager') && argv.includes('core.fsmonitor=false') && argv.includes('diff.external='));
  check('revision is one argv element, followed by --', argv[argv.length - 2] === 'main...feat/x' && argv[argv.length - 1] === '--');
  check('attacker GIT_EXTERNAL_DIFF/GIT_PAGER neutralised in child env', opts.env.GIT_EXTERNAL_DIFF === '' && opts.env.GIT_PAGER === 'cat');
  check('system config off, no terminal prompt', opts.env.GIT_CONFIG_NOSYSTEM === '1' && opts.env.GIT_TERMINAL_PROMPT === '0');
  check('inherited GIT_CONFIG_PARAMETERS does not reach git', !opts.env.GIT_CONFIG_PARAMETERS);
  check('inherited GIT_DIR / GIT_WORK_TREE do not reach git', !opts.env.GIT_DIR && !opts.env.GIT_WORK_TREE);
}

// --- (5) inherited environment cannot redirect the diff -------------------------------------------------
{
  const other = mkRepo('other'); // same branch names, different numbers
  other.w('a.js', '1\n2\n3\n4\n5\n6\n7\n8\n9\n'); other.g('add', '.'); other.g('commit', '-q', '-m', 'more');
  fs.writeFileSync(path.join(TEST_HOME, 'evil-gitconfig'), '[diff]\n\texternal = calc\n[core]\n\tfsmonitor = calc\n');
  const scenarios = {
    GIT_DIR: { GIT_DIR: path.join(other.dir, '.git') },
    'GIT_DIR+GIT_WORK_TREE': { GIT_DIR: path.join(other.dir, '.git'), GIT_WORK_TREE: other.dir },
    GIT_CEILING_DIRECTORIES: { GIT_CEILING_DIRECTORIES: TEST_HOME },
    GIT_CONFIG_COUNT: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.external', GIT_CONFIG_VALUE_0: 'calc' },
    GIT_CONFIG_GLOBAL: { GIT_CONFIG_GLOBAL: path.join(TEST_HOME, 'evil-gitconfig') },
    GIT_OBJECT_DIRECTORY: { GIT_OBJECT_DIRECTORY: path.join(other.dir, '.git', 'objects') },
    GIT_INDEX_FILE: { GIT_INDEX_FILE: path.join(TEST_HOME, 'nope-index') },
  };
  const expected = JSON.stringify(good().r);
  check('own diff is +2/1 file', expected.includes('"added":2') && expected.includes('"files":1'), expected);
  for (const [n, env] of Object.entries(scenarios)) {
    const saved = {}; for (const k of Object.keys(env)) saved[k] = process.env[k];
    Object.assign(process.env, env);
    const o = good();
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    check(`inherited ${n}: result equals the project's own diff`, !o.threw && JSON.stringify(o.r) === expected, o.threw ? String(o.threw) : JSON.stringify(o.r));
  }
}

// --- (6) hostile repo content ----------------------------------------------------------------------------
{
  const H = mkRepo('hostile');
  const marker = path.join(TEST_HOME, 'PWNED');
  const script = path.join(TEST_HOME, 'pwn.js').replace(/\\/g, '/');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`);
  const cmd = `node ${script}`;
  H.w('.gitattributes', '*.js diff=evil\n*.md diff=evil\n'); H.g('add', '.'); H.g('commit', '-q', '-m', 'attrs');
  H.w('b.js', 'x\ny\n'); H.w('n.md', 'z\n'); H.g('add', '.'); H.g('commit', '-q', '-m', 'more');
  for (const [k, v] of [['core.fsmonitor', cmd], ['diff.external', cmd], ['core.pager', cmd], ['diff.evil.command', cmd], ['diff.evil.textconv', cmd]]) H.g('config', k, v);
  fs.rmSync(marker, { force: true }); // the fixture's own git calls above must not count
  const o = run(readCode, { projectDir: H.dir, branch: 'feat/x', base: 'main' });
  check('hostile repo config/attributes: numbers only', !o.threw && closed(o.r) && !!o.r.code && o.r.code.added >= 5, JSON.stringify(o));
  check('no program named by repo config ran (marker absent)', !fs.existsSync(marker));
}

// --- (7) output handling ------------------------------------------------------------------------------------
{
  const P = mkRepo('paths');
  const names = ['sp ace.js', 'q"uote.js', "ap'os.js", 'uni\u00e9\u4e2d.js', 'tab\there.js', 'semi;colon.js', 'tests/in dir/x.js', 'a.test.js'];
  for (const n of names) { try { P.w(n, 'l1\nl2\n'); } catch { /* name unsupported on this fs */ } }
  P.g('add', '.'); P.g('commit', '-q', '-m', 'names');
  const o = run(readCode, { projectDir: P.dir, branch: 'feat/x', base: 'main' });
  const text = JSON.stringify(o);
  check('odd path names: closed numeric result', !o.threw && closed(o.r), text);
  check('no path or file-name text in the result', !/\.js|ace|uote|apos|semi|dir/.test(text), text);
  check('test paths counted as testAdded, others as codeAdded', !!o.r.code && o.r.code.testAdded >= 2 && o.r.code.codeAdded >= 2, text);
  P.g('mv', 'a.js', 'renamed.js'); P.w('bin.dat', Buffer.from([0, 1, 0, 2, 0])); P.g('add', '.'); P.g('commit', '-q', '-m', 'mv');
  const r = run(readCode, { projectDir: P.dir, branch: 'feat/x', base: 'main' });
  check('rename and binary entries parse', !r.threw && closed(r.r) && !!r.r.code, JSON.stringify(r));
}
{
  const B = mkRepo('big');
  const long = 'f'.repeat(120);
  for (let i = 0; i < 9000; i += 1) fs.writeFileSync(path.join(B.dir, `${long}${i}.txt`), 'x\n');
  B.g('add', '.'); B.g('commit', '-q', '-m', 'big');
  const o = run(readCode, { projectDir: B.dir, branch: 'feat/x', base: 'main' });
  check('output over maxBuffer: too-large, no code, no throw', !o.threw && o.r.reason === 'too-large' && o.r.code === null, JSON.stringify(o));
}
{
  const o = run(readCode, { projectDir: R.dir, branch: 'no-such-branch', base: 'main' });
  check('unknown ref: git-failed, nothing from git text in result', !o.threw && o.r.reason === 'git-failed' && JSON.stringify(o.r).length < 60, JSON.stringify(o));
  const x = run(readCode, { projectDir: R.dir, branch: 'feat/x', base: 'main', extra: '--output=/tmp/x' });
  check('extra option fields ignored', !x.threw && closed(x.r));
}

// --- (8) parser edge cases: the module reloaded over a stubbed execFileSync -----------------------------
function loadWith(stub) {
  const saved = require.cache[METRICS];
  delete require.cache[METRICS];
  cp.execFileSync = stub;
  try { return require(METRICS).readCode; } finally { cp.execFileSync = realExec; delete require.cache[METRICS]; if (saved) require.cache[METRICS] = saved; }
}
const cases = {
  empty: ['', (r) => !!r.code && r.code.files === 0],
  'garbage text': ['hello\0', (r) => r.reason === 'unreadable-output'],
  'missing tab': ['1 2 a.js\0', (r) => r.reason === 'unreadable-output'],
  negative: ['-5\t1\ta.js\0', (r) => r.reason === 'unreadable-output'],
  'float': ['1.5\t1\ta.js\0', (r) => r.reason === 'unreadable-output'],
  'huge number': ['99999999999999999999\t0\ta.js\0', (r) => r.reason === 'unreadable-output'],
  'over ceiling': ['2000000000\t0\ta.js\0', (r) => r.reason === 'unreadable-output'],
  'sum over ceiling': ['900000000\t0\ta.js\0'.repeat(3), (r) => r.reason === 'unreadable-output'],
  'truncated rename': ['1\t1\t\0old.js\0', (r) => r.reason === 'unreadable-output'],
  'rename ok': ['1\t1\t\0old.js\0new.js\0', (r) => !!r.code && r.code.files === 1 && r.code.codeAdded === 1],
  'binary dash': ['-\t-\timg.png\0', (r) => !!r.code && r.code.files === 1 && r.code.added === 0],
  'path with newline and tab': ['3\t0\ta\nb\tc.js\0', (r) => !!r.code && r.code.added === 3],
  'replacement chars in path': ['3\t0\t\ufffd\ufffd.js\0', (r) => !!r.code && r.code.added === 3],
  'proto-ish path': ['1\t0\t__proto__\0', (r) => !!r.code && r.code.files === 1 && ({}).polluted === undefined],
  'test path as rename target': ['2\t0\t\0a.js\0tests/b.js\0', (r) => !!r.code && r.code.testAdded === 2 && r.code.codeAdded === 0],
};
for (const [n, [out, ok]] of Object.entries(cases)) {
  const o = run(loadWith(() => out), { projectDir: R.dir, branch: 'feat/x', base: 'main' });
  check(`parser: ${n}`, !o.threw && closed(o.r) && ok(o.r), o.threw ? String(o.threw) : JSON.stringify(o.r));
  check(`parser: ${n}: no path text in the result`, !o.threw && !/old\.js|new\.js|a\.js|img\.png|proto/.test(JSON.stringify(o.r)));
}
const errs = {
  ETIMEDOUT: [Object.assign(new Error('secret C:\\x'), { code: 'ETIMEDOUT' }), 'timeout'],
  ENOBUFS: [Object.assign(new Error('x'), { code: 'ENOBUFS' }), 'too-large'],
  ENOENT: [Object.assign(new Error('x'), { code: 'ENOENT' }), 'no-git'],
  'error carrying paths': [Object.assign(new Error('fatal: C:\\secret\\path'), { status: 128, stderr: 'C:\\secret' }), 'git-failed'],
  'thrown null': [null, 'git-failed'],
  'thrown string': ['C:\\secret', 'git-failed'],
};
for (const [n, [e, reason]] of Object.entries(errs)) {
  const o = run(loadWith(() => { throw e; }), { projectDir: R.dir, branch: 'feat/x', base: 'main' });
  check(`spawn error ${n}: ${reason}, closed, no message leaked`, !o.threw && o.r.reason === reason && closed(o.r) && !/secret|fatal/.test(JSON.stringify(o.r)), o.threw ? String(o.threw) : JSON.stringify(o.r));
}
{
  // output that is not a string at all (a Buffer or object from a broken spawn)
  for (const weird of [Buffer.from('1\t0\ta.js\0'), { split() { throw new Error('boom'); } }, undefined, null, 42]) {
    const o = run(loadWith(() => weird), { projectDir: R.dir, branch: 'feat/x', base: 'main' });
    check(`non-string git output ${Object.prototype.toString.call(weird)}: no throw, closed`, !o.threw && closed(o.r), o.threw ? String(o.threw) : JSON.stringify(o.r));
  }
}

// --- (9) source scan: the section stays free of shell use -------------------------------------------------
{
  const src = fs.readFileSync(path.resolve(__dirname, '../plugin/scripts/metrics.js'), 'utf8');
  const a = src.indexOf('function readCode');
  const sec = src.slice(a, src.indexOf('// --- transcript reader'));
  check('readCode section found', a > 0 && sec.length > 100);
  check('no shell: no execSync/spawn/shell:true/eval, shell:false set', !/\bexecSync\b|\bspawn(Sync)?\b|shell:\s*true|\beval\b|new Function/.test(sec) && /shell:\s*false/.test(sec));
  check('git text never re-emitted: no .stderr/.message/console use', !/\.stderr|\.message|console\./.test(sec));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
