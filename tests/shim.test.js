#!/usr/bin/env node
// The forwarder at shim/task-flow.md (copied to ~/.claude/commands/ by
// install.ps1) is what the user sees when typing /task-flow: its description
// and argument hint, not the skill's. It drifted twice - `review <PR>` and then
// `paperclip <issue>` were added to the skill and never reached the shim - so
// this pins the two together: same argument hint, and every mode named in it
// also named in the shim's description.
//
// Run: node tests/shim.test.js

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const field = (file, name) => {
  const m = new RegExp(`^${name}: (.*)$`, 'm').exec(fs.readFileSync(path.join(root, file), 'utf8'));
  return m ? m[1].trim() : null;
};

const failures = [];
const skillHint = field('plugin/skills/task-flow/SKILL.md', 'argument-hint');
const shimHint = field('shim/task-flow.md', 'argument-hint');
const shimDesc = field('shim/task-flow.md', 'description') || '';

if (!skillHint || skillHint !== shimHint) failures.push('shim argument-hint differs from the skill\'s');
// Each "| <mode> <...>" alternative in the hint is a mode the shim must mention.
for (const m of (skillHint || '').matchAll(/\|\s*(\w+)\s*</g)) {
  if (!shimDesc.includes(m[1])) failures.push(`shim description does not mention "${m[1]}"`);
}

for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(failures.length ? `\n${failures.length} failed` : '  ok    shim matches the skill');
process.exit(failures.length ? 1 : 0);
