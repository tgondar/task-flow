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
// THIS FILE, so far (T1-T4; T4 adds `readTokens`, the tolerant transcript reader, spec R6): the constants, the closed-shape validator of a
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
const http = require('http');
const https = require('https');
const path = require('path');
const {
  crossesLink, isInside, isPaperclipUrlTrusted, loadConfig, parsePaperclipOrigin, runningRuns,
} = require('./config.js');
const { PHASES, SAFE_SEGMENT, STRINGS, formatDuration, readPlanTasks, readSkippedTasks, readPendingTasks } = require('./render-run.js');

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

  /** One line of a run's loop-events.jsonl. A start event is about 150 bytes; a ceiling. */
  LOOP_EVENT_MAX_BYTES: 512,
  /** A loop-events.jsonl already past this gets no more lines (thousands of loops). */
  LOOP_EVENTS_MAX_FILE_BYTES: 1024 * 1024,

  /** One request to paperclip's API (plan T11, RF-042): the whole exchange, connect to last byte. */
  PAPERCLIP_TIMEOUT_MS: 10000,
  /** A paperclip response body past this is refused, not parsed (the request is destroyed). */
  PAPERCLIP_MAX_BODY_BYTES: 1024 * 1024,
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
  /** A subagent's id, as the SubagentStart payload gives it and agent-<id>.jsonl names it. */
  agentId: /^[A-Za-z0-9]{1,64}$/,
  /** A subagent's type (`general-purpose`, `task-flow:security-auditor`): a model name's shape. */
  agentType: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/,
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

/** A run's folder name: a safe path segment of at most 100 characters. */
const isSlug = (value) => typeof value === 'string' && value.length <= 100 && SAFE_SEGMENT.test(value);

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
      isSlug(row.run) &&
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
 * The last `maxBytes` of `file` as text, for this module's bounded line readers
 * (metrics.jsonl, a run's loop-events.jsonl). Returns `{ text, code }`: code null
 * (text '' when the file does not exist yet), `unsafe-path` when the path fails
 * isSafeHistoryPath or is a link/folder/etc. (nothing was opened), or
 * `read-failed`. Never throws, and a code never carries text from the file.
 *
 * One bounded read whatever the size. When the file is bigger than the window, the
 * window starts mid-line and that first fragment is dropped, so every line of
 * `text` is whole as written (the last one may still be cut by a crash).
 */
function readTail(projectDir, stateDir, file, maxBytes) {
  let fd = null;
  try {
    if (!isSafeHistoryPath(projectDir, stateDir, file)) return { text: '', code: 'unsafe-path' };
    let stats;
    try {
      stats = fs.lstatSync(file);
    } catch {
      return { text: '', code: null }; // nothing written yet
    }
    if (!stats.isFile()) return { text: '', code: 'unsafe-path' };

    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buffer, read, length - read, size - length + read);
      if (n === 0) break;
      read += n;
    }
    let text = buffer.subarray(0, read).toString('utf8');
    if (size > length) {
      // the window starts mid-line: that first fragment is not a line
      const cut = text.indexOf('\n');
      text = cut === -1 ? '' : text.slice(cut + 1);
    }
    return { text, code: null };
  } catch {
    return { text: '', code: 'read-failed' };
  } finally {
    closeQuietly(fd);
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
 * Cost is bounded whatever the file: only the last HISTORY_TAIL_BYTES are read
 * (readTail, which drops the partial first line of a cut window), and when the window
 * still holds more than HISTORY_MAX_ROWS lines only the last HISTORY_KEEP_ROWS are
 * looked at, so a hostile multi-GiB file costs one bounded read and a bounded parse.
 */
function readHistory(projectDir, stateDir) {
  const result = { rows: [], ignored: 0, code: null };
  try {
    const tail = readTail(projectDir, stateDir, historyPath(stateDir), CONSTANTS.HISTORY_TAIL_BYTES);
    if (tail.code) return { ...result, code: tail.code };
    let lines = tail.text.split('\n');
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
  }
}

/**
 * Appends one row to `<stateDir>/metrics.jsonl`. `{ ok: true }` or
 * `{ ok: false, code }` with code `invalid-row`, `unsafe-path` or `write-failed`;
 * never throws, never creates `stateDir` (no state folder means no run to measure).
 *
 * The row is re-validated here so that nothing that is not a closed-shape v1 row can
 * reach the file, whoever the caller is, and it is serialised from the validated
 * object, then written by appendLine (no size cap on the file: the reader reads a
 * bounded tail of it).
 */
function appendRow(projectDir, stateDir, row) {
  try {
    const checked = validateRow(row);
    if (!checked.ok) return { ok: false, code: 'invalid-row' };
    const body = JSON.stringify(checked.row);
    if (Buffer.byteLength(body, 'utf8') + 1 > CONSTANTS.MAX_ROW_BYTES) return { ok: false, code: 'invalid-row' };

    return appendLine(projectDir, stateDir, historyPath(stateDir), body, Infinity);
  } catch {
    return { ok: false, code: 'write-failed' };
  }
}

/**
 * Appends `body` and a newline to `file`: the one write path of this module's line
 * files. `{ ok: true }` or `{ ok: false, code }` with code `unsafe-path`, `full`
 * (the file is already over `maxFileBytes`; nothing written) or `write-failed`.
 * Never throws, never creates a folder (no state folder means nothing to measure).
 * Validating `body` is the caller's job: each file has its own closed shape.
 *
 * If the last byte on disk is not a newline (a crash cut the previous line) a
 * newline is written first, so the new line is never glued to the fragment. The
 * write is one append-mode write on a descriptor we fstat'ed (the same effect as
 * fs.appendFileSync with flag 'a', but the file we checked is the file we wrote).
 */
function appendLine(projectDir, stateDir, file, body, maxFileBytes) {
  let fd = null;
  try {
    if (!isSafeHistoryPath(projectDir, stateDir, file)) return { ok: false, code: 'unsafe-path' };
    try {
      if (!fs.lstatSync(file).isFile()) return { ok: false, code: 'unsafe-path' };
    } catch {
      // does not exist yet: it is created below
    }

    fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW, 0o644);
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) return { ok: false, code: 'unsafe-path' };
    if (stats.size > maxFileBytes) return { ok: false, code: 'full' };
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

// --- code metrics from git (spec R9, R1) -----------------------------------------------
//
// `readCode({ projectDir, branch, base })` measures the branch's diff against its base
// with `git diff --numstat`. `branch` and `base` come from state.json / the project's
// config, so they are UNTRUSTED text that ends up in a process argument list. Defences,
// in order: (1) a strict closed shape (no leading '-', no '..', no control characters,
// at most 200 chars) checked BEFORE git is ever spawned - a value that fails it means
// git is not run at all; (2) execFileSync with an argument array and shell:false, so no
// shell ever parses a ref; (3) `--end-of-options` is not used (older gits lack it) but
// the shape already forbids a leading '-', and the revisions are followed by `--` so git
// cannot read them as paths; (4) cwd is the project dir, stdout is bounded (maxBuffer),
// the call has a timeout, stderr is never inherited or captured (git's messages can
// contain paths); (5) config that could run programs (external diff, textconv,
// fsmonitor, pager) is switched off on the command line.
//
// Only numbers leave this function. Paths are read to classify a file as test or code
// and dropped. Every failure ends as `{ code: null, reason }` with a closed reason;
// nothing here throws and nothing here can fail a run.

const { execFileSync } = require('child_process');

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** Sanity ceiling per count, as for the other readers: bigger is not a measurement. */
const MAX_CODE_COUNT = 1e9;

function isSafeRef(value) {
  return typeof value === 'string' && SAFE_REF.test(value) && !value.includes('..') && !value.includes('//') && !value.endsWith('/') && !value.endsWith('.lock');
}

/** Fixed patterns from the spec: a `test`/`tests`/`__tests__` folder, or *.test.* / *.spec.* */
function isTestPath(file) {
  const parts = file.split('/');
  const name = parts[parts.length - 1];
  return parts.slice(0, -1).some((p) => p === 'test' || p === 'tests' || p === '__tests__') || /\.(test|spec)\.[^./]+$/.test(name);
}

/** Inherited GIT_* variables (GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_*, GIT_OBJECT_DIRECTORY, ...) could point git at another repo or inject config: none reach the child. */
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v;
  return env;
}

const noCode = (reason) => ({ code: null, reason });

function readCode(options) {
  try {
    const { projectDir, branch, base } = options && typeof options === 'object' ? options : {};
    if (typeof projectDir !== 'string' || projectDir === '' || projectDir.includes('\0')) return noCode('bad-input');
    if (!isSafeRef(branch) || !isSafeRef(base)) return noCode('bad-ref');
    let out;
    try {
      out = execFileSync(
        'git',
        ['--no-pager', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.pager=cat',
          'diff', '--numstat', '-z', '-M', '--no-ext-diff', '--no-textconv', `${base}...${branch}`, '--'],
        {
          cwd: projectDir, shell: false, timeout: CONSTANTS.GIT_TIMEOUT_MS, maxBuffer: CONSTANTS.GIT_MAX_BUFFER,
          stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, encoding: 'utf8',
          env: { ...cleanEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_EXTERNAL_DIFF: '', GIT_PAGER: 'cat' },
        },
      );
    } catch (error) {
      const c = error && error.code;
      return noCode(c === 'ETIMEDOUT' ? 'timeout' : c === 'ENOBUFS' ? 'too-large' : c === 'ENOENT' ? 'no-git' : 'git-failed');
    }
    // -z records: "<added>\t<removed>\t<path>\0"; a rename is "<a>\t<r>\t\0<old>\0<new>\0".
    const tokens = out.split('\0');
    if (tokens[tokens.length - 1] === '') tokens.pop();
    const total = { added: 0, removed: 0, files: 0, testAdded: 0, codeAdded: 0 };
    for (let i = 0; i < tokens.length; i += 1) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i]);
      if (!m) return noCode('unreadable-output');
      let file = m[3];
      if (file === '') { // rename: the next two tokens are the old and new path
        if (i + 2 > tokens.length - 1) return noCode('unreadable-output');
        file = tokens[i + 2];
        i += 2;
      }
      // binary files ("-") count as a touched file with 0 lines
      const added = m[1] === '-' ? 0 : Number(m[1]);
      const removed = m[2] === '-' ? 0 : Number(m[2]);
      total.files += 1;
      total.added += added;
      total.removed += removed;
      if (isTestPath(file)) total.testAdded += added; else total.codeAdded += added;
    }
    if (!Object.values(total).every((n) => Number.isSafeInteger(n) && n <= MAX_CODE_COUNT)) return noCode('unreadable-output');
    return { code: total, reason: null };
  } catch {
    return noCode('internal');
  }
}

// --- collect: one row for one finished run (spec R1, R2, R4.4, R9) ------------------------
//
// `collect({ projectDir, config, slug, now, readers })` builds the closed-shape row of a
// run from its state.json, questions.json and plan and from the readers around it. It
// only READS: T7's closeRun decides whether and where to append.
//
// Everything it reads is untrusted (a cloned repo, a shared folder). So: (1) each file is
// lstat-ed, refused if it is a link or not a plain file or over MAX_SMALL_FILE bytes,
// BEFORE a byte is read; (2) nothing from a file is copied into the row except numbers,
// booleans and members of closed sets - titles, reasons, questions, branch names and tool
// names are only ever counted or used as lookup keys, never stored; model names come
// through readTokens already checked against the closed shape; (3) a source that is
// missing, malformed or throws makes ITS block null (with the closed reason where the
// row has one) and nothing else - never "all or nothing", never a guess; (4) every block
// is re-checked on its own against the row validator before it goes in, so a reader
// that misbehaves (or is injected by a test) can only lose its own block; (5) the result
// is `{ ok: true, row }` or `{ ok: false, code }` with a closed code and NOTHING else:
// no message, no path. It never throws. The row validator is also what T3 noted must run
// before a row can reach `baseline` (which does not validate `current`): it runs here.
//
// closedAt is the state's `phaseChangedAt` (the moment the run reached `done`), so a
// repair run days later, or the backstop of the next Stop hook, records the same
// instant; only without one does the injected clock (`now`) stand in. That instant also
// ends the transcript window.

const { readQuestionsFile } = require('./questions.js');

const MAX_SMALL_FILE = 1024 * 1024;
const MAX_OTHER_RUNS = 200;
const NULLABLE_BLOCKS = ['tasks', 'tests', 'review', 'questions', 'code', 'tokens', 'agent'];
const OFFSET_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;

const failure = (code) => ({ ok: false, code });

/** A parsed plain JSON object, or null. Links and non-files are refused by lstat, the
 *  size is checked before reading, the parser's message is dropped (it quotes input). */
