// shadcn/ui components (https://ui.shadcn.com/docs/components), reimplemented as plain
// functions returning DOM nodes instead of React - same names and variants as the React
// library, so anyone used to it feels at home. The classes they set are defined in
// css/components.css.
window.TFV = window.TFV || {};
(function () {
const { h, icon } = window.TFV;

const classes = (...parts) => parts.filter(Boolean).join(" ");

function button(opts = {}) {
  const { label, icon: iconName, iconRight, variant = "default", size, title, onclick, type = "button", disabled, className, attrs = {} } = opts;
  const cls = classes("btn", variant !== "default" && `btn-${variant}`, size && `btn-${size}`, !label && iconName && "btn-icon", className);
  const children = [
    iconName ? icon(iconName) : null,
    label ? h("span", {}, label) : null,
    iconRight ? icon(iconRight) : null,
  ];
  return h("button", { type, class: cls, title, "aria-label": label ? undefined : title, disabled, onclick, ...attrs }, ...children);
}

function badge(text, opts = {}) {
  const { variant = "secondary", icon: iconName, title, className } = opts;
  return h("span", { class: classes("badge", `badge-${variant}`, className), title }, iconName ? icon(iconName) : null, text);
}

function alert(opts = {}) {
  const { variant = "default", icon: iconName = "info", title, description, actions, className } = opts;
  const role = variant === "destructive" ? "alert" : "status";
  return h("div", { class: classes("alert", variant !== "default" && `alert-${variant}`, className), role },
    icon(iconName),
    title ? h("div", { class: "alert-title" }, title) : null,
    description ? h("div", { class: "alert-description" }, description) : null,
    actions && actions.length ? h("div", { class: "alert-actions" }, actions) : null);
}

function card(opts = {}) {
  const { id, className, header, content, footer, attrs = {} } = opts;
  return h("section", { id, class: classes("card", className), ...attrs },
    header ? h("header", { class: "card-header" }, header) : null,
    content ? h("div", { class: "card-content" }, content) : null,
    footer ? h("footer", { class: "card-footer" }, footer) : null);
}

// Accessible tabs following the WAI-ARIA tabs pattern (left/right/Home/End move focus and
// selection together). Each panel renders once and is cached; switching tabs just swaps it in.
function tabs(opts = {}) {
  const { items, value, onChange, ariaLabel, className } = opts;
  const triggerOf = new Map();
  const panelCache = new Map();
  let activeId = value ?? items[0]?.id;

  const list = h("div", { class: "tabs-list", role: "tablist", "aria-label": ariaLabel });
  for (const item of items) {
    const trigger = h("button", {
      type: "button", class: "tabs-trigger", role: "tab", id: `tab-${item.id}`,
      "aria-selected": "false", tabindex: "-1",
      onclick: () => activate(item.id, true),
    }, item.icon ? icon(item.icon) : null, h("span", {}, item.label), item.count !== undefined ? h("span", { class: "count" }, String(item.count)) : null);
    triggerOf.set(item.id, trigger);
    list.append(trigger);
  }

  const panels = h("div", {});
  const hasPanels = items.some((item) => item.render);

  function moveFocus(direction) {
    const order = items.map((item) => item.id);
    const from = order.indexOf(activeId);
    const steps = { left: -1, right: 1, home: -from, end: order.length - 1 - from };
    const to = (from + steps[direction] + order.length) % order.length;
    activate(order[to], true);
    triggerOf.get(order[to]).focus();
  }
  list.addEventListener("keydown", (event) => {
    const key = { ArrowLeft: "left", ArrowRight: "right", Home: "home", End: "end" }[event.key];
    if (!key) return;
    event.preventDefault();
    moveFocus(key);
  });

  function activate(id, byUser) {
    activeId = id;
    for (const [itemId, trigger] of triggerOf) {
      const selected = itemId === id;
      trigger.setAttribute("aria-selected", String(selected));
      trigger.tabIndex = selected ? 0 : -1;
    }
    const item = items.find((entry) => entry.id === id);
    if (item && item.render) {
      if (!panelCache.has(id)) panelCache.set(id, h("div", { role: "tabpanel", "aria-labelledby": `tab-${id}` }, item.render()));
      panels.replaceChildren(panelCache.get(id));
    }
    if (byUser && onChange) onChange(id);
  }
  activate(activeId);

  const el = h("div", { class: classes("tabs", className) }, list, hasPanels ? panels : null);
  return {
    el,
    select: activate,
    get value() {
      return activeId;
    },
    setCount(id, count) {
      const target = triggerOf.get(id)?.querySelector(".count");
      if (target) target.textContent = String(count);
    },
  };
}

// A row of exclusive toggle buttons; clicking the active one clears the selection (null).
function toggleGroup(opts = {}) {
  const { items, get, onSelect, ariaLabel, compact = false, labels = true } = opts;
  const buttonOf = new Map();
  const el = h("div", { class: classes("toggle-group", compact && "compact"), role: "group", "aria-label": ariaLabel });

  for (const item of items) {
    const btn = h("button", {
      type: "button",
      class: classes("toggle", item.tone && `tone-${item.tone}`),
      "aria-pressed": "false",
      title: item.title ?? item.label,
      "aria-label": labels ? undefined : item.label,
      onclick: () => onSelect(get() === item.value ? null : item.value),
    }, item.icon ? icon(item.icon) : null, labels ? h("span", { class: "toggle-label" }, item.label) : null);
    buttonOf.set(item.value, btn);
    el.append(btn);
  }

  el.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    const order = [...buttonOf.values()];
    const from = order.indexOf(document.activeElement);
    if (from < 0) return;
    event.preventDefault();
    order[(from + step + order.length) % order.length].focus();
  });

  function refresh() {
    const current = get();
    for (const [value, btn] of buttonOf) btn.setAttribute("aria-pressed", String(value === current));
  }
  refresh();

  return {
    el,
    update: refresh,
    setDisabled(disabled) {
      for (const btn of buttonOf.values()) btn.disabled = disabled;
    },
  };
}

