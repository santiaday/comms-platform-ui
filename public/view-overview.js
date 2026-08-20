// The Overview: the one screen that has to answer "does anything need me today"
// before anything else is read.

import { esc, icon, pct, num, plural, chanChip, dayTick } from "./fmt.js";
import { volumeChart } from "./charts.js";
import { loadMetrics, loadCoverage, errorBanner, skeleton } from "./data.js";
import { isLive, verdict } from "./view-experiments.js";
import { flagChips } from "./view-coverage.js";

async function viewOverview(view) {
  view.innerHTML = skeleton(96);
  const [m, cov] = await Promise.all([loadMetrics(), loadCoverage()]);

  // Pulse arrives as one row per day per channel; the chart wants one row per
  // day with the channel split alongside.
  const byDay = new Map();
  for (const p of m?.pulse ?? []) {
    const d = byDay.get(p.day) ?? { day: p.day, email: 0, sms: 0, replied: 0 };
    if (p.channel === "email") d.email += p.sends;
    else if (p.channel === "sms") d.sms += p.sends;
    else d.email += p.sends;
    d.replied += p.replied_sends;
    byDay.set(p.day, d);
  }
  const days = [...byDay.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => ({ ...d, total: d.email + d.sms, rate: (d.email + d.sms) ? d.replied / (d.email + d.sms) : null }));
  const latest = days[days.length - 1] ?? { total: 0, replied: 0, rate: null, email: 0, sms: 0 };
  const total14 = days.reduce((a, d) => a + d.total, 0);
  const replied14 = days.reduce((a, d) => a + d.replied, 0);

  const groups = m?.programs ?? [];
  const cards = groups.flatMap((g) => g.experiments ?? []);
  const liveCards = cards.filter(isLive);
  const conclusive = liveCards.filter((c) => (c.components ?? []).some((x) => x.conclusive && !c.single_arm));

  const covRows = (cov?.coverage ?? []).filter((r) => !r.is_test);
  const broken = covRows.filter((r) => r.health === "broken");
  const degraded = covRows.filter((r) => r.health === "degraded");

  view.innerHTML = `
    ${errorBanner()}
    ${m?.pulse_error ? `<div class="banner warn">${icon("alert")} Volume unavailable: ${esc(m.pulse_error)}</div>` : ""}
    <div class="page-head">
      <h2>Today at a glance</h2>
      <p>What went out, who answered, and whether anything needs you.</p>
    </div>

    <div class="stats">
      <div class="stat">
        <div class="stat-label">${icon("pulse", 13)} Sent ${days.length ? esc(dayTick(latest.day)) : "today"}</div>
        <div class="stat-value">${num(latest.total)}</div>
        <div class="stat-sub">${latest.email} email · ${latest.sms} SMS</div>
      </div>
      <div class="stat">
        <div class="stat-label">${icon("reply", 13)} Answered</div>
        <div class="stat-value">${num(latest.replied)}</div>
        <div class="stat-sub">${latest.rate == null ? "—" : `${pct(latest.rate)} of today's sends`}</div>
      </div>
      <div class="stat ${conclusive.length ? "accent" : ""}">
        <div class="stat-label">${icon("flask", 13)} Live experiments</div>
        <div class="stat-value">${num(liveCards.length)}</div>
        <div class="stat-sub">${conclusive.length ? `${conclusive.length} reached a verdict` : "none conclusive yet"}</div>
      </div>
      <div class="stat ${broken.length ? "danger" : ""}">
        <div class="stat-label">${icon(broken.length ? "alert" : "check", 13)} Source health</div>
        <div class="stat-value">${broken.length ? num(broken.length) : "OK"}</div>
        <div class="stat-sub">${broken.length
          ? `unmeasurable of ${covRows.length}`
          : degraded.length ? `${degraded.length} degraded of ${covRows.length}` : `all ${covRows.length} sources measurable`}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Last 14 days</h2><span class="spacer"></span>
        <span class="tiny muted">${num(total14)} sent · ${num(replied14)} answered
          ${total14 ? `· ${pct(replied14 / total14)}` : ""}</span>
      </div>
      <div class="card-body">${volumeChart(days)}</div>
    </div>

    ${conclusive.length ? `
    <div class="card">
      <div class="card-head"><h2>${icon("check")} Decided — worth acting on</h2></div>
      <div class="card-body tight">
        ${conclusive.map((card) => {
          const c = (card.components ?? []).find((x) => x.conclusive);
          const v = verdict(c, card);
          return `<button class="rowlink" data-href="#/experiments">
            <span class="rowlink-main">
              <span class="rowlink-title">${esc(card.title)}</span>
              <span class="rowlink-sub">${esc(card.program_label)}</span>
            </span>
            <span class="verdict ${v.tone}">${icon(v.icon, 13)} ${esc(v.text)}</span>
            ${icon("chev", 14)}
          </button>`;
        }).join("")}
      </div>
    </div>` : ""}

    ${broken.length || degraded.length ? `
    <div class="card">
      <div class="card-head">
        <h2>${icon("alert")} Measurement gaps</h2><span class="spacer"></span>
        <button class="btn ghost tiny" data-href="#/coverage">All sources ${icon("chev", 12)}</button>
      </div>
      <div class="card-body tight scroll-x">
        <table class="grid"><thead><tr>
          <th>Source</th><th>Channel</th><th class="num">Comms</th><th>Problem</th>
        </tr></thead><tbody>
          ${[...broken, ...degraded].slice(0, 8).map((r) => `<tr class="clickable" tabindex="0"
              data-href="#/messages?source_key=${encodeURIComponent(r.source_key)}">
            <td><strong>${esc(r.source_key)}</strong></td>
            <td>${chanChip(r.channel)}</td>
            <td class="num">${num(r.n_communications)}</td>
            <td>${flagChips(r)}</td></tr>`).join("")}
        </tbody></table>
      </div>
    </div>` : ""}

    <div class="card">
      <div class="card-head"><h2>Programs</h2><span class="spacer"></span>
        <button class="btn ghost tiny" data-href="#/experiments">Open experiments ${icon("chev", 12)}</button></div>
      <div class="card-body tight">
        ${groups.length ? groups.map((g) => {
          const l = (g.experiments ?? []).filter(isLive).length;
          return `<button class="rowlink" data-href="#/experiments">
            <span class="rowlink-main">
              <span class="rowlink-title">${esc(g.label)}</span>
              <span class="rowlink-sub">${plural(l, "live experiment")} of ${g.n_experiments}
                · ${num(g.total_decided)} decided outcomes</span>
            </span>
            ${g.n_conclusive ? `<span class="chip ok">${g.n_conclusive} decided</span>` : `<span class="chip">running</span>`}
            ${icon("chev", 14)}
          </button>`;
        }).join("") : `<div class="empty">${icon("flask", 28)}<div>No programs reporting.</div></div>`}
      </div>
    </div>`;
}

/** Coverage flags, using the hints the server computed. */

export { viewOverview };
