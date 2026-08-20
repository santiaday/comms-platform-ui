// The Experiments view, and the small model that reads an experiment card.
//
// Two ideas carry this whole screen: uncertainty is drawn rather than described,
// and a verdict has to say how far from conclusive it is — "not conclusive"
// twenty times over is what made the previous version unreadable.

import { $, esc, icon, pct, num, plural, chanChip, timeAgo, humanOutcome } from "./fmt.js";
import { intervalBar, stackBar, funnel } from "./charts.js";
import { state, loadMetrics, errorBanner, skeleton } from "./data.js";

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

const bestRate = (c) => (c.variants ?? []).reduce((b, v) => (v.rate ?? -1) > (b ?? -1) ? v.rate : b, null);
const shortOf = (c, variantKey) =>
  (c.variants ?? []).find((v) => v.variant_key === variantKey)?.short_key ?? variantKey ?? "—";

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

export { viewExperiments, distinctVariants, liveVariants, isLive, primaryOf, verdict };
