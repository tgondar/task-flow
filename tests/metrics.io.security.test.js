#!/usr/bin/env node
// Security cases for plugin/scripts/metrics.js (T2): readHistory and appendRow on
// <stateDir>/metrics.jsonl. The file, the folder above it and the row are all
// untrusted. These assert the refusals: links and junctions (in the file, the state
// folder or a parent), paths outside the project (text, case, slashes), folders and
// hostile file shapes, bounded work, no echo of file content, no state folder
// created, no exception, and that concurrent appenders never corrupt a line.
//
// Run: node tests/metrics.io.security.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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

const METRICS = path.resolve(__dirname, '../plugin/scripts/metrics.js');
const { readHistory, appendRow, CONSTANTS } = require(METRICS);
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
const rowOf = (run, created = '2026-09-29') => { const r = clone(ROW); r.run = run; r.created = created; return r; };
const line = (run, created) => JSON.stringify(rowOf(run, created));
const quiet = (fn) => { try { fn(); return true; } catch { return false; } };
const runs = (h) => h.rows.map((r) => r.run).join(',');
const KEYS_W = ['ok', 'code'];
const KEYS_R = ['rows', 'ignored', 'code'];
const onlyKeys = (o, allowed) => Object.keys(o).every((k) => allowed.includes(k));
const refused = (r) => r.ok === false && r.code === 'unsafe-path';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-io-sec-'));
let n = 0;
function fixture() {
  const project = path.join(base, `p${n++}`);
  const stateDir = path.join(project, '.claude', 'task-flow');
  fs.mkdirSync(stateDir, { recursive: true });
  return { project, stateDir, file: path.join(stateDir, 'metrics.jsonl') };
}
function tryLink(target, linkPath, type) {
  try { fs.symlinkSync(target, linkPath, type); return true; } catch { console.log(`  skip  ${type} link not creatable here`); return false; }
}

// --- path containment: text, case, slashes, relative ---------------------------
{
  const f = fixture();
  const outside = path.join(base, `out${n++}`); fs.mkdirSync(outside);
  check('S path: stateDir outside the project is refused for write and read',
    refused(appendRow(f.project, outside, ROW)) && readHistory(f.project, outside).code === 'unsafe-path' && !fs.existsSync(path.join(outside, 'metrics.jsonl')));
  check('S path: sibling whose name starts with the project name is refused',
    refused(appendRow(f.project, f.project + '0', ROW)) && refused(appendRow(f.project, f.project + '-evil', ROW)));
  const esc = path.join(f.stateDir, '..', '..', '..', 'esc');
  fs.mkdirSync(esc, { recursive: true });
  check('S path: ../ that escapes the project is refused, nothing written', refused(appendRow(f.project, esc, ROW)) && !fs.existsSync(path.join(esc, 'metrics.jsonl')));
  check('S path: the parent of the project as stateDir is refused', refused(appendRow(f.project, path.dirname(f.project), ROW)));
  const cwd = process.cwd();
  process.chdir(base);
  let rel;
  try { rel = appendRow(f.project, path.relative(base, outside), ROW); } finally { process.chdir(cwd); }
  check('S path: a relative stateDir that resolves outside is refused', refused(rel));
  check('S path: nothing was written next to the fixtures', !fs.existsSync(path.join(base, 'metrics.jsonl')));
  if (process.platform === 'win32') {
    const ok = appendRow(f.project, f.stateDir.toUpperCase(), ROW);
    check('S path (win): different casing is the same folder: contained and written inside', ok.ok === true && fs.readFileSync(f.file, 'utf8').split('\n').filter(Boolean).length === 1, JSON.stringify(ok));
    const fwd = appendRow(f.project, f.stateDir.replace(/\\/g, '/'), rowOf('fwd'));
    check('S path (win): forward slashes resolve to the same place', fwd.ok === true && runs(readHistory(f.project, f.stateDir)) === 'a-run,fwd', JSON.stringify(fwd));
    check('S path (win): outside path in another casing / slashes is still refused', refused(appendRow(f.project, outside.toUpperCase().replace(/\\/g, '/'), ROW)));
    check('S path (win): UNC and device paths are refused without throwing', ['\\\\localhost\\c$\\x', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', '//host/share'].every((p) => {
      let r; try { r = appendRow(f.project, p, ROW); } catch { return false; }
      return r.ok === false && ['unsafe-path', 'write-failed'].includes(r.code);
    }));
  }
}

