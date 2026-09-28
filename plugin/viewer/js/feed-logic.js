// Pure data logic for the task-flow viewer: turning a feed file (render-run.js
// writeFeed) into what the page draws, and turning what the page draws back
// into a submission file answers.js consume can take in.
//
// This module touches no filesystem and no DOM - runnable in a browser (as a
// plain script - see dom.js for why not an ES module - attaching to
// window.TFV) and in Node (tests/viewer-feed-logic.test.js, via require)
// without change. Everything that actually reads or writes a file lives in
// data.js instead.
//
// A feed file is UNTRUSTED here, the same way it was for the panel this module
// replaces: it is written by task-flow, but out of a state.json any repository
// can bring, and this module feeds a web page. So every field is taken only in
// a closed shape - an id that matches its pattern, a status out of a fixed
// list, text of bounded length without control characters - and anything else
// is dropped. The page escapes all text on top of that (dom.js), which is the
// second of two walls, not the only one.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else Object.assign((root.TFV = root.TFV || {}), factory());
})(typeof window !== "undefined" ? window : globalThis, function () {
  const FEED_FILE = /^([0-9a-f]{16})\.json$/;
  const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const TASK_ID = /^T[0-9]+[a-z]?$/;
  const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})?$/;
  const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const PHASES = ["idea", "spec", "plan", "build", "tests", "harden", "review", "done"];
  const STATUSES = ["running", "blocked", "failed", "done", "paused"];
  const QUESTION_ID = /^Q[1-9][0-9]{0,3}$/;
  const ANSWER_STATUSES = ["ok", "ko", "modify", "explain"]; // "explain" only ever leaves the question open
  const MAX_FEED_BYTES = 5 * 1024 * 1024;
  const MAX_ANSWERS = 50;
  const COMMENT_LIMIT = 4000;

  // Control characters, Unicode line separators and bidi overrides: see questions.js.
  // eslint-disable-next-line no-control-regex
  const CONTROL = /[\u0000-\u001F\u007F-\u009F‧-‮⁦-⁩]/;
  const CONTROL_ALL = new RegExp(CONTROL.source, "g");

  /** Text in a bounded, single-line, control-free form, or null. */
  function text(value, max) {
    if (typeof value !== "string") return null;
    const flat = value.replace(CONTROL_ALL, " ").replace(/\s+/g, " ").trim();
    if (!flat) return null;
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  }
  const match = (value, regex) => (typeof value === "string" && regex.test(value) ? value : null);
  const oneOf = (value, list, fallback = null) => (list.includes(value) ? value : fallback);
  const list = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

  function taskRefs(value, textKey, max) {
    return list(value, 100)
      .filter((item) => item && match(item.id, TASK_ID))
      .map((item) => ({ id: item.id, [textKey]: text(item[textKey], max) }));
  }

  // --- questions.json validation, ported from scripts/questions.js's own -----
  // validateQuestions: the exact rules task-flow runs before it ever writes a
  // questions.json, so the viewer and the pipeline agree on what a question is.
  // Without this - a looser, hand-rolled check - a field task-flow's own
  // validator would reject (an extra key smuggled onto an item, say) could slip
  // through here and be believed. Kept in lockstep with questions.js by hand:
  // there is no shared package between a Node CLI script and a page opened by
  // double-clicking a file.
  const KINDS = ["decision", "question"];
  const ANSWER_ITEM_STATUSES = ["ok", "ko", "modify"];
  const VIA = ["panel", "conversation"];
  const OPTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
  const SUBMISSION_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
  const Q_LIMITS = { title: 300, label: 200, text: 2000, comment: 4000, list: 50 };

  function questionsValidator() {
    const errors = [];
    const fail = (where, what) => {
      if (errors.length < 20) errors.push(`${where}: ${what}`);
    };
    const onlyKeys = (value, where, allowed) => {
      for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) fail(where, "has a field that is not part of the format");
      }
    };
    const qtext = (value, where, limit, { required = false } = {}) => {
      if (value === undefined || value === null) return void (required && fail(where, "is required"));
      if (typeof value !== "string") return fail(where, "must be a string");
      if (required && !value.trim()) return fail(where, "must not be empty");
      if (value.length > limit) return fail(where, `is longer than ${limit} characters`);
      if (CONTROL.test(value)) return fail(where, "contains control characters");
    };
    const pattern = (value, where, regex, what, { required = false } = {}) => {
      if (value === undefined || value === null) return void (required && fail(where, "is required"));
      if (typeof value !== "string" || !regex.test(value)) fail(where, `must be ${what}`);
    };
    const oneOfQ = (value, where, allowed, { required = false } = {}) => {
      if (value === undefined || value === null) return void (required && fail(where, "is required"));
      if (!allowed.includes(value)) fail(where, `must be one of ${allowed.join(", ")}`);
    };
    const qlist = (value, where) => {
      if (value === undefined) return [];
      if (!Array.isArray(value)) {
        fail(where, "must be a list");
        return [];
      }
      if (value.length > Q_LIMITS.list) {
        fail(where, `has more than ${Q_LIMITS.list} entries`);
        return value.slice(0, Q_LIMITS.list);
      }
      return value;
    };
    return { errors, fail, onlyKeys, isObject, text: qtext, pattern, oneOf: oneOfQ, list: qlist };
  }

  function validateQuestions(data) {
    const v = questionsValidator();
    if (!v.isObject(data)) return { ok: false, errors: ["(file): must be a JSON object"] };

    v.onlyKeys(data, "(file)", ["version", "slug", "created", "items", "consumedSubmissions"]);
    if (data.version !== 1) v.fail("version", "must be 1");
    v.pattern(data.slug, "slug", SAFE_SEGMENT, "the run folder name", { required: true });
    v.pattern(data.created, "created", DATE, "a yyyy-MM-dd date");

    const seen = new Set();
    const items = v.list(data.items, "items");
    if (data.items === undefined) v.fail("items", "is required");
    items.forEach((item, index) => {
      const at = `items[${index}]`;
      if (!v.isObject(item)) return v.fail(at, "must be an object");
      v.onlyKeys(item, at, ["id", "kind", "phase", "task", "title", "chosen", "options", "why", "ifOverruled", "urgent", "rounds", "createdAt", "answer", "explanations"]);
      v.pattern(item.id, `${at}.id`, QUESTION_ID, "Q followed by a number", { required: true });
      if (typeof item.id === "string") {
        if (seen.has(item.id)) v.fail(`${at}.id`, "is used by another item");
        seen.add(item.id);
      }
      v.oneOf(item.kind, `${at}.kind`, KINDS, { required: true });
      v.oneOf(item.phase, `${at}.phase`, PHASES);
      v.pattern(item.task, `${at}.task`, TASK_ID, "a task id like T4");
      v.text(item.title, `${at}.title`, Q_LIMITS.title, { required: true });
      v.text(item.chosen, `${at}.chosen`, Q_LIMITS.label);
      v.text(item.why, `${at}.why`, Q_LIMITS.text);
      v.text(item.ifOverruled, `${at}.ifOverruled`, Q_LIMITS.text);
      if (item.urgent !== undefined && typeof item.urgent !== "boolean") v.fail(`${at}.urgent`, "must be true or false");
      v.pattern(item.createdAt, `${at}.createdAt`, ISO_TIME, "an ISO timestamp");
      if (item.kind === "decision" && !item.chosen) v.fail(`${at}.chosen`, "is required for a decision");

      const optionIds = new Set();
      v.list(item.options, `${at}.options`).forEach((option, o) => {
        const where = `${at}.options[${o}]`;
        if (!v.isObject(option)) return v.fail(where, "must be an object");
        v.onlyKeys(option, where, ["id", "label", "detail", "chosen"]);
        v.pattern(option.id, `${where}.id`, OPTION_ID, "a short id (letters, digits, - and _)", { required: true });
        if (typeof option.id === "string") {
          if (optionIds.has(option.id)) v.fail(`${where}.id`, "is used by another option");
          optionIds.add(option.id);
        }
        v.text(option.label, `${where}.label`, Q_LIMITS.label, { required: true });
        v.text(option.detail, `${where}.detail`, Q_LIMITS.text);
        if (option.chosen !== undefined && typeof option.chosen !== "boolean") v.fail(`${where}.chosen`, "must be true or false");
      });

      v.list(item.rounds, `${at}.rounds`).forEach((round, r) => {
        const where = `${at}.rounds[${r}]`;
        if (!v.isObject(round)) return v.fail(where, "must be an object");
        v.onlyKeys(round, where, ["round", "verdict", "found", "passages"]);
        if (!Number.isInteger(round.round) || round.round < 1 || round.round > 5) v.fail(`${where}.round`, "must be 1 to 5");
        v.text(round.verdict, `${where}.verdict`, Q_LIMITS.label);
        v.text(round.found, `${where}.found`, Q_LIMITS.text);
        v.list(round.passages, `${where}.passages`).forEach((passage, p) => v.text(passage, `${where}.passages[${p}]`, Q_LIMITS.label, { required: true }));
      });

      if (item.answer !== undefined && item.answer !== null) {
        const where = `${at}.answer`;
        const answer = item.answer;
        if (!v.isObject(answer)) {
          v.fail(where, "must be an object or null");
        } else {
          v.onlyKeys(answer, where, ["status", "choice", "comment", "via", "submissionId", "at"]);
          v.oneOf(answer.status, `${where}.status`, ANSWER_ITEM_STATUSES, { required: true });
          v.text(answer.comment, `${where}.comment`, Q_LIMITS.comment);
          v.oneOf(answer.via, `${where}.via`, VIA, { required: true });
          v.pattern(answer.submissionId, `${where}.submissionId`, SUBMISSION_ID, "a submission id");
          v.pattern(answer.at, `${where}.at`, ISO_TIME, "an ISO timestamp", { required: true });
          if (answer.choice !== undefined && answer.choice !== null) {
            if (typeof answer.choice !== "string" || !optionIds.has(answer.choice)) v.fail(`${where}.choice`, "must be the id of one of the options");
          }
          if (answer.status === "modify" && !answer.comment && !answer.choice) v.fail(where, "a change needs a comment or a choice");
        }
      }

      v.list(item.explanations, `${at}.explanations`).forEach((request, e) => {
        const where = `${at}.explanations[${e}]`;
        if (!v.isObject(request)) return v.fail(where, "must be an object");
        v.onlyKeys(request, where, ["comment", "via", "submissionId", "at", "reply"]);
        v.text(request.comment, `${where}.comment`, Q_LIMITS.comment, { required: true });
        v.oneOf(request.via, `${where}.via`, VIA, { required: true });
        v.pattern(request.submissionId, `${where}.submissionId`, SUBMISSION_ID, "a submission id");
        v.pattern(request.at, `${where}.at`, ISO_TIME, "an ISO timestamp", { required: true });
        v.text(request.reply, `${where}.reply`, Q_LIMITS.text);
      });
    });

    if (data.consumedSubmissions !== undefined && !Array.isArray(data.consumedSubmissions)) v.fail("consumedSubmissions", "must be a list");
    if (Array.isArray(data.consumedSubmissions) && data.consumedSubmissions.length > 10000) v.fail("consumedSubmissions", "has more than 10000 entries");
    (Array.isArray(data.consumedSubmissions) ? data.consumedSubmissions.slice(0, 10000) : []).forEach((id, i) =>
      v.pattern(id, `consumedSubmissions[${i}]`, SUBMISSION_ID, "a submission id", { required: true })
    );

    return { ok: v.errors.length === 0, errors: v.errors };
  }

  const isOpen = (item) => !item.answer;

  /** The questions of a run as the feed carries them. Items are only ever taken
   *  when the whole list still looks like the shape task-flow's own validator
   *  requires, so the viewer and the pipeline agree on what a question is. */
  function questionsOf(value, slug) {
    if (!value || typeof value !== "object") return { source: "none" };
    if (value.source === "legacy") {
      const open = Number.isInteger(value.open) && value.open >= 0 ? Math.min(value.open, 9999) : 0;
      return { source: "legacy", open };
    }
    if (value.source === "json" && validateQuestions({ version: 1, slug, items: value.items, consumedSubmissions: value.consumedSubmissions }).ok) {
      return { source: "json", items: value.items, consumedSubmissions: list(value.consumedSubmissions, 10000) };
    }
    return { source: "invalid" };
  }

  function runOf(value) {
    if (!value || typeof value !== "object") return null;
    const slug = match(value.slug, SAFE_SEGMENT);
    if (!slug) return null;
    if (value.unreadable === true) return { slug, unreadable: true };
    const pr = typeof value.pr === "string" && /^https?:\/\/[^\s()<>[\]"']+$/.test(value.pr) ? value.pr : null;
    const runPage =
      typeof value.runPage === "string" && /^runs\/(finished\/)?\d{6}_[A-Za-z0-9._-]+\.md$/.test(value.runPage) ? value.runPage : null;
    return {
      slug,
      phase: oneOf(value.phase, PHASES),
      status: oneOf(value.status, STATUSES, "paused"),
      mode: value.mode === "auto" ? "auto" : "attended",
      created: match(value.created, DATE),
      updated: match(value.updated, ISO),
      phaseChangedAt: match(value.phaseChangedAt, ISO),
      buildCursor: match(value.buildCursor, TASK_ID),
      tasks: list(value.tasks, 500)
        .filter((task) => task && match(task.id, TASK_ID))
        .map((task) => ({ id: task.id, title: text(task.title, 160) || "", done: task.done === true })),
      pendingTasks: taskRefs(value.pendingTasks, "question", 300),
      skippedTasks: taskRefs(value.skippedTasks, "reason", 200),
      branch: text(value.branch, 120),
      pr,
      runPage,
      questions: questionsOf(value.questions, slug),
    };
  }

  /** Open questions of a run, whatever form it keeps them in. */
  function openQuestions(run) {
    if (!run || !run.questions) return 0;
    if (run.questions.source === "legacy") return run.questions.open;
    if (run.questions.source === "json") return run.questions.items.filter(isOpen).length;
    return 0;
  }

  /** Does this run wait on the user? Stopped for an answer, or anything open in a
   *  run that is not over. A finished run with open questions waits too: its
   *  questions are the user's to close. */
  function waitsOnUser(run) {
    if (!run || run.unreadable) return false;
    return run.status === "blocked" || openQuestions(run) > 0;
  }

  /** The order the home view shows runs in: what waits on the user, what is
   *  running, what is stopped, what is done; most recently updated first inside
   *  each group. */
  function sortRuns(runs) {
    const rank = (run) => (run.unreadable ? 4 : waitsOnUser(run) ? 0 : run.status === "running" ? 1 : run.status === "done" ? 3 : 2);
    return [...runs].sort((a, b) => rank(a) - rank(b) || String(b.updated || "").localeCompare(String(a.updated || "")));
  }

  /** One feed file, validated. `key` is the file's own name: a feed that claims to
   *  be another project is not believed. */
  function parseFeed(raw, key) {
    let data;
    try {
      data = JSON.parse(String(raw).replace(/^﻿/, ""));
    } catch {
      return { projectKey: key, unreadable: true };
    }
    if (!data || typeof data !== "object" || data.version !== 1 || data.projectKey !== key) {
      return { projectKey: key, unreadable: true };
    }
    const projectDir =
      typeof data.projectDir === "string" && /^([A-Za-z]:[\\/]|\/)/.test(data.projectDir) && !CONTROL.test(data.projectDir) ? data.projectDir : null;
    return {
      projectKey: key,
      projectDir,
      projectName: text(data.projectName, 80) || key,
      language: data.language === "pt-PT" ? "pt-PT" : "en",
      generatedAt: match(data.generatedAt, ISO),
      runs: sortRuns(list(data.runs, 200).map(runOf).filter(Boolean)),
    };
  }

  function isFeedFileName(name) {
    return FEED_FILE.test(name);
  }
  function feedKeyOf(name) {
    const found = FEED_FILE.exec(name);
    return found ? found[1] : null;
  }

  /** The flat shape the home view draws a run from - task counters and question
   *  counts folded down to numbers, never the raw items (those are read again,
   *  in full, only when a run is opened). */
  function runSummary(run) {
    if (run.unreadable) return { slug: run.slug, unreadable: true };
    const done = run.tasks.filter((task) => task.done).length;
    const cursor = run.tasks.findIndex((task) => task.id === run.buildCursor);
    return {
      slug: run.slug,
      phase: run.phase,
      status: run.status,
      mode: run.mode,
      updated: run.updated,
      buildCursor: run.buildCursor,
      taskCount: run.tasks.length,
      tasksDone: done,
      taskIndex: cursor >= 0 ? cursor + 1 : null,
      openQuestions: openQuestions(run),
      questionsSource: run.questions.source,
      pendingTasks: run.pendingTasks.length,
      waitsOnUser: waitsOnUser(run),
      branch: run.branch,
      pr: run.pr,
      runPage: run.runPage,
    };
  }

  /** The home view's shape: every project, with its runs folded down to
   *  summaries (see `runSummary`). */
  function projectsView(projects) {
    return projects.map((project) =>
      project.unreadable
        ? { projectKey: project.projectKey, unreadable: true }
        : { projectKey: project.projectKey, projectName: project.projectName, generatedAt: project.generatedAt, runs: project.runs.map(runSummary) }
    );
  }

  /** Every project, projects with something waiting first. */
  function sortProjects(projects) {
    const waiting = (project) => (project.runs || []).some(waitsOnUser);
    return [...projects].sort(
      (a, b) => Number(waiting(b)) - Number(waiting(a)) || String(a.projectName || "").localeCompare(String(b.projectName || ""))
    );
  }

  /** A run's questions as cards: what the page draws. Open ones first; the ones
   *  already answered follow, closed. The recommended option of a decision is the
   *  one the agent chose. */
  function cardsFor(run) {
    if (!run || !run.questions || run.questions.source !== "json") return [];
    const cards = run.questions.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      open: isOpen(item),
      urgent: item.urgent === true,
      title: item.title,
      phase: item.phase || null,
      task: item.task || null,
      why: item.why || null,
      ifOverruled: item.ifOverruled || null,
      chosen: item.chosen || null,
      options: (item.options || []).map((option) => ({
        id: option.id,
        label: option.label,
        detail: option.detail || null,
        recommended: option.chosen === true || (item.kind === "decision" && option.label === item.chosen),
      })),
      answer: item.answer || null,
      explanations: item.explanations || [],
    }));
    return [...cards.filter((card) => card.open), ...cards.filter((card) => !card.open)];
  }

  /**
   * Checks one outgoing answer batch against its closed shape before it is ever
   * written to disk - the same rules answers.js checkSubmission enforces when
   * task-flow takes the file in, so the viewer never writes a submission the
   * pipeline would refuse. That later check is still what actually protects the
   * run: this one only saves the user from sending something that would sit on
   * disk unread.
   */
  function checkOutgoingAnswers(items, cardsById) {
    if (!Array.isArray(items) || !items.length || items.length > MAX_ANSWERS) {
      return { ok: false, why: `answers must be a list of 1 to ${MAX_ANSWERS}` };
    }
    const seen = new Set();
    const cleaned = [];
    for (const [index, answer] of items.entries()) {
      const at = `answers[${index}]`;
      if (!isObject(answer)) return { ok: false, why: `${at} is not an object` };
      if (!match(answer.questionId, QUESTION_ID)) return { ok: false, why: `${at}.questionId is not a question id` };
      if (seen.has(answer.questionId)) return { ok: false, why: `${at} answers the same question twice` };
      seen.add(answer.questionId);
      if (!ANSWER_STATUSES.includes(answer.status)) return { ok: false, why: `${at}.status must be one of ${ANSWER_STATUSES.join(", ")}` };
      const card = cardsById.get(answer.questionId);
      if (!card) return { ok: false, why: `${at}.questionId is not one of this run's open questions` };
      if (answer.choice !== undefined && !card.options.some((option) => option.id === answer.choice)) {
        return { ok: false, why: `${at}.choice is not one of the question's options` };
      }
      const comment = typeof answer.comment === "string" ? text(answer.comment, COMMENT_LIMIT) || "" : "";
      if (answer.status === "explain" && !comment) return { ok: false, why: `${at} asks for an explanation without saying what` };
      if (answer.status === "modify" && !comment && !answer.choice) return { ok: false, why: `${at} asks for a change without saying which` };
      const item = { questionId: answer.questionId, status: answer.status };
      if (answer.choice) item.choice = answer.choice;
      if (comment) item.comment = comment;
      cleaned.push(item);
    }
    return { ok: true, answers: cleaned };
  }

  function newId(bytes = 12) {
    const cryptoObj = typeof crypto !== "undefined" ? crypto : require("crypto").webcrypto;
    const array = new Uint8Array(bytes);
    cryptoObj.getRandomValues(array);
    return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** answers.js SUBMISSION_ID: yyyyMMddThhmmssZ-xxxxxxxx. */
  function newSubmissionId(now = new Date()) {
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    return `${stamp}-${newId(4)}`;
  }

  function isIsoTime(value) {
    return typeof value === "string" && ISO_TIME.test(value);
  }

  return {
    openQuestions, waitsOnUser, sortRuns, parseFeed, isFeedFileName, feedKeyOf,
    FEED_SIZE_LIMIT: MAX_FEED_BYTES, runSummary, projectsView, sortProjects, cardsFor,
    checkOutgoingAnswers, newId, newSubmissionId, isIsoTime, validateQuestions,
  };
});
