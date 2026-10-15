// Minimal DOM builder: h("div", { class: "x", onclick: fn }, child, "text"...) creates an element,
// sets its attributes/listeners, and appends its children. Text arguments always become text
// nodes - there is no "html" escape hatch, because every string this viewer ever shows comes from
// a feed a repository fed, and nothing here should be able to turn one into markup.
//
// A plain script, not `type="module"`: Chrome and Edge refuse to load ES modules
// at all over file:// ("Cross origin requests are only supported for protocol
// schemes: http(s)..."), and this page is meant to be opened by double-clicking
// it, not served. So every file in this folder hangs its exports off one global,
// `window.TFV`, instead of using import/export - loaded in dependency order by
// plain <script src> tags, which file:// has always supported. Each file's body
// is its own IIFE: a top-level `const`/`function` in one classic <script> tag
// shares the page's global scope with every other one, so without this, two
// files naming the same local (both calling a parameter `h`, say) would collide.
window.TFV = window.TFV || {};
(function () {
  const SVG_NS = "http://www.w3.org/2000/svg";

  function setAttr(el, key, value, svgMode) {
    if (value === undefined || value === null || value === false) return;
    if (key === "class") {
      if (svgMode) el.setAttribute("class", value);
      else el.className = value;
      return;
    }
    if (key === "dataset") {
      for (const [dataKey, dataValue] of Object.entries(value)) el.dataset[dataKey] = dataValue;
      return;
    }
    if (key === "style" && value && typeof value === "object") {
      for (const [prop, propValue] of Object.entries(value)) el.style.setProperty(prop, propValue);
      return;
    }
    if (key.length > 2 && key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value);
      return;
    }
    if (value === true) {
      el.setAttribute(key, "");
      return;
    }
    el.setAttribute(key, String(value));
  }

  function appendChildren(el, children) {
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }

  function build(el, attrs, children, svgMode) {
    for (const key of Object.keys(attrs || {})) setAttr(el, key, attrs[key], svgMode);
    appendChildren(el, children);
    return el;
  }

  function h(tag, attrs, ...children) {
    return build(document.createElement(tag), attrs || {}, children, false);
  }

  function svg(tag, attrs, ...children) {
    return build(document.createElementNS(SVG_NS, tag), attrs || {}, children, true);
  }

  Object.assign(window.TFV, { h, svg });
})();
