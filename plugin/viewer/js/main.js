// The viewer's page: loads the labels, shows the home view or a run, and
// re-reads the folder every few seconds while the tab is visible.
//
// Two views, chosen by the address: `#/` is every project and run, `#/run/<project
// key>/<run>` is one run's questions as cards. There is no server deciding
// anything here - this file reads the folder itself (data.js, File System
// Access API) and draws what it finds.
window.TFV = window.TFV || {};
(function () {
const { h, makeT, renderHome, renderRun } = window.TFV;

const REFRESH_MS = 4000;

const app = document.getElementById("app");
let t = (key) => key;
let view = null; // the function that redraws the current view
let root = null; // the granted FileSystemDirectoryHandle, once we have one
let refreshTimer = null;

const go = (hash) => {
  if (location.hash === hash) route();
  else location.hash = hash;
};

function showError(error) {
  app.replaceChildren(h("p", { class: "empty", role: "alert" }, t("app.error", { message: error.message })));
}

/** The data.js calls run.js needs, bound to the folder we were granted. Kept
 *  in one small object so run.js never touches File System Access itself. */
function dataFor(root) {
  return {
    loadRun: (project, slug) => window.TFV.loadRun(root, project, slug),
    loadDraft: window.TFV.loadDraft,
    saveDraft: window.TFV.saveDraft,
    submitAnswers: (loaded, answers) => window.TFV.submitAnswers(root, loaded, answers),
  };
}

async function route() {
  const match = /^#\/run\/([0-9a-f]{16})\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(decodeURIComponent(location.hash));
  if (match) {
    view = () => renderRun(app, { project: match[1], slug: match[2], t, go, data: dataFor(root) });
  } else {
    view = async () => renderHome(app, { projects: await window.TFV.loadHome(root), t, go });
  }
  try {
    await view();
  } catch (error) {
    showError(error);
  }
}

function startRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.visibilityState === "visible" && view) view().catch(showError);
  }, REFRESH_MS);
}

function showPicker({ retry = false } = {}) {
  const pickButton = h("button", { class: "btn", onclick: onPick }, t(retry ? "pick.retry" : "pick.button"));
  app.replaceChildren(
    h("h1", {}, t("app.title")),
    h("p", {}, t("pick.body")),
    h("p", { class: "muted" }, t("pick.hint")),
    retry ? h("p", { class: "empty", role: "alert" }, t("pick.denied")) : null,
    pickButton
  );
  async function onPick() {
    pickButton.disabled = true;
    try {
      root = await window.TFV.pickRoot();
      await afterGrant();
    } catch (error) {
      pickButton.disabled = false;
      if (error instanceof window.TFV.NotGrantedError || error.name === "AbortError") return;
      showError(error);
    }
  }
}

async function afterGrant() {
  window.addEventListener("hashchange", route);
  await route();
  startRefresh();
}

async function boot() {
  t = makeT(window.TFV_I18N_EN, "en");
  document.title = t("app.title");
  if (!("showDirectoryPicker" in window)) {
    app.replaceChildren(h("h1", {}, t("app.title")), h("p", { class: "empty", role: "alert" }, t("pick.unsupported")));
    return;
  }
  root = await window.TFV.savedRoot();
  if (root) {
    await afterGrant();
    return;
  }
  const remembered = await window.TFV.loadRootHandle();
  showPicker({ retry: Boolean(remembered) });
}

boot();
})();
