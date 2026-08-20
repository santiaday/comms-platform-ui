/* ============================================================================
   Communications Hub — single-page app.

   Written for one reader: the person who opens this every morning and needs to
   know, in seconds, whether anything requires action. Every decision below
   serves that.

   * Real routes. Hash routing gives every view a shareable URL and a history
     entry, so the browser Back button steps back instead of closing the window.
   * Uncertainty is drawn, not described. "27.6% vs 25.0%" reads as a real gap
     in a table; drawing both Wilson intervals on one scale shows they overlap
     almost entirely, which is why nearly every experiment here is honestly
     "not conclusive".
   * Dormant arms and experiments are demoted, never interleaved. A retired arm
     sitting beside a running one, styled identically, is how you end up reading
     SMS variant B as if it still mattered.
   * Opening a message opens the conversation. A lone message with no thread
     around it was the ledger's central failure.

   No dependencies, no build step, no external requests — one HTML, one CSS, one
   JS, which is also what keeps it working behind a strict CSP.
   ========================================================================= */

// ------------------------------------------------------------------ helpers
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (id, size = 16) =>
  `<svg class="icon" width="${size}" height="${size}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
// Postgres numeric and bigint arrive over JSON as strings, so every figure is
// coerced before it is formatted. "0.1914" must not render as "0.1914%".
const pct = (x, dp = 1) => {
  if (x == null || x === "") return "—";
  const n = Number(x);
  return Number.isFinite(n) ? `${(n * 100).toFixed(dp)}%` : "—";
};
const num = (v) => {
  if (v == null || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString() : "—";
};
const plural = (n, one, many = `${one}s`) => `${num(n)} ${Number(n) === 1 ? one : many}`;

const CHANNEL = {
  email: { icon: "mail", cls: "email", label: "Email", colour: "var(--ch-email)" },
  sms:   { icon: "sms",  cls: "sms",   label: "SMS",   colour: "var(--ch-sms)" },
};
const chan = (c) => CHANNEL[c] ?? { icon: "chat", cls: "", label: c ?? "—", colour: "var(--n-400)" };
const chanChip = (c) => {
  const k = chan(c);
  return `<span class="chip ${k.cls}">${icon(k.icon, 12)} ${esc(k.label)}</span>`;
};

function timeAgo(iso) {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return "—";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const fmtTime = (iso) => iso
  ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
const fmtDay = (iso) => iso
  ? new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : "—";
/** "08-20" from an ISO date string, without letting the local timezone shift it. */
const dayTick = (ymd) => String(ymd ?? "").slice(5);

/**
 * Undo JSON escaping that reached the database as literal text.
 *
 * 7 of the 142 stored inbound bodies contain the characters backslash-u-2-0-1-C
 * rather than a curly quote, and 7 contain a literal backslash-n rather than a
 * newline — the reply payload was stringified once too often on the way in. A
 * reader should not have to decode that by eye, so it is undone here.
 *
 * This is a rendering plaster, not the fix: the ingest path is where the
 * double-encoding happens and where it should be corrected. Decoding on read
 * is safe in the meantime because the output is inserted as text, never HTML.
 */
function decodeStored(text) {
  if (typeof text !== "string" || !text.includes("\\")) return text;
  // One pass, so an escaped backslash cannot be mistaken for the start of an
  // escape sequence.
  return text.replace(/\\(u[0-9a-fA-F]{4}|[nrtbf"'\/\\])/g, (m, g) => {
    if (g[0] === "u") return String.fromCharCode(parseInt(g.slice(1), 16));
    return { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[g] ?? g;
  });
}

// ------------------------------------------------------------------- charts
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

// --------------------------------------------------------------- data layer
const state = {
  metrics: null,          // { programs: ProgramGroup[], pulse: PulseDay[], ... }
  metricsError: null,
  coverage: null,
  archiveOpen: new Set(), // program keys whose retired experiments are expanded
  loading: false,
};

async function getJson(url) {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    return await r.json();
  } catch (e) {
    return { ok: false, error: `request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function loadMetrics(force = false) {
  if (state.metrics && !force) return state.metrics;
  const body = await getJson("/api/metrics");
  if (body?.ok === true) { state.metrics = body; state.metricsError = null; }
  else { state.metrics = null; state.metricsError = body?.error ?? "metrics unavailable"; }
  return state.metrics;
}
async function loadCoverage(force = false) {
  if (state.coverage && !force) return state.coverage;
  state.coverage = await getJson("/api/ledger/coverage");
  return state.coverage;
}

