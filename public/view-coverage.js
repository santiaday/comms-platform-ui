// Pipeline coverage: every source producing communications, and whether we can
// actually measure it.
//
// The distinction this screen exists to protect: "not measured" is not 0%. A
// source with sends and no event feed is unmeasured, and reading that as zero
// engagement is how an eight-day HubSpot outage went unnoticed.

import { $, esc, icon, pct, num, plural, chanChip, timeAgo } from "./fmt.js";
import { loadCoverage, skeleton } from "./data.js";

function flagChips(row) {
  const flags = row.flags ?? [];
  if (!flags.length) return `<span class="chip ok">${icon("check", 12)} healthy</span>`;
  return flags.map((f) =>
    `<span class="chip ${esc(f.tone)}" title="${esc(f.hint)}">${esc(f.label)}</span>`).join(" ");
}

const NO_ENGAGEMENT_HINT =
  "No click or reply feed exists for this source, so the rate is unknown, not zero";
/** An unmeasured cell must never look like a zero. */
const unmeasured = (hint) => `<em class="tiny muted" title="${esc(hint)}">not measured</em>`;

async function viewCoverage(view) {
  view.innerHTML = skeleton(220);
  const body = await loadCoverage();
  const rows = body?.coverage ?? [];
  const real = rows.filter((r) => !r.is_test);
  const test = rows.filter((r) => r.is_test);
  const broken = real.filter((r) => r.health === "broken");
  $("#nav-cov-count").textContent = broken.length ? String(broken.length) : "";

  const RANK = { broken: 0, degraded: 1, unknown: 2, ok: 3 };
  const table = (list, caption, note) => !list.length ? "" : `
    <div class="card">
      <div class="card-head"><h2>${esc(caption)}</h2><span class="spacer"></span>
        <span class="tiny muted">${plural(list.length, "source")}</span></div>
      ${note ? `<div class="card-body" style="padding-bottom:0"><p class="tiny muted">${note}</p></div>` : ""}
      <div class="card-body tight scroll-x">
        <table class="grid"><thead><tr>
          <th>Source</th><th>Channel</th><th class="num">Comms</th><th class="num">People</th>
          <th>Last seen</th><th class="num">Delivered</th><th class="num">Clicked</th>
          <th class="num">Replied</th><th class="num">Engaged</th><th class="num">Joinable</th>
          <th>Health</th>
        </tr></thead><tbody>
        ${[...list].sort((a, b) => (RANK[a.health] ?? 9) - (RANK[b.health] ?? 9)
            || Number(b.n_communications ?? 0) - Number(a.n_communications ?? 0)).map((r) => `
          <tr class="clickable" tabindex="0" data-href="#/messages?source_key=${encodeURIComponent(r.source_key)}">
            <td><strong>${esc(r.source_key)}</strong>
              ${r.display_name ? `<div class="tiny muted">${esc(r.display_name)}</div>` : ""}</td>
            <td>${chanChip(r.channel)}</td>
            <td class="num" title="${num(r.n_inbound)} inbound">${num(r.n_communications)}</td>
            <td class="num">${num(r.n_recipients)}</td>
            <td class="nowrap tiny" title="${esc(r.last_seen ?? "never")}">${esc(timeAgo(r.last_seen))}</td>
            <td class="num">${r.no_delivery_feed
              ? unmeasured("No delivered events exist for this source, so the rate is unknown rather than zero")
              : `<span title="${num(r.n_delivered)} delivered">${pct(r.pct_delivered)}</span>`}</td>
            <td class="num">${r.no_engagement_feed ? unmeasured(NO_ENGAGEMENT_HINT)
              : `<span title="${num(r.n_clicked)} clicked">${pct(r.pct_clicked)}</span>`}</td>
            <td class="num">${r.no_engagement_feed ? unmeasured(NO_ENGAGEMENT_HINT)
              : `<span title="${num(r.n_replied)} replied">${pct(r.pct_replied)}</span>`}</td>
            <td class="num">${r.no_engagement_feed ? unmeasured(NO_ENGAGEMENT_HINT)
              : `<strong title="${num(r.n_engaged)} clicked or replied">${pct(r.pct_engaged)}</strong>`}</td>
            <td class="num" title="Share of sends that can be joined to an outcome">${pct(r.pct_outcome_joinable)}</td>
            <td>${flagChips(r)}</td>
          </tr>`).join("")}
        </tbody></table>
      </div>
    </div>`;

  view.innerHTML = `
    <div class="page-head">
      <h2>Pipeline coverage</h2>
      <p>Every source producing communications, and whether we can actually measure it.</p>
    </div>
    ${body?.ok === false ? `<div class="banner">${icon("alert")} ${esc(body.error ?? "coverage unavailable")}</div>` : ""}
    ${broken.length ? `<div class="banner warn">${icon("alert")}
      ${plural(broken.length, "source")} cannot be measured end to end — hover a badge for why.</div>` : ""}
    ${table(real, "Live sources")}
    ${table(test, "Test sources", "Excluded from every health roll-up above.")}
    <p class="tiny muted foot">
      <strong>Engaged = clicked or replied</strong> — the only signals that carry a human decision.
      Delivery is not engagement, and opens are MPP-inflated by 15–40%, so neither counts as one.
      <em>not measured</em> means no feed exists for that signal; it is never the same as 0%.</p>`;
}

export { viewCoverage, flagChips };
