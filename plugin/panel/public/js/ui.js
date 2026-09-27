// shadcn/ui components as functions: each returns DOM with the classes from css/components.css.
// Same names and same variants as the React library, so anyone used to it feels at home.
import { h } from "./dom.js";
import { icon } from "./icons.js";

const cx = (...parts) => parts.filter(Boolean).join(" ");

export function button({ label, icon: name, iconRight, variant = "default", size, title, onclick, type = "button", disabled, className, attrs = {} } = {}) {
  const cls = cx("btn", variant !== "default" && `btn-${variant}`, size && `btn-${size}`, !label && name && "btn-icon", className);
  return h("button", { type, class: cls, title, "aria-label": label ? undefined : title, disabled, onclick, ...attrs },
    name ? icon(name) : null,
    label ? h("span", {}, label) : null,
    iconRight ? icon(iconRight) : null);
}

export function badge(text, { variant = "secondary", icon: name, title, className } = {}) {
  return h("span", { class: cx("badge", `badge-${variant}`, className), title }, name ? icon(name) : null, text);
}

export function alert({ variant = "default", icon: name = "info", title, description, actions, className } = {}) {
  const role = variant === "destructive" ? "alert" : "status";
  return h("div", { class: cx("alert", variant !== "default" && `alert-${variant}`, className), role },
    icon(name),
    title ? h("div", { class: "alert-title" }, title) : null,
    description ? h("div", { class: "alert-description" }, description) : null,
    actions?.length ? h("div", { class: "alert-actions" }, actions) : null);
}

export function card({ id, className, header, content, footer, attrs = {} } = {}) {
  return h("section", { id, class: cx("card", className), ...attrs },
    header ? h("header", { class: "card-header" }, header) : null,
    content ? h("div", { class: "card-content" }, content) : null,
    footer ? h("footer", { class: "card-footer" }, footer) : null);
}

// details / summary: opens on click, closed by default; `content` can be a function, rendered
// on first opening only.
export function accordion({ label, icon: name, content, open = false, className, right } = {}) {
  const body = h("div", { class: "accordion-content" });
  let rendered = false;
  const fill = () => {
    if (rendered) return;
    rendered = true;
    body.append(typeof content === "function" ? content() : content);
  };
  const el = h("details", { class: cx("accordion", className), open },
    h("summary", {}, h("span", { class: "accordion-label" }, name ? icon(name) : null, label, right ?? null), icon("chevron-down", { className: "chevron" })),
    body);
  // A node that is already built goes into the DOM right away (anchors must find it); only a
  // function waits for the first opening.
  if (open || typeof content !== "function") fill();
  el.addEventListener("toggle", () => el.open && fill());
  return el;
}

// Accessible tabs (left / right arrows). Panels are rendered once; `update` refreshes them if the
// caller needs it.
export function tabs({ items, value, onChange, ariaLabel, className } = {}) {
  const list = h("div", { class: "tabs-list", role: "tablist", "aria-label": ariaLabel });
  const panels = h("div", {});
  const triggers = new Map();
  const cache = new Map();
  let current = value ?? items[0]?.id;
  for (const item of items) {
    const trigger = h("button", { type: "button", class: "tabs-trigger", role: "tab", id: `tab-${item.id}`, "aria-selected": "false", tabindex: "-1", onclick: () => select(item.id, true) },
      item.icon ? icon(item.icon) : null, h("span", {}, item.label), item.count !== undefined ? h("span", { class: "count" }, String(item.count)) : null);
    triggers.set(item.id, trigger);
    list.append(trigger);
  }
  list.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const ids = items.map((i) => i.id);
    let index = ids.indexOf(current);
    if (event.key === "ArrowLeft") index = (index - 1 + ids.length) % ids.length;
    if (event.key === "ArrowRight") index = (index + 1) % ids.length;
    if (event.key === "Home") index = 0;
    if (event.key === "End") index = ids.length - 1;
    select(ids[index], true);
    triggers.get(ids[index]).focus();
  });
  function select(id, fromUser = false) {
    current = id;
    for (const [key, trigger] of triggers) {
      const on = key === id;
      trigger.setAttribute("aria-selected", String(on));
      trigger.tabIndex = on ? 0 : -1;
    }
    const item = items.find((i) => i.id === id);
    if (item?.render) {
      if (!cache.has(id)) cache.set(id, h("div", { role: "tabpanel", "aria-labelledby": `tab-${id}` }, item.render()));
      panels.replaceChildren(cache.get(id));
    }
    if (fromUser) onChange?.(id);
  }
  select(current);
  const el = h("div", { class: cx("tabs", className) }, list, items.some((i) => i.render) ? panels : null);
  return {
    el,
    select,
    get value() {
      return current;
    },
    setCount(id, count) {
      const target = triggers.get(id)?.querySelector(".count");
      if (target) target.textContent = String(count);
    },
  };
}

