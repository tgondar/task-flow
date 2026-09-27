// Labels for the interface and the exports. Pure module: the page loads the dictionary with fetch,
// the server and the CLI from the file system; both get the same `t` function.
//   t("verdict.ok")                        → "Accepted"
//   t("home.decisions", { count: 3 })      → key "home.decisions_one" or "_other"
//   t("round.label", { n: 2 })             → "Round 2"

export const LANGS = ["fr", "en"];

export function makeT(dict, lang = "fr") {
  const t = (key, vars = {}) => {
    let template;
    if (vars.count !== undefined) template = dict[`${key}_${pluralForm(lang, vars.count)}`];
    template ??= dict[key];
    if (template === undefined) return key;
    return template.replace(/\{(\w+)\}/g, (match, name) => (vars[name] !== undefined ? String(vars[name]) : match));
  };
  t.lang = lang;
  t.has = (key) => Object.hasOwn(dict, key);
  return t;
}

// French uses the singular for 0 and 1, English only for 1.
function pluralForm(lang, n) {
  if (lang === "fr") return Math.abs(n) < 2 ? "one" : "other";
  return n === 1 ? "one" : "other";
}

export function formatNumber(value, lang) {
  return new Intl.NumberFormat(lang === "fr" ? "fr-FR" : "en-US").format(value);
}

// ISO day and local time, joined by the "export.dateTime" template: "2026-09-25 at 14:02".
export function formatDate(date, t) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return t("export.dateTime", { day, time });
}

export function formatTime(date, lang) {
  return new Date(date).toLocaleTimeString(lang === "fr" ? "fr-FR" : "en-US", { hour: "2-digit", minute: "2-digit" });
}
