#!/usr/bin/env node
// Tests for plugin/viewer/js/feed-logic.js - what the viewer believes about the
// runs, and what it will and will not write back as an answer.
//
// The feed is written by task-flow, but out of state.json files any repository
// can bring, and this module turns it into what a web page draws. So most of
// these are security tests: a feed that claims to be another project, fields
// out of their shape, questions that did not pass task-flow's own validation,
// a submission that answers a question that is not open or picks an option
// that does not exist. The fixture is the one render-run.js produced for the
// sample project (tests/fixtures/feed.sample.json) - the same fixture the
// panel's equivalent test used, before the viewer replaced it.
//
// Run: node tests/viewer-feed-logic.test.js

const fs = require('fs');
const path = require('path');

const feedLogic = require('../plugin/viewer/js/feed-logic.js');
const { parseFeed, cardsFor, openQuestions, waitsOnUser, sortRuns, checkOutgoingAnswers, newSubmissionId, isIsoTime } = feedLogic;

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

// --- reading the sample -------------------------------------------------------

const project = parseFeed(SAMPLE, KEY);
const bySlug = Object.fromEntries(project.runs.map((run) => [run.slug, run]));
check('F1 the sample feed is read whole', !project.unreadable && project.runs.length === 3 && project.projectName === 'demo-project', JSON.stringify(project).slice(0, 300));
check('F2 runs waiting on the user come first, finished ones last', project.runs.map((r) => r.slug).join() === 'pdf-cleanup,invoices,old-report', project.runs.map((r) => r.slug).join());
check('F3 open questions are counted from data and from a hand-written page alike', openQuestions(bySlug.invoices) === 2 && openQuestions(bySlug['pdf-cleanup']) === 1 && waitsOnUser(bySlug.invoices), `${openQuestions(bySlug.invoices)} ${openQuestions(bySlug['pdf-cleanup'])}`);

const cards = cardsFor(bySlug.invoices);
check('F4 cards: open ones first, answered ones after, closed', cards.map((c) => `${c.id}${c.open ? '' : '(closed)'}`).join() === 'Q1,Q2,Q3(closed)', cards.map((c) => c.id).join());
check('F5 a decision recommends the option the agent chose; an urgent question says so', cards[0].options.find((o) => o.id === 'pg').recommended && !cards[0].options.find((o) => o.id === 'files').recommended && cards[1].urgent, JSON.stringify(cards.slice(0, 2)));
check('F6 a run with hand-written questions has no cards', cardsFor(bySlug['pdf-cleanup']).length === 0);

// --- what is not believed -----------------------------------------------------

check('F7 SECURITY a feed that claims to be another project is not believed', parseFeed(SAMPLE, '0000000000000000').unreadable === true);
check('F8 SECURITY a feed of another version, or not JSON, is unreadable', parseFeed(sampleWith((d) => { d.version = 2; }), KEY).unreadable && parseFeed('{ nope', KEY).unreadable);

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
  check('F9 SECURITY every field is taken only in its closed shape', run.status === 'paused' && run.pr === null && run.runPage === null && run.buildCursor === null && run.tasks.every((t) => /^T\d+[a-z]?$/.test(t.id)), JSON.stringify(run).slice(0, 400));
  check('F10 SECURITY text is single-line, control-free and bounded; markup stays inert text', !/[\n\u202E]/.test(run.branch) && run.branch.length <= 120 && run.branch.includes('<img'), run.branch);
  check('F11 SECURITY a run whose name is not a plain folder name is dropped', !bad.runs.some((r) => r.slug.includes('..')), bad.runs.map((r) => r.slug).join());
}

{
  const bad = parseFeed(sampleWith((d) => {
    d.runs.find((r) => r.slug === 'invoices').questions.items[0].approvedBy = 'me';
  }), KEY);
  const run = bad.runs.find((r) => r.slug === 'invoices');
  check('F12 SECURITY questions that fail task-flow\'s own validation give no cards at all', run.questions.source === 'invalid' && cardsFor(run).length === 0 && !('items' in run.questions), JSON.stringify(run.questions));
}

