#!/usr/bin/env node
// Tests for `promote` in plugin/scripts/standing-answers.js - the one writer of
// a project's standing-answers page (<docsDir>/standing-answers.md).
//
// Most of these are security tests. What `promote` writes goes in front of
// every subagent of every later run, so the writer is held to three things:
//   - It writes only from an answer the person gave and the run recorded: an
//     item of this run's questions.json with an `answer` that carries the
//     person's own words (a comment, or the label of the option they chose). A
//     decision the run took alone, a bare "ok", an unknown id, another run's
//     file, an item already promoted - refused, exit code not 0, nothing written.
//   - What it writes parses back through the reader as an accepted entry. Text
//     the reader would refuse or flag (control, bidi, invisible, a URL, a
//     forged delimiter, the format's own separators, over a limit) is refused
//     before a byte is written, and the refusal names the field, never the text.
//   - It never loses or rewrites what is already there: other lines stay byte
//     for byte, an id is never given twice (also after a line was deleted by
//     hand), a page that changed under it is re-read rather than overwritten,
//     and the page is never written through a link, into a folder, or into a
//     docsDir nobody trusted.
//
// Run: node tests/standing-answers.promote.test.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The trust list lives in the home folder: these tests get a home of their own,
// so they never read or write the real one; child processes inherit it.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.LOCALAPPDATA = TEST_HOME;
process.env.XDG_STATE_HOME = TEST_HOME;

