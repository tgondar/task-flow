#!/usr/bin/env node
// Run health: one line of numbers per finished run, and (later tasks) the
// comparison against the project's own history.
//
// WHY this is code and not a step in SKILL.md: a rule that lives only as prose
// drifts, and a failing LLM system fails silently. The measurement is anchored in
// the renderer (`renderAll`) so it happens once, at the close, whether or not the
// orchestrator remembered. It is INFORMATION: nothing here may block, delay
// (> 5 s) or fail a run or a render.
//
// THIS FILE, so far (T1-T3): the constants, the closed-shape validator of a
// metrics.jsonl line (spec R2) and the parser of the three optional state.json
// additions (`startedAt`, `phaseLog`, `health`; spec R5). Later tasks add the
// history reader/safe writer of metrics.jsonl (T2; spec R3, R10), baseline, transcript reader, git reader, collect and
// closeRun to this same file. T3 adds `baseline`: a PURE comparison of a run against
// the median of the project's own recent runs (spec R7).
//
// Trust model. state.json, metrics.jsonl, questions.json, plans and transcripts
// are all files somebody else may have written (a cloned repo, a shared folder).
// So every reader here follows the same rules:
//   - a CLOSED shape: an unknown key at any level invalidates the whole thing,
//     the way questions.js does, so nothing unexpected can ride along;
//   - objects are read as lists of allowed keys with hasOwn, never indexed by a
//     key that came from the input, and results are built FRESH from validated
//     values, so `__proto__`/`constructor` can never pollute or be copied;
//   - regexes are anchored and bounded (no catastrophic backtracking);
//   - a wrong shape means "absent" (null), never an exception, and NEVER an echo of
//     the offending value or of a JSON.parse message (those quote the input).
//
// Imports are limited to the stdlib and ./config.js, ./render-run.js,
// ./questions.js (a test reads this file to hold that line). render-run.js will
// require THIS module lazily inside renderAll's try, because we import it at the
// top: a top-level require in both directions would hand back partial exports.

const fs = require('fs');
const path = require('path');
const { crossesLink, isInside } = require('./config.js');
const { PHASES, SAFE_SEGMENT } = require('./render-run.js');

// --- constants ---------------------------------------------------------------
// Named, at the top, not configurable: the spec (R7, section 9) fixes these
// values and changing one is a "ask first" change. The baseline and deviation
// numbers land here with T3; the ones below are the limits every reader needs.

const CONSTANTS = Object.freeze({
  /** Baseline: the last N finished runs of the same project and model. A guess. */
  BASELINE_N: 8,
  /** Fewer runs than this in the baseline means no verdict. A guess. */
  BASELINE_MIN: 5,
  /** Total time one closeRun may spend, in ms. The Stop hook has 15 s. */
  BUDGET_MS: 5000,

  /** A metrics.jsonl line. Serialised rows are far smaller; this is a ceiling. */
  MAX_ROW_BYTES: 4096,
  /** Only the tail of the history is read: a huge or hostile file costs 1 MiB. */
  HISTORY_TAIL_BYTES: 1024 * 1024,
  /** More lines than this in the tail: only the newest HISTORY_KEEP_ROWS count. */
  HISTORY_MAX_ROWS: 10000,
  HISTORY_KEEP_ROWS: 200,

  /** Transcripts live outside the project; bound what we are willing to open. */
  MAX_TRANSCRIPT_FILES: 500,
  MAX_TRANSCRIPT_FILE_BYTES: 64 * 1024 * 1024,
  MAX_TRANSCRIPT_TOTAL_BYTES: 512 * 1024 * 1024,
  MAX_TRANSCRIPT_LINE_BYTES: 1024 * 1024,

  /** git --numstat: no shell, a short leash, a small buffer. */
  GIT_TIMEOUT_MS: 3000,
  GIT_MAX_BUFFER: 1024 * 1024,
});

