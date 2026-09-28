// The home view: every project on this machine, and its runs - the ones waiting
// for the user first (the server has already ordered them, feed.mjs sortRuns).
//
// Every piece of text here comes from a feed that a repository's state.json fed,
// so it only ever enters the page as a text node (dom.js h). There is no
// innerHTML in this file, and a PR link is only rendered when the server has
// already reduced it to an http(s) URL.
import { h } from "./dom.js";
import { badge, button } from "./ui.js";

/** A run is finished once it is done and nothing on it still waits for the
 *  user (feed.mjs: a done run with open questions still waits). */
function isFinished(run) {
  return !run.unreadable && run.status === "done" && !run.waitsOnUser;
}

const PHASES = ["idea", "spec", "plan", "build", "tests", "harden", "review"];

/** "3 minutes ago", from an ISO time; empty when there is none. */
export function ago(iso, t, now = Date.now()) {
  const then = Date.parse(iso ?? "");
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 1) return t("ago.now");
  if (minutes < 60) return t("ago.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t("ago.hours", { count: hours });
  return t("ago.days", { count: Math.round(hours / 24) });
}

/** `phase` is the last stage COMPLETED (SKILL.md §8), so the one in flight is
 *  the next - the same reading as the run page. */
function phaseText(run, t) {
  if (run.phase === "done") return t("run.finished");
  const index = PHASES.indexOf(run.phase);
  const inFlight = PHASES[index + 1] ?? PHASES[PHASES.length - 1];
  return t("run.phase", { n: PHASES.indexOf(inFlight) + 1, total: PHASES.length, name: inFlight });
}

function statusBadge(run, t) {
  if (run.waitsOnUser && run.status !== "blocked") return badge(t("status.waiting"), { variant: "warning" });
  const variants = { running: "info", blocked: "warning", failed: "danger", done: "secondary", paused: "outline" };
  return badge(t(`status.${run.status}`), { variant: variants[run.status] ?? "outline" });
}

function runRow(project, run, t, go) {
  if (run.unreadable) {
    return h("li", { class: "run-row" }, h("div", { class: "run-title" }, h("strong", {}, run.slug), badge(t("run.unreadable"), { variant: "danger" })));
  }
  const meta = [phaseText(run, t)];
  if (run.taskIndex) meta.push(t("run.task", { i: run.taskIndex, n: run.taskCount }));
  else if (run.taskCount) meta.push(t("run.tasksDone", { done: run.tasksDone, n: run.taskCount }));
  meta.push(run.updated ? t("run.updated", { ago: ago(run.updated, t) }) : t("run.noUpdate"));
  if (run.openQuestions) meta.push(t("run.questions", { count: run.openQuestions }));
  if (run.pendingTasks) meta.push(t("run.pending", { count: run.pendingTasks }));
  if (run.questionsSource === "legacy" && run.openQuestions) meta.push(t("run.legacy"));
  if (run.questionsSource === "invalid") meta.push(t("run.invalid"));

  const extras = [];
  if (run.branch) extras.push(h("code", {}, run.branch));
  if (run.pr) extras.push(h("a", { href: run.pr, target: "_blank", rel: "noopener noreferrer" }, "PR"));
  if (run.runPage) extras.push(h("span", {}, t("run.page", { path: run.runPage })));

  const canAnswer = run.questionsSource === "json";
  return h(
    "li",
    { class: `run-row${run.waitsOnUser ? " waits" : ""}`, dataset: { slug: run.slug } },
    h("div", { class: "run-title" }, h("strong", {}, run.slug), statusBadge(run, t), run.mode === "auto" ? badge(t("run.auto"), { variant: "outline" }) : null),
    h("div", { class: "run-meta" }, meta.map((part) => h("span", {}, part)), extras),
    h(
      "div",
      { class: "run-actions" },
      canAnswer
        ? button({
            label: run.openQuestions ? t("run.open") : t("run.view"),
            variant: run.openQuestions ? "default" : "outline",
            size: "sm",
            onclick: () => go(`#/run/${project.projectKey}/${encodeURIComponent(run.slug)}`),
          })
        : null
    )
  );
}

export function renderHome(root, { projects, t, go }) {
  const readable = projects.filter((project) => !project.unreadable);
  const waiting = readable.flatMap((project) => project.runs).filter((run) => run.waitsOnUser).length;

  const header = h(
    "header",
    { class: "panel-header" },
    h("div", {}, h("h1", {}, t("app.title")), h("p", {}, t("app.subtitle")))
  );
  const summary = h("p", { class: "panel-summary" }, waiting ? h("strong", {}, t("home.waiting", { count: waiting })) : t("home.nothingWaiting"));

  const body = [];
  if (!projects.length) {
    body.push(h("section", { class: "card empty" }, h("div", { class: "card-header" }, h("div", { class: "card-title" }, t("home.empty.title"))), h("div", { class: "card-content" }, h("p", {}, t("home.empty.body")))));
  }
  if (projects.some((project) => project.unreadable)) body.push(h("p", { class: "empty" }, t("home.unreadable")));
  for (const project of readable) {
    const open = project.runs.filter((run) => !isFinished(run));
    const children = open.length
      ? [h("ul", { class: "runs" }, open.map((run) => runRow(project, run, t, go)))]
      : project.runs.length
      ? [h("p", { class: "empty" }, t("home.allFinished"))]
      : [];
    body.push(
      h(
        "section",
        { class: "project", dataset: { project: project.projectKey } },
        h("div", { class: "project-head" }, h("h2", {}, project.projectName), project.generatedAt ? h("span", {}, t("home.generated", { ago: ago(project.generatedAt, t) })) : null),
        ...children
      )
    );
  }
  root.replaceChildren(header, projects.length ? summary : null, ...body);
}
