// Everything that touches the filesystem: reading the feed task-flow leaves in
// <home>/feed/, and writing an answer submission to <home>/answers/. No network
// request is made anywhere in this file - there is nothing to make one to. The
// browser's own permission model is what stands in for the panel's server-side
// checks (loopback only, a token, an Origin check): a handle only reads and
// writes inside the folder the user explicitly granted.
window.TFV = window.TFV || {};
(function () {
const { parseFeed, sortProjects, feedKeyOf, isFeedFileName, FEED_SIZE_LIMIT, cardsFor, checkOutgoingAnswers, newSubmissionId, projectsView } = window.TFV;
const { loadRootHandle, saveRootHandle, hasReadPermission, requestPermission } = window.TFV;

class NotGrantedError extends Error {}

/** Opens the OS folder picker (must run from a click) and remembers the choice.
 *  Not a security decision here: the browser is the one enforcing that nothing
 *  outside the granted folder is ever reachable through the handle. */
async function pickRoot() {
  if (!("showDirectoryPicker" in window)) {
    throw new Error("This browser has no folder picker (File System Access API). Use Chrome or Edge.");
  }
  const handle = await window.showDirectoryPicker({ id: "task-flow-home", mode: "readwrite" });
  await saveRootHandle(handle);
  return handle;
}

/** The remembered folder, if the browser still lets this page use it without
 *  asking again. Returns null rather than prompting - prompting needs a click,
 *  and boot() runs on page load, not on one. */
async function savedRoot() {
  const handle = await loadRootHandle();
  if (!handle) return null;
  if (!(await hasReadPermission(handle))) return null;
  return handle;
}

/** The remembered folder exists but needs a fresh grant (the permission does not
 *  survive forever). Call only from a click. */
async function reauthorize() {
  const handle = await loadRootHandle();
  if (!handle) throw new NotGrantedError("No folder remembered yet.");
  if (!(await requestPermission(handle))) throw new NotGrantedError("Access to the folder was not granted.");
  return handle;
}

async function readText(dirHandle, name) {
  const fileHandle = await dirHandle.getFileHandle(name);
  const file = await fileHandle.getFile();
  if (file.size > FEED_SIZE_LIMIT) throw new Error(`${name} is too large`);
  return file.text();
}

async function getDir(root, segments, { create = false } = {}) {
  let dir = root;
  for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create });
  return dir;
}

/** Every project the viewer knows about - the exact same shape and trust rules
 *  feed.mjs applied for the panel, just read straight off disk instead of over
 *  HTTP. A missing feed folder (task-flow never ran here) is "no projects", not
 *  an error. */
async function loadProjects(root) {
  let feedDir;
  try {
    feedDir = await root.getDirectoryHandle("feed");
  } catch {
    return [];
  }
  const projects = [];
  for await (const [name, handle] of feedDir.entries()) {
    if (handle.kind !== "file" || !isFeedFileName(name)) continue;
    const key = feedKeyOf(name);
    try {
      projects.push(parseFeed(await readText(feedDir, name), key));
    } catch {
      projects.push({ projectKey: key, unreadable: true });
    }
  }
  return sortProjects(projects);
}

/** The home view's shape: projects with their runs folded down to summaries. */
async function loadHome(root) {
  return projectsView(await loadProjects(root));
}

async function loadRun(root, projectKey, slug) {
  const projects = await loadProjects(root);
  const project = projects.find((p) => p.projectKey === projectKey);
  const run = project?.runs.find((r) => r.slug === slug);
  if (!project || !run) return null;
  return { project, run, cards: cardsFor(run) };
}

// --- drafts: kept in this browser only, never written to disk --------------
// A draft is a convenience for the person typing, not part of the pipeline's
// contract, so localStorage (per-viewer, never shared) is the right place for
// it - simpler than the panel's server-side draft file, and it disappears
// naturally with the browser's own data instead of needing its own cleanup.
const draftKey = (projectKey, slug) => `task-flow-viewer:draft:${projectKey}/${slug}`;

function loadDraft(projectKey, slug) {
  try {
    const raw = localStorage.getItem(draftKey(projectKey, slug));
    const data = raw ? JSON.parse(raw) : null;
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function saveDraft(projectKey, slug, answers) {
  try {
    localStorage.setItem(draftKey(projectKey, slug), JSON.stringify(answers));
  } catch {
    /* the draft is a convenience; the answers are still on screen */
  }
}

function clearDraft(projectKey, slug) {
  try {
    localStorage.removeItem(draftKey(projectKey, slug));
  } catch {
    /* nothing to do */
  }
}

/** Writes one answers/<projectKey>/<slug>/<submissionId>.json - the exact file
 *  answers.js consume expects from the panel this viewer replaced. Checked
 *  against the run's open questions first (checkOutgoingAnswers): that is a
 *  courtesy to the person sending it, not the real gate - consume() validates
 *  again, in full, when task-flow actually takes the file in. */
async function submitAnswers(root, { project, run, cards }, items) {
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const checked = checkOutgoingAnswers(items, cardsById);
  if (!checked.ok) throw new Error(checked.why);

  const submissionId = newSubmissionId();
  const submission = {
    version: 1,
    projectDir: project.projectDir,
    slug: run.slug,
    submissionId,
    submittedAt: new Date().toISOString(),
    answers: checked.answers,
  };
  const dir = await getDir(root, ["answers", project.projectKey, run.slug], { create: true });
  const fileHandle = await dir.getFileHandle(`${submissionId}.json`, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(submission, null, 2) + "\n");
  await writable.close();
  clearDraft(project.projectKey, run.slug);
  return { submissionId };
}

Object.assign(window.TFV, {
  NotGrantedError, pickRoot, savedRoot, reauthorize, loadProjects, loadHome, loadRun,
  loadDraft, saveDraft, clearDraft, submitAnswers,
});
})();