function selectBox(opts) {
  const { options, value, onChange, ariaLabel, placeholder } = opts;
  const select = h("select", { class: "select", "aria-label": ariaLabel, onchange: () => onChange(select.value) },
    placeholder ? h("option", { value: "" }, placeholder) : null,
    options.map((option) => h("option", { value: option.value }, option.label)));
  select.value = value ?? "";
  return { el: h("span", { class: "select-wrap" }, select, icon("chevrons-up-down")), select };
}

function progress(initialSegments) {
  const baseline = initialSegments.reduce((sum, segment) => sum + segment.value, 0) || 1;
  const el = h("div", { class: "progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" });
  function refresh(segments) {
    const filled = segments.reduce((sum, segment) => sum + segment.value, 0);
    const outOf = segments.reduce((sum, segment) => sum + (segment.total ?? 0), 0) || baseline;
    const bars = segments.filter((segment) => segment.tone)
      .map((segment) => h("span", { class: `seg-${segment.tone}`, style: { width: `${(segment.value / outOf) * 100}%` } }));
    el.replaceChildren(...bars);
    el.setAttribute("aria-valuenow", String(Math.round((filled / outOf) * 100)));
  }
  refresh(initialSegments);
  return { el, update: refresh };
}

function kbd(text) {
  return h("kbd", { class: "kbd" }, text);
}

function separator(vertical = false) {
  return h("div", { class: classes("separator", vertical && "vertical"), role: "separator" });
}

// --- Dialog and sheet: the native <dialog> element, which already handles focus and Escape ---

function dialog(opts = {}) {
  const { title, description, content, actions, closeLabel = "Close", onClose } = opts;
  const el = h("dialog", { class: "dialog", "aria-labelledby": "dialog-title" });
  const close = () => el.close();
  const inner = h("div", { class: "dialog-inner" },
    h("div", { class: "dialog-header" },
      h("h2", { class: "dialog-title", id: "dialog-title" }, title),
      description ? h("p", { class: "dialog-description" }, description) : null),
    content ?? null,
    actions ? h("div", { class: "dialog-footer" }, actions({ close })) : null);
  el.append(inner, button({ icon: "x", variant: "ghost", size: "sm", title: closeLabel, className: "dialog-close", onclick: close }));
  el.addEventListener("close", () => {
    if (onClose) onClose();
    el.remove();
  });
  el.addEventListener("click", (event) => {
    if (event.target === el) close();
  });
  document.body.append(el);
  el.showModal();
  return { el, close };
}

function sheet(opts = {}) {
  const { title, description, content, side = "left", closeLabel = "Close" } = opts;
  const body = h("div", { class: "sheet-body" });
  const el = h("dialog", { class: classes("sheet", side === "right" && "right"), "aria-label": title },
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

// --- Toast ---------------------------------------------------------------------------------

function toast(message, opts = {}) {
  const { title, variant = "default", duration = 3500 } = opts;
  let host = document.querySelector(".toaster");
  if (!host) {
    host = h("div", { class: "toaster", role: "status", "aria-live": "polite" });
    document.body.append(host);
  }
  const iconByVariant = { success: "circle-check", error: "circle-alert", info: "info", default: "info" };
  const el = h("div", { class: classes("toast", variant) },
    icon(iconByVariant[variant] ?? "info"),
    h("div", {}, title ? h("div", { class: "toast-title" }, title) : null, h("div", { class: title ? "toast-text" : "toast-title" }, message)),
    button({ icon: "x", variant: "ghost", size: "sm", title: "x", onclick: () => el.remove() }));
  host.append(el);
  setTimeout(() => el.remove(), duration);
  return el;
}

// --- Tooltip and hover card: one shared floating element, moved and refilled per call ------

let floatingEl = null;
let hideTimer = null;

const floating = {
  show(content, x, y, opts = {}) {
    const { variant = "tooltip" } = opts;
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

// Shows on hover and keyboard focus, placed above the target element.
function attachFloating(target, content, opts = {}) {
  const { variant = "tooltip" } = opts;
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

Object.assign(window.TFV, {
  button, badge, alert, card, tabs, toggleGroup, selectBox, progress, kbd, separator,
  dialog, sheet, toast, floating, attachFloating,
});
})();
