// Messages and the conversation view.
//
// Opening a message opens the whole thread, both directions — a single message
// with no conversation around it was the ledger's central failure. Filters are
// pushed upstream rather than applied to a fetched page, because trimming a page
// in the browser starts lying the moment the page cuts off.

import { esc, icon, num, plural, chan, chanChip, fmtTime, fmtDay,
         decodeStored, humanOutcome } from "./fmt.js";
import { getJson, skeleton } from "./data.js";
import { go } from "./router.js";

const FILTERS = [
  ["channel", "Channel", [["", "any"], ["email", "Email"], ["sms", "SMS"]]],
  ["direction", "Direction", [["", "any"], ["outbound", "From us"], ["inbound", "From them"]]],
  ["replied", "Replied", [["", "any"], ["true", "got a reply"], ["false", "no reply"]]],
];
const PASSTHRU = ["variant_key", "experiment_key", "source_key", "recipient_id", "to"];

/**
 * Time window presets.
 *
 * `from` is a real upstream filter, so narrowing happens in SQL. Trimming a
 * fetched page in the browser instead would silently lie the moment the page
 * cut off — the same trap the variant and reply filters were pushed upstream
 * to avoid.
 */
const isoDay = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const RANGES = [["", "any time"], [isoDay(0), "today"], [isoDay(6), "last 7 days"], [isoDay(29), "last 30 days"]];

async function viewMessages(view, route) {
  const p = route.params;
  const qs = new URLSearchParams();
  for (const k of [...FILTERS.map(([f]) => f), ...PASSTHRU, "from"]) {
    const v = p.get(k); if (v) qs.set(k, v);
  }
  const applied = new URLSearchParams(qs);
  qs.set("limit", "100");

  view.innerHTML = skeleton(220);
  const body = await getJson(`/api/ledger/messages?${qs}`);
  const rows = body?.messages ?? [];

  const navTo = (next) => {
    next.delete("limit");
    return `#/messages${next.toString() ? `?${next}` : ""}`;
  };

  view.innerHTML = `
    <div class="page-head">
      <h2>Messages</h2>
      <p>Click any row to read the whole conversation, both sides.</p>
    </div>

    <div class="filters">
      ${FILTERS.map(([key, label, opts]) => `
        <label class="field"><span>${esc(label)}</span>
          <select data-filter="${key}">
            ${opts.map(([val, text]) =>
              `<option value="${esc(val)}"${(p.get(key) ?? "") === val ? " selected" : ""}>${esc(text)}</option>`).join("")}
          </select></label>`).join("")}
      <label class="field"><span>Window</span>
        <select data-filter="from">
          ${RANGES.map(([val, text]) =>
            `<option value="${esc(val)}"${(p.get("from") ?? "") === val ? " selected" : ""}>${esc(text)}</option>`).join("")}
          ${p.get("from") && !RANGES.some(([v]) => v === p.get("from"))
            ? `<option value="${esc(p.get("from"))}" selected>from ${esc(p.get("from"))}</option>` : ""}
        </select></label>
      ${PASSTHRU.filter((k) => p.get(k)).map((k) => `
        <span class="filter-pill" title="${esc(p.get(k))}">
          ${esc(k.replace(/_/g, " "))}: ${esc(pillLabel(k, p.get(k), rows))}
          <button data-clear="${esc(k)}" aria-label="Remove filter">×</button></span>`).join("")}
      ${[...applied.keys()].length ? `<button class="btn ghost tiny" data-href="#/messages">Clear all</button>` : ""}
      <span class="spacer"></span>
      <span class="tiny muted">${rows.length ? `${plural(rows.length, "message")}` : ""}</span>
    </div>

    ${body?.ok === false ? `<div class="banner">${icon("alert")} ${esc(body.error ?? "ledger unavailable")}</div>` : ""}

    <div class="card"><div class="card-body tight scroll-x">
      ${rows.length ? `<table class="grid"><thead><tr>
        <th>Time</th><th>Channel</th><th>Arm</th><th>Source</th>
        <th class="num">Events</th><th>Signals</th><th>Outcome</th><th></th>
      </tr></thead><tbody>${withDayRows(rows)}</tbody></table>`
      : `<div class="empty">${icon("chat", 28)}<div>No messages match these filters.</div></div>`}
    </div></div>

    ${rows.length ? `<p class="tiny muted foot">
      Newest first${body?.next ? " — narrow the filters to reach further back" : ""}.
      Signals come from the event feed; an empty cell means nothing was recorded, not that nothing happened.</p>` : ""}`;

  for (const sel of view.querySelectorAll("select[data-filter]")) {
    sel.onchange = () => {
      const next = new URLSearchParams(qs);
      if (sel.value) next.set(sel.dataset.filter, sel.value); else next.delete(sel.dataset.filter);
      go(navTo(next));
    };
  }
  for (const b of view.querySelectorAll("button[data-clear]")) {
    b.onclick = () => { const next = new URLSearchParams(qs); next.delete(b.dataset.clear); go(navTo(next)); };
  }
}

