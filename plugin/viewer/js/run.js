// One run's questions as cards, and the "Send to agent" button.
//
// The card is the panel's own - FluidPlan's decision card drags in its rounds,
// visuals and glossary - but it is built from the same components and styles
// (ui.js, components.css) and keeps FluidPlan's four answers: OK, Not OK, Change,
// Explain. A decision the agent took can be accepted, rejected or changed; an
// open question is answered by picking one of its options or in words; "Explain"
// asks the agent to say more and leaves the question open.
//
// What is typed is kept two ways, so nothing is lost: in memory across redraws
// (the folder can be re-read while the user types) and as a draft in this
// browser (localStorage, data.js) - once sent, as a submission file task-flow
// takes in at its next step (answers.js consume). The page never talks to the
// run: it cannot, and that is the point.
//
// All text from the run enters the page as text nodes (dom.js h), never as HTML.
window.TFV = window.TFV || {};
(function () {
const { h, icon, badge, button, dialog, toast, toggleGroup, ago } = window.TFV;

const STATUS_ICONS = { ok: "check", ko: "x", modify: "pencil", explain: "circle-help" };

/** Answers being typed, per run, kept across redraws of the page. */
const working = new Map();
/** Question ids already sent from this page in this visit. */
const sentIds = new Map();

/** Is this answer something task-flow will take? The same rules as
 *  feed-logic.js checkOutgoingAnswers, so the button never offers a send that
 *  would be refused. */
function isComplete(card, answer) {
  if (!answer || !answer.status) return false;
  const comment = String(answer.comment ?? "").trim();
  if (answer.status === "explain") return comment !== "";
  if (answer.status === "modify") return comment !== "" || !!answer.choice;
  if (answer.status === "ok" && card.kind === "question" && card.options.length) return !!answer.choice;
  return true;
}

function statusBadge(run, t) {
  const variants = { running: "info", blocked: "warning", failed: "danger", done: "secondary", paused: "outline" };
  return badge(t(`status.${run.status}`), { variant: variants[run.status] ?? "outline" });
}

function answerSummary(card, t) {
  const answer = card.answer;
  const parts = [t(`answer.status.${answer.status}`)];
  if (answer.choice) {
    const option = card.options.find((o) => o.id === answer.choice);
    parts.push(option ? option.label : answer.choice);
  }
  if (answer.comment) parts.push(answer.comment);
  return parts.join(" — ");
}

function renderCard(card, ctx) {
  const { t, answers, save, locked } = ctx;
  const get = () => answers[card.id] ?? {};
  const set = (patch) => {
    answers[card.id] = { ...get(), ...patch };
    save();
    update();
  };

  const tags = [
    card.urgent ? badge(t("card.urgent"), { variant: "danger" }) : null,
    badge(t(card.kind === "decision" ? "card.decision" : "card.question"), { variant: "outline" }),
    card.task ? badge(card.task, { variant: "secondary", className: "badge-mono" }) : null,
    card.phase ? badge(card.phase, { variant: "secondary" }) : null,
  ];

  const text = [];
  if (card.kind === "decision" && card.chosen) text.push(h("p", {}, h("strong", {}, t("card.chose")), " ", card.chosen));
  if (card.why) text.push(h("p", {}, h("strong", {}, t("card.why")), " ", card.why));
  if (card.ifOverruled) text.push(h("p", { class: "muted" }, h("strong", {}, t("card.ifOverruled")), " ", card.ifOverruled));
  const body = [];
  for (const request of card.explanations) {
    body.push(
      h("div", { class: "card-note" }, icon("circle-help"), h("div", {}, h("p", {}, t("card.askedExplain"), " ", request.comment), request.reply ? h("p", {}, h("strong", {}, t("card.reply")), " ", request.reply) : h("p", { class: "muted" }, t("card.noReplyYet"))))
    );
  }

  // Options as radio cards: picking one answers the question (or, for a decision,
  // picks a different option than the agent's - a change).
  let radios = [];
  if (card.options.length) {
    const name = `options-${card.id}`;
    radios = card.options.map((option) => {
      const input = h("input", {
        type: "radio",
        name,
        value: option.id,
        onchange: () => {
          if (card.kind === "decision") set({ choice: option.id, status: option.recommended ? "ok" : "modify" });
          else set({ choice: option.id, status: get().status && get().status !== "ko" ? get().status : "ok" });
        },
      });
      return {
        option,
        input,
        el: h(
          "label",
          { class: "radio-card" },
          input,
          h("span", { class: "rc-title" }, option.label, option.recommended ? badge(t(card.kind === "decision" ? "card.agentChoice" : "card.recommended"), { variant: "secondary" }) : null),
          option.detail ? h("span", { class: "rc-body" }, option.detail) : null
        ),
      };
    });
    body.push(h("div", { class: "radio-cards", role: "radiogroup", "aria-label": card.title }, radios.map((r) => r.el)));
  }

  const kinds = ["ok", "ko", "modify", "explain"];
  const group = toggleGroup({
    items: kinds.map((kind) => ({ value: kind, label: t(`action.${card.kind}.${kind}`), title: t(`action.${kind}.hint`), icon: STATUS_ICONS[kind], tone: kind })),
    get: () => get().status ?? null,
    onSelect: (value) => {
      set({ status: value });
      if (value === "modify" || value === "explain") comment.focus();
    },
    ariaLabel: t("card.answer"),
  });
  const comment = h("textarea", { class: "textarea comment", rows: 2, maxlength: 4000, "aria-label": t("card.comment") });
  comment.addEventListener("input", () => {
    answers[card.id] = { ...get(), comment: comment.value };
    save();
    updateHint();
  });
  const hint = h("p", { class: "field-hint" });

  const sent = sentIds.get(ctx.key)?.has(card.id);
  const el = h(
    "section",
    { class: `card question-card${card.urgent ? " urgent" : ""}`, dataset: { question: card.id } },
    h("header", { class: "card-header" }, h("div", { class: "card-tags" }, tags), h("h2", { class: "card-title" }, card.title)),
    h("div", { class: "card-content" }, h("div", { class: "question-text" }, text), body, sent ? h("p", { class: "sent-note" }, icon("send"), t("card.sent")) : h("div", { class: "answer" }, group.el, comment, hint))
  );

  function updateHint() {
    const answer = get();
    const text = String(answer.comment ?? "").trim();
    let message = "";
    if (answer.status === "explain" && !text) message = t("hint.explain");
    else if (answer.status === "modify" && !text && !answer.choice) message = t("hint.modify");
    else if (answer.status === "ok" && card.kind === "question" && card.options.length && !answer.choice) message = t("hint.pick");
    hint.textContent = message;
    hint.hidden = !message;
    comment.placeholder = t(`placeholder.${answer.status || "none"}`);
    ctx.refresh();
  }
  function update() {
    const answer = get();
    group.update();
    group.setDisabled(locked());
    comment.disabled = locked();
    if (document.activeElement !== comment && comment.value !== String(answer.comment ?? "")) comment.value = String(answer.comment ?? "");
    for (const radio of radios) {
      radio.input.checked = answer.choice ? answer.choice === radio.option.id : false;
      radio.input.disabled = locked();
    }
    updateHint();
  }
  update();
  return el;
}

function answeredCard(card, t) {
  return h(
    "li",
    { class: "answered", dataset: { question: card.id } },
    icon("check"),
    h("div", {}, h("strong", {}, card.title), h("p", { class: "muted" }, t("answer.line", { via: t(`answer.via.${card.answer.via}`), when: ago(card.answer.at, t) }), " ", answerSummary(card, t)))
  );
}

async function renderRun(app, { project, slug, t, go, data }) {
  const key = `${project}/${slug}`;
  const loaded = await data.loadRun(project, slug);
  if (!loaded) {
    app.replaceChildren(h("p", { class: "empty", role: "alert" }, t("run.notFound")));
    return;
  }
  const { run, cards } = loaded;

  // Answers being typed survive a redraw; the saved draft fills in on the first
  // visit. A question that closed meanwhile (answered in the conversation) loses
  // its working answer, and so does one task-flow took in.
  if (!working.has(key)) working.set(key, data.loadDraft(project, slug));
  const answers = working.get(key);
  const open = cards.filter((card) => card.open);
  const openIds = new Set(open.map((card) => card.id));
  for (const id of Object.keys(answers)) if (!openIds.has(id)) delete answers[id];
  const sent = sentIds.get(key);
  if (sent) for (const id of [...sent]) if (!openIds.has(id)) sent.delete(id);

  let sending = false;
  const save = () => data.saveDraft(project, slug, answers);

  const ready = () => open.filter((card) => !sentIds.get(key)?.has(card.id) && isComplete(card, answers[card.id]));
  const sendButton = button({ label: t("send.button"), icon: "send", onclick: () => confirmSend() });
  const readyText = h("span", { class: "muted" });
  const refresh = () => {
    const count = ready().length;
    sendButton.disabled = sending || count === 0;
    readyText.textContent = t("send.ready", { count });
  };
  const ctx = { t, answers, save, key, refresh, locked: () => sending };

  function confirmSend() {
    const chosen = ready();
    if (!chosen.length) return;
    dialog({
      title: t("send.confirmTitle", { count: chosen.length }),
      description: t("send.confirmBody"),
      closeLabel: t("send.cancel"),
      content: h("ul", { class: "send-list" }, chosen.map((card) => h("li", {}, h("strong", {}, card.title), " — ", t(`answer.status.${answers[card.id].status}`)))),
      actions: ({ close }) => [
        button({ label: t("send.cancel"), variant: "outline", onclick: close }),
        button({
          label: t("send.confirm"),
          icon: "send",
          onclick: async (event) => {
            event.currentTarget.disabled = true;
            sending = true;
            refresh();
            try {
              const payload = chosen.map((card) => {
                const answer = answers[card.id];
                const item = { questionId: card.id, status: answer.status };
                if (answer.choice) item.choice = answer.choice;
                const comment = String(answer.comment ?? "").trim();
                if (comment) item.comment = comment;
                return item;
              });
              await data.submitAnswers(loaded, payload);
              if (!sentIds.has(key)) sentIds.set(key, new Set());
              for (const card of chosen) {
                sentIds.get(key).add(card.id);
                delete answers[card.id];
              }
              close();
              toast(t("send.done"), { variant: "success" });
            } catch (error) {
              close();
              toast(error.message, { title: t("send.failed"), variant: "error", duration: 8000 });
            } finally {
              sending = false;
              draw();
            }
          },
        }),
      ],
    });
  }

  function draw() {
    const answered = cards.filter((card) => !card.open);
    const header = h(
      "header",
      { class: "panel-header" },
      h(
        "div",
        {},
        button({ label: t("run.back"), icon: "chevron-left", variant: "link", size: "sm", onclick: () => go("#/") }),
        h("h1", { class: "run-heading" }, run.slug),
        h("p", {}, loaded.project.projectName, " · ", statusBadge(run, t), run.updated ? ` · ${t("run.updated", { ago: ago(run.updated, t) })}` : "")
      )
    );
    const body = [];
    if (run.questions.source !== "json") body.push(h("p", { class: "empty" }, t("run.legacyBody")));
    else if (!open.length) body.push(h("p", { class: "empty" }, t("run.nothingOpen")));
    else body.push(h("div", { class: "cards" }, open.map((card) => renderCard(card, ctx))));
    if (answered.length) body.push(h("section", { class: "answered-list" }, h("h2", {}, t("run.answered", { count: answered.length })), h("ul", {}, answered.map((card) => answeredCard(card, t)))));
    const footer = open.length ? h("footer", { class: "send-bar" }, readyText, sendButton) : null;
    app.replaceChildren(header, ...body, footer);
    refresh();
  }
  draw();
}

Object.assign(window.TFV, { isComplete, renderRun });
})();