const { trustDocsDir } = require('../plugin/scripts/config.js');
const SCRIPT = path.join(__dirname, '..', 'plugin', 'scripts', 'standing-answers.js');
const sa = require(SCRIPT);

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok    ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL  ${name}\n        ${error.message}\n`);
  }
}

const skip = (name, why) => process.stdout.write(`  skip  ${name} (${why})\n`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const AT = '2026-11-27T12:00:00Z';
const MARK = 'ZQX_PROMOTE_5521';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** A run's questions: Q1 answered with a comment, Q2 a decision answered by
 *  choosing an option (no comment), Q3 a bare "ok", Q4 a decision nobody
 *  answered, Q5 a comment that is only blanks. */
function questions(slug, overrides = {}) {
  return {
    version: 1,
    slug,
    created: '2026-11-27',
    items: [
      { id: 'Q1', kind: 'question', title: 'Currency?', answer: { status: 'ok', comment: 'Always euros, in every project run.', via: 'conversation', at: AT } },
      {
        id: 'Q2',
        kind: 'decision',
        title: 'Where the cache lives',
        chosen: 'THE RUN CHOSE THIS TEXT',
        options: [{ id: 'redis', label: 'Redis', chosen: true }, { id: 'mem', label: 'In-process memory' }],
        answer: { status: 'modify', choice: 'mem', via: 'panel', at: AT },
      },
      { id: 'Q3', kind: 'decision', title: 'Go on?', chosen: 'Go on', answer: { status: 'ok', via: 'conversation', at: AT } },
      { id: 'Q4', kind: 'decision', title: 'Alone', chosen: 'Decided alone', answer: null },
      { id: 'Q5', kind: 'question', title: 'Blank', answer: { status: 'ok', comment: '   ', via: 'conversation', at: AT } },
    ],
    ...overrides,
  };
}

/** A project with its docs folder outside it, trusted, and one run folder with
 *  a questions.json. `page` (if given) is written as standing-answers.md. */
function project({ page, language = 'EN', slug = 'demo-run', data, trusted = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-promote-'));
  const projectDir = path.join(root, 'project');
  const docsDir = path.join(root, 'notes');
  fs.mkdirSync(path.join(docsDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'tasks', 'index.md'), '# Tasks\n');
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.claude', 'task-flow.json'), JSON.stringify({ docsDir, language, tasksFile: 'tasks/index.md' }));
  if (trusted) trustDocsDir(projectDir, docsDir);
  const runDir = path.join(projectDir, '.claude', 'task-flow', slug);
  fs.mkdirSync(runDir, { recursive: true });
  const questionsFile = path.join(runDir, 'questions.json');
  fs.writeFileSync(questionsFile, JSON.stringify(data || questions(slug), null, 2) + '\n');
  const pageFile = path.join(docsDir, 'standing-answers.md');
  if (page !== undefined) fs.writeFileSync(pageFile, page);
  return { root, projectDir, docsDir, pageFile, questionsFile, slug };
}

const entry = (n, rule = `Rule number ${n}`, words = `words ${n}`, extra = '') =>
  `- **R${n}** · ${rule} · «${words}» · some-run · 2026-11-20${extra}`;

const read = (file) => (fs.existsSync(file) && fs.lstatSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null);
const itemOf = (p, id) => JSON.parse(fs.readFileSync(p.questionsFile, 'utf8')).items.find((item) => item.id === id);
const promote = (p, args) => sa.promote({ projectDir: p.projectDir, slug: p.slug, ...args });

/** Runs `fn`, expecting a refusal: it throws, and neither the page nor the
 *  questions.json changed. Returns the message. */
function refused(p, fn, label) {
  const page = read(p.pageFile);
  const qs = read(p.questionsFile);
  let message = null;
  try {
    fn();
  } catch (error) {
    message = error.message;
  }
  assert(message !== null, `${label}: not refused`);
  assertEqual(read(p.pageFile), page, `${label}: page changed`);
  assertEqual(read(p.questionsFile), qs, `${label}: questions.json changed`);
  const leftovers = fs.readdirSync(p.docsDir).filter((name) => name.endsWith('.tmp'));
  assertEqual(leftovers, [], `${label}: temp files left`);
  return message;
}

const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: process.env });

// --- writing from a recorded answer ---------------------------------------------

check('a comment becomes an entry: new id, rule, the words, the run, today; the item gets promotedAs', () => {
  const p = project();
  const result = promote(p, { item: 'Q1', rule: 'Prices are in EUR' });
  assertEqual([result.id, result.created], ['R1', true], 'result');
  const r = sa.read({ projectDir: p.projectDir });
  assertEqual(r.rejected, [], 'rejected');
  assertEqual(r.suspicious, [], 'suspicious');
  assertEqual(r.entries, [{ id: 'R1', rule: 'Prices are in EUR', words: 'Always euros, in every project run.', run: 'demo-run', date: today() }], 'entries');
  assertEqual(itemOf(p, 'Q1').promotedAs, 'R1', 'promotedAs');
  const page = read(p.pageFile);
  assert(/^# Standing answers$/m.test(page), `an English title: ${page}`);
  assert(page.includes('<!-- task-flow: next R2 -->'), `the next-id marker: ${page}`);
});

check('Q10 no comment: the words are "chose: <label of the chosen option>", never the decision\'s chosen text', () => {
  const p = project();
  promote(p, { item: 'Q2', rule: 'The cache is in process' });
  const [e] = sa.read({ projectDir: p.projectDir }).entries;
  assertEqual(e.words, 'chose: In-process memory', 'words');
  assert(!read(p.pageFile).includes('THE RUN CHOSE THIS TEXT'), 'the run\'s own text was written');
});

check('a pt-PT page: Portuguese title, "escolheu:", "substitui"', () => {
  const p = project({ language: 'PT-PT' });
  promote(p, { item: 'Q1', rule: 'Preços em EUR' });
  promote(p, { item: 'Q2', rule: 'Cache em memória', replaces: 'R1' });
  const page = read(p.pageFile);
  assert(/^# Respostas permanentes$/m.test(page), `a Portuguese title: ${page}`);
  assert(/«escolheu: In-process memory»/.test(page), `escolheu: ${page}`);
  assert(/ · substitui R1$/m.test(page), `substitui: ${page}`);
  assertEqual(sa.read({ projectDir: p.projectDir }).entries.map((e) => [e.id, e.replaces]), [['R2', 'R1']], 'entries');
});

check('a comment over several lines is written as one line, and reads back the same', () => {
  const data = questions('demo-run');
  data.items[0].answer.comment = 'Always euros.\nIn every run.\tNo exceptions.';
  const p = project({ data });
  promote(p, { item: 'Q1', rule: '  Prices\nare in EUR ' });
  const [e] = sa.read({ projectDir: p.projectDir }).entries;
  assertEqual([e.rule, e.words], ['Prices are in EUR', 'Always euros. In every run. No exceptions.'], 'fields');
});

// --- refusals: no recorded answer ------------------------------------------------

check('SECURITY a decision nobody answered is refused (no self-promotion)', () => {
  const p = project();
  const message = refused(p, () => promote(p, { item: 'Q4', rule: 'x' }), 'Q4');
  assert(/answer/.test(message), `names the answer: ${message}`);
});

check('SECURITY Q10 a status-only answer (a bare ok) is refused', () => {
  const p = project();
  const message = refused(p, () => promote(p, { item: 'Q3', rule: 'x' }), 'Q3');
  assert(/comment|choice|words/.test(message), `says why: ${message}`);
});

check('SECURITY a comment of blanks only, without a choice, is refused', () => {
  const p = project();
  refused(p, () => promote(p, { item: 'Q5', rule: 'x' }), 'Q5');
});

check('SECURITY an item that is not in the run is refused, and a malformed id too', () => {
  const p = project();
  for (const item of ['Q9', 'Q0', 'q1', '../Q1', '', undefined]) refused(p, () => promote(p, { item, rule: 'x' }), String(item));
});

check('SECURITY the same item promoted twice: the second is refused, the page keeps one entry', () => {
  const p = project();
  promote(p, { item: 'Q1', rule: 'Prices are in EUR' });
  const message = refused(p, () => promote(p, { item: 'Q1', rule: 'Prices are in EUR again' }), 'second');
  assert(/promoted/.test(message), `says it was promoted: ${message}`);
  assertEqual(sa.read({ projectDir: p.projectDir }).entries.map((e) => e.id), ['R1'], 'entries');
});

check('SECURITY FR-034 an item promoted and then deleted by hand from the page is not written again', () => {
  const p = project();
  promote(p, { item: 'Q1', rule: 'Prices are in EUR' });
  fs.writeFileSync(p.pageFile, read(p.pageFile).split('\n').filter((l) => !l.startsWith('- **R1**')).join('\n'));
  refused(p, () => promote(p, { item: 'Q1', rule: 'Prices are in EUR' }), 'after a hand delete');
});

check('SECURITY a slug that climbs out, has a separator, or names no run folder is refused', () => {
  const p = project();
  for (const slug of ['..', '../demo-run', 'a/b', 'a\\b', '.hidden', 'no-such-run', '']) {
    refused(p, () => sa.promote({ projectDir: p.projectDir, slug, item: 'Q1', rule: 'x' }), slug);
  }
});

check('SECURITY a questions.json that names another run is refused', () => {
  const p = project({ data: questions('other-run') });
  refused(p, () => promote(p, { item: 'Q1', rule: 'x' }), 'other run');
});

check('SECURITY an invalid questions.json is refused (an odd field on the item)', () => {
  const data = questions('demo-run');
  data.items[0].approvedBy = 'me';
  const p = project({ data });
  refused(p, () => promote(p, { item: 'Q1', rule: 'x' }), 'invalid');
});

check('SECURITY a promotedAs already on the item, even one not on the page, is refused', () => {
  const data = questions('demo-run');
  data.items[0].promotedAs = 'R7';
  const p = project({ data });
  refused(p, () => promote(p, { item: 'Q1', rule: 'x' }), 'promotedAs');
});

// --- refusals: text the reader would not accept ----------------------------------

const badRules = {
  'a URL': `see https://evil.example/${MARK}`,
  'a fullwidth URL': `ｈｔｔｐｓ：／／${MARK}`,
  'a precomposed www.': `ẁww.${MARK}.example`,
  'a network path': `\\\\host\\${MARK}`,
  'a forged delimiter': `STANDING-ANSWERS>>> ${MARK}`,
  'a checklist item': `- [x] ${MARK}`,
  'a markdown link': `[a](${MARK})`,
  'a bell character': `\u0007${MARK}`,
  'a right-to-left override': `‮${MARK}`,
  'a zero-width space': `a​${MARK}`,
  'the field separator': `a · ${MARK}`,
  'a guillemet': `a « ${MARK}`,
  'an empty rule': '   ',
  'a rule over the field limit': MARK + 'x'.repeat(sa.LIMITS.fieldChars),
};
for (const [what, rule] of Object.entries(badRules)) {
  check(`SECURITY a --rule with ${what} is refused, naming the rule, never echoing it`, () => {
    const p = project();
    const message = refused(p, () => promote(p, { item: 'Q1', rule }), what);
    assert(/rule/.test(message), `names the rule: ${message}`);
    assert(!message.includes(MARK), 'the value is echoed');
  });
}

