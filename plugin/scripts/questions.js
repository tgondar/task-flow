// A run's questions, as data: <stateDir>/<slug>/questions.json.
//
// Why a JSON file and not the markdown alone. The markdown questions file was
// written by hand, and the only thing a machine could read in it was a checkbox:
// no id per question, no options, no answer as a field. That was enough to count
// what was open. It is not enough to show a question as a card with its options,
// to take an answer back from somewhere other than the conversation, or to know
// that an answer was already taken so taking it again does nothing. So the
// questions are data, the agent writes the data, and the markdown the user reads
// is GENERATED from it - for the same reason the run page is generated: a page
// transcribed by hand drifts, and a stale page is believed.
//
// Why it lives in stateDir and not in the docs folder. The approval gate blocks
// every write that is not markdown until a run is approved, and the first
// questions come in the spec, before approval. state.json already lives there for
// the same reason. The markdown still goes to the docs folder, as before.
//
// The file is repository data like state.json: an agent writes it, a person can
// edit it, and answers taken from the panel are appended to it. So it is
// validated before anything is rendered from it, and a file that fails leaves the
// previous markdown alone. The error messages name the field and what shape it
// should have, never the value: they reach the model, and a value is text someone
// else chose.

'use strict';

const PHASES = ['idea', 'spec', 'plan', 'build', 'tests', 'harden', 'review'];
const KINDS = ['decision', 'question'];
const ANSWER_STATUSES = ['ok', 'ko', 'modify'];
const VIA = ['panel', 'conversation'];

const QUESTION_ID = /^Q[1-9][0-9]{0,3}$/;
const OPTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const TASK_ID = /^T[0-9]+[a-z]?$/;
const SUBMISSION_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** How long each kind of text may be. Over the limit is an error, not a silent
 *  cut: a cut answer is a different answer. */
const LIMITS = { title: 300, label: 200, text: 2000, comment: 4000, list: 50 };

/** Line breaks and tabs are fine in prose; every other control character is a
 *  way to make a terminal or a page show something that is not in the file. That
 *  includes the Unicode line separators and the bidirectional overrides, which
 *  reorder what a reader sees without changing what the file says. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2027-\u202E\u2066-\u2069]/;

// --- validation ------------------------------------------------------------

function validator() {
  const errors = [];
  const fail = (where, what) => errors.push(`${where}: ${what}`);

  const onlyKeys = (value, where, allowed) => {
    for (const key of Object.keys(value)) {
      // A key is text too: named only when it looks like an ordinary field name.
      if (!allowed.includes(key)) fail(where, /^[A-Za-z0-9_]{1,40}$/.test(key) ? `unknown field "${key}"` : 'unknown field');
    }
  };
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

  const text = (value, where, limit, { required = false } = {}) => {
    if (value === undefined || value === null) {
      if (required) fail(where, 'is required');
      return;
    }
    if (typeof value !== 'string') return fail(where, 'must be a string');
    if (required && !value.trim()) return fail(where, 'must not be empty');
    if (value.length > limit) return fail(where, `is longer than ${limit} characters`);
    if (CONTROL.test(value)) return fail(where, 'contains control characters');
  };
  const pattern = (value, where, regex, what, { required = false } = {}) => {
    if (value === undefined || value === null) {
      if (required) fail(where, 'is required');
      return;
    }
    if (typeof value !== 'string' || !regex.test(value)) fail(where, `must be ${what}`);
  };
  const oneOf = (value, where, allowed, { required = false } = {}) => {
    if (value === undefined || value === null) {
      if (required) fail(where, 'is required');
      return;
    }
    if (!allowed.includes(value)) fail(where, `must be one of ${allowed.join(', ')}`);
  };
  const list = (value, where) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      fail(where, 'must be a list');
      return [];
    }
    if (value.length > LIMITS.list) fail(where, `has more than ${LIMITS.list} entries`);
    return value;
  };

  return { errors, fail, onlyKeys, isObject, text, pattern, oneOf, list };
}

/**
 * Checks a parsed questions.json against version 1 of the format. Returns
 * `{ ok, errors }`; each error is `<where>: <what is wrong>`, e.g.
 * `items[2].answer.status: must be one of ok, ko, modify`.
 */