// --- deviation table (spec R7) --------------------------------------------------
// INITIAL, UNMEASURED GUESSES. Nobody has measured a real run yet: the N and the
// minimum above, every `rel` and every `floor` below are the spec's starting
// numbers, to be validated against >= 5 measured runs. They are named constants and
// not configuration on purpose, and changing one is an "ask first" change (spec
// section 9), never a drive-by edit.
//
// A run deviates on a metric only in the WORSE direction, and only when it is worse
// than the baseline median `m` by more than max(rel * m, floor):
//   worse = 'higher':  value > m + max(rel * m, floor)
//   worse = 'lower':   value < max(0, m - max(rel * m, floor))
// `floor` (absolute) stops a median of 0 or a tiny one from flagging noise;
// `rel` is the relative part. The spec's base rule is rel = 0.5, but for metrics
// bounded to 0..1 that is a huge drop (a cache hit rate of 0.94 would only deviate
// below 0.47), so the two bounded rates carry their own, tighter fraction.
// Order is the order of the page table (R8). `per` = 'task' means "divided by
// tasks.done" so a big run and a small one compare at the same cost per task.
const DEVIATION = Object.freeze([
  { id: 'freshTokensPerTask', per: 'task', worse: 'higher', rel: 0.5, floor: 5000 },
  { id: 'toolCallsPerTask', per: 'task', worse: 'higher', rel: 0.5, floor: 3 },
  { id: 'toolErrorsPerTask', per: 'task', worse: 'higher', rel: 0.5, floor: 1 },
  { id: 'contextPeak', per: null, worse: 'higher', rel: 0.5, floor: 20000 },
  { id: 'cacheHitRate', per: null, worse: 'lower', rel: 0.10, floor: 0.05 },
  { id: 'retriesPerTask', per: 'task', worse: 'higher', rel: 0.5, floor: 0.25 },
  { id: 'findingsPerTask', per: 'task', worse: 'higher', rel: 0.5, floor: 0.25 },
  { id: 'questionsPerTask', per: 'task', worse: 'higher', rel: 0.5, floor: 0.25 },
  { id: 'explainedPerRun', per: null, worse: 'higher', rel: 0.5, floor: 1 },
  { id: 'maxRound', per: null, worse: 'higher', rel: 0.5, floor: 1 },
  { id: 'testCodeRatio', per: null, worse: 'lower', rel: 0.25, floor: 0.10 },
].map((metric) => Object.freeze(metric)));

/** Boundary values are computed in floating point (0.94 - 0.094 is not exactly
 *  0.846): a value ON the limit must be ok, so compare with a hair of tolerance. */
const EPSILON = 1e-9;

/** Every counter in a row is an integer in [0, 1e12]. Beyond that it is not a
 *  measurement, it is a hand-edited file (M-R10.3). */
const MAX_COUNT = 1e12;

const MAX_PHASE_LOG = 16;
const MAX_TASK_RETRY_KEYS = 200;

// --- closed shapes -------------------------------------------------------------

const SHAPE = Object.freeze({
  /** `T<n>`, `D<n>`, `T<n>.<m>`: the ids a plan gives its tasks. */
  taskId: /^[TD][0-9]{1,4}(?:\.[0-9]{1,4})?$/,
  /** A model name; the ONLY value from data that the page will ever print. */
  model: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/,
  date: /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/,
  /** ISO in UTC with a Z; optional milliseconds. Offsets are not accepted. */
  instant: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/,
});