function readSmallObject(projectDir, file) {
  try {
    if (!isInside(projectDir, file) || crossesLink(projectDir, file)) return null;
    const stats = fs.lstatSync(file);
    if (!stats.isFile() || stats.size > MAX_SMALL_FILE) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** An ISO instant with `Z` or an offset, as UTC seconds with `Z`; null otherwise. Strict
 *  shape first: Date.parse alone would turn "1" into a date in 2001. */
function toUtcInstant(value) {
  if (typeof value !== 'string' || value.length > 40 || !OFFSET_INSTANT.test(value)) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  const text = new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return isInstant(text) ? text : null;
}

/** The plan, only if it is a plain file inside docsDir, without a link on the way. */
function resolvePlan(config, state) {
  const docsDir = config.docsDir;
  const given = isObject(state.artifacts) && hasOwn(state.artifacts, 'plan') ? state.artifacts.plan : null;
  if (typeof given !== 'string' || given === '' || given.length > 1024 || given.includes('\0') || typeof docsDir !== 'string' || !path.isAbsolute(docsDir)) return null;
  const file = path.resolve(docsDir, given);
  if (!isInside(docsDir, file) || crossesLink(docsDir, file)) return null;
  try {
    const stats = fs.lstatSync(file);
    return stats.isFile() && stats.size <= MAX_SMALL_FILE * 2 ? file : null;
  } catch {
    return null;
  }
}

/** Windows of the project's other runs (startedAt..end), read only for `overlap`. A run
 *  still going has no end yet: it lasts until `nowIso`. Unreadable ones are skipped. */
function otherWindows(projectDir, stateDir, slug, nowIso) {
  const windows = [];
  try {
    const names = fs.readdirSync(stateDir).slice(0, MAX_OTHER_RUNS);
    for (const name of names) {
      if (name === slug || !SAFE_SEGMENT.test(name)) continue;
      const other = readSmallObject(projectDir, path.join(stateDir, name, 'state.json'));
      if (!other || !isInstant(other.startedAt)) continue;
      const end = other.phase === 'done' ? toUtcInstant(other.phaseChangedAt) : nowIso;
      if (end) windows.push({ startedAt: other.startedAt, closedAt: end });
    }
  } catch {
    // a folder we cannot list means no known overlap, not a failed measurement
  }
  return windows;
}

/** Task counts by the page's own rules (readSkippedTasks / readPendingTasks): a
 *  finished run counts every task done except the skipped and the parked ones. Retries
 *  come from health.taskRetries, which the orchestrator writes when a retry happens:
 *  with a health object and no map nothing was retried; a map that failed validation
 *  means we do not know (null); no health object at all means null too. */
function taskBlock(state, planFile, health, present, readers) {
  if (!planFile) return null;
  const tasks = readers.readPlanTasks(planFile);
  if (!Array.isArray(tasks) || tasks.length === 0) return null;
  const skipped = readSkippedTasks(state, tasks);
  const pending = readPendingTasks(state, tasks);
  const doneTasks = tasks.filter((task) => !skipped.has(task.id) && !pending.has(task.id));
  let retries = null;
  let firstTime = null;
  if (present.health && (health.taskRetries || !present.taskRetries)) {
    const map = health.taskRetries || Object.create(null);
    retries = Object.keys(map).reduce((sum, key) => sum + map[key], 0);
    firstTime = doneTasks.filter((task) => !hasOwn(map, task.id)).length;
  }
  return { total: tasks.length, done: doneTasks.length, skipped: skipped.size, pending: pending.size, retries, firstTime };
}

/** Counts from a validated questions.json (readQuestionsFile already refused anything
 *  off-shape): every item counts, open = no answer, explained = explanation requests. */
function questionsBlock(file, stateDir, slug, readQuestions) {
  const read = readQuestions(file, stateDir, slug);
  if (!isObject(read) || !read.exists || (Array.isArray(read.errors) && read.errors.length) || !isObject(read.data) || !Array.isArray(read.data.items)) return null;
  const items = read.data.items;
  let explained = 0;
  let maxRound = 0;
  let open = 0;
  for (const item of items) {
    if (!item.answer) open += 1;
    if (Array.isArray(item.explanations)) explained += item.explanations.length;
    for (const round of Array.isArray(item.rounds) ? item.rounds : []) if (Number.isInteger(round.round)) maxRound = Math.max(maxRound, round.round);
  }
  return { total: items.length, open, explained, maxRound };
}

/** Runs one source; whatever it throws becomes null (never the exception). */
function attempt(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** A reader's answer as plain data: a copy through JSON, so a Proxy, a throwing getter
 *  or a shared reference in it costs only that source's block (null), never the row. */
const plain = (fn) => attempt(() => JSON.parse(JSON.stringify(fn())));

function collect(options) {
  const started = Date.now();
  try {
    const opts = isObject(options) ? options : {};
    const { projectDir, config, slug } = opts;
    if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir) || !isSlug(slug)) return failure('bad-state');
    const stateDir = isObject(config) ? config.stateDir : null;
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) return failure('bad-state');
    const statePath = path.join(stateDir, slug, 'state.json');
    if (!isInside(stateDir, statePath) || !isInside(projectDir, statePath) || crossesLink(projectDir, statePath)) return failure('unsafe-path');

    const state = readSmallObject(projectDir, statePath);
    if (!state) return failure('bad-state');

    const clock = typeof opts.now === 'function' ? opts.now : Date.now;
    const nowMs = attempt(() => clock());
    const nowIso = Number.isFinite(nowMs) ? toUtcInstant(new Date(nowMs).toISOString()) : null;
    const given = isObject(opts.readers) ? opts.readers : {};
    const pick = (name, fallback) => (typeof given[name] === 'function' ? given[name] : fallback);
    const readers = {
      parseHealth: pick('parseHealth', parseHealth),
      readPlanTasks: pick('readPlanTasks', readPlanTasks),
      readQuestions: pick('readQuestions', readQuestionsFile),
      readCode: pick('readCode', readCode),
      readTokens: pick('readTokens', readTokens),
    };

    // eligibility (R4.4): only a run that reached `done`, and that has a start instant
    const own = parseHealth(state);
    if (state.phase !== 'done' || !own.startedAt) return failure('not-eligible');

    const mode = hasOwn(state, 'mode') ? state.mode : 'attended';
    if (!MODES.includes(mode) || !isDate(state.created)) return failure('bad-state');
    const closedAt = toUtcInstant(state.phaseChangedAt) || nowIso;
    if (!closedAt) return failure('bad-state');
    const failed = typeof state.status === 'string' && state.status.toLowerCase() === 'failed';

    const parsed = plain(() => readers.parseHealth(state));
    const facts = isObject(parsed) && isObject(parsed.health) ? parsed : { phaseLog: null, health: { taskRetries: null, testsGreenFirstRun: null, review: null, hardenFindings: null } };
    const health = facts.health;
    const healthObject = isObject(parsed) && hasOwn(state, 'health') && isObject(state.health);
    const present = { health: healthObject, taskRetries: healthObject && hasOwn(state.health, 'taskRetries') };

    const planFile = attempt(() => resolvePlan(config, state));
    const tasks = attempt(() => taskBlock(state, planFile, health, present, readers));
    const tests = healthObject ? { greenFirstRun: typeof health.testsGreenFirstRun === 'boolean' ? health.testsGreenFirstRun : null } : null;
    const review = isObject(health.review) ? { critical: health.review.critical, required: health.review.required, optional: health.review.optional, nit: health.review.nit } : null;
    const questions = attempt(() => questionsBlock(path.join(stateDir, slug, 'questions.json'), stateDir, slug, readers.readQuestions));

    const base = isObject(config.raw) && isObject(config.raw.branches) ? config.raw.branches.from : null;
    const codeResult = plain(() => readers.readCode({ projectDir, branch: state.branch, base }));
    const code = isObject(codeResult) && isObject(codeResult.code) ? codeResult.code : null;

    // tokens last: they are the slow source and get whatever is left of the budget
    const budgetMs = Math.max(0, CONSTANTS.BUDGET_MS - (Date.now() - started));
    const tokenResult = plain(() => readers.readTokens({
      projectDir,
      window: { startedAt: own.startedAt, closedAt },
      cwd: projectDir,
      otherWindows: otherWindows(projectDir, stateDir, slug, nowIso || closedAt),
      phaseLog: facts.phaseLog,
      budgetMs,
    }));
    const usable = isObject(tokenResult) && isObject(tokenResult.tokens);
    const models = usable && Array.isArray(tokenResult.models) ? tokenResult.models.filter((m) => typeof m === 'string' && SHAPE.model.test(m)).slice(0, 8) : [];

    const row = {
      v: 1,
      run: slug,
      created: state.created,
      closedAt,
      outcome: failed ? 'failed' : 'done',
      mode,
      primaryModel: models.length ? models[0] : null,
      models,
      sizePoints: isObject(state.size) && hasOwn(state.size, 'points') && isCount(state.size.points) ? state.size.points : null,
      tasks,
      tests,
      review,
      hardenFindings: isCount(health.hardenFindings) ? health.hardenFindings : null,
      questions,
      code,
      tokens: usable ? tokenResult.tokens : null,
      tokensNull: usable ? null : (isObject(tokenResult) && TOKENS_NULL.includes(tokenResult.reason) ? tokenResult.reason : 'unreadable-format'),
      agent: usable && isObject(tokenResult.agent) ? tokenResult.agent : null,
    };

    // Each block on its own: a reader that returned something off-shape loses its own
    // block, not the row. The probe is the row with every block null except the one tested.
    const probe = { ...row, tasks: null, tests: null, review: null, questions: null, code: null, agent: null, tokens: null, tokensNull: 'unreadable-format' };
    for (const key of NULLABLE_BLOCKS) {
      if (row[key] === null) continue;
      const candidate = key === 'tokens' ? { ...probe, tokens: row.tokens, tokensNull: null } : { ...probe, [key]: row[key] };
      if (!validateRow(candidate).ok) row[key] = null;
    }
    if (row.tokens === null) {
      if (row.tokensNull === null) row.tokensNull = 'unreadable-format';
      row.primaryModel = null;
      row.models = [];
    }
    const checked = validateRow(row);
    return checked.ok ? { ok: true, row: checked.row } : failure('invalid-row');
  } catch {
    return failure('internal');
  }
}

// --- transcript reader (spec R6) -------------------------------------------------
//
// Tokens are read from the subagents' transcripts under
// ~/.claude/projects/<slug>/<session>/subagents/agent-<id>.jsonl. That format is
// NOT a public contract and the files are written by someone else, so this reader
// is a fail-open boundary: whatever it meets, it returns `tokens: null` and a
// closed reason code, or a partial read that skips the odd part. It never throws,
// never fails a run, and nothing of the transcripts' TEXT comes out - only numbers,
// counts and model names that match a closed shape (a transcript line is data, and
// a JSON.parse message would quote it).
//
// Cost is bounded whatever is on disk: at most MAX_TRANSCRIPT_FILES files, sizes
// decided by lstat/fstat BEFORE anything is read, files read in 64 KiB blocks with
// a per-line ceiling (an oversize line is dropped as it streams, never held), and a
// time budget checked between entries and blocks.

const os = require('os');

const TRANSCRIPT_NAME = /^agent-[A-Za-z0-9]+\.jsonl$/;
/** requestId / tool_use id: an id from the API. Anything else is not counted. */
const API_ID = /^[A-Za-z0-9_-]{1,128}$/;
const READ_BLOCK = 64 * 1024;
/** Ceilings on what one call may remember; a transcript cannot exhaust memory. */
const MAX_REQUESTS = 200000;
const MAX_TOOL_IDS = 200000;
const MAX_DIR_ENTRIES = 20000;

/** A path made comparable: separators unified, no trailing one, case folded on
 *  Windows only (its file system does not tell `C:\X` from `c:\x`). */
function foldCwd(value) {
  if (typeof value !== 'string' || value.length > 1024) return null;
  const unified = value.replace(/[\\/]+/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

/** `usage` as four counts, or null when the shape is not the one we know. The two
 *  fields every request has must be counts; a cache field that is absent is 0, but
 *  one that is present must be a count too (a string or an object is not a number
 *  we can trust). */
function readUsage(usage) {
  if (!isObject(usage)) return null;
  const pick = (key, required) => {
    if (!hasOwn(usage, key) || usage[key] === undefined) return required ? null : 0;
    return isCount(usage[key]) ? usage[key] : null;
  };
  const input = pick('input_tokens', true);
  const output = pick('output_tokens', true);
  const cacheCreate = pick('cache_creation_input_tokens', false);
  const cacheRead = pick('cache_read_input_tokens', false);
  if ([input, output, cacheCreate, cacheRead].includes(null)) return null;
  return { input, output, cacheCreate, cacheRead };
}

/** The phase a request belongs to: the one AFTER the last phase completed before it
 *  (phaseLog records completions, spec R6.6); `other` without a log or past the last
 *  phase. `log` is already validated and sorted by time. */
function phaseAt(log, ms) {
  if (!log) return 'other';
  let last = -1;
  for (const entry of log) {
    if (entry.ms <= ms) last = PHASES.indexOf(entry.phase);
    else break;
  }
  return PHASES[last + 1] || 'other';
}

/** Streams `file` in blocks, calling onLine(text) per line and onOversize() for a
 *  line over the ceiling (dropped while streaming: never held whole). Returns
 *  'ok', 'timeout' or 'skip' (could not be opened / not a plain file / too big). */
function scanFile(file, deadline, onLine, onOversize) {
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.size > CONSTANTS.MAX_TRANSCRIPT_FILE_BYTES) return 'skip';
    const block = Buffer.alloc(READ_BLOCK);
    let parts = [];
    let length = 0;
    let over = false;
    const flush = () => {
      if (over) onOversize();
      else if (length > 0) onLine(Buffer.concat(parts, length).toString('utf8'));
      parts = [];
      length = 0;
      over = false;
    };
    let position = 0;
    while (position < stats.size) {
      if (Date.now() > deadline) return 'timeout';
      const n = fs.readSync(fd, block, 0, Math.min(READ_BLOCK, stats.size - position), position);
      if (n === 0) break;
      position += n;
      let start = 0;
      for (;;) {
        const newline = block.indexOf(0x0a, start);
        const end = newline === -1 || newline >= n ? n : newline;
        if (!over) {
          if (length + (end - start) > CONSTANTS.MAX_TRANSCRIPT_LINE_BYTES) {
            over = true;
            parts = [];
            length = 0;
          } else if (end > start) {
            parts.push(Buffer.from(block.subarray(start, end)));
            length += end - start;
          }
        }
        if (end === n) break;
        flush();
        start = end + 1;
      }
    }
    flush();
    return 'ok';
  } catch {
    return 'skip';
  } finally {
    closeQuietly(fd);
  }
}

function closeDirQuietly(dir) {
  try {
    if (dir) dir.closeSync();
  } catch {
    // nothing to do
  }
}

/** Lists the candidate transcript files, or `{ reason }`. Every entry is lstat'ed
 *  (a link is never followed) and its path checked against the projects root. */
function listTranscripts(projectsRoot, base, startMs, limits, expired) {
  const files = [];
  let total = 0;
  let oversize = 0;
  let sessions = null;
  try {
    sessions = fs.opendirSync(base);
    for (let seen = 0, entry; (entry = sessions.readSync()) !== null; seen += 1) {
      if (seen >= MAX_DIR_ENTRIES || expired()) return { reason: 'timeout' };
      if (!SAFE_SEGMENT.test(entry.name)) continue;
      const sub = path.join(base, entry.name, 'subagents');
      let stats;
      try {
        if (!fs.lstatSync(path.join(base, entry.name)).isDirectory()) continue;
        stats = fs.lstatSync(sub);
      } catch {
        continue;
      }
      if (!stats.isDirectory() || crossesLink(projectsRoot, sub)) continue;
      let dir = null;
      try {
        dir = fs.opendirSync(sub);
        for (let inner = 0, item; (item = dir.readSync()) !== null; inner += 1) {
          if (inner >= MAX_DIR_ENTRIES || expired()) return { reason: 'timeout' };
          if (!TRANSCRIPT_NAME.test(item.name)) continue;
          const file = path.join(sub, item.name);
          let fstats;
          try {
            fstats = fs.lstatSync(file);
          } catch {
            continue;
          }
          if (!fstats.isFile() || !isInside(projectsRoot, file) || crossesLink(projectsRoot, file)) continue;
          // last written before the run began: it cannot hold a line of this run
          if (fstats.mtimeMs < startMs) continue;
          if (files.length + 1 > limits.maxFiles) return { reason: 'timeout' };
          if (fstats.size > CONSTANTS.MAX_TRANSCRIPT_FILE_BYTES) {
            oversize += 1;
            // the name (already TRANSCRIPT_NAME) lets the loop join tell an oversize transcript from a missing one
            files.push({ file: null, name: item.name });
            continue;
          }
          total += fstats.size;
          if (total > limits.maxTotalBytes) return { reason: 'timeout' };
          files.push({ file });
        }
      } catch {
        // an unreadable folder is skipped, like any other odd entry
      } finally {
        closeDirQuietly(dir);
      }
    }
    return { files, oversize };
  } catch {
    return { files, oversize };
  } finally {
    closeDirQuietly(sessions);
  }
}

const noTokens = (reason, skipped) => ({ tokens: null, agent: null, models: [], primaryModel: null, reason, skipped: skipped || { lines: 0, files: 0 } });

/**
 * `readTokens({ projectDir, window, cwd, otherWindows, phaseLog, budgetMs, limits })`
 * -> `{ tokens, agent, models, primaryModel, reason, skipped }`. Never throws.
 *
 * `window` is `{ startedAt, closedAt }` (instants in UTC with a Z); `cwd` defaults to
 * `projectDir`; `otherWindows` are the windows of the other runs of the project
 * (their overlap makes attribution impossible: nothing in a transcript names a run);
 * `phaseLog` is the run's `phaseLog` (validated again here). `budgetMs`/`limits` can
 * only TIGHTEN the defaults (tests, and a caller that has already spent part of the
 * budget).
 *
 * `tokens: null` comes with one of `no-window`, `overlap`, `no-transcripts` (nothing
 * usable belongs to this run), `unreadable-format` (files exist but no line has the
 * shape we know) or `timeout` (a limit was hit). `skipped` counts what was dropped:
 * lines (bad JSON, oversize, bad usage) and files (oversize, unopenable).
 */