function validateQuestions(data) {
  const v = validator();
  if (!v.isObject(data)) return { ok: false, errors: ['(file): must be a JSON object'] };

  v.onlyKeys(data, '(file)', ['version', 'slug', 'created', 'items', 'consumedSubmissions']);
  if (data.version !== 1) v.fail('version', 'must be 1');
  v.pattern(data.slug, 'slug', SAFE_SEGMENT, 'the run folder name', { required: true });
  v.pattern(data.created, 'created', DATE, 'a yyyy-MM-dd date');

  const seen = new Set();
  const items = v.list(data.items, 'items');
  if (data.items === undefined) v.fail('items', 'is required');
  items.forEach((item, index) => {
    const at = `items[${index}]`;
    if (!v.isObject(item)) return v.fail(at, 'must be an object');
    v.onlyKeys(item, at, [
      'id', 'kind', 'phase', 'task', 'title', 'chosen', 'options', 'why', 'ifOverruled',
      'urgent', 'rounds', 'createdAt', 'answer', 'explanations',
    ]);
    v.pattern(item.id, `${at}.id`, QUESTION_ID, 'Q followed by a number', { required: true });
    if (typeof item.id === 'string') {
      if (seen.has(item.id)) v.fail(`${at}.id`, 'is used by another item');
      seen.add(item.id);
    }
    v.oneOf(item.kind, `${at}.kind`, KINDS, { required: true });
    v.oneOf(item.phase, `${at}.phase`, PHASES);
    v.pattern(item.task, `${at}.task`, TASK_ID, 'a task id like T4');
    v.text(item.title, `${at}.title`, LIMITS.title, { required: true });
    v.text(item.chosen, `${at}.chosen`, LIMITS.label);
    v.text(item.why, `${at}.why`, LIMITS.text);
    v.text(item.ifOverruled, `${at}.ifOverruled`, LIMITS.text);
    if (item.urgent !== undefined && typeof item.urgent !== 'boolean') v.fail(`${at}.urgent`, 'must be true or false');
    v.pattern(item.createdAt, `${at}.createdAt`, ISO_TIME, 'an ISO timestamp');
    if (item.kind === 'decision' && !item.chosen) v.fail(`${at}.chosen`, 'is required for a decision');

    const optionIds = new Set();
    v.list(item.options, `${at}.options`).forEach((option, o) => {
      const where = `${at}.options[${o}]`;
      if (!v.isObject(option)) return v.fail(where, 'must be an object');
      v.onlyKeys(option, where, ['id', 'label', 'detail', 'chosen']);
      v.pattern(option.id, `${where}.id`, OPTION_ID, 'a short id (letters, digits, - and _)', { required: true });
      if (typeof option.id === 'string') {
        if (optionIds.has(option.id)) v.fail(`${where}.id`, 'is used by another option');
        optionIds.add(option.id);
      }
      v.text(option.label, `${where}.label`, LIMITS.label, { required: true });
      v.text(option.detail, `${where}.detail`, LIMITS.text);
      if (option.chosen !== undefined && typeof option.chosen !== 'boolean') v.fail(`${where}.chosen`, 'must be true or false');
    });

    v.list(item.rounds, `${at}.rounds`).forEach((round, r) => {
      const where = `${at}.rounds[${r}]`;
      if (!v.isObject(round)) return v.fail(where, 'must be an object');
      v.onlyKeys(round, where, ['round', 'verdict', 'found', 'passages']);
      if (!Number.isInteger(round.round) || round.round < 1 || round.round > 5) v.fail(`${where}.round`, 'must be 1 to 5');
      v.text(round.verdict, `${where}.verdict`, LIMITS.label);
      v.text(round.found, `${where}.found`, LIMITS.text);
      v.list(round.passages, `${where}.passages`).forEach((passage, p) =>
        v.text(passage, `${where}.passages[${p}]`, LIMITS.label, { required: true })
      );
    });

    if (item.answer !== undefined && item.answer !== null) {
      const where = `${at}.answer`;
      const answer = item.answer;
      if (!v.isObject(answer)) {
        v.fail(where, 'must be an object or null');
      } else {
        v.onlyKeys(answer, where, ['status', 'choice', 'comment', 'via', 'submissionId', 'at']);
        v.oneOf(answer.status, `${where}.status`, ANSWER_STATUSES, { required: true });
        v.text(answer.comment, `${where}.comment`, LIMITS.comment);
        v.oneOf(answer.via, `${where}.via`, VIA, { required: true });
        v.pattern(answer.submissionId, `${where}.submissionId`, SUBMISSION_ID, 'a submission id');
        v.pattern(answer.at, `${where}.at`, ISO_TIME, 'an ISO timestamp', { required: true });
        if (answer.choice !== undefined && answer.choice !== null) {
          if (typeof answer.choice !== 'string' || !optionIds.has(answer.choice)) {
            v.fail(`${where}.choice`, 'must be the id of one of the options');
          }
        }
        if (answer.status === 'modify' && !answer.comment && !answer.choice) {
          v.fail(where, 'a change needs a comment or a choice');
        }
      }
    }

    v.list(item.explanations, `${at}.explanations`).forEach((request, e) => {
      const where = `${at}.explanations[${e}]`;
      if (!v.isObject(request)) return v.fail(where, 'must be an object');
      v.onlyKeys(request, where, ['comment', 'via', 'submissionId', 'at', 'reply']);
      v.text(request.comment, `${where}.comment`, LIMITS.comment, { required: true });
      v.oneOf(request.via, `${where}.via`, VIA, { required: true });
      v.pattern(request.submissionId, `${where}.submissionId`, SUBMISSION_ID, 'a submission id');
      v.pattern(request.at, `${where}.at`, ISO_TIME, 'an ISO timestamp', { required: true });
      v.text(request.reply, `${where}.reply`, LIMITS.text);
    });
  });

  // Grows by one per answered submission, so it is not capped like the other lists.
  if (data.consumedSubmissions !== undefined && !Array.isArray(data.consumedSubmissions)) {
    v.fail('consumedSubmissions', 'must be a list');
  }
  (Array.isArray(data.consumedSubmissions) ? data.consumedSubmissions : []).forEach((id, i) =>
    v.pattern(id, `consumedSubmissions[${i}]`, SUBMISSION_ID, 'a submission id', { required: true })
  );

  return { ok: v.errors.length === 0, errors: v.errors };
}

