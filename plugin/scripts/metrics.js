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
const path = require('path');
const { crossesLink, isInside } = require('./config.js');
const { PHASES, SAFE_SEGMENT, readPlanTasks, readSkippedTasks, readPendingTasks } = require('./render-run.js');

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
const GIT_TIMEOUT_MS = 3000;
const GIT_MAX_BUFFER = 1024 * 1024;
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
          cwd: projectDir, shell: false, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER,
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
    if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir) || typeof slug !== 'string' || slug.length > 100 || !SAFE_SEGMENT.test(slug)) return failure('bad-state');
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
            files.push({ file: null });
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
};
