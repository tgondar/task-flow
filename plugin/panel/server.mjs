// The task-flow panel's local server: no dependencies, Node 20+.
//
// It serves one page that shows the runs of every project on this machine and
// lets the user answer their questions. Everything it knows comes from the feed
// (feed.mjs); everything it writes goes to two folders of its own under the
// local state folder (config.js homeDir):
//
//   <home>/answers/<projectKey>/<run>/<submissionId>.json   one file per "send"
//   <home>/panel/drafts/<projectKey>/<run>.json             answers not sent yet
//   <home>/panel/server.json                                 where it is listening
//
// and nowhere else. It has no path into a project or a docs folder - it does not
// know where they are. That is the promise the whole design rests on: the
// documentation is written by task-flow alone, which takes the answers in with
// `answers.js consume` at a point of its choosing.
//
// The protections of FluidPlan's server are kept (after engine/server.mjs, see
// NOTICE.md) and tightened, because what is written here reaches the model:
//   - it listens on 127.0.0.1 only, and refuses any Host but its own (421), so a
//     page elsewhere cannot reach it through DNS rebinding;
//   - a write needs an Origin, and it must be this server's (403): a browser
//     always sends one on a cross-site POST, so a page elsewhere cannot answer
//     for the user; a local program that sends none gets nothing here it could
//     not already do by writing a file;
//   - a write must be JSON, of bounded size;
//   - every response forbids framing and sniffing, and the page may load only
//     its own scripts (Content-Security-Policy, no inline script);
//   - every id that becomes part of a path is checked against its closed shape,
//     and the path is checked again by config.js homePath (no .., no link);
//   - a submission is checked by the same function task-flow uses to take it in
//     (answers.js checkSubmission), so the panel can never write one that the
//     pipeline would refuse - and nothing here can write an approval.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs";
import { readFile, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { cardsFor, openQuestions, readFeeds, waitsOnUser } from "./feed.mjs";
import { httpError, safeJoin, writeAtomic } from "./fsutil.mjs";

const require = createRequire(import.meta.url);
const { homePath } = require("../scripts/config.js");
const { checkSubmission } = require("../scripts/answers.js");

const PANEL = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(PANEL, "public");
const HOST = "127.0.0.1";
export const DEFAULT_PORT = 5190;
const PORT_TRIES = 10;
const MAX_BODY = 512 * 1024;

const PROJECT_KEY = /^[0-9a-f]{16}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SUBMISSION_FILE = /^([0-9]{8}T[0-9]{6}Z-[0-9a-f]{8})\.json$/;
const CLIENT_TOKEN = /^[A-Za-z0-9_-]{8,64}$/;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Sent with every response. The page has no inline script and loads nothing
 *  from elsewhere, so the policy can be this strict. */
export const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/** `yyyyMMddTHHmmssZ-<8 hex>`: sortable by time, unique by the random tail. */
function newSubmissionId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

/** The folders the panel writes, checked before it starts: a link anywhere on
 *  the way (config.js homePath) would carry its writes somewhere nobody chose,
 *  so the panel refuses to run at all rather than find out on the first answer. */
export function panelPaths(options) {
  return {
    answers: homePath(["answers"], options),
    panel: homePath(["panel"], options),
    drafts: homePath(["panel", "drafts"], options),
    registry: homePath(["panel", "server.json"], options),
    feed: homePath(["feed"], options),
  };
}

/**
 * Starts the panel. Tries the next ports when the first is taken; `port: 0` lets
 * the system choose (the tests). Resolves `{ server, port, url, close }`.
 * `env` is only for the tests: it decides where the local state folder is.
 */
export async function startPanel({ port = DEFAULT_PORT, quiet = false, register = true, env } = {}) {
  const options = env ? { env } : undefined;
  const paths = panelPaths(options); // throws on a link: the panel does not start
  const sent = new Map(); // clientToken -> submissionId, so a double click writes once

  let listening = port;
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error.status ?? 500;
      if (status >= 500 && !quiet) console.error(error);
      if (!res.headersSent) sendJson(res, status, { error: status >= 500 ? "internal error" : error.message });
      else res.end();
    });
  });

  async function handle(req, res) {
    const host = String(req.headers.host ?? "");
    if (host !== `${HOST}:${listening}` && host !== `localhost:${listening}`) throw httpError(421, "host rejected");
    const url = new URL(req.url, `http://${HOST}:${listening}`);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      throw httpError(400, "bad path");
    }
    if (pathname.startsWith("/api/")) return api(req, res, url, pathname);
    if (req.method !== "GET" && req.method !== "HEAD") throw httpError(405, "method not allowed");
    if (pathname === "/" || pathname === "/index.html") return sendFile(res, path.join(PUBLIC, "panel.html"));
    return sendFile(res, safeJoin(PUBLIC, pathname.slice(1)));
  }

  async function api(req, res, url, pathname) {
    if (req.method !== "GET") {
      const origin = req.headers.origin;
      if (origin !== `http://${HOST}:${listening}` && origin !== `http://localhost:${listening}`) {
        throw httpError(403, "origin rejected");
      }
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        throw httpError(415, "JSON only");
      }
    }
    switch (`${req.method} ${pathname}`) {
      case "GET /api/projects":
        return sendJson(res, 200, { projects: projectsView() });
      case "GET /api/run": {
        const { project, run } = findRun(url);
        return sendJson(res, 200, {
          project: { projectKey: project.projectKey, projectName: project.projectName, projectDir: project.projectDir },
          run: { ...runSummary(run), tasks: run.tasks, pendingTasks: run.pendingTasks, skippedTasks: run.skippedTasks },
          cards: cardsFor(run),
          draft: readDraft(project.projectKey, run.slug),
        });
      }
      case "PUT /api/draft": {
        const { project, run } = findRun(url);
        const body = await readJsonBody(req);
        const draft = checkDraft(body, run);
        await writeAtomic(draftFile(project.projectKey, run.slug), JSON.stringify(draft, null, 2) + "\n");
        return sendJson(res, 200, { saved: true });
      }
      case "POST /api/submit": {
        const { project, run } = findRun(url);
        const body = await readJsonBody(req);
        return sendJson(res, 200, await submit(project, run, body));
      }
      case "GET /api/events":
        return events(req, res);
      default:
        throw httpError(404, "unknown route");
    }
  }

  // --- what the page is given ---------------------------------------------------

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

  function projectsView() {
    const projects = readFeeds(options);
    for (const project of projects) clearConsumed(project);
    return projects.map((project) =>
      project.unreadable
        ? { projectKey: project.projectKey, unreadable: true }
        : {
            projectKey: project.projectKey,
            projectName: project.projectName,
            generatedAt: project.generatedAt,
            runs: project.runs.map(runSummary),
          }
    );
  }

  function findRun(url) {
    const key = url.searchParams.get("project") ?? "";
    const slug = url.searchParams.get("slug") ?? "";
    if (!PROJECT_KEY.test(key) || !SAFE_SEGMENT.test(slug)) throw httpError(400, "bad project or run");
    const project = readFeeds(options).find((candidate) => candidate.projectKey === key);
    if (!project || project.unreadable) throw httpError(404, "no such project");
    const run = project.runs.find((candidate) => candidate.slug === slug);
    if (!run || run.unreadable) throw httpError(404, "no such run");
    return { project, run };
  }

  // --- drafts -------------------------------------------------------------------

  const draftFile = (key, slug) => homePath(["panel", "drafts", key, `${slug}.json`], options);

  function readDraft(key, slug) {
    try {
      const data = JSON.parse(fs.readFileSync(draftFile(key, slug), "utf8"));
      return data && typeof data === "object" && data.answers && typeof data.answers === "object" ? data.answers : {};
    } catch {
      return {};
    }
  }

  /** A draft is the page's working copy: kept in the same shape as a submission
   *  answer, one per open question, and nothing else. It is checked loosely
   *  (an unfinished answer is allowed) but never lets a field through that a
   *  submission would not have. */
  function checkDraft(body, run) {
    if (!body || typeof body !== "object" || !body.answers || typeof body.answers !== "object" || Array.isArray(body.answers)) {
      throw httpError(400, "a draft is { answers: { <questionId>: {...} } }");
    }
    const open = new Set(cardsFor(run).filter((card) => card.open).map((card) => card.id));
    const answers = {};
    for (const [id, answer] of Object.entries(body.answers)) {
      if (!open.has(id)) continue; // a question closed meanwhile: its draft goes
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw httpError(400, "bad draft answer");
      const kept = {};
      if (["ok", "ko", "modify", "explain"].includes(answer.status)) kept.status = answer.status;
      if (typeof answer.choice === "string" && answer.choice.length <= 40) kept.choice = answer.choice;
      if (typeof answer.comment === "string") {
        if (answer.comment.length > 4000) throw httpError(400, "comment too long");
        kept.comment = answer.comment;
      }
      answers[id] = kept;
    }
    return { version: 1, answers };
  }

  // --- sending ------------------------------------------------------------------

  async function submit(project, run, body) {
    if (!project.projectDir) throw httpError(409, "this project's feed does not say where it is");
    if (!body || typeof body !== "object" || !Array.isArray(body.answers)) throw httpError(400, "a submission is { answers: [...] }");
    if (typeof body.clientToken !== "string" || !CLIENT_TOKEN.test(body.clientToken)) throw httpError(400, "clientToken missing");
    const already = sent.get(`${project.projectKey}/${run.slug}/${body.clientToken}`);
    if (already) return { submissionId: already, repeated: true };
    if (run.questions.source !== "json") throw httpError(409, "this run keeps its questions in a hand-written page");

    const submissionId = newSubmissionId();
    const submission = {
      version: 1,
      projectDir: project.projectDir,
      slug: run.slug,
      submissionId,
      submittedAt: new Date().toISOString(),
      answers: body.answers,
    };
    const raw = JSON.stringify(submission, null, 2) + "\n";
    // The very check task-flow will run when it takes this in. A submission it
    // would refuse is refused here, while the user is still looking at it.
    const checked = checkSubmission({ raw, id: submissionId, projectDir: project.projectDir, slug: run.slug, data: { items: run.questions.items } });
    if (!checked.ok) throw httpError(400, checked.why);
    const closed = checked.answers.filter((answer) => !answer.item || answer.item.answer);
    if (closed.length) throw httpError(409, "a question in this submission is no longer open");

    const dir = homePath(["answers", project.projectKey, run.slug], options);
    await writeAtomic(path.join(dir, `${submissionId}.json`), raw);
    sent.set(`${project.projectKey}/${run.slug}/${body.clientToken}`, submissionId);
    await rm(draftFile(project.projectKey, run.slug), { force: true });
    return { submissionId };
  }

  /** The panel's own clean-up: a submission task-flow has taken in (its id is in
   *  the run's consumedSubmissions, as the feed shows) is no longer needed. Only
   *  file names of the panel's own shape are touched. */
  function clearConsumed(project) {
    if (project.unreadable) return;
    for (const run of project.runs) {
      if (run.unreadable || run.questions.source !== "json" || !run.questions.consumedSubmissions.length) continue;
      const consumed = new Set(run.questions.consumedSubmissions);
      let dir;
      try {
        dir = homePath(["answers", project.projectKey, run.slug], options);
      } catch {
        continue;
      }
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const found = SUBMISSION_FILE.exec(name);
        if (found && consumed.has(found[1])) fs.rmSync(path.join(dir, name), { force: true });
      }
    }
  }

  // --- live updates -------------------------------------------------------------

  /** Tells the page when a feed changed. Modification times are compared every
   *  second, as FluidPlan does: fs.watch is unreliable on Windows. */
  function events(req, res) {
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write("retry: 2000\n\n");
    const stamp = () => {
      try {
        return fs
          .readdirSync(paths.feed)
          .filter((name) => /^[0-9a-f]{16}\.json$/.test(name))
          .map((name) => `${name}:${fs.statSync(path.join(paths.feed, name)).mtimeMs}`)
          .join("|");
      } catch {
        return "";
      }
    };
    let last = stamp();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      const now = stamp();
      if (now !== last) res.write("event: feed\ndata: {}\n\n");
      last = now;
      if (ticks % 15 === 0) res.write(": ping\n\n");
    }, 1000);
    req.on("close", () => clearInterval(timer));
  }

  // --- listening ----------------------------------------------------------------

  for (let attempt = 0; attempt < PORT_TRIES; attempt += 1) {
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(listening, HOST, () => {
          server.off("error", reject);
          resolve();
        });
      });
      break;
    } catch (error) {
      if (error.code !== "EADDRINUSE" || attempt === PORT_TRIES - 1 || listening === 0) throw error;
      listening += 1;
    }
  }
  listening = server.address().port;

  const url = `http://${HOST}:${listening}/`;
  if (register) await writeAtomic(paths.registry, JSON.stringify({ port: listening, pid: process.pid, startedAt: new Date().toISOString() }, null, 2) + "\n");
  const cleanup = async () => {
    try {
      const info = JSON.parse(await readFile(paths.registry, "utf8"));
      if (info.pid === process.pid) await rm(paths.registry, { force: true });
    } catch {
      /* nothing to clean up */
    }
  };
  const close = () => new Promise((resolve) => server.close(() => cleanup().then(resolve)));
  if (!quiet) console.log(`task-flow panel: ${url}`);
  return { server, port: listening, url, close };
}

async function sendFile(res, file) {
  if (!file || !existsSync(file) || !fs.statSync(file).isFile()) throw httpError(404, "file not found");
  const body = await readFile(file);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

function sendJson(res, status, data) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw httpError(413, "request body too large");
    chunks.push(chunk);
  }
  if (!size) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "unreadable JSON");
  }
}
