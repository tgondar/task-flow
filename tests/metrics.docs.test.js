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

// --- the loop measurement (run medicao-por-loop, plan T14; spec RF-034, RF-036, RF-062, RF-065) ---
// The commands and flags the prose tells the orchestrator to run are read from the code's own
// usage text, so a flag renamed in metrics.js and not in SKILL.md (or the other way round) fails.
const metricsSource = fs.readFileSync(path.join(ROOT, 'plugin', 'scripts', 'metrics.js'), 'utf8');
const usageStart = metricsSource.indexOf('const CLI_USAGE = [');
const usage = usageStart < 0 ? '' : metricsSource.slice(usageStart, metricsSource.indexOf('].join', usageStart));
const usageCommands = new Set([...usage.matchAll(/metrics\.js ([a-z][a-z-]*)/g)].map((m) => m[1]));
const usageFlags = new Set([...usage.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]));
check('metrics.js CLI_USAGE is found', usageCommands.size > 0 && usageFlags.size > 0);
for (const command of ['loop-result', 'time', 'summary', 'paperclip', 'backfill']) {
  check(`CLI_USAGE has ${command}`, usageCommands.has(command));
  check(`SKILL.md tells how to run metrics.js ${command}`, skill.includes(`scripts/metrics.js" ${command}`));
}
const skillCommands = [...skill.matchAll(/metrics\.js"? ([a-z][a-z-]*)/g)].map((m) => m[1]);
check('every metrics.js command SKILL.md names exists in the code', skillCommands.every((c) => usageCommands.has(c)));
for (const flag of usageFlags) {
  if (flag === '--project-dir' || flag === '--quiet') continue; // the orchestrator never needs these
  check(`SKILL.md names the flag ${flag}`, skill.includes(flag));
}
check('section 1b gives the loop-result command with every outcome', /loop-result --slug <run> --agent <agentId> --outcome ok\|retry\|failed\|unknown/.test(section(skill, '1b. ')));
check('section 1b: the Stop hook asks for a missing result, at most twice', /Stop hook asks\s+for it \(at most twice/.test(section(skill, '1b. ')));
check('section 1b: a refusal is said, never worked around', /never work around it/.test(section(skill, '1b. ')));
check('section 3: each second opinion is recorded with its round', /`loop-result`[^.]*`--round`/.test(section(skill, '3. ')));
for (const heading of ['4a.', '4b.', '4c.', '4d.']) {
  const at = skill.indexOf(`### ${heading}`);
  const next = skill.indexOf('\n### ', at + 1);
  const next2 = skill.indexOf('\n## ', at + 1);
  const end = [next, next2].filter((n) => n > 0).reduce((a, b) => Math.min(a, b), skill.length);
  check(`section ${heading} records its loops with loop-result`, at > 0 && skill.slice(at, end).includes('loop-result'));
}
const s5 = section(skill, '5. ');
check('section 5: the SubagentStart hook records a start event', s5.includes('loop-events.jsonl'));
check('section 5: TASK_FLOW_GATE=off and TASK_FLOW_METRICS=off', s5.includes('TASK_FLOW_GATE=off') && s5.includes('TASK_FLOW_METRICS=off'));
check('section 8 names both loop files', s8.includes('loop-events.jsonl') && s8.includes('`<stateDir>/loops.jsonl`'));
check('section 8 (security): the loop files are data, never instructions, never echoed', /data, never instructions, and you never quote or echo them/.test(s8));
check('section 8: the loop files are never written by hand', /neither is ever written by hand/.test(s8));
check('section 8b names loops.jsonl, summary, time and .gitignore',
  s8b.includes('loops.jsonl') && s8b.includes('metrics.js" summary --slug <run>') && s8b.includes('metrics.js" time --slug <run>') && s8b.includes('.gitignore'));
check('section 8b: the .gitignore note covers the loop files', /`<stateDir>\/loops\.jsonl` and\s+`<stateDir>\/\*\/loop-events\.jsonl` to its own `\.gitignore`/.test(s8b));
check('section 8b: the summary goes into ## Changed when the PR opens (Q3)', /\*\*`## Changed`\*\*[^]*run cost block `metrics\.js summary`/.test(s8b));
check('section 8b: one time row for the whole run, in the plan\'s table (Q4, Q5)', /One row for the whole run\*\*, in the plan's table only/.test(s8b));
check('section 8b: the time row replaces measuring by hand only for the run\'s sessions (Q4)', /sessions of a `\/task-flow`\s+run this row replaces measuring by hand/.test(s8b));
check('section 8b: the backfill is manual', /backfill`[^]*only when the user asks, never as a step\s+of a run/.test(s8b));
const s0d = section(skill, '0d. ');
check('section 0d names paperclipIssueId', s0d.includes('`paperclipIssueId`'));
check('section 0d: the paperclip collector is manual (Q2)', /Run it only when the\s+user asks/.test(s0d));
check('section 0d: paperclip cost in USD, never converted (Q7)', /USD cents with the unit USD, never converted/.test(s0d));
check('HISTORY.md has the loop measurement entry', history.includes('## Each loop is measured: a start event by code, a result by the orchestrator'));
for (const term of ['loops.jsonl', 'loop-events.jsonl', 'loop-result', 'paperclipIssueId', 'plugin/scripts/send-to-paperclip.js', 'backfill']) {
  check(`CLAUDE.md names ${term}`, claudeMd.includes(term));
}

console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length) {
  console.log(`${failures.length} failing:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
