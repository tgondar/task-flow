#!/usr/bin/env node
// End-to-end check that the viewer actually loads when opened the way a real
// user opens it: double-clicking index.html, i.e. a bare file:// URL, no server
// anywhere. This is the check that matters most for this page: Chrome and Edge
// refuse to load `type="module"` scripts and `fetch()` of local files at all
// over file://, which is why every file under plugin/viewer/js/ is a classic
// script attaching to window.TFV instead (see js/dom.js). If that wiring is
// wrong, this is where it shows up - as a console error, not a passing unit
// test.
//
// What it cannot prove: the native folder-picker dialog (showDirectoryPicker)
// itself, which needs a real user gesture and an OS dialog - out of reach for
// CDP automation. It does confirm the API exists and file:// counts as a secure
// context here, which is the other precondition for the picker to work at all.
//
// Skipped when no Chromium-based browser is installed (set TASK_FLOW_BROWSER).
// Run: node tests/viewer.smoke.js

const path = require('path');
const url = require('url');

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
  const { findBrowser, openBrowser } = await import('./support/browser.mjs');
  if (!findBrowser()) {
    console.log('skip  no Chromium-based browser found (set TASK_FLOW_BROWSER)');
    return;
  }
  const indexPath = path.join(__dirname, '..', 'plugin', 'viewer', 'index.html');
  const fileUrl = url.pathToFileURL(indexPath).href;

  const browser = await openBrowser({ width: 1100, height: 800 });
  try {
    await browser.goto(fileUrl, 500);

    check('V0 the page runs entirely from file://, with no server', (await browser.eval('location.protocol')) === 'file:');
    check('V1 no console error or thrown exception while booting', browser.problems.length === 0, browser.problems.join(' | '));
    check('V2 the title is set (i18n loaded, no fetch needed)', (await browser.eval('document.title')) === 'task-flow viewer');
    const buttonText = await browser.eval('document.querySelector(".btn")?.textContent');
    check('V3 the folder-picker button is drawn (all classic scripts loaded and wired)', buttonText === 'Choose the task-flow folder…', buttonText);
    check('V4 file:// counts as a secure context here (required for showDirectoryPicker)', await browser.eval('window.isSecureContext === true'));
    check('V5 the File System Access API is present in this browser', await browser.eval('"showDirectoryPicker" in window'));
    check('V6 the pure feed-logic module attached to window.TFV with no globals missing', await browser.eval(
      'typeof window.TFV.parseFeed === "function" && typeof window.TFV.cardsFor === "function" && typeof window.TFV.checkOutgoingAnswers === "function"'
    ));

    // A feed straight out of parseFeed, drawn by renderHome with no folder at all -
    // proves the render path end to end without needing the real picker.
    const rows = await browser.eval(`(() => {
      const feed = window.TFV.parseFeed(JSON.stringify({
        version: 1, projectKey: "abc123abc123abcd", projectDir: "C:/proj", projectName: "Demo",
        runs: [{ slug: "run-a", phase: "build", status: "running", buildCursor: "T2", tasks: [{id:"T1",title:"a",done:true},{id:"T2",title:"b",done:false}] }],
      }), "abc123abc123abcd");
      document.getElementById("app").replaceChildren();
      window.TFV.renderHome(document.getElementById("app"), { projects: window.TFV.projectsView([feed]), t: (k, v) => k + JSON.stringify(v||{}), go: () => {} });
      return [...document.querySelectorAll(".run-row")].map((r) => r.dataset.slug);
    })()`);
    check('V7 renderHome draws a run parsed straight from a feed object', JSON.stringify(rows) === JSON.stringify(['run-a']), JSON.stringify(rows));

    const cardsAndRun = await browser.eval(`(() => {
      const feed = window.TFV.parseFeed(JSON.stringify({
        version: 1, projectKey: "abc123abc123abcd", projectDir: "C:/proj", projectName: "Demo",
        runs: [{ slug: "run-a", status: "blocked", questions: { source: "json", items: [
          { id: "Q1", kind: "question", title: "Pick one", options: [{id:"a",label:"A"},{id:"b",label:"B"}] },
        ] } }],
      }), "abc123abc123abcd");
      return JSON.stringify(window.TFV.cardsFor(feed.runs[0]));
    })()`);
    const cards = JSON.parse(cardsAndRun);
    check('V8 cardsFor turns a questions.json item into a card the run view can draw', cards.length === 1 && cards[0].id === 'Q1' && cards[0].open === true, cardsAndRun);

    const validated = await browser.eval(`(() => {
      const cardsById = new Map([["Q1", ${cardsAndRun}[0]]]);
      const ok = window.TFV.checkOutgoingAnswers([{ questionId: "Q1", status: "ok", choice: "a" }], cardsById);
      const bad = window.TFV.checkOutgoingAnswers([{ questionId: "Q1", status: "ok", choice: "not-an-option" }], cardsById);
      return JSON.stringify({ ok: ok.ok, badOk: bad.ok, badWhy: bad.why });
    })()`);
    const v = JSON.parse(validated);
    check('V9 checkOutgoingAnswers accepts a real option and refuses a fabricated one', v.ok === true && v.badOk === false && /options/.test(v.badWhy), validated);
  } finally {
    await browser.close();
  }

  const total = passed + failures.length;
  console.log(`\n${passed}/${total} passed`);
  if (failures.length) {
    console.log(`${failures.length} failing:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
})();