// --- links: file, state folder, a parent folder, dangling ---------------------------
{
  const f = fixture();
  const outside = path.join(base, `out${n++}`); fs.mkdirSync(outside);
  const p2 = path.join(base, `p${n++}`); fs.mkdirSync(p2);
  const realClaude = path.join(outside, 'claude'); fs.mkdirSync(path.join(realClaude, 'task-flow'), { recursive: true });
  if (tryLink(realClaude, path.join(p2, '.claude'), 'junction')) {
    const sd = path.join(p2, '.claude', 'task-flow');
    const w = appendRow(p2, sd, ROW);
    check('S link: a PARENT of stateDir (.claude) as a junction: nothing written, unsafe-path', refused(w) && fs.readdirSync(path.join(realClaude, 'task-flow')).length === 0, JSON.stringify(w));
    check('S link: ... and not read', readHistory(p2, sd).code === 'unsafe-path');
  }
  const ghost = path.join(outside, 'ghost.jsonl');
  if (tryLink(ghost, f.file, 'file')) {
    const w = appendRow(f.project, f.stateDir, ROW);
    check('S link: a DANGLING symlink as metrics.jsonl: target not created, unsafe-path', refused(w) && !fs.existsSync(ghost), JSON.stringify(w));
    const h = readHistory(f.project, f.stateDir);
    check('S link: dangling symlink read: empty + unsafe-path, no throw', h.rows.length === 0 && h.code === 'unsafe-path');
  }
  const f2 = fixture();
  const dirTarget = path.join(outside, 'dirtarget'); fs.mkdirSync(dirTarget);
  if (tryLink(dirTarget, f2.file, 'junction')) {
    const w = appendRow(f2.project, f2.stateDir, ROW);
    check('S link: a junction as metrics.jsonl: nothing written into its target', refused(w) && fs.readdirSync(dirTarget).length === 0, JSON.stringify(w));
  }
  const f3 = fixture();
  fs.writeFileSync(path.join(f3.stateDir, 'real.jsonl'), line('keep') + '\n');
  if (tryLink(path.join(f3.stateDir, 'real.jsonl'), f3.file, 'file')) {
    const w = appendRow(f3.project, f3.stateDir, ROW);
    check('S link: symlink to a file INSIDE the project is refused too, target unchanged', refused(w) && fs.readFileSync(path.join(f3.stateDir, 'real.jsonl'), 'utf8') === line('keep') + '\n');
    check('S link: ... and its content is not read', readHistory(f3.project, f3.stateDir).rows.length === 0);
  }
}

