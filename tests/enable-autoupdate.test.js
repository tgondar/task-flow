#!/usr/bin/env node
// Tests for scripts/enable-autoupdate.js, the one step of install.ps1 that writes
// into the user's own ~/.claude/settings.json. What matters is what it must NOT
// do: lose the user's other settings, or overwrite a file it could not read.
//
// Run: node tests/enable-autoupdate.test.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'enable-autoupdate.js');

let passed = 0;
const failures = [];
function check(name, problem) {
  if (problem) {
    failures.push(`${name}: ${problem}`);
    console.log(`  FAIL  ${name} — ${problem}`);
  } else {
    passed++;
    console.log(`  ok    ${name}`);
  }
}

const tmpFile = (content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-settings-'));
  const file = path.join(dir, 'settings.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
};
const run = (file, source = 'someone/task-flow') =>
  spawnSync(process.execPath, [SCRIPT, file, 'task-flow', 'task-flow@task-flow', source], { encoding: 'utf8' });

// E1: existing settings survive, and the marketplace + plugin are added.
{
  const file = tmpFile(JSON.stringify({ theme: 'dark', note: 'ação', enabledPlugins: { 'claude-hud@claude-hud': true } }));
  const r = run(file);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('E1 exits 0', r.status === 0 ? null : r.stderr);
  check('E1 keeps the other settings', s.theme === 'dark' && s.note === 'ação' && s.enabledPlugins['claude-hud@claude-hud'] === true ? null : JSON.stringify(s));
  check('E1 declares the marketplace with autoUpdate',
    JSON.stringify(s.extraKnownMarketplaces['task-flow']) === JSON.stringify({ source: { source: 'github', repo: 'someone/task-flow' }, autoUpdate: true }) ? null : JSON.stringify(s.extraKnownMarketplaces));
  check('E1 enables the plugin', s.enabledPlugins['task-flow@task-flow'] === true ? null : 'not enabled');
}

// E2: a BOM (PowerShell 5.1's utf8) is tolerated.
{
  const file = tmpFile('﻿{"theme":"light"}');
  const r = run(file);
  check('E2 a BOM does not break it', r.status === 0 && JSON.parse(fs.readFileSync(file, 'utf8')).theme === 'light' ? null : r.stderr);
}

// E3: an unparseable settings file is left exactly as it was.
{
  const broken = '{ "theme": "dark", oops }';
  const file = tmpFile(broken);
  const r = run(file);
  check('E3 unparseable settings fail', r.status !== 0 ? null : 'exited 0');
  check('E3 and are not overwritten', fs.readFileSync(file, 'utf8') === broken ? null : 'file changed');
}

// E4: a JSON that is not an object (e.g. an array) is refused, not replaced.
{
  const file = tmpFile('[1,2,3]');
  const r = run(file);
  check('E4 a non-object is refused untouched', r.status !== 0 && fs.readFileSync(file, 'utf8') === '[1,2,3]' ? null : `status ${r.status}`);
}

// E5: no settings file yet — one is created.
{
  const file = tmpFile(undefined);
  const r = run(file);
  check('E5 creates a missing settings file', r.status === 0 && fs.existsSync(file) ? null : r.stderr);
}

// E6: running it twice changes nothing the second time.
{
  const file = tmpFile('{}');
  run(file);
  const once = fs.readFileSync(file, 'utf8');
  run(file);
  check('E6 idempotent', fs.readFileSync(file, 'utf8') === once ? null : 'second run changed the file');
}

// E7: source kinds.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-src-'));
  const a = tmpFile('{}'); run(a, dir);
  const b = tmpFile('{}'); run(b, 'https://example.com/x.git');
  const sa = JSON.parse(fs.readFileSync(a, 'utf8')).extraKnownMarketplaces['task-flow'].source;
  const sb = JSON.parse(fs.readFileSync(b, 'utf8')).extraKnownMarketplaces['task-flow'].source;
  check('E7 a local directory becomes a directory source', sa.source === 'directory' ? null : JSON.stringify(sa));
  check('E7 a URL becomes a git source', sb.source === 'git' && sb.url === 'https://example.com/x.git' ? null : JSON.stringify(sb));
}

// E8: missing arguments are a usage error, and write nothing.
{
  const r = spawnSync(process.execPath, [SCRIPT, 'only-one-arg'], { encoding: 'utf8' });
  check('E8 missing arguments exit 2', r.status === 2 && !fs.existsSync('only-one-arg') ? null : `status ${r.status}`);
}

const total = passed + failures.length;
console.log(`\n${passed}/${total} passed`);
if (failures.length) process.exit(1);
