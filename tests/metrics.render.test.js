#!/usr/bin/env node
// Tests for plan T8: renderAll closes a finished run through metrics.js (spec R4) and the
// run page gains the "Run health" section (spec R8). What they hold: the run is closed
// once and only when phase is "done" (never on status alone), the section prints ONLY
// numbers formatted by the code, fixed sentences and the validated model name in a
// code span (the page is also read by the model), a run without a row keeps a page
// byte-identical to the one without this feature, TASK_FLOW_METRICS=off removes both
// the close and the section, and a metrics failure never fails or changes a render.
// Everything is synthetic under a throwaway HOME.
//
// Run: node tests/metrics.render.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-mrender-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.LOCALAPPDATA = TEST_HOME;
process.env.XDG_STATE_HOME = TEST_HOME;
delete process.env.TASK_FLOW_METRICS;
delete process.env.TASK_FLOW_GATE;

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log(`  ok  ${name}`); }
  else { failures.push(`${name}${detail ? ` - ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`); }
}

const { renderAll, buildDocument } = require('../plugin/scripts/render-run.js');

const PROJECT = path.join(TEST_HOME, 'work', 'proj');
const DOCS = path.join(PROJECT, 'docs');
const STATE = path.join(PROJECT, '.claude', 'task-flow');
const HISTORY = path.join(STATE, 'metrics.jsonl');
const SLUG = 'my-run';
const PAGE = path.join(DOCS, 'runs', `260929_${SLUG}.md`);
const PAGE_DONE = path.join(DOCS, 'runs', 'finished', `260929_${SLUG}.md`);
const CLOSED = '2026-09-29T12:00:00Z';
const MODEL = 'claude-opus-5-5';

const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); };
const config = (language) => put(path.join(PROJECT, '.claude', 'task-flow.json'), { docsDir: 'docs', language, tasksFile: 'tasks.md' });
put(path.join(DOCS, 'tasks.md'), '# tasks\n');
put(path.join(DOCS, 'plans', 'p.plan.md'), '# Plan\n\n## T1 · first\n- [x] **Done** — built\n');
put(path.join(DOCS, 'other', 'extra.md'), '# extra\n');

const state = (extra) => ({
  task: SLUG, mode: 'auto', phase: 'done', status: 'done', approvedBy: 'x', created: '2026-09-29',
  updated: CLOSED, phaseChangedAt: CLOSED, startedAt: '2026-09-29T09:00:00Z', size: { points: 3 },
  artifacts: { plan: 'plans/p.plan.md', extra: 'other/extra.md' }, outcome: 'merged', ...extra,
});
function reset(s, language = 'PT-PT') {
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.rmSync(path.join(DOCS, 'runs'), { recursive: true, force: true });
  config(language);
  put(path.join(STATE, SLUG, 'state.json'), s);
}
const page = () => (fs.existsSync(PAGE) ? fs.readFileSync(PAGE, 'utf8') : fs.existsSync(PAGE_DONE) ? fs.readFileSync(PAGE_DONE, 'utf8') : null);
const lines = () => (fs.existsSync(HISTORY) && fs.statSync(HISTORY).isFile() ? fs.readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean) : []);

function row(run, over = {}) {
  return {
    v: 1, run, created: '2026-09-29', closedAt: '2026-09-29T10:00:00Z', outcome: 'done', mode: 'auto',
    primaryModel: MODEL, models: [MODEL], sizePoints: 3,
    tasks: { total: 4, done: 4, skipped: 0, pending: 0, retries: 0, firstTime: 4 },
    tests: { greenFirstRun: true },
    review: { critical: 0, required: 0, optional: 0, nit: 0 }, hardenFindings: 0,
    questions: { total: 0, open: 0, explained: 0, maxRound: 0 },
    code: { added: 100, removed: 10, files: 4, testAdded: 50, codeAdded: 50 },
    tokens: { input: 1000, cacheCreate: 8000, cacheRead: 90000, output: 1000, cacheHitRate: 0.9, byPhase: {} },
    tokensNull: null,
    agent: { requests: 40, toolCalls: 40, toolErrors: 0, contextPeak: 60000 },
    ...over,
  };
}
const seed = (rows) => put(HISTORY, `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`);
const base = (count) => Array.from({ length: count }, (_, i) => row(`base-${i}`, { closedAt: `2026-09-2${i}T10:00:00Z` }));
const own = (over) => row(SLUG, { closedAt: CLOSED, ...over });
const otherModel = (rows) => rows.map((x) => ({ ...x, primaryModel: 'other-model', models: ['other-model'] }));
const HIGH_CALLS = { agent: { requests: 40, toolCalls: 400, toolErrors: 0, contextPeak: 60000 } };

// --- 1. the close, once (M-R4.1) and only on phase === done (spec, note d) -----------------
reset(state());
const before = renderAll({ projectDir: PROJECT });
check('render still lists the run', before.rendered.length + before.archived.length === 1, JSON.stringify(before));
check('a done run with startedAt and no row is closed by the render: one line', lines().length === 1 && JSON.parse(lines()[0]).run === SLUG);
renderAll({ projectDir: PROJECT });
check('a second render adds no line (M-R4.1)', lines().length === 1);
check('no metricsError on the happy path', before.metricsError === undefined);
check('the same render already shows the section (closed BEFORE building the page)', page().includes('## Saúde da run'));
check('no tokens: the fixed reason phrase (transcripts missing)', page().includes('Tokens não medidos: não há transcripts.'), page());
check('no model, no base: fixed phrase, no invention', page().includes('Sem veredicto: não há base para este modelo.'));

reset(state({ phase: 'review', status: 'done' }));
renderAll({ projectDir: PROJECT });
check('status "done" with phase "review" is not closed (spec, not isDone)', lines().length === 0 && !page().includes('Saúde da run'));
reset(state({ phase: 'build', status: 'running' }));
renderAll({ projectDir: PROJECT });
check('a running run is not closed and has no section', lines().length === 0 && !page().includes('Saúde da run'));

// --- 2. M-R8.3 / M-R5.3: no row means the page of today, byte for byte ---------------------
const noStart = state(); delete noStart.startedAt;
reset(noStart);
renderAll({ projectDir: PROJECT });
const withoutFeature = page();
check('done without startedAt: no line, no section (M-R4.3)', lines().length === 0 && !withoutFeature.includes('Saúde da run'));
reset(state({ health: { x: 1 }, phaseLog: [{ p: 'spec' }] }));
process.env.TASK_FLOW_METRICS = 'off';
renderAll({ projectDir: PROJECT });
const off = page();
delete process.env.TASK_FLOW_METRICS;
check('METRICS=off: no close, no section (M-R9.4)', lines().length === 0 && !off.includes('Saúde da run'));
check('page identical with and without startedAt/phaseLog/health (M-R5.3)', off === withoutFeature);

// --- 3. the section per case, pt-PT and en (M-R8.1) ------------------------------------------
function rendered(rows, language = 'PT-PT', stateExtra = {}) {
  reset(state(stateExtra), language);
  seed(rows);
  renderAll({ projectDir: PROJECT });
  return page();
}
const section = (text) => text.slice(Math.max(text.indexOf('## Saúde da run'), text.indexOf('## Run health'), 0));

let text = rendered([...base(5), own(HIGH_CALLS)]);
check('with verdict: table header, note with n', text.includes('Métrica | Esta run | Mediana | Veredicto') && text.includes('Informativo, nunca bloqueia. Base: mediana das últimas 8 runs concluídas deste projeto com o mesmo modelo.'), section(text));
check('with verdict: the deviating metric says desvio, another says ok', /Passos por task[^\n]*desvio/.test(text) && /Pico de contexto[^\n]*\| ok \|/.test(text), section(text));
check('the model is printed, in a code span', text.includes(`\`${MODEL}\``));
check('tokens scope note when tokens exist', text.includes('Os tokens são só dos subagentes; o orquestrador não conta.'));
check('cache hit is a percentage', text.includes('90%'));
text = rendered([...base(5), own(HIGH_CALLS)], 'EN');
check('en: heading, verdict word and note', text.includes('## Run health') && /Tool calls per task[^\n]*deviation/.test(text) && text.includes('Informational, never blocks. Baseline: median of the last 8 finished runs of this project on the same model.'), section(text));
text = rendered([...base(5), own()], 'FR');
check('fr falls back to English (M-R8.2)', text.includes('## Run health') && !text.includes('Saúde'));