// --- hostile file shapes -----------------------------------------------------------
{
  const f = fixture();
  fs.writeFileSync(f.file, '');
  const h = readHistory(f.project, f.stateDir);
  check('S file: empty file: empty history, no code', h.rows.length === 0 && h.ignored === 0 && h.code === null);
  check('S file: append to an empty file writes no repair newline', appendRow(f.project, f.stateDir, ROW).ok && fs.readFileSync(f.file, 'utf8') === line('a-run') + '\n');
}
{
  const f = fixture();
  const parts = [
    Buffer.from(line('good1') + '\r\n'),
    Buffer.alloc(200, 0), Buffer.from('\n'),
    Buffer.from([0xed, 0xa0, 0x80, 0xff, 0xfe, 0x0a]), // lone surrogate in UTF-8 + invalid bytes
    Buffer.from(JSON.stringify(rowOf('x')).replace('"x"', '"\\ud800"') + '\n'), // escaped lone surrogate in JSON
    Buffer.from('\ufeff' + line('good2') + '\n'),
    Buffer.from(line('bom\\u0000in') + '\n'),
    Buffer.from(line('good3')),
  ];
  fs.writeFileSync(f.file, Buffer.concat(parts));
  let h; const ok = quiet(() => { h = readHistory(f.project, f.stateDir); });
  check('S file: NUL bytes / invalid UTF-8 / lone surrogates / BOM: valid rows survive, no throw', ok && runs(h) === 'good1,good2,good3' && h.code === null, ok ? `${runs(h)}/${h.code}` : 'threw');
  check('S file: the garbage is counted, not echoed', h.ignored >= 3 && onlyKeys(h, KEYS_R));
  const w = appendRow(f.project, f.stateDir, rowOf('after'));
  const t = fs.readFileSync(f.file, 'utf8');
  check('S file: no final newline: repair newline, then the row on its own line', w.ok && t.endsWith(`\n${line('after')}\n`) && t.split('\n').includes(line('good3')) && runs(readHistory(f.project, f.stateDir)).endsWith('good3,after'));
  fs.writeFileSync(f.file, Buffer.alloc(300000, 0));
  const h2 = readHistory(f.project, f.stateDir);
  check('S file: a NUL-only file is one ignored line, no rows, no throw', h2.rows.length === 0 && h2.ignored === 1 && h2.code === null, JSON.stringify(h2));
  const w2 = appendRow(f.project, f.stateDir, ROW);
  check('S file: appending after a NUL-only file ends on a clean line', w2.ok && fs.readFileSync(f.file).slice(-1)[0] === 0x0a && runs(readHistory(f.project, f.stateDir)) === 'a-run');
}
{
  const f = fixture();
  fs.writeFileSync(f.file, 'x'.repeat(3 * 1024 * 1024));
  const t0 = Date.now(); const h = readHistory(f.project, f.stateDir); const ms = Date.now() - t0;
  check('S bound: 3 MiB in ONE line with no newline: no rows, no throw, fast', h.rows.length === 0 && h.code === null && ms < 1000, `${ms} ms ${JSON.stringify(h)}`);
  const w = appendRow(f.project, f.stateDir, ROW);
  check('S bound: append after it lands on its own line and reads back', w.ok && runs(readHistory(f.project, f.stateDir)) === 'a-run');
}
{
  const f = fixture();
  const padded = line('padded') + ' '.repeat(4200);
  fs.writeFileSync(f.file, `${padded}\n${line('ok')}\n`);
  const h = readHistory(f.project, f.stateDir);
  check('S bound: whitespace-padded row over 4096 bytes is ignored', runs(h) === 'ok' && h.ignored === 1, runs(h));
}
{
  const f = fixture();
  fs.writeFileSync(f.file, Buffer.concat([Buffer.alloc(CONSTANTS.HISTORY_TAIL_BYTES, 0x0a), Buffer.from(`${line('after-blank')}\n`)]));
  const t0 = Date.now(); const h = readHistory(f.project, f.stateDir); const ms = Date.now() - t0;
  check('S bound: 1 MiB of blank lines then a row: row read, blanks not counted, fast', runs(h) === 'after-blank' && h.ignored === 0 && ms < 1000, `${ms} ms ${runs(h)} ${h.ignored}`);
  fs.writeFileSync(f.file, 'junk\n'.repeat(50000) + ['a', 'b', 'c'].map((r) => line(r)).join('\n') + '\n');
  const t1 = Date.now(); const h2 = readHistory(f.project, f.stateDir); const ms2 = Date.now() - t1;
  check('S bound: 50000 junk lines + 3 rows: the 3 are read, ignored bounded by KEEP_ROWS', runs(h2) === 'a,b,c' && h2.ignored <= CONSTANTS.HISTORY_KEEP_ROWS && ms2 < 1000, `${ms2} ms ${runs(h2)} ${h2.ignored}`);
}
{
  const f = fixture();
  fs.writeFileSync(f.file, '\u00e9'.repeat(CONSTANTS.HISTORY_TAIL_BYTES) + `\n${line('tail')}\n`);
  const h = readHistory(f.project, f.stateDir);
  check('S bound: window starting inside a multi-byte character: only the real row survives', runs(h) === 'tail', runs(h));
}
{
  // a valid row that the window cuts must not be read as a row: only its tail would be seen
  const f = fixture();
  const mk = (i) => Buffer.from(`${line(`r${String(i).padStart(5, '0')}`)}\n`);
  const vbuf = Buffer.from(`${line('v00000')}\n`);
  const rows = [];
  let after = 0;
  while (after + vbuf.length < CONSTANTS.HISTORY_TAIL_BYTES) { const r = mk(rows.length); rows.push(r); after += r.length; }
  const cutAt = after + vbuf.length - CONSTANTS.HISTORY_TAIL_BYTES; // bytes of the victim that fall before the window
  fs.writeFileSync(f.file, Buffer.concat([Buffer.from('y'.repeat(20) + '\n'), vbuf, ...rows]));
  const h = readHistory(f.project, f.stateDir);
  check('S bound: fixture cuts the victim row mid-way (self-check)', cutAt > 0 && cutAt < vbuf.length, `cutAt=${cutAt}`);
  check('S bound: a row cut by the window is dropped, every whole row after it is kept', !runs(h).includes('v00000') && h.rows.length === rows.length && h.ignored === 0, `${h.rows.length}/${rows.length} ignored ${h.ignored}`);
}
{
  const f = fixture();
  fs.mkdirSync(f.file);
  const w = appendRow(f.project, f.stateDir, ROW);
  check('S file: metrics.jsonl as a folder: unsafe-path, folder left empty', refused(w) && fs.readdirSync(f.file).length === 0);
  const f2 = fixture();
  const asFile = path.join(f2.project, '.claude', 'flat'); fs.writeFileSync(asFile, 'x');
  let w2; const ok = quiet(() => { w2 = appendRow(f2.project, asFile, ROW); });
  check('S file: stateDir that is a plain file: refused, no throw, file unchanged', ok && w2.ok === false && ['write-failed', 'unsafe-path'].includes(w2.code) && fs.readFileSync(asFile, 'utf8') === 'x', JSON.stringify(w2));
  check('S file: reading under a stateDir that is a file: empty, no throw', (() => { let h; return quiet(() => { h = readHistory(f2.project, asFile); }) && h.rows.length === 0; })());
}
{
  const f = fixture();
  fs.writeFileSync(f.file, `${line('ro')}\n`); fs.chmodSync(f.file, 0o444);
  let w; const ok = quiet(() => { w = appendRow(f.project, f.stateDir, ROW); });
  check('S file: a read-only file: no throw, a code when the OS honours the mode', ok && (w.ok === true || w.code === 'write-failed'), JSON.stringify(w));
  if (w && w.ok === false) check('S file: ... and the file is unchanged', fs.readFileSync(f.file, 'utf8') === `${line('ro')}\n`);
  fs.chmodSync(f.file, 0o644);
}

