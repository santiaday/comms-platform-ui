"use strict";
// Ledger tab — source-agnostic view of every tracked communication.
//
// Four screens: coverage grid (front door) -> message list -> message detail,
// plus a person timeline reachable from search or from any message.
//
// Wrapped in an IIFE so it shares no globals with app.js.
//
// Rendering rule that matters: null is never drawn as zero. A source with no
// engagement source configured reads "not measured", not "0%" — conflating
// those is what let an eight-day HubSpot outage pass unnoticed.
(function () {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const pctOrDash = (x) => (x == null ? '<span class="na">not measured</span>' : (x * 100).toFixed(1) + "%");
  const num = (n) => (n == null ? "—" : Number(n).toLocaleString());

  function ago(ts) {
    if (!ts) return "—";
    const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
    if (!isFinite(mins)) return "—";
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
    return `${Math.round(mins / 1440)}d ago`;
  }

  const FLAG_META = {
    declared_silent: ["silent", "warn", "Registered as a comms source but has never produced a communication."],
    observed_undeclared: ["unregistered", "warn", "Producing communications but missing from core.sources."],
    no_engagement: ["no engagement", "bad", "Has sends but zero engagement events ever — unmeasured, not 0%."],
    unattributable: ["unattributable", "bad", "Under 5% of sends join to any outcome, so nothing here can be credited."],
    unbound: ["no objective", "warn", "Under 5% carry an objective, so these sends are absent from the experiment readout."],
    stale: ["stale", "bad", "No activity within this source's freshness window."],
  };

  function flagBadges(row) {
    return Object.keys(FLAG_META)
      .filter((k) => row[k])
      .map((k) => {
        const [label, tone, hint] = FLAG_META[k];
        return `<span class="flag ${tone}" title="${esc(hint)}">${esc(label)}</span>`;
      })
      .join("");
  }

  async function api(path) {
    const r = await fetch(`/api/ledger/${path}`, { headers: { accept: "application/json" } });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || `request failed (${r.status})`);
    return data;
  }

  // ---------------------------------------------------------------- coverage
  function renderCoverage(rows) {
    if (!rows.length) return `<p class="muted">No sources found.</p>`;
    const body = rows
      .map((r) => {
        const flags = flagBadges(r);
        const key = `${r.source_key}|${r.channel || ""}`;
        return `<tr class="cov-row ${flags ? "has-flags" : ""}" data-key="${esc(key)}">
        <td>
          <span class="src">${esc(r.source_key)}</span>
          ${r.display_name ? `<span class="muted"> ${esc(r.display_name)}</span>` : ""}
          ${r.observed ? "" : '<span class="muted"> · never seen</span>'}
        </td>
        <td>${esc(r.channel || "—")}</td>
        <td class="n">${num(r.n_communications)}</td>
        <td class="n">${num(r.n_recipients)}</td>
        <td>${r.last_seen ? esc(ago(r.last_seen)) : "—"}</td>
        <td>${pctOrDash(r.pct_with_engagement)}</td>
        <td>${pctOrDash(r.pct_outcome_joinable)}</td>
        <td>${pctOrDash(r.pct_objective_bound)}</td>
        <td class="flags">${flags || '<span class="flag ok">ok</span>'}</td>
      </tr>`;
      })
      .join("");

    return `<section class="obj">
      <div class="head">
        <span class="name">Pipeline coverage</span>
        <span class="thr">every declared and observed comms source · click a row for its messages</span>
      </div>
      <table class="coverage">
        <thead><tr>
          <th>Source</th><th>Channel</th><th>Comms</th><th>People</th><th>Last seen</th>
          <th>Engaged</th><th>Joinable to outcome</th><th>Has objective</th><th>Health</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
      <p class="legend">
        <b>Engaged</b> = share with at least one delivered/open/click/reply/bounce event.
        <b>Joinable to outcome</b> = share whose recipient carries an <code>sf_lead</code> that appears in outcomes —
        the ceiling on what can ever be attributed. <b>Has objective</b> = share visible in the Experiments tab.
      </p>
    </section>`;
  }

  // ---------------------------------------------------------------- messages
  function eventChips(m) {
    const chips = [
      ["delivered", m.has_delivered],
      ["opened", m.has_opened],
      ["clicked", m.has_clicked],
      ["replied", m.has_replied],
      ["bounced", m.has_bounced],
    ]
      .filter(([, on]) => on)
      .map(([label]) => `<span class="chip ${label}">${label}</span>`)
      .join("");
    if (chips) return chips;
    return m.n_events > 0
      ? `<span class="chip">${m.n_events} event(s)</span>`
      : '<span class="na">no events</span>';
  }

  function outcomeCell(m) {
    if (m.attainment_status) {
      return `<span class="att ${esc(m.attainment_status)}">${esc(m.attainment_status)}</span>
              <span class="muted"> ${esc(m.attainment_outcome_type || "")}</span>`;
    }
    // Explain *why* there is nothing, rather than rendering an empty cell.
    const reasons = [];
    if (!m.objective_key) reasons.push("no objective binding");
    if (!m.has_sf_lead_ref) reasons.push("no sf_lead ref");
    return `<span class="na" title="${esc(reasons.join(" · ") || "no attainment row")}">not attributable</span>`;
  }

  function renderMessages(title, rows, sub) {
    if (!rows.length) return `<p class="muted">No communications match.</p>`;
    const body = rows
      .map(
        (m) => `<tr class="msg-row" data-id="${esc(m.communication_id)}">
        <td>${m.sent_at ? esc(new Date(m.sent_at).toLocaleString()) : "—"}</td>
        <td>${esc(m.source_key)} <span class="muted">${esc(m.channel)}</span></td>
        <td>${esc(m.direction)}</td>
        <td>${esc(m.experiment_key || "—")}<br><span class="muted">${esc(m.variant_key || "")}</span></td>
        <td>${eventChips(m)}</td>
        <td>${outcomeCell(m)}</td>
      </tr>`,
      )
      .join("");
    return `<section class="obj">
      <div class="head"><span class="name">${esc(title)}</span><span class="thr">${esc(sub || "")}</span></div>
      <table class="messages">
        <thead><tr><th>Sent</th><th>Source</th><th>Dir</th><th>Experiment / variant</th><th>Engagement</th><th>Outcome</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </section>`;
  }

  // ------------------------------------------------------------------ person
  function renderPerson(data) {
    const msgs = data.messages || [];
    const outs = data.outcomes || [];
    const outHtml = outs.length
      ? `<table class="messages"><thead><tr><th>When</th><th>Outcome</th><th>Via</th></tr></thead><tbody>${outs
          .map(
            (o) => `<tr><td>${esc(new Date(o.occurred_at).toLocaleString())}</td>
            <td><span class="att attained">${esc(o.outcome_type)}</span></td>
            <td class="muted">${esc(o.ref_type)} ${esc(o.ref_id)}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : `<p class="muted">No outcomes join to this person. If their sends carry no <code>sf_lead</code>
         reference, nothing they do downstream can be credited to them — that is a pipeline gap, not an absence of activity.</p>`;

    return (
      renderMessages(`Person timeline`, msgs, `${msgs.length} communication(s) across all sources`) +
      `<section class="obj"><div class="head"><span class="name">Outcomes</span>
       <span class="thr">joined via sf_lead / sje references</span></div>${outHtml}</section>`
    );
  }

  // ------------------------------------------------------------------ detail
  function renderDetail(m) {
    const field = (k, v) => `<div class="kv"><span>${esc(k)}</span><b>${v}</b></div>`;
    return `<section class="obj">
      <div class="head"><span class="name">Communication</span><span class="thr">${esc(m.communication_id)}</span></div>
      <div class="detail">
        ${field("source", esc(m.source_key) + " / " + esc(m.channel))}
        ${field("direction", esc(m.direction))}
        ${field("sent", m.sent_at ? esc(new Date(m.sent_at).toLocaleString()) : "—")}
        ${field("status", esc(m.status || "—"))}
        ${field("experiment", esc(m.experiment_key || "—"))}
        ${field("variant", esc(m.variant_key || "—"))}
        ${field("campaign", esc(m.campaign_key || "—"))}
        ${field("content", esc(m.content_key || "—"))}
        ${field("prompt version", esc(m.prompt_version || "—"))}
        ${field("objective", esc(m.objective_key || '<span class="na">none</span>'))}
        ${field("sf_lead ref", m.sf_lead_id ? esc(m.sf_lead_id) : '<span class="na">none</span>')}
        ${field("engagement", eventChips(m))}
        ${field("outcome", outcomeCell(m))}
      </div>
      <p><button class="link" data-person="${esc(m.recipient_id)}">view this person's full timeline →</button></p>
    </section>`;
  }

  // -------------------------------------------------------------- controller
  const body = () => $("#ledger-body");
  const backBtn = () => $("#ledger-back");
  let atRoot = true;

  function setBusy(on) {
    body().setAttribute("aria-busy", on ? "true" : "false");
  }

  async function show(fn, isRoot) {
    setBusy(true);
    try {
      body().innerHTML = await fn();
      atRoot = !!isRoot;
      backBtn().hidden = atRoot;
    } catch (e) {
      body().innerHTML = `<div class="banner">${esc(e.message || String(e))}</div>`;
    } finally {
      setBusy(false);
    }
  }

  const showCoverage = () =>
    show(async () => renderCoverage((await api("coverage")).coverage || []), true);

  const showMessages = (source, channel) =>
    show(async () => {
      const q = new URLSearchParams({ source_key: source, limit: "100" });
      if (channel) q.set("channel", channel);
      const d = await api(`messages?${q}`);
      return renderMessages(
        `${source}${channel ? " · " + channel : ""}`,
        d.messages || [],
        `${(d.messages || []).length} most recent`,
      );
    });

  const showMessage = (id) => show(async () => renderDetail((await api(`message/${id}`)).message));

  const showPerson = (params) => show(async () => renderPerson(await api(`person?${params}`)));

  // Delegated clicks: coverage row -> messages, message row -> detail.
  document.addEventListener("click", (ev) => {
    const cov = ev.target.closest?.(".cov-row");
    if (cov && body().contains(cov)) {
      const [source, channel] = cov.dataset.key.split("|");
      return showMessages(source, channel);
    }
    const msg = ev.target.closest?.(".msg-row");
    if (msg && body().contains(msg)) return showMessage(msg.dataset.id);
    const person = ev.target.closest?.("[data-person]");
    if (person && body().contains(person)) {
      return showPerson(new URLSearchParams({ recipient_id: person.dataset.person }));
    }
  });

  $("#ledger-back").addEventListener("click", showCoverage);

  $("#person-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const value = $("#person-value").value.trim();
    if (!value) return;
    showPerson(new URLSearchParams({ id_type: $("#person-type").value, id_value: value }));
  });

  // Tabs
  const TABS = {
    experiments: {
      panes: ["#objectives"],
      sub: "Show-rate & A/B confidence per objective · updates hourly from Salesforce",
      foot: "Bayesian P(best) · winner declared at each objective's confidence threshold · rates = Show / (Show + No-Show + Canceled + Rescheduled)",
    },
    ledger: {
      panes: ["#ledger"],
      sub: "Every tracked communication, its engagement, and its outcome — across all sources",
      foot: "Null is never shown as zero: 'not measured' means no engagement source is wired up for that channel, not that engagement was 0%.",
    },
  };

  let loadedLedgerOnce = false;

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.tab;
      document.querySelectorAll(".tab").forEach((b) => {
        const on = b === btn;
        b.classList.toggle("active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
      $("#objectives").hidden = name !== "experiments";
      $("#ledger").hidden = name !== "ledger";
      $("#subtitle").textContent = TABS[name].sub;
      $("#footnote").textContent = TABS[name].foot;
      if (name === "ledger" && !loadedLedgerOnce) {
        loadedLedgerOnce = true;
        showCoverage();
      }
    });
  });
})();
