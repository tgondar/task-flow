// Sets the light or dark theme before the first paint, so a dark screen does not
// flash white. A file of its own and not an inline script: the page's
// Content-Security-Policy allows scripts from this server only, and no inline
// script at all (server.mjs). Loaded without `defer`, from <head>.
(function () {
  var choice = "system";
  try {
    choice = localStorage.getItem("task-flow-panel:theme") || "system";
  } catch (e) {
    /* storage blocked: follow the system */
  }
  var dark = choice === "dark" || (choice === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
