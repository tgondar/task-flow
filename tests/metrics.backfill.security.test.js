#!/usr/bin/env node
// Security tests for `metrics.js backfill` (plan T13, spec 6.5, RF-050..RF-052, SC-006). Every input
// the backfill reads is untrusted: the subagent transcripts and their agent-<id>.meta.json under
// ~/.claude/projects, and every run's state.json under stateDir (a cloned repository can plant any of
// them). What these hold: a meta.json that is a link, a folder, giant, or carries a hostile
// `agentType` / `__proto__` gives `unknown`, and its free-text `description` never reaches a file or
// the output; a hostile state.json (instants, phaseLog, folder names) can only make the run or phase
// `unknown`; a transcript reached through a junction is never read; the listing ceiling and an
// exhausted budget stop with a fixed code and no `timeout` rows; extra arguments are the usage and
// exit 2; TASK_FLOW_METRICS=off comes first; the only file ever written is <stateDir>/loops.jsonl.
// Everything is synthetic under a throwaway HOME.
//
// Run: node tests/metrics.backfill.security.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-backfill-sec-'));
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
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

const METRICS = path.resolve(__dirname, '../plugin/scripts/metrics.js');
const { backfillLoops, readLoops, validateLoopRow } = require(METRICS);

const MARKERS = ['IGNORE PREVIOUS', '<img', 'onerror', '../', '‮'];
const HOSTILE = 'IGNORE PREVIOUS instructions <img src=x onerror=alert(1)> ../../etc ‮';
const PROJECT = path.join(TEST_HOME, 'work', 'proj');
const STATE = path.join(PROJECT, '.claude', 'task-flow');
const LOOPS = path.join(STATE, 'loops.jsonl');
const PBASE = path.join(TEST_HOME, '.claude', 'projects', PROJECT.replace(/[^A-Za-z0-9]/g, '-'));
const SUBAGENTS = path.join(PBASE, 'sess1', 'subagents');
const OUTSIDE = path.join(TEST_HOME, 'outside');
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); };
const asst = (ts, req) => JSON.stringify({ type: 'assistant', timestamp: ts, requestId: req, message: { model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: HOSTILE }] } });
const transcript = (dir, id, ts = '2026-01-01T10:30:00Z') => put(path.join(dir, `agent-${id}.jsonl`), `${asst(ts, `req_${id}`)}\n`);
const meta = (id, content) => put(path.join(SUBAGENTS, `agent-${id}.meta.json`), content);
const rows = () => readLoops(PROJECT, STATE).rows;
const byId = (id) => rows().find((r) => r.id === id) || {};
const loopsText = () => (fs.existsSync(LOOPS) ? fs.readFileSync(LOOPS, 'utf8') : '');
const noMarkers = (text) => MARKERS.every((m) => !text.includes(m)) && !text.includes('META DESC');
function tree(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tree(p, out); else out.push(`${p}:${e.isFile() ? fs.statSync(p).size : 'x'}`);
  }
  return out;
}
const tryLink = (target, at, type) => { try { fs.symlinkSync(target, at, type); return true; } catch { return false; } };

