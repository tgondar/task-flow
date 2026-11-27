#!/usr/bin/env node
// Tests for plugin/scripts/standing-answers.js - the one reader of a project's
// standing-answers page (<docsDir>/standing-answers.md).
//
// Most of these are security tests. The page sits in the docs folder, which can
// come with the repository, and what this reader accepts ends up in front of
// every subagent of a run (the SubagentStart hook, T4). So the cases that matter
// are the ones where the page, or the path to it, tries to be something it is
// not: a link or junction that points somewhere else, a folder or a pipe in its
// place, a file too big to read in a hook, a docsDir nobody trusted, a line that
// hides control or bidirectional characters, an entry that sends the reader to a
// URL or a network share, or text that forges the data block's own delimiters or
// a checklist item. And in every one of them the reader's report names a line
// number, an id or a field - never the text it refused.
//
// Run: node tests/standing-answers.test.js

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

const { loadConfig, trustDocsDir } = require('../plugin/scripts/config.js');
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

/** A project with its docs folder outside it, trusted; `page` (if given) is
 *  written as standing-answers.md in that folder. */
function project(page, { trusted = true, docsInside = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-standing-'));
  const projectDir = path.join(root, 'project');
  const docsDir = docsInside ? path.join(projectDir, 'docs') : path.join(root, 'notes');
  fs.mkdirSync(path.join(docsDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'tasks', 'index.md'), '# Tasks\n');
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.claude', 'task-flow.json'),
    JSON.stringify({ docsDir, language: 'EN', tasksFile: 'tasks/index.md' })
  );
  if (trusted && !docsInside) trustDocsDir(projectDir, docsDir);
  const pageFile = path.join(docsDir, 'standing-answers.md');
  if (page !== undefined) fs.writeFileSync(pageFile, page);
  return { root, projectDir, docsDir, pageFile };
}

const entry = (n, rule = `Rule number ${n}`, words = `words ${n}`, extra = '') =>
  `- **R${n}** · ${rule} · «${words}» · some-run · 2026-11-20${extra}`;

const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: process.env });

/** Every text the reader produced for this page, in one string - for the
 *  "nothing refused is ever echoed" assertions. */
const everything = (result) => JSON.stringify(result) + '\n' + sa.formatBlock(result);

// --- a page that is fine ------------------------------------------------------

check('a valid page gives its entries, with every field', () => {
  const page = [
    '# Standing answers',
    '',
    'Answers that stay true for every run of this project.',
    '<!-- task-flow: next R4 -->',
    entry(1),
    entry(2, 'Prices are in EUR', 'always euros'),
    entry(3, 'Use the new API', 'the old one is gone', ' · substitui R1'),
    '',
  ].join('\n');
  const p = project(page);
  const r = sa.read({ projectDir: p.projectDir });
  assertEqual(r.refused, undefined, 'refused');
  assertEqual(r.rejected, [], 'rejected');
  assertEqual(r.suspicious, [], 'suspicious');
  assertEqual(r.truncated, false, 'truncated');
  assertEqual(r.entries.map((e) => e.id), ['R1', 'R2', 'R3'], 'ids');
  assertEqual(r.entries[1], { id: 'R2', rule: 'Prices are in EUR', words: 'always euros', run: 'some-run', date: '2026-11-20' }, 'R2');
  assertEqual(r.entries[2].replaces, 'R1', 'R3 replaces');
});

check('"replaces R<m>" is accepted as well as "substitui R<m>"', () => {
  const p = project(entry(5, 'A', 'b', ' · replaces R2') + '\n');
  const r = sa.read({ projectDir: p.projectDir });
  assertEqual(r.entries.map((e) => [e.id, e.replaces]), [['R5', 'R2']], 'entries');
});

check('a BOM and CRLF line endings are tolerated', () => {
  const p = project('\uFEFF# Standing answers\r\n' + entry(1) + '\r\n' + entry(2) + '\r\n');
  const r = sa.read({ projectDir: p.projectDir });
  assertEqual(r.entries.map((e) => e.id), ['R1', 'R2'], 'ids');
  assertEqual(r.entries[1].date, '2026-11-20', 'no \\r left in the last field');
  assertEqual(r.rejected, [], 'rejected');
});