// Group of exclusive toggles; pressing again clears the value (null).
export function toggleGroup({ items, get, onSelect, ariaLabel, compact = false, labels = true } = {}) {
  const buttons = new Map();
  const el = h("div", { class: cx("toggle-group", compact && "compact"), role: "group", "aria-label": ariaLabel });
  for (const item of items) {
    const b = h("button", {
      type: "button",
      class: cx("toggle", item.tone && `tone-${item.tone}`),
      "aria-pressed": "false",
      title: item.title ?? item.label,
      "aria-label": labels ? undefined : item.label,
      onclick: () => onSelect(get() === item.value ? null : item.value),
    }, item.icon ? icon(item.icon) : null, labels ? h("span", { class: "toggle-label" }, item.label) : null);
    buttons.set(item.value, b);
    el.append(b);
  }
  el.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const list = [...buttons.values()];
    const index = list.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    list[(index + (event.key === "ArrowRight" ? 1 : list.length - 1)) % list.length].focus();
  });
  function update() {
    const value = get();
    for (const [key, b] of buttons) b.setAttribute("aria-pressed", String(key === value));
  }
  update();
  return {
    el,
    update,
    setDisabled(disabled) {
      for (const b of buttons.values()) b.disabled = disabled;
    },
  };
}

export function selectBox({ options, value, onChange, ariaLabel, placeholder }) {
  const select = h("select", { class: "select", "aria-label": ariaLabel, onchange: () => onChange(select.value) },
    placeholder ? h("option", { value: "" }, placeholder) : null,
    options.map((o) => h("option", { value: o.value }, o.label)));
  select.value = value ?? "";
  return { el: h("span", { class: "select-wrap" }, select, icon("chevrons-up-down")), select };
}

export function progress(segments) {
  const total = segments.reduce((sum, s) => sum + s.value, 0) || 1;
  const el = h("div", { class: "progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" });
  const update = (list) => {
    const sum = list.reduce((n, s) => n + s.value, 0);
    const all = list.reduce((n, s) => n + (s.total ?? 0), 0) || total;
    el.replaceChildren(...list.filter((s) => s.tone).map((s) => h("span", { class: `seg-${s.tone}`, style: { width: `${(s.value / all) * 100}%` } })));
    el.setAttribute("aria-valuenow", String(Math.round((sum / all) * 100)));
  };
  update(segments);
  return { el, update };
}

export function kbd(text) {
  return h("kbd", { class: "kbd" }, text);
}

export function separator(vertical = false) {
  return h("div", { class: cx("separator", vertical && "vertical"), role: "separator" });
}

// --- Dialog and sheet: native <dialog>, which handles focus and the Escape key ----------------------

export function dialog({ title, description, content, actions, closeLabel = "Fermer", onClose } = {}) {
  const el = h("dialog", { class: "dialog", "aria-labelledby": "dialog-title" });
  const close = () => el.close();
  const inner = h("div", { class: "dialog-inner" },
    h("div", { class: "dialog-header" }, h("h2", { class: "dialog-title", id: "dialog-title" }, title), description ? h("p", { class: "dialog-description" }, description) : null),
    content ?? null,
    actions ? h("div", { class: "dialog-footer" }, actions({ close })) : null);
  el.append(inner, button({ icon: "x", variant: "ghost", size: "sm", title: closeLabel, className: "dialog-close", onclick: close }));
  el.addEventListener("close", () => {
    onClose?.();
    el.remove();
  });
  el.addEventListener("click", (event) => {
    if (event.target === el) close();
  });
  document.body.append(el);
  el.showModal();
  return { el, close };
}

