#!/usr/bin/env node
// Tests for plugin/scripts/metrics.js - the run-health measurement.
//
// Same shape as the other suites: a standalone script, a check() counter, an exit
// code. The R-cases (M-R...) say what the module does; the S-cases say what it
// refuses to do. Everything metrics.js reads - state.json, metrics.jsonl,
// transcripts - is written by someone else, so the S-cases are as load-bearing as
// the R-cases, and here in T1 that means the closed-shape row validator and the
// state.json parser: a wrong shape is IGNORED, never thrown and never echoed.
//
// Run: node tests/metrics.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

// Same isolation as the other suites: a home of its own, so nothing here can read
// or write the real one (later tasks read ~/.claude/projects and write the feed).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.LOCALAPPDATA = TEST_HOME;
process.env.XDG_STATE_HOME = TEST_HOME;

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` - ${detail}` : ''}`);
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

/** Runs fn; true when it did not throw. The module's contract is "never throws". */
function quiet(fn) {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

const SCRIPT = path.join(__dirname, '..', 'plugin', 'scripts', 'metrics.js');
const metrics = require(SCRIPT);
const render = require('../plugin/scripts/render-run.js');
const { validateRow, parseRow, parseHealth, PHASES } = metrics;

// --- fixtures ---------------------------------------------------------------

const clone = (value) => JSON.parse(JSON.stringify(value));

const FULL_ROW = {
  v: 1,
  run: 'medicao-saude-das-runs',
  created: '2026-09-29',
  closedAt: '2026-09-30T14:02:11Z',
  outcome: 'done',
  mode: 'attended',
  primaryModel: 'claude-opus-5-5',
  models: ['claude-opus-5-5'],
  sizePoints: 5,
  tasks: { total: 9, done: 9, skipped: 0, pending: 0, retries: 1, firstTime: 8 },
  tests: { greenFirstRun: true },
  review: { critical: 0, required: 2, optional: 3, nit: 1 },
  hardenFindings: 0,
  questions: { total: 4, open: 0, explained: 1, maxRound: 2 },
  code: { added: 812, removed: 40, files: 11, testAdded: 430, codeAdded: 382 },
  tokens: {
    input: 1200,
    cacheCreate: 310000,
    cacheRead: 5200000,
    output: 91000,
    cacheHitRate: 0.94,
    byPhase: { spec: { in: 0, out: 0 }, build: { in: 10, out: 20 }, other: { in: 1, out: 2 } },
  },
  tokensNull: null,
  agent: { requests: 210, toolCalls: 388, toolErrors: 7, contextPeak: 141000 },
};

const NULL_ROW = {
  ...clone(FULL_ROW),
  primaryModel: null,
  models: [],
  sizePoints: null,
  tasks: null,
  tests: null,
  review: null,
  hardenFindings: null,
  questions: null,
  code: null,
  tokens: null,
  tokensNull: 'no-transcripts',
  agent: null,
};

/** A copy of FULL_ROW with one edit applied by fn. */
function rowWith(fn) {
  const row = clone(FULL_ROW);
  fn(row);
  return row;
}

const accepted = (row) => validateRow(row).ok === true;
const rejected = (row) => {
  let result;
  try {
    result = validateRow(row);
  } catch {
    return false;
  }
  return result.ok === false;
};

// --- M-R2.1 / M-R2.2: the closed-shape row -----------------------------------
{
  check('M-R2.1 a full row passes the validator', accepted(FULL_ROW), JSON.stringify(validateRow(FULL_ROW)));
  check('M-R2.1 a row with every block null passes', accepted(NULL_ROW), JSON.stringify(validateRow(NULL_ROW)));
  check('M-R2.1 the validator hands back the row it accepted', validateRow(FULL_ROW).row.run === FULL_ROW.run);
  check('M-R2.1 failed outcome and auto mode are in the closed sets', accepted(rowWith((r) => { r.outcome = 'failed'; r.mode = 'auto'; })));
  check('M-R2.1 tasks.retries/firstTime may be null (no state.health)', accepted(rowWith((r) => { r.tasks.retries = null; r.tasks.firstTime = null; r.tests = { greenFirstRun: null }; })));
  check('M-R2.1 cacheHitRate null (zero denominator) passes', accepted(rowWith((r) => { r.tokens.cacheHitRate = null; })));
  check('M-R2.1 every tokensNull reason from the closed set is accepted', ['no-transcripts', 'unreadable-format', 'overlap', 'no-window', 'timeout', 'disabled'].every((reason) => accepted({ ...clone(NULL_ROW), tokensNull: reason })));

  const cases = {
    'extra top-level field': rowWith((r) => { r.note = 'x'; }),
    'extra field inside tasks': rowWith((r) => { r.tasks.extra = 1; }),
    'extra field inside tokens': rowWith((r) => { r.tokens.extra = 1; }),
    'extra field inside byPhase entry': rowWith((r) => { r.tokens.byPhase.spec.extra = 1; }),
    'missing top-level field': rowWith((r) => { delete r.agent; }),
    'run with ..': rowWith((r) => { r.run = '..'; }),
    'run with /': rowWith((r) => { r.run = 'a/b'; }),
    'run with a backslash': rowWith((r) => { r.run = 'a\\b'; }),
    'run over 100 chars': rowWith((r) => { r.run = 'a'.repeat(101); }),
    'created not a date': rowWith((r) => { r.created = '2026-13-45'; }),
    'created with time': rowWith((r) => { r.created = '2026-09-29T00:00:00Z'; }),
    'closedAt without Z': rowWith((r) => { r.closedAt = '2026-09-30T14:02:11'; }),
    'closedAt with an offset': rowWith((r) => { r.closedAt = '2026-09-30T14:02:11+01:00'; }),
    'outcome outside the set': rowWith((r) => { r.outcome = 'running'; }),
    'mode outside the set': rowWith((r) => { r.mode = 'yolo'; }),
    'negative number': rowWith((r) => { r.code.added = -1; }),
    'NaN': rowWith((r) => { r.code.added = NaN; }),
    'Infinity': rowWith((r) => { r.code.added = Infinity; }),
    'numeric string': rowWith((r) => { r.code.added = '812'; }),
    'fractional counter': rowWith((r) => { r.code.added = 1.5; }),
    '1e13': rowWith((r) => { r.tokens.input = 1e13; }),
    'sizePoints as string': rowWith((r) => { r.sizePoints = '5'; }),
    'cacheHitRate above 1': rowWith((r) => { r.tokens.cacheHitRate = 1.2; }),
    'cacheHitRate negative': rowWith((r) => { r.tokens.cacheHitRate = -0.1; }),
    'cacheHitRate with 5 decimals': rowWith((r) => { r.tokens.cacheHitRate = 0.12345; }),
    'primaryModel with a space': rowWith((r) => { r.primaryModel = 'claude opus'; }),
    'primaryModel with <script>': rowWith((r) => { r.primaryModel = '<script>'; }),
    'primaryModel over 80 chars': rowWith((r) => { r.primaryModel = 'm'.repeat(81); }),
    'models entry with markup': rowWith((r) => { r.models = ['ok', '<img onerror=1>']; }),
    'models with 9 entries': rowWith((r) => { r.models = Array.from({ length: 9 }, (_, i) => `m${i}`); }),
    'models not an array': rowWith((r) => { r.models = 'claude-opus-5-5'; }),
    'tokensNull outside the set': rowWith((r) => { r.tokens = null; r.tokensNull = 'because'; }),
    'tokensNull set while tokens is present': rowWith((r) => { r.tokensNull = 'timeout'; }),
    'tokens null with tokensNull null': rowWith((r) => { r.tokens = null; }),
    'byPhase with an arbitrary key': rowWith((r) => { r.tokens.byPhase.evil = { in: 0, out: 0 }; }),
    'byPhase with a path-like key': rowWith((r) => { r.tokens.byPhase['../x'] = { in: 0, out: 0 }; }),
    'byPhase entry with a negative number': rowWith((r) => { r.tokens.byPhase.spec.in = -1; }),
    'tests.greenFirstRun as a string': rowWith((r) => { r.tests.greenFirstRun = 'true'; }),
    'a block as an array': rowWith((r) => { r.tasks = []; }),
    'row as an array': [],
    'row as null': null,
    'row as a string': 'nope',
    'row as a number': 7,
  };
  for (const [name, row] of Object.entries(cases)) check(`M-R2.2 rejected without throwing: ${name}`, rejected(row));

  check('M-R2.2 v: 2 is IGNORED, not an error', (() => { const r = validateRow(rowWith((x) => { x.v = 2; })); return r.ok === false && r.ignored === true; })());
  check('M-R2.2 v: "1" is not version 1', rejected(rowWith((r) => { r.v = '1'; })));
  check('M-R2.2 a real error is not flagged as ignored', validateRow(cases['extra top-level field']).ignored !== true);

  // The line-level entry: the 4096 byte cap and JSON.parse live here.
  check('M-R2.2 parseRow accepts the serialised full row', parseRow(JSON.stringify(FULL_ROW)).ok === true);
  check('M-R2.2 parseRow tolerates BOM and a CRLF ending', parseRow(`﻿${JSON.stringify(FULL_ROW)}\r\n`).ok === true);
  const huge = rowWith((r) => { r.tokens.byPhase.other = { in: 1, out: 1 }; });
  const padded = `${JSON.stringify(huge)}${' '.repeat(4100)}`;
  check('M-R2.2 a line over 4096 bytes is rejected', quiet(() => parseRow(padded)) && parseRow(padded).ok === false);
  check('M-R2.2 the 4096 limit is in BYTES, not characters', (() => {
    const wide = JSON.stringify(rowWith((r) => { r.run = 'a'; })).slice(0, -1);
    const line = `${wide},"x":"${'é'.repeat(2100)}"}`; // ~4200 bytes, ~2200 chars
    return Buffer.byteLength(line) > 4096 && line.length < 4096 && parseRow(line).ok === false;
  })());
  for (const bad of ['', '   ', '{', '{"v":1', 'null', '[]', '"x"', 'not json', '{"v":1}\u0000']) {
    check(`M-R2.2 parseRow never throws on ${JSON.stringify(bad)}`, quiet(() => parseRow(bad)) && parseRow(bad).ok === false);
  }
  check('M-R2.2 parseRow does not echo the JSON.parse message or the input', !JSON.stringify(parseRow('{"secret":')).includes('secret'));
  check('M-R2.2 parseRow on a non-string never throws', quiet(() => parseRow(undefined)) && quiet(() => parseRow({})));
}

// --- M-R10.2: prototype pollution --------------------------------------------
{
  const evilRow = JSON.parse(JSON.stringify(FULL_ROW).replace('"tasks":{', '"tasks":{"__proto__":1,'));
  check('M-R10.2 a row with an own __proto__ key inside tasks is rejected', rejected(evilRow));
  check('M-R10.2 a row with an own __proto__ top-level key is rejected', rejected(JSON.parse('{"__proto__":{"polluted":1},"v":1}')));
  check('M-R10.2 constructor/prototype keys are just unknown keys', rejected(rowWith((r) => { r.constructor = 1; })) && rejected(rowWith((r) => { r.tasks.prototype = 1; })));
  const state = { health: JSON.parse('{"taskRetries":{"__proto__":1}}') };
  const parsed = parseHealth(state);
  check('M-R10.2 {"__proto__": 1} in taskRetries is rejected', parsed.health.taskRetries === null);
  check('M-R10.2 nothing was polluted', ({}).polluted === undefined && Object.prototype.polluted === undefined);
  const polluting = parseHealth({ health: JSON.parse('{"taskRetries":{"__proto__":{"polluted":true}},"review":{"__proto__":{"polluted":true}}}') });
  check('M-R10.2 a __proto__ object payload does not pollute either', ({}).polluted === undefined && polluting.health.taskRetries === null && polluting.health.review === null);
  check('M-R10.2 a phaseLog entry with __proto__ is rejected', parseHealth({ phaseLog: JSON.parse('[{"__proto__":{"polluted":true},"phase":"spec","at":"2026-09-29T10:00:00Z"}]') }).phaseLog === null && ({}).polluted === undefined);
}

// --- M-R5.1 / M-R5.2: parseHealth --------------------------------------------
{
  const GOOD_STATE = {
    task: 'x',
    startedAt: '2026-09-29T10:00:00Z',
    phaseLog: [
      { phase: 'idea', at: '2026-09-29T10:05:00Z' },
      { phase: 'spec', at: '2026-09-29T11:00:00.250Z' },
    ],
    health: {
      taskRetries: { T1: 1, 'T2.1': 2, D3: 99 },
      testsGreenFirstRun: false,
      review: { critical: 0, required: 2, optional: 3, nit: 1, notReproduced: 1 },
      hardenFindings: 4,
    },
  };
  const ok = parseHealth(GOOD_STATE);
  check('M-R5.1 a valid state parses in full', ok.startedAt === '2026-09-29T10:00:00Z' && ok.phaseLog.length === 2 && ok.health.taskRetries.T1 === 1 && ok.health.taskRetries['T2.1'] === 2 && ok.health.testsGreenFirstRun === false && ok.health.review.required === 2 && ok.health.hardenFindings === 4, JSON.stringify(ok));
  check('M-R5.1 the review block keeps notReproduced apart', ok.health.review.notReproduced === 1);
  check('M-R5.1 PHASES is the renderer PHASES', PHASES === render.PHASES || JSON.stringify(PHASES) === JSON.stringify(render.PHASES));

  const NOTHING = { startedAt: null, phaseLog: null, health: { taskRetries: null, testsGreenFirstRun: null, review: null, hardenFindings: null } };
  for (const bad of [undefined, null, 'str', 7, [], {}, { health: null }, { health: [] }, { health: 'x' }, { health: 5 }]) {
    check(`M-R5.1 state ${JSON.stringify(bad)} gives every metric null`, quiet(() => parseHealth(bad)) && JSON.stringify(parseHealth(bad)) === JSON.stringify(NOTHING), JSON.stringify(parseHealth(bad)));
  }

  const field = (state) => parseHealth(state);
  const each = (label, state, pick) => check(`M-R5.1 ${label} -> null, no throw`, quiet(() => field(state)) && pick(field(state)) === null, JSON.stringify(field(state)));

  each('startedAt not a string', { startedAt: 12345 }, (p) => p.startedAt);
  each('startedAt without Z', { startedAt: '2026-09-29T10:00:00' }, (p) => p.startedAt);
  each('startedAt not a real date', { startedAt: '2026-19-99T10:00:00Z' }, (p) => p.startedAt);
  each('startedAt an object', { startedAt: { a: 1 } }, (p) => p.startedAt);
  each('startedAt over-long', { startedAt: `2026-09-29T10:00:00Z${'0'.repeat(500)}` }, (p) => p.startedAt);

  each('phaseLog not an array', { phaseLog: { phase: 'spec' } }, (p) => p.phaseLog);
  each('phaseLog with 17 entries', { phaseLog: Array.from({ length: 17 }, () => ({ phase: 'spec', at: '2026-09-29T10:00:00Z' })) }, (p) => p.phaseLog);
  each('phaseLog giant array', { phaseLog: new Array(100000).fill({ phase: 'spec', at: '2026-09-29T10:00:00Z' }) }, (p) => p.phaseLog);
  each('phaseLog phase outside PHASES', { phaseLog: [{ phase: 'launch', at: '2026-09-29T10:00:00Z' }] }, (p) => p.phaseLog);
  each('phaseLog phase with a path', { phaseLog: [{ phase: '../x', at: '2026-09-29T10:00:00Z' }] }, (p) => p.phaseLog);
  each('phaseLog entry with an extra key', { phaseLog: [{ phase: 'spec', at: '2026-09-29T10:00:00Z', note: 'hi' }] }, (p) => p.phaseLog);
  each('phaseLog entry with a bad instant', { phaseLog: [{ phase: 'spec', at: 'yesterday' }] }, (p) => p.phaseLog);
  each('phaseLog entry nested array', { phaseLog: [[{ phase: 'spec' }]] }, (p) => p.phaseLog);
  each('phaseLog entry null', { phaseLog: [null] }, (p) => p.phaseLog);
  check('M-R5.1 an empty phaseLog is valid and empty', Array.isArray(parseHealth({ phaseLog: [] }).phaseLog) && parseHealth({ phaseLog: [] }).phaseLog.length === 0);

  const hp = (health) => parseHealth({ health }).health;
  each('taskRetries an array', { health: { taskRetries: [1] } }, (p) => p.health.taskRetries);
  each('taskRetries key outside the pattern', { health: { taskRetries: { 'not-a-task': 1 } } }, (p) => p.health.taskRetries);
  each('taskRetries key with a path', { health: { taskRetries: { '../T1': 1 } } }, (p) => p.health.taskRetries);
  each('taskRetries key T1.2.3', { health: { taskRetries: { 'T1.2.3': 1 } } }, (p) => p.health.taskRetries);
  each('taskRetries value 0', { health: { taskRetries: { T1: 0 } } }, (p) => p.health.taskRetries);
  each('taskRetries value 100', { health: { taskRetries: { T1: 100 } } }, (p) => p.health.taskRetries);
  each('taskRetries negative value', { health: { taskRetries: { T1: -1 } } }, (p) => p.health.taskRetries);
  each('taskRetries string value', { health: { taskRetries: { T1: '<img onerror>' } } }, (p) => p.health.taskRetries);
  each('taskRetries nested value', { health: { taskRetries: { T1: { n: 1 } } } }, (p) => p.health.taskRetries);
  each('taskRetries fractional value', { health: { taskRetries: { T1: 1.5 } } }, (p) => p.health.taskRetries);
  each('taskRetries 201 keys', { health: { taskRetries: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`T${i + 1}`, 1])) } }, (p) => p.health.taskRetries);
  check('M-R5.1 taskRetries with exactly 200 keys is fine', hp({ taskRetries: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`T${i + 1}`, 1])) }).taskRetries !== null);
  check('M-R5.1 an empty taskRetries is valid (no retries happened)', hp({ taskRetries: {} }).taskRetries !== null);

  each('testsGreenFirstRun a string', { health: { testsGreenFirstRun: 'true' } }, (p) => p.health.testsGreenFirstRun);
  each('testsGreenFirstRun a number', { health: { testsGreenFirstRun: 1 } }, (p) => p.health.testsGreenFirstRun);

  each('review negative', { health: { review: { critical: -1, required: 0, optional: 0, nit: 0 } } }, (p) => p.health.review);
  each('review missing a key', { health: { review: { critical: 0, required: 0, optional: 0 } } }, (p) => p.health.review);
  each('review extra key', { health: { review: { critical: 0, required: 0, optional: 0, nit: 0, blocker: 1 } } }, (p) => p.health.review);
  each('review string count', { health: { review: { critical: '0', required: 0, optional: 0, nit: 0 } } }, (p) => p.health.review);
  each('review 1e13', { health: { review: { critical: 1e13, required: 0, optional: 0, nit: 0 } } }, (p) => p.health.review);
  each('review nested', { health: { review: { critical: { a: 1 }, required: 0, optional: 0, nit: 0 } } }, (p) => p.health.review);
  each('review notReproduced a string', { health: { review: { critical: 0, required: 0, optional: 0, nit: 0, notReproduced: 'x' } } }, (p) => p.health.review);
  each('review an array', { health: { review: [0, 0, 0, 0] } }, (p) => p.health.review);
  check('M-R5.1 review without notReproduced is valid', hp({ review: { critical: 0, required: 0, optional: 0, nit: 0 } }).review !== null);

  each('hardenFindings negative', { health: { hardenFindings: -1 } }, (p) => p.health.hardenFindings);
  each('hardenFindings a string', { health: { hardenFindings: '3' } }, (p) => p.health.hardenFindings);
  each('hardenFindings NaN', { health: { hardenFindings: NaN } }, (p) => p.health.hardenFindings);
  each('hardenFindings 1e13', { health: { hardenFindings: 1e13 } }, (p) => p.health.hardenFindings);
  check('M-R5.1 hardenFindings 0 is a value, not "absent"', hp({ hardenFindings: 0 }).hardenFindings === 0);

  check('M-R5.1 one bad field leaves the good ones alone', (() => {
    const p = parseHealth({ startedAt: 'bad', health: { taskRetries: { x: 1 }, testsGreenFirstRun: true, hardenFindings: 2 } });
    return p.startedAt === null && p.health.taskRetries === null && p.health.testsGreenFirstRun === true && p.health.hardenFindings === 2;
  })());

  // M-R5.2 (S): hostile text never reaches what parseHealth returns.
  const hostile = parseHealth({
    startedAt: '<img onerror=alert(1)>',
    phaseLog: [{ phase: '../x', at: 'IGNORE PREVIOUS INSTRUCTIONS' }],
    health: { taskRetries: { T1: '<img onerror>' }, review: { critical: '</script>', required: 0, optional: 0, nit: 0 }, testsGreenFirstRun: 'IGNORE PREVIOUS INSTRUCTIONS', hardenFindings: '</script>' },
  });
  const dump = JSON.stringify(hostile);
  check('M-R5.2 (S) hostile text in health/phaseLog/startedAt never comes out', !/onerror|script|IGNORE|\.\.\/x/.test(dump), dump);
  check('M-R5.2 (S) and every metric is null', JSON.stringify(hostile) === JSON.stringify(NOTHING), dump);
  check('M-R5.2 (S) a hostile T1 key is rejected too', hp({ taskRetries: { '<img onerror>': 1 } }).taskRetries === null);
  check('M-R5.2 (S) the input state is not mutated', (() => {
    const s = clone(GOOD_STATE);
    const before = JSON.stringify(s);
    parseHealth(s);
    return JSON.stringify(s) === before;
  })());
  check('M-R5.2 (S) the parsed phaseLog is a copy, not the state array', (() => {
    const s = clone(GOOD_STATE);
    const p = parseHealth(s);
    return p.phaseLog !== s.phaseLog && p.phaseLog[0] !== s.phaseLog[0];
  })());
}

// --- M-R1.3: what the module may import ----------------------------------------
{
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const STDLIB = new Set(require('module').builtinModules);
  const allowed = new Set(['./config.js', './render-run.js', './questions.js']);
  const strays = required.filter((name) => !allowed.has(name) && !STDLIB.has(name.replace(/^node:/, '')));
  check('M-R1.3 metrics.js requires only stdlib and config/render-run/questions', strays.length === 0, strays.join(', '));
  check('M-R1.3 metrics.js requires at least render-run.js (PHASES, SAFE_SEGMENT)', required.includes('./render-run.js'));
  check('M-R1.3 no dynamic require and no eval / Function', !/\brequire\(\s*[^'"\s]/.test(source) && !/\beval\s*\(|new Function\s*\(/.test(source));
  check('M-R1.3 metrics.js does not shell out (no child_process in T1)', !required.includes('child_process') || /execFileSync/.test(source));
}

// --- render-run.js exports the parsers metrics.js reuses -----------------------
{
  check('R1 render-run exports SAFE_SEGMENT', render.SAFE_SEGMENT instanceof RegExp && render.SAFE_SEGMENT.test('abc') && !render.SAFE_SEGMENT.test('../x'));
  check('R1 render-run exports readJson', typeof render.readJson === 'function');
  check('R1 render-run exports readSkippedTasks and readPendingTasks', typeof render.readSkippedTasks === 'function' && typeof render.readPendingTasks === 'function');
  check('R1 metrics accepts run names exactly as the renderer does', accepted(rowWith((r) => { r.run = 'a.b_c-d'; })) && rejected(rowWith((r) => { r.run = '-lead'; })));
}

// --- constants ------------------------------------------------------------------
{
  const c = metrics.CONSTANTS;
  check('R7 the guessed constants are named and exported (N=8, min=5)', c && c.BASELINE_N === 8 && c.BASELINE_MIN === 5, JSON.stringify(c));
  check('R4 the time budget is 5 s', c && c.BUDGET_MS === 5000);
  check('R10 history read limits: 4096 B row, 1 MiB tail, 200 of 10000 rows', c && c.MAX_ROW_BYTES === 4096 && c.HISTORY_TAIL_BYTES === 1024 * 1024 && c.HISTORY_MAX_ROWS === 10000 && c.HISTORY_KEEP_ROWS === 200);
  check('R6 transcript limits: 500 files, 64 MiB/file, 512 MiB total, 1 MiB/line', c && c.MAX_TRANSCRIPT_FILES === 500 && c.MAX_TRANSCRIPT_FILE_BYTES === 64 * 1024 * 1024 && c.MAX_TRANSCRIPT_TOTAL_BYTES === 512 * 1024 * 1024 && c.MAX_TRANSCRIPT_LINE_BYTES === 1024 * 1024);
  check('R9 git limits: 3 s, 1 MiB', c && c.GIT_TIMEOUT_MS === 3000 && c.GIT_MAX_BUFFER === 1024 * 1024);
  check('the constants object is frozen', c && Object.isFrozen(c));
}

// --- T2: history reader and safe writer (spec R3, R10.1-3, M-R4.2 read side) ---------
{
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-hist-'));
  const project = mk();
  const stateDir = path.join(project, '.claude', 'task-flow');
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'metrics.jsonl');
  const named = (run, created = '2026-09-29') => rowWith((r) => { r.run = run; r.created = created; });
  const trySymlink = (target, linkPath, type) => {
    try {
      fs.symlinkSync(target, linkPath, type);
      return true;
    } catch {
      console.log(`  skip  no permission to create a ${type || 'file'} link here`);
      return false;
    }
  };

  check('T2 exports readHistory and appendRow', typeof metrics.readHistory === 'function' && typeof metrics.appendRow === 'function');
  const { readHistory, appendRow } = metrics;
  const runs = (h) => h.rows.map((r) => r.run).join();

  let h = readHistory(project, stateDir);
  check('R3 no metrics.jsonl yet: empty history, no code', h.rows.length === 0 && h.ignored === 0 && h.code === null, JSON.stringify(h));

  const w = appendRow(project, stateDir, named('run-a'));
  check('M-R3.1 append creates the file and reports ok', w.ok === true && fs.existsSync(file), JSON.stringify(w));
  const text = fs.readFileSync(file, 'utf8');
  check('M-R3.1 exactly one line, ending in a newline, parseable by parseRow', text.endsWith('\n') && text.split('\n').filter(Boolean).length === 1 && parseRow(text).ok === true);
  check('M-R3.1 nothing but metrics.jsonl was added to the state folder', fs.readdirSync(stateDir).join() === 'metrics.jsonl');
  h = readHistory(project, stateDir);
  check('M-R3.1 the history reads it back', runs(h) === 'run-a');

  const before = fs.readFileSync(file, 'utf8');
  const bad = appendRow(project, stateDir, { ...named('run-b'), extra: 1 });
  check('R2 an invalid row is refused (invalid-row) and not written', bad.ok === false && bad.code === 'invalid-row' && fs.readFileSync(file, 'utf8') === before, JSON.stringify(bad));
  check('R2 a non-object row does not throw', quiet(() => appendRow(project, stateDir, null)) && appendRow(project, stateDir, null).code === 'invalid-row');

  // M-R3.3: a line truncated by a crash gets a newline of repair before the next row
  fs.writeFileSync(file, `${JSON.stringify(named('run-old'))}\n{"v":1,"run":"trunc`);
  const w2 = appendRow(project, stateDir, named('run-new'));
  const raw = fs.readFileSync(file, 'utf8');
  h = readHistory(project, stateDir);
  check('M-R3.3 new row lands on its own line after a truncated one', w2.ok === true && raw.split('\n').length === 4 && raw.endsWith('\n'), JSON.stringify(raw));
  check('M-R3.3 earlier history stays readable, the fragment is counted as ignored', runs(h) === 'run-old,run-new' && h.ignored === 1, `${runs(h)} / ${h.ignored}`);

  // tolerant reading: BOM, CRLF, blank lines, garbage
  fs.writeFileSync(file, `﻿${JSON.stringify(named('r1'))}\r\n\r\n\n${JSON.stringify(named('r2'))}\r\nnot json\r\n[1,2]\r\n${JSON.stringify(named('r3'))}`);
  h = readHistory(project, stateDir);
  check('R10.1 BOM, CRLF, blank and garbage lines: valid rows survive', runs(h) === 'r1,r2,r3', runs(h));
  check('R10.1 invalid non-blank lines are counted, blank ones are not', h.ignored === 2, String(h.ignored));

  // M-R10.3: a hand-edited absurd number
  fs.writeFileSync(file, `${JSON.stringify(rowWith((r) => { r.run = 'hostile'; r.tokens.input = 1e15; }))}\n${JSON.stringify(named('fine'))}\n`);
  h = readHistory(project, stateDir);
  check('M-R10.3 a line with tokens.input 1e15 is ignored', runs(h) === 'fine' && h.ignored === 1);

  const big = JSON.stringify(named('big')).replace('"models":["claude-opus-5-5"]', `"models":[${'"x",'.repeat(2000)}"x"]`);
  fs.writeFileSync(file, `${big}\n${JSON.stringify(named('small'))}\n`);
  h = readHistory(project, stateDir);
  check('R10.2 a line over 4096 bytes is ignored', big.length > 4096 && runs(h) === 'small' && h.ignored === 1, runs(h));

  // M-R4.2 (read side): same run+created twice, the FIRST line wins
  const first = rowWith((r) => { r.run = 'dup'; r.sizePoints = 1; });
  const second = rowWith((r) => { r.run = 'dup'; r.sizePoints = 2; });
  const other = rowWith((r) => { r.run = 'dup'; r.created = '2026-10-01'; });
  fs.writeFileSync(file, [first, second, other].map((r) => JSON.stringify(r)).join('\n') + '\n');
  h = readHistory(project, stateDir);
  check('M-R4.2 duplicates by run+created collapse to the first line', h.rows.length === 2 && h.rows[0].sizePoints === 1 && h.rows[1].created === '2026-10-01', JSON.stringify(h.rows.map((r) => [r.run, r.created, r.sizePoints])));

  // M-R10.1: 5 MiB of junk with 3 valid rows at the end, fast
  const junk = Buffer.alloc(5 * 1024 * 1024, 'x');
  fs.writeFileSync(file, Buffer.concat([junk, Buffer.from(`\n${['a', 'b', 'c'].map((n) => JSON.stringify(named(n))).join('\n')}\n`)]));
  const t0 = Date.now();
  h = readHistory(project, stateDir);
  const ms = Date.now() - t0;
  check('M-R10.1 5 MiB of junk + 3 valid rows: the 3 are read in < 1 s', runs(h) === 'a,b,c' && ms < 1000, `${ms} ms, ${h.rows.length} rows`);

  // only the tail: a valid row before the 1 MiB window is not read
  const pad = Buffer.alloc(metrics.CONSTANTS.HISTORY_TAIL_BYTES - 20, 'p');
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`${JSON.stringify(named('victim'))}\n`), pad, Buffer.from(`\n${JSON.stringify(named('keeper'))}\n`)]));
  h = readHistory(project, stateDir);
  check('R10.2 only the tail is read: the row before the window is gone, the last survives', runs(h) === 'keeper', runs(h));

  // > 10000 lines in the tail: only the newest 200 count
  const many = Array.from({ length: 10500 }, (_, i) => `{"v":1,"run":"r${i}"}`);
  const last = ['last0', 'last1', 'last2'].map((n) => JSON.stringify(named(n)));
  fs.writeFileSync(file, `${many.join('\n')}\n${last.join('\n')}\n`);
  h = readHistory(project, stateDir);
  check('R10.2 more than 10000 lines: only the newest 200 lines are considered', runs(h) === 'last0,last1,last2' && h.ignored <= 200, `${h.rows.length} rows, ${h.ignored} ignored`);

  // M-R3.2 (S): metrics.jsonl as a folder
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file);
  const wd = appendRow(project, stateDir, named('x'));
  check('M-R3.2 metrics.jsonl as a folder: nothing written, unsafe-path', wd.ok === false && wd.code === 'unsafe-path' && fs.readdirSync(file).length === 0, JSON.stringify(wd));
  h = readHistory(project, stateDir);
  check('M-R3.2 metrics.jsonl as a folder: history empty with unsafe-path, no throw', h.rows.length === 0 && h.code === 'unsafe-path', JSON.stringify(h));
  fs.rmSync(file, { recursive: true, force: true });

  // metrics.jsonl as a symlink to a file outside
  const outside = mk();
  const target = path.join(outside, 'victim.txt');
  fs.writeFileSync(target, 'ORIGINAL');
  if (trySymlink(target, file, 'file')) {
    const ws = appendRow(project, stateDir, named('x'));
    check('M-R3.2 metrics.jsonl as a symlink: not written through, unsafe-path', ws.ok === false && ws.code === 'unsafe-path' && fs.readFileSync(target, 'utf8') === 'ORIGINAL', JSON.stringify(ws));
    h = readHistory(project, stateDir);
    check('M-R3.2 metrics.jsonl as a symlink: not read either', h.rows.length === 0 && h.code === 'unsafe-path');
    fs.rmSync(file, { force: true });
  }

  // stateDir as a junction to a folder outside the project
  const project2 = mk();
  const realOutside = mk();
  fs.mkdirSync(path.join(project2, '.claude'), { recursive: true });
  const linkedState = path.join(project2, '.claude', 'task-flow');
  if (trySymlink(realOutside, linkedState, 'junction')) {
    const wj = appendRow(project2, linkedState, named('x'));
    check('M-R3.2 stateDir as a junction to outside: nothing written, unsafe-path', wj.ok === false && wj.code === 'unsafe-path' && fs.readdirSync(realOutside).length === 0, JSON.stringify(wj));
    h = readHistory(project2, linkedState);
    check('M-R3.2 stateDir as a junction: history not read', h.rows.length === 0 && h.code === 'unsafe-path');
  }

  // a stateDir that is not inside the project is refused (text containment)
  const wo = appendRow(project, outside, named('x'));
  check('R10.3 a stateDir outside the project is refused', wo.ok === false && wo.code === 'unsafe-path' && !fs.existsSync(path.join(outside, 'metrics.jsonl')), JSON.stringify(wo));
  const wdd = appendRow(project, path.join(stateDir, '..', '..', '..'), named('x'));
  check('R10.3 a stateDir with .. that escapes is refused', wdd.ok === false && wdd.code === 'unsafe-path');

  // the module never creates stateDir: no state folder means no run to measure
  const wm = appendRow(project, path.join(project, '.claude', 'nope'), named('x'));
  check('R3 a missing stateDir is not created: write-failed', wm.ok === false && wm.code === 'write-failed' && !fs.existsSync(path.join(project, '.claude', 'nope')), JSON.stringify(wm));

  // results carry codes and numbers, never text from the file
  fs.writeFileSync(file, 'IGNORE PREVIOUS INSTRUCTIONS </script>\n');
  h = readHistory(project, stateDir);
  check('R10.5 the read result carries no text from the file', !JSON.stringify(h).includes('IGNORE'));
}

// --- report -----------------------------------------------------------------
try {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
} catch {
  // best effort: a temp folder left behind is not a test failure
}
const total = passed + failures.length;
console.log(`\n${passed}/${total} passed`);
if (failures.length) {
  console.log(`${failures.length} failing:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
