#!/usr/bin/env node
// Hands a task-flow run's idea + spec + plan to a paperclip agent org instead of
// running build/tests/harden/review in this session (SKILL.md §0d).
//
// Why a script and not more prose. The concatenation order, the precedence note,
// and the state.json transition this mode makes are exactly the kind of logic
// that drifts when it is only words an agent re-derives each run (see this
// plugin's README on anchoring drifting prose in code). This file is that
// anchor: SKILL.md says what the mode is for, this does the one thing it does.
//
// Everything project-specific — the paperclip URL, which agent gets the
// issue, which GitHub Project field to flip — comes from
// .claude/task-flow.json's optional `paperclip`/`githubProject` objects, the
// same way every other project-specific setting in this plugin does. Two
// things that file does NOT get a say in, because it is committed and a PR
// could change it: the token is always PAPERCLIP_TOKEN, a fixed environment
// variable never named by config; and paperclip.url must be confirmed on this
// machine first (config.js's trustPaperclipUrl/isPaperclipUrlTrusted) before
// it is ever sent a request carrying that token.

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
// GITHUB_NAME (owner/repo) and GRAPHQL_ID (project, field and option ids) are
// the same closed patterns config.js validates githubProject with: re-checked
// here right before each value becomes a `gh` argument, so a committed config
// value cannot smuggle a `gh` flag or (on some `gh` versions) an `@file`-style
// argument into the call. cleanText is config.js's one-visible-line cleaner.
const {
  GITHUB_NAME, GRAPHQL_ID, cleanText, crossesLink, isPaperclipUrlTrusted, loadConfig, parsePaperclipOrigin,
} = require('./config.js');

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ISSUE_NUMBER = /^[1-9][0-9]*$/;

function fail(message) {
  process.stderr.write(`send-to-paperclip: ${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function readArg(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** The same containment discipline render-run.js applies to every artifact path
 *  out of state.json: it is repository data, written by an agent and editable by
 *  hand, so a `../../..` in it must not let this script read a file outside the
 *  docs folder and paste it into an external, third-party service.
 *
 *  Text containment alone is not enough - a symlink or junction anywhere between
 *  docsDir and the target can resolve outside it while still *reading* as inside,
 *  so `crossesLink` (lstat-only, never follows the link) is checked too, the same
 *  two-part test render-run.js's `assertInside` applies to every path it touches. */
function readArtifact(docsDir, label, relativeOrAbsolute) {
  if (!relativeOrAbsolute || typeof relativeOrAbsolute !== 'string') return null;
  const root = path.resolve(docsDir);
  const joined = path.isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : path.join(docsDir, relativeOrAbsolute);
  const target = path.resolve(joined);
  if (target !== root && !target.startsWith(root + path.sep)) {
    fail(`artifacts.${label} escapes docsDir: ${relativeOrAbsolute}`);
  }
  if (!fs.existsSync(target)) return null;
  if (crossesLink(root, target)) fail(`artifacts.${label} goes through a link: ${relativeOrAbsolute}`);
  return fs.readFileSync(target, 'utf8');
}

// --- the paperclip call -----------------------------------------------------

function postIssue({ baseUrl, token, companyId, title, description, assigneeAgentId }) {
  const url = new URL(`/api/companies/${encodeURIComponent(companyId)}/issues`, baseUrl);
  const body = JSON.stringify({ title, description, assigneeAgentId });
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            // Never the token, never the full body (it may echo request fields back).
            reject(new Error(`paperclip responded ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('paperclip response was not valid JSON'));
          }
        });
      },
    );
    req.on('error', (error) => reject(new Error(`paperclip request failed: ${error.code || error.message}`)));
    req.write(body);
    req.end();
  });
}

// --- the GitHub Project status flip -----------------------------------------
//
// Shells out to `gh`, already authenticated on this machine, rather than
// reimplementing GitHub auth. Every value gh sees here is passed as its own
// argv entry (execFileSync, never a shell string, so no argument can inject
// another flag) AND validated first against GITHUB_NAME/GRAPHQL_ID/ISSUE_NUMBER
// — belt and suspenders, because `gh api`'s `-f`/`-F` both give an `@value`
// special, file-reading meaning on some versions, and a value out of a
// project's own committed config is not this script's to trust blindly.

function findProjectItemId({ owner, repo, issueNumber, projectId }) {
  if (!GITHUB_NAME.test(owner)) fail(`githubProject.owner is not a valid GitHub name: ${owner}`);
  if (!GITHUB_NAME.test(repo)) fail(`githubProject.repo is not a valid GitHub name: ${repo}`);
  if (!GRAPHQL_ID.test(projectId)) fail(`githubProject.projectId is not a valid id: ${projectId}`);
  if (!ISSUE_NUMBER.test(String(issueNumber))) fail(`issue number is not valid: ${issueNumber}`);

  const out = execFileSync(
    'gh',
    [
      'api',
      'graphql',
      '-f',
      'query=query($owner:String!,$repo:String!,$number:Int!){' +
        'repository(owner:$owner,name:$repo){issue(number:$number){' +
        'projectItems(first:20){nodes{id project{id}}}}}}',
      '-f',
      `owner=${owner}`,
      '-f',
      `repo=${repo}`,
      '-F',
      `number=${issueNumber}`,
    ],
    { encoding: 'utf8' },
  );
  const data = JSON.parse(out);
  const nodes = (data && data.data && data.data.repository && data.data.repository.issue
    && data.data.repository.issue.projectItems && data.data.repository.issue.projectItems.nodes) || [];
  const hit = nodes.find((node) => node.project && node.project.id === projectId);
  return hit ? hit.id : null;
}

