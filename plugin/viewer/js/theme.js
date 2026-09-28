// Sets the light or dark theme before the first paint, so a dark screen does not
// flash white. Loaded without `defer`, from <head>, as a plain script (not
// type="module" - those fail to load at all over file://, which is how this
// page is opened).
(function () {
  var choice = "system";
  try {
    choice = localStorage.getItem("task-flow-viewer:theme") || "system";
  } catch (e) {
    /* storage blocked: follow the system */
  }
  var dark = choice === "dark" || (choice === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