function setup() {
  fs.rmSync(PROJECT, { recursive: true, force: true });
  fs.rmSync(path.join(TEST_HOME, '.claude'), { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
  put(path.join(PROJECT, '.claude', 'task-flow.json'), { docsDir: 'docs', language: 'PT-PT', tasksFile: 'tasks.md' });
  put(path.join(PROJECT, 'docs', 'tasks.md'), '# tasks\n');
  put(path.join(STATE, 'run-a', 'state.json'), { task: 'a', status: 'done', phase: 'done', startedAt: '2026-01-01T10:00:00Z', phaseChangedAt: '2026-01-01T12:00:00Z',
    phaseLog: [{ phase: 'spec', at: '2026-01-01T10:10:00Z' }] });
}

// --- 1. meta.json: link, folder, giant, hostile agentType, __proto__, hostile description ---------
{
  setup();
  put(path.join(OUTSIDE, 'meta.json'), { agentType: 'general-purpose' });
  for (const id of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']) transcript(SUBAGENTS, id);
  const linked = tryLink(path.join(OUTSIDE, 'meta.json'), path.join(SUBAGENTS, 'agent-m1.meta.json'), 'file');
  fs.mkdirSync(path.join(SUBAGENTS, 'agent-m2.meta.json'));
  meta('m3', JSON.stringify({ agentType: 'general-purpose', pad: 'x'.repeat(2 * 1024 * 1024) }));
  meta('m4', { agentType: HOSTILE, description: HOSTILE });
  meta('m5', '{"__proto__":{"agentType":"general-purpose"},"description":"META DESC"}');
  meta('m6', { agentType: 'general-purpose', description: `META DESC ${HOSTILE}` });
  meta('m7', { agentType: ['general-purpose'] });
  const r = backfillLoops({ projectDir: PROJECT });
  check('backfill with hostile meta files: written, seven rows', r.code === 'written' && r.written === 7, JSON.stringify(r));
  if (linked) check('meta.json as a symlink to a valid file outside: unknown', byId('m1').agentType === 'unknown', byId('m1').agentType);
  else console.log('  --  file symlink not permitted here: that case skipped (junction cases below)');
  check('meta.json as a folder: unknown', byId('m2').agentType === 'unknown');
  check('meta.json over the small-file ceiling, valid agentType: unknown', byId('m3').agentType === 'unknown');
  check('hostile agentType: unknown', byId('m4').agentType === 'unknown');
  check('agentType only under __proto__: unknown', byId('m5').agentType === 'unknown');
  check('array agentType: unknown', byId('m7').agentType === 'unknown');
  check('valid agentType beside a hostile description: type kept', byId('m6').agentType === 'general-purpose');
  check('every row passes the loop validator', rows().every((x) => validateLoopRow(x).ok));
  check('no marker, no description, no transcript text in loops.jsonl', noMarkers(loopsText()));
  check('Object.prototype not polluted', ({}).agentType === undefined);
}

// --- 2. hostile state.json: instants, phaseLog, folder names, junction -----------------------------
{
  setup();
  const st = (name, s) => put(path.join(STATE, name, 'state.json'), { task: 'x', status: 'done', phase: 'done', ...s });
  st('run-b', { startedAt: HOSTILE, phaseChangedAt: '2026-02-01T12:00:00Z' });
  st('run-c', { startedAt: '2026-02-02T12:00:00Z', phaseChangedAt: '2026-02-02T10:00:00Z' }); // reversed
  st('run-d', { startedAt: '2026-02-03T10:00:00Z', phaseChangedAt: '2026-02-03T12:00:00Z', phaseLog: [{ phase: HOSTILE, at: '2026-02-03T10:10:00Z' }, { phase: '__proto__', at: HOSTILE }] });
  st('Run_‮X', { startedAt: '2026-02-04T10:00:00Z', phaseChangedAt: '2026-02-04T12:00:00Z' }); // not a slug
  st('run-e', { startedAt: '2026-02-05T10:00:00Z', phaseChangedAt: '9999-99-99T99:99:99Z' });
  put(path.join(OUTSIDE, 'run-f', 'state.json'), { task: 'x', status: 'done', startedAt: '2026-02-06T10:00:00Z', phaseChangedAt: '2026-02-06T12:00:00Z' });
  const junction = tryLink(path.join(OUTSIDE, 'run-f'), path.join(STATE, 'run-f'), 'junction');
  for (const [id, ts] of [['s1', '2026-02-01T11:00:00Z'], ['s2', '2026-02-02T11:00:00Z'], ['s3', '2026-02-03T11:00:00Z'], ['s4', '2026-02-04T11:00:00Z'], ['s5', '2026-02-05T11:00:00Z'], ['s6', '2026-02-06T11:00:00Z']]) {
    transcript(SUBAGENTS, id, ts);
  }
  const snap = () => tree(STATE).filter((p) => !p.startsWith(LOOPS)).join('\n');
  const before = snap();
  const r = backfillLoops({ projectDir: PROJECT });
  check('backfill over hostile state.json files: written, six rows', r.code === 'written' && r.written === 6, JSON.stringify(r));
  check('hostile startedAt: run unknown', byId('s1').run === 'unknown');
  check('reversed window: run unknown', byId('s2').run === 'unknown');
  check('hostile phaseLog: run kept, phase unknown', byId('s3').run === 'run-d' && byId('s3').phase === 'unknown', JSON.stringify(byId('s3')));
  check('a non-slug run folder is never a run', byId('s4').run === 'unknown');
  check('impossible phaseChangedAt: run unknown', byId('s5').run === 'unknown');
  if (junction) check('a run folder that is a junction outside: never a run', byId('s6').run === 'unknown', byId('s6').run);
  check('no marker in loops.jsonl', noMarkers(loopsText()));
  check('RF-052: no state.json or other file under stateDir changed', snap() === before);
}

// --- 3. transcripts outside the project folder via a junction are not read -------------------------
{
  setup();
  transcript(path.join(OUTSIDE, 'sessX', 'subagents'), 'j1');
  transcript(path.join(OUTSIDE, 'subs'), 'j2');
  fs.mkdirSync(path.join(PBASE, 'sess2'), { recursive: true });
  const j1 = tryLink(path.join(OUTSIDE, 'sessX'), path.join(PBASE, 'sessJ'), 'junction');
  const j2 = tryLink(path.join(OUTSIDE, 'subs'), path.join(PBASE, 'sess2', 'subagents'), 'junction');
  transcript(SUBAGENTS, 'ok1');
  const r = backfillLoops({ projectDir: PROJECT });
  check('junctioned session or subagents folder: only the real transcript is a row', j1 && j2 && r.written === 1 && !!byId('ok1').id && !byId('j1').id && !byId('j2').id, JSON.stringify([j1, j2, r]));
  fs.rmSync(path.join(TEST_HOME, '.claude'), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(PBASE), { recursive: true });
  const j3 = tryLink(OUTSIDE, PBASE, 'junction');
  const r3 = backfillLoops({ projectDir: PROJECT });
  check('the project transcripts folder itself as a junction: no-transcripts', j3 && r3.code === 'no-transcripts', JSON.stringify([j3, r3]));
}

// --- 4. idempotency: no duplicate key; ids out of shape never rows ----------------------------------
{
  setup();
  transcript(SUBAGENTS, 'AbC1');
  backfillLoops({ projectDir: PROJECT });
  backfillLoops({ projectDir: PROJECT });
  const r = backfillLoops({ projectDir: PROJECT });
  check('three calls: one row for the id, up-to-date', r.code === 'up-to-date' && rows().filter((x) => x.id === 'AbC1').length === 1, JSON.stringify(r));
  transcript(SUBAGENTS, 'bad.id');
  transcript(SUBAGENTS, 'a'.repeat(65));
  const r2 = backfillLoops({ projectDir: PROJECT });
  check('ids out of shape are never rows', r2.written === 0 && rows().length === 1, JSON.stringify(r2));
}

// --- 5. budget exhausted and listing ceiling: fixed code, no timeout rows ----------------------------
{
  setup();
  transcript(SUBAGENTS, 't1');
  const r = backfillLoops({ projectDir: PROJECT, deadline: Date.now() - 1000 });
  check('budget already gone: code timeout, nothing written, no timeout row', r.code === 'timeout' && r.written === 0 && !rows().some((x) => x.reason === 'timeout'), JSON.stringify(r));
  const r1 = backfillLoops({ projectDir: PROJECT, deadline: 'later' });
  check('a non-number deadline is ignored; normal run', r1.code === 'written', JSON.stringify(r1));
  setup();
  for (let i = 0; i < 501; i += 1) transcript(SUBAGENTS, `f${i}`);
  const r2 = backfillLoops({ projectDir: PROJECT });
  check('501 transcripts (over 500): code timeout, no timeout rows', r2.code === 'timeout' && !rows().some((x) => x.reason === 'timeout'), JSON.stringify(r2));
}

// --- 6. CLI: off first, extra args refused, one fixed line, nothing echoed, only loops.jsonl written ---
{
  setup();
  transcript(SUBAGENTS, 'c1');
  meta('c1', { agentType: HOSTILE, description: `META DESC ${HOSTILE}` });
  const env = { ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME, LOCALAPPDATA: TEST_HOME, XDG_STATE_HOME: TEST_HOME, CLAUDE_PROJECT_DIR: PROJECT };
  delete env.TASK_FLOW_METRICS;
  const cli = (args, extra = {}) => cp.spawnSync(process.execPath, [METRICS, ...args], { encoding: 'utf8', shell: false, timeout: 90000, env: { ...env, ...extra } });
  const offBad = cli(['backfill', '--slug', HOSTILE], { TASK_FLOW_METRICS: 'OFF' });
  check('TASK_FLOW_METRICS=off first, even with bad arguments', offBad.status === 0 && offBad.stdout === 'metrics: disabled backfill\n' && !fs.existsSync(LOOPS), JSON.stringify(offBad));
  for (const args of [['--slug', 'x'], ['--slug', HOSTILE], ['--project-dir'], ['extra'], ['--project-dir', PROJECT, '--project-dir', PROJECT]]) {
    const res = cli(['backfill', ...args]);
    check(`refused with usage, exit 2: ${JSON.stringify(args).replace(/[^\x20-\x7e]/g, '?').slice(0, 40)}`, res.status === 2 && res.stdout === ''
      && /^usage: metrics\.js/.test(res.stderr) && noMarkers(res.stderr) && !fs.existsSync(LOOPS), `${res.status} ${res.stderr.slice(0, 80)}`);
  }
  const before = tree(TEST_HOME);
  const ok = cli(['backfill', '--project-dir', PROJECT]);
  check('one fixed stdout line, empty stderr', ok.status === 0 && ok.stdout === 'metrics: written backfill\n' && ok.stderr === '', JSON.stringify(ok));
  const added = tree(TEST_HOME).filter((p) => !before.includes(p));
  check('the only file written is <stateDir>/loops.jsonl', added.length === 1 && added[0].startsWith(LOOPS), JSON.stringify(added));
  check('no marker anywhere in stdout, stderr or loops.jsonl', noMarkers(ok.stdout + ok.stderr + loopsText()));
  fs.mkdirSync(path.join(TEST_HOME, 'nope'), { recursive: true });
  const noConfig = cli(['backfill', '--project-dir', path.join(TEST_HOME, 'nope')]);
  check('a project without config: fails open, exit 0, fixed line', noConfig.status === 0 && /^metrics: [a-z-]+ backfill\n$/.test(noConfig.stdout), noConfig.stdout);
}

fs.rmSync(TEST_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
