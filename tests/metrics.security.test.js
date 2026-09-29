#!/usr/bin/env node
// Security cases for plugin/scripts/metrics.js (T1): the closed-shape row validator
// and the state.json parser. Everything they read is written by someone else, so
// these assert the refusals: numeric edge cases, control characters, path-shaped
// names, limits, hostile objects that throw, and that nothing is echoed or polluted.
//
// Run: node tests/metrics.security.test.js

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

const { validateRow, parseRow, parseHealth } = require('../plugin/scripts/metrics.js');
const clone = (v) => JSON.parse(JSON.stringify(v));
const ROW = {
  v: 1, run: 'a-run', created: '2026-09-29', closedAt: '2026-09-30T14:02:11Z', outcome: 'done', mode: 'attended',
  primaryModel: 'claude-opus-5-5', models: ['claude-opus-5-5'], sizePoints: 5,
  tasks: { total: 9, done: 9, skipped: 0, pending: 0, retries: 1, firstTime: 8 },
  tests: { greenFirstRun: true }, review: { critical: 0, required: 2, optional: 3, nit: 1 }, hardenFindings: 0,
  questions: { total: 4, open: 0, explained: 1, maxRound: 2 },
  code: { added: 8, removed: 4, files: 1, testAdded: 4, codeAdded: 4 },
  tokens: { input: 1, cacheCreate: 2, cacheRead: 3, output: 4, cacheHitRate: 0.94, byPhase: { build: { in: 1, out: 2 } } },
  tokensNull: null, agent: { requests: 1, toolCalls: 2, toolErrors: 0, contextPeak: 5 },
};
const withEdit = (fn) => { const r = clone(ROW); fn(r); return r; };
const bad = (row) => { try { const x = validateRow(row); return x.ok === false && !('reason' in x) && !('row' in x); } catch { return false; } };
const good = (row) => { try { return validateRow(row).ok === true; } catch { return false; } };

