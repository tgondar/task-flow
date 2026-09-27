// What the panel knows about the runs on this machine: the feed files task-flow
// leaves in <home>/feed/ (render-run.js writeFeed), and nothing else.
//
// The panel never opens a project, its configuration or its docs folder. That is
// not a precaution on top of the design, it is the design: the documentation is
// written by task-flow alone, and a panel that cannot find a docs folder cannot
// write to one.
//
// A feed file is still UNTRUSTED here. It is written by task-flow, but out of a
// state.json that any repository can bring, and this module feeds a web page.
// So every field is taken only in a closed shape - an id that matches its
// pattern, a status out of a fixed list, text of bounded length without control
// characters - and anything else is dropped. The page escapes all text on top of
// that; this is the first of two walls, not the only one.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { homePath } = require("../scripts/config.js");
const questionsData = require("../scripts/questions.js");

const FEED_FILE = /^([0-9a-f]{16})\.json$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TASK_ID = /^T[0-9]+[a-z]?$/;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PHASES = ["idea", "spec", "plan", "build", "tests", "harden", "review", "done"];
const STATUSES = ["running", "blocked", "failed", "done", "paused"];
const MAX_FEED_BYTES = 5 * 1024 * 1024;

// Control characters, Unicode line separators and bidi overrides: see questions.js.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2027-\u202E\u2066-\u2069]/;
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

function taskRefs(value, textKey, max) {
  return list(value, 100)
    .filter((item) => item && match(item.id, TASK_ID))
    .map((item) => ({ id: item.id, [textKey]: text(item[textKey], max) }));
}

/** The questions of a run as the feed carries them. Items are only ever taken
 *  when the whole list passes task-flow's own validation - the same function
 *  task-flow ran before putting them in - so the panel and the pipeline agree on
 *  what a question is. */
function questionsOf(value, slug) {
  if (!value || typeof value !== "object") return { source: "none" };
  if (value.source === "legacy") {
    const open = Number.isInteger(value.open) && value.open >= 0 ? Math.min(value.open, 9999) : 0;
    return { source: "legacy", open };
  }
  if (value.source === "json") {
    const data = { version: 1, slug, items: value.items, consumedSubmissions: value.consumedSubmissions };
    if (questionsData.validateQuestions(data).ok) {
      return { source: "json", items: value.items, consumedSubmissions: value.consumedSubmissions || [] };
    }
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
export function openQuestions(run) {
  if (!run || !run.questions) return 0;
  if (run.questions.source === "legacy") return run.questions.open;
  if (run.questions.source === "json") return run.questions.items.filter(questionsData.isOpen).length;
  return 0;
}

/** Does this run wait on the user? Stopped for an answer, or anything open in a
 *  run that is not over. A finished run with open questions waits too: its
 *  questions are the user's to close. */
export function waitsOnUser(run) {
  if (!run || run.unreadable) return false;
  return run.status === "blocked" || openQuestions(run) > 0;
}

/** The order the home view shows runs in: what waits on the user, what is
 *  running, what is stopped, what is done; most recently updated first inside
 *  each group. */
export function sortRuns(runs) {
  const rank = (run) => (run.unreadable ? 4 : waitsOnUser(run) ? 0 : run.status === "running" ? 1 : run.status === "done" ? 3 : 2);
  return [...runs].sort((a, b) => rank(a) - rank(b) || String(b.updated || "").localeCompare(String(a.updated || "")));
}

/** One feed file, validated. `key` is the file's own name: a feed that claims to
 *  be another project is not believed. */
export function parseFeed(raw, key) {
  let data;
  try {
    data = JSON.parse(String(raw).replace(/^\uFEFF/, ""));
  } catch {
    return { projectKey: key, unreadable: true };
  }
  if (!data || typeof data !== "object" || data.version !== 1 || data.projectKey !== key) {
    return { projectKey: key, unreadable: true };
  }
  const projectDir = typeof data.projectDir === "string" && path.isAbsolute(data.projectDir) && !CONTROL.test(data.projectDir) ? data.projectDir : null;
  return {
    projectKey: key,
    projectDir,
    projectName: text(data.projectName, 80) || key,
    language: data.language === "pt-PT" ? "pt-PT" : "en",
    generatedAt: match(data.generatedAt, ISO),
    runs: sortRuns(list(data.runs, 200).map(runOf).filter(Boolean)),
  };
}

/** Every project the panel knows about, projects with something waiting first.
 *  Throws only when the feed folder itself is unusable (a link, a network path);
 *  a single bad file is listed as unreadable and hides nothing else. */
export function readFeeds({ env } = {}) {
  const dir = homePath(["feed"], env ? { env } : undefined);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const projects = [];
  for (const name of names) {
    const found = FEED_FILE.exec(name);
    if (!found) continue;
    const file = homePath(["feed", name], env ? { env } : undefined);
    try {
      const stats = fs.lstatSync(file);
      if (!stats.isFile() || stats.size > MAX_FEED_BYTES) throw new Error("not a plain, small file");
      projects.push(parseFeed(fs.readFileSync(file, "utf8"), found[1]));
    } catch {
      projects.push({ projectKey: found[1], unreadable: true });
    }
  }
  const waiting = (project) => (project.runs || []).some(waitsOnUser);
  return projects.sort(
    (a, b) => Number(waiting(b)) - Number(waiting(a)) || String(a.projectName || "").localeCompare(String(b.projectName || ""))
  );
}

/** A run's questions as cards: what the page draws. Open ones first; the ones
 *  already answered follow, closed. The recommended option of a decision is the
 *  one the agent chose. */
export function cardsFor(run) {
  if (!run || !run.questions || run.questions.source !== "json") return [];
  const cards = run.questions.items.map((item) => ({
    id: item.id,
    kind: item.kind,
    open: questionsData.isOpen(item),
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