// ---------------------------------------------------------- experiment model
/** Distinct arms across an experiment's components. The same arm appears once
    per component (primary and secondary), so this must dedupe or a two-arm test
    reports four. */
function distinctVariants(card) {
  const seen = new Map();
  for (const c of card.components ?? []) {
    for (const v of c.variants ?? []) {
      if (v.variant_key && !seen.has(v.variant_key)) seen.set(v.variant_key, v);
    }
  }
  return [...seen.values()];
}
const liveVariants = (card) => distinctVariants(card).filter((v) => v.live);
const isLive = (card) => (card.components ?? []).some((c) => (c.live_variants ?? 0) > 0);
const primaryOf = (card) => (card.components ?? [])[0] ?? null;

/**
 * One line a human can act on.
 *
 * "Not conclusive" repeated twenty times is what made the old dashboard
 * unreadable — it never said how far from conclusive, or whether the sample was
 * even large enough to ask the question.
 */
function verdict(c, card) {
  if (!c) return { tone: "waiting", icon: "clock", text: "no data yet" };
  const decided = (c.variants ?? []).reduce((a, v) => a + (v.denominator ?? 0), 0);
  const arms = (c.variants ?? []).filter((v) => v.live).length || (c.variants ?? []).length;
  if (card?.single_arm || arms < 2) {
    return { tone: "single", icon: "info",
      text: decided ? `single arm — ${pct(bestRate(c))} of ${plural(decided, "outcome")}` : "single arm, no outcomes yet" };
  }
  if (decided < 30) {
    return { tone: "thin", icon: "clock", text: `too thin — ${decided} of ~30 decided outcomes needed` };
  }
  const need = c.confidence_threshold ?? 0.95;
  if (c.conclusive) {
    return { tone: "conclusive", icon: "check",
      text: `winner: ${esc(shortOf(c, c.leader))} at ${pct(c.prob_leader_best, 0)} confidence` };
  }
  const gap = Math.max(0, Math.round((need - (c.prob_leader_best ?? 0)) * 100));
  return { tone: "waiting", icon: "clock",
    text: `no winner yet — leader at ${pct(c.prob_leader_best, 0)}, needs ${pct(need, 0)} (${gap}pp to go)` };
}
/** "converted_to_opp" -> "Converted to opp". The raw key stays alongside it, so
    nothing is lost by making the headline readable. */
const humanOutcome = (t) => {
  if (!t) return "outcome";
  const w = String(t).replace(/_/g, " ");
  return w.charAt(0).toUpperCase() + w.slice(1);
};
const bestRate = (c) => (c.variants ?? []).reduce((b, v) => (v.rate ?? -1) > (b ?? -1) ? v.rate : b, null);
const shortOf = (c, variantKey) =>
  (c.variants ?? []).find((v) => v.variant_key === variantKey)?.short_key ?? variantKey ?? "—";

// ------------------------------------------------------------------- router
const ROUTES = ["overview", "experiments", "messages", "coverage", "thread"];
const TITLES = { overview: "Overview", experiments: "Experiments", messages: "Messages",
                 coverage: "Coverage", thread: "Conversation" };

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, qs] = raw.split("?");
  const seg = (path || "overview").split("/").filter(Boolean);
  const name = ROUTES.includes(seg[0]) ? seg[0] : "overview";
  return { name, arg: seg[1] ?? null, params: new URLSearchParams(qs ?? "") };
}
const go = (hash) => { location.hash = hash; };

async function render() {
  const route = parseHash();
  document.title = `${TITLES[route.name]} · Comms Hub`;
  $("#page-title").textContent = TITLES[route.name];
  for (const b of document.querySelectorAll(".navitem[data-route]")) {
    b.toggleAttribute("aria-current", b.dataset.route === route.name);
    if (b.dataset.route === route.name) b.setAttribute("aria-current", "page");
  }
  const view = $("#view");
  view.setAttribute("aria-busy", "true");
  try {
    if (route.name === "experiments")   await viewExperiments(view);
    else if (route.name === "messages") await viewMessages(view, route);
    else if (route.name === "coverage") await viewCoverage(view);
    else if (route.name === "thread")   await viewThread(view, route);
    else                                await viewOverview(view);
  } catch (err) {
    view.innerHTML = `<div class="banner">${icon("alert")} Could not render this view: ${esc(err?.message ?? err)}</div>`;
  }
  view.setAttribute("aria-busy", "false");
  stampFreshness();
  if (route.name !== "thread") window.scrollTo({ top: 0 });
}