// --- rows: hostile objects, pollution, no partial write -----------------------------
{
  const f = fixture();
  const getter = Object.defineProperty(clone(ROW), 'run', { get() { throw new Error('SECRET-GETTER'); }, enumerable: true });
  const trap = () => { throw new Error('SECRET-PROXY'); };
  const evil = {
    'own __proto__ key': JSON.parse(JSON.stringify(ROW).replace('{"v":1', '{"__proto__":{"polluted":1},"v":1')),
    'constructor key': { ...clone(ROW), constructor: { prototype: { p: 1 } } },
    'extra key': { ...clone(ROW), extra: 1 },
    'throwing getter': getter,
    'throwing proxy': new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap, has: trap, getOwnPropertyDescriptor: trap }),
    'toJSON swap': Object.assign(clone(ROW), { toJSON() { return { pwned: 1 }; } }),
    'run with a path': { ...clone(ROW), run: '../../x' },
    array: [ROW], string: line('x'), undefined: undefined, number: 1,
  };
  let all = true; let last;
  for (const [label, row] of Object.entries(evil)) {
    let r; const ok = quiet(() => { r = appendRow(f.project, f.stateDir, row); });
    if (!(ok && r.ok === false && r.code === 'invalid-row' && onlyKeys(r, KEYS_W) && !JSON.stringify(r).includes('SECRET'))) { all = false; console.log(`   detail: ${label} -> ${JSON.stringify(r)}`); }
    last = r;
  }
  check('S row: every hostile row is refused with invalid-row, never throws, leaks nothing', all, JSON.stringify(last));
  check('S row: nothing polluted Object.prototype', ({}).polluted === undefined && ({}).p === undefined && ({}).pwned === undefined);
  check('S row: nothing was written by any refused row (no file created)', !fs.existsSync(f.file));
  const big = clone(ROW); big.run = 'a'.repeat(100); big.models = Array(8).fill('m'.repeat(80)); big.primaryModel = 'm'.repeat(80);
  const wb = appendRow(f.project, f.stateDir, big);
  const lines = fs.existsSync(f.file) ? fs.readFileSync(f.file, 'utf8').split('\n').filter(Boolean) : [];
  check('S row: the largest legal row is either refused or fits in MAX_ROW_BYTES, one line', (wb.ok === false && wb.code === 'invalid-row') || (lines.length === 1 && Buffer.byteLength(lines[0]) + 1 <= CONSTANTS.MAX_ROW_BYTES), JSON.stringify(wb));
  fs.writeFileSync(f.file, `{"__proto__":{"polluted":1},"v":1}\n${line('fine')}\n`);
  const h = readHistory(f.project, f.stateDir);
  check('S row: a __proto__ line in the file is ignored, nothing polluted, history intact', runs(h) === 'fine' && h.ignored === 1 && ({}).polluted === undefined);
  h.rows[0].run = 'mutated';
  check('S row: rows are fresh objects (mutating one does not touch a re-read)', runs(readHistory(f.project, f.stateDir)) === 'fine');
}

