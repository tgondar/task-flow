#!/usr/bin/env node
// Prose/code coherence for the pipeline's own rules (spec FR-013 of the
// standing-answers run).
//
// The rules of a run are prose in SKILL.md, and prose is what drifts: the
// security-harden/review ask of section 4c was removed on 2026-11-27 (the user
// answered "later" 19 times out of 20, and then decided both always run), and
// nothing but this file stops a later edit from quietly putting the question
// back, or the "one exception" to "no AskUserQuestion in an auto run" with it.
// This suite reads the repo's own files (no state, no network, no writes) and
// fails when that happens. It has no security surface of its own; the rule it
// guards is one: security-and-hardening can no longer be skipped in a local run.
//
// Run: node tests/skill-rules.docs.test.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const skillDir = path.join(ROOT, 'plugin', 'skills', 'task-flow');
const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
const history = fs.readFileSync(path.join(skillDir, 'HISTORY.md'), 'utf8');
const claudeMd = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

let passed = 0;
const failures = [];
function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
}

/** The text from a heading (`## 0b.`, `### 4c.`) to the next heading of the same or a higher level. */
function section(text, marks, headingStart) {
  const start = text.indexOf(`\n${marks} ${headingStart}`);
  if (start < 0) return '';
  const next = new RegExp(`\\n#{1,${marks.length}} `, 'g');
  next.lastIndex = start + 1;
  const m = next.exec(text);
  return text.slice(start, m ? m.index : undefined);
}

const s0b = section(skill, '##', '0b. ');
const s4c = section(skill, '###', '4c. ');
check('section 0b exists', s0b.length > 0);
check('section 4c exists', s4c.length > 0);

// FR-001: section 4c no longer asks; harden and the 4d review always run
check('section 4c does not use AskUserQuestion', !s4c.includes('AskUserQuestion'));
check('section 4c does not ask about harden/review', !/ask before (security-)?harden|check later|skip straight to the PR|planned stop/i.test(s4c));
check('section 4c runs security-and-hardening', s4c.includes('agent-skills:security-and-hardening'));
check('section 4c goes on to the 4d review', s4c.includes('§4d'));

// Security (T1): a resumed run cannot carry the old skip back in. A run
// blocked on the removed ask, or an old "later" answer in its questions file
// or log, must still go on to security-and-hardening; drop this sentence and
// a resumed run has nothing telling it so.
check('section 4c: a run resumed on the old ask does not ask it again', /does not ask it\s+again: it goes on to this step/.test(s4c));
check('section 4c: an old "later" answer does not skip the harden', /Nothing a resumed run carries[^.]*old "later"\s+answer in its questions file or its log[^.]*skips it either/.test(s4c));
check('SKILL.md has no "skip §4d" path left', !/skip §4d|passes were skipped/.test(skill));