check('FR-038 no page: an empty result, nothing refused', () => {
  const p = project(undefined);
  const r = sa.read({ projectDir: p.projectDir });
  assertEqual(r, { entries: [], rejected: [], suspicious: [], truncated: false }, 'result');
});

check('FR-038 no page: the CLI says so in one line and exits 0', () => {
  const p = project(undefined);
  const out = cli('read', '--project-dir', p.projectDir);
  assertEqual(out.status, 0, 'exit');
  assert(!/<<<STANDING-ANSWERS/.test(out.stdout), 'no block without a page');
  assertEqual(out.stdout.trim().split('\n').length, 1, 'one line');
});

// --- malformed lines ------------------------------------------------------------

check('a malformed line is ignored and counted by its number; the others go on', () => {
  const page = ['# Title', entry(1), '- **R2** this is not the format', entry(3), 'plain text', ''].join('\n');
  const p = project(page);
  const r = sa.read({ projectDir: p.projectDir });
  assertEqual(r.entries.map((e) => e.id), ['R1', 'R3'], 'ids');
  assertEqual(r.rejected.map((x) => x.line), [3], 'rejected lines');
  assert(typeof r.rejected[0].why === 'string' && r.rejected[0].why, 'a reason');
});

check('lines that are not entries (title, prose, control line, other list items) are not rejected', () => {
  const page = ['# Standing answers', 'Intro text.', '<!-- task-flow: next R9 -->', '- a normal list item', '- **bold** item', '* **R1** star bullet', ''].join('\n');
  const p = project(page);
  const r = sa.read({ projectDir: p.projectDir });
  assertEqual(r.entries, [], 'entries');
  assertEqual(r.rejected, [], 'rejected');
});

const badLines = {
  'a field missing': '- **R1** · Rule · «words» · some-run',
  'a field too many': '- **R1** · Rule · «words» · some-run · 2026-11-20 · substitui R2 · more',
  'words without the quotes': '- **R1** · Rule · words · some-run · 2026-11-20',
  'an empty rule': '- **R1** ·  · «words» · some-run · 2026-11-20',
  'empty words': '- **R1** · Rule · «» · some-run · 2026-11-20',
  'a quote mark inside the rule': '- **R1** · Rule « inside · «words» · some-run · 2026-11-20',
  'a run that climbs out': '- **R1** · Rule · «words» · ../x · 2026-11-20',
  'a date that is not yyyy-MM-dd': '- **R1** · Rule · «words» · some-run · 20-11-2026',
  'a date that does not exist': '- **R1** · Rule · «words» · some-run · 2026-13-40',
  'an id R0': '- **R0** · Rule · «words» · some-run · 2026-11-20',
  'an id with a leading zero': '- **R01** · Rule · «words» · some-run · 2026-11-20',
  'a replaces tail in another shape': '- **R1** · Rule · «words» · some-run · 2026-11-20 · overrides R2',
  'no space after the separator': '- **R1** ·Rule · «words» · some-run · 2026-11-20',
};
for (const [what, line] of Object.entries(badLines)) {
  check(`rejected: ${what}`, () => {
    const p = project(['# T', line, entry(7), ''].join('\n'));
    const r = sa.read({ projectDir: p.projectDir });
    assertEqual(r.rejected.map((x) => x.line), [2], 'rejected lines');
    assertEqual(r.entries.map((e) => e.id), ['R7'], 'the next entry still read');
  });
}

check('a field over the limit rejects the line - it is never cut', () => {
  const long = 'x'.repeat(sa.LIMITS.fieldChars + 1);
  const p = project([entry(1, long), entry(2, 'ok', long), entry(3, 'x'.repeat(sa.LIMITS.fieldChars)), ''].join('\n'));
  const r = sa.read({ projectDir: p.projectDir });
  assertEqual(r.rejected.map((x) => x.line), [1, 2], 'rejected lines');
  assert(/rule/.test(r.rejected[0].why) && /words/.test(r.rejected[1].why), `the why names the field: ${JSON.stringify(r.rejected)}`);
  assertEqual(r.entries.map((e) => [e.id, e.rule.length]), [['R3', sa.LIMITS.fieldChars]], 'exactly at the limit is fine');
});