// --- no echo, no side effects ----------------------------------------------------------
{
  const f = fixture();
  const secret = 'TOP-SECRET-TOKEN-123';
  fs.writeFileSync(f.file, `{"run":"${secret}"}\nnot json ${secret}\n${line('ok')}\n`);
  const o = { w: console.warn, e: console.error, l: console.log }; let printed = '';
  console.warn = console.error = console.log = (...a) => { printed += a.join(' '); };
  let h; let w;
  try { h = readHistory(f.project, f.stateDir); w = appendRow(f.project, f.stateDir, rowOf('n')); } finally { console.warn = o.w; console.error = o.e; console.log = o.l; }
  check('S echo: neither call echoes file content in its result', !JSON.stringify(h).includes(secret) && !JSON.stringify(w).includes(secret) && onlyKeys(h, KEYS_R) && onlyKeys(w, KEYS_W));
  check('S echo: neither call prints anything', printed === '', printed);
  const d = fixture(); fs.mkdirSync(d.file);
  const codes = [readHistory(d.project, d.stateDir).code, appendRow(d.project, d.stateDir, ROW).code, appendRow(d.project, path.join(d.project, 'nope'), ROW).code, appendRow(d.project, d.stateDir, {}).code];
  check('S echo: every code is from the closed set, no paths or messages', codes.every((c) => ['unsafe-path', 'write-failed', 'invalid-row', 'read-failed'].includes(c)), codes.join());
}
{
  const f = fixture();
  const missing = path.join(f.project, '.claude', 'not-there');
  const w = appendRow(f.project, missing, ROW);
  check('S side effect: a missing stateDir is not created (write-failed)', w.ok === false && w.code === 'write-failed' && !fs.existsSync(missing));
  const deep = path.join(f.project, 'a', 'b', 'c');
  appendRow(f.project, deep, ROW); readHistory(f.project, deep);
  check('S side effect: a deep missing stateDir creates no folder either', !fs.existsSync(path.join(f.project, 'a')));
  const before = fs.readdirSync(f.stateDir).join(); readHistory(f.project, f.stateDir);
  check('S side effect: a read creates nothing', fs.readdirSync(f.stateDir).join() === before);
  fs.writeFileSync(path.join(f.stateDir, 'state.json'), '{}'); fs.writeFileSync(path.join(f.project, '.gitignore'), 'x');
  appendRow(f.project, f.stateDir, ROW);
  check('S side effect: an append touches no other file (state.json, .gitignore) and adds only metrics.jsonl',
    fs.readFileSync(path.join(f.stateDir, 'state.json'), 'utf8') === '{}' && fs.readFileSync(path.join(f.project, '.gitignore'), 'utf8') === 'x' && fs.readdirSync(f.stateDir).sort().join() === 'metrics.jsonl,state.json');
}
check('S path: an empty or relative stateDir/projectDir never resolves against cwd (nothing written there)', (() => { const c = process.cwd(); const d = fixture(); process.chdir(d.project); let a; let b; try { a = appendRow('', '', ROW); b = appendRow(d.project, path.relative(d.project, d.stateDir), ROW); } finally { process.chdir(c); } return refused(a) && refused(b) && !fs.existsSync(path.join(d.project, 'metrics.jsonl')) && !fs.existsSync(d.file); })());
check('S never throws: odd arguments to both functions', [[undefined, undefined], [null, null], [5, {}], ['', ''], [[], []], ['a\u0000b', 'a\u0000b']].every(([p, s]) => quiet(() => { readHistory(p, s); appendRow(p, s, ROW); })));
{
  const r = readHistory(undefined, undefined); const w = appendRow(null, null, ROW);
  check('S never throws: odd arguments return the closed result shapes', onlyKeys(r, KEYS_R) && r.rows.length === 0 && w.ok === false && onlyKeys(w, KEYS_W));
}