function readTokens(options) {
  try {
    const opts = isObject(options) ? options : {};
    const window = isObject(opts.window) ? opts.window : {};
    if (!isInstant(window.startedAt) || !isInstant(window.closedAt)) return noTokens('no-window');
    const startMs = Date.parse(window.startedAt);
    const endMs = Date.parse(window.closedAt);
    if (!(startMs <= endMs)) return noTokens('no-window');

    const others = Array.isArray(opts.otherWindows) ? opts.otherWindows : [];
    for (const other of others.slice(0, 1000)) {
      if (!isObject(other) || !isInstant(other.startedAt) || !isInstant(other.closedAt)) continue;
      if (Date.parse(other.startedAt) <= endMs && Date.parse(other.closedAt) >= startMs) return noTokens('overlap');
    }

    if (typeof opts.projectDir !== 'string' || opts.projectDir === '' || opts.projectDir.length > 1024) return noTokens('no-transcripts');
    // the slug has only [A-Za-z0-9-]: whatever the projectDir holds, this is ONE folder name
    const slug = opts.projectDir.replace(/[^A-Za-z0-9]/g, '-');
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    const base = path.join(projectsRoot, slug);
    if (!isInside(projectsRoot, base) || crossesLink(projectsRoot, base)) return noTokens('no-transcripts');
    try {
      if (!fs.lstatSync(base).isDirectory()) return noTokens('no-transcripts');
    } catch {
      return noTokens('no-transcripts');
    }

    const budget = typeof opts.budgetMs === 'number' && Number.isFinite(opts.budgetMs) ? Math.min(opts.budgetMs, CONSTANTS.BUDGET_MS) : CONSTANTS.BUDGET_MS;
    const deadline = Date.now() + budget;
    const expired = () => Date.now() > deadline;
    const given = isObject(opts.limits) ? opts.limits : {};
    const limits = {
      maxFiles: isCount(given.maxFiles) ? Math.min(given.maxFiles, CONSTANTS.MAX_TRANSCRIPT_FILES) : CONSTANTS.MAX_TRANSCRIPT_FILES,
      maxTotalBytes: isCount(given.maxTotalBytes) ? Math.min(given.maxTotalBytes, CONSTANTS.MAX_TRANSCRIPT_TOTAL_BYTES) : CONSTANTS.MAX_TRANSCRIPT_TOTAL_BYTES,
    };

    const listed = listTranscripts(projectsRoot, base, startMs, limits, expired);
    if (listed.reason) return noTokens(listed.reason);

    const phaseLog = parsePhaseLog(opts.phaseLog);
    const log = phaseLog ? phaseLog.map((e) => ({ phase: e.phase, ms: Date.parse(e.at) })).sort((a, b) => a.ms - b.ms) : null;
    const wantCwd = foldCwd(typeof opts.cwd === 'string' ? opts.cwd : opts.projectDir);
    if (wantCwd === null) return noTokens('no-transcripts');

    const skipped = { lines: 0, files: listed.oversize };
    const requests = new Map();
    const toolIds = new Set();
    const errorIds = new Set();
    let anonymousErrors = 0;
    let recognised = 0;
    let scanned = listed.oversize;
    let overflow = false;

    const onLine = (text) => {
      let line;
      try {
        line = JSON.parse(text);
      } catch {
        skipped.lines += 1; // never the parser's message: it quotes the input
        return;
      }
      if (!isObject(line)) {
        skipped.lines += 1;
        return;
      }
      const message = isObject(line.message) ? line.message : {};
      const usage = line.type === 'assistant' ? readUsage(message.usage) : null;
      if (line.type === 'assistant') {
        if (!usage) {
          skipped.lines += 1;
          return;
        }
        recognised += 1;
      }
      // in scope: inside the run's window and under this project's cwd
      if (!isInstant(line.timestamp)) return;
      const ms = Date.parse(line.timestamp);
      if (ms < startMs || ms > endMs || foldCwd(line.cwd) !== wantCwd) return;
      const content = Array.isArray(message.content) ? message.content.slice(0, 500) : [];

      if (line.type === 'user') {
        for (const item of content) {
          if (!isObject(item) || item.type !== 'tool_result' || item.is_error !== true) continue;
          if (typeof item.tool_use_id === 'string' && API_ID.test(item.tool_use_id)) {
            if (errorIds.size < MAX_TOOL_IDS) errorIds.add(item.tool_use_id);
          } else {
            anonymousErrors += 1;
          }
        }
        return;
      }
      if (line.type !== 'assistant') return;
      if (typeof line.requestId !== 'string' || !API_ID.test(line.requestId) || message.model === '<synthetic>') return;

      let request = requests.get(line.requestId);
      if (!request) {
        if (requests.size >= MAX_REQUESTS) {
          overflow = true;
          return;
        }
        request = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, model: null, ms };
        requests.set(line.requestId, request);
      }
      // the same request is written once per content block and only `output` grows:
      // the largest value of each field is the request's final one
      for (const key of ['input', 'output', 'cacheCreate', 'cacheRead']) request[key] = Math.max(request[key], usage[key]);
      if (request.model === null && typeof message.model === 'string' && SHAPE.model.test(message.model)) request.model = message.model;
      for (const item of content) {
        if (isObject(item) && item.type === 'tool_use' && typeof item.id === 'string' && API_ID.test(item.id) && toolIds.size < MAX_TOOL_IDS) toolIds.add(item.id);
      }
    };
    const onOversize = () => {
      skipped.lines += 1;
    };

    for (const { file } of listed.files) {
      if (file === null) continue;
      if (expired()) return noTokens('timeout', skipped);
      const outcome = scanFile(file, deadline, onLine, onOversize);
      if (outcome === 'timeout') return noTokens('timeout', skipped);
      if (outcome === 'skip') skipped.files += 1;
      scanned += 1;
    }
    if (overflow) return noTokens('timeout', skipped);

    if (requests.size === 0) return noTokens(recognised === 0 && scanned > 0 ? 'unreadable-format' : 'no-transcripts', skipped);

    const totals = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 };
    const phases = new Map();
    const perModel = new Map();
    let contextPeak = 0;
    for (const request of requests.values()) {
      for (const key of Object.keys(totals)) totals[key] += request[key];
      contextPeak = Math.max(contextPeak, request.input + request.cacheCreate + request.cacheRead);
      const phase = phaseAt(log, request.ms);
      const slot = phases.get(phase) || { in: 0, out: 0 };
      slot.in += request.input + request.cacheCreate;
      slot.out += request.output;
      phases.set(phase, slot);
      if (request.model !== null) perModel.set(request.model, (perModel.get(request.model) || 0) + 1);
    }
    const denominator = totals.input + totals.cacheCreate + totals.cacheRead;
    const byPhase = {};
    for (const key of BY_PHASE_KEYS) if (phases.has(key)) byPhase[key] = phases.get(key);
    const tokens = {
      input: totals.input,
      cacheCreate: totals.cacheCreate,
      cacheRead: totals.cacheRead,
      output: totals.output,
      cacheHitRate: denominator === 0 ? null : Math.round((totals.cacheRead / denominator) * 10000) / 10000,
      byPhase,
    };
    const agent = { requests: requests.size, toolCalls: toolIds.size, toolErrors: errorIds.size + anonymousErrors, contextPeak };
    // sums of many bounded counts can still pass the ceiling: that is not a measurement
    const sane = [tokens.input, tokens.cacheCreate, tokens.cacheRead, tokens.output, ...Object.values(agent), ...Object.values(byPhase).flatMap((s) => [s.in, s.out])].every(isCount);
    if (!sane) return noTokens('unreadable-format', skipped);
    const models = [...perModel.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 8).map(([name]) => name);
    return { tokens, agent, models, primaryModel: models.length ? models[0] : null, reason: null, skipped };
  } catch {
    return noTokens('unreadable-format');
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
function baseline(history, current, options) {
  // The options are read defensively and only whole numbers survive: n and min are
  // echoed in the result, so a string/object/NaN/getter must never get through (and a
  // `null` options object must not throw at a destructuring outside the try below).
  const wholeOr = (key, fallback, low) => {
    try {
      const value = isObject(options) ? options[key] : undefined;
      return Number.isInteger(value) && value >= low && value <= CONSTANTS.HISTORY_MAX_ROWS ? value : fallback;
    } catch { return fallback; }
  };
  const n = wholeOr('n', CONSTANTS.BASELINE_N, 0);
  const min = wholeOr('min', CONSTANTS.BASELINE_MIN, 1);
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
  readTokens,
  readCode,
  collect,
  closeRun,
};

// --- loop start events (spec 6.1, RF-001..RF-004, RF-060..RF-062; plan T1) --------------------
//
// One line per subagent of a live run, written by the SubagentStart hook at the moment the
// subagent starts, in `<stateDir>/<run>/loop-events.jsonl`. WHY a start event at all: the
// transcript of a subagent (`agent-<id>.jsonl`) says what it spent, but not which run, phase
// or task it served - only the hook knows that, and only at that moment, from state.json. The
// close (closeRun, a later task) joins each start to its transcript and writes one line per
// loop to the project's history.
//
// Deliberately AFTER module.exports and BEFORE closeRun: the security suites scan slices of
// this file that end at module.exports and that start at closeRun, and the code here does I/O
// and reads TASK_FLOW_METRICS, which those slices forbid or count. Exported with
// Object.assign for the same reason.
//
// Trust. The hook's payload, state.json and the events file are all input somebody else may
// have written. So: the payload gives two values and only when they match their closed shape
// (`agent_id`, `agent_type`) - session_id, transcript_path, cwd and the rest are never read,
// let alone stored (RF-003, RF-062); state.json gives a phase from PHASES and a task id in
// SHAPE.taskId, anything else becomes `unknown` / ''; the run folder must be a SAFE_SEGMENT;
// the file goes through appendLine (contained in the project and the state folder, no link,
// a plain file, append-only, no folder created, nothing once it is over 1 MiB). The reader
// rebuilds every line fresh from validated values and only counts what it rejects.
//
// It FAILS OPEN (RF-061): every failure is a closed `{ ok, code }`, never an exception, and
// the hook ignores the result. A subagent must start whatever happens here.

const LOOP_EVENTS_FILE = 'loop-events.jsonl';
const LOOP_EVENT_KEYS = ['v', 'kind', 'agent', 'type', 'phase', 'task', 'at'];
const LOOP_PHASES = [...PHASES, 'unknown'];

const loopResult = (ok, code) => ({ ok, code });
/** An own property or undefined: an inherited or polluted key never answers. */
const ownValue = (object, key) => (hasOwn(object, key) ? object[key] : undefined);

/** The phase a subagent started now works in: state.json's `phase` is the last stage
 *  COMPLETED (SKILL.md section 8), so the work in flight is the next one. Past the last
 *  phase, or for anything that is not a phase, `unknown` - never a guess. */
function phaseInFlight(done) {
  const index = typeof done === 'string' ? PHASES.indexOf(done) : -1;
  return index >= 0 && index + 1 < PHASES.length ? PHASES[index + 1] : 'unknown';
}

/**
 * Appends the start event of one subagent to the live run's loop-events.jsonl.
 * `options`: `{ projectDir, payload, env }` - the hook's project, its parsed stdin and
 * the environment (only TASK_FLOW_METRICS is read from it; the configuration expands
 * its folder variables from the real environment, as in closeRun).
 *
 * Checks, in this order (RF-001): the switch; a valid configuration; exactly one running
 * run, whose folder is a safe segment (two live runs: no way to tell which one the
 * subagent serves, so none); the payload's two values in shape. Returns `{ ok, code }`:
 * `written`, `disabled` (ok), or `bad-input`, `bad-config`, `no-single-run`, `bad-payload`,
 * `bad-state`, `too-long`, `unsafe-path`, `full`, `write-failed`, `internal`. Never throws.
 */
function appendLoopEvent(options) {
  try {
    const opts = isObject(options) ? options : {};
    const env = isObject(opts.env) ? opts.env : process.env;
    if (String(env.TASK_FLOW_METRICS || '').toLowerCase() === 'off') return loopResult(true, 'disabled');
    const { projectDir, payload } = opts;
    if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir) || !isObject(payload)) return loopResult(false, 'bad-input');

    const loaded = loadConfig(projectDir);
    if (!loaded.ok || !loaded.config || typeof loaded.config.stateDir !== 'string') return loopResult(false, 'bad-config');
    const stateDir = loaded.config.stateDir;

    const runs = runningRuns(projectDir);
    if (runs.length !== 1 || !isSlug(runs[0])) return loopResult(false, 'no-single-run');
    const run = runs[0];

    const agent = ownValue(payload, 'agent_id');
    const type = ownValue(payload, 'agent_type');
    if (typeof agent !== 'string' || !SHAPE.agentId.test(agent) || typeof type !== 'string' || !SHAPE.agentType.test(type)) {
      return loopResult(false, 'bad-payload');
    }

    const state = readSmallObject(projectDir, path.join(stateDir, run, 'state.json'));
    if (!state) return loopResult(false, 'bad-state');
    const cursor = ownValue(state, 'buildCursor');
    const event = {
      v: 1,
      kind: 'start',
      agent,
      type,
      phase: phaseInFlight(ownValue(state, 'phase')),
      task: typeof cursor === 'string' && SHAPE.taskId.test(cursor) ? cursor : '',
      at: new Date().toISOString(),
    };
    const body = JSON.stringify(event);
    if (Buffer.byteLength(body, 'utf8') + 1 > CONSTANTS.LOOP_EVENT_MAX_BYTES) return loopResult(false, 'too-long');
    const file = path.join(stateDir, run, LOOP_EVENTS_FILE);
    const written = appendLine(projectDir, stateDir, file, body, CONSTANTS.LOOP_EVENTS_MAX_FILE_BYTES);
    return written.ok ? loopResult(true, 'written') : loopResult(false, written.code);
  } catch {
    return loopResult(false, 'internal');
  }
}

/** One line of loop-events.jsonl as parsed JSON, or null. Length first (a long line is never
 *  parsed); the parser's message, which quotes the input, is dropped. */
function parseEventLine(line) {
  if (line.length > CONSTANTS.LOOP_EVENT_MAX_BYTES || Buffer.byteLength(line, 'utf8') > CONSTANTS.LOOP_EVENT_MAX_BYTES) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** A parsed event as a fresh start event, or null: the closed shape of every field. */
function parseStartEvent(value) {
  if (!hasExactKeys(value, LOOP_EVENT_KEYS) || value.v !== 1 || value.kind !== 'start') return null;
  const { agent, type, phase, task, at } = value;
  if (typeof agent !== 'string' || !SHAPE.agentId.test(agent)) return null;
  if (typeof type !== 'string' || !SHAPE.agentType.test(type)) return null;
  if (!LOOP_PHASES.includes(phase)) return null;
  if (task !== '' && !(typeof task === 'string' && SHAPE.taskId.test(task))) return null;
  if (!isInstant(at)) return null;
  return { v: 1, kind: 'start', agent, type, phase, task, at };
}

/**
 * The events of run `slug`, oldest first: `{ starts, results, ignored }`. `results` are the
 * loop-result events (plan T5, toResultEvent); `ignored` counts the non-blank lines that are
 * not a valid event of either kind. Only the bounded tail is read (the writer's cap plus
 * one line, so a file the writer filled is read whole). A missing, refused or unreadable
 * file is simply no events. Never throws, never carries text from the file.
 */
function readLoopEvents(projectDir, stateDir, slug) {
  const empty = () => ({ starts: [], results: [], ignored: 0 });
  try {
    if (!isSlug(slug) || typeof stateDir !== 'string') return empty();
    const file = path.join(stateDir, slug, LOOP_EVENTS_FILE);
    const tail = readTail(projectDir, stateDir, file, CONSTANTS.LOOP_EVENTS_MAX_FILE_BYTES + CONSTANTS.LOOP_EVENT_MAX_BYTES);
    const result = empty();
    if (tail.code) return result;
    for (const raw of tail.text.split('\n')) {
      const line = raw.replace(/^﻿/, '');
      if (line.trim() === '') continue;
      const value = parseEventLine(line);
      const start = parseStartEvent(value);
      const outcome = start ? null : toResultEvent(value);
      if (start) result.starts.push(start);
      else if (outcome) result.results.push(outcome);
      else result.ignored += 1;
    }
    return result;
  } catch {
    return empty();
  }
}

/**
 * The agent ids of run `slug`'s loops still owed a result, sorted and each once (spec 6.2,
 * RF-024; plan T6) - what the Stop hook asks the orchestrator to record with loop-result.
 * A loop is owed one when it has a start event, no result event, AND the run has moved on
 * from where it started: the phase a start event would record now (phaseInFlight) or the
 * cursor (in SHAPE.taskId, else '') differ from the start's - derived exactly as
 * appendLoopEvent records them, so the comparison is like for like. A loop still running in
 * the background while the run has not moved is not owed anything yet.
 *
 * `state` is the run's parsed state.json, untrusted: only its own `phase` and `buildCursor`
 * are read, through closed shapes. The ids come from readLoopEvents, so each is in
 * SHAPE.agentId - the only thing of the file the caller may show. Never throws; any failure
 * (no file, a refused or unreadable one, no state) is [] - nothing to ask for (RF-026).
 */
function loopsWithoutResult(projectDir, stateDir, slug, state) {
  try {
    if (!isObject(state)) return [];
    const events = readLoopEvents(projectDir, stateDir, slug);
    const phase = phaseInFlight(ownValue(state, 'phase'));
    const cursor = ownValue(state, 'buildCursor');
    const task = typeof cursor === 'string' && SHAPE.taskId.test(cursor) ? cursor : '';
    const answered = new Set(events.results.map((r) => r.agent));
    const owed = new Set();
    for (const start of events.starts) {
      if (!answered.has(start.agent) && (start.phase !== phase || start.task !== task)) owed.add(start.agent);
    }
    return [...owed].sort();
  } catch {
    return [];
  }
}

Object.assign(module.exports, { appendLoopEvent, readLoopEvents });
Object.assign(module.exports, { loopsWithoutResult });

// --- loop rows: the closed shape and the history loops.jsonl (spec 6.1, RF-009; plan T3) ---------
//
// One line per loop - one execution of an agent - in `<stateDir>/loops.jsonl`, the project's
// loop history beside metrics.jsonl. The SAME validator takes the three origins (SC-007): a
// task-flow subagent joined to its transcript at the close, a paperclip loop read from its API,
// and a backfilled old run. WHY one shape for all three: the page, the PR summary and any later
// comparison read one file and never ask where a line came from beyond `source`.
//
// Same section placement as the start events above (after module.exports, before closeRun), for
// the same reason. Same trust model as metrics.jsonl: the file is repository data anybody may
// have edited, so a line is a row only when every field is in its closed shape, an unknown key
// at any level invalidates it, and the row handed back is rebuilt from the validated values
// (never the parsed object: no prototype pollution, no smuggled key). A wrong line is counted,
// never echoed. The key of a row is `source` + `run` + `id`; the FIRST line of a key wins on
// read, and the writer never appends a key that is already there (RF-052: idempotent backfill).

const LOOPS_FILE = 'loops.jsonl';
const LOOP_KEYS = [
  'v', 'source', 'run', 'id', 'agentType', 'phase', 'task', 'round', 'model', 'effort', 'startedAt', 'durationS',
  'tokens', 'costCents', 'outcome', 'tests', 'critical', 'required', 'reason', 'backfill',
];
const LOOP_TOKEN_KEYS = ['input', 'cacheCreate', 'cacheRead', 'output'];
const LOOP_SOURCES = ['taskflow', 'paperclip'];
const LOOP_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'unknown'];
const LOOP_OUTCOMES = ['ok', 'retry', 'failed', 'unknown'];
const LOOP_TESTS = ['green', 'red'];
const LOOP_REASONS = ['no-transcript', 'unreadable-format', 'timeout'];
/** RF-009: one line of loops.jsonl. A full row is about 800 bytes; past this it is not ours. */
const LOOP_ROW_MAX_BYTES = 1024;
/** Only the tail is read. Bigger than the metrics.jsonl tail on purpose: the writer checks it
 *  for keys already present, and a backfill must still see the rows it wrote earlier (about
 *  5 000 rows fit). More lines than LOOPS_MAX_LINES in it: only the newest are parsed. */