/** Show the readable arm name in a filter pill when the rows can supply one. */
function pillLabel(key, value, rows) {
  if (key === "variant_key") {
    const hit = rows.find((r) => r.variant_key === value);
    if (hit?.short_variant) return hit.short_variant;
  }
  return value;
}

/** Insert a day header ahead of the first row of each calendar day. */
function withDayRows(rows) {
  let last = "";
  return rows.map((m) => {
    const day = fmtDay(m.sent_at ?? m.received_at ?? m.ingested_at);
    const head = day === last ? "" :
      `<tr class="dayrow"><td colspan="8">${esc(day)}</td></tr>`;
    last = day;
    return head + msgRow(m);
  }).join("");
}

function msgRow(m) {
  const when = m.sent_at ?? m.received_at ?? m.ingested_at;
  const signals = [
    m.has_replied && `<span class="chip ok">${icon("reply", 11)} replied</span>`,
    m.has_clicked && `<span class="chip info">clicked</span>`,
    m.has_bounced && `<span class="chip bad">bounced</span>`,
    m.has_opened && !m.has_clicked && !m.has_replied && `<span class="chip">opened</span>`,
  ].filter(Boolean).join(" ");
  const st = m.attainment_status;
  const outcomeName = m.attainment_outcome_type ? humanOutcome(m.attainment_outcome_type) : "outcome";
  const outcome = !st ? `<span class="tiny muted">—</span>`
    : st === "attained" ? `<span class="chip ok" title="${esc(outcomeName)}">${icon("check", 11)} ${esc(outcomeName)}</span>`
    : st === "failed"   ? `<span class="chip bad" title="${esc(outcomeName)}">${esc(outcomeName)} missed</span>`
    : `<span class="tiny muted" title="${esc(outcomeName)} not decided yet">pending</span>`;
  return `<tr class="clickable" tabindex="0" data-href="#/thread/${esc(m.communication_id)}">
    <td class="nowrap">${esc(fmtTime(when))}</td>
    <td>${chanChip(m.channel)}</td>
    <td>${m.variant_key
      ? `<span class="chip mono" title="${esc(m.variant_key)}">${esc(m.short_variant ?? m.variant_key)}</span>`
      : `<span class="tiny muted">untagged</span>`}</td>
    <td><span class="tiny">${esc(m.source_key ?? "—")}</span>
        ${m.direction === "inbound"
          ? ` <span class="chip info">${icon("reply", 11)} from them</span>` : ""}</td>
    <td class="num">${num(m.n_events)}</td>
    <td>${signals || `<span class="tiny muted">none</span>`}</td>
    <td>${outcome}</td>
    <td class="muted">${icon("chev", 14)}</td>
  </tr>`;
}

