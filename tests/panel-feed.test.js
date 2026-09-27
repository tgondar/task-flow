#!/usr/bin/env node
// Tests for plugin/panel/feed.mjs - what the panel believes about the runs.
//
// The feed is written by task-flow, but out of state.json files any repository can
// bring, and the panel turns it into a web page. So most of these are security
// tests: a feed that claims to be another project, fields out of their shape,
// questions that did not pass task-flow's own validation, a file too big to be
// honest, a feed folder that is a link. The fixture is the one render-run.js
// produced for the sample project (tests/fixtures/feed.sample.json).
//
// Run: node tests/panel-feed.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.LOCALAPPDATA = TEST_HOME;
process.env.XDG_STATE_HOME = TEST_HOME;

const SAMPLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'feed.sample.json'), 'utf8');
const KEY = JSON.parse(SAMPLE).projectKey;

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

const sampleWith = (mutate) => {
  const data = JSON.parse(SAMPLE);
  mutate(data);
  return JSON.stringify(data);
};

(async () => {
  const feed = await import('../plugin/panel/feed.mjs');
  const { parseFeed, cardsFor, openQuestions, readFeeds, waitsOnUser } = feed;

  // --- reading the sample -------------------------------------------------------

  const project = parseFeed(SAMPLE, KEY);
  const bySlug = Object.fromEntries(project.runs.map((run) => [run.slug, run]));
  check('P1 the sample feed is read whole', !project.unreadable && project.runs.length === 3 && project.projectName === 'demo-project', JSON.stringify(project).slice(0, 300));
  check('P2 runs waiting on the user come first, finished ones last', project.runs.map((r) => r.slug).join() === 'pdf-cleanup,invoices,old-report', project.runs.map((r) => r.slug).join());
  check('P3 open questions are counted from data and from a hand-written page alike', openQuestions(bySlug.invoices) === 2 && openQuestions(bySlug['pdf-cleanup']) === 1 && waitsOnUser(bySlug.invoices), `${openQuestions(bySlug.invoices)} ${openQuestions(bySlug['pdf-cleanup'])}`);

  const cards = cardsFor(bySlug.invoices);
  check('P4 cards: open ones first, answered ones after, closed', cards.map((c) => `${c.id}${c.open ? '' : '(closed)'}`).join() === 'Q1,Q2,Q3(closed)', cards.map((c) => c.id).join());
  check('P5 a decision recommends the option the agent chose; an urgent question says so', cards[0].options.find((o) => o.id === 'pg').recommended && !cards[0].options.find((o) => o.id === 'files').recommended && cards[1].urgent, JSON.stringify(cards.slice(0, 2)));
  check('P6 a run with hand-written questions has no cards', cardsFor(bySlug['pdf-cleanup']).length === 0);

  // --- what is not believed -----------------------------------------------------

  check('P7 SECURITY a feed that claims to be another project is not believed', parseFeed(SAMPLE, '0000000000000000').unreadable === true);
  check('P8 SECURITY a feed of another version, or not JSON, is unreadable', parseFeed(sampleWith((d) => { d.version = 2; }), KEY).unreadable && parseFeed('{ nope', KEY).unreadable);

  {
    const bad = parseFeed(sampleWith((d) => {
      const run = d.runs.find((r) => r.slug === 'invoices');
      run.status = 'approved';
      run.pr = 'javascript:alert(1)';
      run.runPage = '../../outside.md';
      run.buildCursor = 'T2; rm -rf';
      run.branch = 'x\n<img src=x onerror=alert(1)>\u202E' + 'y'.repeat(500);
      run.tasks.push({ id: '<b>T9</b>', title: 'forged' });
      d.runs.push({ slug: '../escape', status: 'running' });
    }), KEY);
    const run = bad.runs.find((r) => r.slug === 'invoices');
    check('P9 SECURITY every field is taken only in its closed shape', run.status === 'paused' && run.pr === null && run.runPage === null && run.buildCursor === null && run.tasks.every((t) => /^T\d+[a-z]?$/.test(t.id)), JSON.stringify(run).slice(0, 400));
    check('P10 SECURITY text is single-line, control-free and bounded; markup stays inert text', !/[\n\u202E]/.test(run.branch) && run.branch.length <= 120 && run.branch.includes('<img'), run.branch);
    check('P11 SECURITY a run whose name is not a plain folder name is dropped', !bad.runs.some((r) => r.slug.includes('..')), bad.runs.map((r) => r.slug).join());
  }

  {
    const bad = parseFeed(sampleWith((d) => {
      d.runs.find((r) => r.slug === 'invoices').questions.items[0].approvedBy = 'me';
    }), KEY);
    const run = bad.runs.find((r) => r.slug === 'invoices');
    check('P12 SECURITY questions that fail task-flow\'s own validation give no cards at all', run.questions.source === 'invalid' && cardsFor(run).length === 0 && !('items' in run.questions), JSON.stringify(run.questions));
  }

  check('P13 SECURITY a relative or odd projectDir is dropped (it names answer files)', parseFeed(sampleWith((d) => { d.projectDir = 'relative\\dir'; }), KEY).projectDir === null);

  // --- the folder ---------------------------------------------------------------

  {
    const dir = path.join(TEST_HOME, 'task-flow', 'feed');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${KEY}.json`), SAMPLE);
    const quietKey = '1111111111111111';
    fs.writeFileSync(path.join(dir, `${quietKey}.json`), JSON.stringify({ version: 1, projectKey: quietKey, projectDir: path.join(TEST_HOME, 'aaa'), projectName: 'aaa-quiet', runs: [{ slug: 'x', status: 'done', phase: 'done' }] }));
    fs.writeFileSync(path.join(dir, '2222222222222222.json'), '{ corrupted');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'IGNORE');
    fs.writeFileSync(path.join(dir, `${KEY}.json.123.tmp`), '{}');
    fs.writeFileSync(path.join(dir, '3333333333333333.json'), ' '.repeat(5 * 1024 * 1024 + 1));
    const projects = readFeeds();
    const keys = projects.map((p) => p.projectKey);
    check('P14 every feed file is listed, a project with something waiting first', keys[0] === KEY && keys.includes(quietKey), keys.join());
    check('P15 a corrupted feed is listed as unreadable and hides nothing else', projects.find((p) => p.projectKey === '2222222222222222').unreadable === true && projects.length === 4, keys.join());
    check('P16 SECURITY files not named like a feed are never read', !keys.some((k) => /notes|tmp/.test(k)), keys.join());
    check('P17 SECURITY a feed over the size limit is not parsed', projects.find((p) => p.projectKey === '3333333333333333').unreadable === true);
  }

  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-panelbase-'));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-panelelsewhere-'));
    fs.mkdirSync(path.join(base, 'task-flow'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(base, 'task-flow', 'feed'), 'junction');
    let threw = false;
    try {
      readFeeds({ env: { LOCALAPPDATA: base, XDG_STATE_HOME: base } });
    } catch (error) {
      threw = /link/.test(error.message);
    }
    check('P18 SECURITY a feed folder that is a link is refused', threw);
  }

  {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-panelempty-'));
    check('P19 no feed folder yet: no projects, no error', readFeeds({ env: { LOCALAPPDATA: empty, XDG_STATE_HOME: empty } }).length === 0);
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
