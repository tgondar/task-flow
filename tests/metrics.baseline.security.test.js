#!/usr/bin/env node
// Security cases for plugin/scripts/metrics.js (T3): the pure baseline() and the
// DEVIATION table. history, current and the options are all untrusted (history comes
// from a file somebody else may have written). These assert: no exception ever, a
// bounded amount of work, inputs never mutated, no prototype pollution, a result made
// of closed codes and numbers only (nothing from an untrusted string or object), a
// failed current run never getting a verdict, a failed / other-model row never
// entering the base, model spoofing refused, and exact arithmetic on the limits.
//
// Run: node tests/metrics.baseline.security.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.LOCALAPPDATA = TEST_HOME;
process.env.XDG_STATE_HOME = TEST_HOME;

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

const { baseline, DEVIATION, CONSTANTS } = require(path.resolve(__dirname, '../plugin/scripts/metrics.js'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const MODEL = 'claude-opus-5-5';
const ROW = {
  v: 1, run: 'a-run', created: '2026-09-29', closedAt: '2026-09-30T14:02:11Z', outcome: 'done', mode: 'attended',
  primaryModel: MODEL, models: [MODEL], sizePoints: 5,
  tasks: { total: 9, done: 9, skipped: 0, pending: 0, retries: 1, firstTime: 8 },
  tests: { greenFirstRun: true }, review: { critical: 0, required: 2, optional: 3, nit: 1 }, hardenFindings: 0,
  questions: { total: 4, open: 0, explained: 1, maxRound: 2 },
  code: { added: 8, removed: 4, files: 1, testAdded: 4, codeAdded: 4 },
  tokens: { input: 1, cacheCreate: 2, cacheRead: 3, output: 4, cacheHitRate: 0.94, byPhase: { build: { in: 1, out: 2 } } },
  tokensNull: null, agent: { requests: 1, toolCalls: 2, toolErrors: 0, contextPeak: 5 },
};
function row(run, over = {}) {
  const r = clone(ROW); r.run = run; r.created = '2026-09-29';
  return Object.assign(r, over);
}
const at = (i) => `2026-09-${String(10 + i).padStart(2, '0')}T10:00:00Z`;
const hist = (count, over) => Array.from({ length: count }, (_, i) => row(`r${i}`, { closedAt: at(i), ...(over ? over(i) : {}) }));
const CUR = () => row('cur', { closedAt: '2026-09-28T10:00:00Z' });
const noThrow = (fn) => { try { return { v: fn() }; } catch (e) { return { threw: true, e }; } };
const boom = () => { throw new Error('boom'); };
const HOSTILE = () => new Proxy({}, { get: boom, ownKeys: boom, getPrototypeOf: boom, has: boom, getOwnPropertyDescriptor: boom });
const RESULT_KEYS = ['hasVerdict', 'reason', 'have', 'min', 'n', 'metrics'];
const REASONS = [null, 'too-few', 'no-model-base', 'failed', 'bad-current'];
const VERDICTS = ['ok', 'deviation', 'n/d', null];
const IDS = DEVIATION.map((d) => d.id);
// The shape contract: closed keys, closed codes, finite numbers, ids from the table.
function closedShape(r) {
  if (!r || typeof r !== 'object' || Object.keys(r).join() !== RESULT_KEYS.join()) return false;
  if (typeof r.hasVerdict !== 'boolean' || !REASONS.includes(r.reason)) return false;
  if (![r.have, r.min, r.n].every((x) => typeof x === 'number' && Number.isFinite(x))) return false;
  if (!Array.isArray(r.metrics)) return false;
  if (r.reason === 'bad-current') return r.metrics.length === 0 && !r.hasVerdict; // documented: nothing to compare
  if (r.metrics.length !== IDS.length) return false;
  return r.metrics.every((m, i) => Object.keys(m).join() === 'id,value,median,verdict' && m.id === IDS[i] &&
    VERDICTS.includes(m.verdict) && [m.value, m.median].every((x) => x === null || (typeof x === 'number' && Number.isFinite(x))));
}
const verdictOf = (r, id) => r.metrics.find((m) => m.id === id).verdict;
const metricOf = (r, id) => r.metrics.find((m) => m.id === id);

// --- hostile history ----------------------------------------------------------------
for (const [name, h] of [['undefined', undefined], ['null', null], ['string', 'abc'], ['number', 7], ['object', { length: 9 }], ['function', () => 1], ['array-like', { 0: row('a'), length: 1 }]]) {
  const o = noThrow(() => baseline(h, CUR()));
  check(`history ${name}: no throw, closed shape, no verdict`, !o.threw && closedShape(o.v) && !o.v.hasVerdict && o.v.reason === 'no-model-base');
}
{
  const h = hist(6); h[2] = undefined; h[3] = null; h[4] = 'x'; h[5] = 42; h.length = 20;
  const o = noThrow(() => baseline(h, CUR()));
  check('sparse / non-object rows ignored, no throw', !o.threw && closedShape(o.v) && o.v.have === 2);
}
{
  const o = noThrow(() => baseline([...hist(6), HOSTILE()], CUR()));
  check('throwing proxy row: no exception escapes', !o.threw && closedShape(o.v));
  const p = noThrow(() => baseline(new Proxy(hist(6), { get(t, k) { if (k === 'slice') throw new Error('boom'); return t[k]; } }), CUR()));
  check('history proxy whose slice throws: no exception escapes', !p.threw && closedShape(p.v));
}
{
  let reads = 0;
  const flip = row('flip', { closedAt: at(1) });
  Object.defineProperty(flip, 'outcome', { enumerable: true, get() { reads += 1; return reads % 2 ? 'done' : 'failed'; } });
  const o = noThrow(() => baseline([...hist(6), flip], CUR()));
  check('row with a side-effecting getter: no throw, closed shape', !o.threw && closedShape(o.v));
}
{
  const o = noThrow(() => baseline(hist(6).map((r) => Object.freeze(r)), CUR()));
  check('frozen rows fine', !o.threw && o.v.hasVerdict);
}

// --- huge input: bounded ---------------------------------------------------------
{
  const big = hist(3 * CONSTANTS.HISTORY_MAX_ROWS);
  const t0 = Date.now();
  const o = noThrow(() => baseline(big, CUR()));
  check('3x HISTORY_MAX_ROWS rows: bounded time and closed shape', !o.threw && closedShape(o.v) && Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  const sparse = []; sparse.length = 4294967295;
  const t1 = Date.now();
  const s = noThrow(() => baseline(sparse, CUR()));
  check('array of length 2^32-1 (sparse): bounded, no throw', !s.threw && closedShape(s.v) && Date.now() - t1 < 5000, `${Date.now() - t1} ms`);
}

// --- rows that pass or fail validation -------------------------------------------
{
  const evil = JSON.parse('{"__proto__": {"polluted": 1}, "constructor": {"x": 1}}');
  const h = hist(6); h.push(Object.assign(row('evil'), evil), Object.assign(row('evil2', { closedAt: at(7) }), { extra: 1 }));
  const before = JSON.stringify(h);
  const o = noThrow(() => baseline(h, CUR()));
  check('rows with __proto__/constructor/extra keys are out of the base, no pollution',
    !o.threw && o.v.have === 6 && ({}).polluted === undefined && Object.prototype.polluted === undefined);
  check('inputs not mutated (history)', JSON.stringify(h) === before);
}
{
  const cur = CUR(); const h = hist(6); const bc = JSON.stringify(cur); const bh = JSON.stringify(h);
  baseline(h, cur);
  check('inputs not mutated (current, history)', JSON.stringify(cur) === bc && JSON.stringify(h) === bh);
  const f = Object.freeze(clone(cur)); f.tasks = Object.freeze(f.tasks);
  check('frozen current fine', noThrow(() => baseline(Object.freeze(hist(6)), f)).v.hasVerdict);
}
for (const [name, mut] of [
  ['NaN', (r) => { r.agent.toolCalls = NaN; }], ['Infinity', (r) => { r.agent.toolCalls = Infinity; }],
  ['-0', (r) => { r.agent.toolCalls = -0; }], ['negative', (r) => { r.agent.toolCalls = -5; }],
  ['1e13', (r) => { r.agent.toolCalls = 1e13; }], ['string number', (r) => { r.agent.toolCalls = '5'; }],
  ['float count', (r) => { r.agent.toolCalls = 1.5; }], ['cacheHitRate 2', (r) => { r.tokens.cacheHitRate = 2; }],
  ['cacheHitRate NaN', (r) => { r.tokens.cacheHitRate = NaN; }],
]) {
  const h = hist(6); h.forEach((r) => mut(r));
  const o = noThrow(() => baseline(h, CUR()));
  check(`history rows with ${name} value: no throw, closed shape, no NaN/Infinity out`, !o.threw && closedShape(o.v));
}
{
  // current is not validated by baseline: it is read through isCount/isRate anyway.
  const cur = CUR(); cur.agent.toolCalls = NaN; cur.tokens.cacheHitRate = Infinity;
  const o = noThrow(() => baseline(hist(6), cur));
  check('current with NaN/Infinity: value null, verdict n/d, never NaN', !o.threw && closedShape(o.v) &&
    metricOf(o.v, 'toolCallsPerTask').value === null && verdictOf(o.v, 'toolCallsPerTask') === 'n/d' && verdictOf(o.v, 'cacheHitRate') === 'n/d');
  const c2 = CUR(); c2.tasks.done = -3; c2.code.codeAdded = 0;
  const o2 = baseline(hist(6), c2);
  check('tasks.done negative / codeAdded 0: no division, null', closedShape(o2) && metricOf(o2, 'freshTokensPerTask').value === null && metricOf(o2, 'testCodeRatio').value === null);
  const c3 = CUR(); c3.tasks.done = 0;
  const o3 = baseline(hist(6), c3);
  check('tasks.done 0: per-task metrics null (no 0/0, no Infinity)', closedShape(o3) && metricOf(o3, 'toolCallsPerTask').value === null && verdictOf(o3, 'toolCallsPerTask') === 'n/d');
}
{
  const h = hist(6, () => ({ tasks: { total: 9, done: 0, skipped: 0, pending: 0, retries: 1, firstTime: 8 } }));
  const o = baseline(h, CUR());
  check('history all tasks.done 0: per-task metrics n/d', closedShape(o) && verdictOf(o, 'toolCallsPerTask') === 'n/d' && verdictOf(o, 'contextPeak') === 'ok');
}

// --- hostile current --------------------------------------------------------------
for (const [name, c] of [['undefined', undefined], ['null', null], ['string', 'x'], ['array', []], ['number', 1]]) {
  const o = noThrow(() => baseline(hist(6), c));
  check(`current ${name}: bad-current, no verdict, no throw`, !o.threw && closedShape(o.v) && o.v.reason === 'bad-current' && !o.v.hasVerdict);
}
{
  const o = noThrow(() => baseline(hist(6), HOSTILE()));
  check('current proxy that throws: no exception escapes', !o.threw && closedShape(o.v) && !o.v.hasVerdict);
}
{
  const cur = JSON.parse('{"__proto__": {"outcome": "done"}, "primaryModel": "' + MODEL + '"}');
  const o = noThrow(() => baseline(hist(6), cur));
  check('current with only own model: no throw, all values null', !o.threw && closedShape(o.v) && o.v.metrics.every((m) => m.value === null));
}
{
  const c = CUR(); c.tasks = { get done() { throw new Error('boom'); } };
  check('current with throwing getter: no exception', !noThrow(() => baseline(hist(6), c)).threw);
}

// --- failed runs -----------------------------------------------------------------
{
  const cur = CUR(); cur.outcome = 'failed';
  const o = baseline(hist(9), cur);
  check('failed current: values yes, verdict never', closedShape(o) && !o.hasVerdict && o.reason === 'failed' && o.metrics.every((m) => m.verdict === null && m.median === null) && o.metrics.some((m) => m.value !== null));
  const o2 = baseline([], cur);
  check('failed current with empty history: still "failed", no verdict', o2.reason === 'failed' && !o2.hasVerdict);
  const cur3 = CUR(); cur3.outcome = 'failed'; cur3.primaryModel = null;
  check('failed current without model: no verdict', !baseline(hist(9), cur3).hasVerdict);
}
{
  const h = hist(5); h.push(...hist(20, (i) => ({ run: `f${i}`, closedAt: at(20 + i), outcome: 'failed', agent: { requests: 1, toolCalls: 1e9, toolErrors: 0, contextPeak: 5 } })));
  const o = baseline(h, CUR());
  check('failed rows never enter the base (count and median)', o.have === 5 && metricOf(o, 'toolCallsPerTask').median === 2 / 9);
  const fewer = baseline(hist(4).concat(hist(20, (i) => ({ run: `f${i}`, closedAt: at(20 + i), outcome: 'failed' }))), CUR());
  check('4 done + many newer failed: still too-few, not stolen', fewer.reason === 'too-few' && fewer.have === 4);
}

// --- model spoofing --------------------------------------------------------------
{
  const other = hist(9, () => ({ primaryModel: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'] }));
  const o = baseline(other, CUR());
  check('only other-model rows: no-model-base, no verdict', o.reason === 'no-model-base' && !o.hasVerdict && o.have === 0);
  const cased = baseline(hist(9, () => ({ primaryModel: 'CLAUDE-OPUS-5-5', models: ['CLAUDE-OPUS-5-5'] })), CUR());
  check('model case variant is a different model', cased.reason === 'no-model-base');
  const pad = baseline(hist(9, () => ({ primaryModel: MODEL + ' ' })), CUR());
  check('model with trailing space: row invalid, out of base', pad.have === 0);
  for (const evil of ['<script>alert(1)</script>', 'a'.repeat(5000), MODEL + '\n', '../x', '', 'x y', '__proto__', null]) {
    const c = CUR(); c.primaryModel = evil;
    const o = noThrow(() => baseline(hist(9), c));
    check(`current primaryModel ${JSON.stringify(evil).slice(0, 30)}: no verdict, no throw`, !o.threw && closedShape(o.v) && !o.v.hasVerdict && o.v.reason === 'no-model-base');
  }
  const claim = baseline(hist(9, () => ({ primaryModel: 'claude-sonnet-5-5', models: [MODEL, 'claude-sonnet-5-5'] })), CUR());
  check('models[] containing the current model does not enter the base', claim.have === 0);
  const nullModel = baseline(hist(9, () => ({ primaryModel: null })), Object.assign(CUR(), { primaryModel: null }));
  check('null model matches nothing (null === null must not build a base)', nullModel.reason === 'no-model-base' && !nullModel.hasVerdict);
}
{
  const c = CUR(); c.primaryModel = 'claude-x';
  const o = baseline(hist(6, () => ({ primaryModel: 'claude-x', models: ['claude-x'] })), c);
  check('no string from the inputs appears in the result', !JSON.stringify(o).includes('claude-x') && !JSON.stringify(o).includes('a-run'));
}

// --- current run excluded, duplicates, order, ties ---------------------------------
{
  const cur = CUR(); const same = clone(cur);
  const h = hist(5); h.push(same, clone(same), clone(same));
  check('the current run (same run+created) never enters its own base', baseline(h, cur).have === 5);
  const twin = row('cur', { created: '2026-09-27', closedAt: at(9) });
  check('same run name with another created is another run', baseline([...hist(5), twin], cur).have === 6);
}
{
  const a = hist(9); const b = [...a].reverse();
  check('order of history irrelevant (deterministic)', JSON.stringify(baseline(a, CUR())) === JSON.stringify(baseline(b, CUR())));
  const tie = hist(12, () => ({ closedAt: '2026-09-15T10:00:00Z' }));
  const x = baseline(tie, CUR()); const y = baseline([...tie].reverse(), CUR());
  check('ties on closedAt cut deterministically (by run)', JSON.stringify(x) === JSON.stringify(y) && x.have === 8);
  const cutOld = hist(9, (i) => ({ agent: { requests: 1, toolCalls: i === 0 ? 9e6 : 2, toolErrors: 0, contextPeak: 5 } }));
  check('only the 8 newest are used: the oldest outlier is out', metricOf(baseline(cutOld, CUR()), 'toolCallsPerTask').median === 2 / 9);
  const badDates = hist(6); badDates[0].closedAt = 'not a date'; badDates[1].closedAt = '2026-13-45T99:99:99Z'; badDates[2].closedAt = '2026-09-10T10:00:00+01:00';
  const o = noThrow(() => baseline(badDates, CUR()));
  check('invalid closedAt rows out of the base, no NaN sort', !o.threw && o.v.have === 3);
}

// --- options ---------------------------------------------------------------------
for (const [name, opt] of [
  ['n 0', { n: 0 }], ['n -1', { n: -1 }], ['n NaN', { n: NaN }], ['n Infinity', { n: Infinity }], ['n -Infinity', { n: -Infinity }],
  ['n string', { n: '3' }], ['n huge', { n: 1e300 }], ['n object', { n: {} }], ['n fraction', { n: 2.5 }],
  ['min 0', { min: 0 }], ['min -1', { min: -1 }], ['min NaN', { min: NaN }], ['min Infinity', { min: Infinity }],
  ['min string', { min: '5' }], ['min throwing object', { min: { valueOf: boom } }], ['min huge', { min: 1e300 }],
  ['n < min', { n: 2, min: 5 }], ['both hostile', { n: 'x', min: [] }], ['null', null], ['string', 'abc'], ['number', 3], ['array', []],
  ['throwing getter', { get n() { throw new Error('boom'); } }], ['proxy', HOSTILE()], ['inherited', Object.create({ n: 1, min: 1 })],
]) {
  const o = noThrow(() => baseline(hist(9), CUR(), opt));
  check(`options ${name}: no throw, closed shape (numbers only)`, !o.threw && closedShape(o.v), o.threw ? String(o.e && o.e.message) : JSON.stringify(o.v).slice(0, 120));
}
{
  const o = baseline(hist(9), CUR(), { n: 2, min: 5 });
  check('n < min: never a verdict from fewer rows than min', !o.hasVerdict && o.reason === 'too-few');
  check('min 0 cannot produce a verdict out of an empty base', !baseline([], CUR(), { min: 0 }).hasVerdict);
  check('min NaN cannot bypass the too-few guard', !baseline(hist(2), CUR(), { min: NaN }).hasVerdict);
  check('n NaN / negative / huge does not widen the base past the cap', [NaN, -1, 1e300, Infinity].every((n) => baseline(hist(20), CUR(), { n }).have <= CONSTANTS.BASELINE_N));
}

// --- arithmetic on the limits -----------------------------------------------------
{
  // toolErrors: median 0 per task, floor 1 per task: 9 errors over 9 done is ON the limit
  const h = hist(5, () => ({ agent: { requests: 1, toolCalls: 2, toolErrors: 0, contextPeak: 5 } }));
  const atLimit = CUR(); atLimit.agent.toolErrors = 9;
  const over = CUR(); over.agent.toolErrors = 10;
  check('median 0: the floor decides, on the limit ok', verdictOf(baseline(h, atLimit), 'toolErrorsPerTask') === 'ok');
  check('median 0: just past the floor is a deviation', verdictOf(baseline(h, over), 'toolErrorsPerTask') === 'deviation');
  const ctx = hist(5, () => ({ agent: { requests: 1, toolCalls: 2, toolErrors: 0, contextPeak: 100000 } }));
  const c1 = CUR(); c1.agent.contextPeak = 150000; const c2 = CUR(); c2.agent.contextPeak = 150001;
  check('contextPeak exactly m*1.5 ok, +1 deviation', verdictOf(baseline(ctx, c1), 'contextPeak') === 'ok' && verdictOf(baseline(ctx, c2), 'contextPeak') === 'deviation');
  const better = CUR(); better.agent.contextPeak = 0;
  check('better (lower) is never a deviation for a higher-is-worse metric', verdictOf(baseline(ctx, better), 'contextPeak') === 'ok');
  const cache = hist(5, () => ({ tokens: { input: 1, cacheCreate: 2, cacheRead: 3, output: 4, cacheHitRate: 0.94, byPhase: {} } }));
  const k = (v) => { const c = CUR(); c.tokens = { ...c.tokens, cacheHitRate: v }; return verdictOf(baseline(cache, c), 'cacheHitRate'); };
  check('cacheHitRate 0.94 -> 0.85 ok, 0.80 deviation, 1 ok, 0 deviation', k(0.85) === 'ok' && k(0.8) === 'deviation' && k(1) === 'ok' && k(0) === 'deviation');
  const zero = hist(5, () => ({ tokens: { input: 1, cacheCreate: 2, cacheRead: 3, output: 4, cacheHitRate: 0, byPhase: {} } }));
  const z0 = CUR(); z0.tokens = { ...z0.tokens, cacheHitRate: 0 };
  check('lower-is-worse with median 0: limit clamps at 0, no deviation', verdictOf(baseline(zero, z0), 'cacheHitRate') === 'ok');
  const huge = hist(5, () => ({ tokens: { input: 1e12, cacheCreate: 1e12, cacheRead: 1e12, output: 1e12, cacheHitRate: 1, byPhase: {} }, tasks: { total: 1, done: 1, skipped: 0, pending: 0, retries: 0, firstTime: 1 } }));
  const hc = CUR(); hc.tokens = { ...hc.tokens, input: 1e12, cacheCreate: 1e12, output: 1e12 }; hc.tasks = { ...hc.tasks, done: 1 };
  const ho = baseline(huge, hc);
  check('1e12 counters: finite, no overflow, ok', closedShape(ho) && verdictOf(ho, 'freshTokensPerTask') === 'ok');
  const tiny = hist(5, () => ({ tasks: { total: 1, done: 1e12, skipped: 0, pending: 0, retries: 0, firstTime: 1 } }));
  check('tasks.done 1e12: no underflow into NaN', closedShape(baseline(tiny, CUR())));
  check('all equal history and current: every verdict ok or n/d', baseline(hist(8), row('cur', { closedAt: at(30) })).metrics.every((m) => m.verdict === 'ok' || m.verdict === 'n/d'));
  const even = hist(6, (i) => ({ agent: { requests: 1, toolCalls: 0, toolErrors: 0, contextPeak: i < 3 ? 100 : 200 } }));
  check('even count median = mean of the two middle values', metricOf(baseline(even, CUR()), 'contextPeak').median === 150);
}
{
  check('DEVIATION is deeply frozen', Object.isFrozen(DEVIATION) && DEVIATION.every((d) => Object.isFrozen(d)));
  check('DEVIATION entries: closed keys and finite non-negative numbers', DEVIATION.every((d) => Object.keys(d).join() === 'id,per,worse,rel,floor' &&
    ['higher', 'lower'].includes(d.worse) && [null, 'task'].includes(d.per) && Number.isFinite(d.rel) && d.rel >= 0 && Number.isFinite(d.floor) && d.floor >= 0));
  check('DEVIATION ids unique', new Set(IDS).size === IDS.length);
  const t = noThrow(() => { 'use strict'; DEVIATION[0].rel = 99; });
  check('DEVIATION cannot be mutated', DEVIATION[0].rel === 0.5 && (t.threw || true));
  const r1 = baseline(hist(6), CUR()); const r2 = baseline(hist(6), CUR());
  check('result is a fresh object each call (no shared state)', r1 !== r2 && r1.metrics !== r2.metrics);
  check('no prototype pollution after all cases', ({}).polluted === undefined && Object.keys(Object.prototype).length === 0);
}

// --- purity: no I/O -----------------------------------------------------------------
{
  const src = fs.readFileSync(path.resolve(__dirname, '../plugin/scripts/metrics.js'), 'utf8');
  const start = src.indexOf('// --- baseline (spec R7)');
  const end = src.indexOf('module.exports');
  const section = src.slice(start, end);
  check('baseline section touches no fs/child_process/clock/process/require', start > 0 && end > start && !/\b(fs\.|child_process|spawn|exec\w*|readFileSync|writeFileSync|Date\.now|new Date|process\.|require\()/.test(section));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