check('a repeated id is rejected; the first one stays', () => {
  const p = project([entry(1, 'first'), entry(1, 'second'), ''].join('\n'));
  const r = sa.read({ projectDir: p.projectDir });
  assertEqual(r.entries.map((e) => e.rule), ['first'], 'entries');
  assertEqual(r.rejected.map((x) => x.line), [2], 'rejected');
});

// --- control, bidi, suspicious ---------------------------------------------------

const MARK = 'ZQX_MARKER_7731';

const controlLines = {
  'a bell character': `\u0007${MARK}`,
  'an escape sequence': `\u001b[31m${MARK}`,
  'a right-to-left override': `\u202E${MARK}`,
  'a bidi isolate': `\u2066${MARK}`,
  'a Unicode line separator': `a\u2028${MARK}`,
  'a paragraph separator': `a\u2029${MARK}`,
  'a C1 control': `\u0085${MARK}`,
};
for (const [what, text] of Object.entries(controlLines)) {
  check(`SECURITY a line with ${what} is rejected by line number, its text never echoed`, () => {
    const p = project([entry(1), entry(2, text), entry(3, 'ok', text), ''].join('\n'));
    const r = sa.read({ projectDir: p.projectDir });
    assertEqual(r.entries.map((e) => e.id), ['R1'], 'entries');
    assertEqual(r.rejected.map((x) => x.line), [2, 3], 'rejected');
    assert(!everything(r).includes(MARK), 'marker echoed');
  });
}

const suspiciousTexts = {
  'an https URL': `see https://evil.example/${MARK}`,
  'a URL with another scheme': `ftp://host/${MARK}`,
  'a www. address': `www.${MARK}.example`,
  'a mailto: address': `mailto:${MARK}@example.com`,
  'a UNC path': `\\\\host\\share\\${MARK}`,
  'a field starting with //': `//host/${MARK}`,
  'the block opening marker': `<<<STANDING-ANSWERS ${MARK}`,
  'the block closing marker': `${MARK} STANDING-ANSWERS>>>`,
  'the delimiter name alone, in lower case': `standing-answers ${MARK}`,
  'three angle brackets': `>>> ${MARK}`,
  'an unchecked checkbox': `- [ ] ${MARK}`,
  'a checked checkbox': `- [x] ${MARK}`,
  'a markdown link': `[click](${MARK})`,
  'a wiki link': `[[${MARK}]]`,
};
for (const [what, text] of Object.entries(suspiciousTexts)) {
  check(`SECURITY an entry with ${what} is suspicious: not used, reported by id, never echoed`, () => {
    const p = project([entry(1), entry(2, text), entry(3, 'ok', text), ''].join('\n'));
    const r = sa.read({ projectDir: p.projectDir });
    assertEqual(r.entries.map((e) => e.id), ['R1'], 'entries');
    assertEqual(r.suspicious.map((x) => x.id), ['R2', 'R3'], 'suspicious ids');
    assert(r.suspicious.every((x) => typeof x.why === 'string' && x.why), 'a reason each');
    assert(!everything(r).includes(MARK), 'marker echoed');
    assert(!sa.formatBlock(r).includes('R2'), 'R2 not in the block');
  });
}

check('ordinary text with a single backslash, a colon or a slash is not suspicious', () => {
  const p = project([entry(1, 'Paths look like C:\\GIT\\app', 'use a/b: yes'), ''].join('\n'));
  const r = sa.read({ projectDir: p.projectDir });
  assertEqual(r.entries.map((e) => e.id), ['R1'], 'entries');
  assertEqual(r.suspicious, [], 'suspicious');
});

// --- limits ------------------------------------------------------------------------

