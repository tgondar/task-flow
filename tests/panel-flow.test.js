#!/usr/bin/env node
// The whole round trip, with the real pieces and no Claude session:
//
//   a run with a question → render (page + feed) → the panel lists it →
//   the user answers in the panel → answers.js wait wakes → consume takes it in →
//   the page shows the answer → the feed shows it consumed → the panel clears
//   its file.
//
// Each unit is tested on its own elsewhere; this proves they agree with each
// other - the feed the renderer writes is what the panel reads, the submission
// the panel writes is what consume takes - and that through all of it nothing
// was written in the docs folder except by task-flow.
//
// Run: node tests/panel-flow.test.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-home-'));
for (const name of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_STATE_HOME']) process.env[name] = TEST_HOME;

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

(async () => {
  const { trustDocsDir } = require('../plugin/scripts/config.js');
  const { renderAll } = require('../plugin/scripts/render-run.js');
  const { consume, wait, report } = require('../plugin/scripts/answers.js');
  const { startPanel } = await import('../plugin/panel/server.mjs');

  // A project with one blocked run and one open question.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-flow-'));
  const projectDir = path.join(root, 'project');
  const docsDir = path.join(root, 'notes');
  fs.mkdirSync(path.join(docsDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'tasks', 'index.md'), '# Tasks\n');
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.claude', 'task-flow.json'), JSON.stringify({ docsDir, language: 'PT-PT', tasksFile: 'tasks/index.md' }));
  const runDir = path.join(projectDir, '.claude', 'task-flow', 'invoices');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ task: 'invoices', phase: 'plan', status: 'blocked', created: '2026-09-27', updated: '2026-09-27T20:00:00Z', approvedBy: '' }));
  fs.writeFileSync(path.join(runDir, 'questions.json'), JSON.stringify({
    version: 1, slug: 'invoices', created: '2026-09-27',
    items: [{ id: 'Q1', kind: 'question', title: 'Which currency?', options: [{ id: 'eur', label: 'EUR' }, { id: 'usd', label: 'USD' }] }],
  }));
  trustDocsDir(projectDir, docsDir);

  renderAll({ projectDir });
  const page = path.join(docsDir, 'questions', '260927_invoices_questions.md');
  check('F1 the render writes the questions page, with the question open', /- \[ \] \*\*Which currency\?\*\*/.test(fs.readFileSync(page, 'utf8')));
  const docsBefore = fs.readdirSync(docsDir, { recursive: true }).sort().join('|');

  const panel = await startPanel({ port: 0, quiet: true, register: false });
  const call = (method, url, body) =>
    new Promise((resolve) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({
        host: '127.0.0.1', port: panel.port, method, path: url,
        headers: { Host: `127.0.0.1:${panel.port}`, 'X-Panel-Token': panel.token, ...(data ? { Origin: `http://127.0.0.1:${panel.port}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
      }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text || 'null') }));
      });
      if (data) req.write(data);
      req.end();
    });

  const listed = await call('GET', '/api/projects');
  const project = listed.json.projects[0];
  check('F2 the panel lists the run as waiting for the user', project && project.runs[0].slug === 'invoices' && project.runs[0].waitsOnUser && project.runs[0].openQuestions === 1, JSON.stringify(listed.json).slice(0, 300));

  const waiting = wait({ projectDir, slug: 'invoices', timeoutMs: 10000, intervalMs: 100 });
  const sent = await call('POST', `/api/submit?project=${project.projectKey}&slug=invoices`, {
    answers: [{ questionId: 'Q1', status: 'ok', choice: 'usd', comment: 'Only US clients for now.' }],
    clientToken: 'flow-test-1',
  });
  check('F3 the answer is sent from the panel', sent.status === 200 && /^\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(sent.json.submissionId), JSON.stringify(sent));
  check('F4 answers.js wait wakes for it', (await waiting) === 0);

  const outcome = consume({ projectDir, slug: 'invoices' });
  check('F5 consume takes it in, and says so inside the data block', outcome.taken.length === 1 && /<<<PANEL-ANSWERS[\s\S]*"choice": "usd"[\s\S]*PANEL-ANSWERS>>>/.test(report('invoices', outcome)), report('invoices', outcome));
  const md = fs.readFileSync(page, 'utf8');
  check('F6 the page shows it answered, from the panel, in the project language', /- \[x\] \*\*Which currency\?\*\*/.test(md) && /Resposta \(painel, [^)]+\): OK — escolha: USD — Only US clients for now\./.test(md), md);

  panel.sweep();
  const answersDir = path.join(TEST_HOME, 'task-flow', 'answers', project.projectKey, 'invoices');
  check('F7 the feed shows it consumed, and the panel clears its file', fs.readdirSync(answersDir).length === 0, fs.readdirSync(answersDir).join());
  const after = await call('GET', '/api/projects');
  check('F8 and the run no longer waits for the user, but its status is still for task-flow to change', after.json.projects[0].runs[0].openQuestions === 0 && after.json.projects[0].runs[0].status === 'blocked');

  const docsAfter = fs.readdirSync(docsDir, { recursive: true }).sort().join('|');
  check('F9 the docs folder holds the same files - only task-flow rewrote its own page', docsAfter === docsBefore, `${docsBefore}\n${docsAfter}`);
  const second = consume({ projectDir, slug: 'invoices' });
  check('F10 consuming again takes nothing', second.taken.length === 0);

  await panel.close();
  const total = passed + failures.length;
  console.log(`\n${passed}/${total} passed`);
  if (failures.length) {
    console.log(`${failures.length} failing:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
})();
