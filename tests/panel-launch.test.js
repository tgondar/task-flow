#!/usr/bin/env node
// Tests for plugin/panel/panel.mjs - starting the panel, or finding the one that
// is already running.
//
// The security case is the registry, <home>/panel/server.json: it is only a hint.
// A registry that names a process that is gone, or a port where something other
// than a task-flow panel answers, must not be believed - otherwise a stale file
// (or another program on that port) would stand in for the panel, and the user
// would be sent to it.
//
// Run: node tests/panel-launch.test.js

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-home-'));
const ENV = { ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME, LOCALAPPDATA: TEST_HOME, XDG_STATE_HOME: TEST_HOME };
const PANEL = path.join(__dirname, '..', 'plugin', 'panel', 'panel.mjs');
const REGISTRY = path.join(TEST_HOME, 'task-flow', 'panel', 'server.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(100);
  }
  return false;
}

(async () => {
  // A foreign server on some port, and a registry that points at it with a live pid.
  const foreign = http.createServer((req, res) => res.end('not a panel'));
  await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve));
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify({ port: foreign.address().port, pid: process.pid }));

  const first = spawn(process.execPath, [PANEL, '--port', '0'], { env: ENV });
  let out = '';
  first.stdout.on('data', (chunk) => (out += chunk));
  first.stderr.on('data', (chunk) => (out += chunk));
  const started = await waitFor(() => /task-flow panel: http:\/\/127\.0\.0\.1:\d+\//.test(out));
  check('L1 SECURITY a registry pointing at a program that is not a panel is not believed: a panel starts', started, out);
  const port = Number((/127\.0\.0\.1:(\d+)/.exec(out) || [])[1]);
  const registry = fs.existsSync(REGISTRY) ? JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) : {};
  check('L2 the new panel records itself', registry.port === port && registry.pid === first.pid, JSON.stringify(registry));

  const second = spawnSync(process.execPath, [PANEL, '--port', '0'], { env: ENV, encoding: 'utf8', timeout: 15000 });
  check('L3 a second start reuses the running panel instead of starting another', second.status === 0 && second.stdout.includes(`already running: http://127.0.0.1:${port}/`), `${second.status} ${second.stdout} ${second.stderr}`);

  first.kill();
  await waitFor(() => first.exitCode !== null || first.signalCode !== null);
  fs.writeFileSync(REGISTRY, JSON.stringify({ port, pid: 2147483000 }));
  const third = spawn(process.execPath, [PANEL, '--port', '0'], { env: ENV });
  let thirdOut = '';
  third.stdout.on('data', (chunk) => (thirdOut += chunk));
  check('L4 a registry naming a process that is gone is ignored', await waitFor(() => /task-flow panel: http/.test(thirdOut)), thirdOut);
  third.kill();

  const bad = spawnSync(process.execPath, [PANEL, '--port', '99999'], { env: ENV, encoding: 'utf8', timeout: 15000 });
  check('L5 a bad option is refused with a message, not a stack', bad.status === 1 && /--port takes a port number/.test(bad.stderr) && !/at .*\.mjs/.test(bad.stderr), bad.stderr);

  // The exact command line install.ps1 gives the scheduled task, run with the
  // local folder redirected here (Windows only).
  if (process.platform === 'win32') {
    fs.rmSync(REGISTRY, { force: true });
    const node = process.execPath.replace(/'/g, "''");
    const script = PANEL.replace(/'/g, "''");
    const command = `& '${node}' '${script}' --quiet --port 0`;
    const task = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command], { env: ENV });
    const up = await waitFor(() => fs.existsSync(REGISTRY), 15000);
    check('L6 the scheduled task\'s command line starts the panel', up);
    if (up) {
      const info = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
      try {
        process.kill(info.pid);
      } catch {
        /* already gone */
      }
    }
    task.kill();
  }

  foreign.close();
  const total = passed + failures.length;
  console.log(`\n${passed}/${total} passed`);
  if (failures.length) {
    console.log(`${failures.length} failing:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
})();