// Q1: performance is never asked, in either mode; it runs on a named requirement only
check('SKILL.md has no performance ask', !/Yes, optimise|Sim, otimizar|performance ask/.test(skill));
check('section 4c runs performance only on a named requirement', /performance\s+requirement/.test(s4c) && /spec\s+or\s+the\s+plan/.test(s4c));
check('no section runs performance on the user\'s yes', !/user said yes in §4c|user's yes in §4c/.test(skill));

// FR-002: an auto run never uses AskUserQuestion, without exceptions
check('section 0b has no exception for AskUserQuestion', !/with one exception|is that exception|not waived/i.test(s0b));
check('section 0b says auto never uses AskUserQuestion', /`AskUserQuestion` is not used at all in an auto run/.test(s0b));

// FR-012: no file describes a planned stop any more
for (const [name, text] of [['SKILL.md', skill], ['CLAUDE.md', claudeMd], ['README.md', readme]]) {
  check(`${name} does not describe a planned stop`, !/planned stop/i.test(text));
}

// FR-012: the reason is recorded in a dated section of HISTORY.md
check('HISTORY.md has the dated inversion section',
  /\n## Security-harden and review always run; performance is not asked \(2026-11-27\)/.test(history));

// T2 (FR-009): three warnings are facts, not decisions, listed in ONE place.
// Before 2026-11-27 they were logged as decisions and went to the list to
// review, which is how the FleetManager ended up with 87 of 110 items waiting
// there. The paragraph must name exactly these three, their destination (the
// log without a warning marker, and the PR body's "Found") and the three
// places a fact never goes; drop one and this fails.
const s3 = section(skill, '##', '3. ');
const s4size = section(skill, '###', 'Task size');
const s5 = section(skill, '##', '5. ');
const s8b = section(skill, '##', '8b. ');
const s8c = section(skill, '##', '8c. ');
const factsStart = skill.indexOf('**Three warnings are facts, not decisions');
const facts = factsStart < 0 ? '' : skill.slice(factsStart, skill.indexOf('\n- **', factsStart + 1));
check('section 3 exists', s3.length > 0);
check('section 4 "Task size" exists', s4size.length > 0);
check('section 5 exists', s5.length > 0);
check('section 8b exists', s8b.length > 0);
check('section 8c exists', s8c.length > 0);
check('SKILL.md lists the three facts in one paragraph', facts.length > 0);
check('SKILL.md lists the facts only once', skill.indexOf('**Three warnings are facts, not decisions', factsStart + 1) < 0);
check('fact 1: performance not run (section 4c)', /\(1\)[^()]*performance[^]*§4c/.test(facts));
check('fact 2: the plan above the section 2c pre-estimate', /\(2\)[^]*pre-estimate[^]*§2c/.test(facts));
check('fact 3: how the tasks were split (Task size)', /\(3\)[^]*split[^]*"Task size"/.test(facts));
check('the facts are exactly three', !/\(4\)/.test(facts));
check('a fact goes to the log without a warning marker', /without a ⚠️ marker/.test(facts));
check('a fact goes under ## Found', facts.includes('`## Found`'));
check('a fact never goes to questions.json, ## Needs you or pendingDecisions',
  /never[^.]*`questions\.json`[^.]*`## Needs you`[^.]*`pendingDecisions`/.test(facts));
check('section 4 "Task size": a split is a fact, not a 🔹 entry', !/as 🔹/.test(s4size) && /fact/.test(s4size));
check('section 2c: a split is a fact, not a 🔹 entry', !/Record it as 🔹/.test(section(skill, '###', '2c. ')));
check('section 5: a plan above the pre-estimate is a fact', /pre-estimate[^.]*fact/.test(s5));
check('section 8b: ## Found carries the three facts', /\*\*`## Found`\*\*[^]*three facts/.test(s8b));
check('section 8c does not put performance under ## Needs you', !/performance/i.test(s8c));

// T2 (FR-010): a question a document closed stays in the log with its quote;
// only a question closed by the second opinion's agree is a decision to review.
// The quote is what keeps the document path checkable instead of a shortcut.
check('section 3: closed by a document goes to the log with the quote, not questions.json',
  /A document answers it explicitly\.\*\*\s+Quote it[^]*`_log\.md`[^]*not into `questions\.json`/.test(s3));
check('section 3: no quote in the log means it was not closed by a document', /no quoted passage[^.]*is not closed this way/.test(s3));
check('section 3: closed by agree is still a decision in questions.json',
  /`Verdict: agree`[^]*`questions\.json` as a `decision`/.test(s3));

// T2 security: the document path keeps a decision OFF the list to review, so
// "a document" must stay the closed list of sources step 1 names (a file merely
// sitting in docsDir is not one), and the log entry must name which document.
check('section 3 (security): the documents are the closed list of sources',
  /in this\s+order: the task's entry in the task list[^]*the idea; the spec;\s+the plan/.test(s3));
check('section 3 (security): the log entry names the document and the quote',
  /with the round, the document and the quoted passage/.test(s3));

// D1 security: the spec and the plan are on that list, but the run writes them
// itself, so a run could write its answer into its own spec, quote it and keep
// the decision off the list. Only a source this run did not write closes a
// question by document; a passage from its own spec or plan leaves it a decision.
const docStart = s3.indexOf('**A document answers it explicitly.**');
const docPath = docStart < 0 ? '' : s3.slice(docStart, s3.indexOf('\n- **', docStart));
check('section 3 (security): only a source this run did not write closes a question by document',
  /Only\s+a\s+passage\s+from\s+a\s+source\s+this\s+run\s+did\s+not\s+write\s+closes\s+it\s+this\s+way/.test(docPath));
check('section 3 (security): the sources that close it are the ones the run did not write',
  /task's\s+entry\s+in\s+the\s+task\s+list[^]*the\s+idea[^]*answered\s+decisions[^]*artifacts\s+of\s+earlier\s+runs/.test(docPath));
check('section 3 (security): this run\'s own spec or plan leaves it a decision in questions.json',
  /this\s+run's\s+own\s+spec\s+or\s+plan[^]*`questions\.json`\s+as\s+a\s+`decision`/.test(docPath));

// T2 (FR-011, Q2): every decision to review is listed in one place, questions.json;
// the _log.md keeps the full entry as the audit trail and cites Q<n>.
check('section 3: questions.json is the one list to review', /One list to review/.test(s3));
check('section 3: the log cites the item id Q<n>', /cites the item's id[^.]*`Q<n>`/.test(s3));
check('section 8b: ## Needs you lists the decisions of questions.json', /every decision in this run's\s+`questions\.json`/.test(s8b));
check('section 8b: ## Needs you no longer lists "every ⚠️ decision"', !/every ⚠️ decision/.test(s8b));
check('section 8c: decisions written out from questions.json, not "every ⚠️ entry"', !/Every ⚠️ entry/.test(s8c));

// FR-012: the reason for T2's rules has its own dated section
check('HISTORY.md has the dated facts/one-list section',
  /\n## Three facts go to "Found"; each decision is listed in one place \(2026-11-27\)/.test(history));

console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length) {
  console.log(`${failures.length} failing:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