const errorBanner = () => state.metricsError
  ? `<div class="banner">${icon("alert")} ${esc(state.metricsError)}</div>` : "";
const skeleton = (h) => `<div class="skeleton" style="height:${h}px"></div>`;

// ----------------------------------------------------------------- overview
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
function flagChips(row) {
  const flags = row.flags ?? [];
  if (!flags.length) return `<span class="chip ok">${icon("check", 12)} healthy</span>`;
  return flags.map((f) =>
    `<span class="chip ${esc(f.tone)}" title="${esc(f.hint)}">${esc(f.label)}</span>`).join(" ");
}

// -------------------------------------------------------------- experiments
async function viewExperiments(view) {
  view.innerHTML = skeleton(140);
  const m = await loadMetrics();
  const groups = m?.programs ?? [];
  const totalLive = groups.reduce((a, g) => a + (g.experiments ?? []).filter(isLive).length, 0);
  const totalDormant = groups.reduce((a, g) => a + (g.experiments ?? []).filter((c) => !isLive(c)).length, 0);
  $("#nav-exp-count").textContent = totalLive ? String(totalLive) : "";

  view.innerHTML = `
    ${errorBanner()}
    <div class="page-head">
      <h2>Experiments</h2>
      <p>${plural(totalLive, "experiment")} sending${totalDormant ? ` · ${plural(totalDormant, "retired one")} tucked away` : ""}.
         Bars span the 95% interval — where they overlap, the difference isn't real yet.</p>
    </div>
    ${groups.length ? groups.map(programBlock).join("")
      : `<div class="card"><div class="empty">${icon("flask", 28)}
           <div>No experiments are reporting.</div></div></div>`}`;
}

function programBlock(g) {
  const live = (g.experiments ?? []).filter(isLive);
  const dormant = (g.experiments ?? []).filter((c) => !isLive(c));
  // Decided first, then by weight of evidence: the top of each program is
  // always the card most worth reading.
  const sorted = [...live].sort((a, b) => {
    const ca = (a.components ?? []).some((c) => c.conclusive) ? 0 : 1;
    const cb = (b.components ?? []).some((c) => c.conclusive) ? 0 : 1;
    return ca - cb || b.primary_denominator - a.primary_denominator;
  });
  const open = state.archiveOpen.has(g.program);
  return `<section class="program">
    <header class="program-head">
      <h3>${esc(g.label)}</h3>
      <span class="chip${live.length ? " ok" : ""}">${live.length ? `${live.length} live` : "none live"}</span>
      ${g.n_conclusive ? `<span class="chip ok">${g.n_conclusive} decided</span>` : ""}
      <span class="spacer"></span>
      <span class="tiny muted">${num(g.total_decided)} decided outcomes</span>
    </header>
    ${sorted.length ? sorted.map((c, i) => expCard(c, false, i === 0 || hasVerdict(c))).join("")
      : `<p class="tiny muted" style="margin:0 2px 10px">Nothing sending in this program right now.</p>`}
    ${dormant.length ? `
      <div class="archive">
        <button class="archive-toggle" data-archive="${esc(g.program)}">
          ${icon("archive", 14)} ${open ? "Hide" : "Show"} ${plural(dormant.length, "retired experiment")}
          <span class="tiny muted">— kept for history, not sending</span>
        </button>
        ${open ? dormant.map((c) => expCard(c, true, false)).join("") : ""}
      </div>` : ""}
  </section>`;
}

const hasVerdict = (card) => (card.components ?? []).some((c) => c.conclusive) && !card.single_arm;