// --- concurrency: three processes appending must not corrupt a line -------------------------
{
  const f = fixture();
  const worker = `const m=require(${JSON.stringify(METRICS)});
const row=${JSON.stringify(ROW)};let bad=0;
for(let i=0;i<60;i++){const r=Object.assign({},row,{run:process.argv[1]+'-'+i});const w=m.appendRow(${JSON.stringify(f.project)},${JSON.stringify(f.stateDir)},r);if(!w.ok)bad++;}
process.exit(bad?3:0);`;
  const start = (id) => new Promise((resolve) => { spawn(process.execPath, ['-e', worker, id], { stdio: 'ignore', env: process.env }).on('exit', resolve); });
  Promise.all([start('A'), start('B'), start('C')]).then((codes) => {
    const text = fs.readFileSync(f.file, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    const h = readHistory(f.project, f.stateDir);
    check('S race: three processes x 60 appends all report ok', codes.every((c) => c === 0), codes.join());
    check('S race: every line is a complete valid row (no interleaving, no glued lines)', lines.length === 180 && h.ignored === 0 && h.rows.length === 180, `${lines.length} lines, ${h.rows.length} rows, ${h.ignored} ignored`);
    check('S race: file ends with a newline, nothing lost or duplicated', text.endsWith('\n') && new Set(h.rows.map((r) => r.run)).size === 180);
    finish();
  });
}

function finish() {
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((x) => `  - ${x}`).join('\n')); process.exit(1); }
}
