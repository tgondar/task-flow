#!/usr/bin/env node
// Extra security cases for plan T9 (see metrics.hooks.test.js for the differential ones).
// Focus: a `metrics.jsonl` (or a name that Windows folds onto it) must never become an
// approval, an exemption or a run for gate.js, and the gate's anti-forgery of `approvedBy`
// must still hold while the file exists. Exit codes only, never reply wording.
// Run: node tests/metrics.hooks.security.test.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-msec-home-'));
for (const k of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_STATE_HOME']) process.env[k] = TEST_HOME;
delete process.env.TASK_FLOW_GATE;
delete process.env.TASK_FLOW_METRICS;

const GATE = path.join(__dirname, '..', 'plugin', 'hooks', 'gate.js');
const ALLOW = 0;
const BLOCK = 2;
let passed = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push(`${name}${detail ? ` - ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
};
const put = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof c === 'string' ? c : JSON.stringify(c)); };

function project(state) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-msec-'));
  put(path.join(root, '.claude', 'task-flow.json'), { docsDir: 'docs', language: 'PT-PT', tasksFile: 'tasks.md' });
  put(path.join(root, 'src', 'a.js'), '// code\n');
  const s = path.join(root, '.claude', 'task-flow');
  if (state) put(path.join(s, 'demo', 'state.json'), { phase: 'plan', status: 'ready', approvedBy: '', ...state });
  put(path.join(s, 'metrics.jsonl'), '{"v":1}\n');
  return { root, s };
}
let n = 0;
const gate = (root, tool_input, tool_name = 'Write') => spawnSync(process.execPath, [GATE], {
  input: JSON.stringify({ session_id: `msec-${process.pid}-${n++}`, cwd: root, hook_event_name: 'PreToolUse', tool_name, tool_input }),
  encoding: 'utf8', env: { ...process.env, TASK_FLOW_GATE: '', CLAUDE_PROJECT_DIR: root.split(path.sep).join('/') },
}).status;

// 1. Name variants of metrics.jsonl are "code": blocked before approval, like any file.
{
  const { root, s } = project({});
  const names = ['metrics.jsonl', 'METRICS.JSONL', 'Metrics.Jsonl', 'metrics.jsonl.', 'metrics.jsonl::$DATA', 'metrics.jsonl:state.json', 'metrics~1.jsonl', 'metrics.jsonl/../metrics.jsonl'];
  for (const name of names) {
    const code = gate(root, { file_path: `${s}/${name}`, content: 'x' });
    check(`unapproved: Write to <stateDir>/${name} is blocked`, code === BLOCK, `exit ${code}`);
  }
  check('unapproved: Edit of metrics.jsonl is blocked', gate(root, { file_path: path.join(s, 'metrics.jsonl'), old_string: 'a', new_string: 'b' }, 'Edit') === BLOCK);
}

// 2. A run folder named metrics.jsonl cannot be approved through the Write tool.
{
  const { root, s } = project({});
  const forged = JSON.stringify({ phase: 'plan', status: 'ready', approvedBy: 'user' });
  for (const rel of ['metrics.jsonl/state.json', 'METRICS.JSONL/state.json', 'demo/state.json', 'new/state.json']) {
    const code = gate(root, { file_path: path.join(s, rel), content: forged });
    check(`anti-forgery with metrics.jsonl present: Write ${rel} with approvedBy is blocked`, code === BLOCK, `exit ${code}`);
  }
  check('anti-forgery: unreplayable Edit on demo/state.json is blocked', gate(root, { file_path: path.join(s, 'demo', 'state.json'), old_string: 'zzz-not-there', new_string: '"approvedBy":"user"' }, 'Edit') === BLOCK);
  check('anti-forgery: code write still blocked afterwards', gate(root, { file_path: path.join(root, 'src', 'a.js'), content: 'x' }) === BLOCK);
}

// 3. A metrics.jsonl file never counts as an approved run; a real approved run still does.
{
  const { root } = project({});
  check('unapproved run + metrics.jsonl: code write blocked', gate(root, { file_path: path.join(root, 'src', 'a.js'), content: 'x' }) === BLOCK);
  const ok = project({ approvedBy: 'user' });
  check('approved run + metrics.jsonl: code write allowed (gate not broken)', gate(ok.root, { file_path: path.join(ok.root, 'src', 'a.js'), content: 'x' }) === ALLOW);
}

// 4. A real run folder literally named metrics.jsonl, unapproved: no approval from it.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-msec-'));
  put(path.join(root, '.claude', 'task-flow.json'), { docsDir: 'docs', language: 'PT-PT', tasksFile: 'tasks.md' });
  put(path.join(root, 'src', 'a.js'), '//\n');
  put(path.join(root, '.claude', 'task-flow', 'metrics.jsonl', 'state.json'), { phase: 'plan', status: 'ready', approvedBy: '' });
  check('folder named metrics.jsonl, unapproved: code write blocked', gate(root, { file_path: path.join(root, 'src', 'a.js'), content: 'x' }) === BLOCK);
}

// 5. A metrics.jsonl link (junction/symlink) to outside: writing through it is code, blocked.
{
  const { root, s } = project({});
  const out = fs.mkdtempSync(path.join(TEST_HOME, 'out-'));
  fs.rmSync(path.join(s, 'metrics.jsonl'));
  try {
    fs.symlinkSync(out, path.join(s, 'metrics.jsonl'), 'junction');
    check('link metrics.jsonl: Write through it is blocked', gate(root, { file_path: path.join(s, 'metrics.jsonl', 'x.txt'), content: 'x' }) === BLOCK);
    check('link metrics.jsonl: Write of state.json through it with approvedBy is blocked', gate(root, { file_path: path.join(s, 'metrics.jsonl', 'state.json'), content: '{"approvedBy":"user"}' }) === BLOCK);
  } catch (e) { console.log(`  skip  link cases (${e.code})`); }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