text = rendered([...base(4), own()]);
check('4 runs in the base: the phrase with counts (pt-PT)', text.includes('Sem veredicto: 4 de 5 runs na base.'), section(text));
check('4 runs in the base: no table of verdicts', !text.includes('desvio'));
text = rendered([...base(4), own()], 'EN');
check('4 runs in the base (en)', text.includes('No verdict: 4 of 5 runs in the baseline.'));
text = rendered([...otherModel(base(5)), own()]);
check('no base for this model (pt-PT)', text.includes('Sem veredicto: não há base para este modelo.'));
text = rendered([...otherModel(base(5)), own()], 'EN');
check('no base for this model (en)', text.includes('No verdict: no baseline for this model.'));

const REASONS = {
  'no-transcripts': ['não há transcripts', 'no transcripts'],
  'unreadable-format': ['formato dos transcripts não reconhecido', 'transcript format not recognised'],
  overlap: ['outra run em simultâneo no projeto', 'another run at the same time in the project'],
  'no-window': ['run sem hora de início', 'run without a start time'],
  timeout: ['leitura demasiado longa', 'reading took too long'],
  disabled: ['desativado', 'disabled'],
};
for (const [code, [pt, en]] of Object.entries(REASONS)) {
  const withNull = own({ tokens: null, tokensNull: code });
  const ptText = rendered([...base(5), withNull]);
  check(`tokensNull ${code}: pt-PT fixed phrase, no tokens scope note`, ptText.includes(`Tokens não medidos: ${pt}.`) && !ptText.includes('o orquestrador não conta'));
  check(`tokensNull ${code}: en fixed phrase`, rendered([...base(5), withNull], 'EN').includes(`Tokens not measured: ${en}.`));
}

