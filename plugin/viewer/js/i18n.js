// Labels for the interface. The dictionary itself lives in i18n-en.js as a plain
// object (`fetch` of a local file is blocked over file://, same reason every
// module here is a plain script - see dom.js), and every label goes through the
// same `t` function.
//   t("verdict.ok")                        -> "Accepted"
//   t("home.decisions", { count: 3 })      -> key "home.decisions_one" or "_other"
//   t("round.label", { n: 2 })             -> "Round 2"
window.TFV = window.TFV || {};
(function () {
  const LANGS = ["en"];

  // French keeps the singular form for 0 and 1; every other supported language
  // (today: English) only for 1.
  function pluralForm(lang, count) {
    if (lang === "fr") return Math.abs(count) < 2 ? "one" : "other";
    return count === 1 ? "one" : "other";
  }

  function interpolate(template, vars) {
    return template.replace(/\{(\w+)\}/g, (whole, name) => (vars[name] !== undefined ? String(vars[name]) : whole));
  }

  function makeT(dict, lang = "en") {
    function t(key, vars = {}) {
      const pluralKey = vars.count !== undefined ? `${key}_${pluralForm(lang, vars.count)}` : undefined;
      const template = (pluralKey !== undefined ? dict[pluralKey] : undefined) ?? dict[key];
      return template === undefined ? key : interpolate(template, vars);
    }
    t.lang = lang;
    t.has = (key) => Object.hasOwn(dict, key);
    return t;
  }

  function formatNumber(value, lang) {
    return new Intl.NumberFormat(lang === "fr" ? "fr-FR" : "en-US").format(value);
  }

  function formatTime(date, lang) {
    return new Date(date).toLocaleTimeString(lang === "fr" ? "fr-FR" : "en-US", { hour: "2-digit", minute: "2-digit" });
  }

  // ISO day plus local time, joined by the "export.dateTime" template: "2026-09-25 at 14:02".
  function formatDate(date, t) {
    const parsed = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(parsed.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    const day = `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
    const time = `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
    return t("export.dateTime", { day, time });
  }

  Object.assign(window.TFV, { LANGS, makeT, formatNumber, formatDate, formatTime });
})();