function expCard(card, isArchive, expanded = !isArchive) {
  const primary = primaryOf(card);
  const v = verdict(primary, card);
  const live = liveVariants(card);
  return `<section class="card exp">
    <div class="exp-head" role="button" tabindex="0" data-toggle="exp"
         aria-expanded="${expanded}">
      <div style="min-width:0">
        <div class="exp-title">${esc(card.title)}</div>
        <div class="exp-sub">
          ${primary?.channel ? chanChip(primary.channel) : ""}
          ${card.experiment_key ? `<span class="chip mono">${esc(card.experiment_key)}</span>`
            : `<span class="chip warn" title="No experiment registered — these sends cannot be compared">untagged</span>`}
          ${live.length ? `<span class="chip ok">${plural(live.length, "live arm")}</span>`
            : `<span class="chip" title="${primary?.last_sent_at ? `last sent ${new Date(primary.last_sent_at).toLocaleString()}` : "no sends recorded"}">
                 ${primary?.last_sent_at ? `last sent ${esc(timeAgo(primary.last_sent_at))}` : "no sends"}</span>`}
          ${primary?.experiment_status && primary.experiment_status !== "running"
            ? `<span class="chip warn">${esc(primary.experiment_status)}</span>` : ""}
        </div>
      </div>
      <div class="exp-verdict">
        <span class="tiny muted nowrap">${num(card.primary_denominator)} decided</span>
        <span class="verdict ${v.tone}">${icon(v.icon, 13)} ${esc(v.text)}</span>
        ${icon("chev", 14)}
      </div>
    </div>
    <div class="exp-body"${expanded ? "" : " hidden"}>
      ${(card.components ?? []).map((c) => componentBlock(c, card, isArchive)).join("")}
      ${card.engagement?.length ? engagementBlock(card) : ""}
    </div>
  </section>`;
}

function componentBlock(c, card, isArchive) {
  const all = (c.variants ?? []);
  // Hide retired arms inside a running experiment — that is precisely the
  // "why am I looking at SMS variant B" problem. The archive shows everything.
  const shown = isArchive ? all : all.filter((v) => v.live);
  const use = shown.length ? shown : all;
  const hidden = all.length - use.length;
  const ranked = [...use].sort((a, b) => (b.prob_best ?? 0) - (a.prob_best ?? 0));
  const max = Math.min(1, Math.max(0.02, ...use.map((v) => v.wilson_high ?? v.rate ?? 0)) * 1.12);
  const bestProb = Math.max(...use.map((v) => v.prob_best ?? 0));
  const decided = use.reduce((a, v) => a + v.denominator, 0);

  return `<div class="component">
    <div class="component-head">
      <span class="chip ${c.rank === 1 ? "info" : ""}">${c.rank === 1 ? "Primary" : "Secondary"}</span>
      <span class="what">${esc(humanOutcome(c.outcome_type))}</span>
      <span class="tiny muted mono">${esc(c.outcome_type)} · ${esc(c.eval_mode)}</span>
      <span class="spacer"></span>
      <span class="tiny muted">${num(decided)} decided${hidden ? ` · ${hidden} retired hidden` : ""}</span>
    </div>
    <div class="arms">
      ${ranked.map((v) => {
        const leader = use.length > 1 && (v.prob_best ?? 0) === bestProb;
        return `<div class="arm ${leader ? "leader" : ""}">
          <div class="arm-name">
            <span class="label" title="${esc(v.variant_key ?? "untagged")}">${esc(v.short_key || "untagged")}</span>
            ${v.live ? "" : `<span class="chip">retired</span>`}
            ${v.split_pct != null ? `<span class="chip mono" title="Share of traffic right now">${esc(v.split_pct)}%</span>` : ""}
          </div>
          <div class="arm-rate">${pct(v.rate)}</div>
          ${intervalBar(v, max, leader)}
          <div class="arm-vol" title="${num(v.showed)} attained, ${num(v.not_showed)} failed, ${num(v.pending)} still open">
            ${num(v.showed)}/${num(v.denominator)}${v.pending ? ` <span class="muted">+${num(v.pending)}</span>` : ""}
          </div>
          <div class="arm-bar">${stackBar(v.showed, v.not_showed, v.pending)}</div>
          <div class="arm-actions">
            ${v.variant_key ? `<button class="btn ghost tiny"
              data-href="#/messages?variant_key=${encodeURIComponent(v.variant_key)}"
              title="Every send of this arm">${icon("chat", 12)} sends</button>` : ""}
            ${v.variant_key ? `<button class="btn ghost tiny"
              data-href="#/messages?variant_key=${encodeURIComponent(v.variant_key)}&replied=true"
              title="Only the ones that got a reply">${icon("reply", 12)} replies</button>` : ""}
          </div>
        </div>`;
      }).join("")}
    </div>
    ${c.rank === 1 && use.length > 1 && !card.single_arm ? `<p class="tiny muted foot">
      P(best) ranks these arms; the bar is the Wilson 95% interval and the tick is the observed rate.
      Overlapping bars mean the gap is not yet distinguishable from noise.</p>` : ""}
    ${c.rank === 1 && card.single_arm ? `<p class="tiny muted foot">
      Only one arm is tagged here, so this is a rate to watch — not a race to win.</p>` : ""}
  </div>`;
}

