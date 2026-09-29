#!/usr/bin/env node
// Security cases for closeRun and the `close` CLI in plugin/scripts/metrics.js (plan T7).
// closeRun runs on every render and in the Stop hook, so what is held here is: the CLI
// arguments are hostile input (never echoed, only usage errors exit non-zero), the
// TASK_FLOW_METRICS=off switch is read first and only from the real environment, a cloned
// repo's config/state cannot steer a write outside the project, the pre-check keeps a
// finished run from being re-collected, a hostile history cannot crash or loop the close,
// and the test seams (steps, readers) are not reachable from the CLI. Synthetic fixtures,
// throwaway HOME, CLI spawned with an argument array and shell:false.
//
// Run: node tests/metrics.close.security.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-closesec-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.LOCALAPPDATA = TEST_HOME;
process.env.XDG_STATE_HOME = TEST_HOME;
delete process.env.TASK_FLOW_METRICS;

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

const METRICS = path.resolve(__dirname, '../plugin/scripts/metrics.js');
const metrics = require(METRICS);
const { closeRun } = metrics;
const collectReal = (o) => metrics.collect(o);
const SRC = fs.readFileSync(METRICS, 'utf8');
const noComments = (s) => s.replace(/^\s*\/\/.*$/gm, '');

const PROJECT = path.join(TEST_HOME, 'work', 'proj');
const STATE = path.join(PROJECT, '.claude', 'task-flow');
const HISTORY = path.join(STATE, 'metrics.jsonl');
const OUTSIDE = path.join(TEST_HOME, 'outside');
const SIBLING = path.join(TEST_HOME, 'work', 'outside-state');
const SLUG = 'my-run';
const CLOSED = '2026-09-29T12:00:00Z';
const CODES = ['closed', 'already-closed', 'not-eligible', 'disabled', 'unsafe-path', 'write-failed', 'bad-state', 'timeout', 'internal'];
const DEFAULT_CONFIG = { docsDir: 'docs', language: 'PT-PT', tasksFile: 'tasks.md' };
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); };
const state = (extra) => ({ task: SLUG, mode: 'auto', phase: 'done', status: 'done', approvedBy: 'x', created: '2026-09-29', updated: CLOSED, phaseChangedAt: CLOSED, startedAt: '2026-09-29T09:00:00Z', size: { points: 3 }, artifacts: { plan: 'plans/p.plan.md' }, ...extra });
function setup(config, s) {
  fs.rmSync(path.join(TEST_HOME, 'work'), { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
  put(path.join(PROJECT, '.claude', 'task-flow.json'), config || DEFAULT_CONFIG);
  put(path.join(PROJECT, 'docs', 'tasks.md'), '# tasks\n');
  put(path.join(PROJECT, 'docs', 'plans', 'p.plan.md'), '# Plan\n\n## T1 · first\n- [x] **Done** — built\n');
  put(path.join(STATE, SLUG, 'state.json'), s || state());
}
const lines = (f) => (fs.existsSync(f || HISTORY) && fs.statSync(f || HISTORY).isFile() ? fs.readFileSync(f || HISTORY, 'utf8').split('\n').filter(Boolean) : []);
const tree = (dir) => { const out = []; const walk = (d) => { let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of e) { const p = path.join(d, x.name); out.push(p); if (x.isDirectory() && !x.isSymbolicLink()) walk(p); } }; walk(dir); return out; };
const cli0 = (args, env, opts) => cp.spawnSync(process.execPath, [METRICS, ...args], { encoding: 'utf8', shell: false, timeout: 60000, env: { ...process.env, ...(env || {}) }, ...(opts || {}) });
// a spawn the OS itself refuses (NUL, path too long) never reached the CLI
const cli = (args, env, opts) => { try { const r = cli0(args, env, opts); return r.error ? { status: -1, stdout: '', stderr: '', refused: true } : r; } catch { return { status: -1, stdout: '', stderr: '', refused: true }; } };
const out = (r) => (r.stdout || '') + (r.stderr || '');
const noThrow = (fn) => { try { return { r: fn() }; } catch (e) { return { threw: true, e }; } };
const junction = (target, link) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');

async function main() {
  // --- 1. --slug hostile forms: exit 2, fixed usage, nothing echoed, nothing written -------------
  setup();
  const evil = [
    '../x', '..', '.', 'a/b', 'a\\b', '-x', '--quiet', '--project-dir', '', ' ', 'my-run\n', 'my-run ', 'my run', 'a\0b',
    'é-run', 'my-run\u202e', 'x'.repeat(101), 'x'.repeat(5000), '$(calc)', '`x`', 'a;b', 'a|b', '%TEMP%', '~', 'C:\\x', '\\\\host\\share\\x', 'a:b', 'a*', '.hidden',
  ];
  for (const slug of evil) {
    const shown = JSON.stringify(slug).slice(0, 30);
    const res = cli(['close', '--slug', slug, '--project-dir', PROJECT]);
    if (res.refused) { check(`slug ${shown}: the OS refuses to spawn it (never reaches the CLI)`, slug.includes('\0') || slug.length >= 5000); continue; }
    check(`slug ${shown}: exit 2, fixed usage, stdout empty`, res.status === 2 && /^usage: metrics\.js close/.test(res.stderr) && res.stdout === '', `${res.status} ${JSON.stringify(res.stderr.slice(0, 80))}`);
    check(`slug ${shown}: not echoed`, slug.trim().length < 3 || slug.startsWith('--') || !res.stderr.includes(slug.trim()));
  }
  check('no hostile slug wrote anything', lines().length === 0 && tree(STATE).every((p) => !/metrics\.jsonl$/.test(p)));

  // repeated / equals / missing / flag-looking forms
  for (const [name, args, code] of [
    ['--slug=my-run (equals form is not a value)', ['close', '--slug=my-run', '--project-dir', PROJECT], 2],
    ['--slug with no value at the end', ['close', '--project-dir', PROJECT, '--slug'], 2],
    ['--slug followed by another flag', ['close', '--slug', '--project-dir', PROJECT], 2],
    ['no command', ['--slug', SLUG, '--project-dir', PROJECT], 2],
    ['command in the wrong place', ['--slug', SLUG, 'close', '--project-dir', PROJECT], 2],
    ['unknown command', ['open', '--slug', SLUG, '--project-dir', PROJECT], 2],
    ['uppercase command CLOSE', ['CLOSE', '--slug', SLUG, '--project-dir', PROJECT], 2],
    ['extra positional args are ignored', ['close', 'extra', '--slug', SLUG, '--project-dir', PROJECT, 'more'], 0],
    ['repeated --slug: first wins', ['close', '--slug', SLUG, '--slug', '../evil', '--project-dir', PROJECT], 0],
    ['repeated --slug: an invalid first is not rescued by a valid second', ['close', '--slug', '../evil', '--slug', SLUG, '--project-dir', PROJECT], 2],
    ['unknown extra flag', ['close', '--slug', SLUG, '--project-dir', PROJECT, '--output=x', '--evil'], 0],
  ]) {
    setup();
    const res = cli(args);
    const o = out(res);
    check(`CLI ${name}: exit ${code}`, res.status === code, `${res.status} ${JSON.stringify(o.slice(0, 100))}`);
    check(`CLI ${name}: no argument echoed beyond the slug`, !/evil|extra|more|=my-run|output/.test(o), JSON.stringify(o));
  }
  setup();
  {
    const upper = cli(['close', '--slug', 'MY-RUN', '--project-dir', PROJECT]);
    check('a case-variant slug: exit 0, one closed line, never crashes', upper.status === 0 && new RegExp(`^metrics: (${CODES.join('|')}) MY-RUN$`).test(out(upper).trim()), JSON.stringify(out(upper)));
  }

  // Windows device names as a slug: no hang, closed output
  for (const dev of ['con', 'nul', 'aux', 'com1']) {
    setup();
    const res = cli(['close', '--slug', dev, '--project-dir', PROJECT]);
    check(`device-like slug ${dev}: returns, exit 0, closed output`, res.status === 0 && new RegExp(`^metrics: (${CODES.join('|')}) ${dev}$`).test(out(res).trim()), `${res.status} ${JSON.stringify(out(res))}`);
  }

  // --- 2. --project-dir forms ---------------------------------------------------------------------
  setup();
  const fileArg = path.join(TEST_HOME, 'afile'); fs.writeFileSync(fileArg, 'x');
  for (const [name, dir] of [
    ['nonexistent', path.join(TEST_HOME, 'nope-xyz')], ['a file', fileArg], ['empty string', ''], ['very long', path.join(TEST_HOME, 'x'.repeat(3000))],
    ['device', '\\\\.\\NUL'], ['UNC to nowhere', '\\\\127.0.0.1.invalid\\share'], ['relative nonexistent', 'no/such/dir'],
  ]) {
    const res = cli(['close', '--slug', SLUG, '--project-dir', dir]);
    check(`project-dir ${name}: exit 2 (or refused by the OS), path not echoed`, res.refused || (res.status === 2 && /^usage:/.test(res.stderr) && res.stdout === '' && (dir.length < 3 || !res.stderr.includes(dir))), `${res.status} ${JSON.stringify(res.stderr.slice(0, 80))}`);
  }
  {
    const res = cli(['close', '--slug', SLUG, '--project-dir'], { CLAUDE_PROJECT_DIR: PROJECT });
    check('--project-dir without a value is a usage error, not a silent fallback', res.status === 2, `${res.status}`);
    const pct = cli(['close', '--slug', SLUG, '--project-dir', '%USERPROFILE%', '--quiet']);
    check('project-dir env-var text is not expanded', pct.status === 2 && !out(pct).includes(TEST_HOME));
    const rel = cli(['close', '--slug', SLUG, '--project-dir', '.', '--quiet'], {}, { cwd: PROJECT });
    check('relative project-dir resolves against cwd and works (exit 0, one line)', rel.status === 0 && lines().length === 1, `${rel.status} ${out(rel)}`);
    setup();
    const dotdot = cli(['close', '--slug', SLUG, '--project-dir', path.join(PROJECT, 'docs', '..')]);
    check('project-dir with ".." is normalised, exit 0', dotdot.status === 0 && lines().length === 1, `${dotdot.status} ${out(dotdot)}`);
    setup();
    const viaEnv = cli(['close', '--slug', SLUG, '--quiet'], { CLAUDE_PROJECT_DIR: PROJECT }, { cwd: TEST_HOME });
    check('CLAUDE_PROJECT_DIR is the default project', viaEnv.status === 0 && lines().length === 1, out(viaEnv));
  }
  {
    setup();
    const linkRoot = path.join(TEST_HOME, 'linkroot');
    fs.rmSync(linkRoot, { recursive: true, force: true });
    junction(PROJECT, linkRoot);
    const res = cli(['close', '--slug', SLUG, '--project-dir', linkRoot, '--quiet']);
    check('project-dir given as a junction: exit 0, no crash', res.status === 0, `${res.status} ${out(res)}`);
    fs.rmSync(linkRoot, { recursive: true, force: true });
  }

  // --- 3. TASK_FLOW_METRICS variants; off is read first ------------------------------------------
  for (const [v, disabled] of [['off', true], ['OFF', true], ['Off', true], [' off', false], ['off ', false], ['off\n', false], ['0', false], ['', false], ['false', false], ['no', false]]) {
    setup();
    const res = closeRun({ projectDir: PROJECT, slug: SLUG, env: { TASK_FLOW_METRICS: v } });
    check(`METRICS=${JSON.stringify(v)}: ${disabled ? 'disabled, no line' : 'not disabled (only exact off, like TASK_FLOW_GATE)'}`, disabled ? res.code === 'disabled' && lines().length === 0 : res.code === 'closed', JSON.stringify(res));
  }
  {
    setup();
    const res = cli(['close', '--slug', SLUG, '--project-dir', PROJECT], { TASK_FLOW_METRICS: 'off' });
    check('CLI with the real env off: exit 0, "metrics: disabled <slug>", no line', res.status === 0 && /^metrics: disabled my-run\r?\n$/.test(res.stdout) && res.stderr === '' && lines().length === 0);
    const res2 = cli(['close', '--slug', SLUG, '--project-dir', PROJECT, '--quiet'], { TASK_FLOW_METRICS: 'off' });
    check('... with --quiet: silent', res2.status === 0 && out(res2) === '');
  }
  {
    // spy: with off, no filesystem call and no child process at all (the switch is read before any file access)
    setup();
    const names = ['readFileSync', 'statSync', 'lstatSync', 'readdirSync', 'openSync', 'existsSync', 'realpathSync', 'appendFileSync', 'writeFileSync', 'mkdirSync', 'readSync'];
    const orig = {}; let calls = 0; let cpCalls = 0;
    for (const n of names) { orig[n] = fs[n]; fs[n] = function spied(...a) { calls += 1; return orig[n].apply(this, a); }; }
    const origSpawn = cp.spawnSync; cp.spawnSync = (...a) => { cpCalls += 1; return origSpawn(...a); };
    let res;
    try { res = closeRun({ projectDir: PROJECT, slug: SLUG, env: { TASK_FLOW_METRICS: 'off' } }); } finally { for (const n of names) fs[n] = orig[n]; cp.spawnSync = origSpawn; }
    check('METRICS=off: zero fs calls and zero child processes', res.code === 'disabled' && calls === 0 && cpCalls === 0, `fs=${calls} cp=${cpCalls}`);
  }
  {
    // a repo-controlled config, state or .env cannot switch the metrics off
    setup({ ...DEFAULT_CONFIG, env: { TASK_FLOW_METRICS: 'off' }, metrics: 'off', TASK_FLOW_METRICS: 'off' }, state({ env: { TASK_FLOW_METRICS: 'off' }, TASK_FLOW_METRICS: 'off' }));
    check('config/state text "TASK_FLOW_METRICS: off" does not disable', closeRun({ projectDir: PROJECT, slug: SLUG, env: {} }).code === 'closed');
    setup();
    put(path.join(PROJECT, '.env'), 'TASK_FLOW_METRICS=off\n');
    check('a .env in the repo does not disable either', closeRun({ projectDir: PROJECT, slug: SLUG, env: {} }).code === 'closed');
    const body = noComments(SRC.slice(SRC.indexOf('function closeRun(options)')));
    check('the only TASK_FLOW_METRICS read in closeRun is the first statement, on env/process.env', (body.match(/TASK_FLOW_METRICS/g) || []).length === 1 && /const env = isObject\(opts\.env\) \? opts\.env : process\.env;\s*\n\s*if \(String\(env\.TASK_FLOW_METRICS/.test(body));
  }

  // --- 4. hostile config: no read/write outside the project --------------------------------------
  {
    const evilConfigs = [
      ['stateDir with ..', { stateDir: '../outside-state' }],
      ['stateDir absolute outside', { stateDir: path.join(OUTSIDE, 'st') }],
      ['stateDir "."', { stateDir: '.' }],
      ['stateDir ".."', { stateDir: '..' }],
      ['stateDir UNC', { stateDir: '\\\\host\\share\\st' }],
      ['docsDir outside and not trusted', { docsDir: OUTSIDE }],
      ['docsDir with ..', { docsDir: '../outside' }],
    ];
    for (const [name, extra] of evilConfigs) {
      setup({ ...DEFAULT_CONFIG, ...extra });
      // plant an eligible run where the hostile config points, so a followed path would write there
      for (const base of [OUTSIDE, path.join(OUTSIDE, 'st'), SIBLING, path.join(TEST_HOME, 'work')]) {
        try { put(path.join(base, SLUG, 'state.json'), state()); } catch { /* ignore */ }
      }
      const before = new Set([...tree(OUTSIDE), ...tree(SIBLING)]);
      const r = noThrow(() => closeRun({ projectDir: PROJECT, slug: SLUG, env: {} }));
      const wrote = [OUTSIDE, SIBLING, path.join(TEST_HOME, 'work')].flatMap((d) => tree(d)).filter((p) => /metrics\.jsonl$/.test(p));
      check(`hostile config (${name}): no throw, closed code, no metrics.jsonl outside the project's state`, !r.threw && CODES.includes(r.r.code) && wrote.every((p) => p.startsWith(STATE)), JSON.stringify({ r: r.r, wrote }));
      check(`hostile config (${name}): nothing new appeared outside`, [...tree(OUTSIDE), ...tree(SIBLING)].every((p) => before.has(p)));
    }
  }
  {
    setup();
    fs.mkdirSync(OUTSIDE, { recursive: true });
    put(path.join(OUTSIDE, SLUG, 'state.json'), state());
    fs.rmSync(STATE, { recursive: true, force: true });
    junction(OUTSIDE, STATE);
    const res = closeRun({ projectDir: PROJECT, slug: SLUG, env: {} });
    check('stateDir as a junction to outside: refused, nothing written through it', res.ok === false && CODES.includes(res.code) && !fs.existsSync(path.join(OUTSIDE, 'metrics.jsonl')), JSON.stringify(res));
    fs.rmSync(STATE, { recursive: true, force: true });
  }
  {
    setup();
    fs.mkdirSync(OUTSIDE, { recursive: true });
    put(path.join(OUTSIDE, 'state.json'), state());
    fs.rmSync(path.join(STATE, SLUG), { recursive: true, force: true });
    junction(OUTSIDE, path.join(STATE, SLUG));
    const res = closeRun({ projectDir: PROJECT, slug: SLUG, env: {} });
    check('run folder as a junction: not read as a state, nothing written', res.ok === false && lines().length === 0, JSON.stringify(res));
    fs.rmSync(path.join(STATE, SLUG), { recursive: true, force: true });
  }
  {
    setup();
    fs.mkdirSync(OUTSIDE, { recursive: true });
    const target = path.join(OUTSIDE, 'victim.txt'); fs.writeFileSync(target, 'ORIGINAL');
    let linked = true;
    try { fs.symlinkSync(target, HISTORY, 'file'); } catch { linked = false; }
    if (linked) {
      const res = closeRun({ projectDir: PROJECT, slug: SLUG, env: {} });
      check('metrics.jsonl as a symlink to a file outside: victim untouched', fs.readFileSync(target, 'utf8') === 'ORIGINAL' && res.ok === false, JSON.stringify(res));
    } else check('metrics.jsonl file symlink: not creatable here (needs privilege), no surface exercised', true);
  }

  // --- 5. idempotency, foreign rows, poisoned history ---------------------------------------------
  {
    setup();
    closeRun({ projectDir: PROJECT, slug: SLUG, env: {} });
    const rowA = lines()[0];
    put(path.join(STATE, 'other-run', 'state.json'), state({ task: 'other-run' }));
    const other = closeRun({ projectDir: PROJECT, slug: 'other-run', env: {} });
    check('another run appends its own line; the first line is byte-identical', other.code === 'closed' && lines().length === 2 && lines()[0] === rowA, JSON.stringify(other));
    for (let i = 0; i < 5; i += 1) closeRun({ projectDir: PROJECT, slug: SLUG, env: {} });
    check('five more closes of a closed run: file unchanged (2 lines)', lines().length === 2 && lines()[0] === rowA);
  }
  {
    setup();
    const mine = JSON.stringify({ v: 1, run: SLUG, created: '2026-09-29', note: 'pre-existing' });
    put(HISTORY, `${mine}\n`);
    const res = closeRun({ projectDir: PROJECT, slug: SLUG, env: {} });
    check('pre-existing (invalid) line for the key: kept byte-identical, never rewritten', lines()[0] === mine, JSON.stringify(lines()));
    check('... the result is a closed code', CODES.includes(res.code), JSON.stringify(res));
  }
  {
    // A VALID row claiming the key suppresses this run's measurement. Impact: whoever can write
    // metrics.jsonl can already write any row; the only effect is one run not being measured.
    setup();
    closeRun({ projectDir: PROJECT, slug: SLUG, env: {} });
    const real = JSON.parse(lines()[0]);
    put(HISTORY, `${JSON.stringify({ ...real, outcome: 'failed' })}\n`);
    const res = closeRun({ projectDir: PROJECT, slug: SLUG, env: {} });
    check('a valid row claiming the key: already-closed, file untouched (documented impact, not a crash)', res.code === 'already-closed' && lines().length === 1 && JSON.parse(lines()[0]).outcome === 'failed', JSON.stringify(res));
  }
  {
    const shapes = [
      '{"__proto__":{"polluted":1},"run":"my-run","created":"2026-09-29"}\n',
      '{"run":"my-run","created":"2026-09-29","constructor":{"prototype":{"x":1}}}\n',
      `${'{"a":'.repeat(50000)}\n`,
      `${'['.repeat(100000)}\n`,
      'x'.repeat(5 * 1024 * 1024),
      '\0\0\0\n\r\n\r',
      '\ufeff{"v":1}\n',
      '{"v":1}\n'.repeat(200000),
    ];
    for (let i = 0; i < shapes.length; i += 1) {
      setup();
      put(HISTORY, shapes[i]);
      const t0 = Date.now();
      const r = noThrow(() => closeRun({ projectDir: PROJECT, slug: SLUG, env: {} }));
      const ms = Date.now() - t0;
      check(`hostile history shape #${i}: no throw, closed code, under 10 s (${ms} ms)`, !r.threw && CODES.includes(r.r.code) && ms < 10000, r.threw ? String(r.e) : JSON.stringify(r.r));
    }
    check('no prototype pollution after hostile history', ({}).polluted === undefined && ({}).x === undefined);
  }
  {
    // large history: the pre-check for a closed run must not collect
    setup();
    closeRun({ projectDir: PROJECT, slug: SLUG, env: {} });
    const row = lines()[0];
    const filler = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ ...JSON.parse(row), run: `r${i}`, created: '2026-01-01' })).join('\n');
    put(HISTORY, `${filler}\n${row}\n`);
    let collects = 0; let tokenReads = 0;
    const t0 = Date.now();
    const res = closeRun({ projectDir: PROJECT, slug: SLUG, env: {}, steps: { collect: () => { collects += 1; return { ok: false, code: 'internal' }; } }, readers: { readTokens: () => { tokenReads += 1; return { tokens: null, reason: 'x' }; } } });
    check('already-closed with a large history: collect and readers never called (spy), fast', res.code === 'already-closed' && collects === 0 && tokenReads === 0 && Date.now() - t0 < 5000, `${res.code} ${collects} ${tokenReads}`);
  }
  {
    // not eligible / not done / blocked: no collect, no write
    const noStart = state(); delete noStart.startedAt;
    for (const [name, s] of [['phase build', state({ phase: 'build', status: 'running' })], ['blocked', state({ phase: 'plan', status: 'blocked' })], ['no startedAt', noStart], ['phase not a string', state({ phase: ['done'] })], ['phase "DONE"', state({ phase: 'DONE' })]]) {
      setup(DEFAULT_CONFIG, s);
      let collects = 0;
      const res = closeRun({ projectDir: PROJECT, slug: SLUG, env: {}, steps: { collect: () => { collects += 1; return { ok: false, code: 'internal' }; } } });
      check(`${name}: not-eligible, collect not called, nothing written`, res.ok === true && res.code === 'not-eligible' && collects === 0 && lines().length === 0, JSON.stringify(res));
    }
    const noCreated = state(); delete noCreated.created;
    for (const [name, s] of [['created not a date', state({ created: '../../x' })], ['created missing', noCreated], ['created huge', state({ created: 'x'.repeat(100000) })]]) {
      setup(DEFAULT_CONFIG, s);
      const res = closeRun({ projectDir: PROJECT, slug: SLUG, env: {} });
      check(`${name}: bad-state, nothing written`, res.ok === false && res.code === 'bad-state' && lines().length === 0, JSON.stringify(res));
    }
    for (const [name, content] of [['array', '[]'], ['null', 'null'], ['string', '"done"'], ['20 MB', `{"phase":"done","pad":"${'x'.repeat(20 * 1024 * 1024)}"}`]]) {
      setup(); put(path.join(STATE, SLUG, 'state.json'), content);
      const t0 = Date.now();
      const res = closeRun({ projectDir: PROJECT, slug: SLUG, env: {} });
      check(`state.json ${name}: closed failure, no write, fast`, res.ok === false && CODES.includes(res.code) && lines().length === 0 && Date.now() - t0 < 5000, JSON.stringify(res));
    }
  }
  {
    // state.json changes between the pre-check and collect: collect re-checks
    setup();
    const res = closeRun({ projectDir: PROJECT, slug: SLUG, env: {}, steps: { collect: (o) => { put(path.join(STATE, SLUG, 'state.json'), state({ phase: 'build', status: 'running' })); return collectReal(o); } } });
    check('state flips to running after the pre-check: no row for an unfinished run', lines().length === 0 && CODES.includes(res.code), `${JSON.stringify(res)} ${lines().length}`);
    setup();
    const res2 = closeRun({ projectDir: PROJECT, slug: SLUG, env: {}, steps: { collect: (o) => { fs.rmSync(path.join(STATE, SLUG), { recursive: true, force: true }); return collectReal(o); } } });
    check('state.json deleted after the pre-check: closed failure, no throw, no row', res2.ok === false && lines().length === 0, JSON.stringify(res2));
  }
  {
    // the history is read again before the append: a row that appears during collect wins
    setup();
    let appends = 0;
    const res = closeRun({ projectDir: PROJECT, slug: SLUG, env: {}, steps: {
      collect: (o) => { const c = collectReal(o); put(HISTORY, `${JSON.stringify(c.row)}\n`); return c; },
      appendRow: () => { appends += 1; return { ok: true }; },
    } });
    check('a row that appears during collect: already-closed, no second append', res.code === 'already-closed' && appends === 0, JSON.stringify(res));
  }

  // --- 6. concurrency: many processes --------------------------------------------------------------
  {
    let raw = 0;
    for (let round = 0; round < 3; round += 1) {
      setup(undefined, state({ created: `2026-09-${10 + round}` }));
      const args = [METRICS, 'close', '--slug', SLUG, '--project-dir', PROJECT, '--quiet'];
      const exits = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => { const c = cp.spawn(process.execPath, args, { stdio: 'ignore', shell: false }); c.on('exit', resolve); }))); // eslint-disable-line no-await-in-loop
      const all = lines(); raw += all.length;
      check(`8 racing processes round ${round}: all exit 0, every line parses, reader returns one row`, exits.every((e) => e === 0) && all.length >= 1 && all.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }) && metrics.readHistory(PROJECT, STATE).rows.length === 1, `${exits} n=${all.length}`);
    }
    console.log(`  (raw lines over 3 rounds of 8 racing processes: ${raw}; more than 3 = duplicates the reader keeps as one)`);
    setup();
    const exits = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => { const c = cp.spawn(process.execPath, [METRICS, 'close', '--slug', SLUG, '--project-dir', PROJECT, '--quiet'], { stdio: 'ignore', shell: false, env: { ...process.env, TASK_FLOW_METRICS: 'off' } }); c.on('exit', resolve); })));
    check('8 processes with METRICS=off: exit 0, no history created', exits.every((e) => e === 0) && !fs.existsSync(HISTORY));
  }

  // --- 7. seams and output ---------------------------------------------------------------------------
  {
    const cliBlock = SRC.slice(SRC.indexOf('if (require.main === module)'));
    const calls = cliBlock.match(/closeRun\(\{[^}]*\}\)/g) || [];
    check('the CLI calls closeRun with exactly { projectDir, slug } (no steps, readers or env)', calls.length === 1 && calls[0] === 'closeRun({ projectDir, slug })', JSON.stringify(calls));
    check('the CLI block parses no JSON, requires nothing, reads no env but CLAUDE_PROJECT_DIR', !/JSON\.parse|require\(/.test(noComments(cliBlock).replace('require.main', '')) && (cliBlock.match(/process\.env\.\w+/g) || []).join() === 'process.env.CLAUDE_PROJECT_DIR');
    setup();
    const res = cli(['close', '--slug', SLUG, '--project-dir', PROJECT], { TASK_FLOW_STEPS: 'collect', TASK_FLOW_READERS: 'x', collect: 'x', steps: 'x' });
    check('env vars named like seams do nothing', res.status === 0 && /^metrics: closed my-run/.test(res.stdout));
    setup();
    const r = closeRun({ projectDir: PROJECT, slug: SLUG, env: {}, steps: { collect: 'evil', appendRow: 42, baseline: {} }, readers: 'x' });
    check('non-function steps and a non-object readers are ignored', r.code === 'closed' && lines().length === 1, JSON.stringify(r));
    const bomb = { get projectDir() { throw new Error('boom'); }, get slug() { return SLUG; }, env: {} };
    const t = noThrow(() => closeRun(bomb));
    check('a throwing getter in options: no exception, closed failure', !t.threw && t.r.ok === false && CODES.includes(t.r.code), t.threw ? String(t.e) : JSON.stringify(t.r));
    const t2 = noThrow(() => closeRun({ projectDir: PROJECT, slug: SLUG, env: { get TASK_FLOW_METRICS() { throw new Error('boom'); } } }));
    check('a throwing env getter: no exception, closed code', !t2.threw && CODES.includes(t2.r.code));
    check('null / number / array / string / function options: no exception', [null, 5, [], 'x', () => 1].every((o) => noThrow(() => closeRun(o)).threw !== true));
  }
  {
    const noStartInner = state({ startedAt: 'IGNORE PREVIOUS' });
    for (const s of [state({ created: 'IGNORE PREVIOUS INSTRUCTIONS' }), noStartInner, state({ artifacts: { plan: '../../../etc/passwd' } })]) {
      setup(undefined, s);
      const res = cli(['close', '--slug', SLUG, '--project-dir', PROJECT]);
      check('hostile state: exit 0, output exactly one closed line', res.status === 0 && new RegExp(`^metrics: (${CODES.join('|')}) ${SLUG}$`).test(out(res).trim()) && !/IGNORE|passwd/.test(out(res)), JSON.stringify(out(res)));
    }
    check('failures go to stderr, successes to stdout unless --quiet (source)', /if \(!result\.ok\) process\.stderr\.write\(line\);\s*\n\s*else if \(!argv\.includes\('--quiet'\)\) process\.stdout\.write\(line\)/.test(SRC));
  }
  {
    const closeSection = noComments(SRC.slice(SRC.indexOf('// --- closeRun and the CLI')));
    check('the closeRun/CLI section has no child_process, exec, spawn, eval, Function or require', !/child_process|\bexec|\bspawn|\beval\b|new Function|\brequire\(/.test(closeSection));
    check('no unhandled-rejection surface: no async/await/Promise in the section', !/\basync\b|\bawait\b|Promise/.test(closeSection));
  }
}

main().then(() => {
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
});