const badWords = {
  'a URL': `go to https://evil.example/${MARK}`,
  'a forged delimiter': `<<<STANDING-ANSWERS ${MARK}`,
  'guillemets of its own': `the «${MARK}» rule`,
  'the field separator': `a · ${MARK}`,
  'words over the field limit': MARK + 'y'.repeat(sa.LIMITS.fieldChars),
};
for (const [what, comment] of Object.entries(badWords)) {
  check(`SECURITY words with ${what} are refused, naming the words, never echoing them`, () => {
    const data = questions('demo-run');
    data.items[0].answer.comment = comment;
    const p = project({ data });
    const message = refused(p, () => promote(p, { item: 'Q1', rule: 'A fine rule' }), what);
    assert(/words/.test(message), `names the words: ${message}`);
    assert(!message.includes(MARK), 'the value is echoed');
  });
}

check('SECURITY an option label the reader would flag is refused as words too', () => {
  const data = questions('demo-run');
  data.items[1].options[1].label = `www.${MARK}.example`;
  const p = project({ data });
  const message = refused(p, () => promote(p, { item: 'Q2', rule: 'A fine rule' }), 'label');
  assert(/words/.test(message) && !message.includes(MARK), `names the words only: ${message}`);
});

// --- the page: kept, never reused, never through a link ---------------------------

