// The panel's page: loads the labels, shows the home view or a run, and redraws
// when a feed changes on disk (the server's /api/events).
//
// Two views, chosen by the address: `#/` is every project and run, `#/run/<project
// key>/<run>` is one run's questions as cards. The server decides everything
// about ordering and shape; this file only draws what it is given.
import { h } from "./dom.js";
import { makeT } from "./i18n.js";
import { renderHome } from "./home.js";

const app = document.getElementById("app");

// The panel's token (server.mjs): every API call carries it. The page gets it
// once, in the address panel.mjs --open builds - #t=<token> - and keeps it in
// this browser, so a bookmark of the plain address keeps working. It is taken
// out of the address at once, so it is not left in the history or on screen.
const TOKEN_KEY = "task-flow-panel:token";
function takeToken() {
  const match = /^#t=([0-9a-f]{64})$/.exec(location.hash);
  if (match) {
    try {
      localStorage.setItem(TOKEN_KEY, match[1]);
    } catch {
      /* storage blocked: the token lives for this page only */
    }
    history.replaceState(null, "", location.pathname);
    return match[1];
  }
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
const token = takeToken();

export async function getJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...(options.headers ?? {}), "X-Panel-Token": token ?? "" } });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) throw Object.assign(new Error((body && body.error) || String(response.status)), { status: response.status });
  return body;
}

let t = (key) => key;
let view = null; // the function that redraws the current view

const go = (hash) => {
  if (location.hash === hash) route();
  else location.hash = hash;
};

function showError(error) {
  app.replaceChildren(h("p", { class: "empty", role: "alert" }, t("app.error", { message: error.message })));
}

async function route() {
  const match = /^#\/run\/([0-9a-f]{16})\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(decodeURIComponent(location.hash));
  if (match) {
    const { renderRun } = await import("./run.js");
    view = () => renderRun(app, { project: match[1], slug: match[2], t, go, getJson });
  } else {
    view = async () => renderHome(app, { projects: (await getJson("/api/projects")).projects, t, go });
  }
  try {
    await view();
  } catch (error) {
    showError(error);
  }
}

function listen() {
  const events = new EventSource("/api/events");
  // A feed changed: redraw what is on screen. A run view keeps what is being
  // typed (run.js saves drafts as the user goes), so a redraw loses nothing.
  events.addEventListener("feed", () => view && view().catch(showError));
}

async function boot() {
  try {
    t = makeT(await getJson("/i18n/en.json"), "en");
  } catch (error) {
    showError(error);
    return;
  }
  document.title = t("app.title");
  if (!token) {
    app.replaceChildren(h("h1", {}, t("app.title")), h("p", { class: "empty", role: "alert" }, t("app.noToken")));
    return;
  }
  window.addEventListener("hashchange", route);
  await route();
  listen();
}

boot();
