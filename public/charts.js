// Charts. All inline SVG: no chart library, so there is nothing to load, nothing
// to version, and nothing blocked by a strict CSP. A fixed viewBox scaled to
// 100% width keeps text crisp and proportional without a layout pass.

import { esc, pct, num, icon, dayTick } from "./fmt.js";

// All inline SVG. A fixed viewBox scaled to 100% width keeps text crisp and
// proportional without a layout pass or a chart library.

/**
 * Volume and answer rate over time, on one canvas.
 *
 * Volume alone doesn't answer "is this working"; reply rate alone hides that a
 * great rate came off nine sends. Stacked bars carry the channel mix, the line
 * carries the answer rate, and putting them together means one glance covers
 * both — including the case where volume climbs while replies flatten.
 */
function volumeChart(days) {
  if (!days.length) {
    return `<div class="empty">${icon("pulse", 28)}<div>No sends in the last 14 days.</div></div>`;
  }
  const W = 760, H = 200, L = 42, R = 46, T = 16, B = 30;
  const iw = W - L - R, ih = H - T - B;
  const maxSends = Math.max(1, ...days.map((d) => d.email + d.sms));
  const step = niceStep(maxSends);
  const top = Math.ceil(maxSends / step) * step;
  const maxRate = Math.max(0.1, ...days.map((d) => d.rate ?? 0)) * 1.2;

  const bw = Math.min(30, (iw / days.length) * 0.62);
  const cx = (i) => L + (iw / days.length) * (i + 0.5);
  const y = (v) => T + ih - (v / top) * ih;
  const yr = (v) => T + ih - (v / maxRate) * ih;

  const grid = [];
  for (let v = 0; v <= top; v += step) {
    grid.push(`<line x1="${L}" y1="${y(v).toFixed(1)}" x2="${W - R}" y2="${y(v).toFixed(1)}"
      stroke="var(--border)" stroke-width="1"/>`);
    grid.push(`<text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end"
      class="ax">${v}</text>`);
  }

  const bars = days.map((d, i) => {
    const x = (cx(i) - bw / 2).toFixed(1);
    const hE = ((d.email / top) * ih).toFixed(1);
    const hS = ((d.sms / top) * ih).toFixed(1);
    const yS = y(d.email + d.sms).toFixed(1);
    const yE = y(d.email).toFixed(1);
    return `<g><title>${esc(d.day)} — ${d.email + d.sms} sent (${d.email} email, ${d.sms} SMS), ${d.replied} answered${d.rate == null ? "" : ` (${(d.rate * 100).toFixed(0)}%)`}</title>
      ${d.sms   ? `<rect x="${x}" y="${yS}" width="${bw.toFixed(1)}" height="${hS}" fill="var(--ch-sms)" opacity=".9" rx="2"/>` : ""}
      ${d.email ? `<rect x="${x}" y="${yE}" width="${bw.toFixed(1)}" height="${hE}" fill="var(--ch-email)" opacity=".9" rx="2"/>` : ""}
    </g>`;
  }).join("");

  const pts = days.map((d, i) => (d.rate == null ? null : [cx(i), yr(d.rate)])).filter(Boolean);
  const line = pts.length > 1
    ? `<path d="${pts.map(([x, yy], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${yy.toFixed(1)}`).join(" ")}"
         fill="none" stroke="var(--brand)" stroke-width="2" stroke-linejoin="round"/>` : "";
  const dots = pts.map(([x, yy]) => `<circle cx="${x.toFixed(1)}" cy="${yy.toFixed(1)}" r="2.8"
    fill="var(--surface)" stroke="var(--brand)" stroke-width="1.8"/>`).join("");

  const ticks = days.map((d, i) =>
    (days.length <= 8 || i % 2 === (days.length - 1) % 2)
      ? `<text x="${cx(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" class="ax">${esc(dayTick(d.day))}</text>`
      : "").join("");

  return `
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
         aria-label="Daily send volume by channel with reply rate">
      ${grid.join("")}${bars}${line}${dots}${ticks}
      <text x="${W - R + 8}" y="${(yr(maxRate) + 10).toFixed(1)}" class="ax">${(maxRate * 100).toFixed(0)}%</text>
      <text x="${W - R + 8}" y="${(T + ih + 4).toFixed(1)}" class="ax">0%</text>
    </svg>
    <div class="legend">
      <span><i style="background:var(--ch-email)"></i> Email</span>
      <span><i style="background:var(--ch-sms)"></i> SMS</span>
      <span><i class="line" style="background:var(--brand)"></i> Sends answered</span>
    </div>`;
}
function niceStep(max) {
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
}

/**
 * The Wilson interval, drawn. The most important graphic here.
 *
 * The bar spans the 95% interval and the tick marks the observed rate. Two arms
 * share one scale, so overlapping bars say "not distinguishable from noise"
 * without anyone having to read a p-value.
 */
function intervalBar(v, max, leader) {
  if (v.rate == null) return `<div class="tiny muted">no decided outcomes yet</div>`;
  const s = (x) => Math.max(0, Math.min(100, ((x ?? v.rate) / max) * 100));
  const lo = s(v.wilson_low), hi = s(v.wilson_high), mid = s(v.rate);
  const colour = leader ? "var(--brand)" : "var(--n-400)";
  return `<div class="arm-interval">
    <svg viewBox="0 0 100 18" preserveAspectRatio="none" role="img"
         aria-label="${pct(v.rate)}, 95% range ${pct(v.wilson_low)} to ${pct(v.wilson_high)}">
      <line x1="0" y1="9" x2="100" y2="9" stroke="var(--border)" vector-effect="non-scaling-stroke"/>
      <rect x="${lo.toFixed(2)}" y="5" width="${Math.max(hi - lo, 0.5).toFixed(2)}" height="8"
            fill="${colour}" opacity=".26" rx="1"/>
      <line x1="${mid.toFixed(2)}" y1="2.5" x2="${mid.toFixed(2)}" y2="15.5" stroke="${colour}"
            stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linecap="round"/>
    </svg>
  </div>`;
}

/** Attained / failed / still-pending as one proportional bar. */
function stackBar(hit, miss, pending) {
  const total = hit + miss + pending;
  if (!total) return "";
  const w = (n) => ((n / total) * 100).toFixed(2);
  return `<svg class="stackbar" viewBox="0 0 100 5" preserveAspectRatio="none" role="img"
      aria-label="${hit} attained, ${miss} failed, ${pending} pending">
    <rect x="0" y="0" width="${w(hit)}" height="5" fill="var(--ok)"/>
    <rect x="${w(hit)}" y="0" width="${w(miss)}" height="5" fill="var(--bad)" opacity=".5"/>
    <rect x="${Number(w(hit)) + Number(w(miss))}" y="0" width="${w(pending)}" height="5" fill="var(--n-300)"/>
  </svg>`;
}

/**
 * Email engagement as a funnel.
 *
 * Opens sit in here greyed and labelled, not omitted: Apple Mail Privacy
 * Protection inflates them 15–40%, so they are directional at best. Clicks and
 * replies are the rows that carry a decision.
 */
function funnel(e) {
  const steps = [
    ["Sent", e.sent, null, false],
    ["Delivered", e.delivered, e.delivery_rate, false],
    ["Opened", e.opened, e.open_rate, true],
    ["Clicked", e.clicked, e.click_rate, false],
    ["Replied", e.replied, e.reply_rate, false],
  ];
  const base = Math.max(1, e.sent);
  return `<div class="funnel">
    ${steps.map(([label, n, rate, soft]) => `
      <div class="funnel-row ${soft ? "soft" : ""}">
        <span class="fl"${soft ? ' title="Apple Mail Privacy Protection inflates opens by 15-40%, so this row is directional only"' : ""}>${esc(label)}${soft ? " *" : ""}</span>
        <span class="fbar"><i style="width:${((n / base) * 100).toFixed(1)}%"></i></span>
        <span class="fn num">${num(n)}</span>
        <span class="fr num tiny muted">${rate == null ? "" : pct(rate, 1)}</span>
      </div>`).join("")}
    <div class="funnel-note tiny muted">* Opens are MPP-inflated by 15–40% — directional only.
      Clicks and replies are the rows that carry a decision.</div>
    ${e.bounced || e.unsubscribed || e.complained ? `
      <div class="funnel-neg tiny">
        ${e.bounced ? `<span class="chip bad">${num(e.bounced)} bounced${e.bounce_rate == null ? "" : ` · ${pct(e.bounce_rate)}`}</span>` : ""}
        ${e.unsubscribed ? `<span class="chip warn">${num(e.unsubscribed)} unsubscribed</span>` : ""}
        ${e.complained ? `<span class="chip bad">${num(e.complained)} complained</span>` : ""}
      </div>` : ""}
  </div>`;
}

export { volumeChart, intervalBar, stackBar, funnel };