const LOOPS_TAIL_BYTES = 4 * 1024 * 1024;
const LOOPS_MAX_LINES = 20000;
/** A paperclip id: a lower-case UUID, the form its API uses in paths. One spelling only, so
 *  that the same loop can never be two keys. */
const PAPERCLIP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isShape = (re) => (value) => typeof value === 'string' && re.test(value);
const isRound = (value) => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 99;

/**
 * Is `row` a valid version-1 loop line? Never throws. `{ ok: true, row }` with `row` rebuilt
 * from the validated values, in LOOP_KEYS order; `{ ok: false }` for a wrong shape;
 * `{ ok: false, ignored: true }` for another version (a newer task-flow's line is not an
 * error). No reason text, as in validateRow.
 *
 * Two rules tie fields together: `costCents` can only be a number on a paperclip line (RF-045:
 * money only from paperclip, never priced by task-flow), and `reason` explains missing tokens,
 * so it can only be set when `tokens` is null (tokens null with no reason is allowed: a
 * paperclip loop may simply report none).
 */
function validateLoopRow(row) {
  try {
    if (!isObject(row)) return { ok: false };
    if (hasOwn(row, 'v') && row.v !== 1 && typeof row.v === 'number') return { ok: false, ignored: true };
    if (!hasExactKeys(row, LOOP_KEYS) || row.v !== 1 || !LOOP_SOURCES.includes(row.source)) return { ok: false };
    const paperclip = row.source === 'paperclip';
    const tokens = row.tokens;
    if (tokens !== null && !(hasExactKeys(tokens, LOOP_TOKEN_KEYS) && LOOP_TOKEN_KEYS.every((key) => isCount(tokens[key])))) return { ok: false };

    const fields =
      (row.run === 'unknown' || isSlug(row.run)) &&
      (paperclip ? isShape(PAPERCLIP_ID)(row.id) : isShape(SHAPE.agentId)(row.id)) &&
      isShape(SHAPE.agentType)(row.agentType) &&
      LOOP_PHASES.includes(row.phase) &&
      (row.task === '' || isShape(SHAPE.taskId)(row.task)) &&
      orNull(isRound)(row.round) &&
      orNull(isShape(SHAPE.model))(row.model) &&
      (row.effort === null || LOOP_EFFORTS.includes(row.effort)) &&
      orNull(isInstant)(row.startedAt) &&
      orNull(isCount)(row.durationS) &&
      (row.costCents === null || (paperclip && isCount(row.costCents))) &&
      (row.outcome === null || LOOP_OUTCOMES.includes(row.outcome)) &&
      (row.tests === null || LOOP_TESTS.includes(row.tests)) &&
      orNull(isCount)(row.critical) &&
      orNull(isCount)(row.required) &&
      (row.reason === null || (tokens === null && LOOP_REASONS.includes(row.reason))) &&
      isBool(row.backfill);
    if (!fields) return { ok: false };

    const fresh = {};
    for (const key of LOOP_KEYS) fresh[key] = row[key];
    fresh.tokens = tokens === null ? null : { input: tokens.input, cacheCreate: tokens.cacheCreate, cacheRead: tokens.cacheRead, output: tokens.output };
    if (Buffer.byteLength(JSON.stringify(fresh), 'utf8') > LOOP_ROW_MAX_BYTES) return { ok: false };
    return { ok: true, row: fresh };
  } catch {
    return { ok: false };
  }
}

/** One loops.jsonl line (text, without its newline) to a validated row. Never throws, never
 *  echoes: length before parsing, and the JSON.parse message (which quotes the input) dropped. */
function parseLoopRow(line) {
  try {
    if (typeof line !== 'string') return { ok: false };
    const text = line.replace(/^﻿/, '').replace(/[\r\n]+$/, '');
    if (text.length > LOOP_ROW_MAX_BYTES || Buffer.byteLength(text, 'utf8') > LOOP_ROW_MAX_BYTES) return { ok: false };
    return validateLoopRow(JSON.parse(text));
  } catch {
    return { ok: false };
  }
}

const loopKey = (row) => `${row.source}\n${row.run}\n${row.id}`;

/**
 * The validated rows of `<stateDir>/loops.jsonl`, oldest first, one per key (the first line
 * wins). `{ rows, ignored, code }` exactly as readHistory: `ignored` counts non-blank lines that
 * are not a row (a duplicate key is a valid row, not counted); `code` null, `unsafe-path` or
 * `read-failed`. Bounded whatever the file; never throws, never carries text from the file.
 */
function readLoops(projectDir, stateDir) {
  const result = { rows: [], ignored: 0, code: null };
  try {
    if (typeof stateDir !== 'string') return { ...result, code: 'unsafe-path' };
    const tail = readTail(projectDir, stateDir, path.join(stateDir, LOOPS_FILE), LOOPS_TAIL_BYTES);
    if (tail.code) return { ...result, code: tail.code };
    let lines = tail.text.split('\n');
    if (lines.length > LOOPS_MAX_LINES) lines = lines.slice(-LOOPS_MAX_LINES);
    const seen = new Set();
    for (const raw of lines) {
      if (raw.replace(/^﻿/, '').trim() === '') continue;
      const parsed = parseLoopRow(raw);
      if (!parsed.ok) {
        result.ignored += 1;
        continue;
      }
      const key = loopKey(parsed.row);
      if (seen.has(key)) continue;
      seen.add(key);
      result.rows.push(parsed.row);
    }
    return result;
  } catch {
    return { rows: [], ignored: 0, code: 'read-failed' };
  }
}

/**
 * Appends to `<stateDir>/loops.jsonl` the rows of `rows` that are valid and whose key is not in
 * the history yet (nor earlier in the same batch), each serialised from its validated object,
 * all in ONE append (appendLine: contained, no link, no folder created). Returns
 * `{ ok, code, written, invalid }`: code null on success (`written` 0 means nothing new, and
 * then no file is created), or `bad-input`, `unsafe-path`, `read-failed`, `write-failed`.
 * A history that cannot be read is not written either: without it the keys already there are
 * unknown, and a blind append would duplicate them. Never throws.
 */
function appendLoopRows(projectDir, stateDir, rows) {
  const outcome = (ok, code, written, invalid) => ({ ok, code, written, invalid });
  try {
    if (!Array.isArray(rows)) return outcome(false, 'bad-input', 0, 0);
    const history = readLoops(projectDir, stateDir);
    if (history.code) return outcome(false, history.code, 0, 0);
    const seen = new Set(history.rows.map(loopKey));
    const lines = [];
    let invalid = 0;
    for (const row of rows) {
      const checked = validateLoopRow(row);
      if (!checked.ok) {
        invalid += 1;
        continue;
      }
      const key = loopKey(checked.row);
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(JSON.stringify(checked.row));
    }
    if (lines.length === 0) return outcome(true, null, 0, invalid);
    const written = appendLine(projectDir, stateDir, path.join(stateDir, LOOPS_FILE), lines.join('\n'), Infinity);
    return written.ok ? outcome(true, null, lines.length, invalid) : outcome(false, written.code, 0, invalid);
  } catch {
    return outcome(false, 'write-failed', 0, 0);
  }
}

Object.assign(module.exports, { LOOP_KEYS, validateLoopRow, parseLoopRow, readLoops, appendLoopRows });

// --- the join: each loop's start event with its transcript, at the close (spec 6.1, RF-005..RF-008; plan T4)
//
// A start event says which run, phase and task a subagent served; its transcript
// `agent-<id>.jsonl` says what it spent. At the close (closeRun, below) the two are joined into
// one loop row per start event and appended to loops.jsonl. WHY at the close and not in the hook:
// the transcript is only complete once the subagent is done, and the close already runs once per
// run with a time budget.
//
// The transcripts are the same untrusted, unversioned format readTokens reads, so the same rules:
// ONE bounded listing of the project's transcript folder (listTranscripts: lstat, no link, names
// in TRANSCRIPT_NAME only, under ~/.claude/projects), files opened through scanFile (O_NOFOLLOW,
// fstat, size and line ceilings), only `assistant` records with an API_ID requestId and a usage in
// the known shape count, deduplicated by requestId with the max of each field. Nothing of the
// messages is read into a row: numbers, a model in SHAPE.model and an effort from a closed set.
// The agent id is never joined into a path - it only looks a listed name up.
//
// Fail open (RF-008): a loop whose transcript is missing, unreadable or out of time still gets
// its row, with tokens/duration/model/effort null and a closed reason, and never stops the others.

/** RF-007: the `effort:` of each agent this plugin ships (plugin/agents/*.md), by the type a
 *  SubagentStart payload gives it. A test compares it with the files, both ways. */
const AGENT_EFFORT = Object.freeze({
  'task-flow:code-reviewer': 'low',
  'task-flow:security-auditor': 'low',
  'task-flow:second-opinion-low': 'low',
  'task-flow:second-opinion-medium': 'medium',
  'task-flow:second-opinion-high': 'high',
  'task-flow:second-opinion-xhigh': 'xhigh',
  'task-flow:second-opinion-max': 'max',
});
const TRANSCRIPT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** The listing skips transcripts last written before the run's first start event, less this
 *  margin (clock rounding between the hook and the transcript writer). Not measured: a guess. */
const LOOP_MTIME_SLACK_MS = 60 * 1000;

/** The most frequent non-null value; a tie goes to the one that sorts first (deterministic). */
function mostFrequent(values) {
  const counts = new Map();
  for (const value of values) if (value !== null) counts.set(value, (counts.get(value) || 0) + 1);
  let best = null;
  for (const [value, n] of counts) {
    const top = best === null ? 0 : counts.get(best);
    if (n > top || (n === top && value < best)) best = value;
  }
  return best;
}

/**
 * What one loop's transcript says: `{ tokens, durationS, model, effort, reason: null }`, or
 * `{ reason }` (`timeout`, `unreadable-format`). `effort` is the most frequent closed value in the
 * records, or null (the caller applies RF-007's fallback). Never throws.
 */
function readLoopTranscript(file, deadline) {
  try {
    const requests = new Map();
    let first = null;
    let last = null;
    let overflow = false;
    const onLine = (text) => {
      let line;
      try {
        line = JSON.parse(text);
      } catch {
        return; // the parser's message quotes the input: dropped
      }
      if (!isObject(line)) return;
      const timestamp = ownValue(line, 'timestamp');
      if (isInstant(timestamp)) {
        const ms = Date.parse(timestamp);
        first = first === null ? ms : Math.min(first, ms);
        last = last === null ? ms : Math.max(last, ms);
      }
      if (ownValue(line, 'type') !== 'assistant') return;
      const id = ownValue(line, 'requestId');
      const message = ownValue(line, 'message');
      if (typeof id !== 'string' || !API_ID.test(id) || !isObject(message)) return;
      const model = ownValue(message, 'model');
      if (model === '<synthetic>') return;
      const usage = readUsage(ownValue(message, 'usage'));
      if (!usage) return;
      let request = requests.get(id);
      if (!request) {
        if (requests.size >= MAX_REQUESTS) {
          overflow = true;
          return;
        }
        request = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0, model: null, effort: null };
        requests.set(id, request);
      }
      // one request is written once per content block and only `output` grows: the max is final
      for (const key of LOOP_TOKEN_KEYS) request[key] = Math.max(request[key], usage[key]);
      if (request.model === null && typeof model === 'string' && SHAPE.model.test(model)) request.model = model;
      const effort = ownValue(line, 'effort');
      if (request.effort === null && TRANSCRIPT_EFFORTS.includes(effort)) request.effort = effort;
    };
    const scanned = scanFile(file, deadline, onLine, () => {});
    if (scanned === 'timeout' || overflow) return { reason: 'timeout' };
    if (scanned !== 'ok' || requests.size === 0) return { reason: 'unreadable-format' };

    const tokens = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 };
    for (const request of requests.values()) for (const key of LOOP_TOKEN_KEYS) tokens[key] += request[key];
    const durationS = first === null ? null : Math.round((last - first) / 1000);
    // sums of many bounded counts can still pass the ceiling: that is not a measurement
    if (!LOOP_TOKEN_KEYS.every((key) => isCount(tokens[key])) || !orNull(isCount)(durationS)) return { reason: 'unreadable-format' };
    const list = [...requests.values()];
    return {
      tokens,
      durationS,
      model: mostFrequent(list.map((r) => r.model)),
      effort: mostFrequent(list.map((r) => r.effort)),
      // the first record of any type: the backfill's run window (plan T13); joinLoops keeps the event's
      startedAt: first === null ? null : new Date(first).toISOString(),
      reason: null,
    };
  } catch {
    return { reason: 'unreadable-format' };
  }
}

/**
 * `joinLoops({ projectDir, slug, events, deadline })` -> the loop rows of run `slug`, in memory
 * (nothing is written): one per start event of `events` (readLoopEvents' result), the first start
 * of an agent id winning, in event order. The LAST result event of an agent (plan T5: a later
 * result is a correction) gives outcome, tests, critical, required and round, and its phase/task,
 * when set, beat the start's (RF-022: a security pass started while buildCursor had already
 * moved on is put right by its result); round comes only from a result (RF-023). A result with
 * no start adds no row (RF-005: one row per start event). `deadline` (ms since the epoch) can
 * only tighten the BUDGET_MS from now. Every row passes validateLoopRow; a start that would not is dropped.
 * Never throws.
 */
function joinLoops(options) {
  try {
    const opts = isObject(options) ? options : {};
    const { projectDir, slug } = opts;
    if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir) || projectDir.length > 1024 || !isSlug(slug)) return [];
    const given = isObject(opts.events) && Array.isArray(opts.events.starts) ? opts.events.starts : [];
    const limit = Date.now() + CONSTANTS.BUDGET_MS;
    const deadline = typeof opts.deadline === 'number' && Number.isFinite(opts.deadline) ? Math.min(opts.deadline, limit) : limit;
    const expired = () => Date.now() > deadline;

    const starts = [];
    const seen = new Set();
    for (const s of given.slice(0, 20000)) {
      if (!isObject(s) || typeof s.agent !== 'string' || !SHAPE.agentId.test(s.agent) || !isInstant(s.at) || seen.has(s.agent)) continue;
      seen.add(s.agent);
      starts.push(s);
    }
    if (starts.length === 0) return [];
    const results = new Map();
    const givenResults = isObject(opts.events) && Array.isArray(opts.events.results) ? opts.events.results : [];
    for (const r of givenResults.slice(-20000)) {
      const checked = toResultEvent(r);
      if (checked) results.set(checked.agent, checked);
    }

    const row = (s, read) => {
      const found = read.reason === null;
      const result = results.get(s.agent) || null;
      const from = (key) => (result === null ? null : result[key]);
      const fallback = typeof s.type === 'string' && hasOwn(AGENT_EFFORT, s.type) ? AGENT_EFFORT[s.type] : 'unknown';
      return {
        v: 1, source: 'taskflow', run: slug, id: s.agent, agentType: s.type,
        phase: from('phase') || s.phase,
        task: from('task') || s.task,
        round: from('round'),
        model: found ? read.model : null,
        effort: found ? read.effort || fallback : null,
        startedAt: s.at,
        durationS: found ? read.durationS : null,
        tokens: found ? read.tokens : null,
        costCents: null, outcome: from('outcome'), tests: from('tests'), critical: from('critical'), required: from('required'),
        reason: read.reason,
        backfill: false,
      };
    };
    const finish = (rows) => rows.map(validateLoopRow).filter((r) => r.ok).map((r) => r.row);
    const all = (reason) => finish(starts.map((s) => row(s, { reason })));

    // the same folder readTokens reads: the slug has only [A-Za-z0-9-], ONE folder name
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    const base = path.join(projectsRoot, projectDir.replace(/[^A-Za-z0-9]/g, '-'));
    if (!isInside(projectsRoot, base) || crossesLink(projectsRoot, base)) return all('no-transcript');
    try {
      if (!fs.lstatSync(base).isDirectory()) return all('no-transcript');
    } catch {
      return all('no-transcript');
    }
    if (expired()) return all('timeout');
    const startMs = Math.min(...starts.map((s) => Date.parse(s.at))) - LOOP_MTIME_SLACK_MS;
    const limits = { maxFiles: CONSTANTS.MAX_TRANSCRIPT_FILES, maxTotalBytes: CONSTANTS.MAX_TRANSCRIPT_TOTAL_BYTES };
    const listed = listTranscripts(projectsRoot, base, startMs, limits, expired);
    if (listed.reason) return all('timeout');
    // name -> file (null: listed but over the size ceiling); the first listed wins
    const byName = new Map();
    for (const entry of listed.files) {
      const name = entry.file === null ? entry.name : path.basename(entry.file);
      if (typeof name === 'string' && !byName.has(name)) byName.set(name, entry.file);
    }

    return finish(starts.map((s) => {
      if (expired()) return row(s, { reason: 'timeout' });
      const name = `agent-${s.agent}.jsonl`;
      if (!byName.has(name)) return row(s, { reason: 'no-transcript' });
      const file = byName.get(name);
      return row(s, file === null ? { reason: 'unreadable-format' } : readLoopTranscript(file, deadline));
    }));
  } catch {
    return [];
  }
}