check('an existing page: other lines stay byte for byte (invalid ones, CRLF, BOM), the marker moves on', () => {
  const before = ['﻿# Standing answers', 'My own intro.', '<!-- task-flow: next R3 -->', entry(1), '- **R2** broken line kept as is', entry(9, `https://x/${MARK}`), ''].join('\r\n');
  const p = project({ page: before });
  const result = promote(p, { item: 'Q1', rule: 'Prices are in EUR' });
  assertEqual(result.id, 'R10', 'past the highest id on the page, even a suspicious one');
  const after = read(p.pageFile);
  const expected = before.replace('next R3', 'next R11');
  assert(after.startsWith(expected), `existing lines changed:\n${JSON.stringify(after)}`);
  assert(/^- \*\*R10\*\* · Prices are in EUR · «Always euros, in every project run\.» · demo-run · \d{4}-\d{2}-\d{2}\r\n$/.test(after.slice(expected.length)), `the new line, with the page's line ending: ${JSON.stringify(after.slice(expected.length))}`);
});

check('a page without a final line break gets one before the new entry', () => {
  const p = project({ page: `# T\n<!-- task-flow: next R2 -->\n${entry(1)}` });
  promote(p, { item: 'Q1', rule: 'Prices are in EUR' });
  assertEqual(sa.read({ projectDir: p.projectDir }).entries.map((e) => e.id), ['R1', 'R2'], 'entries');
});

check('FR-034 ids are never reused after a line is deleted by hand', () => {
  const p = project();
  promote(p, { item: 'Q1', rule: 'Rule one' });
  promote(p, { item: 'Q2', rule: 'Rule two' });
  fs.writeFileSync(p.pageFile, read(p.pageFile).split('\n').filter((l) => !l.startsWith('- **R2**')).join('\n'));
  const data = JSON.parse(read(p.questionsFile));
  data.items.push({ id: 'Q6', kind: 'question', title: 'More', answer: { status: 'ok', comment: 'Third rule words', via: 'conversation', at: AT } });
  fs.writeFileSync(p.questionsFile, JSON.stringify(data));
  assertEqual(promote(p, { item: 'Q6', rule: 'Rule three' }).id, 'R3', 'id');
});

check('a marker lowered by hand never gives an id that is on the page', () => {
  const p = project({ page: ['# T', '<!-- task-flow: next R2 -->', entry(1), entry(5), ''].join('\n') });
  assertEqual(promote(p, { item: 'Q1', rule: 'x y' }).id, 'R6', 'id');
  assert(read(p.pageFile).includes('<!-- task-flow: next R7 -->'), 'marker');
});