text = rendered([...base(5), own({ outcome: 'failed' })], 'PT-PT', { status: 'failed' });
check('failed run: the neutral sentence (pt-PT)', text.includes('Esta run terminou como falhada (PR em rascunho); valores sem veredicto.'), section(text));
check('failed run: nothing about red tests, no deviation', !/vermelh/i.test(section(text)) && !/desvio/.test(section(text)));
text = rendered([...base(5), own({ outcome: 'failed' })], 'EN', { status: 'failed' });
check('failed run (en): the neutral sentence, no "red"', text.includes('This run ended as failed (draft PR); values shown, no verdict.') && !/\bred\b/i.test(section(text)));

// --- 4. order: after the artifacts, before the outcome ------------------------------------------
text = rendered([...base(5), own()]);
const at = (needle) => text.indexOf(needle);
check('section sits after "Outros artefactos" and before "Desfecho"', at('## Outros artefactos') >= 0 && at('## Outros artefactos') < at('## Saúde da run') && at('## Saúde da run') < at('## Desfecho'), text);

// --- 5. hostile input never reaches the page (M-R8.4, M-R10.3, M-R10.4) ---------------------
const evil = '# forged | `x` <script>alert(1)</script> [a](http://evil.example) IGNORE PREVIOUS';
reset(state());
put(HISTORY, `${[
  ...base(5).map((x) => JSON.stringify(x)),
  JSON.stringify(row('bad-one', { primaryModel: evil, models: [evil] })),
  JSON.stringify({ ...row('bad-two'), agent: { requests: evil, toolCalls: evil, toolErrors: 0, contextPeak: 1 } }),
  evil,
  JSON.stringify(own()),
].join('\n')}\n`);
renderAll({ projectDir: PROJECT });
const hostile = page();
check('hostile lines in the history: nothing of them on the page', !hostile.includes('forged') && !hostile.includes('script') && !hostile.includes('evil.example') && !hostile.includes('IGNORE'));
check('the page carries no absolute path of the machine (M-R10.4)', !hostile.includes(TEST_HOME) && !hostile.includes(PROJECT) && !hostile.includes(DOCS));

const args = { state: state(), slug: SLUG, tasks: [], questions: null, openQuestions: 0, depth: 1, artifacts: {}, created: '2026-09-29', lang: 'en' };
const injected = buildDocument({ ...args, health: { row: own({ primaryModel: 'x`\n## forged <b>' }), baseline: { hasVerdict: false, reason: 'no-model-base', have: 0, min: 5, n: 8, metrics: [] } } });
check('a hostile model name cannot start a line or a tag', !/^## forged/m.test(injected) && !injected.includes('<b>'));
const junk = buildDocument({ ...args, health: { row: { nonsense: evil }, baseline: { hasVerdict: true, reason: evil, have: evil, min: evil, n: evil, metrics: [{ id: evil, value: evil, median: evil, verdict: evil }] } } });
check('a malformed health object prints no text of its own', !junk.includes('forged') && !junk.includes('script') && !junk.includes('evil.example'));
check('health null: no section', !buildDocument({ ...args, health: null }).includes('Run health'));
check('a run that is not done never shows the section', !buildDocument({ ...args, state: state({ phase: 'build' }), health: { row: own(), baseline: { hasVerdict: false, reason: 'too-few', have: 1, min: 5, n: 8, metrics: [] } } }).includes('Run health'));

// --- 6. a metrics failure never fails or changes a render (M-R9.1) --------------------------
reset(state());
process.env.TASK_FLOW_METRICS = 'off';
const plain = renderAll({ projectDir: PROJECT });
const plainPage = page();
delete process.env.TASK_FLOW_METRICS;
reset(state());
fs.mkdirSync(HISTORY, { recursive: true }); // metrics.jsonl as a folder: the history path is refused
const failing = renderAll({ projectDir: PROJECT });
check('history path refused: the page is still rendered', failing.rendered.length + failing.archived.length === plain.rendered.length + plain.archived.length && failing.skipped.length === 0, JSON.stringify(failing));
check('... metricsError is set, and only to a closed code', typeof failing.metricsError === 'string' && /^[a-z-]+$/.test(failing.metricsError), String(failing.metricsError));
check('... the page equals the one without the section', page() === plainPage);

// --- 7. the CLI prints a note, exit code untouched ---------------------------------------------
const cli = cp.spawnSync(process.execPath, [path.resolve(__dirname, '../plugin/scripts/render-run.js'), '--quiet', '--project-dir', PROJECT], { encoding: 'utf8', env: { ...process.env } });
check('CLI with a metrics failure: exit 0, stderr note without paths', cli.status === 0 && /metrics not closed: [a-z-]+/.test(cli.stderr) && !cli.stderr.includes(TEST_HOME), `${cli.status} ${cli.stderr}`);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
