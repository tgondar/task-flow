// Tiny DOM builder: h("div", { class: "x", onclick: fn }, child, "text"…). Text always goes through
// text nodes. From FluidPlan (see NOTICE.md), minus its `html` attribute: every text the viewer
// shows comes from a feed a repository fed, and there is no way left here to turn one into markup.
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
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    applyAttrs(el, attrs, false);
    append(el, children);
    return el;
  }

  function svg(tag, attrs = {}, ...children) {
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

  Object.assign(window.TFV, { h, svg });
})();