// -------------------------------------------------------------------- thread
async function viewThread(view, route) {
  view.innerHTML = skeleton(200);
  const body = await getJson(`/api/ledger/thread/${encodeURIComponent(route.arg ?? "")}`);
  if (body?.ok !== true) {
    view.innerHTML = `${crumbs()}<div class="banner">${icon("alert")}
      ${esc(body?.error ?? "conversation unavailable")}</div>`;
    return;
  }
  const msgs = body.messages ?? [];
  const anchor = msgs.find((m) => m.communication_id === body.anchor_id) ?? msgs[0] ?? {};
  const ch = chan(anchor.channel);
  const out = msgs.filter((m) => m.direction === "outbound").length;
  const inb = msgs.length - out;

  let lastDay = "";
  const bubbles = msgs.map((m) => {
    const when = m.sent_at ?? m.received_at ?? m.ingested_at;
    const day = fmtDay(when);
    const sep = day !== lastDay ? `<div class="thread-day">${esc(day)}</div>` : "";
    lastDay = day;
    const isOut = m.direction === "outbound";
    // A send with no captured body is a real gap and should say so, rather than
    // rendering as an empty bubble that looks like a delivery failure.
    const text = m.body_redacted ? "[body erased on request]"
      : decodeStored(m.body_text || m.body_snippet || "")
        || (m.has_body ? "" : "[no content captured for this send]");
    const missing = !m.body_redacted && !m.body_text && !m.body_snippet;
    return `${sep}<div class="bubble-row ${isOut ? "out" : "in"}">
      <div class="bubble-wrap">
        <div class="bubble${m.communication_id === body.anchor_id ? " anchor" : ""}${m.body_redacted || missing ? " redacted" : ""}">
          ${m.subject ? `<span class="subject">${esc(decodeStored(m.subject))}</span>` : ""}${esc(text)}
        </div>
        <div class="bubble-meta">
          <span>${esc(fmtTime(when))}</span>
          ${m.short_variant && isOut ? `<span class="chip mono">${esc(m.short_variant)}</span>` : ""}
          ${m.has_replied ? `<span class="chip ok">${icon("reply", 11)} drew a reply</span>` : ""}
          ${m.has_clicked ? `<span class="chip info">clicked</span>` : ""}
          ${m.attainment_status ? `<span class="chip ${
            m.attainment_status === "attained" ? "ok" : m.attainment_status === "failed" ? "bad" : ""}">${
            esc(humanOutcome(m.attainment_outcome_type))}: ${esc(m.attainment_status)}</span>` : ""}
        </div>
      </div>
    </div>`;
  }).join("");

  view.innerHTML = `
    ${crumbs()}
    <div class="page-head">
      <h2>${esc(ch.label)} conversation</h2>
      <p>${plural(msgs.length, "message")} · ${out} from us, ${inb} from them
         ${inb ? "" : "· no reply yet"}</p>
    </div>
    <div class="card"><div class="card-body">
      <div class="thread">${bubbles || `<div class="empty">Nothing in this conversation.</div>`}</div>
    </div></div>
    <div class="card">
      <div class="card-head"><h3>Context</h3><span class="spacer"></span>
        ${anchor.variant_key ? `<button class="btn ghost tiny"
          data-href="#/messages?variant_key=${encodeURIComponent(anchor.variant_key)}">
          Every send of this arm ${icon("chev", 12)}</button>` : ""}</div>
      <div class="card-body">
        <dl class="kv">
          <dt>Experiment</dt><dd>${anchor.experiment_key
            ? `<a href="#/messages?experiment_key=${encodeURIComponent(anchor.experiment_key)}">${esc(anchor.experiment_key)}</a>`
            : "—"}</dd>
          <dt>Arm</dt><dd>${anchor.variant_key
            ? `<a href="#/messages?variant_key=${encodeURIComponent(anchor.variant_key)}">${esc(anchor.short_variant ?? anchor.variant_key)}</a>`
            : "untagged"}</dd>
          <dt>Source</dt><dd>${esc(anchor.source_key ?? "—")}</dd>
          <dt>Objective</dt><dd>${esc(anchor.objective_key ?? "—")}</dd>
          <dt>Prompt version</dt><dd class="mono">${esc(anchor.prompt_version ?? "—")}</dd>
          <dt>Salesforce lead</dt><dd class="mono">${esc(anchor.sf_lead_id ?? "—")}</dd>
        </dl>
      </div>
    </div>`;
}

const crumbs = () => `<div class="breadcrumb">
  <button data-back>${icon("back", 13)} Back</button><span>·</span>
  <button data-href="#/messages">All messages</button></div>`;

export { viewMessages, viewThread };
