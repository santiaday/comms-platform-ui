"use strict";
// Communications Hub — Experiments.
//
// One card per EXPERIMENT, with its outcomes side by side. The old build drew a
// card per (objective × component), so an experiment's primary and secondary
// sat far apart with every other experiment between them — you could not see
// "did they show up" and "did it convert" together, which is the only question
// worth asking of an A/B.
//
// The chart is a dot-and-interval, not a bar. Nearly every experiment here is
// correctly "not conclusive", and a bar chart actively hides why: 27.5% vs
// 25.4% reads like a real gap until you see the Wilson intervals overlap almost
// entirely. The interval IS the finding.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pct = (x, d = 1) => (x == null ? "—" : (x * 100).toFixed(d) + "%");
const num = (n) => (n == null ? "—" : Number(n).toLocaleString());
const NA = (t) => `<span class="na">${esc(t)}</span>`;

// Categorical slots, validated for CVD + contrast in both modes
// (dataviz validator: lightness band, chroma floor, CVD ΔE, normal-vision ΔE).
// Series colour follows the ARM, never its rank, so filtering never repaints.
const SERIES = ["s1", "s2", "s3", "s4"];
const seriesClass = (i) => SERIES[i % SERIES.length];

const MIN_N = 30; // below this, a leader is never called

/* ---------------------------------------------------------------- charts */

/**
 * Rate with Wilson interval. Magnitude + uncertainty on one row.
 * Domain is shared across the component's variants so rows are comparable.
 */
function intervalRow(v, i, domain, leaderKey) {
  const isLeader = leaderKey && (v.variant_key ?? "(none)") === leaderKey;
  const scale = (x) => ((x - domain.lo) / (domain.hi - domain.lo || 1)) * 100;
  const lo = v.wilson_low != null ? scale(v.wilson_low) : null;
  const hi = v.wilson_high != null ? scale(v.wilson_high) : null;
  const mid = v.rate != null ? scale(v.rate) : null;
  const band = lo != null && hi != null
    ? `<span class="ci" style="left:${lo}%;width:${Math.max(hi - lo, 0.6)}%"></span>` : "";
  const dot = mid != null ? `<span class="dot-mark" style="left:${mid}%"></span>` : "";

  return `<tr class="${isLeader ? "lead-row" : ""}">
    <td class="v-name">
      <span class="swatch ${seriesClass(i)}"></span>
      <span class="vk">${esc(v.short_key || v.variant_key || "untagged")}</span>
    </td>
    <td class="v-rate">${pct(v.rate)}</td>
    <td class="v-plot ${seriesClass(i)}">
      <span class="track">${band}${dot}</span>
    </td>
    <td class="v-n">${num(v.showed)}<span class="muted">/${num(v.denominator)}</span></td>
    <td class="v-pend">${v.pending ? num(v.pending) : "—"}</td>
    <td class="v-pbest">
      <span class="pbar"><i style="width:${Math.round((v.prob_best || 0) * 100)}%"></i></span>
      <span class="pnum">${pct(v.prob_best, 0)}</span>
    </td>
  </tr>`;
}

function componentBlock(c, single) {
  const vs = [...c.variants].sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
  const decided = vs.reduce((s, v) => s + v.denominator, 0);
  const pending = vs.reduce((s, v) => s + v.pending, 0);

  if (decided === 0) {
    return `<div class="comp">
      <div class="comp-head">
        <span class="pill ${c.label === "primary" ? "primary" : ""}">${esc(c.label)}</span>
        <span class="ot">${esc(c.outcome_type)}</span>
        <span class="pill ghost">${esc(c.eval_mode)}</span>
      </div>
      <div class="empty-note">No decided outcomes yet · <b>${num(pending)}</b> still inside the
        ${esc(c.eval_mode === "window" ? "conversion window" : "disposition window")}.
        A rate here would be noise, so none is shown.</div>
    </div>`;
  }

  // Shared domain across arms, padded, so intervals are visually comparable.
  const los = vs.map((v) => v.wilson_low).filter((x) => x != null);
  const his = vs.map((v) => v.wilson_high).filter((x) => x != null);
  const lo = los.length ? Math.max(0, Math.min(...los) - 0.03) : 0;
  const hi = his.length ? Math.min(1, Math.max(...his) + 0.03) : 1;
  const domain = { lo, hi };

  const leaderN = (() => {
    const l = vs.find((v) => (v.variant_key ?? "(none)") === c.leader);
    return l ? l.denominator : 0;
  })();

  const verdict = c.conclusive
    ? `<div class="verdict win"><span class="vdot"></span>
         <b>${esc(vs.find((v) => (v.variant_key ?? "(none)") === c.leader)?.short_key ?? c.leader ?? "—")}</b>
         wins — P(best) ${pct(c.prob_leader_best, 0)} ≥ ${pct(c.confidence_threshold, 0)} on ${num(leaderN)} decided</div>`
    : single
      ? `<div class="verdict flat"><span class="vdot"></span>Single arm — nothing to compare against yet</div>`
      : `<div class="verdict pend"><span class="vdot"></span>Not conclusive —
           leader <b>${esc(vs.find((v) => (v.variant_key ?? "(none)") === c.leader)?.short_key ?? "—")}</b>
           at ${pct(c.prob_leader_best, 0)}${leaderN < MIN_N
             ? ` · only ${num(leaderN)} decided (need ≥${MIN_N})`
             : ` · needs ${pct(c.confidence_threshold, 0)}`}</div>`;

  return `<div class="comp">
    <div class="comp-head">
      <span class="pill ${c.label === "primary" ? "primary" : ""}">${esc(c.label)}</span>
      <span class="ot">${esc(c.outcome_type)}</span>
      <span class="pill ghost">${esc(c.eval_mode)}</span>
      <span class="comp-n">${num(decided)} decided${pending ? ` · ${num(pending)} pending` : ""}</span>
    </div>
    <table class="variants">
      <thead><tr>
        <th>Arm</th><th class="r">Rate</th><th class="plot-h">95% interval</th>
        <th class="r">Hit/n</th><th class="r">Pend</th><th class="r">P(best)</th>
      </tr></thead>
      <tbody>${vs.map((v, i) => intervalRow(v, i, domain, c.leader)).join("")}</tbody>
    </table>
    ${verdict}
  </div>`;
}

