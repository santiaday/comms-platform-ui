"use strict";
// Comms Outcomes dashboard. Fetches /api/metrics (same-origin; the server adds
// the reader bearer + computes Bayesian confidence) and renders objective cards.
// Auto-refreshes every 60s.

const $ = (sel) => document.querySelector(sel);
const pct = (x) => (x == null ? "—" : (x * 100).toFixed(1) + "%");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function variantShort(k) {
  if (!k) return "(none)";
  const m = String(k).match(/-([AB])-/);
  return m ? `${m[1]} · ${k}` : k;
}

function renderComponent(c) {
  const rows = [...c.variants].sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1)).map((v) => {
    const isLeader = c.leader && (v.variant_key ?? "(none)") === c.leader;
    return `<tr class="${isLeader ? "lead-row" : ""}">
      <td><span class="vk">${esc(variantShort(v.variant_key))}</span></td>
      <td class="rate">${pct(v.rate)}</td>
      <td>${v.showed}</td>
      <td>${v.not_showed}</td>
      <td>${v.pending}</td>
      <td><span class="pbar"><i style="width:${Math.round((v.prob_best || 0) * 100)}%"></i><span>${pct(v.prob_best)}</span></span></td>
    </tr>`;
  }).join("");

  // Leader's decided sample size — surfaced so a high P(best) on a tiny sample
  // reads honestly (a winner is never declared under MIN_N decided obs).
  const MIN_N = 30;
  const leaderV = c.variants.find((v) => c.leader && (v.variant_key ?? "(none)") === c.leader);
  const leaderN = leaderV ? leaderV.showed + leaderV.not_showed : 0;
  const verdict = c.conclusive
    ? `<div class="verdict win"><span class="dot"></span>Winner: <b>${esc(variantShort(c.leader))}</b> — P(best) ${pct(c.prob_leader_best)} ≥ ${pct(c.confidence_threshold)} threshold (n=${leaderN})</div>`
    : `<div class="verdict pend"><span class="dot"></span>Not conclusive — leader <b>${esc(variantShort(c.leader) || "—")}</b> at ${pct(c.prob_leader_best)}` +
      (leaderN < MIN_N
        ? ` · only ${leaderN} decided (need ≥${MIN_N} + ${pct(c.confidence_threshold)})`
        : ` (need ${pct(c.confidence_threshold)})`) + `</div>`;

  return `<div class="comp">
    <div class="ctitle">
      <span class="pill ${c.label === "primary" ? "primary" : ""}">${esc(c.label)}</span>
      <span class="ot">${esc(c.outcome_type)}</span>
      <span class="pill">${esc(c.eval_mode)}</span>
      <span class="exp">${esc(c.experiment_key || "—")}</span>
    </div>
    <table>
      <thead><tr><th>Variant</th><th>Rate</th><th>Hit</th><th>Miss</th><th>Pending</th><th>P(best)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${verdict}
  </div>`;
}

function renderEngagementExperiment(e) {
  const anyData = e.variants.some((v) =>
    v.delivered || v.opened || v.clicked || v.replied || v.bounced || v.unsubscribed || v.complained);
  const totalSent = e.variants.reduce((s, v) => s + (v.sent || 0), 0);

  const body = anyData
    ? `<table>
        <thead><tr><th>Variant</th><th>Sent</th><th>Deliv.</th><th>Open</th><th>Click</th><th>Reply</th><th>Bounce</th></tr></thead>
        <tbody>${[...e.variants].sort((a, b) => (b.reply_rate ?? -1) - (a.reply_rate ?? -1)).map((v) => `<tr>
          <td><span class="vk">${esc(variantShort(v.variant_key))}</span></td>
          <td>${v.sent}</td>
          <td>${pct(v.delivery_rate)}</td>
          <td>${pct(v.open_rate)}</td>
          <td>${pct(v.click_rate)}</td>
          <td class="rate">${pct(v.reply_rate)}</td>
          <td>${pct(v.bounce_rate)}</td>
        </tr>`).join("")}</tbody>
      </table>`
    : `<div class="pending-note">⏳ Sent ${totalSent} · awaiting engagement data (Outreach poll pending)</div>`;

  return `<div class="comp">
    <div class="ctitle"><span class="pill email">email</span><span class="ot">engagement</span><span class="exp">${esc(e.experiment_key || "—")}</span></div>
    ${body}
  </div>`;
}

function renderEngagement(engagement) {
  if (!engagement || engagement.length === 0) return "";
  return `<section class="obj">
    <div class="head"><span class="name">📧 Email engagement</span><span class="thr">per experiment · reply is decision-bearing · open rate is MPP-inflated (directional only)</span></div>
    ${engagement.map(renderEngagementExperiment).join("")}
  </section>`;
}

function renderObjectives(objectives) {
  // group components by objective
  const byObj = new Map();
  for (const c of objectives) {
    const k = `${c.objective_key} v${c.objective_version}`;
    (byObj.get(k) || byObj.set(k, []).get(k)).push(c);
  }
  let html = "";
  for (const [name, comps] of byObj) {
    const thr = comps[0].confidence_threshold;
    html += `<section class="obj">
      <div class="head"><span class="name">${esc(name)}</span><span class="thr">confidence threshold ${pct(thr)}</span></div>
      ${comps.sort((a, b) => a.rank - b.rank).map(renderComponent).join("")}
    </section>`;
  }
  return html || `<p class="muted">No objectives with data yet.</p>`;
}

async function load() {
  const main = $("#objectives");
  const banner = $("#banner");
  try {
    const r = await fetch("/api/metrics", { headers: { accept: "application/json" } });
    const data = await r.json();
    if (!data.ok) {
      banner.hidden = false;
      banner.textContent = data.error || "Failed to load metrics.";
      main.setAttribute("aria-busy", "false");
      return;
    }
    banner.hidden = true;
    main.innerHTML = renderObjectives(data.objectives || []) + renderEngagement(data.engagement || []);
    main.setAttribute("aria-busy", "false");
    $("#updated").textContent = "updated " + new Date(data.computed_at).toLocaleTimeString();
  } catch (e) {
    banner.hidden = false;
    banner.textContent = "Network error loading metrics: " + (e && e.message ? e.message : e);
  }
}

$("#refresh").addEventListener("click", load);
$("#objectives").innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
load();
setInterval(load, 60_000);