/** closeRun's loop step: the run's start events joined and appended to loops.jsonl. A run with
 *  no start event reads no transcript and creates no file. The result is information only;
 *  `orphans` counts the result events whose agent has no start (ignored, plan T5). */
function recordLoops(projectDir, stateDir, slug, deadline) {
  try {
    const events = readLoopEvents(projectDir, stateDir, slug);
    const started = new Set(events.starts.map((s) => s.agent));
    const orphans = events.results.filter((r) => !started.has(r.agent)).length;
    if (events.starts.length === 0) return { ok: true, code: null, written: 0, invalid: 0, orphans };
    return { ...appendLoopRows(projectDir, stateDir, joinLoops({ projectDir, slug, events, deadline })), orphans };
  } catch {
    return { ok: false, code: 'internal', written: 0, invalid: 0, orphans: 0 };
  }
}

Object.assign(module.exports, { AGENT_EFFORT, joinLoops });

// --- the loop result: the loop-result CLI and its event (spec 6.2, RF-020..RF-023; plan T5) -------
//
// Only the orchestrator knows how a loop ended (a transcript does not say whether a review
// passed or a task must be redone), so after each loop it records it:
//
//   node plugin/scripts/metrics.js loop-result --slug <run> --agent <id> --outcome ok|retry|failed|unknown
//     [--tests green|red] [--critical <n>] [--required <n>] [--round <1-99>] [--phase <phase>]
//     [--task <id>] [--project-dir <dir>]
//
// It appends one `kind: "result"` event to the run's loop-events.jsonl, through the same writer
// as the start events (appendLine: contained, no link, no folder created, capped at 1 MiB);
// closeRun's join (above) puts the last one of each agent on that loop's row. A start event is
// not required (the CLI would have to read the file first); the close ignores and counts it.
//
// Trust. Every argument is untrusted text: the parse is all-or-nothing - each flag known, at most
// once, with a value in its closed shape - and anything else is exit 1 with ONE fixed message,
// nothing written. Nothing the caller passed is ever printed back (RF-021), not even on success:
// the output is `metrics: <closed code> loop-result`. A count is decimal digits with no leading
// zero (`08`, `1e3`, `-1`, ` 1` are not counts), turned into a number only after the regex.
//
// Here, before closeRun, for the same reasons as the sections above: this reads
// TASK_FLOW_METRICS (counted once from closeRun to the end of the file), and the CLI block only
// hands it control through `runCommand(argv, projectDir)`, so that block stays as it was.

const RESULT_KEYS = ['v', 'kind', 'agent', 'outcome', 'tests', 'critical', 'required', 'round', 'phase', 'task'];
const COUNT_ARG = /^(?:0|[1-9][0-9]{0,11})$/;
const ROUND_ARG = /^[1-9][0-9]?$/;
const CLI_USAGE = [
  'usage: metrics.js close --slug <slug> [--project-dir <dir>] [--quiet]',
  '       metrics.js loop-result --slug <run> --agent <id> --outcome ok|retry|failed|unknown',
  '         [--tests green|red] [--critical <n>] [--required <n>] [--round <1-99>]',
  `         [--phase ${PHASES.join('|')}] [--task <id>] [--project-dir <dir>]`,
  '       metrics.js time --slug <run> [--project-dir <dir>]',
  '       metrics.js summary --slug <run> [--project-dir <dir>]',
  '       metrics.js paperclip --issue <n> [--paperclip-issue <id>] [--project-dir <dir>]',
  '       metrics.js backfill [--project-dir <dir>]',
  '',
].join('\n');

/** A result event (parsed JSON, or the CLI's) as a fresh object, or null: exactly RESULT_KEYS,
 *  each value in its closed shape, every optional one null when absent. */
function toResultEvent(value) {
  if (!hasExactKeys(value, RESULT_KEYS) || value.v !== 1 || value.kind !== 'result') return null;
  const { agent, outcome, tests, critical, required, round, phase, task } = value;
  const ok =
    isShape(SHAPE.agentId)(agent) &&
    LOOP_OUTCOMES.includes(outcome) &&
    (tests === null || LOOP_TESTS.includes(tests)) &&
    orNull(isCount)(critical) &&
    orNull(isCount)(required) &&
    orNull(isRound)(round) &&
    (phase === null || PHASES.includes(phase)) &&
    orNull(isShape(SHAPE.taskId))(task);
  return ok ? { v: 1, kind: 'result', agent, outcome, tests, critical, required, round, phase, task } : null;
}

/** The flags of loop-result and the closed shape of each value. A Map: a flag from argv is never
 *  used as an object key (`__proto__`, `constructor` are simply unknown flags). */
const RESULT_FLAGS = new Map([
  ['--slug', isSlug],
  ['--agent', isShape(SHAPE.agentId)],
  ['--outcome', (v) => LOOP_OUTCOMES.includes(v)],
  ['--tests', (v) => LOOP_TESTS.includes(v)],
  ['--critical', (v) => COUNT_ARG.test(v)],
  ['--required', (v) => COUNT_ARG.test(v)],
  ['--round', (v) => ROUND_ARG.test(v)],
  ['--phase', (v) => PHASES.includes(v)],
  ['--task', isShape(SHAPE.taskId)],
  ['--project-dir', () => true], // resolved and checked by the CLI block, as for close
]);

/** `--flag value` pairs as a Map, or null: every flag in `flags` (a Map flag -> check), at most
 *  once, with a string value its check accepts. All or nothing. Shared by the CLI commands. */
function parseFlags(args, flags) {
  const given = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    const check = typeof flag === 'string' ? flags.get(flag) : undefined;
    if (!check || given.has(flag) || typeof value !== 'string' || !check(value)) return null;
    given.set(flag, value);
  }
  return given;
}

/** loop-result's arguments (after the command) as `{ slug, event }`, or null. All or nothing. */
function parseResultArgs(args) {
  const given = parseFlags(args, RESULT_FLAGS);
  if (!given || !given.has('--slug') || !given.has('--agent') || !given.has('--outcome')) return null;
  const text = (flag) => (given.has(flag) ? given.get(flag) : null);
  const number = (flag) => (given.has(flag) ? Number(given.get(flag)) : null);
  const event = toResultEvent({
    v: 1, kind: 'result', agent: text('--agent'), outcome: text('--outcome'), tests: text('--tests'),
    critical: number('--critical'), required: number('--required'), round: number('--round'),
    phase: text('--phase'), task: text('--task'),
  });
  return event ? { slug: given.get('--slug'), event } : null;
}

/** loop-result's write: a closed code (`written`, `invalid`, `bad-config`, `too-long`,
 *  appendLine's `unsafe-path` / `full` / `write-failed`, `internal`). Never throws. */
function appendLoopResult(projectDir, args) {
  try {
    const parsed = parseResultArgs(args);
    if (!parsed || typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) return 'invalid';
    const loaded = loadConfig(projectDir);
    if (!loaded.ok || !loaded.config || typeof loaded.config.stateDir !== 'string') return 'bad-config';
    const stateDir = loaded.config.stateDir;
    const body = JSON.stringify(parsed.event);
    if (Buffer.byteLength(body, 'utf8') + 1 > CONSTANTS.LOOP_EVENT_MAX_BYTES) return 'too-long';
    const file = path.join(stateDir, parsed.slug, LOOP_EVENTS_FILE);
    const written = appendLine(projectDir, stateDir, file, body, CONSTANTS.LOOP_EVENTS_MAX_FILE_BYTES);
    return written.ok ? 'written' : written.code;
  } catch {
    return 'internal';
  }
}

/**
 * Every CLI command but `close` (which the CLI block runs itself). Writes its own output and
 * sets process.exitCode, which it also returns. An unknown command is the usage text and 2, as
 * before this existed. `time` goes to timeCommand (plan T8, below), `summary` to summaryCommand (plan T9). loop-result: 0 when
 * written, or with TASK_FLOW_METRICS=off (checked first: nothing parsed, nothing done); else 1;
 * one fixed line either way. `projectDir` is the CLI block's resolution (--project-dir, CLAUDE_PROJECT_DIR, the cwd), or null.
 */
function runCommand(argv, projectDir) {
  const exit = (code, stream, text) => {
    stream.write(text);
    process.exitCode = code;
    return code;
  };
  try {
    const args = Array.isArray(argv) ? argv : [];
    if (args[0] === 'time') return timeCommand(args.slice(1), projectDir, exit); // plan T8, below
    if (args[0] === 'summary') return summaryCommand(args.slice(1), projectDir, exit); // plan T9, below
    // plan T12, below: asynchronous (HTTP), so this one returns a promise; it never rejects
    if (args[0] === 'paperclip') return paperclipCommand(args.slice(1), projectDir, exit);
    if (args[0] === 'backfill') return backfillCommand(args.slice(1), projectDir, exit); // plan T13, below
    if (args[0] !== 'loop-result') return exit(2, process.stderr, CLI_USAGE);
    if (String(process.env.TASK_FLOW_METRICS || '').toLowerCase() === 'off') return exit(0, process.stdout, 'metrics: disabled loop-result\n');
    const code = appendLoopResult(projectDir, args.slice(1));
    return code === 'written' ? exit(0, process.stdout, 'metrics: written loop-result\n') : exit(1, process.stderr, `metrics: ${code} loop-result\n`);
  } catch {
    return exit(1, process.stderr, 'metrics: internal loop-result\n');
  }
}

Object.assign(module.exports, { runCommand });

// --- the main transcripts and the time CLI (spec 6.3, RF-035..RF-037; plan T8) -------------------
//
// The run's row of the plan's `## Registo de tempo` table, computed instead of measured by hand
// with session-time.ps1 (decisions Q4, Q5: ONE row for the whole run window, in the plan's table):
//
//   node plugin/scripts/metrics.js time --slug <run> [--project-dir <dir>]
//   -> | <local date> | run /task-flow (spec → PR) | <session h> | <Claude h> | <effort> | <model> |
//
// The hours are the ps1's rule, ported: per main transcript (one session), the session runs from
// its first to its last event, and Claude works from each real user message to the last event
// before the next one; the sessions add up. Only the orchestrator's <session>.jsonl files at the
// top of ~/.claude/projects/<slug> are read - a subagent's transcript lives under
// <session>/subagents/ and is never listed, so loops running in parallel can never add up to more
// hours than the wall clock (pressuposto 5): their time is already inside the orchestrator's turn.
//
// Window: the run's startedAt to now while it is open, to phaseChangedAt once phase is `done`
// (repeated after the close, it must not count later sessions). An event counts only inside the
// window AND under the project's cwd; a record without a cwd does not count (as in readTokens).
//
// Trust. The main transcripts are the same untrusted, unversioned format as the subagents', so
// the same rules (RF-037 -> RF-006): one bounded listing (lstat, no link, a closed file name,
// mtime, file/total size ceilings), files read through scanFile, the time budget BUDGET_MS. A
// "real user message" is decided by FIELDS only (type, isMeta, isSidechain, toolUseResult), never
// by text: a message saying `"isMeta":true` is still the user's (the ps1 matched raw text; this
// does not). Nothing of a message reaches the output: numbers, the local date, a fixed phrase per
// language, an effort from a closed set and a model in SHAPE.model (which has no `|`), else
// `unknown`. It writes nothing. Without data, one fixed line `metrics: <code> time`, exit 0;
// arguments out of shape: the fixed usage, exit 2 - nothing the caller passed is printed back.

/** A main transcript: `<session id>.jsonl` (a UUID today). `agent-*.jsonl` live one level down. */
const MAIN_TRANSCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}\.jsonl$/;
/** Events one call may remember (each in-window, in-cwd timestamped record is one). A ceiling. */
const MAX_MAIN_EVENTS = 1000000;
const TIME_PHRASE = Object.freeze({ 'pt-PT': 'run /task-flow (spec → PR)', en: '/task-flow run (spec → PR)' });
const TIME_FLAGS = new Map([
  ['--slug', isSlug],
  ['--project-dir', () => true], // resolved and checked by the CLI block, as for close
]);

const noMain = (reason) => ({ reason, sessions: [], tokens: null, model: null, effort: null });

/** The main transcripts of `base`, or `{ reason }`: lstat'ed, never a link, inside the root. */
function listMainTranscripts(projectsRoot, base, startMs, expired) {
  const files = [];
  let total = 0;
  let dir = null;
  try {
    dir = fs.opendirSync(base);
    for (let seen = 0, entry; (entry = dir.readSync()) !== null; seen += 1) {
      if (seen >= MAX_DIR_ENTRIES || expired()) return { reason: 'timeout' };
      if (!MAIN_TRANSCRIPT_NAME.test(entry.name)) continue;
      const file = path.join(base, entry.name);
      let stats;
      try {
        stats = fs.lstatSync(file);
      } catch {
        continue;
      }
      if (!stats.isFile() || !isInside(projectsRoot, file) || crossesLink(projectsRoot, file)) continue;
      // last written before the run began: it cannot hold an event of this run
      if (stats.mtimeMs < startMs) continue;
      // a limit hit, never read: skipping a session would print fewer hours as if measured
      if (stats.size > CONSTANTS.MAX_TRANSCRIPT_FILE_BYTES) return { reason: 'timeout' };
      total += stats.size;
      if (files.length + 1 > CONSTANTS.MAX_TRANSCRIPT_FILES || total > CONSTANTS.MAX_TRANSCRIPT_TOTAL_BYTES) return { reason: 'timeout' };
      files.push(file);
    }
    return { files };
  } catch {
    return { files };
  } finally {
    closeDirQuietly(dir);
  }
}

/**
 * `readMainTranscripts({ projectDir, window, deadline })` -> `{ reason: null, sessions, tokens,
 * model, effort }` or `{ reason }` with sessions [] and the rest null. Never throws.
 *
 * `window` is `{ startedAt, closedAt }` (UTC instants with a Z). `sessions` has one
 * `{ events: [{ ms, real }] }` per main transcript with at least one event in the window and the
 * project's cwd, in file order (any timestamped record is an event, a sidechain one included, as
 * in the ps1). `tokens` are the orchestrator's (`assistant`, not sidechain, a usage in shape),
 * deduplicated by requestId with the max of each field; `model`/`effort` the most frequent of
 * those requests, counted once per request (as joinLoops), or null. `deadline` (ms since the
 * epoch) can only tighten BUDGET_MS from now. Reasons: `no-window`, `no-transcripts`, `timeout`.
 */
