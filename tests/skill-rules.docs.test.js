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

console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length) {
  console.log(`${failures.length} failing:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