check('no marker on the page: highest + 1, said in the result, and the marker is added', () => {
  const p = project({ page: ['# T', entry(1), entry(3), ''].join('\n') });
  const result = promote(p, { item: 'Q1', rule: 'x y' });
  assertEqual([result.id, result.markerMissing], ['R4', true], 'result');
  assert(read(p.pageFile).includes('<!-- task-flow: next R5 -->'), 'marker added');
  const out = (() => {
    const q = project({ page: ['# T', entry(1), ''].join('\n') });
    return cli('promote', '--slug', q.slug, '--item', 'Q1', '--rule', 'x y', '--project-dir', q.projectDir);
  })();
  assertEqual(out.status, 0, `exit: ${out.stderr}`);
  assert(/marker/i.test(out.stdout), `says the marker was missing: ${out.stdout}`);
});

check('--replaces R1 takes R1 off the page and the new entry says it replaces it', () => {
  const p = project({ page: ['# T', '<!-- task-flow: next R3 -->', entry(1, 'old rule'), entry(2), ''].join('\n') });
  const result = promote(p, { item: 'Q1', rule: 'New rule', replaces: 'R1' });
  assertEqual([result.id, result.replaced], ['R3', 'R1'], 'result');
  assert(!read(p.pageFile).includes('old rule'), 'R1 still on the page');
  const r = sa.read({ projectDir: p.projectDir });
  assertEqual(r.entries.map((e) => [e.id, e.replaces || null]), [['R2', null], ['R3', 'R1']], 'entries');
  assertEqual(r.replaced, [], 'nothing left to report as replaced');
});

check('SECURITY --replaces of an id that is not an accepted entry is refused (absent, suspicious, replaced, malformed)', () => {
  const page = ['# T', '<!-- task-flow: next R4 -->', entry(1), entry(2, `https://x/${MARK}`), entry(3, 'new', 'w', ' · substitui R1'), ''].join('\n');
  for (const replaces of ['R7', 'R2', 'R1', 'R0', 'X1', '1', 'R1 · more']) {
    const p = project({ page });
    const message = refused(p, () => promote(p, { item: 'Q1', rule: 'x y', replaces }), replaces);
    assert(/replaces/.test(message) && !message.includes(MARK), `names --replaces: ${message}`);
  }
});

check('SECURITY a page whose entries are at the limit is refused: the new entry would not be used', () => {
  const lines = ['# T'];
  for (let n = 1; n <= sa.LIMITS.entries; n += 1) lines.push(entry(n));
  const p = project({ page: lines.join('\n') + '\n' });
  const message = refused(p, () => promote(p, { item: 'Q1', rule: 'x y' }), 'limit');
  assert(/limit|entries/.test(message), `says why: ${message}`);
});

check('SECURITY a page that the new entry would push over the size limit is refused', () => {
  const p = project({ page: '# T\n' + 'x'.repeat(sa.LIMITS.pageBytes - 50) + '\n' });
  refused(p, () => promote(p, { item: 'Q1', rule: 'A rule long enough to cross the limit' }), 'size');
});

check('SECURITY a page that is a folder is refused', () => {
  const p = project();
  fs.mkdirSync(p.pageFile);
  refused(p, () => promote(p, { item: 'Q1', rule: 'x y' }), 'folder');
});

(() => {
  const name = 'SECURITY a page that is a junction is refused, nothing written behind it, the target never named';
  const p = project();
  const elsewhere = path.join(p.root, `elsewhere-${MARK}`);
  fs.mkdirSync(elsewhere);
  try {
    fs.symlinkSync(elsewhere, p.pageFile, 'junction');
  } catch (error) {
    return skip(name, `junction could not be created: ${error.code}`);
  }
  check(name, () => {
    const message = refused(p, () => promote(p, { item: 'Q1', rule: 'x y' }), 'junction');
    assert(/link|junction/.test(message) && !message.includes(MARK), `message: ${message}`);
    assertEqual(fs.readdirSync(elsewhere), [], 'written behind the junction');
  });
})();

(() => {
  const name = 'SECURITY a file symlink in place of the page is refused and its target is not changed';
  const p = project();
  const target = path.join(p.root, 'outside.md');
  fs.writeFileSync(target, entry(1) + '\n');
  try {
    fs.symlinkSync(target, p.pageFile, 'file');
  } catch (error) {
    return skip(name, `file symlink could not be created (${error.code}; needs Developer Mode or admin on Windows)`);
  }
  check(name, () => {
    refused(p, () => promote(p, { item: 'Q1', rule: 'x y' }), 'symlink');
    assertEqual(read(target), entry(1) + '\n', 'target');
  });
})();

