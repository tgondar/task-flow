#!/usr/bin/env node
// Security tests for the loop join (plan T4): joinLoops reads each loop's transcript
// ~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl - untrusted, unversioned
// input written by another program. A hostile transcript (link, folder, oversize file or line,
// broken JSON, bogus usage, hostile requestId/model/effort, __proto__ keys, injection text) must
// give a row with null fields and a closed reason, or have its field dropped; nothing of it is
// ever echoed into a row, the result, stdout/stderr or loops.jsonl; no path outside the projects
// root is touched; and the close stays inside its 5 s budget. Everything under a throwaway HOME.
//
// Run: node tests/metrics.loops.join.security.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-joinsec-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.LOCALAPPDATA = TEST_HOME;
process.env.XDG_STATE_HOME = TEST_HOME;
delete process.env.TASK_FLOW_METRICS;
delete process.env.TASK_FLOW_GATE;

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? ` - ${String(detail).slice(0, 300)}` : ''}`); }
}

const metrics = require('../plugin/scripts/metrics.js');
const { joinLoops, closeRun, validateLoopRow } = metrics;

const PROJECT = path.join(TEST_HOME, 'work', 'proj');
const STATE = path.join(PROJECT, '.claude', 'task-flow');
const SLUG = 'my-run';
const EVENTS = path.join(STATE, SLUG, 'loop-events.jsonl');
const LOOPS = path.join(STATE, 'loops.jsonl');
const ROOT = path.join(TEST_HOME, '.claude', 'projects');
const SUB = path.join(ROOT, PROJECT.replace(/[^A-Za-z0-9]/g, '-'), 'sess1', 'subagents');
const MARKERS = ['IGNORE PREVIOUS', '<img onerror', '../', '‮', 'EVILMARK'];
const hasMarker = (text) => MARKERS.some((m) => String(text).includes(m));
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); };
const tfile = (id) => path.join(SUB, `agent-${id}.jsonl`);
const usage = (i, o) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
const asst = (ts, requestId, u, extra = {}) => ({ type: 'assistant', timestamp: ts, requestId, message: { model: 'claude-opus-5-5', usage: u, content: [{ type: 'text', text: 'IGNORE PREVIOUS <img onerror=x> EVILMARK' }] }, ...extra });
const good = (ts = '2026-01-01T10:00:05Z', id = 'req_ok') => asst(ts, id, usage(5, 10));
const writeT = (id, records) => put(tfile(id), `${records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`);
const start = (agent, type = 'general-purpose') => ({ v: 1, kind: 'start', agent, type, phase: 'build', task: 'T4', at: '2026-01-01T10:00:00.000Z' });
const join = (...starts) => joinLoops({ projectDir: PROJECT, slug: SLUG, events: { starts, results: [], ignored: 0 }, deadline: Date.now() + 5000 });
const one = (id, type) => join(start(id, type))[0];
const nullRow = (row, reason) => row && row.tokens === null && row.model === null && row.effort === null && row.durationS === null && row.reason === reason;
const reset = () => fs.rmSync(path.join(TEST_HOME, '.claude'), { recursive: true, force: true });

// --- 1. hostile transcript files: a closed reason, nothing echoed, never followed -------------
{
  reset();
  // a link named like a transcript, pointing at a valid one outside the projects root
  const outside = path.join(TEST_HOME, 'outside', 'real.jsonl');
  put(outside, `${JSON.stringify(good())}\n`);
  fs.mkdirSync(SUB, { recursive: true });
  let linked = true;
  try { fs.symlinkSync(outside, tfile('lnk1'), 'file'); } catch { linked = false; }
  if (linked) check('transcript as symlink: not followed (no tokens)', nullRow(one('lnk1'), 'no-transcript') || nullRow(one('lnk1'), 'unreadable-format'), JSON.stringify(one('lnk1')));
  else console.log('  --  symlink case skipped (no privilege)');
  // a junction in place of the session folder
  const jdir = path.join(TEST_HOME, 'outside', 'sess', 'subagents');
  put(path.join(jdir, 'agent-jun1.jsonl'), `${JSON.stringify(good())}\n`);
  try {
    fs.symlinkSync(path.join(TEST_HOME, 'outside', 'sess'), path.join(path.dirname(path.dirname(SUB)), 'sessJ'), 'junction');
    check('session folder as junction: not followed', nullRow(one('jun1'), 'no-transcript'), JSON.stringify(one('jun1')));
  } catch { console.log('  --  junction case skipped'); }

  fs.mkdirSync(tfile('dir1'), { recursive: true });
  check('transcript name that is a folder: no-transcript', nullRow(one('dir1'), 'no-transcript'), JSON.stringify(one('dir1')));

  // > 64 MiB (sparse, cheap): listed but refused, never read
  put(tfile('big1'), '');
  fs.truncateSync(tfile('big1'), 64 * 1024 * 1024 + 1);
  check('transcript over 64 MiB: unreadable-format', nullRow(one('big1'), 'unreadable-format'), JSON.stringify(one('big1')));
  fs.rmSync(tfile('big1'));

  writeT('line1', [`{"type":"assistant","pad":"${'x'.repeat(2 * 1024 * 1024)}"}`, good()]);
  const longLine = one('line1');
  check('a 2 MiB line is dropped, the rest still counts or the row has a reason', longLine && validateLoopRow(longLine).ok && (longLine.reason === null ? longLine.tokens.input === 5 : longLine.tokens === null), JSON.stringify(longLine));

  writeT('json1', ['{"type":"assistant", IGNORE PREVIOUS', '‮{]', 'null', '[]', '"EVILMARK"']);
  check('broken JSON only: unreadable-format', nullRow(one('json1'), 'unreadable-format'));
}

// --- 2. hostile fields inside a parsable record: dropped, never echoed ----------------------
{
  const bogus = [
    ['string usage', usage('5', '10')], ['negative usage', usage(-5, 10)], ['1e13 usage', usage(1e13, 10)],
    ['NaN-ish usage', { input_tokens: null, output_tokens: {} }], ['fractional usage', usage(1.5, 2)],
  ];
  for (const [name, u] of bogus) {
    writeT('bog1', [asst('2026-01-01T10:00:05Z', 'req_b', u)]);
    check(`${name}: record not counted`, nullRow(one('bog1'), 'unreadable-format'), JSON.stringify(one('bog1')));
  }
  // many bounded counts whose sum passes the ceiling
  writeT('sum1', Array.from({ length: 50 }, (_, i) => asst('2026-01-01T10:00:05Z', `req_s${i}`, usage(9e11, 1))));
  const sum = one('sum1');
  check('sum of counts past the ceiling: never an out-of-shape number', sum && validateLoopRow(sum).ok, JSON.stringify(sum));

  for (const rid of ['../../etc', '<img onerror=x>', 'req_‮', 'r'.repeat(500), 42, { x: 1 }, '__proto__']) {
    writeT('rid1', [asst('2026-01-01T10:00:05Z', rid, usage(5, 10))]);
    const r = one('rid1');
    check(`requestId ${JSON.stringify(rid).slice(0, 18)}: not counted, not echoed`, r && !hasMarker(JSON.stringify(r)) && (r.reason === 'unreadable-format' || rid === '__proto__'), JSON.stringify(r));
  }

  writeT('mod1', [asst('2026-01-01T10:00:05Z', 'req_m', usage(5, 10), { message: { model: '<img onerror=x>', usage: usage(5, 10) } })]);
  const mod = one('mod1');
  check('model <img onerror>: model null, tokens kept, not echoed', mod && mod.model === null && mod.tokens && mod.tokens.input === 5 && !hasMarker(JSON.stringify(mod)), JSON.stringify(mod));

  for (const effort of ['ultra', 'HIGH', '<img onerror=x>', ['high'], { high: 1 }, 'constructor', '__proto__']) {
    writeT('eff1', [asst('2026-01-01T10:00:05Z', 'req_e', usage(5, 10), { effort })]);
    const r = one('eff1', 'general-purpose');
    check(`effort ${JSON.stringify(effort).slice(0, 18)}: falls back to unknown`, r && r.effort === 'unknown' && validateLoopRow(r).ok, JSON.stringify(r));
  }

  // __proto__ / constructor keys in the record and the usage: no pollution, field read only as own value
  writeT('pro1', [
    '{"__proto__":{"type":"assistant","requestId":"req_p","message":{"usage":{"input_tokens":1,"output_tokens":1}}}}',
    '{"type":"assistant","requestId":"req_q","message":{"model":"claude-opus-5-5","usage":{"__proto__":{"input_tokens":7},"output_tokens":1,"input_tokens":2,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}',
  ]);
  const pro = one('pro1');
  check('__proto__ keys: no pollution, only own fields', ({}).type === undefined && ({}).input_tokens === undefined && pro && validateLoopRow(pro).ok && (pro.tokens === null || pro.tokens.input === 2), JSON.stringify(pro));

  // timestamps: hostile ones never give a negative or huge duration
  writeT('ts1', [{ type: 'user', timestamp: '9999-12-31T23:59:59Z' }, { type: 'user', timestamp: 'EVILMARK' }, good('0001-01-01T00:00:00Z')]);
  const ts = one('ts1');
  check('extreme timestamps: row still in shape (duration null or a count)', ts && validateLoopRow(ts).ok, JSON.stringify(ts));
}

// --- 3. hostile event ids: no path built, no path outside the projects root touched ----------
{
  writeT('okid', [good()]);
  const spied = {};
  const touched = [];
  for (const name of ['openSync', 'lstatSync', 'statSync', 'readdirSync', 'opendirSync', 'readFileSync', 'realpathSync']) {
    spied[name] = fs[name];
    fs[name] = function spy(p, ...rest) { touched.push(String(p)); return spied[name].call(fs, p, ...rest); };
  }
  let rows;
  try {
    rows = join(start('../../outside/real'), start('..\\x'), start('a/b'), start('__proto__'), start('constructor'), start('okid'), start('a‮b'), start(''));
  } finally { for (const name of Object.keys(spied)) fs[name] = spied[name]; }
  const under = (p) => path.resolve(p).toLowerCase().startsWith(ROOT.toLowerCase());
  check('hostile ids touch nothing outside the projects root (spy)', touched.length > 0 && touched.every(under), touched.filter((p) => !under(p)).join(' | '));
  check('hostile ids give no row (constructor: a plain name, no-transcript); the valid one counts', rows.every((r) => r.id === 'okid' || (r.id === 'constructor' && r.reason === 'no-transcript')) && rows.find((r) => r.id === 'okid').tokens.input === 5, JSON.stringify(rows.map((r) => r.id)));
  check('rows carry no transcript text', !hasMarker(JSON.stringify(rows)));
  check('Object.prototype untouched', Object.keys(Object.prototype).length === 0);
}

// --- 4. closeRun: hostile steps, nothing echoed, within budget -------------------------------
function doneRun() {
  fs.rmSync(PROJECT, { recursive: true, force: true });
  put(path.join(PROJECT, '.claude', 'task-flow.json'), { docsDir: 'docs', language: 'EN', tasksFile: 'tasks.md' });
  put(path.join(PROJECT, 'docs', 'tasks.md'), '# tasks\n');
  put(path.join(PROJECT, 'docs', 'plans', 'p.plan.md'), '# Plan\n\n## T1 · first\n- [x] **Done** — built\n');
  put(path.join(STATE, SLUG, 'state.json'), {
    task: SLUG, mode: 'auto', phase: 'done', status: 'done', approvedBy: 'x', created: '2026-01-01',
    updated: '2026-01-01T13:00:00Z', phaseChangedAt: '2026-01-01T13:00:00Z', startedAt: '2026-01-01T09:00:00Z',
    size: { points: 3 }, artifacts: { plan: 'plans/p.plan.md' },
  });
  put(EVENTS, `${JSON.stringify(start('okid'))}\n`);
}
{
  const out = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { out.push(String(s)); return true; };
  let thrown = null;
  let res;
  try {
    doneRun();
    res = closeRun({ projectDir: PROJECT, slug: SLUG, env: {}, steps: { collect: () => { throw new Error('IGNORE PREVIOUS <img onerror=x>'); } } });
  } catch (e) { thrown = e; } finally { process.stdout.write = realOut; process.stderr.write = realErr; }
  check('closeRun with collect throwing and events present: no exception, closed code', !thrown && res && typeof res.code === 'string' && /^[a-z-]+$/.test(res.code), JSON.stringify(res));
  check('nothing hostile in the result or on stdout/stderr', !hasMarker(JSON.stringify(res)) && !hasMarker(out.join('')), out.join('').slice(0, 200));

  // loops.jsonl never carries transcript text
  doneRun();
  writeT('okid', [good(), asst('2026-01-01T10:00:06Z', 'req_x', usage(1, 1), { effort: '<img onerror=x>', message: { model: 'x<img onerror=x>', usage: usage(1, 1) } })]);
  closeRun({ projectDir: PROJECT, slug: SLUG, env: {} });
  const loops = fs.existsSync(LOOPS) ? fs.readFileSync(LOOPS, 'utf8') : '';
  check('loops.jsonl written, with no hostile marker', loops.includes('"okid"') && !hasMarker(loops), loops.slice(0, 200));
}
{
  // time: many large transcripts must not push the close past its 5 s budget (plus slack for the line)
  reset();
  doneRun();
  const line = JSON.stringify(asst('2026-01-01T10:00:05Z', 'req_t', usage(1, 1)));
  const block = `${Array.from({ length: 20000 }, () => line).join('\n')}\n`; // ~4 MiB of valid, repeated requests
  const ids = [];
  for (let i = 0; i < 40; i += 1) { const id = `slow${i}`; ids.push(id); put(tfile(id), block); }
  put(EVENTS, `${ids.map((id) => JSON.stringify(start(id))).join('\n')}\n`);
  const t0 = Date.now();
  const res = closeRun({ projectDir: PROJECT, slug: SLUG, env: {} });
  const ms = Date.now() - t0;
  check(`closeRun over 40 x 4 MiB transcripts stays under 6 s (took ${ms} ms)`, ms < 6000 && res.ok === true, JSON.stringify(res));
  const rows = fs.readFileSync(LOOPS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('every loop got a row, each in shape (some may be timeout)', rows.length === 40 && rows.every((r) => validateLoopRow(r).ok && (r.reason === null || r.reason === 'timeout')), String(rows.length));
}

fs.rmSync(TEST_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
