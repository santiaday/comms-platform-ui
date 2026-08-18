"use strict";
// Ledger tab — every tracked communication, its engagement, and its outcome.
//
// Screens: coverage grid (front door) -> message list -> message detail,
// plus a person timeline reachable from search or from any message.
//
// IIFE so it shares no globals with app.js.
//
// The rule this file exists to enforce: NULL IS NOT ZERO. A rate is only a
// number when a feed for that signal exists. "not measured" means nothing is
// wired up to tell us — which is a pipeline gap, not a performance result.
// Conflating the two is what let an eight-day HubSpot outage pass unnoticed and
// made Zoom SMS look 99% "engaged" while its real reply rate was 0.05%.
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const NA = (label = "not measured") => `<span class="na">${esc(label)}</span>`;
  const pct = (x) => (x == null ? NA() : (x * 100).toFixed(1) + "%");
  const num = (n) => (n == null ? "—" : Number(n).toLocaleString());

  function ago(ts) {
    if (!ts) return "—";
    const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
    if (!isFinite(m)) return "—";
    if (m < 60) return `${m}m ago`;
    if (m < 1440) return `${Math.round(m / 60)}h ago`;
    return `${Math.round(m / 1440)}d ago`;
  }
  const when = (ts) => (ts ? new Date(ts).toLocaleString() : "—");

  // Flags, worst first. The hint explains the consequence, not just the state.
  const FLAGS = [
    ["no_events_at_all", "no events", "bad",
     "Sends are logged but no engagement events have ever arrived — this channel is unmeasured end to end."],
    ["no_engagement_feed", "engagement unmeasured", "bad",
     "No click or reply events exist for this source, so its engagement rate cannot be computed at all."],
    ["unattributable", "unattributable", "bad",
     "Under 5% of sends join an outcome. Attainment joins only via communication_refs, so these sends can never be credited."],
    ["stale", "stale", "bad", "No activity within this source's freshness window."],
    ["unbound", "no objective", "warn",
     "Under 5% carry an objective, so these sends are invisible in the Experiments tab."],
    ["no_delivery_feed", "no delivery receipts", "warn",
     "This source reports no delivered events, so the delivery rate is unknown rather than zero."],
    ["observed_undeclared", "unregistered", "warn",
     "Producing communications but missing from core.sources."],
    ["declared_silent", "silent", "warn",
     "Registered as an active comms source but has never produced a communication."],
  ];
  const flagsFor = (r) => FLAGS.filter(([k]) => r[k]);
  const flagBadges = (r) => {
    const f = flagsFor(r);
    if (!f.length) return '<span class="flag ok">healthy</span>';
    return f.map(([, label, tone, hint]) =>
      `<span class="flag ${tone}" title="${esc(hint)}">${esc(label)}</span>`).join("");
  };

  async function api(path) {
    const r = await fetch(`/api/ledger/${path}`, { headers: { accept: "application/json" } });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || `request failed (${r.status})`);
    return d;
  }

  // ------------------------------------------------------------- coverage
  function coverageRow(r) {
    const key = `${r.source_key}|${r.channel || ""}`;
    return `<tr class="cov-row" data-key="${esc(key)}">
      <td>
        <span class="src">${esc(r.source_key)}</span>
        ${r.display_name ? `<span class="dn"> ${esc(r.display_name)}</span>` : ""}
        ${r.is_test ? '<span class="flag warn">test</span>' : ""}
      </td>
      <td>${esc(r.channel || "—")}</td>
      <td class="n">${num(r.n_communications)}</td>
      <td class="n">${num(r.n_recipients)}</td>
      <td>${r.last_seen ? esc(ago(r.last_seen)) : "—"}</td>
      <td>${pct(r.pct_delivered)}</td>
      <td>${pct(r.pct_opened)}</td>
      <td><b>${pct(r.pct_engaged)}</b></td>
      <td>${pct(r.pct_outcome_joinable)}</td>
      <td>${pct(r.pct_objective_bound)}</td>
      <td class="flags">${flagBadges(r)}</td>
    </tr>`;
  }

  function renderCoverage(rows) {
    if (!rows.length) return `<p class="muted">No sources found.</p>`;
    const live = rows.filter((r) => !r.is_test);
    const test = rows.filter((r) => r.is_test);
    const head = `<thead><tr>
        <th>Source</th><th>Channel</th><th>Comms</th><th>People</th><th>Last seen</th>
        <th>Delivered</th><th>Opened</th><th>Engaged</th><th>Joinable</th><th>Objective</th><th>Health</th>
      </tr></thead>`;
    const testSection = test.length
      ? `<tr><td colspan="11" class="group-h">test sources</td></tr>` + test.map(coverageRow).join("")
      : "";
    return `<section class="obj">
      <div class="head">
        <span class="name">Pipeline coverage</span>
        <span class="thr">every active and observed comms source · click a row for its messages</span>
      </div>
      <table class="coverage">${head}<tbody>${live.map(coverageRow).join("")}${testSection}</tbody></table>
      <p class="legend">
        <b>Delivered</b> / <b>Opened</b> / <b>Engaged</b> are separate on purpose.
        <b>Engaged = clicked or replied</b> — the only human, decision-bearing signal.
        Delivery is not engagement, and opens are MPP-inflated by 15–40%, so neither is counted as one.
        <b>Joinable</b> = share whose <code>sf_lead</code> ref resolves to a real outcome — the hard ceiling
        on what can ever be attributed. <b>Objective</b> = share visible in the Experiments tab.
        <em>not measured</em> means no feed exists for that signal; it is never the same as 0%.
      </p>
    </section>`;
  }

  // ------------------------------------------------------------- messages
  function eventChips(m) {
    const on = [["delivered", m.has_delivered], ["opened", m.has_opened], ["clicked", m.has_clicked],
                ["replied", m.has_replied], ["bounced", m.has_bounced]]
      .filter(([, v]) => v).map(([k]) => `<span class="chip ${k}">${k}</span>`).join("");
    if (on) return on;
    return m.n_events > 0 ? `<span class="chip">${m.n_events} event(s)</span>` : NA("no events");
  }

  function outcomeCell(m) {
    if (m.attainment_status) {
      return `<span class="att ${esc(m.attainment_status)}">${esc(m.attainment_status)}</span>` +
             (m.attainment_outcome_type ? ` <span class="muted">${esc(m.attainment_outcome_type)}</span>` : "");
    }
    const why = [];
    if (!m.objective_key) why.push("no objective binding");
    if (!m.has_sf_lead_ref) why.push("no sf_lead ref");
    return `<span class="na" title="${esc(why.join(" · ") || "no attainment row")}">not attributable</span>`;
  }

  function renderMessages(title, rows, sub) {
    if (!rows.length) return `<section class="obj"><div class="head"><span class="name">${esc(title)}</span></div>
      <p class="legend">No communications match.</p></section>`;
    const body = rows.map((m) => `<tr class="msg-row" data-id="${esc(m.communication_id)}">
        <td>${esc(when(m.sent_at))}</td>
        <td>${esc(m.source_key)} <span class="muted">${esc(m.channel)}</span></td>
        <td>${esc(m.direction)}</td>
        <td><span class="vk">${esc(m.experiment_key || "—")}</span>${m.variant_key ? `<br><span class="muted vk">${esc(m.variant_key)}</span>` : ""}</td>
        <td>${eventChips(m)}</td>
        <td>${outcomeCell(m)}</td>
      </tr>`).join("");
    return `<section class="obj">
      <div class="head"><span class="name">${esc(title)}</span><span class="thr">${esc(sub || "")}</span></div>
      <table class="messages">
        <thead><tr><th>Sent</th><th>Source</th><th>Dir</th><th>Experiment / variant</th><th>Engagement</th><th>Outcome</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </section>`;
  }

  // ------------------------------------------------------------- detail
  const SOURCES_WITHOUT_BODY = {
    outreach: "the Outreach logger posts metadata only",
    zoom_sms: "the Zoom SMS logger posts metadata only",
    hubspot: "the HubSpot logger posts metadata only",
  };

  function bodyBlock(m) {
    if (m.body_redacted) {
      return `<div class="body-missing">Body was captured and has since been <b>redacted</b>
        (erasure request or retention policy). This is not a logging gap.</div>`;
    }
    const text = m.body_text || m.body_html || m.body_snippet;
    if (m.has_body && text) {
      const isHtml = !m.body_text && !!m.body_html;
      return `<div class="timeline-sep">Message body${isHtml ? " (HTML source)" : ""}</div>
              <div class="body-block"><pre>${esc(text)}</pre></div>`;
    }
    const why = SOURCES_WITHOUT_BODY[m.source_key];
    return `<div class="body-missing">
      <b>No body was captured for this message.</b>
      ${why ? esc(why[0].toUpperCase() + why.slice(1)) + " — " : ""}nothing was ever written to
      <code>comms.communication_bodies</code>, so there is no content to show. Only the agent platform
      currently sends message content. Fixing this means changing the sender to include the body at log time.
    </div>`;
  }

  function renderDetail(m) {
    // NOTE: values are pre-escaped or are trusted markup. Do NOT wrap the whole
    // string in esc() — an earlier version did, and rendered literal
    // `<span class="na">none</span>` on screen.
    const f = (k, v) => `<div class="kv"><span>${esc(k)}</span><b>${v}</b></div>`;
    const or = (v) => (v ? esc(v) : NA("none"));
    return `<section class="obj">
      <div class="head"><span class="name">Communication</span>
        <span class="thr vk">${esc(m.communication_id)}</span></div>
      <div class="detail">
        ${f("source", esc(m.source_key) + " / " + esc(m.channel))}
        ${f("direction", esc(m.direction))}
        ${f("sent", esc(when(m.sent_at)))}
        ${f("delivered", m.delivered_at ? esc(when(m.delivered_at)) : NA("no receipt"))}
        ${f("status", or(m.status))}
        ${f("experiment", or(m.experiment_key))}
        ${f("variant", or(m.variant_key))}
        ${f("campaign", or(m.campaign_key))}
        ${f("content", or(m.content_key))}
        ${f("prompt version", or(m.prompt_version))}
        ${f("objective", or(m.objective_key))}
        ${f("sf_lead ref", or(m.sf_lead_id))}
        ${f("engagement", eventChips(m))}
        ${f("outcome", outcomeCell(m))}
      </div>
      ${bodyBlock(m)}
      <p class="legend"><button class="link" data-person="${esc(m.recipient_id)}">view this person's full timeline →</button></p>
    </section>`;
  }

  // ------------------------------------------------------------- person
  function renderPerson(d) {
    const msgs = d.messages || [], outs = d.outcomes || [];
    const outHtml = outs.length
      ? `<table class="messages"><thead><tr><th>When</th><th>Outcome</th><th>Joined via</th></tr></thead><tbody>${
          outs.map((o) => `<tr><td>${esc(when(o.occurred_at))}</td>
            <td><span class="att attained">${esc(o.outcome_type)}</span></td>
            <td class="muted vk">${esc(o.ref_type)} ${esc(o.ref_id)}</td></tr>`).join("")}</tbody></table>`
      : `<p class="legend">No outcomes join to this person. If their sends carry no
         <code>sf_lead</code> reference, nothing they do downstream can be credited — that is a
         pipeline gap, not an absence of activity.</p>`;
    return renderMessages("Person timeline", msgs, `${msgs.length} communication(s) across all sources`) +
      `<section class="obj"><div class="head"><span class="name">Outcomes</span>
        <span class="thr">joined via sf_lead / sje references</span></div>${outHtml}</section>`;
  }

  // ------------------------------------------------------------- controller
  const body = () => $("#ledger-body");
  const back = () => $("#ledger-back");

  async function show(fn, isRoot) {
    body().setAttribute("aria-busy", "true");
    try {
      body().innerHTML = await fn();
      back().hidden = !!isRoot;
    } catch (e) {
      body().innerHTML = `<div class="banner">${esc(e.message || String(e))}</div>`;
    } finally {
      body().setAttribute("aria-busy", "false");
    }
  }

  const showCoverage = () =>
    show(async () => renderCoverage((await api("coverage")).coverage || []), true);

  const showMessages = (source, channel) =>
    show(async () => {
      const q = new URLSearchParams({ source_key: source, limit: "100" });
      if (channel) q.set("channel", channel);
      const d = await api(`messages?${q}`);
      return renderMessages(`${source}${channel ? " · " + channel : ""}`,
        d.messages || [], `${(d.messages || []).length} most recent`);
    });

  const showMessage = (id) => show(async () => renderDetail((await api(`message/${id}`)).message));
  const showPerson = (params) => show(async () => renderPerson(await api(`person?${params}`)));

  document.addEventListener("click", (ev) => {
    const inBody = (el) => el && body().contains(el);
    const cov = ev.target.closest?.(".cov-row");
    if (inBody(cov)) { const [s, c] = cov.dataset.key.split("|"); return showMessages(s, c); }
    const person = ev.target.closest?.("[data-person]");
    if (inBody(person)) return showPerson(new URLSearchParams({ recipient_id: person.dataset.person }));
    const msg = ev.target.closest?.(".msg-row");
    if (inBody(msg)) return showMessage(msg.dataset.id);
  });

  back().addEventListener("click", showCoverage);
  $("#person-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = $("#person-value").value.trim();
    if (!v) return;
    showPerson(new URLSearchParams({ id_type: $("#person-type").value, id_value: v }));
  });

  const TABS = {
    experiments: { sub: "Show-rate & A/B confidence per objective · updates hourly from Salesforce",
      foot: "Bayesian P(best) · winner declared at each objective's confidence threshold · rates = Show / (Show + No-Show + Canceled + Rescheduled)" },
    ledger: { sub: "Every tracked communication, its engagement, and its outcome — across all sources",
      foot: "Null is never shown as zero. 'not measured' means no feed is wired up for that signal, not that the result was 0%. Engaged = clicked or replied; delivery and opens are never counted as engagement." },
  };
  let loadedOnce = false;
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
      if (name === "ledger" && !loadedOnce) { loadedOnce = true; showCoverage(); }
    });
  });
})();