// An issue title is typed by whoever opened the issue, and the orchestrator
// reads it to pick a run's slug and match its idea file (SKILL.md §0d) - so it
// comes back through config.js's cleanText: one line of visible text, nothing
// invisible, capped. Visible text is left as typed - still data, never
// instructions.
const cleanTitle = cleanText;

function issueTitle({ owner, repo, issueNumber }) {
  if (!GITHUB_NAME.test(owner)) fail(`githubProject.owner is not a valid GitHub name: ${owner}`);
  if (!GITHUB_NAME.test(repo)) fail(`githubProject.repo is not a valid GitHub name: ${repo}`);
  if (!ISSUE_NUMBER.test(String(issueNumber))) fail(`issue number is not valid: ${issueNumber}`);
  const out = execFileSync(
    'gh',
    ['issue', 'view', String(issueNumber), '--repo', `${owner}/${repo}`, '--json', 'title'],
    { encoding: 'utf8' },
  );
  const data = JSON.parse(out);
  return cleanTitle(data && typeof data.title === 'string' ? data.title : '');
}

function flipStatus({ projectId, itemId, fieldId, optionId }) {
  if (!GRAPHQL_ID.test(projectId)) fail(`githubProject.projectId is not a valid id: ${projectId}`);
  if (!GRAPHQL_ID.test(itemId)) fail(`project item id is not valid: ${itemId}`);
  if (!GRAPHQL_ID.test(fieldId)) fail(`githubProject.statusFieldId is not a valid id: ${fieldId}`);
  if (!GRAPHQL_ID.test(optionId)) fail(`githubProject.readyOptionId is not a valid id: ${optionId}`);
  execFileSync('gh', [
    'project', 'item-edit',
    '--project-id', projectId,
    '--id', itemId,
    '--field-id', fieldId,
    '--single-select-option-id', optionId,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
}

// --- main --------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const projectDir = readArg(argv, '--project-dir') || process.cwd();
  const slug = readArg(argv, '--slug');
  const githubIssue = readArg(argv, '--github-issue');
  // `--issue-title --github-issue <n>` only prints the issue's title, for the
  // orchestrator to derive a slug from when the user typed no description
  // (SKILL.md §0d) - it needs no slug, no token and sends nothing anywhere.
  const titleOnly = argv.includes('--issue-title');

  if (!titleOnly && (!slug || !SAFE_SEGMENT.test(slug))) fail(`--slug is required and must be a safe name (got ${JSON.stringify(slug)})`);
  if (!githubIssue || !ISSUE_NUMBER.test(githubIssue)) fail(`--github-issue is required and must be a positive integer (got ${JSON.stringify(githubIssue)})`);

  const loaded = loadConfig(projectDir);
  if (!loaded.ok) fail(`configuration is not valid: ${loaded.errors.join('; ')}`);
  const config = loaded.config;
  const raw = config.raw || {};

  const pc = raw.paperclip || {};
  for (const field of ['url', 'companyId', 'agentId']) {
    if (typeof pc[field] !== 'string' || !pc[field]) fail(`.claude/task-flow.json is missing paperclip.${field}`);
  }
  if (raw.githubProject === null) {
    fail('this repository has no GitHub Project (githubProject is null in .claude/task-flow.json); '
      + '/task-flow paperclip needs one - choose it with config.js github-projects, then github-project <number>');
  }
  const gh = raw.githubProject || {};
  for (const field of ['owner', 'repo', 'projectId', 'statusFieldId', 'readyOptionId']) {
    if (typeof gh[field] !== 'string' || !gh[field]) fail(`.claude/task-flow.json is missing githubProject.${field}`);
  }

  if (titleOnly) {
    process.stdout.write(`${issueTitle({ owner: gh.owner, repo: gh.repo, issueNumber: githubIssue })}\n`);
    return;
  }

  // Parsed once, here, with new URL() - never a raw string compare or a
  // regex - and only the result (scheme+host+port, nothing a path or query
  // could hide a difference in) is trusted, compared, shown, or ever reaches
  // a message this process prints. A value that does not parse as a plain
  // http(s) origin with no username/password is refused outright: it is
  // never safe to echo into a suggested command, whatever it contains, so
  // the message below cannot be built from it at all. See config.js's
  // parsePaperclipOrigin for why userinfo specifically is rejected.
  const origin = parsePaperclipOrigin(pc.url);
  if (!origin) fail('paperclip.url is not a plain http(s) URL with no username or password');

  // The destination of a board-level secret must never be picked by committed
  // config alone (HISTORY.md, "handing build onward to a separate agent
  // org"): a malicious edit to paperclip.url in a merged PR must not be able
  // to silently redirect where the token goes. The URL needs the person's own
  // confirmation on this machine first, exactly like an outside docsDir does.
  // The suggested fix-it command below is built only from `origin` (already
  // validated to contain nothing but scheme/host/port) and from `projectDir`
  // (this process's own resolved path, never a value out of state.json or
  // the config file) - never the raw, unparsed `pc.url` a committed file
  // could have set to anything, including a string that looks like a
  // runnable shell command of its own.
  if (!isPaperclipUrlTrusted(projectDir, pc.url)) {
    fail(
      `paperclip.url (${origin}) is not trusted on this machine; confirm it with the person, then run: `
      + `node "${path.join(__dirname, 'config.js')}" trust-paperclip --project-dir "${projectDir}" --url "${origin}"`,
    );
  }

  // The token is never named by committed config (only its destination was,
  // above) — one fixed, purpose-specific environment variable, so a malicious
  // config edit cannot redirect an unrelated secret into this request either.
  const token = process.env.PAPERCLIP_TOKEN;
  if (!token) fail('environment variable PAPERCLIP_TOKEN is not set');

  const stateDir = path.join(config.stateDir, slug);
  const statePath = path.join(stateDir, 'state.json');
  if (!fs.existsSync(statePath)) fail(`no run at ${statePath}`);
  const state = readJson(statePath);
  if (state.phase !== 'plan') {
    fail(`run "${slug}" is at phase "${state.phase}", not "plan" — task-flow paperclip only hands off right after the plan`);
  }

  // A run started in this mode records its issue (SKILL.md §0d) so that a
  // resume cannot hand it off under a different one by a typo. The recorded
  // value is state.json content, so it is compared, never echoed.
  if (state.paperclipIssue !== undefined && String(state.paperclipIssue) !== githubIssue) {
    fail(`run "${slug}" was started for a different GitHub issue than --github-issue ${githubIssue}`);
  }

  const artifacts = state.artifacts || {};
  const idea = readArtifact(config.docsDir, 'idea', artifacts.idea);
  const spec = readArtifact(config.docsDir, 'spec', artifacts.spec);
  const plan = readArtifact(config.docsDir, 'plan', artifacts.plan);
  if (!spec) fail(`run "${slug}" has no spec artifact recorded in state.json`);
  if (!plan) fail(`run "${slug}" has no plan artifact recorded in state.json`);

  const PRECEDENCE = 'Precedence if these documents conflict: plan overrides spec overrides idea. '
    + 'Treat the plan as current truth; earlier docs are context for why decisions were made.';

  const sections = [['idea', idea], ['spec', spec], ['plan', plan]]
    .filter(([, body]) => body)
    .map(([name, body]) => `---\n## ${name}\n\n${body}\n`);

  const description = [PRECEDENCE, '', ...sections, `GitHub issue: #${githubIssue}`].join('\n');

  const issue = await postIssue({
    baseUrl: origin,
    token,
    companyId: pc.companyId,
    title: slug,
    description,
    assigneeAgentId: pc.agentId,
  });

  let statusFlipped = false;
  try {
    const itemId = findProjectItemId({
      owner: gh.owner,
      repo: gh.repo,
      issueNumber: githubIssue,
      projectId: gh.projectId,
    });
    if (itemId) {
      flipStatus({ projectId: gh.projectId, itemId, fieldId: gh.statusFieldId, optionId: gh.readyOptionId });
      statusFlipped = true;
    } else {
      process.stderr.write(`warning: issue #${githubIssue} is not on the configured GitHub Project; status not flipped\n`);
    }
  } catch (error) {
    // The paperclip handoff already happened; a board-status failure is a note,
    // not a reason to leave the run looking like nothing was sent at all.
    process.stderr.write(`warning: could not flip the GitHub Project status: ${error.message}\n`);
  }

  // §0d's state transition: phase stays "plan" (build never ran in this run),
  // status is "blocked" (reused, not a new value — see HISTORY.md). The
  // orchestrator does not also write state.json for this step; this is the
  // one place that does, the same division of labour every other subagent
  // in this pipeline has (§1b).
  const now = new Date().toISOString();
  state.status = 'blocked';
  state.updated = now;
  if (!state.phaseChangedAt) state.phaseChangedAt = now;
  state.outcome = 'handed-off';
  state.outcomeNote = `paperclip issue ${issue.identifier || issue.id}${statusFlipped ? '' : ' (board status not flipped)'}`;
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  process.stdout.write(`handed off ${slug} to paperclip as ${issue.identifier || issue.id}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    if (!process.exitCode) process.exitCode = 1;
    if (error && error.message && !/^send-to-paperclip:/.test(error.message)) {
      process.stderr.write(`send-to-paperclip: ${error.message}\n`);
    }
  });
}

module.exports = { readArtifact, findProjectItemId, flipStatus, issueTitle, cleanTitle };
