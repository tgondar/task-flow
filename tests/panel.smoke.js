#!/usr/bin/env node
// End-to-end check of the panel page in a real (headless) browser: the server
// started on a free port over a temporary local folder holding the sample feed,
// then the page driven over the DevTools protocol. Skipped when no Chromium-based
// browser is installed (set TASK_FLOW_BROWSER to point to one).
//
// What it proves that the server tests cannot: that the page draws what the
// feed holds, in the right order, without a console error; that the strict
// Content-Security-Policy does not break it; that text from a feed stays text;
// and that a feed changed on disk reaches the open page within seconds.
//
// Run: node tests/panel.smoke.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.LOCALAPPDATA = TEST_HOME;
process.env.XDG_STATE_HOME = TEST_HOME;

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

/** Polls an expression in the page until it is truthy or the time runs out. */
async function until(browser, expression, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await browser.eval(expression);
    if (value || Date.now() > end) return value;
    await sleep(150);
  }
}

(async () => {
  const { findBrowser, openBrowser } = await import('./support/browser.mjs');
  if (!findBrowser()) {
    console.log('skip  no Chromium-based browser found (set TASK_FLOW_BROWSER)');
    return;
  }
  const { startPanel } = await import('../plugin/panel/server.mjs');
  const { projectKey } = require('../plugin/scripts/config.js');

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-smoke-project-'));
  const key = projectKey(projectDir);
  const feedDir = path.join(TEST_HOME, 'task-flow', 'feed');
  fs.mkdirSync(feedDir, { recursive: true });
  const feed = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'feed.sample.json'), 'utf8'));
  Object.assign(feed, { projectKey: key, projectDir });
  // A feed field carrying markup: it must reach the page as text.
  feed.runs.find((run) => run.slug === 'invoices').branch = 'feature/<img src=x onerror="window.__pwned=1">';
  const writeFeed = () => fs.writeFileSync(path.join(feedDir, `${key}.json`), JSON.stringify(feed));
  writeFeed();

  const panel = await startPanel({ port: 0, quiet: true, register: false });
  const browser = await openBrowser({ width: 1200, height: 900 });
  try {
    await browser.goto(panel.url, 800);
    const noKey = await until(browser, 'document.querySelector(".empty") && document.querySelector(".empty").textContent');
    check('U0 SECURITY a browser without the key is told how to get it, and sees no run', /does not have the panel's key/.test(noKey || '') && (await browser.eval('document.querySelectorAll(".run-row").length')) === 0, noKey);
    // A new document, not a hash change: the page reads the key when it loads.
    await browser.goto("about:blank", 100);
    await browser.goto(`${panel.url}#t=${panel.token}`, 800);
    await until(browser, 'document.querySelectorAll(".run-row").length === 2');
    check('U0b the key is taken out of the address at once', (await browser.eval('location.hash')) === '', await browser.eval('location.href'));

    const rows = await browser.eval('[...document.querySelectorAll(".run-row")].map((row) => row.dataset.slug)');
    check('U1 the home view lists open runs, waiting ones first, and hides finished ones', JSON.stringify(rows) === JSON.stringify(['pdf-cleanup', 'invoices']), JSON.stringify(rows));
    const accordionLabel = await browser.eval('document.querySelector(".accordion summary").textContent');
    check('U1b a finished run is folded into a "finished" accordion instead', /1 finished run/.test(accordionLabel), accordionLabel);
    await browser.eval('document.querySelector(".accordion summary").click()');
    await until(browser, 'document.querySelectorAll(".run-row").length === 3');
    check('U1c opening it reveals the finished run', (await browser.eval('document.querySelectorAll(".run-row").length')) === 3);
    const summary = await browser.eval('document.querySelector(".panel-summary").textContent');
    check('U2 it says how many runs wait for the user', /2 runs waiting for you/.test(summary), summary);
    const invoices = await browser.eval('document.querySelector(\'[data-slug="invoices"]\').textContent');
    check('U3 a run shows its state, phase, task, questions and pending tasks', /stopped — waiting for an answer/.test(invoices) && /phase 4 of 7 · build/.test(invoices) && /task 2 of 3/.test(invoices) && /2 open questions/.test(invoices) && /1 task waiting on an answer/.test(invoices), invoices);
    const legacy = await browser.eval('document.querySelector(\'[data-slug="pdf-cleanup"]\').textContent');
    check('U4 a run with hand-written questions says so and has no answer button', /questions only in the \.md/.test(legacy) && !(await browser.eval('!!document.querySelector(\'[data-slug="pdf-cleanup"] button\')')), legacy);
    const pwned = await browser.eval('window.__pwned === 1');
    const branch = await browser.eval('document.querySelector(\'[data-slug="invoices"] code\').textContent');
    check('U5 SECURITY markup in a feed stays text', !pwned && branch.includes('<img'), branch);
    check('U6 no console error under the Content-Security-Policy', browser.problems.length === 0, browser.problems.join(' | '));

    feed.runs.find((run) => run.slug === 'invoices').status = 'running';
    feed.runs.find((run) => run.slug === 'invoices').questions.items.forEach((item) => {
      item.answer = { status: 'ok', via: 'conversation', at: '2026-09-27T21:00:00Z' };
    });
    writeFeed();
    const changed = await until(browser, 'document.querySelector(\'[data-slug="invoices"]\') && /running/.test(document.querySelector(\'[data-slug="invoices"]\').textContent) && !/open question/.test(document.querySelector(\'[data-slug="invoices"]\').textContent)', 5000);
    check('U7 a feed changed on disk reaches the open page within 5 seconds', !!changed);

    fs.rmSync(path.join(feedDir, `${key}.json`));
    await browser.goto(panel.url, 800);
    const empty = await until(browser, 'document.querySelector(".empty") && document.querySelector(".empty").textContent');
    check('U8 with no feed at all, the page explains where runs come from', /No runs yet/.test(empty || ''), empty);

    // --- one run: cards, drafts, sending -----------------------------------------
    const fresh = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'feed.sample.json'), 'utf8'));
    Object.assign(fresh, { projectKey: key, projectDir });
    fresh.runs.find((run) => run.slug === 'invoices').questions.items[0].why = 'Because <img src=x onerror="window.__pwned=2"> **bold**';
    fs.writeFileSync(path.join(feedDir, `${key}.json`), JSON.stringify(fresh));
    // Same document, new address: no load event, the page routes on hashchange.
    await browser.eval(`location.hash = "#/run/${key}/invoices"`);
    await until(browser, 'document.querySelectorAll(".question-card").length === 2');

    const cardIds = await browser.eval('[...document.querySelectorAll(".question-card")].map((c) => c.dataset.question)');
    const answeredIds = await browser.eval('[...document.querySelectorAll(".answered")].map((c) => c.dataset.question)');
    check('U9 a run shows its open questions as cards and the answered ones below', JSON.stringify(cardIds) === '["Q1","Q2"]' && JSON.stringify(answeredIds) === '["Q3"]', `${cardIds} / ${answeredIds}`);
    const why = await browser.eval('document.querySelector(\'[data-question="Q1"] .question-text\').textContent');
    check('U10 SECURITY markup in a question stays text', !(await browser.eval('window.__pwned === 2')) && why.includes('<img') && why.includes('**bold**'), why);

    const ready = () => browser.eval('document.querySelector(".send-bar .muted").textContent');
    const sendDisabled = () => browser.eval('document.querySelector(".send-bar button").disabled');
    await browser.eval('document.querySelectorAll(\'[data-question="Q1"] .toggle\')[3].click()');
    check('U11 "Explain" without saying what is not ready to send', /0 answers ready/.test(await ready()) && (await sendDisabled()), await ready());
    await browser.eval('document.querySelectorAll(\'[data-question="Q2"] input[type=radio]\')[1].click()');
    await browser.eval(`(() => { const box = document.querySelector('[data-question="Q1"] textarea'); box.value = 'Why not files?'; box.dispatchEvent(new Event('input')); })()`);
    check('U12 picking an option and asking in words make two answers ready', /2 answers ready/.test(await ready()) && !(await sendDisabled()), await ready());

    const draftFile = path.join(TEST_HOME, 'task-flow', 'panel', 'drafts', key, 'invoices.json');
    await sleep(900);
    const draft = fs.existsSync(draftFile) ? JSON.parse(fs.readFileSync(draftFile, 'utf8')) : null;
    check('U13 answers are kept as a draft on the server as they are typed', draft && draft.answers.Q2.choice === 'usd' && draft.answers.Q1.comment === 'Why not files?', JSON.stringify(draft));

    await browser.eval('document.querySelector(".send-bar button").click()');
    await until(browser, '!!document.querySelector("dialog[open]")');
    // Two clicks on "Send", as fast as a double click.
    await browser.eval('(() => { const buttons = document.querySelectorAll("dialog[open] .dialog-footer button"); const send = buttons[buttons.length - 1]; send.click(); send.click(); })()');
    await until(browser, '!document.querySelector("dialog[open]") && document.querySelectorAll(".sent-note").length === 2');
    const answersDir = path.join(TEST_HOME, 'task-flow', 'answers', key, 'invoices');
    const files = fs.existsSync(answersDir) ? fs.readdirSync(answersDir) : [];
    check('U14 "Send to agent" writes one submission, even on a double click', files.length === 1, files.join());
    const submission = files.length ? JSON.parse(fs.readFileSync(path.join(answersDir, files[0]), 'utf8')) : null;
    check('U15 it holds exactly the two answers', submission && JSON.stringify(submission.answers) === JSON.stringify([
      { questionId: 'Q1', status: 'explain', comment: 'Why not files?' },
      { questionId: 'Q2', status: 'ok', choice: 'usd' },
    ]), JSON.stringify(submission && submission.answers));
    check('U16 the sent questions say they wait for task-flow, and the draft is gone', (await browser.eval('document.querySelectorAll(".sent-note").length')) === 2 && !fs.existsSync(draftFile));
    check('U17 still no console error', browser.problems.length === 0, browser.problems.join(' | '));
  } finally {
    await browser.close();
    await panel.close();
  }

  const total = passed + failures.length;
  console.log(`\n${passed}/${total} passed`);
  if (failures.length) {
    console.log(`${failures.length} failing:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