function readMainTranscripts(options) {
  try {
    const opts = isObject(options) ? options : {};
    const window = isObject(opts.window) ? opts.window : {};
    if (!isInstant(window.startedAt) || !isInstant(window.closedAt)) return noMain('no-window');
    const startMs = Date.parse(window.startedAt);
    const endMs = Date.parse(window.closedAt);
    if (!(startMs <= endMs)) return noMain('no-window');
    const { projectDir } = opts;
    if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir) || projectDir.length > 1024) return noMain('no-transcripts');
    const limit = Date.now() + CONSTANTS.BUDGET_MS;
    const deadline = typeof opts.deadline === 'number' && Number.isFinite(opts.deadline) ? Math.min(opts.deadline, limit) : limit;
    const expired = () => Date.now() > deadline;

    // the same folder readTokens reads: the slug has only [A-Za-z0-9-], ONE folder name
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    const base = path.join(projectsRoot, projectDir.replace(/[^A-Za-z0-9]/g, '-'));
    if (!isInside(projectsRoot, base) || crossesLink(projectsRoot, base)) return noMain('no-transcripts');
    try {
      if (!fs.lstatSync(base).isDirectory()) return noMain('no-transcripts');
    } catch {
      return noMain('no-transcripts');
    }
    const listed = listMainTranscripts(projectsRoot, base, startMs, expired);
    if (listed.reason) return noMain(listed.reason);
    const wantCwd = foldCwd(projectDir);

    const sessions = [];
    const requests = new Map();
    let eventCount = 0;
    let overflow = false;
    for (const file of listed.files) {
      if (expired()) return noMain('timeout');
      const events = [];
      const onLine = (text) => {
        let line;
        try {
          line = JSON.parse(text);
        } catch {
          return; // the parser's message quotes the input: dropped
        }
        if (!isObject(line)) return;
        const timestamp = ownValue(line, 'timestamp');
        if (!isInstant(timestamp)) return;
        const ms = Date.parse(timestamp);
        if (ms < startMs || ms > endMs || foldCwd(ownValue(line, 'cwd')) !== wantCwd) return;
        if (eventCount >= MAX_MAIN_EVENTS) {
          overflow = true;
          return;
        }
        eventCount += 1;
        const type = ownValue(line, 'type');
        const sidechain = ownValue(line, 'isSidechain');
        // RF-037: by fields, never by text - typed by the human: not meta, not a subagent's, not a tool result
        const real = type === 'user' && ownValue(line, 'isMeta') !== true && sidechain === false && !hasOwn(line, 'toolUseResult');
        events.push({ ms, real });

        if (type !== 'assistant' || sidechain === true) return;
        const id = ownValue(line, 'requestId');
        const message = ownValue(line, 'message');
        if (typeof id !== 'string' || !API_ID.test(id) || !isObject(message)) return;
        const model = ownValue(message, 'model');
        if (model === '<synthetic>') return;
        const usage = readUsage(ownValue(message, 'usage'));
        if (!usage) return;
        let request = requests.get(id);
        if (!request) {
          if (requests.size >= MAX_REQUESTS) {
            overflow = true;
            return;
          }
          request = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0, model: null, effort: null };
          requests.set(id, request);
        }
        for (const key of LOOP_TOKEN_KEYS) request[key] = Math.max(request[key], usage[key]);
        if (request.model === null && typeof model === 'string' && SHAPE.model.test(model)) request.model = model;
        const effort = ownValue(line, 'effort');
        if (request.effort === null && TRANSCRIPT_EFFORTS.includes(effort)) request.effort = effort;
      };
      if (scanFile(file, deadline, onLine, () => {}) === 'timeout' || overflow) return noMain('timeout');
      if (events.length > 0) sessions.push({ events });
    }
    if (sessions.length === 0) return noMain('no-transcripts');

    const tokens = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 };
    for (const request of requests.values()) for (const key of LOOP_TOKEN_KEYS) tokens[key] += request[key];
    const list = [...requests.values()];
    return {
      reason: null,
      sessions,
      // sums of many bounded counts can still pass the ceiling: then no token count at all
      tokens: LOOP_TOKEN_KEYS.every((key) => isCount(tokens[key])) ? tokens : null,
      model: mostFrequent(list.map((r) => r.model)),
      effort: mostFrequent(list.map((r) => r.effort)),
    };
  } catch {
    return noMain('timeout');
  }
}

/** session-time.ps1's rule on one session's events (not empty): `{ firstMs, sessionMs, claudeMs }`. */
function sessionTime(events) {
  const sorted = events.slice().sort((a, b) => a.ms - b.ms); // stable: file order on a tie
  const starts = [];
  for (let i = 0; i < sorted.length; i += 1) if (sorted[i].real) starts.push(i);
  let claudeMs = 0;
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] - 1 : sorted.length - 1;
    if (end > starts[k]) claudeMs += Math.max(0, sorted[end].ms - sorted[starts[k]].ms);
  }
  return { firstMs: sorted[0].ms, sessionMs: sorted[sorted.length - 1].ms - sorted[0].ms, claudeMs };
}

/** Hours as the ps1 prints them: rounded to 2 decimals, invariant (`2`, `0.5`, `1.23`).
 *  ponytail: half-up rounding, .NET's Math.Round is half-even; differs only on an exact .xx5. */
const hours = (ms) => String(Math.round(ms / 36000) / 100);

/** The local date of an instant, `yyyy-MM-dd` (the ps1's `Data` column). */
function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The run's window `{ startedAt, closedAt }` from its state.json, or `{ code }` (`bad-state`,
 *  `no-window`, `unsafe-path`). Open run: until now; phase `done`: until phaseChangedAt. */
function runWindow(projectDir, stateDir, slug) {
  const statePath = path.join(stateDir, slug, 'state.json');
  if (!isInside(stateDir, statePath) || !isInside(projectDir, statePath) || crossesLink(projectDir, statePath)) return { code: 'unsafe-path' };
  const state = readSmallObject(projectDir, statePath);
  if (!state) return { code: 'bad-state' };
  const startedAt = parseHealth(state).startedAt;
  const closedAt = state.phase === 'done' ? ownValue(state, 'phaseChangedAt') : new Date().toISOString();
  if (!startedAt || !isInstant(closedAt) || Date.parse(startedAt) > Date.parse(closedAt)) return { code: 'no-window' };
  return { startedAt, closedAt };
}

/** The time row, or `{ code }`. Never throws. */
function timeRow(projectDir, slug) {
  try {
    const loaded = loadConfig(projectDir);
    if (!loaded.ok || !loaded.config || typeof loaded.config.stateDir !== 'string') return { code: 'bad-config' };
    const window = runWindow(projectDir, loaded.config.stateDir, slug);
    if (window.code) return { code: window.code };
    const read = readMainTranscripts({ projectDir, window });
    if (read.reason) return { code: read.reason };
    let sessionMs = 0;
    let claudeMs = 0;
    let first = Infinity; // a loop, not Math.min(...): a million events would overflow the stack
    for (const s of read.sessions) {
      const t = sessionTime(s.events);
      sessionMs += t.sessionMs;
      claudeMs += t.claudeMs;
      first = Math.min(first, t.firstMs);
    }
    const phrase = TIME_PHRASE[loaded.config.pageLanguage] || TIME_PHRASE.en;
    const effort = TRANSCRIPT_EFFORTS.includes(read.effort) ? read.effort : 'unknown';
    const model = typeof read.model === 'string' && SHAPE.model.test(read.model) ? read.model : 'unknown';
    return { line: `| ${localDate(first)} | ${phrase} | ${hours(sessionMs)} | ${hours(claudeMs)} | ${effort} | ${model} |\n` };
  } catch {
    return { code: 'internal' };
  }
}

/** runCommand's `time`: TASK_FLOW_METRICS=off first (nothing read), then the arguments (all or
 *  nothing: the usage and 2), then the row on stdout or `metrics: <code> time`, exit 0 either way. */
function timeCommand(args, projectDir, exit) {
  if (String(process.env.TASK_FLOW_METRICS || '').toLowerCase() === 'off') return exit(0, process.stdout, 'metrics: disabled time\n');
  const given = parseFlags(args, TIME_FLAGS);
  if (!given || !given.has('--slug') || typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) return exit(2, process.stderr, CLI_USAGE);
  const row = timeRow(projectDir, given.get('--slug'));
  return exit(0, process.stdout, row.line || `metrics: ${row.code} time\n`);
}

Object.assign(module.exports, { readMainTranscripts });

// --- the PR summary CLI (spec 6.3, RF-033, RF-034; plan T9) ---------------------------------------
//
// The cost block of the PR body, put in its `## Changed` section when the PR is opened (Q3):
//
//   node plugin/scripts/metrics.js summary --slug <run> [--project-dir <dir>]
//
// Computed on demand, and NOTHING is written: the PR opens before `phase: "done"`, so the run's
// loop rows are not in loops.jsonl yet (spec-log decision "Linhas finais no fecho"). The rows are
// therefore the run's start events joined to their transcripts in memory (joinLoops, as the close
// would), plus the rows loops.jsonl already holds for the run (a run summarised after its close,
// or a paperclip run that has rows and no events) - a recorded row wins over a fresh join of the
// same loop, so the PR body and the page agree. As on the page, a row counts only when it started
// at or after the run's startedAt (a folder name can be reused). The orchestrator's own tokens
// come from the main transcripts in the run window (readMainTranscripts, plan T8) on a line of
// their own, not as a loop (spec-log decision "Tokens do orquestrador").
//
// Tokens only, never money (Q1: euros only ever come from paperclip). FRESH tokens - input +
// cache creation + output - and the block says so (Q6, the definition the page uses). A loop with
// no measured tokens is left out of the sums and counted on a line of its own, so a number that
// is short is never printed as if complete. Review rounds: the highest `round` of the review
// loops; without any, the count of those loops, said as such (RF-033).
//
// Trust: the block goes into a PR body on GitHub, read by people and by models. It holds only
// numbers formatted here, phase names from PHASES and fixed phrases per language (render-run's
// strings where the page has the same words) - nothing from a file, an exception or an argument,
// not even the slug. Arguments: all or nothing, the usage and exit 2. Without data, one fixed
// line `metrics: <code> summary`, exit 0. One budget, BUDGET_MS, for the join and the main read.

const SUMMARY_STRINGS = Object.freeze({
  en: {
    heading: '### Run cost',
    fresh: 'Fresh tokens = input + cache creation + output, without cache reads.',
    orchestrator: 'orchestrator',
    rounds: (n) => `Review rounds: ${n}.`,
    noRounds: (n) => `Review rounds: ${n} review ${n === 1 ? 'loop' : 'loops'}, no round recorded.`,
    unmeasured: (n) => `Loops without measured tokens: ${n} (not in the sums).`,
  },
  'pt-PT': {
    heading: '### Custo da run',
    fresh: 'Tokens frescos = input + cache creation + output, sem cache reads.',
    orchestrator: 'orquestrador',
    rounds: (n) => `Rondas de review: ${n}.`,
    noRounds: (n) => `Rondas de review: ${n} ${n === 1 ? 'loop' : 'loops'} de review, sem ronda registada.`,
    unmeasured: (n) => `Loops sem tokens medidos: ${n} (fora das somas).`,
  },
});
/** readMainTranscripts' reasons in the words the page already has for a loop's missing tokens. */
const MAIN_REASON = Object.freeze({ 'no-transcripts': 'no-transcript', timeout: 'timeout' });

/** The block, from validated loop rows (not empty) and readMainTranscripts' result. */
function summaryBlock(rows, main, lang) {
  const page = (STRINGS[lang] || STRINGS.en).loops;
  const s = SUMMARY_STRINGS[lang] || SUMMARY_STRINGS.en;
  const DASH = '—';
  const number = (value) => (Number.isSafeInteger(value) && value >= 0 ? String(value) : DASH);
  const fresh = (tokens) => tokens.input + tokens.cacheCreate + tokens.output;
  // [fresh tokens, seconds] of some rows, each null when no row has one
  const sums = (list) => {
    const measured = list.filter((row) => row.tokens !== null);
    const timed = list.filter((row) => row.durationS !== null);
    return [
      measured.length ? measured.reduce((n, row) => n + fresh(row.tokens), 0) : null,
      timed.length ? timed.reduce((n, row) => n + row.durationS, 0) : null,
    ];
  };

  const out = [s.heading, '', s.fresh, '', `| ${page.byPhaseHeader.join(' | ')} |`, '| --- | ---: | ---: | ---: |'];
  for (const phase of LOOP_PHASES) {
    const inPhase = rows.filter((row) => row.phase === phase);
    if (inPhase.length === 0) continue;
    const [tokens, seconds] = sums(inPhase);
    out.push(`| ${phase === 'unknown' ? page.unknown : phase} | ${inPhase.length} | ${tokens === null ? DASH : number(tokens)} | ${formatDuration(seconds)} |`);
  }
  const mainTokens = main.reason === null && main.tokens !== null ? fresh(main.tokens) : null;
  const mainCell = mainTokens !== null ? number(mainTokens)
    : hasOwn(MAIN_REASON, main.reason) ? `${DASH} (${page.reasons[MAIN_REASON[main.reason]]})` : DASH;
  out.push(`| ${s.orchestrator} | ${DASH} | ${mainCell} | ${DASH} |`);
  const [loopTokens, seconds] = sums(rows);
  const total = loopTokens === null && mainTokens === null ? null : (loopTokens || 0) + (mainTokens || 0);
  out.push(`| **Total** | ${rows.length} | ${total === null ? DASH : number(total)} | ${formatDuration(seconds)} |`, '', page.overlap);

  const unmeasured = rows.filter((row) => row.tokens === null).length;
  if (unmeasured > 0) out.push('', s.unmeasured(unmeasured));
  const review = rows.filter((row) => row.phase === 'review');
  const rounds = review.map((row) => row.round).filter(isRound);
  out.push('', rounds.length ? s.rounds(Math.max(...rounds)) : s.noRounds(review.length), '');
  return out.join('\n');
}

/** The summary text of run `slug`, or `{ code }`. Reads only; never throws. */
function summaryText(projectDir, slug) {
  try {
    const loaded = loadConfig(projectDir);
    if (!loaded.ok || !loaded.config || typeof loaded.config.stateDir !== 'string') return { code: 'bad-config' };
    const stateDir = loaded.config.stateDir;
    const window = runWindow(projectDir, stateDir, slug);
    if (window.code) return { code: window.code };
    const deadline = Date.now() + CONSTANTS.BUDGET_MS;
    // a history that cannot be read could hold this run's rows: no block rather than a short one
    const history = readLoops(projectDir, stateDir);
    if (history.code) return { code: history.code };
    const joined = joinLoops({ projectDir, slug, events: readLoopEvents(projectDir, stateDir, slug), deadline });

    const sinceMs = Date.parse(window.startedAt);
    const byKey = new Map();
    for (const row of [...history.rows, ...joined]) { // recorded first: the first of a key wins
      if (row.run !== slug || row.startedAt === null || Date.parse(row.startedAt) < sinceMs || byKey.has(loopKey(row))) continue;
      byKey.set(loopKey(row), row);
    }
    if (byKey.size === 0) return { code: 'no-loops' };
    const main = readMainTranscripts({ projectDir, window, deadline });
    return { text: summaryBlock([...byKey.values()], main, loaded.config.pageLanguage) };
  } catch {
    return { code: 'internal' };
  }
}

/** runCommand's `summary`, the shape of timeCommand: TASK_FLOW_METRICS=off first (nothing read),
 *  then the arguments (all or nothing: the usage and 2), then the block or one fixed line, exit 0. */
function summaryCommand(args, projectDir, exit) {
  if (String(process.env.TASK_FLOW_METRICS || '').toLowerCase() === 'off') return exit(0, process.stdout, 'metrics: disabled summary\n');
  const given = parseFlags(args, TIME_FLAGS); // the same two flags as time
  if (!given || !given.has('--slug') || typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) return exit(2, process.stderr, CLI_USAGE);
  const result = summaryText(projectDir, given.get('--slug'));
  return exit(0, process.stdout, result.text || `metrics: ${result.code} summary\n`);
}


// --- the one request to paperclip's API (spec 6.4, RF-042, RF-060; plan T11) ------------------------
//
// `paperclipGet({ projectDir, url, pathname, env, deadline })` -> a Promise that always resolves to
// `{ ok, code, body }`: `{ ok: true, code: 'ok', body: <parsed JSON> }`, or `ok: false`, `body: null`
// and one closed code - untrusted-url, no-token, timeout, http-status, too-large, bad-json, network.
// It never rejects and never throws: the caller (metrics.js paperclip, plan T12) is information,
// and a down or slow paperclip must cost it one fixed line, not a stack.
//
// Trust. The request carries the board token, so where it goes is decided the way
// send-to-paperclip.js decides it: `url` (a project's committed `paperclip.url`) counts only once
// config.js `parsePaperclipOrigin` reads it as a plain http(s) origin and `isPaperclipUrlTrusted`
// finds that pair confirmed on this machine; only that ORIGIN is used, never the raw string. The
// token comes only from PAPERCLIP_TOKEN (fixed name, never configurable) and a value that is not a
// plain header token is treated as missing. Neither check passing means no request at all.
// `pathname` is built by the caller from closed-shape ids (encodeURIComponent all the same); it
// must start with /api/, hold only path/query characters, and survive `new URL` unchanged - so a
// dot segment, %2e%2e (which the URL parser folds into ..), a scheme-relative //host or a fragment
// is refused as untrusted-url before anything leaves the process.
//
// Response. Untrusted data: no redirect is followed (Node's http never does; a 3xx is http-status,
// so the token never reaches a Location), only 2xx counts, the body is cut at
// PAPERCLIP_MAX_BODY_BYTES by destroying the request, one timer covers the whole exchange
// (PAPERCLIP_TIMEOUT_MS, or less when `deadline`, ms since the epoch, comes first - a slow drip
// cannot keep a socket-idle timeout alive), and JSON.parse runs in a try. Nothing of a body, a
// status line, an error message or the token is ever put in a code. `agent: false`: a fresh agent
// per request, never a shared or environment-configured one (Node can be told to route the global
// agent through a proxy, which would hand the bearer token to that proxy).

const PAPERCLIP_CODES = ['untrusted-url', 'no-token', 'timeout', 'http-status', 'too-large', 'bad-json', 'network'];
const PAPERCLIP_PATHNAME = /^\/api(?:\/[A-Za-z0-9._~%-]+)+(?:\?[A-Za-z0-9._~%=&-]*)?$/;
const HEADER_TOKEN = /^[\x21-\x7e]{1,4096}$/;