export function sheet({ title, description, content, side = "left", closeLabel = "Fermer" } = {}) {
  const body = h("div", { class: "sheet-body" });
  const el = h("dialog", { class: cx("sheet", side === "right" && "right"), "aria-label": title },
    h("div", { class: "sheet-inner" },
      h("div", { class: "sheet-header" },
        h("div", { class: "sheet-title" }, title),
        description ? h("div", { class: "sheet-description" }, description) : null,
        button({ icon: "x", variant: "ghost", size: "sm", title: closeLabel, className: "dialog-close", onclick: () => el.close() })),
      body));
  el.addEventListener("click", (event) => {
    if (event.target === el) el.close();
  });
  document.body.append(el);
  return {
    el,
    open(node) {
      body.replaceChildren(node ?? (typeof content === "function" ? content() : content));
      el.showModal();
    },
    close: () => el.close(),
  };
}

// --- Toast -------------------------------------------------------------------------------------------

export function toast(message, { title, variant = "default", duration = 3500 } = {}) {
  let host = document.querySelector(".toaster");
  if (!host) {
    host = h("div", { class: "toaster", role: "status", "aria-live": "polite" });
    document.body.append(host);
  }
  const names = { success: "circle-check", error: "circle-alert", info: "info", default: "info" };
  const el = h("div", { class: cx("toast", variant) },
    icon(names[variant] ?? "info"),
    h("div", {}, title ? h("div", { class: "toast-title" }, title) : null, h("div", { class: title ? "toast-text" : "toast-title" }, message)),
    button({ icon: "x", variant: "ghost", size: "sm", title: "×", onclick: () => el.remove() }));
  host.append(el);
  setTimeout(() => el.remove(), duration);
  return el;
}

// --- Tooltip and hover card: a single shared floating element -------------------------------------------

let floatingEl = null;
let hideTimer = null;

export const floating = {
  show(content, x, y, { variant = "tooltip" } = {}) {
    clearTimeout(hideTimer);
    if (!floatingEl) {
      floatingEl = h("div", { class: "floating", role: "tooltip" });
      floatingEl.addEventListener("pointerenter", () => clearTimeout(hideTimer));
      floatingEl.addEventListener("pointerleave", () => floating.hide());
      document.body.append(floatingEl);
    }
    floatingEl.className = `floating ${variant}`;
    floatingEl.replaceChildren(content);
    floatingEl.hidden = false;
    const rect = floatingEl.getBoundingClientRect();
    const left = Math.min(Math.max(8, x - rect.width / 2), window.innerWidth - rect.width - 8);
    const above = y - rect.height - 10;
    floatingEl.style.left = `${left}px`;
    floatingEl.style.top = `${above < 8 ? y + 26 : above}px`;
  },
  hide(delay = 0) {
    clearTimeout(hideTimer);
    const run = () => {
      if (floatingEl) floatingEl.hidden = true;
    };
    if (delay) hideTimer = setTimeout(run, delay);
    else run();
  },
};

// Tooltip on hover and keyboard focus, placed above the element.
export function attachFloating(target, content, { variant = "tooltip" } = {}) {
  const show = () => {
    const rect = target.getBoundingClientRect();
    floating.show(typeof content === "function" ? content() : content, rect.left + rect.width / 2, rect.top, { variant });
  };
  target.addEventListener("pointerenter", show);
  target.addEventListener("focus", show);
  target.addEventListener("pointerleave", () => floating.hide(variant === "hover-card" ? 150 : 0));
  target.addEventListener("blur", () => floating.hide());
  target.addEventListener("keydown", (event) => {
    if (event.key === "Escape") floating.hide();
  });
  return target;
}