// --- numeric edge cases (M-R10.3) ---------------------------------------------
for (const [label, value] of [['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity], ['negative', -1], ['1e12+1', 1e12 + 1], ['1e308', 1e308], ['fraction', 1.5], ['string', '5'], ['bigint', 5n], ['null', null], ['bool', true], ['array', [5]], ['object', { a: 1 }]]) {
  check(`S numeric: ${label} as a counter is rejected`, bad(withEdit((r) => { r.code.added = value; })));
}
check('S numeric: 1e12 (the ceiling) is accepted, 0 too', good(withEdit((r) => { r.code.added = 1e12; r.code.removed = 0; })));
check('S numeric: sizePoints / hardenFindings hold the same bound', bad(withEdit((r) => { r.sizePoints = 1e13; })) && bad(withEdit((r) => { r.hardenFindings = -3; })));
for (const [label, value] of [['NaN', NaN], ['Infinity', Infinity], ['-0.1', -0.1], ['1.0001', 1.0001], ['5 decimals', 0.12345], ['string', '0.5']]) {
  check(`S numeric: cacheHitRate ${label} is rejected`, bad(withEdit((r) => { r.tokens.cacheHitRate = value; })));
}
check('S numeric: 1e999 in a line parses to Infinity and is rejected', !parseRow(JSON.stringify(ROW).replace('"added":8', '"added":1e999')).ok);

// --- control characters and shapes in strings ---------------------------------
for (const [label, value] of [['newline', 'gpt\n'], ['NUL', 'a\u0000b'], ['ANSI escape', 'a\u001b[31m'], ['space', 'a b'], ['unicode look-alike', 'cl\u0430ude'], ['RTL override', 'a\u202eb'], ['81 chars', 'a'.repeat(81)], ['empty', ''], ['leading dot', '.x'], ['non-string', 7]]) {
  check(`S string: model with ${label} is rejected`, bad(withEdit((r) => { r.primaryModel = value; r.models = [value]; })));
}
check('S string: 80-char model is accepted', good(withEdit((r) => { r.primaryModel = 'a'.repeat(80); })));
check('S string: more than 8 models is rejected', bad(withEdit((r) => { r.models = Array(9).fill('m'); })));
for (const run of ['../evil', '..', '.', 'a/b', 'a\\b', 'C:\\x', 'a\n', 'a\u0000', '.hidden', '', 'a'.repeat(101), 'NUL:', '\\\\server\\share']) {
  check(`S run name: ${JSON.stringify(run).slice(0, 30)} is rejected`, bad(withEdit((r) => { r.run = run; })));
}
for (const created of ['2026-02-31', '2026-13-01', '2026-9-1', '2026-09-29\n', '2026-09-29T00:00:00Z', 20260929]) {
  check(`S date: ${JSON.stringify(created)} is rejected`, bad(withEdit((r) => { r.created = created; })));
}
for (const at of ['2026-09-30T14:02:11+01:00', '2026-09-30T14:02:11', '2026-09-30T25:02:11Z', '2026-02-30T10:00:00Z', '2026-09-30T14:02:11Z\n', '2026-09-30T14:02:11.1234Z', 'x'.repeat(5000)]) {
  check(`S instant: ${JSON.stringify(at).slice(0, 34)} is rejected`, bad(withEdit((r) => { r.closedAt = at; })));
}

// --- closed shapes ------------------------------------------------------------
check('S shape: unknown key in each block is rejected', ['tasks', 'tests', 'review', 'questions', 'code', 'agent', 'tokens'].every((k) => bad(withEdit((r) => { r[k].extra = 1; }))));
check('S shape: unknown key in byPhase entry / unknown phase / __proto__ phase rejected',
  bad(withEdit((r) => { r.tokens.byPhase.build.x = 1; })) && bad(withEdit((r) => { r.tokens.byPhase.evil = { in: 1, out: 1 }; })) &&
  bad(withEdit((r) => { r.tokens.byPhase = JSON.parse('{"__proto__":{"in":1,"out":1}}'); })));
check('S shape: a missing key is rejected', bad(withEdit((r) => { delete r.agent; })) && bad(withEdit((r) => { delete r.tasks.done; })));
check('S shape: arrays / primitives / null / undefined as the row never throw', [null, undefined, 5, 'x', [], [ROW], true].every(bad));
check('S shape: a block as an array or string is rejected', bad(withEdit((r) => { r.tasks = []; })) && bad(withEdit((r) => { r.review = 'x'; })));
check('S shape: tokens null needs a reason, a block forbids one, reason is a closed set',
  bad(withEdit((r) => { r.tokens = null; r.tokensNull = null; })) && bad(withEdit((r) => { r.tokensNull = 'overlap'; })) && bad(withEdit((r) => { r.tokens = null; r.tokensNull = 'free text'; })));
check('S shape: outcome / mode outside the closed sets are rejected', bad(withEdit((r) => { r.outcome = 'DONE'; })) && bad(withEdit((r) => { r.mode = 'x'; })));

// --- hostile objects: exceptions must not escape ------------------------------
const throwing = { get v() { throw new Error('SECRET-in-getter'); } };
check('S throw: a getter that throws yields ok:false, no exception, no message', (() => { try { const x = validateRow(throwing); return x.ok === false && !JSON.stringify(x).includes('SECRET'); } catch { return false; } })());
const proxy = new Proxy({}, { ownKeys() { throw new Error('SECRET-proxy'); }, has() { throw new Error('x'); }, getOwnPropertyDescriptor() { throw new Error('x'); } });
check('S throw: a throwing Proxy is contained by validateRow and parseHealth', (() => { try { return validateRow(proxy).ok === false && parseHealth(proxy).startedAt === null && parseHealth({ health: proxy }).health.review === null; } catch { return false; } })());
const circular = clone(ROW); circular.self = circular;
check('S throw: a circular object is just an unknown key', bad(circular));
let deep = []; for (let i = 0; i < 50000; i += 1) deep = [deep];
check('S throw: 50000-deep nesting in a field is contained', (() => { try { return validateRow({ ...clone(ROW), models: deep }).ok === false && parseHealth({ phaseLog: deep }).phaseLog === null; } catch { return false; } })());

// --- parseRow: size, echo, DoS -----------------------------------------------
const secret = 'TOPSECRET-token-123';
check('S parseRow: garbage text is not echoed', (() => { const x = parseRow(`{"a":"${secret}" oops`); return x.ok === false && !JSON.stringify(x).includes(secret); })());
check('S parseRow: a valid-JSON but invalid row is not echoed', (() => { const x = parseRow(JSON.stringify({ ...ROW, run: secret + '/../' })); return x.ok === false && !JSON.stringify(x).includes(secret); })());
check('S parseRow: 5 MB line is refused fast (no parse)', (() => { const t = Date.now(); const x = parseRow('{"a":"' + 'x'.repeat(5e6) + '"}'); return x.ok === false && Date.now() - t < 500; })());
check('S parseRow: near-limit pathological regex input is fast', (() => { const t = Date.now(); parseRow(JSON.stringify({ ...ROW, run: 'a'.repeat(100) + '!', primaryModel: 'a'.repeat(3000) + '!' })); return Date.now() - t < 500; })());
check('S parseRow: a __proto__ key in raw text does not pollute', (() => { parseRow('{"__proto__":{"polluted":1},"v":1}'); parseRow(JSON.stringify(ROW).replace('"tasks":{', '"tasks":{"__proto__":{"polluted":1},')); return ({}).polluted === undefined; })());
check('S parseRow: NUL / lone surrogate / non-string inputs never throw', ['\u0000', '\ud800', '', ' ', null, undefined, 5, {}, []].every((x) => { try { return parseRow(x).ok === false; } catch { return false; } }));
check('S parseRow: two parses of one line share nothing', (() => { const line = JSON.stringify(ROW); const a = parseRow(line).row; const b = parseRow(line).row; a.tasks.total = 99; return b.tasks.total === 9; })());

// --- parseHealth limits and type confusion ------------------------------------
const okAt = '2026-09-29T10:00:00Z';
check('S health: 17 phaseLog entries is rejected, 16 accepted',
  parseHealth({ phaseLog: Array(17).fill({ phase: 'spec', at: okAt }) }).phaseLog === null && parseHealth({ phaseLog: Array(16).fill({ phase: 'spec', at: okAt }) }).phaseLog.length === 16);
check('S health: phaseLog entry with unknown phase / extra key / bad instant / sparse hole / non-array is rejected',
  [[{ phase: 'nope', at: okAt }], [{ phase: 'spec', at: okAt, x: 1 }], [{ phase: 'spec', at: 'now' }], [{ phase: 'toString', at: okAt }], [{ phase: 'constructor', at: okAt }], [, { phase: 'spec', at: okAt }], 'spec', { length: 1, 0: { phase: 'spec', at: okAt } }]
    .every((v) => parseHealth({ phaseLog: v }).phaseLog === null));
check('S health: 201 taskRetries keys rejected', (() => { const m = {}; for (let i = 1; i <= 201; i += 1) m[`T${i}`] = 1; return parseHealth({ health: { taskRetries: m } }).health.taskRetries === null; })());
check('S health: taskRetries bad ids / counts are all-or-nothing rejected',
  ['T', 'T0x', 'x1', 'T1\n', ' T1', 'T12345', 'T1.2.3', '__proto__', 'constructor', 'T1/../x'].every((k) => parseHealth({ health: { taskRetries: { T1: 1, [k]: 1 } } }).health.taskRetries === null) &&
  [0, -1, 100, 1.5, NaN, Infinity, '1', null].every((c) => parseHealth({ health: { taskRetries: { T1: c } } }).health.taskRetries === null));
check('S health: the parsed taskRetries has no prototype to pollute', (() => { const m = parseHealth({ health: { taskRetries: { T1: 2 } } }).health.taskRetries; return Object.getPrototypeOf(m) === null && m.T1 === 2; })());
check('S health: review numbers out of range / extra key / bad notReproduced / array are rejected',
  [{ critical: -1, required: 0, optional: 0, nit: 0 }, { critical: 1e13, required: 0, optional: 0, nit: 0 }, { critical: 0, required: 0, optional: 0, nit: 0, extra: 1 }, { critical: 0, required: 0, optional: 0, nit: 0, notReproduced: NaN }, { critical: '0', required: 0, optional: 0, nit: 0 }, []]
    .every((v) => parseHealth({ health: { review: v } }).health.review === null));
check('S health: inherited top-level fields do not count', (() => {
  const state = Object.create({ startedAt: okAt, phaseLog: [], health: { hardenFindings: 3 } });
  const r = parseHealth(state); return r.phaseLog === null && r.health.hardenFindings === null;
})());
check('S health: inherited health keys do not count', (() => { const h = Object.create({ hardenFindings: 3, testsGreenFirstRun: true }); const r = parseHealth({ health: h }); return r.health.hardenFindings === null && r.health.testsGreenFirstRun === null; })());
check('S health: startedAt with offset, newline, huge string, number is null', ['2026-09-29T10:00:00+00:00', okAt + '\n', 'x'.repeat(1e6), 1780000000000, {}].every((v) => parseHealth({ startedAt: v }).startedAt === null));
check('S health: hardenFindings NaN / negative / huge / string is null', [NaN, -1, 1e13, '2', Infinity].every((v) => parseHealth({ health: { hardenFindings: v } }).health.hardenFindings === null));
check('S health: non-object states never throw and give all nulls', [null, undefined, 5, 'x', [], () => 1].every((s) => { try { const r = parseHealth(s); return r.startedAt === null && r.phaseLog === null && r.health.review === null; } catch { return false; } }));
check('S health: nothing was polluted by any case above', ({}).polluted === undefined && Object.prototype.polluted === undefined);

try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length) { console.log(`${failures.length} failing:`); for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
