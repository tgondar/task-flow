// Tiny DOM builder: h("div", { class: "x", onclick: fn }, child, "text"…). Text always goes through
// text nodes; only `html` injects HTML, and it is only ever given the output of md.js, which
// escapes everything.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  applyAttrs(el, attrs, false);
  append(el, children);
  return el;
}

export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  applyAttrs(el, attrs, true);
  append(el, children);
  return el;
}

function applyAttrs(el, attrs, isSvg) {
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") {
      if (isSvg) el.setAttribute("class", value);
      else el.className = value;
    } else if (key === "html") {
      el.innerHTML = value;
    } else if (key === "dataset") {
      Object.assign(el.dataset, value);
    } else if (key === "style" && typeof value === "object") {
      for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, v);
    } else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}