check('SECURITY an untrusted docsDir is refused: no page created, the folder never touched', () => {
  const p = project({ trusted: false });
  const touched = [];
  const names = ['lstatSync', 'statSync', 'openSync', 'readFileSync', 'writeFileSync', 'renameSync', 'existsSync', 'readdirSync'];
  const saved = {};
  for (const n of names) {
    saved[n] = fs[n];
    fs[n] = function recorded(target, ...rest) {
      touched.push(String(target));
      return saved[n].call(fs, target, ...rest);
    };
  }
  let message = null;
  try {
    promote(p, { item: 'Q1', rule: 'x y' });
  } catch (error) {
    message = error.message;
  } finally {
    for (const n of names) fs[n] = saved[n];
  }
  assert(message && /docsDir/.test(message), `refused: ${message}`);
  const fold = (s) => path.resolve(s).toLowerCase();
  assertEqual(touched.filter((t) => fold(t).startsWith(fold(p.docsDir))), [], 'paths under the untrusted docsDir');
  assert(!message.includes(p.docsDir), 'the path is repeated');
  assertEqual(read(p.pageFile), null, 'page');
});

// --- a second writer ---------------------------------------------------------------

/** Runs `fn` while every write of a temp file next to the page also appends a
 *  line to the page - another session writing between this one's read and its
 *  rename. `times` writes are disturbed, then the other writer stops. */
function withRivalWriter(p, times, fn) {
  const original = fs.writeFileSync;
  let left = times;
  let n = 100;
  fs.writeFileSync = function rival(target, ...rest) {
    const result = original.call(fs, target, ...rest);
    if (left > 0 && String(target).endsWith('.tmp') && path.dirname(String(target)) === p.docsDir) {
      left -= 1;
      n += 1;
      const now = fs.existsSync(p.pageFile) ? fs.readFileSync(p.pageFile, 'utf8') : '# T\n';
      original.call(fs, p.pageFile, now + entry(n, `rival ${n}`) + '\n');
    }
    return result;
  };
  try {
    return fn();
  } finally {
    fs.writeFileSync = original;
  }
}

check('SECURITY a page changed between read and rename is read again: both writes survive', () => {
  const p = project({ page: ['# T', '<!-- task-flow: next R2 -->', entry(1), ''].join('\n') });
  const result = withRivalWriter(p, 1, () => promote(p, { item: 'Q1', rule: 'Mine' }));
  const r = sa.read({ projectDir: p.projectDir });
  assert(r.entries.some((e) => e.rule === 'rival 101'), `the other writer's line was lost: ${read(p.pageFile)}`);
  assert(r.entries.some((e) => e.id === result.id && e.rule === 'Mine'), `this write is missing: ${read(p.pageFile)}`);
  assertEqual(result.id, 'R102', 'the id goes past the rival\'s');
  assertEqual(itemOf(p, 'Q1').promotedAs, result.id, 'promotedAs');
  assertEqual(fs.readdirSync(p.docsDir).filter((x) => x.endsWith('.tmp')), [], 'temp files left');
});

check('SECURITY a page that keeps changing is refused after 3 tries: the other writer\'s page stays, nothing marked', () => {
  const p = project({ page: ['# T', '<!-- task-flow: next R2 -->', entry(1), ''].join('\n') });
  let message = null;
  withRivalWriter(p, 99, () => {
    try {
      promote(p, { item: 'Q1', rule: 'Mine' });
    } catch (error) {
      message = error.message;
    }
  });
  assert(message && /changed/.test(message), `refused, saying why: ${message}`);
  const r = sa.read({ projectDir: p.projectDir });
  assertEqual(r.entries.map((e) => e.rule), ['Rule number 1', 'rival 101', 'rival 102', 'rival 103'], 'the rival\'s lines, none of mine');
  assertEqual(itemOf(p, 'Q1').promotedAs, undefined, 'promotedAs');
  assertEqual(fs.readdirSync(p.docsDir).filter((x) => x.endsWith('.tmp')), [], 'temp files left');
});