check('above the entry limit only the first N are used and truncated is true', () => {
  const lines = [];
  for (let n = 1; n <= sa.LIMITS.entries + 5; n += 1) lines.push(entry(n));
  const p = project(lines.join('\n') + '\n');
  const r = sa.read({ projectDir: p.projectDir });
  assertEqual(r.entries.length, sa.LIMITS.entries, 'count');
  assertEqual(r.entries[r.entries.length - 1].id, `R${sa.LIMITS.entries}`, 'the first N');
  assertEqual(r.truncated, true, 'truncated');
});

check('exactly at the entry limit is not truncated', () => {
  const lines = [];
  for (let n = 1; n <= sa.LIMITS.entries; n += 1) lines.push(entry(n));
  const r = sa.read({ projectDir: project(lines.join('\n') + '\n').projectDir });
  assertEqual([r.entries.length, r.truncated], [sa.LIMITS.entries, false], 'count, truncated');
});

check('SECURITY a page over the size limit is refused without its text', () => {
  const big = entry(1, MARK) + '\n' + '#'.repeat(sa.LIMITS.pageBytes) + '\n';
  const p = project(big);
  const r = sa.read({ projectDir: p.projectDir });
  assert(typeof r.refused === 'string' && /size|bytes|larger/i.test(r.refused), `refused: ${r.refused}`);
  assertEqual(r.entries, [], 'entries');
  assert(!everything(r).includes(MARK), 'marker echoed');
});

// --- the path to the page --------------------------------------------------------

check('SECURITY a folder in place of the page is refused', () => {
  const p = project(undefined);
  fs.mkdirSync(p.pageFile);
  const r = sa.read({ projectDir: p.projectDir });
  assert(typeof r.refused === 'string' && r.refused, 'refused');
  assertEqual(r.entries, [], 'entries');
});

check('SECURITY the CLI says a refused page in one line and exits 0 (the run does not stop)', () => {
  const p = project(undefined);
  fs.mkdirSync(p.pageFile);
  const out = cli('read', '--project-dir', p.projectDir);
  assertEqual(out.status, 0, 'exit');
  assert(/refused/i.test(out.stdout), `says refused: ${out.stdout}`);
  assert(!/<<<STANDING-ANSWERS/.test(out.stdout), 'no block');
});

(() => {
  const name = 'SECURITY a junction in place of the page is refused, without saying where it points';
  const p = project(undefined);
  const elsewhere = path.join(p.root, `elsewhere-${MARK}`);
  fs.mkdirSync(elsewhere);
  try {
    fs.symlinkSync(elsewhere, p.pageFile, 'junction');
  } catch (error) {
    return skip(name, `junction could not be created: ${error.code}`);
  }
  check(name, () => {
    const r = sa.read({ projectDir: p.projectDir });
    assert(typeof r.refused === 'string' && /link|junction/i.test(r.refused), `refused: ${r.refused}`);
    assert(!everything(r).includes(MARK), 'the link target is named');
    const out = cli('read', '--project-dir', p.projectDir);
    assert(out.status === 0 && !(out.stdout + out.stderr).includes(MARK), `cli: ${out.status} ${out.stdout} ${out.stderr}`);
  });
})();

(() => {
  const name = 'SECURITY a file symlink in place of the page is refused, and the target is not read';
  const p = project(undefined);
  const target = path.join(p.root, 'outside.md');
  fs.writeFileSync(target, entry(1, 'from outside') + '\n');
  try {
    fs.symlinkSync(target, p.pageFile, 'file');
  } catch (error) {
    return skip(name, `file symlink could not be created (${error.code}; needs Developer Mode or admin on Windows)`);
  }
  check(name, () => {
    const r = sa.read({ projectDir: p.projectDir });
    assert(typeof r.refused === 'string' && /link|junction/i.test(r.refused), `refused: ${r.refused}`);
    assertEqual(r.entries, [], 'entries');
  });
})();

(() => {
  const name = 'SECURITY a FIFO in place of the page is refused without opening it';
  if (process.platform === 'win32') return skip(name, 'no FIFOs on Windows');
  const p = project(undefined);
  const made = spawnSync('mkfifo', [p.pageFile]);
  if (made.status !== 0) return skip(name, 'mkfifo is not available');
  check(name, () => {
    // Opening a FIFO for reading blocks until a writer comes: a child with a
    // timeout proves the reader refused it from lstat, without opening it.
    const out = spawnSync(process.execPath, [SCRIPT, 'read', '--project-dir', p.projectDir], { encoding: 'utf8', env: process.env, timeout: 10000 });
    assert(out.status === 0 && /refused/i.test(out.stdout), `cli: ${out.status} ${out.signal} ${out.stdout}`);
  });
})();

