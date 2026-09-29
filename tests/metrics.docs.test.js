#!/usr/bin/env node
// Prose/code coherence for the run-health measurement (spec R11, M-R11.2/3).
//
// SKILL.md is prose, metrics.js and render-run.js are code, and prose is what
// drifts. This suite reads the repo's own files (no state, no network, no writes)
// and fails when the rules the orchestrator follows stop naming the fields the
// code reads, when the phase table of section 4 stops matching PHASES, or when
// HISTORY.md loses the reason. It has no security surface of its own.
//
// Run: node tests/metrics.docs.test.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const skillDir = path.join(ROOT, 'plugin', 'skills', 'task-flow');
const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
const history = fs.readFileSync(path.join(skillDir, 'HISTORY.md'), 'utf8');
const claudeMd = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
const { PHASES } = require('../plugin/scripts/render-run.js');

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

/** The text of one `## ` section, from its heading to the next `## `. */
function section(text, headingStart) {
  const start = text.indexOf(`\n## ${headingStart}`);
  if (start < 0) return '';
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

const s4 = section(skill, '4. ');
const s8 = section(skill, '8. ');
const s8b = section(skill, '8b. ');

// M-R11.2: the fields and the keys of `health` are in section 8
for (const term of ['startedAt', 'phaseLog', 'health', 'taskRetries', 'testsGreenFirstRun', 'hardenFindings', 'review']) {
  check(`section 8 names ${term}`, s8.includes(`\`${term}\``));
}
check('section 8 says the renderer ignores the new fields', /ignor/i.test(s8.slice(s8.indexOf('startedAt'))));

// M-R11.2: PHASES of the code = the rows of the table of section 4
const tablePhases = [...s4.matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]).filter((p) => p !== 'phase'); // 'phase' is the header cell
check('section 4 table lists exactly PHASES, in order', JSON.stringify(tablePhases) === JSON.stringify(PHASES));

// the facts are written where they happen (sections 2a, 4a-4d, 8b)
check('section 2a writes startedAt', section(skill, '2. ').includes('startedAt'));
for (const [heading, key] of [['4a.', 'taskRetries'], ['4b.', 'testsGreenFirstRun'], ['4c.', 'hardenFindings'], ['4d.', 'review']]) {
  const at = skill.indexOf(`### ${heading}`);
  const next = skill.indexOf('\n### ', at + 1);
  check(`section ${heading} writes health.${key}`, at > 0 && skill.slice(at, next).includes(`health.${key}`));
}
check('section 8b appends phaseLog', s8b.includes('phaseLog'));
check('section 8b says information, never a gate', /never a gate/.test(s8b) && s8b.includes('TASK_FLOW_METRICS=off'));
check('section 8b tells the user about .gitignore', s8b.includes('metrics.jsonl') && s8b.includes('.gitignore'));

// M-R11.3: the reason is recorded, and CLAUDE.md lists the piece and its suites
check('HISTORY.md has the run health entry', history.includes('Run health is measured by code, once, and is only information'));
check('CLAUDE.md lists metrics.js', claudeMd.includes('plugin/scripts/metrics.js'));
const suites = fs.readdirSync(__dirname).filter((f) => /^metrics\..*test\.js$/.test(f));
check('CLAUDE.md lists every metrics test file', suites.length > 0 && suites.every((f) => claudeMd.includes(`node tests/${f}`)));

console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length) {
  console.log(`${failures.length} failing:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