/** An item waits on the user until it has an answer. An explanation request does
 *  not answer it: it asks the agent to say more, and the question stays open. */
const isOpen = (item) => !item.answer;

const openCount = (data) => (data.items || []).filter(isOpen).length;

// --- the generated markdown ------------------------------------------------

const STRINGS = {
  en: {
    title: (slug) => `${slug} — questions and decisions`,
    note: [
      '> Generated by `render-run.js` from the run\'s `questions.json`. **Do not edit by hand** -',
      '> the next render overwrites it. Answer in the conversation or in the task-flow panel.',
    ],
    decisions: '### Decisions taken — to review',
    questions: '### Open questions',
    urgent: '**URGENT**',
    chose: 'I chose',
    others: 'Also on the table',
    options: 'Options',
    why: 'Why',
    overrule: 'If you overrule me',
    phase: 'phase',
    task: 'task',
    round: 'Round',
    passages: 'rests on',
    answer: 'Answer',
    via: { panel: 'panel', conversation: 'conversation' },
    status: { ok: 'OK', ko: 'Not OK', modify: 'Change' },
    choice: 'choice',
    explain: 'Asked for more explanation',
    reply: 'Reply',
    none: '_None._',
  },
  'pt-PT': {
    title: (slug) => `${slug} — perguntas e decisões`,
    note: [
      '> Gerado por `render-run.js` a partir do `questions.json` do run. **Não editar à mão** -',
      '> o próximo render reescreve-o. Responde na conversa ou no painel do task-flow.',
    ],
    decisions: '### Decisões tomadas — para rever',
    questions: '### Perguntas em aberto',
    urgent: '**URGENTE**',
    chose: 'Escolhi',
    others: 'Também em cima da mesa',
    options: 'Opções',
    why: 'Porquê',
    overrule: 'Se me contrariares',
    phase: 'fase',
    task: 'task',
    round: 'Ronda',
    passages: 'assenta em',
    answer: 'Resposta',
    via: { panel: 'painel', conversation: 'conversa' },
    status: { ok: 'OK', ko: 'Não OK', modify: 'Alterar' },
    choice: 'escolha',
    explain: 'Pediu mais explicação',
    reply: 'Explicação',
    none: '_Nenhuma._',
  },
};