check('F13 SECURITY a relative or odd projectDir is dropped (it names answer files)', parseFeed(sampleWith((d) => { d.projectDir = 'relative\\dir'; }), KEY).projectDir === null);
check('F14 a real Windows absolute path is kept', parseFeed(sampleWith((d) => { d.projectDir = 'C:\\work\\demo-project'; }), KEY).projectDir === 'C:\\work\\demo-project');
check('F15 a POSIX absolute path is kept too (the viewer also runs on Linux/macOS)', parseFeed(sampleWith((d) => { d.projectDir = '/home/x/demo-project'; }), KEY).projectDir === '/home/x/demo-project');

check('F16 sortRuns: waiting first, then running, then stopped, then done, most recent first', sortRuns([
  { status: 'done', updated: '2026-01-01T00:00:00Z' },
  { status: 'blocked', updated: '2026-01-01T00:00:00Z' },
  { status: 'running', updated: '2026-01-02T00:00:00Z' },
  { status: 'running', updated: '2026-01-03T00:00:00Z' },
].map((r) => ({ ...r, questions: { source: 'none' } }))).map((r) => r.status).join() === 'blocked,running,running,done');

// --- outgoing answers: what the viewer will write, before task-flow even sees it --

{
  const openCards = cardsFor(bySlug.invoices);
  const cardsById = new Map(openCards.map((c) => [c.id, c]));
  const openId = openCards.find((c) => c.open).id;
  const optionId = openCards.find((c) => c.open).options[0]?.id;

  check('F17 a well-formed answer to an open question is accepted', checkOutgoingAnswers([{ questionId: openId, status: 'ok', choice: optionId }], cardsById).ok);
  check('F18 SECURITY an answer to a question this run does not have is refused', !checkOutgoingAnswers([{ questionId: 'Q999', status: 'ok' }], cardsById).ok);
  check('F19 SECURITY a choice that is not one of the question\'s options is refused', !checkOutgoingAnswers([{ questionId: openId, status: 'ok', choice: 'not-a-real-option' }], cardsById).ok);
  check('F20 SECURITY the same question answered twice in one batch is refused', !checkOutgoingAnswers([{ questionId: openId, status: 'ok', choice: optionId }, { questionId: openId, status: 'ko' }], cardsById).ok);
  check('F21 SECURITY an unknown status is refused', !checkOutgoingAnswers([{ questionId: openId, status: 'approved' }], cardsById).ok);
  check('F22 "explain" with no comment is refused; the same request with one is accepted', !checkOutgoingAnswers([{ questionId: openId, status: 'explain' }], cardsById).ok && checkOutgoingAnswers([{ questionId: openId, status: 'explain', comment: 'say more' }], cardsById).ok);
  check('F23 SECURITY an empty batch, and a batch over the cap, are both refused', !checkOutgoingAnswers([], cardsById).ok && !checkOutgoingAnswers(Array.from({ length: 51 }, (_, i) => ({ questionId: `Q${i + 1}`, status: 'ok' })), cardsById).ok);
  check('F24 SECURITY a comment with control characters is stripped down, not smuggled through', checkOutgoingAnswers([{ questionId: openId, status: 'explain', comment: 'a\u0000b' }], cardsById).answers[0].comment === 'a b');
  check('F25 SECURITY a field that is not part of an answer is dropped, not carried through', !('extra' in checkOutgoingAnswers([{ questionId: openId, status: 'ok', choice: optionId, extra: 'x' }], cardsById).answers[0]));
}

check('F26 newSubmissionId matches the shape answers.js consume expects', /^\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(newSubmissionId(new Date('2026-09-28T12:34:56.789Z'))), newSubmissionId());
check('F27 isIsoTime accepts an ISO timestamp and refuses plain text', isIsoTime('2026-09-28T12:34:56Z') && !isIsoTime('not a date'));

// --- report -------------------------------------------------------------------
const total = passed + failures.length;
console.log(`\n${passed}/${total} passed`);
if (failures.length) {
  console.log(`${failures.length} failing:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