check('a page created by someone else while this one was writing a new page is not overwritten', () => {
  const p = project();
  const result = withRivalWriter(p, 1, () => promote(p, { item: 'Q1', rule: 'Mine' }));
  const r = sa.read({ projectDir: p.projectDir });
  assert(r.entries.some((e) => e.rule === 'rival 101') && r.entries.some((e) => e.rule === 'Mine'), read(p.pageFile));
  assertEqual(result.created, false, 'not "created" any more');
});

// --- the CLI -----------------------------------------------------------------------

check('SECURITY questions.json changed after the page write (answers.js consume) keeps that change: the write-back re-reads, no lost update', () => {
  const p = project();
  const original = fs.renameSync;
  fs.renameSync = function consume(from, to, ...rest) {
    const result = original.call(fs, from, to, ...rest);
    if (path.resolve(String(to)) === path.resolve(p.pageFile)) {
      const data = JSON.parse(fs.readFileSync(p.questionsFile, 'utf8'));
      data.items.find((x) => x.id === 'Q4').answer = { status: 'ok', comment: 'answered meanwhile', via: 'panel', at: AT };
      fs.writeFileSync(p.questionsFile, JSON.stringify(data, null, 2) + String.fromCharCode(10));
    }
    return result;
  };
  try {
    promote(p, { item: 'Q1', rule: 'Prices are in EUR' });
  } finally {
    fs.renameSync = original;
  }
  assertEqual(itemOf(p, 'Q1').promotedAs, 'R1', 'promotedAs');
  assertEqual((itemOf(p, 'Q4').answer || {}).comment, 'answered meanwhile', 'the other writer answer was lost');
  assertEqual(itemOf(p, 'Q2').chosen, 'THE RUN CHOSE THIS TEXT', 'other fields kept');
});

check('CLI promote: exit 0, names the id and the item, says the page was created; never echoes the words', () => {
  const data = questions('demo-run');
  data.items[0].answer.comment = `Always euros ${MARK}`;
  const p = project({ data });
  const out = cli('promote', '--slug', p.slug, '--item', 'Q1', '--rule', 'Prices are in EUR', '--project-dir', p.projectDir);
  assertEqual(out.status, 0, `exit: ${out.stderr}`);
  assert(/\bR1\b/.test(out.stdout) && /\bQ1\b/.test(out.stdout), `ids: ${out.stdout}`);
  assert(/created/i.test(out.stdout) && /index\.md/.test(out.stdout), `says it created the page: ${out.stdout}`);
  assert(!(out.stdout + out.stderr).includes(MARK), 'words echoed');
  assertEqual(itemOf(p, 'Q1').promotedAs, 'R1', 'promotedAs');
});

check('SECURITY CLI promote refused: exit code not 0, one line on stderr, the value never echoed', () => {
  const p = project();
  const out = cli('promote', '--slug', p.slug, '--item', 'Q1', '--rule', `https://${MARK}.example`, '--project-dir', p.projectDir);
  assert(out.status !== 0 && out.status !== null, `exit: ${out.status}`);
  assert(/rule/.test(out.stderr), `names the rule: ${out.stderr}`);
  assert(!(out.stdout + out.stderr).includes(MARK), 'value echoed');
  assertEqual(read(p.pageFile), null, 'page');
});

check('SECURITY CLI promote without --rule, --item or --slug: exit code not 0, nothing written', () => {
  const p = project();
  for (const args of [['--item', 'Q1', '--rule', 'x'], ['--slug', p.slug, '--rule', 'x'], ['--slug', p.slug, '--item', 'Q1']]) {
    const out = cli('promote', ...args, '--project-dir', p.projectDir);
    assert(out.status !== 0 && out.status !== null, `exit for ${args.join(' ')}: ${out.status}`);
  }
  assertEqual(read(p.pageFile), null, 'page');
});

// --- report ------------------------------------------------------------------------

const total = passed + failures.length;
process.stdout.write(`\n${passed}/${total} passed\n`);
if (failures.length) {
  process.stdout.write(`${failures.length} failing:\n`);
  for (const f of failures) process.stdout.write(`  - ${f.name}\n`);
  process.exit(1);
}