const paperclipFailure = (code) => ({ ok: false, code: PAPERCLIP_CODES.includes(code) ? code : 'network', body: null });

/** The URL to request, or null: origin trusted for projectDir and a pathname of the closed shape. */
function paperclipTarget(projectDir, url, pathname) {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir) || typeof pathname !== 'string' || !PAPERCLIP_PATHNAME.test(pathname)) return null;
  const origin = parsePaperclipOrigin(url);
  if (!origin || !isPaperclipUrlTrusted(projectDir, url)) return null;
  const target = new URL(pathname, origin);
  return target.origin === origin && target.pathname + target.search === pathname ? target : null;
}

function paperclipGet(options) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let req = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (req) req.destroy();
      resolve(result);
    };
    try {
      const opts = isObject(options) ? options : {};
      const target = paperclipTarget(opts.projectDir, opts.url, opts.pathname);
      if (!target) return finish(paperclipFailure('untrusted-url'));
      const env = isObject(opts.env) ? opts.env : process.env;
      const token = hasOwn(env, 'PAPERCLIP_TOKEN') ? env.PAPERCLIP_TOKEN : undefined;
      if (typeof token !== 'string' || !HEADER_TOKEN.test(token)) return finish(paperclipFailure('no-token'));
      const limit = Date.now() + CONSTANTS.PAPERCLIP_TIMEOUT_MS;
      const deadline = typeof opts.deadline === 'number' && Number.isFinite(opts.deadline) ? Math.min(opts.deadline, limit) : limit;
      timer = setTimeout(() => finish(paperclipFailure('timeout')), Math.max(0, deadline - Date.now()));
      const client = target.protocol === 'https:' ? https : http;
      req = client.request(target, {
        method: 'GET', agent: false, headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      }, (res) => {
        if (res.statusCode < 200 || res.statusCode > 299) return finish(paperclipFailure('http-status'));
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > CONSTANTS.PAPERCLIP_MAX_BODY_BYTES) return finish(paperclipFailure('too-large'));
          chunks.push(chunk);
          return undefined;
        });
        res.on('end', () => {
          let body;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            return finish(paperclipFailure('bad-json'));
          }
          return finish({ ok: true, code: 'ok', body });
        });
        res.on('error', () => finish(paperclipFailure('network')));
        return undefined;
      });
      req.on('error', () => finish(paperclipFailure('network')));
      req.end();
    } catch {
      finish(paperclipFailure('network'));
    }
    return undefined;
  });
}

Object.assign(module.exports, { paperclipGet });

// --- metrics.js paperclip --issue N: paperclip's runs as loop rows (spec 6.4, RF-040..RF-045; plan T12)
//
//   node plugin/scripts/metrics.js paperclip --issue <n> [--paperclip-issue <id>] [--project-dir <dir>]
//
// A run handed to paperclip never reaches `done` here, so its loops are collected by hand (Q2),
// with this command, as often as wanted: a row is keyed by source+run+id and appendLoopRows never
// writes a key twice, so a second call only adds what finished since.
//
// Steps, and why each one is where it is:
//   1. `--issue N` (^[1-9][0-9]*$) finds THE run whose state.json `paperclipIssue` is a JSON number
//      whose decimal form is N (SKILL.md §0d); zero or several is a code and nothing is asked.
//   2. The paperclip issue: state.json `paperclipIssueId` (plan T10) or `--paperclip-issue`, both a
//      UUID or a GON-12 identifier (RF-041); both given and different is a code. None: no request.
//   3. GET the issue (an identifier is resolved to its UUID there), its sub-issues (one level:
//      `?parentId=`, and each one must really name the parent - a server that ignored the query
//      would otherwise hand us every issue of the company), and the runs of each.
//   4. Per FINISHED run (a `finishedAt` instant: the status values were never measured) not yet in
//      the history: one GET of its agent, once per distinct agentId, for `name`/`role` through the
//      closed role table. An agent lookup that fails leaves its runs for the next call instead of
//      writing them as `unknown` - the first row of a key wins forever, so a guess would stick.
//   5. Rows through validateLoopRow (inside appendLoopRows), the same validator as the other
//      origins (SC-007). `model` and `effort` are null: paperclip reports neither (`adapterType`
//      is not a model). Tokens and cost are paperclip's own figures (RF-045, Q7): integer USD cents,
//      unit USD, never converted or priced here.
//
// Trust: every value of a response is untrusted data. Ids are taken only in their closed shape
// and lower-cased (one spelling per key, T3), objects are read by own keys, nothing of a response
// is ever printed, and the output is one fixed line `metrics: <code> paperclip`, exit 0 (RF-044),
// with TASK_FLOW_METRICS=off checked before anything is read. Every request goes through
// paperclipGet (trusted origin, token from PAPERCLIP_TOKEN, 10 s each), all of them inside ONE
// command deadline, so a slow paperclip costs at most PAPERCLIP_COMMAND_MS.

/** The whole command, every request included. A guess: a handful of issues and agents each. */
const PAPERCLIP_COMMAND_MS = 60 * 1000;
const PAPERCLIP_MAX_SUBISSUES = 100;
const PAPERCLIP_MAX_RUNS = 5000;
const PAPERCLIP_MAX_AGENTS = 50;
const ISSUE_ARG = /^[1-9][0-9]*$/;
const PAPERCLIP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAPERCLIP_IDENTIFIER = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,6}$/;
/** The closed role table (RF-043): lower-cased name or role -> [agentType, phase]. */
const PAPERCLIP_ROLES = new Map([
  ['builder', ['Builder', 'build']], ['tester', ['Tester', 'tests']], ['security', ['Security', 'harden']], ['reviewer', ['Reviewer', 'review']],
]);
/** usageJson's names for each token count, first present wins (camelCase is paperclip's own). */
const PAPERCLIP_TOKEN_FIELDS = new Map([
  ['input', ['inputTokens', 'input_tokens']],
  ['cacheCreate', ['cacheCreationInputTokens', 'cache_creation_input_tokens']],
  ['cacheRead', ['cachedInputTokens', 'cached_input_tokens', 'cache_read_input_tokens']],
  ['output', ['outputTokens', 'output_tokens']],
]);
const PAPERCLIP_COST_FIELDS = ['costUsd', 'cost_usd', 'total_cost_usd'];
const PAPERCLIP_FLAGS = new Map([
  ['--issue', (v) => ISSUE_ARG.test(v)],
  ['--paperclip-issue', (v) => PAPERCLIP_UUID.test(v) || PAPERCLIP_IDENTIFIER.test(v)],
  ['--project-dir', () => true], // resolved and checked by the CLI block, as for close
]);

/** A UUID in its one spelling (lower case), or null. */
const uuidOf = (value) => (typeof value === 'string' && PAPERCLIP_UUID.test(value) ? value.toLowerCase() : null);
/** A paperclip issue reference (UUID lower-cased, or an identifier), or null. */
const issueRefOf = (value) => uuidOf(value) || (typeof value === 'string' && PAPERCLIP_IDENTIFIER.test(value) ? value : null);

/** The one run recorded for GitHub issue `issue`: `{ slug, state }`, or `{ code }` (no-run, many-runs). */
function findPaperclipRun(projectDir, stateDir, issue) {
  const found = [];
  let names = [];
  try {
    names = fs.readdirSync(stateDir).slice(0, MAX_OTHER_RUNS);
  } catch {
    // no folder: no run
  }
  for (const name of names) {
    if (!isSlug(name)) continue;
    const state = readSmallObject(projectDir, path.join(stateDir, name, 'state.json'));
    const recorded = state ? ownValue(state, 'paperclipIssue') : undefined;
    if (Number.isSafeInteger(recorded) && String(recorded) === issue) found.push({ slug: name, state });
  }
  if (found.length === 0) return { code: 'no-run' };
  return found.length === 1 ? found[0] : { code: 'many-runs' };
}

/** usageJson's tokens, or null: input and output must be there; a count that is present but not a
 *  count spoils the block. No cache-creation field (none measured, T11) counts as 0. */
function paperclipTokens(usage) {
  if (!isObject(usage)) return null;
  const tokens = {};
  for (const [key, names] of PAPERCLIP_TOKEN_FIELDS) {
    const name = names.find((n) => hasOwn(usage, n));
    if (name === undefined && (key === 'input' || key === 'output')) return null;
    if (name !== undefined && !isCount(usage[name])) return null;
    tokens[key] = name === undefined ? 0 : usage[name];
  }
  return tokens;
}

/** usageJson's cost in integer USD cents, or null. Every cost field present must be a finite
 *  amount >= 0 and they must agree to the cent; when they disagree no figure is chosen. Rounded
 *  half up after dropping binary float noise (1.005 USD is 101 cents, not 100). */
function paperclipCostCents(usage) {
  if (!isObject(usage)) return null;
  const cents = PAPERCLIP_COST_FIELDS.filter((n) => hasOwn(usage, n)).map((n) => {
    const usd = usage[n];
    return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? Math.round(Number((usd * 100).toPrecision(12))) : NaN;
  });
  return cents.length > 0 && cents.every((c) => c === cents[0] && isCount(c)) ? cents[0] : null;
}

/** An agent object to its [agentType, phase] from the role table, by `name` then `role`; else null. */
function paperclipRole(agent) {
  if (!isObject(agent)) return null;
  for (const field of ['name', 'role']) {
    const value = ownValue(agent, field);
    if (typeof value === 'string' && value.length <= 100 && PAPERCLIP_ROLES.has(value.toLowerCase())) return PAPERCLIP_ROLES.get(value.toLowerCase());
  }
  return null;
}

/** One finished paperclip run as a loop row (validated later, by appendLoopRows). */
function paperclipRow(slug, id, run, role) {
  const startedAt = toUtcInstant(ownValue(run, 'startedAt'));
  const ms = startedAt ? Date.parse(ownValue(run, 'finishedAt')) - Date.parse(ownValue(run, 'startedAt')) : NaN;
  const usage = ownValue(run, 'usageJson');
  return {
    v: 1, source: 'paperclip', run: slug, id,
    agentType: role ? role[0] : 'unknown', phase: role ? role[1] : 'unknown', task: '', round: null,
    model: null, effort: null, startedAt, durationS: ms >= 0 ? Math.round(ms / 1000) : null,
    tokens: paperclipTokens(usage), costCents: paperclipCostCents(usage),
    outcome: null, tests: null, critical: null, required: null, reason: null, backfill: false,
  };
}

/**
 * The command's work: `{ code, written }`, never rejects, never carries text from a response.
 * Codes: written, up-to-date, partial (some request failed: what was read is written, the rest
 * waits for the next call), invalid, bad-config, no-run, many-runs, no-issue-id, id-mismatch,
 * bad-response, paperclipGet's codes for the issue itself, appendLoopRows' codes, internal.
 * `deadline` (ms since the epoch) is a test seam: it can only tighten PAPERCLIP_COMMAND_MS.
 */
async function collectPaperclip(options) {
  const done = (code, written) => ({ code, written: written || 0 });
  try {
    const opts = isObject(options) ? options : {};
    const { projectDir, issue } = opts;
    if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir) || typeof issue !== 'string' || !ISSUE_ARG.test(issue)) return done('invalid');
    const flag = opts.paperclipIssue === undefined ? null : issueRefOf(opts.paperclipIssue);
    if (opts.paperclipIssue !== undefined && !flag) return done('invalid');

    const loaded = loadConfig(projectDir);
    if (!loaded.ok || !loaded.config || typeof loaded.config.stateDir !== 'string') return done('bad-config');
    const stateDir = loaded.config.stateDir;
    const found = findPaperclipRun(projectDir, stateDir, issue);
    if (found.code) return done(found.code);
    const recorded = issueRefOf(ownValue(found.state, 'paperclipIssueId'));
    if (recorded && flag && recorded !== flag) return done('id-mismatch');
    const ref = recorded || flag;
    if (!ref) return done('no-issue-id');
    const raw = isObject(loaded.config.raw) ? ownValue(loaded.config.raw, 'paperclip') : undefined;
    const company = isObject(raw) ? uuidOf(ownValue(raw, 'companyId')) : null;
    if (!company) return done('bad-config');
    const history = readLoops(projectDir, stateDir);
    if (history.code) return done(history.code);
    const known = new Set(history.rows.map(loopKey));

    const limit = Date.now() + PAPERCLIP_COMMAND_MS;
    const deadline = typeof opts.deadline === 'number' && Number.isFinite(opts.deadline) ? Math.min(opts.deadline, limit) : limit;
    const env = isObject(opts.env) ? opts.env : process.env;
    const get = (pathname) => (Date.now() >= deadline
      ? paperclipFailure('timeout')
      : paperclipGet({ projectDir, url: ownValue(raw, 'url'), pathname, env, deadline }));
    const enc = encodeURIComponent;

    const head = await get(`/api/issues/${enc(ref)}`);
    if (!head.ok) return done(head.code);
    const parent = isObject(head.body) ? uuidOf(ownValue(head.body, 'id')) : null;
    if (!parent || (parent !== ref && ownValue(head.body, 'identifier') !== ref)) return done('bad-response');

    let partial = false;
    const issues = [parent];
    const subs = await get(`/api/companies/${enc(company)}/issues?parentId=${enc(parent)}`);
    if (!subs.ok || !Array.isArray(subs.body)) partial = true;
    else {
      for (const sub of subs.body) {
        const id = isObject(sub) ? uuidOf(ownValue(sub, 'id')) : null;
        if (!id || issues.includes(id) || uuidOf(ownValue(sub, 'parentId')) !== parent) continue;
        if (issues.length > PAPERCLIP_MAX_SUBISSUES) { partial = true; break; }
        issues.push(id);
      }
    }

    const runs = new Map(); // runId -> run, finished and not in the history yet
    for (const id of issues) {
      const got = await get(`/api/issues/${enc(id)}/runs`); // eslint-disable-line no-await-in-loop
      if (!got.ok || !Array.isArray(got.body)) { partial = true; continue; }
      for (const run of got.body) {
        const runId = isObject(run) ? uuidOf(ownValue(run, 'runId')) : null;
        if (!runId || runs.has(runId) || !toUtcInstant(ownValue(run, 'finishedAt'))) continue;
        if (known.has(loopKey({ source: 'paperclip', run: found.slug, id: runId }))) continue;
        if (runs.size >= PAPERCLIP_MAX_RUNS) { partial = true; break; }
        runs.set(runId, run);
      }
    }

    const roles = new Map(); // agentId -> { role } once answered, { failed: true } once failed
    const rows = [];
    for (const [runId, run] of runs) {
      const agentId = uuidOf(ownValue(run, 'agentId'));
      if (agentId && !roles.has(agentId)) {
        if (roles.size >= PAPERCLIP_MAX_AGENTS) { partial = true; continue; }
        const got = await get(`/api/agents/${enc(agentId)}`); // eslint-disable-line no-await-in-loop
        roles.set(agentId, got.ok ? { role: paperclipRole(got.body) } : { failed: true });
      }
      const entry = agentId ? roles.get(agentId) : { role: null };
      if (entry.failed) { partial = true; continue; }
      rows.push(paperclipRow(found.slug, runId, run, entry.role));
    }

    const appended = appendLoopRows(projectDir, stateDir, rows);
    if (!appended.ok) return done(appended.code);
    if (partial) return done('partial', appended.written);
    return done(appended.written > 0 ? 'written' : 'up-to-date', appended.written);
  } catch {
    return done('internal');
  }
}

/** runCommand's `paperclip`: TASK_FLOW_METRICS=off first (nothing read), then the arguments (all
 *  or nothing: the usage and 2), then one fixed line `metrics: <code> paperclip`, exit 0. Never
 *  rejects (the CLI block does not wait on it). */
async function paperclipCommand(args, projectDir, exit) {
  try {
    if (String(process.env.TASK_FLOW_METRICS || '').toLowerCase() === 'off') return exit(0, process.stdout, 'metrics: disabled paperclip\n');
    const given = parseFlags(args, PAPERCLIP_FLAGS);
    if (!given || !given.has('--issue') || typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) return exit(2, process.stderr, CLI_USAGE);
    const result = await collectPaperclip({
      projectDir, issue: given.get('--issue'), paperclipIssue: given.has('--paperclip-issue') ? given.get('--paperclip-issue') : undefined,
    });
    return exit(0, process.stdout, `metrics: ${result.code} paperclip\n`);
  } catch {
    return exit(0, process.stdout, 'metrics: internal paperclip\n');
  }
}

Object.assign(module.exports, { collectPaperclip });

