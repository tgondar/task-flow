#!/usr/bin/env node
// Tests for the task-flow run renderer.
//
// Two halves, and the second is not decoration. The renderer takes paths out of
// state.json - a file written by agents, edited by hand and committed - joins them
// to the user's docs folder, READS what it finds, pastes it into a page, and
// DELETES files it considers stale. Every one of those verbs is a way to do damage
// with a bad path, so the S-cases are as load-bearing as the R-cases.
//
// Most R-cases run a PT-PT project, because the page wording is what they assert
// on and that table is the fuller one; the L-cases cover English and the fallback.
//
// Run: node tests/render-run.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

// The trust list for a docsDir outside the project lives in the home folder
// (config.js). These tests get a home of their own, so they never read or write
// the real one; child processes inherit it through the environment.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
// The feed for the panel goes to LOCALAPPDATA (XDG_STATE_HOME elsewhere): never the real one.
process.env.LOCALAPPDATA = TEST_HOME;
process.env.XDG_STATE_HOME = TEST_HOME;
const { trustDocsDir } = require('../plugin/scripts/config.js');

const { renderAll } = require('../plugin/scripts/render-run.js');

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

const PLAN = [
  '# Plano',
  '',
  '## Visão geral',
  'blá',
  '',
  '## T1 · A primeira tarefa',
  'detalhe que não deve aparecer no painel',
  '',
  '## T2 · A segunda tarefa',
  '',
  '## Checkpoint A — depois de T1–T2',
  '',
  '## T3 · A terceira tarefa',
  '',
].join('\n');

/** A project + docs folder pair on disk. Everything a case needs, nothing it does not.
 *  `config` replaces the whole .claude/task-flow.json when given. */