function engagementBlock(rows) {
  if (!rows || !rows.length) return "";
  const any = rows.some((v) => v.delivered || v.opened || v.clicked || v.replied || v.bounced);
  if (!any) {
    const sent = rows.reduce((s, v) => s + (v.sent || 0), 0);
    return `<div class="eng"><div class="eng-head">Email engagement</div>
      <div class="empty-note">Sent ${num(sent)} · no engagement events yet for this experiment.</div></div>`;
  }
  return `<div class="eng">
    <div class="eng-head">Email engagement
      <span class="muted">reply is decision-bearing · opens are MPP-inflated, directional only</span></div>
    <table class="variants eng-table">
      <thead><tr><th>Arm</th><th class="r">Sent</th><th class="r">Deliv</th>
        <th class="r">Open</th><th class="r">Click</th><th class="r">Reply</th><th class="r">Bounce</th></tr></thead>
      <tbody>${rows.map((v, i) => `<tr>
        <td class="v-name"><span class="swatch ${seriesClass(i)}"></span>
          <span class="vk">${esc(v.variant_key ?? "untagged")}</span></td>
        <td class="r">${num(v.sent)}</td>
        <td class="r">${v.delivery_rate == null ? NA("—") : pct(v.delivery_rate, 0)}</td>
        <td class="r muted">${v.open_rate == null ? NA("—") : pct(v.open_rate, 0)}</td>
        <td class="r">${v.click_rate == null ? NA("—") : pct(v.click_rate, 0)}</td>
        <td class="r strong">${v.reply_rate == null ? NA("—") : pct(v.reply_rate, 1)}</td>
        <td class="r">${v.bounce_rate == null ? NA("—") : pct(v.bounce_rate, 0)}</td>
      </tr>`).join("")}</tbody>
    </table>
  </div>`;
}

function experimentCard(x) {
  const conclusive = x.components.some((c) => c.conclusive);
  return `<section class="exp ${conclusive ? "is-win" : ""}">
    <header class="exp-head">
      <div>
        <h3>${esc(x.title)}</h3>
        <div class="exp-key vk">${esc(x.experiment_key ?? "—")}</div>
      </div>
      <div class="exp-meta">
        ${x.single_arm ? '<span class="chip warn">single arm</span>' : ""}
        ${conclusive ? '<span class="chip good">winner</span>' : ""}
        <span class="chip">${num(x.primary_denominator)} decided</span>
      </div>
    </header>
    <div class="exp-body">${x.components.map((c) => componentBlock(c, x.single_arm)).join("")}</div>
    ${engagementBlock(x.engagement)}
  </section>`;
}

function programSection(g) {
  return `<section class="prog">
    <div class="prog-head">
      <h2>${esc(g.label)}</h2>
      <div class="prog-stats">
        <span><b>${num(g.n_experiments)}</b> experiments</span>
        <span><b>${num(g.total_decided)}</b> decided</span>
        <span class="${g.n_conclusive ? "good" : ""}"><b>${num(g.n_conclusive)}</b> conclusive</span>
      </div>
    </div>
    <div class="exp-grid">${g.experiments.map(experimentCard).join("")}</div>
  </section>`;
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
    const programs = data.programs || [];
    main.innerHTML = programs.length
      ? programs.map(programSection).join("")
      : `<p class="muted">No experiments with data yet.</p>`;
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