// --- metrics.js backfill: the transcripts already there as loop rows (spec 6.5, RF-050..RF-052; plan T13)
//
//   node plugin/scripts/metrics.js backfill [--project-dir <dir>]
//
// Run by hand (spec-log decision «Backfill explícito»: never on a render), once or as often as
// wanted: every subagent transcript `agent-<id>.jsonl` of the project that has no task-flow row in
// loops.jsonl yet (under ANY run: a loop measured at a close, or backfilled as `unknown` before, is
// never measured twice) becomes one row with `backfill: true`, read by the same readLoopTranscript
// as the close (RF-006, RF-007), through the same bounded listing (listTranscripts, without its
// mtime filter: old transcripts are the point). A loop whose start event sits in a run still
// going is left alone - that run's close owns it, and a backfill row first would leave the loop
// with two keys (backfill `unknown` + the close's).
//
// Attribution (RF-051), from data that has no link to the transcript but time: the run is the ONE
// run whose window (state.json `startedAt`..`phaseChangedAt`, both validated instants) holds the
// loop's first record, else `unknown`; the phase is phaseAt over that run's validated phaseLog
// (no log, or past the last phase: `unknown`); task, round and result stay empty. The agent type
// comes only from `agentType` of the `agent-<id>.meta.json` beside the transcript (readSmallObject:
// lstat, no link, size first), in SHAPE.agentType, else `unknown` - no other key of it is used
// (`description` is free text). Every state.json is only read (RF-052).
//
// Budget: BACKFILL_MS for the whole command (RF-050: not a hook, so more than the close's 5 s).
// When it runs out, the rows already read are written and the rest is left for the next call (a
// `timeout` row would stick: the first row of a key wins). Output: one fixed line
// `metrics: <code> backfill`, exit 0 (usage errors: the usage text and 2); TASK_FLOW_METRICS=off
// first, before anything is read. Nothing of a transcript, a meta.json or a state.json is printed.

/** The whole backfill, listing and every transcript read. A ceiling, not measured. */
const BACKFILL_MS = 60 * 1000;
const BACKFILL_FLAGS = new Map([['--project-dir', () => true]]); // resolved by the CLI block

/** The project's runs that have a window: `[{ slug, startMs, endMs, log }]`, `log` the validated
 *  phaseLog sorted for phaseAt (or null). A run without both instants, or with them reversed, has
 *  no window. Read only; never throws. */
function backfillWindows(projectDir, stateDir) {
  const windows = [];
  let names = [];
  try {
    names = fs.readdirSync(stateDir).slice(0, MAX_OTHER_RUNS);
  } catch {
    // no folder: no window
  }
  for (const name of names) {
    if (!isSlug(name)) continue;
    const state = readSmallObject(projectDir, path.join(stateDir, name, 'state.json'));
    if (!state) continue;
    const { startedAt, phaseLog } = parseHealth(state);
    const end = ownValue(state, 'phaseChangedAt');
    if (!startedAt || !isInstant(end) || Date.parse(startedAt) > Date.parse(end)) continue;
    const log = phaseLog ? phaseLog.map((e) => ({ phase: e.phase, ms: Date.parse(e.at) })).sort((a, b) => a.ms - b.ms) : null;
    windows.push({ slug: name, startMs: Date.parse(startedAt), endMs: Date.parse(end), log });
  }
  return windows;
}

/** The `agentType` of the meta.json beside `transcript`, in its shape, else `unknown`. */
function backfillAgentType(projectsRoot, transcript) {
  const meta = readSmallObject(projectsRoot, transcript.replace(/\.jsonl$/, '.meta.json'));
  const type = meta ? ownValue(meta, 'agentType') : undefined;
  return isShape(SHAPE.agentType)(type) ? type : 'unknown';
}

/** One backfilled row from readLoopTranscript's `read` (RF-051). */
function backfillRow(id, agentType, read, windows) {
  const found = read.reason === null;
  const firstMs = found && isInstant(read.startedAt) ? Date.parse(read.startedAt) : NaN;
  const holding = windows.filter((w) => firstMs >= w.startMs && firstMs <= w.endMs);
  const owner = holding.length === 1 ? holding[0] : null;
  const phase = owner ? phaseAt(owner.log, firstMs) : 'other';
  const fallback = hasOwn(AGENT_EFFORT, agentType) ? AGENT_EFFORT[agentType] : 'unknown';
  return {
    v: 1, source: 'taskflow', run: owner ? owner.slug : 'unknown', id, agentType,
    phase: LOOP_PHASES.includes(phase) ? phase : 'unknown', task: '', round: null,
    model: found ? read.model : null,
    effort: found ? read.effort || fallback : null,
    startedAt: found ? read.startedAt : null,
    durationS: found ? read.durationS : null,
    tokens: found ? read.tokens : null,
    costCents: null, outcome: null, tests: null, critical: null, required: null,
    reason: read.reason,
    backfill: true,
  };
}

/**
 * The backfill's work: `{ code, written }`. Codes: written, up-to-date, timeout (the budget ran
 * out: what was read is written), no-transcripts, invalid, bad-config, readLoops' and
 * appendLoopRows' codes, internal. `deadline` (ms since the epoch) is a test seam: it can only
 * tighten BACKFILL_MS. Never throws.
 */
function backfillLoops(options) {
  const done = (code, written) => ({ code, written: written || 0 });
  try {
    const opts = isObject(options) ? options : {};
    const { projectDir } = opts;
    if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir) || projectDir.length > 1024) return done('invalid');
    const limit = Date.now() + BACKFILL_MS;
    const deadline = typeof opts.deadline === 'number' && Number.isFinite(opts.deadline) ? Math.min(opts.deadline, limit) : limit;
    const expired = () => Date.now() > deadline;

    const loaded = loadConfig(projectDir);
    if (!loaded.ok || !loaded.config || typeof loaded.config.stateDir !== 'string') return done('bad-config');
    const stateDir = loaded.config.stateDir;
    const history = readLoops(projectDir, stateDir);
    if (history.code) return done(history.code);
    // RF-052: any task-flow row of the loop, whatever its run; and the loops a live run's close owns
    const skip = new Set(history.rows.filter((row) => row.source === 'taskflow').map((row) => row.id));
    for (const name of runningRuns(projectDir)) {
      if (isSlug(name)) for (const s of readLoopEvents(projectDir, stateDir, name).starts) skip.add(s.agent);
    }

    // the same folder readTokens and joinLoops read: the slug has only [A-Za-z0-9-], ONE folder name
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    const base = path.join(projectsRoot, projectDir.replace(/[^A-Za-z0-9]/g, '-'));
    if (!isInside(projectsRoot, base) || crossesLink(projectsRoot, base)) return done('no-transcripts');
    try {
      if (!fs.lstatSync(base).isDirectory()) return done('no-transcripts');
    } catch {
      return done('no-transcripts');
    }
    const limits = { maxFiles: CONSTANTS.MAX_TRANSCRIPT_FILES, maxTotalBytes: CONSTANTS.MAX_TRANSCRIPT_TOTAL_BYTES };
    const listed = listTranscripts(projectsRoot, base, 0, limits, expired);
    if (listed.reason) return done('timeout');

    const windows = backfillWindows(projectDir, stateDir);
    const rows = [];
    let timedOut = false;
    for (const entry of listed.files) {
      const name = entry.file === null ? entry.name : path.basename(entry.file);
      const id = typeof name === 'string' ? name.slice('agent-'.length, -'.jsonl'.length) : '';
      if (!SHAPE.agentId.test(id) || skip.has(id)) continue;
      if (expired()) { timedOut = true; break; }
      // over the size ceiling: listed by name only (no path, so no meta.json either)
      const read = entry.file === null ? { reason: 'unreadable-format' } : readLoopTranscript(entry.file, deadline);
      // out of time mid-file: left for the next call; a request-count overflow is a row, as in joinLoops
      if (read.reason === 'timeout' && expired()) { timedOut = true; break; }
      skip.add(id);
      rows.push(backfillRow(id, entry.file === null ? 'unknown' : backfillAgentType(projectsRoot, entry.file), read, windows));
    }

    const appended = appendLoopRows(projectDir, stateDir, rows);
    if (!appended.ok) return done(appended.code);
    if (timedOut) return done('timeout', appended.written);
    return done(appended.written > 0 ? 'written' : 'up-to-date', appended.written);
  } catch {
    return done('internal');
  }
}

/** runCommand's `backfill`: TASK_FLOW_METRICS=off first (nothing read), then the arguments (only
 *  --project-dir; anything else: the usage and 2), then one fixed line, exit 0. */
function backfillCommand(args, projectDir, exit) {
  if (String(process.env.TASK_FLOW_METRICS || '').toLowerCase() === 'off') return exit(0, process.stdout, 'metrics: disabled backfill\n');
  const given = parseFlags(args, BACKFILL_FLAGS);
  if (!given || typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) return exit(2, process.stderr, CLI_USAGE);
  return exit(0, process.stdout, `metrics: ${backfillLoops({ projectDir }).code} backfill\n`);
}

Object.assign(module.exports, { backfillLoops });

// --- closeRun and the CLI (spec R3, R4, R9; plan T7) -----------------------------------------------
//
// Deliberately AFTER module.exports: the security suites of the pure/reader sections scan
// slices of this file that end at the baseline marker and at module.exports, and the
// rules they check there (no fs, no require in the baseline; no I/O beyond the readers)
// are about THOSE sections. closeRun is the one orchestrating step and lives on its own.
//
// closeRun({ projectDir, slug, env, steps, readers }) is what the renderer's close and
// the `close` CLI call. It answers `{ ok, code, verdict? }`. It NEVER throws and never
// carries text from a file or from an exception: a failing step becomes one of a closed
// set of codes (unsafe-path, write-failed, bad-state, timeout, internal; not-eligible,
// disabled, already-closed and closed are the non-failures), because the measurement is
// information and must not fail or slow a run (spec R9).
//
// Order, cheapest first, because renderAll and the Stop hook call this on EVERY render
// of a finished run and collect can cost seconds of transcript reading:
//   1. TASK_FLOW_METRICS=off - before anything is read (D7, like TASK_FLOW_GATE in gate.js);
//   2. arguments and config, then only state.json: eligible (phase done + startedAt)?
//   3. is run+created already in metrics.jsonl? then stop: no collect, no write;
//   4. collect -> baseline over the history -> re-check the history -> appendRow;
//      just before appendRow, the loop rows of the run's start events (plan T4), inside the
//      same 5 s budget counted from the start of the close.
// Only a row that came out of collect (which validates it) is ever handed to baseline
// (T3's note: baseline does not validate `current`). The token reader's time budget
// lives in collect (BUDGET_MS): out of budget the row is written with tokensNull
// "timeout", so 'timeout' is never a closeRun failure of its own.
//
// Concurrency, honestly. Steps 3 and 4 are a check followed by an append, not one atomic
// step: no lock is taken (a lock file needs stale-lock handling, which is more machinery
// than a best-effort measurement deserves). Two processes closing the same run in the
// same instant can therefore BOTH append. The window is made small (the history is read
// again right before the append, so it is microseconds, not the seconds collect takes)
// and the backstop is on the read side: readHistory keeps the FIRST line per
// run+created, so a duplicate line costs a few bytes and nothing else. That is the
// ceiling; upgrading it means an O_EXCL lock file around steps 3-4.
//
// `steps` and `readers` are seams for tests (inject a failure per step); production
// callers pass neither.

const CLOSE_FAILURES = ['unsafe-path', 'write-failed', 'bad-state', 'timeout', 'internal'];
const closeResult = (ok, code, verdict) => (verdict === undefined ? { ok, code } : { ok, code, verdict });
/** A failure code from a step, reduced to the closed set: anything else is 'internal'. */
const closedFailure = (code) => closeResult(false, typeof code === 'string' && CLOSE_FAILURES.includes(code) ? code : 'internal');

function hasKey(history, key) {
  return Array.isArray(history.rows) && history.rows.some((row) => `${row.run}\n${row.created}` === key);
}

function closeRun(options) {
  try {
    const opts = isObject(options) ? options : {};
    // 1. the escape hatch, first of all: no file is read when it is set
    const env = isObject(opts.env) ? opts.env : process.env;
    if (String(env.TASK_FLOW_METRICS || '').toLowerCase() === 'off') return closeResult(true, 'disabled');
    // the one budget of this close; `budgetMs` (a test seam, like steps) can only tighten it
    const budget = typeof opts.budgetMs === 'number' && Number.isFinite(opts.budgetMs) ? Math.min(opts.budgetMs, CONSTANTS.BUDGET_MS) : CONSTANTS.BUDGET_MS;
    const deadline = Date.now() + budget;

    const { projectDir, slug } = opts;
    if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir) || !isSlug(slug)) return closeResult(false, 'bad-state');
    const given = isObject(opts.steps) ? opts.steps : {};
    const step = (name, fallback) => (typeof given[name] === 'function' ? given[name] : fallback);

    // docsDir variables (OneDrive...) expand from the real environment, not from the switch's
    const loaded = loadConfig(projectDir);
    if (!loaded.ok || !loaded.config || typeof loaded.config.stateDir !== 'string') return closeResult(false, 'bad-state');
    const config = loaded.config;
    const stateDir = config.stateDir;

    // 2. eligible? (only state.json is read)
    const statePath = path.join(stateDir, slug, 'state.json');
    if (!isInside(stateDir, statePath) || !isInside(projectDir, statePath) || crossesLink(projectDir, statePath)) return closeResult(false, 'unsafe-path');
    const state = readSmallObject(projectDir, statePath);
    if (!state) return closeResult(false, 'bad-state');
    if (state.phase !== 'done' || !parseHealth(state).startedAt) return closeResult(true, 'not-eligible');
    if (!isDate(state.created)) return closeResult(false, 'bad-state');
    const key = `${slug}\n${state.created}`;

    // 3. already measured? A history that cannot be read is not fatal (the row can still be
    // written and the reader deduplicates), but a refused path is: nothing may be written there.
    const readHist = step('readHistory', readHistory);
    const history = plain(() => readHist(projectDir, stateDir)) || { rows: [], ignored: 0, code: null };
    if (history.code === 'unsafe-path') return closeResult(false, 'unsafe-path');
    if (hasKey(history, key)) return closeResult(true, 'already-closed');

    // 4. collect -> baseline -> append
    const collected = attempt(() => step('collect', collect)({ projectDir, config, slug, readers: opts.readers }));
    if (!isObject(collected)) return closeResult(false, 'internal');
    if (!collected.ok) return collected.code === 'not-eligible' ? closeResult(true, 'not-eligible') : closedFailure(collected.code);
    const row = collected.row;

    const judged = attempt(() => step('baseline', baseline)(Array.isArray(history.rows) ? history.rows : [], row));
    const verdict = isObject(judged)
      ? { hasVerdict: judged.hasVerdict === true, reason: typeof judged.reason === 'string' ? judged.reason : null, have: isCount(judged.have) ? judged.have : 0 }
      : null;

    // the window between step 3 and here can be seconds (transcripts): look again
    const again = plain(() => readHist(projectDir, stateDir));
    if (isObject(again) && again.code === 'unsafe-path') return closeResult(false, 'unsafe-path');
    if (isObject(again) && hasKey(again, key)) return closeResult(true, 'already-closed');

    // 5. the loop rows (plan T4), BEFORE the metrics.jsonl line: a close cut short here is
    // repeated by the next render (no line yet, so not already-closed), and the loop append is
    // idempotent by key. With what is left of the budget; whatever it returns or throws, the
    // close goes on to its own line and its own code.
    attempt(() => step('loops', recordLoops)(projectDir, stateDir, slug, deadline));

    let appended;
    try {
      appended = step('appendRow', appendRow)(projectDir, stateDir, row);
    } catch {
      return closeResult(false, 'write-failed');
    }
    if (!isObject(appended) || appended.ok !== true) return closedFailure(isObject(appended) ? appended.code : null);
    return closeResult(true, 'closed', verdict);
  } catch {
    return closeResult(false, 'internal');
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  // For close, usage errors are the only non-zero exit, and print only the fixed usage text:
  // the offending argument is never echoed. Everything else exits 0 (spec R9): a run must
  // not change its exit code because its measurement failed. Every other command goes to
  // runCommand (above closeRun), which owns its output and exit code.
  const slug = value('--slug');
  let projectDir = null;
  try {
    // an explicit but empty --project-dir must not silently mean the cwd (path.resolve('') is the cwd)
    const explicit = argv.includes('--project-dir') ? String(value('--project-dir')) : null;
    if (explicit === '') throw new Error('empty');
    const candidate = path.resolve(explicit !== null ? explicit : (process.env.CLAUDE_PROJECT_DIR || process.cwd()));
    if (fs.statSync(candidate).isDirectory()) projectDir = candidate;
  } catch {
    // stays null: reported as a usage error below
  }
  if (argv[0] !== 'close') {
    runCommand(argv, projectDir); // every other command (plan T5): its own output and exit code
  } else if (!isSlug(slug) || projectDir === null) {
    process.stderr.write(CLI_USAGE);
    process.exitCode = 2;
  } else {
    const result = closeRun({ projectDir, slug });
    const line = `metrics: ${result.code} ${slug}\n`;
    if (!result.ok) process.stderr.write(line);
    else if (!argv.includes('--quiet')) process.stdout.write(line);
  }
}