/** Text from the file, made unable to forge structure in the page.
 *
 *  Collapsing every run of whitespace removes everything that needs a line start:
 *  a heading, a list item, a block quote, a table row - and above all a new
 *  `- [ ]`, which is what the renderer counts as an open question. What can act
 *  in the middle of a line - emphasis, a link, an HTML tag, a table cell, a code
 *  span - is escaped with a backslash rather than removed, because this is the
 *  user's own answer and it should read as they wrote it. */
function inline(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_[\]<>|~#]/g, (c) => `\\${c}`);
}

const when = (iso) => (typeof iso === 'string' ? iso.slice(0, 16).replace('T', ' ') : '');

function renderItem(item, s) {
  const lines = [];
  const box = isOpen(item) ? '- [ ]' : '- [x]';
  const urgent = item.urgent ? `${s.urgent} ` : '';
  // A title ends in a full stop, unless it already ends a sentence of its own.
  const bare = inline(item.title);
  const title = `**${/[.?]$/.test(bare) ? bare : `${bare}.`}**`;
  const parts = [];

  const options = item.options || [];
  if (item.kind === 'decision') {
    parts.push(`${s.chose} ${inline(item.chosen)}.`);
    const others = options.filter((o) => !o.chosen && o.label !== item.chosen).map((o) => inline(o.label));
    if (others.length) parts.push(`${s.others}: ${others.join('; ')}.`);
  } else if (options.length) {
    parts.push(`${s.options}: ${options.map((o) => inline(o.label)).join('; ')}.`);
  }
  if (item.why) parts.push(`${s.why}: ${inline(item.why)}`);
  if (item.ifOverruled) parts.push(`${s.overrule}: ${inline(item.ifOverruled)}`);
  const where = [item.phase && `${s.phase}: ${item.phase}`, item.task && `${s.task}: ${item.task}`].filter(Boolean);
  if (where.length) parts.push(`(${where.join(' · ')})`);

  lines.push(`${box} ${urgent}${title}${parts.length ? ` ${parts.join(' ')}` : ''}`);

  for (const round of item.rounds || []) {
    const bits = [round.verdict && inline(round.verdict), round.found && inline(round.found)].filter(Boolean);
    const passages = (round.passages || []).map(inline);
    if (passages.length) bits.push(`${s.passages}: ${passages.join('; ')}`);
    lines.push(`  - ${s.round} ${round.round}${bits.length ? `: ${bits.join(' — ')}` : ''}`);
  }
  for (const request of item.explanations || []) {
    lines.push(`  - ${s.explain} (${s.via[request.via]}, ${when(request.at)}): ${inline(request.comment)}`);
    if (request.reply) lines.push(`    - ${s.reply}: ${inline(request.reply)}`);
  }
  if (item.answer) {
    const answer = item.answer;
    const bits = [s.status[answer.status]];
    if (answer.choice) {
      const chosen = options.find((o) => o.id === answer.choice);
      bits.push(`${s.choice}: ${inline(chosen ? chosen.label : answer.choice)}`);
    }
    if (answer.comment) bits.push(inline(answer.comment));
    lines.push(`  - ${s.answer} (${s.via[answer.via]}, ${when(answer.at)}): ${bits.join(' — ')}`);
  }
  return lines;
}

/** The whole questions page, in the project's page language. `created` is the
 *  run's creation date (yyyy-MM-dd), the same one its file name carries. */
function renderQuestionsMarkdown(data, { lang = 'en', created } = {}) {
  const s = STRINGS[lang] || STRINGS.en;
  const items = data.items || [];
  const section = (kind) => {
    const chosen = items.filter((item) => item.kind === kind);
    return chosen.length ? chosen.flatMap((item) => renderItem(item, s)) : [s.none];
  };
  return [
    '---',
    'type: questions',
    `created: ${created || data.created || ''}`,
    '---',
    '',
    ...s.note,
    '',
    // The slug has passed SAFE_SEGMENT in validateQuestions: nothing to escape.
    `# ${s.title(data.slug)}`,
    '',
    s.decisions,
    ...section('decision'),
    '',
    s.questions,
    ...section('question'),
    '',
  ].join('\n');
}

module.exports = {
  LIMITS,
  CONTROL,
  QUESTION_ID,
  OPTION_ID,
  SUBMISSION_ID,
  ANSWER_STATUSES,
  STRINGS,
  validateQuestions,
  renderQuestionsMarkdown,
  isOpen,
  openCount,
  inline,
};