function engagementBlock(card) {
  const rows = (card.engagement ?? []).filter((e) => e.sent > 0);
  if (!rows.length) return "";
  const keys = new Set(liveVariants(card).map((v) => v.variant_key));
  const live = rows.filter((r) => keys.has(r.variant_key));
  const use = live.length ? live : rows;
  return `<div class="component">
    <div class="component-head">
      <span class="chip">${icon("mail", 12)} Delivery &amp; engagement</span>
      <span class="spacer"></span>
      <span class="tiny muted">per arm, per email</span>
    </div>
    <div class="funnels">
      ${use.map((e) => `<div class="funnel-card">
        <div class="funnel-title">${esc(e.short_variant ?? shortFallback(e.variant_key, card.experiment_key))}</div>
        ${funnel(e)}
      </div>`).join("")}
    </div>
  </div>`;
}
/** Only used if engagement rows ever arrive without a server-computed name. */
const shortFallback = (variantKey, experimentKey) => {
  if (!variantKey) return "untagged";
  return experimentKey && variantKey.startsWith(experimentKey)
    ? (variantKey.slice(experimentKey.length).replace(/^-/, "") || variantKey)
    : variantKey;
};

// ------------------------------------------------------------------ messages
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

// ------------------------------------------------------------------ coverage
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

// ---------------------------------------------------------------------- boot
// One delegated listener for every navigation, so freshly rendered HTML never
// needs re-wiring. data-href navigates (pushing history, so Back steps back).
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-back]")) { e.preventDefault(); history.back(); return; }

  const nav = e.target.closest("[data-href]");
  if (nav) { e.preventDefault(); go(nav.dataset.href); return; }

  const routeBtn = e.target.closest(".navitem[data-route]");
  if (routeBtn) { e.preventDefault(); go(`#/${routeBtn.dataset.route}`); return; }

  const arch = e.target.closest("[data-archive]");
  if (arch) {
    const k = arch.dataset.archive;
    if (state.archiveOpen.has(k)) state.archiveOpen.delete(k); else state.archiveOpen.add(k);
    render();
    return;
  }

  const toggle = e.target.closest('[data-toggle="exp"]');
  if (toggle) {
    const body = toggle.parentElement?.querySelector(".exp-body");
    if (body) { body.hidden = !body.hidden; toggle.setAttribute("aria-expanded", String(!body.hidden)); }
  }
});

// Rows and card headers are focusable, so Enter and Space must do what a click does.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const t = e.target.closest("[data-href],[data-toggle],[data-archive],[data-back]");
  if (!t || t.tagName === "SELECT" || t.tagName === "INPUT") return;
  e.preventDefault();
  t.click();
});

$("#refresh").onclick = async () => {
  const btn = $("#refresh");
  btn.disabled = true;
  state.metrics = null; state.coverage = null;
  await render();
  btn.disabled = false;
};

// Theme: an explicit choice persists and wins in both directions; with no
// choice stored the page follows the OS.
const THEME_KEY = "comms-hub-theme";
const saved = localStorage.getItem(THEME_KEY);
if (saved === "dark" || saved === "light") document.documentElement.dataset.theme = saved;
$("#theme").onclick = () => {
  const cur = document.documentElement.dataset.theme
    ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
};

function stampFreshness() {
  const at = state.metrics?.computed_at;
  $("#updated").textContent = at ? `updated ${timeAgo(at)}` : "";
}

window.addEventListener("hashchange", render);

(function boot() {
  if (!location.hash) history.replaceState(null, "", "#/overview");
  render();
  setInterval(stampFreshness, 15000);
})();
