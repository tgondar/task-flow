#!/usr/bin/env node
// Tests for plugin/panel/server.mjs - the panel's local server.
//
// Mostly security tests. The server writes files that end up in front of the
// model, so the cases that matter are the ways another page, another program or
// a crafted request could get it to write something it should not, or to write
// somewhere it should not: a foreign Host (DNS rebinding), a write without this
// server's Origin (another site), ids that climb out of their folder, a
// submission task-flow would refuse, an approval smuggled in, a folder that is a
// link. And the one promise under all of it: after all these requests, nothing
// was written outside the panel's two folders.
//
// Run: node tests/panel-server.test.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.LOCALAPPDATA = TEST_HOME;
process.env.XDG_STATE_HOME = TEST_HOME;

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'feed.sample.json'), 'utf8'));
const KEY = SAMPLE.projectKey;
const HOME = path.join(TEST_HOME, 'task-flow');

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

/** Every file under a folder, relative, with its size and mtime: the "before and
 *  after" that proves where the server wrote. */
function tree(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stats = fs.statSync(full);
        out[path.relative(root, full)] = `${stats.size}:${stats.mtimeMs}`;
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

(async () => {
  const { startPanel, SECURITY_HEADERS } = await import('../plugin/panel/server.mjs');

  // The feed the panel reads: the sample project, pointing at a project folder
  // that exists (the server itself never looks at it - the test does).
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-panel-project-'));
  const { projectKey } = require('../plugin/scripts/config.js');
  const key = projectKey(projectDir);
  const feed = { ...SAMPLE, projectKey: key, projectDir };
  fs.mkdirSync(path.join(HOME, 'feed'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'feed', `${key}.json`), JSON.stringify(feed));
  // A sentinel for "the documentation": a docs folder beside the project.
  const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-panel-docs-'));
  fs.writeFileSync(path.join(docsDir, 'spec.md'), '# untouched');

  const panel = await startPanel({ port: 0, quiet: true });
  const base = `127.0.0.1:${panel.port}`;
  const origin = `http://${base}`;

  function request(method, url, { host = base, headers = {}, body } = {}) {
    return new Promise((resolve) => {
      const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port: panel.port, method, path: url, headers: { Host: host, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
            resolve({ status: res.statusCode, headers: res.headers, text, json });
          });
        }
      );
      req.on('error', (error) => resolve({ status: 0, error }));
      if (data) req.write(data);
      req.end();
    });
  }
  const write = (method, url, body, headers = {}) =>
    request(method, url, { body, headers: { Origin: origin, 'Content-Type': 'application/json', ...headers } });
  const runUrl = (route, slug = 'invoices', project = key) => `/api/${route}?project=${project}&slug=${slug}`;

  const before = { docs: tree(docsDir), project: tree(projectDir) };
  const beforeHome = tree(HOME);

  // --- reading --------------------------------------------------------------------

  const projects = await request('GET', '/api/projects');
  const runs = projects.json && projects.json.projects[0].runs;
  check('S1 the projects view lists the feed, waiting runs first', projects.status === 200 && runs && runs[0].waitsOnUser && runs.map((r) => r.slug).join() === 'pdf-cleanup,invoices,old-report', projects.text.slice(0, 300));
  check('S2 the projects view never carries the project path', projects.status === 200 && !projects.text.includes(JSON.stringify(projectDir).slice(1, -1)), '');

  const run = await request('GET', runUrl('run'));
  check('S3 a run comes with its cards', run.status === 200 && run.json.cards.map((c) => c.id).join() === 'Q1,Q2,Q3' && run.json.run.taskCount === 3, run.text.slice(0, 300));

  const page = await request('GET', '/');
  check('S4 every response carries the security headers', Object.entries(SECURITY_HEADERS).every(([name, value]) => page.headers[name.toLowerCase()] === value && projects.headers[name.toLowerCase()] === value), JSON.stringify(page.headers));
  check('S5 the policy forbids inline script and framing', /script-src 'self'/.test(page.headers['content-security-policy']) && /frame-ancestors 'none'/.test(page.headers['content-security-policy']) && !/unsafe-inline/.test(page.headers['content-security-policy']));

  // --- what is refused -------------------------------------------------------------

  check('S6 SECURITY a foreign Host is refused (DNS rebinding)', (await request('GET', '/api/projects', { host: 'evil.example:80' })).status === 421);
  check('S7 SECURITY a write without an Origin is refused', (await request('POST', runUrl('submit'), { body: { answers: [], clientToken: 'abcdefgh' }, headers: { 'Content-Type': 'application/json' } })).status === 403);
  check('S8 SECURITY a write from another Origin is refused', (await write('POST', runUrl('submit'), { answers: [], clientToken: 'abcdefgh' }, { Origin: 'http://evil.example' })).status === 403);
  check('S9 SECURITY a write that is not JSON is refused (form posts)', (await write('POST', runUrl('submit'), 'answers=1', { 'Content-Type': 'application/x-www-form-urlencoded' })).status === 415);
  for (const [label, url] of [
    ['a project key with ..', runUrl('run', 'invoices', '..%2F..%2Fx')],
    ['a run name with ..', runUrl('run', '..%2F..%2Fescape')],
    ['a run name with a backslash', runUrl('run', 'a%5Cb')],
    ['an empty run name', runUrl('run', '')],
  ]) {
    check(`S10 SECURITY ${label} is refused`, (await request('GET', url)).status === 400, url);
  }
  check('S11 SECURITY a static path climbing out of the page folder is refused', [(await request('GET', '/..%2F..%2Fscripts%2Fconfig.js')).status, (await request('GET', '/%2e%2e/%2e%2e/NOTICE.md')).status].every((s) => s === 404));
  check('S12 an unknown run is 404', (await request('GET', runUrl('run', 'nope'))).status === 404);

  const approval = await write('POST', runUrl('submit'), { answers: [{ questionId: 'Q2', status: 'ok', approvedBy: 'me' }], clientToken: 'token-approval' });
  check('S13 SECURITY an approval smuggled into an answer is refused', approval.status === 400, approval.text);
  const envelope = await write('POST', runUrl('submit'), { answers: [{ questionId: 'Q2', status: 'ok' }], clientToken: 'token-envelope', approvedBy: 'me' });
  const envelopeFiles = tree(path.join(HOME, 'answers'));
  check('S14 SECURITY extra fields around the answers never reach the submission file', envelope.status === 200 && Object.keys(envelopeFiles).length === 1 && !/approvedBy/.test(fs.readFileSync(path.join(HOME, 'answers', Object.keys(envelopeFiles)[0]), 'utf8')), envelope.text);
  fs.rmSync(path.join(HOME, 'answers'), { recursive: true, force: true });

  check('S15 SECURITY a choice that was never offered is refused', (await write('POST', runUrl('submit'), { answers: [{ questionId: 'Q2', status: 'ok', choice: 'gbp' }], clientToken: 'token-choice' })).status === 400);
  check('S16 SECURITY an answer to a closed question is refused', (await write('POST', runUrl('submit'), { answers: [{ questionId: 'Q3', status: 'ko', comment: 'reopen' }], clientToken: 'token-closed' })).status === 409);
  check('S17 SECURITY control characters in a comment are refused', (await write('POST', runUrl('submit'), { answers: [{ questionId: 'Q2', status: 'ko', comment: 'a\u001b[2Jb' }], clientToken: 'token-ctrl' })).status === 400);
  check('S18 a run whose questions are a hand-written page takes no answers here', (await write('POST', runUrl('submit', 'pdf-cleanup'), { answers: [{ questionId: 'Q1', status: 'ok' }], clientToken: 'token-legacy' })).status === 409);
  check('S19 SECURITY an oversized body is refused', (await write('POST', runUrl('submit'), { answers: [], clientToken: 'token-big', pad: 'x'.repeat(600 * 1024) })).status === 413);

  // --- sending ---------------------------------------------------------------------

  const draft = await write('PUT', runUrl('draft'), { answers: { Q2: { status: 'modify', choice: 'usd', comment: 'draft' }, Q3: { status: 'ko' }, Q1: { status: 'ok', approvedBy: 'me' } } });
  const draftFile = path.join(HOME, 'panel', 'drafts', key, 'invoices.json');
  const draftText = fs.existsSync(draftFile) ? fs.readFileSync(draftFile, 'utf8') : '';
  check('S20 a draft is kept for open questions only, with nothing but answer fields', draft.status === 200 && /"Q2"/.test(draftText) && !/"Q3"/.test(draftText) && !/approvedBy/.test(draftText), draftText);
  check('S21 the run view returns the draft', (await request('GET', runUrl('run'))).json.draft.Q2.comment === 'draft');

  const send = { answers: [{ questionId: 'Q2', status: 'modify', choice: 'usd', comment: 'Only for US clients.' }, { questionId: 'Q1', status: 'ok' }], clientToken: 'token-send-1' };
  const first = await write('POST', runUrl('submit'), send);
  const second = await write('POST', runUrl('submit'), send);
  const answersDir = path.join(HOME, 'answers', key, 'invoices');
  const files = fs.existsSync(answersDir) ? fs.readdirSync(answersDir) : [];
  check('S22 a send writes one submission file, named by its id', first.status === 200 && files.length === 1 && files[0] === `${first.json.submissionId}.json`, JSON.stringify({ first: first.json, files }));
  check('S23 the same send twice (a double click) writes once', second.status === 200 && second.json.repeated === true && second.json.submissionId === first.json.submissionId && files.length === 1, second.text);
  check('S24 the draft goes once it is sent', !fs.existsSync(draftFile));

  const { consume } = require('../plugin/scripts/answers.js');
  const written = JSON.parse(fs.readFileSync(path.join(answersDir, files[0]), 'utf8'));
  check('S25 the submission is exactly what answers.js takes in', written.version === 1 && written.slug === 'invoices' && written.projectDir === projectDir && written.answers.length === 2 && typeof consume === 'function', JSON.stringify(written));

  // task-flow takes it in: the feed now lists it as consumed, and the panel clears it.
  const consumed = JSON.parse(JSON.stringify(feed));
  consumed.runs.find((r) => r.slug === 'invoices').questions.consumedSubmissions = [first.json.submissionId];
  fs.writeFileSync(path.join(HOME, 'feed', `${key}.json`), JSON.stringify(consumed));
  fs.writeFileSync(path.join(answersDir, 'notes.txt'), 'not ours');
  await request('GET', '/api/projects');
  check('S26 a consumed submission is cleared by the panel; other files are left alone', !fs.existsSync(path.join(answersDir, files[0])) && fs.existsSync(path.join(answersDir, 'notes.txt')), fs.readdirSync(answersDir).join());

  // --- where it wrote ---------------------------------------------------------------

  const afterHome = tree(HOME);
  const newOrChanged = Object.keys(afterHome).filter((file) => beforeHome[file] !== afterHome[file]);
  check('S27 SECURITY it wrote only under answers/ and panel/ (and the test wrote the feed)', newOrChanged.every((file) => /^(answers|panel|feed)[\\/]/.test(file)), newOrChanged.join());
  check('S28 SECURITY it wrote nothing in the project or the docs folder', JSON.stringify(tree(docsDir)) === JSON.stringify(before.docs) && JSON.stringify(tree(projectDir)) === JSON.stringify(before.project));

  await panel.close();
  check('S29 closing removes its registry entry', !fs.existsSync(path.join(HOME, 'panel', 'server.json')));

  // --- refusing to start ------------------------------------------------------------

  {
    const linkBase = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-panel-linkbase-'));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-panel-elsewhere-'));
    fs.mkdirSync(path.join(linkBase, 'task-flow'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(linkBase, 'task-flow', 'answers'), 'junction');
    let refused = false;
    try {
      const started = await startPanel({ port: 0, quiet: true, register: false, env: { LOCALAPPDATA: linkBase, XDG_STATE_HOME: linkBase } });
      await started.close();
    } catch (error) {
      refused = /link/.test(error.message);
    }
    check('S30 SECURITY it refuses to start when its answers folder is a link', refused && fs.readdirSync(elsewhere).length === 0);
  }

  // --- report -------------------------------------------------------------------
  const total = passed + failures.length;
  console.log(`\n${passed}/${total} passed`);
  if (failures.length) {
    console.log(`${failures.length} failing:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
})();