(() => {
  const name = 'SECURITY a docsDir that is a junction inside the project is refused, and the page behind it is not read';
  const p = project(undefined, { docsInside: true });
  const realDocs = path.join(p.root, 'real-docs');
  fs.renameSync(path.join(p.projectDir, 'docs'), realDocs);
  fs.writeFileSync(path.join(realDocs, 'standing-answers.md'), entry(1, 'behind a junction') + '\n');
  try {
    fs.symlinkSync(realDocs, path.join(p.projectDir, 'docs'), 'junction');
  } catch (error) {
    return skip(name, `junction could not be created: ${error.code}`);
  }
  check(name, () => {
    const r = sa.read({ projectDir: p.projectDir });
    assert(typeof r.refused === 'string' && /docsDir/.test(r.refused), `refused: ${r.refused}`);
    assertEqual(r.entries, [], 'entries');
  });
})();

/** Runs `fn` with every fs call that takes a path recorded, to prove a folder
 *  was never even stat-ed. */
function recordingFs(fn) {
  const touched = [];
  const names = ['lstatSync', 'statSync', 'openSync', 'readFileSync', 'existsSync', 'readdirSync', 'accessSync', 'realpathSync'];
  const saved = {};
  for (const name of names) {
    saved[name] = fs[name];
    fs[name] = function recorded(target, ...rest) {
      touched.push(String(target));
      return saved[name].call(fs, target, ...rest);
    };
  }
  try {
    return { value: fn(), touched };
  } finally {
    for (const name of names) fs[name] = saved[name];
  }
}

check('SECURITY an untrusted docsDir outside the project is refused and never even stat-ed', () => {
  const p = project(entry(1, 'from an untrusted folder') + '\n', { trusted: false });
  const { value: r, touched } = recordingFs(() => sa.read({ projectDir: p.projectDir }));
  assert(typeof r.refused === 'string' && /docsDir/.test(r.refused), `refused: ${r.refused}`);
  assertEqual(r.entries, [], 'entries');
  const fold = (s) => path.resolve(s).toLowerCase();
  const hits = touched.filter((t) => fold(t).startsWith(fold(p.docsDir)));
  assertEqual(hits, [], 'paths under the untrusted docsDir that were touched');
  assert(!r.refused.includes(p.docsDir), 'the refusal does not repeat the path');
});

check('SECURITY readPage with a network or device docsDir refuses without touching the disk', () => {
  for (const docsDir of ['\\\\host\\share\\notes', '//host/share/notes', '\\\\?\\C:\\notes', '\\\\.\\pipe\\x']) {
    const { value: r, touched } = recordingFs(() => sa.readPage({ docsDir }));
    assert(typeof r.refused === 'string', `refused for ${docsDir}`);
    assertEqual(touched, [], `fs calls for ${docsDir}`);
  }
});

check('SECURITY readPage without an accepted docsDir refuses (relative, missing, not a string)', () => {
  for (const config of [null, {}, { docsDir: 'notes' }, { docsDir: 42 }]) {
    const r = sa.readPage(config);
    assert(typeof r.refused === 'string', `refused for ${JSON.stringify(config)}`);
  }
});

check('SECURITY the page name is fixed: a config field cannot move it', () => {
  const p = project(undefined);
  const raw = JSON.parse(fs.readFileSync(path.join(p.projectDir, '.claude', 'task-flow.json'), 'utf8'));
  raw.standingAnswers = '../elsewhere.md';
  raw.standingAnswersFile = '../elsewhere.md';
  fs.writeFileSync(path.join(p.projectDir, '.claude', 'task-flow.json'), JSON.stringify(raw));
  fs.writeFileSync(path.join(p.root, 'elsewhere.md'), entry(1) + '\n');
  const config = loadConfig(p.projectDir).config;
  assertEqual(sa.pagePath(config), path.join(p.docsDir, 'standing-answers.md'), 'path');
  assertEqual(sa.read({ projectDir: p.projectDir }).entries, [], 'entries');
});