const OUTCOMES = ['done', 'failed'];
const MODES = ['attended', 'auto'];
const TOKENS_NULL = ['no-transcripts', 'unreadable-format', 'overlap', 'no-window', 'timeout', 'disabled'];
const BY_PHASE_KEYS = [...PHASES, 'other'];
const ROW_KEYS = [
  'v', 'run', 'created', 'closedAt', 'outcome', 'mode', 'primaryModel', 'models', 'sizePoints',
  'tasks', 'tests', 'review', 'hardenFindings', 'questions', 'code', 'tokens', 'tokensNull', 'agent',
];

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** An integer counter in [0, MAX_COUNT]. `typeof` first: "5" and 5n are not numbers here. */
const isCount = (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT;

/** A plain object whose OWN keys are exactly `keys` (any order, none missing, none
 *  extra). hasOwn on both sides: an inherited or `__proto__` key can neither
 *  satisfy nor hide behind the check. */
function hasExactKeys(object, keys) {
  if (!isObject(object)) return false;
  const own = Object.keys(object);
  return own.length === keys.length && keys.every((key) => hasOwn(object, key));
}

/** Calendar-valid `yyyy-MM-dd` (2026-02-31 matches the regex and is not a date). */
function isDate(value) {
  if (typeof value !== 'string' || !SHAPE.date.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** Calendar-valid ISO UTC instant with a Z. */
function isInstant(value) {
  if (typeof value !== 'string' || value.length > 30 || !SHAPE.instant.test(value)) return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
}

/** A rate in [0, 1] with at most 4 decimals (the row stores it rounded). */
const isRate = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 && Math.round(value * 10000) / 10000 === value;

/** `block` is null or an object with exactly `keys`, each passing its own check. */
function isBlock(block, checks) {
  if (block === null) return true;
  if (!hasExactKeys(block, Object.keys(checks))) return false;
  return Object.keys(checks).every((key) => checks[key](block[key]));
}

const counts = (...names) => Object.fromEntries(names.map((name) => [name, isCount]));
const orNull = (check) => (value) => value === null || check(value);
const isBool = (value) => typeof value === 'boolean';

function isByPhase(value) {
  if (!isObject(value)) return false;
  const own = Object.keys(value);
  if (own.length > BY_PHASE_KEYS.length) return false;
  return own.every((key) => BY_PHASE_KEYS.includes(key) && hasExactKeys(value[key], ['in', 'out']) && isCount(value[key].in) && isCount(value[key].out));
}

function isModels(value) {
  return Array.isArray(value) && value.length <= 8 && value.every((model) => typeof model === 'string' && SHAPE.model.test(model));
}

/**
 * Is `row` a valid version-1 metrics line? Never throws.
 *
 * `{ ok: true, row }`, or `{ ok: false }` for a wrong shape, or
 * `{ ok: false, ignored: true }` for another version: a row written by a newer
 * task-flow is not an error, it is not ours to read.
 *
 * The result carries no reason text: a validator that named the failing value would
 * be one more place to echo file content.
 */
function validateRow(row) {
  try {
    if (!isObject(row)) return { ok: false };
    if (hasOwn(row, 'v') && row.v !== 1 && typeof row.v === 'number') return { ok: false, ignored: true };
    if (!hasExactKeys(row, ROW_KEYS) || row.v !== 1) return { ok: false };

    const scalar =
      typeof row.run === 'string' && row.run.length <= 100 && SAFE_SEGMENT.test(row.run) &&
      isDate(row.created) && isInstant(row.closedAt) &&
      OUTCOMES.includes(row.outcome) && MODES.includes(row.mode) &&
      (row.primaryModel === null || (typeof row.primaryModel === 'string' && SHAPE.model.test(row.primaryModel))) &&
      isModels(row.models) &&
      (row.sizePoints === null || isCount(row.sizePoints)) &&
      (row.hardenFindings === null || isCount(row.hardenFindings));
    if (!scalar) return { ok: false };

    const blocks =
      isBlock(row.tasks, { ...counts('total', 'done', 'skipped', 'pending'), retries: orNull(isCount), firstTime: orNull(isCount) }) &&
      isBlock(row.tests, { greenFirstRun: orNull(isBool) }) &&
      isBlock(row.review, counts('critical', 'required', 'optional', 'nit')) &&
      isBlock(row.questions, counts('total', 'open', 'explained', 'maxRound')) &&
      isBlock(row.code, counts('added', 'removed', 'files', 'testAdded', 'codeAdded')) &&
      isBlock(row.agent, counts('requests', 'toolCalls', 'toolErrors', 'contextPeak')) &&
      isBlock(row.tokens, { ...counts('input', 'cacheCreate', 'cacheRead', 'output'), cacheHitRate: orNull(isRate), byPhase: isByPhase });
    if (!blocks) return { ok: false };

    // tokensNull explains a missing tokens block, and only that: both together, or
    // neither, would be a row that says two different things.
    const reasonOk = row.tokens === null ? TOKENS_NULL.includes(row.tokensNull) : row.tokensNull === null;
    return reasonOk ? { ok: true, row } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * One metrics.jsonl line (text, without its newline) to a validated row. Never
 * throws and never echoes the line: the JSON.parse message quotes the input, so it
 * is dropped here.
 */
function parseRow(line) {
  try {
    if (typeof line !== 'string') return { ok: false };
    const text = line.replace(/^﻿/, '').replace(/[\r\n]+$/, '');
    if (Buffer.byteLength(text, 'utf8') > CONSTANTS.MAX_ROW_BYTES) return { ok: false };
    return validateRow(JSON.parse(text));
  } catch {
    return { ok: false };
  }
}

// --- state.json additions (spec R5) -------------------------------------------

/** `taskRetries`: `{ "T3": 1 }`. All or nothing: a partly valid map would be a
 *  partly invented count. Built as a null-prototype copy. */
function parseTaskRetries(value) {
  if (!isObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length > MAX_TASK_RETRY_KEYS) return null;
  const copy = Object.create(null);
  for (const key of keys) {
    const count = value[key];
    if (!SHAPE.taskId.test(key) || typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 99) return null;
    copy[key] = count;
  }
  return copy;
}

/** `review`: the four severities as the reviewer labelled them, plus an optional
 *  `notReproduced` kept apart (it is not part of the baseline's counts). */
function parseReview(value) {
  const base = ['critical', 'required', 'optional', 'nit'];
  if (!isObject(value)) return null;
  const withExtra = hasOwn(value, 'notReproduced');
  if (!hasExactKeys(value, withExtra ? [...base, 'notReproduced'] : base)) return null;
  if (![...base, ...(withExtra ? ['notReproduced'] : [])].every((key) => isCount(value[key]))) return null;
  const copy = {};
  for (const key of base) copy[key] = value[key];
  if (withExtra) copy.notReproduced = value.notReproduced;
  return copy;
}

/** `phaseLog`: at most 16 `{ phase, at }` entries, `phase` in PHASES. All or nothing. */
function parsePhaseLog(value) {
  if (!Array.isArray(value) || value.length > MAX_PHASE_LOG) return null;
  const entries = [];
  for (const entry of value) {
    if (!hasExactKeys(entry, ['phase', 'at']) || !PHASES.includes(entry.phase) || !isInstant(entry.at)) return null;
    entries.push({ phase: entry.phase, at: entry.at });
  }
  return entries;
}

/**
 * What metrics.js takes from a state.json: `startedAt`, `phaseLog` and the four
 * `health` facts, each independently null when absent or malformed. Never throws,
 * never mutates `state`, and copies (nothing returned aliases the input).
 */
function parseHealth(state) {
  const none = { startedAt: null, phaseLog: null, health: { taskRetries: null, testsGreenFirstRun: null, review: null, hardenFindings: null } };
  try {
    if (!isObject(state)) return none;
    const health = hasOwn(state, 'health') && isObject(state.health) ? state.health : null;
    const own = (key) => (health && hasOwn(health, key) ? health[key] : undefined);
    return {
      startedAt: hasOwn(state, 'startedAt') && isInstant(state.startedAt) ? state.startedAt : null,
      phaseLog: hasOwn(state, 'phaseLog') ? parsePhaseLog(state.phaseLog) : null,
      health: {
        taskRetries: parseTaskRetries(own('taskRetries')),
        testsGreenFirstRun: isBool(own('testsGreenFirstRun')) ? own('testsGreenFirstRun') : null,
        review: parseReview(own('review')),
        hardenFindings: isCount(own('hardenFindings')) ? own('hardenFindings') : null,
      },
    };
  } catch {
    return none;
  }
}

// --- history: read (spec R10.1-3, R4 read side) and write (spec R3) ---------------

const HISTORY_FILE = 'metrics.jsonl';

/** Where the history lives. `stateDir` comes from config.js's resolution, never from
 *  here: this module does not know how to resolve one, on purpose (spec R10.4). */
const historyPath = (stateDir) => path.join(stateDir, HISTORY_FILE);

/**
 * Is `file` somewhere metrics.js may touch? Text containment in BOTH the state
 * folder and the project, and no link anywhere on the way (lstat only, so a link's
 * target is never opened - it may be a network share, or a file that is not ours).
 * A `stateDir` that is itself a junction is caught here: crossesLink walks every
 * component below the project root, the state folder included.
 */
function isSafeHistoryPath(projectDir, stateDir, file) {
  // absolute only: '' or a relative stateDir would resolve against the process cwd
  // and write metrics.jsonl wherever the hook happened to start
  if (typeof projectDir !== 'string' || typeof stateDir !== 'string' || !path.isAbsolute(projectDir) || !path.isAbsolute(stateDir)) return false;
  return isInside(stateDir, file) && isInside(projectDir, file) && !crossesLink(projectDir, file);
}

/** O_NOFOLLOW where the platform has one (POSIX): closes the window between the lstat
 *  below and the open. Windows has no such flag; there the lstat check is what we
 *  have (a drift/hardening guard, not a security boundary - same as the gate). */
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function closeQuietly(fd) {
  if (fd === null) return;
  try {
    fs.closeSync(fd);
  } catch {
    // nothing to do: a failed close of a file we only read or appended to
  }
}

/**
 * The validated rows of `<stateDir>/metrics.jsonl`, oldest first, one per
 * `run`+`created` (the FIRST line wins: two racing closes may both append, and the
 * earlier one is the measurement that was reported).
 *
 * Returns `{ rows, ignored, code }`. `ignored` counts non-blank lines that were not
 * valid rows (a partial line, garbage, another version, a hand-edited number);
 * `code` is null, `unsafe-path` when the file is a link/folder/etc. (nothing was
 * opened) or `read-failed`. Never throws, and never carries text from the file:
 * only counts and codes.
 *
 * Cost is bounded whatever the file: only the last HISTORY_TAIL_BYTES are read, the
 * first (probably partial) line of a truncated window is dropped, and when the window
 * still holds more than HISTORY_MAX_ROWS lines only the last HISTORY_KEEP_ROWS are
 * looked at, so a hostile multi-GiB file costs one bounded read and a bounded parse.
 */
function readHistory(projectDir, stateDir) {
  const result = { rows: [], ignored: 0, code: null };
  let fd = null;
  try {
    const file = historyPath(stateDir);
    if (!isSafeHistoryPath(projectDir, stateDir, file)) return { ...result, code: 'unsafe-path' };
    let stats;
    try {
      stats = fs.lstatSync(file);
    } catch {
      return result; // no history yet
    }
    if (!stats.isFile()) return { ...result, code: 'unsafe-path' };

    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, CONSTANTS.HISTORY_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buffer, read, length - read, size - length + read);
      if (n === 0) break;
      read += n;
    }
    let text = buffer.subarray(0, read).toString('utf8');
    if (size > length) {
      // the window starts mid-line: that first fragment is not a row
      const cut = text.indexOf('\n');
      text = cut === -1 ? '' : text.slice(cut + 1);
    }
    let lines = text.split('\n');
    if (lines.length > CONSTANTS.HISTORY_MAX_ROWS) lines = lines.slice(-CONSTANTS.HISTORY_KEEP_ROWS);

    const seen = new Set();
    for (const raw of lines) {
      if (raw.replace(/^﻿/, '').trim() === '') continue;
      const parsed = parseRow(raw);
      if (!parsed.ok) {
        result.ignored += 1;
        continue;
      }
      const key = `${parsed.row.run}\n${parsed.row.created}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.rows.push(parsed.row);
    }
    return result;
  } catch {
    return { rows: [], ignored: 0, code: 'read-failed' };
  } finally {
    closeQuietly(fd);
  }
}

/**
 * Appends one row to `<stateDir>/metrics.jsonl`. `{ ok: true }` or
 * `{ ok: false, code }` with code `invalid-row`, `unsafe-path` or `write-failed`;
 * never throws, never creates `stateDir` (no state folder means no run to measure).
 *
 * The row is re-validated here so that nothing that is not a closed-shape v1 row can
 * reach the file, whoever the caller is, and it is serialised from the validated
 * object. If the last byte on disk is not a newline (a crash cut the previous line)
 * a newline is written first, so the new row is never glued to the fragment. The
 * write is one append-mode write on a descriptor we fstat'ed (the same effect as
 * fs.appendFileSync with flag 'a', but the file we checked is the file we wrote).
 */
function appendRow(projectDir, stateDir, row) {
  let fd = null;
  try {
    const checked = validateRow(row);
    if (!checked.ok) return { ok: false, code: 'invalid-row' };
    const body = JSON.stringify(checked.row);
    if (Buffer.byteLength(body, 'utf8') + 1 > CONSTANTS.MAX_ROW_BYTES) return { ok: false, code: 'invalid-row' };

    const file = historyPath(stateDir);
    if (!isSafeHistoryPath(projectDir, stateDir, file)) return { ok: false, code: 'unsafe-path' };
    try {
      if (!fs.lstatSync(file).isFile()) return { ok: false, code: 'unsafe-path' };
    } catch {
      // does not exist yet: it is created below
    }

    fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW, 0o644);
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) return { ok: false, code: 'unsafe-path' };
    let prefix = '';
    if (stats.size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, stats.size - 1);
      if (last[0] !== 0x0a) prefix = '\n';
    }
    fs.writeSync(fd, `${prefix}${body}\n`);
    return { ok: true };
  } catch {
    return { ok: false, code: 'write-failed' };
  } finally {
    closeQuietly(fd);
  }
}

// --- baseline (spec R7) ---------------------------------------------------------

/** The number of `row`'s metric, or null. A row is read through isCount/isRate
 *  again here, so even a row that skipped validation cannot produce NaN, Infinity or
 *  a value from an inherited key. Per-task metrics need tasks.done > 0. */
function metricValue(row, id) {
  const block = (name) => (isObject(row) && hasOwn(row, name) && isObject(row[name]) ? row[name] : null);
  const count = (object, key) => (object && hasOwn(object, key) && isCount(object[key]) ? object[key] : null);
  const tasks = block('tasks');
  const done = count(tasks, 'done');
  const perTask = (total) => (total === null || !done ? null : total / done);
  const sum = (...parts) => (parts.some((part) => part === null) ? null : parts.reduce((a, b) => a + b, 0));
  const tokens = block('tokens');
  const agent = block('agent');
  const review = block('review');
  const questions = block('questions');
  const code = block('code');
  switch (id) {
    case 'freshTokensPerTask': return perTask(sum(count(tokens, 'input'), count(tokens, 'cacheCreate'), count(tokens, 'output')));
    case 'toolCallsPerTask': return perTask(count(agent, 'toolCalls'));
    case 'toolErrorsPerTask': return perTask(count(agent, 'toolErrors'));
    case 'contextPeak': return count(agent, 'contextPeak');
    case 'cacheHitRate': return tokens && hasOwn(tokens, 'cacheHitRate') && isRate(tokens.cacheHitRate) ? tokens.cacheHitRate : null;
    case 'retriesPerTask': return perTask(count(tasks, 'retries'));
    case 'findingsPerTask': return perTask(sum(count(review, 'critical'), count(review, 'required')));
    case 'questionsPerTask': return perTask(count(questions, 'total'));
    case 'explainedPerRun': return count(questions, 'explained');
    case 'maxRound': return count(questions, 'maxRound');
    case 'testCodeRatio': {
      const codeAdded = count(code, 'codeAdded');
      const testAdded = count(code, 'testAdded');
      return codeAdded && testAdded !== null ? testAdded / codeAdded : null;
    }
    default: return null;
  }
}

/** Median of a non-empty list of finite numbers: the middle one, or for an even
 *  count the mean of the two middle ones. Sorts a copy. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** ok / deviation for one value against a baseline median, by the rule above. */
function judge(spec, value, m) {
  const slack = Math.max(spec.rel * m, spec.floor);
  if (spec.worse === 'higher') return value > m + slack + EPSILON ? 'deviation' : 'ok';
  return value < Math.max(0, m - slack) - EPSILON ? 'deviation' : 'ok';
}

const sameRun = (a, b) => a.run === b.run && a.created === b.created;
const byClosedAt = (a, b) => (Date.parse(a.closedAt) - Date.parse(b.closedAt)) || (a.run < b.run ? -1 : a.run > b.run ? 1 : 0);

/**
 * Compares `current` (a row) with the median of the last `n` finished runs of the
 * same model in `history` (rows). PURE: no I/O, no clock, inputs not mutated, never
 * throws, and nothing in the result comes from the inputs but numbers.
 *
 * Returns { hasVerdict, reason, have, min, n, metrics: [{ id, value, median, verdict }] }
 *   reason: null | 'too-few' (have < min) | 'no-model-base' (no baseline row of this
 *   model, also when the current run has no model) | 'failed' (current run failed:
 *   values, never a verdict, and failed rows are never in the baseline either) |
 *   'bad-current'.
 *   verdict: 'ok' | 'deviation' | 'n/d' (no value, or fewer than `min` non-null baseline
 *   values for this metric) | null (the run has no verdict at all).
 *
 * The baseline is filtered FIRST (validated, outcome done, same primaryModel, not the
 * current run) and only THEN cut to the last `n` by closedAt (ties by run). Taking the
 * newest n and filtering afterwards would let a burst of failed or other-model runs
 * empty the baseline of the runs that are actually comparable.
 */
function baseline(history, current, { n = CONSTANTS.BASELINE_N, min = CONSTANTS.BASELINE_MIN } = {}) {
  const result = { hasVerdict: false, reason: 'bad-current', have: 0, min, n, metrics: [] };
  try {
    if (!isObject(current)) return result;
    const values = DEVIATION.map((spec) => ({ id: spec.id, value: metricValue(current, spec.id) }));
    const out = (extra) => ({
      ...result,
      ...extra,
      metrics: values.map((v, i) => ({ id: v.id, value: v.value, median: null, verdict: null, ...(extra.metrics ? extra.metrics[i] : {}) })),
    });

    const modelOk = typeof current.primaryModel === 'string' && SHAPE.model.test(current.primaryModel);
    // bounded: the history reader already caps rows, this caps a caller that did not
    const rows = Array.isArray(history) ? history.slice(-CONSTANTS.HISTORY_MAX_ROWS) : [];
    const base = [];
    for (const row of rows) {
      if (modelOk && validateRow(row).ok && row.outcome === 'done' && row.primaryModel === current.primaryModel && !sameRun(row, current)) base.push(row);
    }
    base.sort(byClosedAt);
    const used = base.slice(-Math.max(0, n));
    const have = used.length;

    if (current.outcome === 'failed') return out({ reason: 'failed', have });
    if (have === 0) return out({ reason: 'no-model-base', have });
    if (have < min) return out({ reason: 'too-few', have });

    const metrics = DEVIATION.map((spec, i) => {
      const own = used.map((row) => metricValue(row, spec.id)).filter((v) => v !== null);
      const value = values[i].value;
      if (own.length < min || value === null) return { verdict: 'n/d' };
      const m = median(own);
      return { median: m, verdict: judge(spec, value, m) };
    });
    return out({ hasVerdict: true, reason: null, have, metrics });
  } catch {
    return { ...result, reason: 'bad-current' };
  }
}

module.exports = {
  CONSTANTS,
  PHASES,
  validateRow,
  parseRow,
  parseHealth,
  readHistory,
  appendRow,
  DEVIATION,
  baseline,
};