function fixture({
  state = {},
  language = 'PT-PT',
  stateDir = 'docs/pipeline',
  slug = 'demo',
  plan = PLAN,
  questions = null,
  questionsArchived = false,
  config = undefined,
  runDirName = null,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-render-'));
  const projectDir = path.join(root, 'project');
  const docsParent = path.join(root, 'notes');
  const docsDir = path.join(docsParent, 'demo-project');

  fs.mkdirSync(path.join(docsDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'tasks', 'index.md'), '# Tasks\n');

  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.claude', 'task-flow.json'),
    JSON.stringify(config === undefined ? { docsDir, language, tasksFile: 'tasks/index.md', stateDir } : config)
  );

  const runDir = path.join(projectDir, ...stateDir.split('/'), runDirName || slug);
  fs.mkdirSync(runDir, { recursive: true });

  fs.mkdirSync(path.join(docsDir, 'plans'), { recursive: true });
  fs.mkdirSync(path.join(docsDir, 'ideas'), { recursive: true });
  if (plan !== null) fs.writeFileSync(path.join(docsDir, 'plans', `260908_${slug}.plan.md`), plan);
  fs.writeFileSync(path.join(docsDir, 'ideas', `260908_${slug}.md`), '# ideia');

  if (questions !== null) {
    const dir = questionsArchived ? path.join(docsDir, 'questions', 'resolved') : path.join(docsDir, 'questions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `260908_${slug}_questions.md`), questions);
  }

  fs.writeFileSync(
    path.join(runDir, 'state.json'),
    typeof state === 'string'
      ? state
      : JSON.stringify({
          task: slug,
          phase: 'plan',
          status: 'running',
          created: '2026-09-08',
          buildCursor: 'T1',
          branch: 'feature/demo',
          updated: '2026-09-08T18:36:23Z',
          artifacts: { idea: `ideas/260908_${slug}.md`, plan: `plans/260908_${slug}.plan.md` },
          ...state,
        })
  );

  trustDocsDir(projectDir, docsDir);
  const liveDir = path.join(docsDir, 'runs');
  return {
    projectDir,
    docsParent,
    docsDir,
    liveDir,
    archiveDir: path.join(liveDir, 'finished'),
    live: (name = `260908_${slug}.md`) => path.join(liveDir, name),
    archived: (name = `260908_${slug}.md`) => path.join(liveDir, 'finished', name),
  };
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const ls = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.md')) : []);

console.log('\n--- the document it produces ---');

// --- R1: a live run lands in runs/, named for its creation date ---------------
{
  const f = fixture();
  const out = renderAll({ projectDir: f.projectDir });
  check('R1 a live run renders into runs/', fs.existsSync(f.live()), JSON.stringify(out.skipped));
}

// --- R2: the phase in flight is the one AFTER state.phase --------------------
{
  const f = fixture({ state: { phase: 'plan' } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R2 phase "plan" shows build in flight', /\*\*Fase 4 de 7 · build\*\*/.test(doc), doc && doc.slice(0, 400));
  check('R2 the plan row is ticked', /- \[x\] plan/.test(doc));
  check('R2 the build row is the one marked', /- \[ \] \*\*build\*\*.*← aqui/.test(doc));
}

// --- R3: the cursor turns into "6 done, this one running" --------------------
{
  const f = fixture({ state: { buildCursor: 'T2' } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R3 tasks landed are ticked', /- \[x\] T1 · A primeira tarefa/.test(doc) && /- \[x\] T2 · A segunda/.test(doc));
  check('R3 the next task is the one in flight', /- \[ \] \*\*T3 · A terceira tarefa\*\* ← aqui/.test(doc));
  check('R3 the count is landed-of-total', /## Tarefas — 2 de 3/.test(doc), doc && doc.match(/## Tarefas.*/));
  check('R3 "Agora" names the running task', /\*\*Agora:\*\* T3 · A terceira tarefa/.test(doc));
  check('R3 no plan detail is copied in', !doc.includes('detalhe que não deve aparecer'));
  check('R3 checkpoints are not tasks', !doc.includes('Checkpoint A'));
}

// --- R4: done with nothing open is archived ----------------------------------
{
  const f = fixture({ state: { phase: 'done', status: 'done' }, questions: '- [x] respondida\n' });
  renderAll({ projectDir: f.projectDir });
  check('R4 a closed run moves to runs/finished/', fs.existsSync(f.archived()));
  check('R4 and leaves the live folder', ls(f.liveDir).length === 0, ls(f.liveDir).join(','));
}

// --- R5: done but still waiting on a person stays in sight -------------------
{
  const f = fixture({ state: { phase: 'done', status: 'done' }, questions: '- [ ] por responder\n- [x] feita\n' });
  renderAll({ projectDir: f.projectDir });
  check('R5 a closed run with an open question stays live', fs.existsSync(f.live()));
  check('R5 and is not archived', ls(f.archiveDir).length === 0);
  check('R5 the open count is stated', /⚠️ \*\*1 por responder\*\*/.test(read(f.live())));
}

// --- R6: archiving is reversible, because runs reopen ------------------------
{
  const f = fixture({ state: { phase: 'done', status: 'done' }, questions: '- [x] feita\n' });
  renderAll({ projectDir: f.projectDir });
  const statePath = path.join(f.projectDir, 'docs', 'pipeline', 'demo', 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  fs.writeFileSync(statePath, JSON.stringify({ ...state, phase: 'build', status: 'running' }));
  renderAll({ projectDir: f.projectDir });
  check('R6 a reopened run comes back to the live folder', fs.existsSync(f.live()));
  check('R6 and its archived copy is gone', ls(f.archiveDir).length === 0, ls(f.archiveDir).join(','));
}

// --- R7: one file per run, even if the date prefix changes -------------------
{
  const f = fixture();
  fs.mkdirSync(f.liveDir, { recursive: true });
  fs.writeFileSync(
    path.join(f.liveDir, '260101_demo.md'),
    '> Generated by `render-run.js`. stale name for the same run'
  );
  renderAll({ projectDir: f.projectDir });
  check('R7 exactly one file survives for the run', ls(f.liveDir).length === 1, ls(f.liveDir).join(','));
  check('R7 and it is the current one', fs.existsSync(f.live()));
}

// --- R8: a plan with no T-headings degrades, it does not crash ---------------
{
  const f = fixture({ plan: '# Plano\n\n## Abordagem\ntexto\n' });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R8 no task headings falls back to the cursor', /Cursor em `T1`/.test(doc), doc && doc.slice(0, 300));
}

// --- R9: stateDir comes from the configuration -------------------------------
{
  const f = fixture({ stateDir: '.claude/pipeline' });
  const out = renderAll({ projectDir: f.projectDir });
  check('R9 a non-default stateDir is honoured', fs.existsSync(f.live()), JSON.stringify(out.skipped));
}

// --- R10: a project that never opted in is not this script's business --------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-render-bare-'));
  let threw = null;
  let out = null;
  try {
    out = renderAll({ projectDir: root });
  } catch (error) {
    threw = error;
  }
  check('R10 no task-flow.json does not throw', threw === null, threw && threw.message);
  check('R10 and says why it did nothing', out && /task-flow\.json/.test(out.skipped[0].why));
}

// --- R11: one corrupt run must not hide the others ---------------------------
{
  const f = fixture({ state: '{ not json at all' });
  const good = path.join(f.projectDir, 'docs', 'pipeline', 'other');
  fs.mkdirSync(good, { recursive: true });
  fs.writeFileSync(
    path.join(good, 'state.json'),
    JSON.stringify({ task: 'other', phase: 'spec', status: 'running', created: '2026-09-08', docsParent: f.docsParent })
  );
  const out = renderAll({ projectDir: f.projectDir });
  check('R11 the healthy run still renders', fs.existsSync(f.live('260908_other.md')), JSON.stringify(out));
  check('R11 the corrupt one is reported, not fatal', out.skipped.some((s) => s.run === 'demo'));
}

// --- R12: without a valid configuration there is nowhere to write ------------
// The three required fields are what tell the renderer where and in which
// language; a project missing one renders nothing and says which.
{
  const f = fixture();
  fs.writeFileSync(
    path.join(f.projectDir, '.claude', 'task-flow.json'),
    JSON.stringify({ language: 'EN', tasksFile: 'tasks/index.md', stateDir: 'docs/pipeline' })
  );
  const out = renderAll({ projectDir: f.projectDir });
  check('R12 a project with no docsDir renders nothing', out.rendered.length === 0 && out.skipped.length === 1);
  check('R12 and the reason names it', /docsDir/.test(out.skipped[0].why), out.skipped[0].why);
}

// --- R13: questions already resolved still get a link -----------------------
{
  const f = fixture({ questions: '- [x] feita\n', questionsArchived: true });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R13 resolved questions count as zero open', /Nenhuma por responder/.test(doc), doc);
  check('R13 and still link to the archived file', /questions\/resolved\//.test(doc), doc);
}

// --- R14: the banked-decision count is visible ------------------------------
{
  const f = fixture({ state: { pendingDecisions: 2 } });
  renderAll({ projectDir: f.projectDir });
  check('R14 banked decisions are shown', /Decisões tomadas sozinho, à espera de revisão: 2/.test(read(f.live())));
}

// --- R15: a legacy run is dated from its artifacts, not from the checkout ----
// Inside a git worktree every file is born the day the worktree was made, so the
// file's own timestamp would date every old run today.
{
  const f = fixture({ state: { created: undefined } });
  renderAll({ projectDir: f.projectDir });
  check('R15 a run with no `created` is dated from its artifacts', fs.existsSync(f.live('260908_demo.md')), ls(f.liveDir).join(','));
  check('R15 and not from today', !ls(f.liveDir).some((n) => n !== '260908_demo.md'));
}

// --- R16: a declared creation date wins -------------------------------------
{
  const f = fixture({ state: { created: '2026-01-02' } });
  renderAll({ projectDir: f.projectDir });
  check('R16 `created` beats the artifact prefix', fs.existsSync(f.live('260102_demo.md')), ls(f.liveDir).join(','));
}

// --- R17: real plans number tasks T0.5, A1, B3 — not only T1 ----------------
{
  const plan = [
    '## Visão geral',
    '## T0 · Pré-voo do ambiente',
    '## T0.5 · A medição P10 — gate da Fatia 1',
    '## A1 · O resolvedor partilhado',
    '## Checkpoint A — antes do PR A',
    '## B3 · A linha de origem do preço',
    '## Riscos e mitigações',
  ].join('\n');
  const f = fixture({ plan, state: { buildCursor: 'T0.5' } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R17 decimal and letter task ids are found', /## Tarefas — 2 de 4/.test(doc), doc && doc.match(/## Tarefas.*/));
  check('R17 T0.5 counts as landed', /- \[x\] T0\.5 · A medição P10/.test(doc));
  check('R17 A1 is the one in flight', /- \[ \] \*\*A1 · O resolvedor partilhado\*\* ← aqui/.test(doc));
  check('R17 a checkpoint is not a task', !doc.includes('Checkpoint A'));
  check('R17 a prose heading is not a task', !/- \[[ x]\] .*Riscos/.test(doc));
}

// --- R18: a free-form cursor must not fake a position -----------------------
// A real run parked "PR A (#200) and PR B (#201) both open" in buildCursor.
{
  const f = fixture({ state: { buildCursor: 'PR A (#200) and PR B (#201) both open. PR C not started.' } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R18 an unmatched cursor claims no task number', !/tarefa \d+ de \d+/.test(doc), doc && doc.slice(0, 400));
  check('R18 no task is ticked on a guess', !/- \[x\]/.test(doc.split('## Tarefas')[1] || ''));
  check('R18 and the cursor is shown verbatim', doc.includes('não nomeia uma destas tarefas'));
}

// --- R19: the frontmatter date is always filled ----------------------------
{
  const f = fixture({ state: { created: undefined } });
  renderAll({ projectDir: f.projectDir });
  check('R19 created is never left empty', /^created: 2026-09-08$/m.test(read(f.live('260908_demo.md'))));
}

// --- R20: a finished run that still needs a person does not say "terminada" --
//
// A run with nothing open archives, so every page left sitting in runs/ is
// either working or waiting on someone. Labelling the second kind "terminada" made
// the folder read as a pile of finished work: four pages, four "terminada", and no
// way to see at a glance which one wanted an answer.
{
  const f = fixture({ state: { phase: 'done', status: 'done' }, questions: '- [ ] por responder\n' });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R20 a done run with an open question waits on a person', /^# demo — à espera de ti$/m.test(doc), doc.split('\n')[8]);
  check('R20 and does not call itself terminada', !/# demo — terminada/.test(doc));
  check('R20 and says why it is still here', /Fica aqui porque tem questões por responder/.test(doc));
}

// --- R21: a finished run with nothing open keeps the old word ---------------
{
  const f = fixture({ state: { phase: 'done', status: 'done' }, questions: '- [x] feita\n' });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.archived());
  check('R21 nothing open is still "terminada"', /^# demo — terminada$/m.test(doc), doc.split('\n')[8]);
  check('R21 and it does not claim to be waiting', !/à espera de ti/.test(doc));
}

// --- R22: the new label is only about being done, not about being stuck -----
{
  const f = fixture({ state: { phase: 'build', status: 'blocked' }, questions: '- [ ] por responder\n' });
  renderAll({ projectDir: f.projectDir });
  check('R22 a blocked run keeps its own words', /^# demo — parada — à espera de resposta$/m.test(read(f.live())));
}

// --- R23: an unattended run says so, because nobody is watching the terminal -
{
  const f = fixture({ state: { mode: 'auto' } });
  renderAll({ projectDir: f.projectDir });
  check('R23 an auto run is marked as such', /modo auto/.test(read(f.live())));
}

// --- R24: attended is the silent default, including for runs that predate it -
{
  const f = fixture({ state: { mode: undefined } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R24 a run with no mode says nothing about the mode', !/modo /.test(doc), doc);
}

console.log('\n--- what it refuses to do ---');

// --- S1: a configuration config.js refuses renders nothing -------------------
// The docs folder, the task list and the state folder are all repository data;
// config.js owns their containment, and the renderer must not work around a
// refusal by writing somewhere anyway.
{
  const f = fixture();
  fs.writeFileSync(
    path.join(f.projectDir, '.claude', 'task-flow.json'),
    JSON.stringify({ docsDir: f.docsDir, language: 'EN', tasksFile: '../../escape.md', stateDir: 'docs/pipeline' })
  );
  const out = renderAll({ projectDir: f.projectDir });
  check('S1 a task list outside docsDir stops the render', out.rendered.length === 0 && out.archived.length === 0);
  check('S1 and says so', /tasksFile/.test(out.skipped[0].why), out.skipped[0].why);
  check('S1 and no page is written', !fs.existsSync(f.liveDir));
}

// --- S2: a traversing plan path is not read ---------------------------------
{
  const f = fixture({ state: { artifacts: { plan: '../../secret.md' } } });
  fs.writeFileSync(path.join(f.docsParent, '..', 'secret.md'), '## T1 · SEGREDO QUE NAO DEVE SAIR\n');
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('S2 a plan path outside the docs folder is not read', doc !== null && !doc.includes('SEGREDO'), doc);
}

// --- S3: a traversing questions path is not read either ---------------------
{
  const f = fixture({ state: { artifacts: { questions: '../../secret_questions.md' } } });
  fs.writeFileSync(path.join(f.docsParent, '..', 'secret_questions.md'), '- [ ] SEGREDO\n- [ ] OUTRO\n');
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('S3 a questions path outside the docs folder is not read', !/2 por responder/.test(doc), doc);
  check('S3 and is not linked', !doc.includes('secret_questions'));
}

// --- S4: an absolute artifact path OUTSIDE the docs folder is refused -------
// An absolute path inside the docs folder is fine (R24). What must never be readable is
// one that lands outside it, whatever its spelling: containment is the check, and
// this is the case that proves containment is still doing the work now that
// `isAbsolute` no longer refuses everything on sight.
{
  const outside = path.join(os.tmpdir(), `taskflow-abs-${process.pid}.md`);
  fs.writeFileSync(outside, '## T1 · ABSOLUTO\n');
  const f = fixture({ state: { artifacts: { plan: outside } } });
  renderAll({ projectDir: f.projectDir });
  check('S4 an absolute artifact path outside the docs folder is refused', !read(f.live()).includes('ABSOLUTO'));
  fs.unlinkSync(outside);
}

// --- S12: an absolute path that climbs back out is refused ------------------
// The shape a traversal takes once absolute paths are allowed: it starts inside
// the docs folder, so a naive prefix test on the raw string would pass it, and only
// resolving it first catches the `..`.
{
  const outside = path.join(os.tmpdir(), `taskflow-climb-${process.pid}.md`);
  fs.writeFileSync(outside, '## T1 · TREPADOR\n');
  const f = fixture();
  const statePath = path.join(f.projectDir, 'docs', 'pipeline', 'demo', 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const climbing = path.join(f.docsDir, '..', '..', '..', path.basename(outside));
  fs.writeFileSync(statePath, JSON.stringify({ ...state, artifacts: { plan: climbing } }));
  renderAll({ projectDir: f.projectDir });
  check('S12 an absolute path climbing out of the docs folder is refused', !read(f.live()).includes('TREPADOR'));
  fs.unlinkSync(outside);
}

// --- S5: a run directory that is not a safe name is skipped -----------------
{
  const f = fixture({ runDirName: '..evil' });
  const out = renderAll({ projectDir: f.projectDir });
  check('S5 an unsafe run directory name is skipped', out.rendered.length === 0, JSON.stringify(out.rendered));
  check('S5 and the reason names it', /safe name/.test(out.skipped[0].why), out.skipped[0].why);
}

// --- S6: the stale sweep only removes this run's own files ------------------
{
  const f = fixture();
  fs.mkdirSync(f.liveDir, { recursive: true });
  fs.writeFileSync(path.join(f.liveDir, '260101_outra-run.md'), 'another run, still live');
  renderAll({ projectDir: f.projectDir });
  check('S6 another run in the folder is left alone', fs.existsSync(path.join(f.liveDir, '260101_outra-run.md')));
}

// --- S7: the sweep never leaves the runs tree ---------------------------------
{
  const f = fixture();
  const decoy = path.join(f.docsDir, '260101_demo.md'); // same suffix, wrong folder
  fs.writeFileSync(decoy, 'a real artifact that happens to end in _demo.md');
  renderAll({ projectDir: f.projectDir });
  check('S7 a same-named file outside runs/ survives', fs.existsSync(decoy));
}

// --- S8: a missing docs folder is refused, never created ---------------------
{
  const f = fixture();
  fs.rmSync(f.docsDir, { recursive: true, force: true });
  const out = renderAll({ projectDir: f.projectDir });
  check('S8 a missing docs folder is refused', out.rendered.length === 0);
  check('S8 and nothing is created in its place', !fs.existsSync(f.docsDir));
}

// --- S9: the mode is a whitelist, not a string to paste into the page -------
// state.json is written by agents and edited by hand, and this page is the thing
// the user trusts to say where a run is. A mode that carried markdown of its own
// could forge a heading, a status line or a PR link on a page read as
// generated truth — so the renderer must decide from the value, never echo it.
{
  const hostile = 'auto\n\n# demo — terminada\n\n**Agora:** nada\n\n[PR](http://evil.example)';
  const f = fixture({ state: { mode: hostile } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('S9 a hostile mode is not echoed', !doc.includes('evil.example'), doc);
  check('S9 and it cannot forge a heading', !/^# demo — terminada$/m.test(doc), doc);
  check('S9 and an unknown mode is treated as attended', !/modo /.test(doc), doc);
}

// --- R20: a task the run deliberately skipped is not reported as done --------
// The renderer used to mark every task done the moment the run closed, so four
// tasks that were measured and consciously NOT written showed up as "15 de 15"
// on the page read as truth. The skip lives in state.json; the page has
// to carry it, or a cancelled slice looks delivered.
{
  const f = fixture({
    state: {
      phase: 'review',
      status: 'done',
      buildCursor: 'T3',
      skippedTasks: [{ id: 'T2', reason: 'medido 0 em branco — a fatia não corrigia nada' }],
    },
  });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live()) || read(f.archived());
  check('R20 a skipped task is excluded from the done count', /## Tarefas — 2 de 3 · 1 saltada$/m.test(doc), doc);
  check('R20 and the skipped task is not ticked', !/- \[x\].*T2 · A segunda tarefa/.test(doc), doc);
  check('R20 and it says why it was skipped', /T2 · A segunda tarefa.*saltada.*não corrigia nada/.test(doc), doc);
  check('R20 and the tasks around it are still done', /- \[x\] T1 · A primeira tarefa/.test(doc) && /- \[x\] T3 · A terceira tarefa/.test(doc), doc);
}

// --- R21: more than one skip reads as plural, and a run still in flight ------
// shows its skips too — a slice cancelled at task 1 must not look pending for
// the rest of the run.
{
  const f = fixture({
    state: {
      buildCursor: 'T2',
      skippedTasks: [{ id: 'T1', reason: 'primeira' }, { id: 'T3', reason: 'terceira' }],
    },
  });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R21 plural agrees with the count', /· 2 saltadas$/m.test(doc), doc);
  check('R21 a skip before the cursor is not ticked', !/- \[x\].*T1 · A primeira tarefa/.test(doc), doc);
  // Every remaining task after the cursor is skipped, so there is nothing to be
  // "at" — and claiming a position would be claiming a task that is struck out.
  check('R21 and no position is claimed when nothing is left to do', !/tarefa \d+ de \d+/.test(doc), doc);
}

// --- R21b: the position names the task it sits next to ----------------------
{
  const f = fixture({ state: { buildCursor: 'T1', skippedTasks: [{ id: 'T2', reason: 'saltada' }] } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R21b "Agora" steps over the skipped task', /\*\*Agora:\*\* T3 · A terceira tarefa/.test(doc), doc);
  check('R21b and the position agrees with it', /· tarefa 3 de 3/.test(doc), doc);
}

// --- R22: an id that names no task of this plan is ignored -------------------
// Same discipline the buildCursor already follows: state.json is repository
// data, so an id out of it is a lookup key, never a fact. A typo must not
// invent a task line or move the count.
{
  const f = fixture({
    state: { phase: 'review', status: 'done', buildCursor: 'T3', skippedTasks: [{ id: 'T99', reason: 'não existe' }] },
  });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live()) || read(f.archived());
  check('R22 an unknown skipped id does not move the count', /## Tarefas — 3 de 3$/m.test(doc), doc);
  check('R22 and it is not echoed as a task', !doc.includes('T99'), doc);
}

// --- R23: a run with no skips is unchanged ----------------------------------
{
  const f = fixture({ state: { phase: 'review', status: 'done', buildCursor: 'T3' } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live()) || read(f.archived());
  check('R23 a done run with no skips still counts them all', /## Tarefas — 3 de 3$/m.test(doc), doc);
  check('R23 and says nothing about skips', !/saltada/.test(doc), doc);
}

// --- S10: a skip reason is text, not markup ---------------------------------
// The reason is the first free text this page ever takes from state.json and
// prints. Same threat as the mode in S9: a file written by agents and edited by
// hand must not be able to forge structure on a page read as generated truth.
{
  // The forged heading has to be text this page would never write by itself: a
  // done run's real title IS `# demo — terminada`, so using that would have let
  // the case pass on the genuine heading instead of on the defence.
  const hostile = 'razão\n\n# forjado pelo state\n\n**Agora:** nada\n\n[PR](http://evil.example)';
  const f = fixture({
    state: { phase: 'review', status: 'done', buildCursor: 'T3', skippedTasks: [{ id: 'T2', reason: hostile }] },
  });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live()) || read(f.archived());
  check('S10 a hostile reason cannot forge a link', !doc.includes('evil.example'), doc);
  check('S10 and it cannot forge a heading', !/^# forjado pelo state$/m.test(doc), doc);
  check('S10 and it cannot forge a status line', !/^\*\*Agora:\*\* nada$/m.test(doc), doc);
  check('S10 and the harmless part survives', /razão/.test(doc), doc);
}

// --- S11: the PR url is a link target, not a place to break out -------------
// Pre-existing hole found while closing S10: state.pr was pasted raw inside
// `[PR](...)`, so a closing paren in the value ended the link and everything
// after it became page markup.
{
  const f = fixture({
    state: { pr: 'http://ok.example) — **terminada** · [x](http://evil.example' },
  });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('S11 a hostile PR url cannot break out of the link', !doc.includes('evil.example'), doc);
}

console.log('\n--- what real runs broke on ---');

// --- R24: an absolute artifact path INSIDE the docs folder is read ----------
// The defect that emptied a page without a word: every artifact in that run was
// recorded as an absolute path, all inside the docs folder, and every one resolved
// to null. No links, and a plan the page claimed declared no numbered tasks while
// the parser was reading all of them.
{
  const f = fixture();
  const statePath = path.join(f.projectDir, 'docs', 'pipeline', 'demo', 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const absolutePlan = path.join(f.docsDir, 'plans', '260908_demo.plan.md');
  const absoluteIdea = path.join(f.docsDir, 'ideas', '260908_demo.md');
  fs.writeFileSync(
    statePath,
    JSON.stringify({ ...state, artifacts: { idea: absoluteIdea, plan: absolutePlan } })
  );
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R24 an absolute plan path inside the docs folder is read', /T1 · A primeira tarefa/.test(doc), doc);
  check('R24 and it does not degrade to "no numbered headings"', !/cabeçalhos numerados/.test(doc), doc);
  check('R24 and the artifact still becomes a link', /\[idea\]\(\.\.\/ideas\//.test(doc), doc);
}

// --- R25: a task inserted mid-run keeps its letter ---------------------------
{
  const f = fixture({
    plan: ['## T4 · A quarta', '', '## T4b · A que nasceu a meio', '', '## T5 · A quinta', ''].join('\n'),
    state: { buildCursor: 'T4' },
  });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R25 T4b is counted as a task', /Tarefas — 1 de 3/.test(doc), doc);
  check('R25 and it is the one in flight', /\*\*T4b · A que nasceu a meio\*\* ← aqui/.test(doc), doc);
}

// --- R26: a date with no time is not printed as an hour ----------------------
// `new Date('2026-09-08')` is UTC midnight, so east of Greenwich a date came out as
// 01:00 the next day. The page said "actualizado 22/09 01:00" for work done in
// the afternoon, which reads as a measurement and was not one.
{
  const f = fixture({ state: { updated: '2026-09-08' } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R26 a bare date renders as a date', /actualizado 08\/09 ·/.test(doc), doc);
  check('R26 and invents no hour', !/actualizado 08\/09 \d\d:/.test(doc) && !/0[01]:00/.test(doc), doc);
}

// --- R27: a real timestamp still carries its time ----------------------------
{
  const f = fixture({ state: { updated: '2026-09-08T18:36:23' } });
  renderAll({ projectDir: f.projectDir });
  check('R27 a full timestamp keeps its time', /actualizado 08\/09 18:36/.test(read(f.live())), read(f.live()));
}

// --- R28: the cursor outranks a `phase` that says the build is over ----------
// `phase` names the last stage COMPLETED, so "build" means the build is finished.
// It is the field agents most often write as the stage they are IN. When the
// cursor still has tasks left, the two cannot both be true.
{
  const f = fixture({ state: { phase: 'build', buildCursor: 'T1' } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R28 the build is shown in flight, not finished', /\*\*Fase 4 de 7 · build\*\*/.test(doc), doc);
  check('R28 and build is not ticked off', /- \[ \] \*\*build\*\* ← aqui/.test(doc), doc);
  check('R28 and the page says it overrode the field', /página seguiu o cursor/.test(doc), doc);
}

// --- R29: and it does not fire when the build really is over -----------------
{
  const f = fixture({ state: { phase: 'build', buildCursor: 'T3' } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R29 a finished build moves on to tests', /\*\*Fase 5 de 7 · tests\*\*/.test(doc), doc);
  check('R29 and says nothing about overriding', !/página seguiu o cursor/.test(doc), doc);
}

// --- R30: a task over the size cap is split into T<id>.1, T<id>.2 ------------
// A task that already arrived split from the idea (T11.8) splits again into
// T11.8.1 / T11.8.2, so the id takes any number of decimal parts.
{
  const plan = [
    '## T11.7 · Já cabia no teto',
    '## T11.8.1 · Primeira metade',
    '## T11.8.2 · Segunda metade',
    '## T12 · Seguinte',
    '## 2026.09 · Uma data não é uma task',
  ].join('\n');
  const f = fixture({ plan, state: { buildCursor: 'T11.8.1' } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R30 two-level subtask ids are found', /## Tarefas — 2 de 4/.test(doc), doc && doc.match(/## Tarefas.*/));
  check('R30 T11.8.1 counts as landed', /- \[x\] T11\.8\.1 · Primeira metade/.test(doc));
  check('R30 T11.8.2 is the one in flight', /- \[ \] \*\*T11\.8\.2 · Segunda metade\*\* ← aqui/.test(doc));
  check('R30 a heading without a letter prefix is not a task', !doc.includes('Uma data'));
}

// --- R31: the widened id pattern stays linear on a hostile heading ----------
// The plan is written by an agent and edited by hand; a pathological heading
// must not hang the Stop hook that runs this renderer.
{
  const hostile = '## T1' + '.1'.repeat(50000) + 'x'.repeat(10) + ' no separator';
  const f = fixture({ plan: [hostile, '## T2 · Real'].join('\n'), state: { buildCursor: 'T2' } });
  const started = Date.now();
  renderAll({ projectDir: f.projectDir });
  const elapsed = Date.now() - started;
  const doc = read(f.live());
  check('R31 a 100k-char dotted heading renders in under a second', elapsed < 1000, `${elapsed} ms`);
  check('R31 and is not taken for a task', /## Tarefas — 1 de 1/.test(doc), doc && doc.match(/## Tarefas.*/));
}

// --- R32: the plan's own state lines are the truth, discovered tasks included --
// A real run: 39 ticks in the plan, cursor on D4 — a task of
// `## Tarefas descobertas`, which is a list item and not a heading — and the page
// showed all 35 tasks unticked.
const REAL_PLAN = [
  '## T1 — Pré-voo',
  '- [x] **Feito** — sem commit',
  '- [ ] Ramo confirmado',
  '## T2 — Entidades',
  '',
  '- [x] **Feito** — build `abc` · segurança `def`',
  '## T3 — Consultas',
  '**Descrição:** ainda por fazer.',
  '- [x] **(+)** um critério de aceitação, não o estado da tarefa',
  '## Checkpoint A — antes do PR',
  '## Tarefas descobertas',
  '',
  'Trabalho encontrado durante a execução.',
  '',
  '- [x] **D1** · **Alargar a coluna, com migração nova.**',
  '  Encontrado ao fazer a T2.',
  '- [ ] **D2** · Rever o índice',
].join('\n');
{
  const f = fixture({ plan: REAL_PLAN, state: { buildCursor: 'D1' } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R32 a cursor on a discovered task still locates', /## Tarefas — 3 de 5/.test(doc), doc && doc.match(/## Tarefas.*/));
  check('R32 ticked tasks stay ticked', /- \[x\] T1 · Pré-voo/.test(doc) && /- \[x\] T2 · Entidades/.test(doc), doc);
  check('R32 discovered tasks are listed, bold stripped', /- \[x\] D1 · Alargar a coluna, com migração nova\./.test(doc), doc);
  check('R32 the next open task after the cursor is "aqui"', /- \[ \] \*\*D2 · Rever o índice\*\* ← aqui/.test(doc), doc);
  check('R32 and no warning that the cursor names no task', !/não nomeia uma destas tarefas/.test(doc), doc);
}

// --- R32b: a cursor on a task not yet ticked is the task in flight -----------
// Live runs park the cursor on the task being built
// (D4, T14, T15, each still unticked), not on the last one that landed.
{
  const f = fixture({ plan: REAL_PLAN, state: { buildCursor: 'D2' } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R32b the open task the cursor names is "aqui"', /- \[ \] \*\*D2 · Rever o índice\*\* ← aqui/.test(doc), doc);
  check('R32b not the first open task of the plan', !/\*\*T3 · Consultas\*\* ← aqui/.test(doc), doc);
}

// --- R33: an acceptance checkbox inside an open task never ticks it ----------
{
  const f = fixture({ plan: REAL_PLAN, state: { buildCursor: 'D1' } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R33 T3 is open although its section holds a ticked criterion', /- \[ \] T3 · Consultas/.test(doc), doc);
  check('R33 a checkpoint is still not a task', !doc.includes('Checkpoint A'), doc);
}

// --- R34: a task waiting on the user's answer is shown pending, not done ----
{
  const f = fixture({
    plan: REAL_PLAN,
    state: { buildCursor: 'T2', pendingTasks: [{ id: 'T3', question: 'Qual das pernas conta o custo?' }, { id: 'T99', question: 'inventada' }] },
  });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R34 the pending task is marked and says what it waits on', /- \[ \] ⏸ T3 · Consultas — \*\*pendente resposta\*\*: Qual das pernas conta o custo\?/.test(doc), doc);
  check('R34 the count says how many are pending', /## Tarefas — 3 de 5 · 1 pendente$/m.test(doc), doc && doc.match(/## Tarefas.*/));
  check('R34 "Agora" steps over the pending task', /- \[ \] \*\*D2 · Rever o índice\*\* ← aqui/.test(doc), doc);
  check('R34 an unknown pending id invents nothing', !doc.includes('T99') && !doc.includes('inventada'), doc);
}

// --- R35: a pending question is plain text on the page -----------------------
// state.json is repository data: a question carrying markup or a link must not
// forge a heading or a link on a page read as generated truth.
{
  const f = fixture({
    plan: REAL_PLAN,
    state: { buildCursor: 'T2', pendingTasks: [{ id: 'T3', question: 'ver [aqui](https://evil.example/x) <b>já</b>\n## Falso heading' }] },
  });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('R35 no link survives', !doc.includes('evil.example') && !doc.includes('[aqui]'), doc);
  check('R35 no html survives', !doc.includes('<b>'), doc);
  check('R35 no heading can be forged', !/^## Falso heading/m.test(doc), doc);
}

console.log('\n--- the page language ---');

// --- L1: an English project gets an English page ------------------------------
{
  const f = fixture({ language: 'EN', state: { buildCursor: 'T1', mode: 'auto' } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('L1 the status is in English', /^# demo — running$/m.test(doc), doc && doc.split('\n')[8]);
  check('L1 the phase line is in English', /\*\*Phase 4 of 7 · build\*\* · task 2 of 3/.test(doc), doc);
  check('L1 the task count is in English', /## Tasks — 1 of 3/.test(doc), doc && doc.match(/## Tasks.*/));
  check('L1 the mode is in English', /auto mode/.test(doc), doc);
  check('L1 and no Portuguese label leaks in', !/Fase|Tarefas|Agora|modo auto/.test(doc), doc);
}

// --- L2: a language with no page table falls back to English ------------------
{
  const f = fixture({ language: 'fr' });
  const out = renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('L2 an unsupported page language still renders', doc !== null, JSON.stringify(out.skipped));
  check('L2 and it renders in English', /## Phases/.test(doc || ''), doc);
}

// --- L3: the discovered-tasks section is found in English too ----------------
{
  const plan = [
    '## T1 — First',
    '- [x] **Done** — build `abc`',
    '## Discovered tasks',
    '',
    '- [x] **D1** · Widen the column',
    '- [ ] **D2** · Review the index',
  ].join('\n');
  const f = fixture({ language: 'EN', plan, state: { buildCursor: 'D2' } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('L3 English discovered tasks are listed', /- \[x\] D1 · Widen the column/.test(doc), doc);
  check('L3 and counted', /## Tasks — 2 of 3/.test(doc), doc && doc.match(/## Tasks.*/));
}

// --- L4: a plan written in one language keeps rendering in the other ---------
{
  const plan = ['## T1 — Primeira', '- [x] **Feito**', '## Tarefas descobertas', '', '- [ ] **D1** · Nova'].join('\n');
  const f = fixture({ language: 'EN', plan, state: { buildCursor: 'D1' } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('L4 a Portuguese plan in an English project still finds its discovered tasks', /D1 · Nova/.test(doc), doc);
}

console.log('\n--- free text out of state.json, again ---');

// --- S13: the branch is shown in a code span it cannot break out of -----------
{
  const f = fixture({ state: { branch: 'feature/x` **terminada** [PR](http://evil.example) `' } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('S13 a hostile branch cannot forge a link', !doc.includes('evil.example'), doc);
  check('S13 and cannot close its code span', (doc.match(/branch `[^`]*`/) || [''])[0].split('`').length === 3, doc);
}

// --- S14: approvedBy is text, not markup ----------------------------------------
{
  const f = fixture({ state: { approvedBy: 'user\n\n# forjado\n[x](http://evil.example)', approvedAt: '2026-09-08T10:00:00' } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('S14 a hostile approvedBy cannot forge a heading', !/^# forjado$/m.test(doc), doc);
  check('S14 and cannot forge a link', !doc.includes('evil.example'), doc);
  check('S14 and the harmless part survives', /aprovado por user/.test(doc), doc);
}

// --- S15: the outcome and its note are text, not markup -------------------------
{
  const f = fixture({
    state: { phase: 'done', status: 'done', outcome: 'ok`\n## Forjado', outcomeNote: 'nota\n\n# outra [x](http://evil.example)' },
    questions: '- [ ] aberta\n',
  });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('S15 a hostile outcome cannot forge a heading', !/^## Forjado$/m.test(doc) && !/^# outra/m.test(doc), doc);
  check('S15 and cannot forge a link', !doc.includes('evil.example'), doc);
}

// --- S16: an artifact key is a label, not markup ----------------------------------
{
  const f = fixture();
  const statePath = path.join(f.projectDir, 'docs', 'pipeline', 'demo', 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  fs.writeFileSync(path.join(f.docsDir, 'ideas', 'extra.md'), '# extra');
  state.artifacts['review](http://evil.example) [x'] = 'ideas/extra.md';
  fs.writeFileSync(statePath, JSON.stringify(state));
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('S16 a hostile artifact key cannot forge a link', !doc.includes('evil.example'), doc);
}

// --- S17: a pendingDecisions that is not a number is not echoed -------------------
{
  const f = fixture({ state: { pendingDecisions: '2\n\n# forjado' } });
  renderAll({ projectDir: f.projectDir });
  const doc = read(f.live());
  check('S17 a non-numeric pendingDecisions is not printed', !/forjado/.test(doc), doc);
}

// --- S20: a page a person wrote in runs/ is never swept -------------------------
// Security: the sweep deletes files. Only pages this renderer generated qualify,
// whatever their name.
{
  const f = fixture();
  fs.mkdirSync(f.archiveDir, { recursive: true });
  fs.writeFileSync(path.join(f.liveDir, '260101_demo.md'), 'my own notes, same suffix');
  fs.writeFileSync(path.join(f.archiveDir, '260102_demo.md'), 'more of my notes');
  renderAll({ projectDir: f.projectDir });
  check('S20 a hand-written file with the run suffix survives in runs/', fs.existsSync(path.join(f.liveDir, '260101_demo.md')));
  check('S20 and in runs/finished/', fs.existsSync(path.join(f.archiveDir, '260102_demo.md')));
  check('S20 the page of the run is still written', fs.existsSync(f.live()));
}

// --- S21: an untrusted docsDir outside the project renders nothing -------------
{
  const f = fixture();
  fs.rmSync(path.join(process.env.HOME, '.claude', 'task-flow-trusted.json'), { force: true });
  const out = renderAll({ projectDir: f.projectDir });
  check('S21 an untrusted docsDir outside the project renders nothing', out.rendered.length === 0 && out.archived.length === 0);
  check('S21 and no runs/ folder is created there', !fs.existsSync(f.liveDir));
  check('S21 and the reason says it is not trusted', /not trusted/.test((out.skipped[0] || {}).why || ''), JSON.stringify(out.skipped));
}

// --- S22: a plan heading cannot put markup on the page ----------------------
// Security: task titles come from the plan, a file anyone with the docs folder can
// write. The page is read as generated truth.
{
  const f = fixture({ plan: '## T1 · <img src=x onerror=alert(1)> [click me](javascript:alert(1)) ![](https://attacker.example/p.png)\n\n- [ ] estado\n' });
  renderAll({ projectDir: f.projectDir });
  const page = fs.readFileSync(f.live(), 'utf8');
  check('S22 no HTML tag from a heading', !/<img/i.test(page), page);
  check('S22 no link from a heading', !/\]\(javascript/i.test(page), page);
  check('S22 no image or remote URL from a heading', !/!\[|attacker\.example/.test(page), page);
}

// --- S23: a file name cannot end a link and start another --------------------
{
  const f = fixture();
  const name = 'a) [PR approved](evil.html) (b.md';
  fs.writeFileSync(path.join(f.docsDir, 'ideas', name), '# x');
  const statePath = path.join(f.projectDir, 'docs', 'pipeline', 'demo', 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  fs.writeFileSync(statePath, JSON.stringify({ ...state, artifacts: { ...state.artifacts, review: `ideas/${name}` } }));
  renderAll({ projectDir: f.projectDir });
  const page = fs.readFileSync(f.live(), 'utf8');
  check('S23 a ")" in a file name does not forge a second link', !/\[PR approved\]\(/.test(page), page);
}

// --- S24: runs whose names end alike keep their own pages --------------------
{
  const f = fixture({ slug: 'b' });
  const other = path.join(f.projectDir, 'docs', 'pipeline', 'a_b');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'state.json'), JSON.stringify({
    task: 'a_b', phase: 'plan', status: 'running', created: '2026-09-08', updated: '2026-09-08T18:36:23Z',
  }));
  renderAll({ projectDir: f.projectDir });
  check('S24 run a_b keeps its page when run b renders', fs.existsSync(path.join(f.liveDir, '260908_a_b.md')), ls(f.liveDir).join(','));
  check('S24 and run b has its own', fs.existsSync(path.join(f.liveDir, '260908_b.md')), ls(f.liveDir).join(','));
}

// --- S25: runs/ as a link is never written through ----------------------------
{
  const f = fixture();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-render-link-'));
  fs.symlinkSync(elsewhere, f.liveDir, 'junction');
  const out = renderAll({ projectDir: f.projectDir });
  check('S25 nothing is rendered through a linked runs/', out.rendered.length === 0 && out.archived.length === 0, JSON.stringify(out));
  check('S25 and the link target is untouched', fs.readdirSync(elsewhere).length === 0, fs.readdirSync(elsewhere).join(','));
}

// --- S26: a plan reached through a link is not read -------------------------
{
  const f = fixture({ plan: null });
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-render-linkplan-'));
  fs.writeFileSync(path.join(elsewhere, '260908_demo.plan.md'), '## T1 · SEGREDO ATRAVES DE LIGACAO\n');
  fs.rmSync(path.join(f.docsDir, 'plans'), { recursive: true, force: true });
  fs.symlinkSync(elsewhere, path.join(f.docsDir, 'plans'), 'junction');
  renderAll({ projectDir: f.projectDir });
  const page = fs.existsSync(f.live()) ? fs.readFileSync(f.live(), 'utf8') : '';
  check('S26 a plan behind a link is not pasted into the page', !/SEGREDO/.test(page), page);
}

// --- F: the feed for the panel ------------------------------------------------
// One summary per project in <LOCALAPPDATA>/task-flow/feed/ (TEST_HOME here). The
// panel reads nothing else, so what matters is what it contains - and what it
// must not: the absolute docs folder, or anything written where the promise
// says the panel has no business.

const { projectKey } = require('../plugin/scripts/config.js');
const feedFile = (projectDir) => path.join(TEST_HOME, 'task-flow', 'feed', `${projectKey(projectDir)}.json`);
const readFeed = (projectDir) => JSON.parse(fs.readFileSync(feedFile(projectDir), 'utf8'));

{
  const f = fixture({
    state: {
      status: 'blocked',
      mode: 'auto',
      buildCursor: 'T2',
      pendingTasks: [{ id: 'T3', question: 'Which currency?' }, { id: '../x', question: 'bad id' }],
      phaseChangedAt: '2026-09-08T18:00:00Z',
      pr: 'https://github.com/o/r/pull/1',
    },
    questions: '# q\n- [ ] one\n- [ ] two\n- [x] three\n',
  });
  const outcome = renderAll({ projectDir: f.projectDir });
  const feed = fs.existsSync(feedFile(f.projectDir)) ? readFeed(f.projectDir) : null;
  const run = feed && feed.runs[0];
  check('F1 every render writes the project feed', feed && feed.version === 1 && outcome.feed === feedFile(f.projectDir), JSON.stringify(outcome));
  check('F2 the run is there in closed shapes', run && run.slug === 'demo' && run.status === 'blocked' && run.mode === 'auto' && run.buildCursor === 'T2' && run.phase === 'plan', JSON.stringify(run));
  check('F3 with its plan tasks and only well-formed pending ids', run && run.tasks.length === 3 && run.tasks[0].id === 'T1' && run.pendingTasks.length === 1 && run.pendingTasks[0].id === 'T3', JSON.stringify(run && run.pendingTasks));
  check('F4 hand-written questions become a count', run && run.questions.source === 'legacy' && run.questions.open === 2, JSON.stringify(run && run.questions));
  check('F5 the run page is given relative to the docs folder', run && run.runPage === 'runs/260908_demo.md', run && run.runPage);
  const text = fs.readFileSync(feedFile(f.projectDir), 'utf8');
  check('F6 SECURITY the absolute docs folder is not in the feed', !text.toLowerCase().includes(f.docsDir.toLowerCase()) && !text.includes(JSON.stringify(f.docsDir).slice(1, -1)), f.docsDir);
  check('F7 no temp file is left behind', fs.readdirSync(path.dirname(feedFile(f.projectDir))).every((name) => !name.endsWith('.tmp')));
}

{
  const f = fixture({});
  const runDir = path.join(f.projectDir, 'docs', 'pipeline', 'demo');
  fs.writeFileSync(path.join(runDir, 'questions.json'), JSON.stringify({
    version: 1, slug: 'demo', items: [{ id: 'Q1', kind: 'question', title: 'Which currency?', options: [{ id: 'eur', label: 'EUR' }] }],
    consumedSubmissions: ['20260927T201500Z-a1b2c3d4'],
  }));
  renderAll({ projectDir: f.projectDir });
  const run = readFeed(f.projectDir).runs[0];
  check('F8 questions kept as data go into the feed whole, with what was consumed', run.questions.source === 'json' && run.questions.items[0].id === 'Q1' && run.questions.consumedSubmissions[0] === '20260927T201500Z-a1b2c3d4', JSON.stringify(run.questions));

  fs.writeFileSync(path.join(runDir, 'questions.json'), JSON.stringify({ version: 1, slug: 'demo', items: [{ id: 'Q1', kind: 'question', title: 'x', evil: '<script>' }] }));
  renderAll({ projectDir: f.projectDir });
  const invalid = readFeed(f.projectDir).runs[0].questions;
  check('F9 SECURITY an invalid questions.json never reaches the panel', invalid.source === 'invalid' && !('items' in invalid), JSON.stringify(invalid));
}

{
  const f = fixture({ state: { status: 'weird<b>', mode: 'AUTO ', pr: 'javascript:alert(1)', branch: 'x\n## forged', updated: 'yesterday', buildCursor: '<T1>' } });
  renderAll({ projectDir: f.projectDir });
  const run = readFeed(f.projectDir).runs[0];
  check('F10 SECURITY state.json values are reduced to closed shapes', run.status === 'paused' && run.mode === 'auto' && run.pr === null && run.updated === null && run.buildCursor === null && !/\n|<|>/.test(run.branch || ''), JSON.stringify(run));

  fs.writeFileSync(path.join(f.projectDir, 'docs', 'pipeline', 'demo', 'state.json'), '{ broken');
  fs.mkdirSync(path.join(f.projectDir, 'docs', 'pipeline', 'other'), { recursive: true });
  fs.writeFileSync(path.join(f.projectDir, 'docs', 'pipeline', 'other', 'state.json'), JSON.stringify({ phase: 'spec', status: 'running', created: '2026-09-08' }));
  renderAll({ projectDir: f.projectDir });
  const runs = readFeed(f.projectDir).runs;
  check('F11 an unreadable state.json is listed as unreadable and does not hide the others', runs.some((r) => r.slug === 'demo' && r.unreadable) && runs.some((r) => r.slug === 'other' && r.status === 'running'), JSON.stringify(runs));
}

/** Runs `fn` with LOCALAPPDATA/XDG_STATE_HOME pointing at `base`, then restores them. */
function withHomeBase(base, fn) {
  const saved = [process.env.LOCALAPPDATA, process.env.XDG_STATE_HOME];
  process.env.LOCALAPPDATA = base;
  process.env.XDG_STATE_HOME = base;
  try {
    return fn();
  } finally {
    [process.env.LOCALAPPDATA, process.env.XDG_STATE_HOME] = saved;
  }
}

{
  const f = fixture({});
  const outcome = withHomeBase(path.join(f.projectDir, 'local'), () => renderAll({ projectDir: f.projectDir }));
  check('F12 SECURITY a local state folder inside the project gets no feed', !fs.existsSync(path.join(f.projectDir, 'local', 'task-flow')) && /overlap/.test(outcome.feedError || ''), JSON.stringify(outcome));
  check('F13 and the documentation is rendered all the same', fs.existsSync(f.live()), f.live());
}

{
  const f = fixture({});
  const outcome = withHomeBase(path.join(f.docsDir, 'local'), () => renderAll({ projectDir: f.projectDir }));
  check('F14 SECURITY a local state folder inside the docs folder gets no feed', !fs.existsSync(path.join(f.docsDir, 'local', 'task-flow')) && /overlap/.test(outcome.feedError || ''), JSON.stringify(outcome));
}

{
  const f = fixture({});
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-feedbase-'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-feedelsewhere-'));
  fs.mkdirSync(path.join(base, 'task-flow'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(base, 'task-flow', 'feed'), 'junction');
  const outcome = withHomeBase(base, () => renderAll({ projectDir: f.projectDir }));
  check('F15 SECURITY a feed folder that is a link gets nothing written behind it', fs.readdirSync(elsewhere).length === 0 && /link/.test(outcome.feedError || '') && fs.existsSync(f.live()), JSON.stringify(outcome));
}

{
  const f = fixture({});
  const saved = [process.env.LOCALAPPDATA, process.env.XDG_STATE_HOME, process.env.HOME];
  delete process.env.LOCALAPPDATA;
  let outcome;
  try {
    outcome = process.platform === 'win32' ? renderAll({ projectDir: f.projectDir }) : { feedError: 'n/a', skipped: [] };
  } finally {
    [process.env.LOCALAPPDATA, process.env.XDG_STATE_HOME, process.env.HOME] = saved;
  }
  check('F16 no local state folder at all: a note, and the pages still render', /LOCALAPPDATA|n\/a/.test(outcome.feedError || '') && fs.existsSync(f.live()), JSON.stringify(outcome));
}

// --- report -----------------------------------------------------------------
const total = passed + failures.length;
console.log(`\n${passed}/${total} passed`);
if (failures.length) {
  console.log(`${failures.length} failing:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