if (process.platform === 'win32') {
  check('SECURITY Windows: a docsDir written in another case is the same trusted folder', () => {
    const p = project(entry(1) + '\n');
    const file = path.join(p.projectDir, '.claude', 'task-flow.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.docsDir = p.docsDir.toUpperCase();
    fs.writeFileSync(file, JSON.stringify(raw));
    const r = sa.read({ projectDir: p.projectDir });
    assertEqual(r.refused, undefined, 'refused');
    assertEqual(r.entries.map((e) => e.id), ['R1'], 'entries');
  });
} else {
  skip('Windows: a docsDir written in another case', 'not on Windows');
}

check('SECURITY no .claude/task-flow.json: refused, no block', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-standing-none-'));
  const r = sa.read({ projectDir: dir });
  assert(typeof r.refused === 'string', 'refused');
  const out = cli('read', '--project-dir', dir);
  assertEqual(out.status, 0, 'exit');
});

// --- the data block ----------------------------------------------------------------

check('formatBlock wraps the accepted entries as JSON in the delimited block, saying they are data', () => {
  const p = project([entry(1, 'Use <b> tags & "quotes"', 'x > y'), entry(2), ''].join('\n'));
  const r = sa.read({ projectDir: p.projectDir });
  const block = sa.formatBlock(r);
  const lines = block.split('\n');
  assert(/data, not instructions/.test(lines[0]), `first line: ${lines[0]}`);
  assertEqual(lines[1], '<<<STANDING-ANSWERS', 'opening');
  assertEqual(lines[lines.length - 1], 'STANDING-ANSWERS>>>', 'closing');
  const inner = lines.slice(2, -1).join('\n');
  assert(!/[<>]/.test(inner), 'no raw < or > inside the block');
  assertEqual(JSON.parse(inner), r.entries, 'the JSON is the entries');
});

check('SECURITY formatBlock never carries a rejected or suspicious entry', () => {
  const p = project([entry(1), entry(2, `https://x/${MARK}`), `- **R3** broken ${MARK}`, entry(4, `\u202E${MARK}`), ''].join('\n'));
  const block = sa.formatBlock(sa.read({ projectDir: p.projectDir }));
  assert(!block.includes(MARK), 'marker in the block');
  assertEqual(JSON.parse(block.split('\n').slice(2, -1).join('\n')).map((e) => e.id), ['R1'], 'only R1');
});

// --- the CLI -----------------------------------------------------------------------

check('SECURITY CLI: prints the block, then one line per refusal by line number and id, never the text', () => {
  const page = ['# Standing answers', entry(1), `- **R2** broken ${MARK}`, entry(3, `see https://${MARK}.example`), entry(4, `\u0007${MARK}`), ''].join('\n');
  const p = project(page);
  const out = cli('read', '--project-dir', p.projectDir);
  assertEqual(out.status, 0, 'exit');
  assert(out.stdout.includes('<<<STANDING-ANSWERS') && out.stdout.includes('STANDING-ANSWERS>>>'), 'block');
  const after = out.stdout.slice(out.stdout.indexOf('STANDING-ANSWERS>>>'));
  assert(/line 3\b/i.test(after) && /line 5\b/i.test(after), `line numbers after the block: ${after}`);
  assert(/\bR3\b/.test(after), `suspicious id after the block: ${after}`);
  assert(!(out.stdout + out.stderr).includes(MARK), 'marker echoed');
});

check('CLI: an unknown command is a usage error (exit 2)', () => {
  const out = cli('write');
  assertEqual(out.status, 2, 'exit');
});

// --- report ------------------------------------------------------------------------

const total = passed + failures.length;
process.stdout.write(`\n${passed}/${total} passed\n`);
if (failures.length) {
  process.stdout.write(`${failures.length} failing:\n`);
  for (const f of failures) process.stdout.write(`  - ${f.name}\n`);
  process.exit(1);
}
