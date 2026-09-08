// The Experiments view.
//
// One card = one experiment, in one audience, with its variations side by side.
//
// That grain took two goes to get right. DemoDriver-Model is a single registered
// experiment, but it runs as eighteen separate sends — one per cohort × touch ×
// segment — and each of those pits two variations against each other. Keying the
// ROWS on the variant key while pooling all eighteen audiences into one card
// produced a thirty-way leaderboard racing audiences against each other; keying
// them on the registry ARM instead produced one card with two rows and no
// head-to-head in it.
//
// Splitting the card by audience fixes both at once. Every card now shows the
// two things that were actually sent to the same kind of person, which is the
// only comparison that means anything, and the cross-audience roll-up moves to a
// single line at the top of the program where it belongs.

import { $, esc, icon, pct, num, plural, chanChip, humanOutcome } from "./fmt.js";
import { intervalBar, stackBar, funnel, effectBar } from "./charts.js";
import { state, loadMetrics, errorBanner, skeleton } from "./data.js";

const isLive = (card) => card.phase_is_current === true;
const primaryOf = (card) => (card.components ?? [])[0] ?? null;
const variationsOf = (c) => c?.variations ?? [];
const liveVariations = (card) => variationsOf(primaryOf(card)).filter((v) => v.live);

const signed = (v, dp = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(dp)}pp`;
const labelOf = (c, key) => variationsOf(c).find((v) => v.key === key)?.label ?? key ?? "—";

/** One line a human can act on. */
function verdict(c, card) {
  if (!c) return { tone: "waiting", icon: "clock", text: "no data yet" };
  const vars = variationsOf(c);
  const decided = vars.reduce((a, v) => a + (v.denominator ?? 0), 0);

  if (card?.single_arm || vars.length < 2) {
    const best = vars.reduce((b, v) => ((v.rate ?? -1) > (b ?? -1) ? v.rate : b), null);
    return { tone: "single", icon: "info",
      text: decided ? `not being tested — ${pct(best)} of ${plural(decided, "outcome")}`
                    : "not being tested, no outcomes yet" };
  }

  const e = c.effect;
  if (e && e.diff != null) {
    if (decided < 30) {
      return { tone: "thin", icon: "clock", text: `too thin — ${decided} of ~30 outcomes` };
    }
    if (c.conclusive) {
      return { tone: "conclusive", icon: "check",
        text: `${labelOf(c, c.leader)} wins by ${signed(Math.abs(e.diff))}` };
    }
    // NOT "diff ± half-width". The Newcombe interval is asymmetric, so that
    // restated [-32.6, +6.1] as [-29.4, +9.4] — a header quietly contradicting
    // the interval drawn six lines below it.
    return { tone: "waiting", icon: "clock",
      text: `too close to call — ${signed(e.diff)}, range ${signed(e.ci_low)} to ${signed(e.ci_high)}` };
  }

  // Three or more variations: no single lift, so P(best) is the honest summary.
  if (decided < 30) {
    return { tone: "thin", icon: "clock", text: `too thin — ${decided} of ~30 outcomes` };
  }
  const need = c.confidence_threshold ?? 0.95;
  if (c.conclusive) {
    return { tone: "conclusive", icon: "check",
      text: `winner: ${labelOf(c, c.leader)} at ${pct(c.prob_leader_best, 0)} confidence` };
  }
  const gap = Math.max(0, Math.round((need - (c.prob_leader_best ?? 0)) * 100));
  return { tone: "waiting", icon: "clock",
    text: `no winner yet — leader at ${pct(c.prob_leader_best, 0)}, needs ${pct(need, 0)} (${gap}pp to go)` };
}

/**
 * Reasons a card's two rates cannot be read straight off against each other.
 *
 * Note what this does NOT say any more. Both variations on a card went to the
 * same audience, so a lopsided split makes the comparison imprecise, not biased
 * — the earlier wording ("not drawn from the same pool of people") was true of
 * the pooled card and is wrong here.
 */
function integrityIssues(c) {
  if (!c?.srm?.mismatch) return [];
  const over = [...c.srm.arms].sort((a, b) => b.gap_pp - a.gap_pp)[0];
  const total = c.srm.arms.reduce((s, a) => s + a.observed, 0);
  return [{
    key: "srm",
    title: "One variation got far more of the traffic",
    body: `${esc(labelOf(c, over.arm))} took ${Math.round((over.observed / total) * 100)}% of the
           sends here, against the ${over.intended_pct}% registered for it. Both variations went to
           this same audience, so the comparison still holds — but it is a lopsided one, and the
           smaller side carries almost all of the uncertainty in the figure below.`,
  }];
}

async function viewExperiments(view) {
  view.innerHTML = skeleton(140);
  const m = await loadMetrics();
  const groups = m?.programs ?? [];
  const live = groups.flatMap((g) => (g.experiments ?? []).filter(isLive));
  const headToHead = live.filter((c) => !c.single_arm);
  $("#nav-exp-count").textContent = headToHead.length ? String(headToHead.length) : "";

  view.innerHTML = `
    ${errorBanner()}
    <div class="page-head">
      <h2>Experiments</h2>
      <p>${plural(headToHead.length, "live head-to-head")}${
        live.length - headToHead.length
          ? ` · ${plural(live.length - headToHead.length, "audience")} running one variation with nothing to compare against`
          : ""}.
         One card is one experiment in one audience, showing the variations that were actually sent
         to it. The difference is drawn against zero — a bar touching the dashed line is not a
         result yet.</p>
    </div>
    ${groups.length ? groups.map(programBlock).join("")
      : `<div class="card"><div class="empty">${icon("flask", 28)}
           <div>No experiments are reporting.</div></div></div>`}`;
}

function programBlock(g) {
  const live = (g.experiments ?? []).filter(isLive);
  const dormant = (g.experiments ?? []).filter((c) => !isLive(c));
  const tests = live.filter((c) => !c.single_arm);
  const untested = live.filter((c) => c.single_arm);
  const open = state.archiveOpen.has(g.program);
  const untestedOpen = state.archiveOpen.has(`${g.program}::untested`);

  return `<section class="program">
    <header class="program-head">
      <h3>${esc(g.label)}</h3>
      <span class="chip${tests.length ? " ok" : ""}">${
        tests.length ? `${tests.length} head-to-head` : "nothing being tested"}</span>
      ${g.n_conclusive ? `<span class="chip ok">${g.n_conclusive} decided</span>` : ""}
      <span class="spacer"></span>
      <span class="tiny muted">${num(g.total_decided)} decided outcomes</span>
    </header>
    ${(g.rollups ?? []).map(rollupBanner).join("")}
    ${tests.length ? tests.map((c, i) => expCard(c, false, i === 0)).join("")
      : `<p class="tiny muted" style="margin:0 2px 10px">Nothing is being A/B tested in this program right now.</p>`}
    ${untested.length ? `
      <div class="archive">
        <button class="archive-toggle" data-archive="${esc(g.program)}::untested">
          ${icon("chev", 14)} ${untestedOpen ? "Hide" : "Show"} the ${
            plural(untested.length, "audience")} running a single variation
          <span class="tiny muted">— nothing to compare against, so nothing to decide</span>
        </button>
        ${untestedOpen ? untested.map((c) => expCard(c, false, false)).join("") : ""}
      </div>` : ""}
    ${dormant.length ? `
      <div class="archive">
        <button class="archive-toggle" data-archive="${esc(g.program)}">
          ${icon("archive", 14)} ${open ? "Hide" : "Show"} ${plural(dormant.length, "finished comparison")}
          <span class="tiny muted">— kept for the record</span>
        </button>
        ${open ? dormant.map((c) => expCard(c, true, false)).join("") : ""}
      </div>` : ""}
  </section>`;
}

/**
 * The one thing worth saying about an experiment that spans many audiences.
 *
 * Pooling those audiences is how the AI copy came to look 2.5pp ahead when it is
 * about 1pp behind within them, so this states the within-audience figure and,
 * when they disagree, says the pooled one points the other way. It is a line,
 * not a card, because the cards below are where the decisions actually are.
 */
function rollupBanner(r) {
  if (r.diff == null) return "";
  const decisive = r.ci_low > 0 || r.ci_high < 0;
  return `<div class="rollup ${decisive ? "decisive" : ""}">
    ${icon(decisive ? "check" : "info", 15)}
    <div>
      <strong>${esc(r.contender_label)} vs ${esc(r.control_label)}, across all ${
        plural(r.n_strata_paired, "audience")}: ${signed(r.diff)}</strong>
      <div class="tiny">95% interval ${signed(r.ci_low)} to ${signed(r.ci_high)}, p = ${
        r.p_value < 0.001 ? "&lt;0.001" : r.p_value.toFixed(2)}, over ${num(r.n_comparable)} outcomes.
        ${esc(r.contender_label)} is ahead in ${r.contender_leads} of ${r.n_strata_paired}.
        ${r.simpson ? ` <strong>Pooling every send instead gives ${signed(r.pooled_diff)}, the opposite
          sign</strong> — the two were not given these audiences in the same proportions.` : ""}
        ${r.n_orphan ? ` A further ${num(r.n_orphan)} outcomes ran in audiences with only one
          variation and cannot contribute.` : ""}
        ${r.ignored_arms?.length ? ` Not included: ${r.ignored_arms.map(esc).join(", ")} — this line
          compares two arms, and those ran elsewhere in the same programme.` : ""}</div>
    </div>
  </div>`;
}

/** "since 20 Aug" while running, "20 Aug – 24 Aug" once finished. */
function phaseWindow(card) {
  const d = (t) => new Date(t).toLocaleDateString([], { day: "numeric", month: "short" });
  if (!card.phase_from) return "";
  return card.phase_to ? `${d(card.phase_from)} – ${d(card.phase_to)}` : `since ${d(card.phase_from)}`;
}

function expCard(card, isArchive, expanded = !isArchive) {
  const primary = primaryOf(card);
  const v = verdict(primary, card);
  const vars = variationsOf(primary);
  const issues = integrityIssues(primary);
  return `<section class="card exp${issues.length ? " flagged" : ""}">
    <div class="exp-head" role="button" tabindex="0" data-toggle="exp" aria-expanded="${expanded}">
      <div style="min-width:0">
        <div class="exp-title">${esc(card.title)}</div>
        ${vars.length ? `<div class="exp-arms">${
          vars.map((x) => `<span class="armchip${x.live ? "" : " off"}">${esc(x.label)}${
            x.is_control ? `<span class="tiny">control</span>` : ""}</span>`).join(
            `<span class="vs">vs</span>`)}</div>` : ""}
        <div class="exp-sub">
          ${primary?.channel ? chanChip(primary.channel) : ""}
          ${card.phase_from ? `<span class="chip">${esc(phaseWindow(card))}</span>` : ""}
          ${card.has_multiple_phases ? `<span class="chip info">comparison ${card.phase_no}</span>` : ""}
          ${card.experiment_key ? `<span class="chip mono">${esc(card.experiment_key)}</span>`
            : `<span class="chip warn">untagged</span>`}
          ${issues.length ? `<span class="chip bad">${icon("alert", 12)} lopsided split</span>` : ""}
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
      ${issues.map((i) => `<div class="integrity"><div class="integrity-row">
        ${icon("alert", 15)}
        <div><strong>${esc(i.title)}</strong><div class="tiny">${i.body}</div></div>
      </div></div>`).join("")}
      ${primary ? effectBlock(primary) : ""}
      ${(card.components ?? []).map((c) => componentBlock(c, card)).join("")}
      ${card.engagement?.length ? engagementBlock(card) : ""}
    </div>
  </section>`;
}

/** The headline: one signed difference, drawn against zero. */
function effectBlock(c) {
  const e = c.effect;
  if (!e || e.diff == null) return "";
  const decisive = e.ci_low > 0 || e.ci_high < 0;
  return `<div class="effect ${decisive ? "decisive" : "flat"}">
    <div class="effect-head">
      <span class="effect-what">${esc(labelOf(c, e.contender_arm))} vs ${esc(labelOf(c, e.control_arm))}</span>
      <span class="effect-num">${signed(e.diff)}</span>
    </div>
    ${effectBar(e)}
    <div class="effect-read tiny">
      95% interval ${signed(e.ci_low)} to ${signed(e.ci_high)} &middot; p = ${
        e.p_value < 0.001 ? "&lt;0.001" : e.p_value.toFixed(2)} &middot; ${
        num(e.n_comparable)} decided outcomes in this audience${
        decisive ? "" : ` &middot; <span class="muted">the interval crosses zero, so this is not a result yet</span>`}
    </div>
  </div>`;
}

function componentBlock(c, card) {
  const use = variationsOf(c);
  if (!use.length) return "";
  const max = Math.min(1, Math.max(0.02, ...use.map((v) => v.wilson_high ?? v.rate ?? 0)) * 1.12);
  const decided = use.reduce((a, v) => a + v.denominator, 0);
  // Only rows that HAVE a rate can lead. `v.rate ?? 0` made a variation with no
  // decided outcomes tie at 0% and take the leader styling on any card where
  // nothing had resolved yet.
  const rated = use.map((v) => v.rate).filter((r) => r != null);
  const lead = rated.length ? Math.max(...rated) : null;

  return `<div class="component">
    <div class="component-head">
      <span class="chip ${c.rank === 1 ? "info" : ""}"${c.rank >= 3
        ? ' title="A leading indicator: it resolves the moment a reply does or does not arrive, hours before the demo outcome is known"' : ""
      }>${c.rank === 1 ? "Primary" : c.rank === 2 ? "Secondary" : "Leading"}</span>
      <span class="what">${esc(humanOutcome(c.outcome_type))}</span>
      <span class="tiny muted mono">${esc(c.outcome_type)} · ${esc(c.eval_mode)}</span>
      <span class="spacer"></span>
      <span class="tiny muted">${num(decided)} decided</span>
    </div>
    <div class="arms">
      ${use.map((v) => {
        const leader = use.length > 1 && lead != null && v.rate === lead;
        const skew = v.intended_pct != null && Math.abs(v.observed_pct - v.intended_pct) >= 5;
        return `<div class="arm ${leader ? "leader" : ""}">
          <div class="arm-name">
            <span class="label" title="${esc(v.variant_key ?? v.key)}">${esc(v.label)}</span>
            ${v.is_control ? `<span class="chip">control</span>` : ""}
            ${v.live ? "" : `<span class="chip">retired</span>`}
          </div>
          <div class="arm-rate">${pct(v.rate)}</div>
          ${intervalBar(v, max, leader)}
          <div class="arm-vol" title="${num(v.attained)} attained, ${num(v.failed)} failed, ${num(v.pending)} still open">
            ${num(v.attained)}/${num(v.denominator)}${v.pending ? ` <span class="muted">+${num(v.pending)}</span>` : ""}
          </div>
          <div class="arm-bar">${stackBar(v.attained, v.failed, v.pending)}</div>
          <div class="arm-share ${skew ? "skew" : ""}"
               title="Share of decided outcomes this variation actually received${
                 v.intended_pct != null ? `, against the ${v.intended_pct}% registered for it` : ""}">
            ${use.length > 1 ? `${v.observed_pct.toFixed(0)}%` : ""}
          </div>
          <div class="arm-actions">
            ${v.variant_key ? `<button class="btn ghost tiny"
              data-href="#/messages?variant_key=${encodeURIComponent(v.variant_key)}"
              title="Every send of this variation">${icon("chat", 12)} sends</button>` : ""}
            ${v.variant_key ? `<button class="btn ghost tiny"
              data-href="#/messages?variant_key=${encodeURIComponent(v.variant_key)}&replied=true"
              title="Only the ones that got a reply">${icon("reply", 12)} replies</button>` : ""}
          </div>
        </div>`;
      }).join("")}
    </div>
    ${c.rank === 1 && use.length === 1 ? `<p class="tiny muted foot">
      Only one variation is running in this audience, so this is a rate to watch — not a race to win.</p>` : ""}
  </div>`;
}

function engagementBlock(card) {
  const vars = variationsOf(primaryOf(card));
  const keys = new Set(vars.map((v) => v.variant_key));
  const rows = (card.engagement ?? []).filter((e) => e.sent > 0 && keys.has(e.variant_key));
  if (!rows.length) return "";
  return `<div class="component">
    <div class="component-head">
      <span class="chip">${icon("mail", 12)} Delivery &amp; engagement</span>
      <span class="spacer"></span>
      <span class="tiny muted">per variation</span>
    </div>
    <div class="funnels">
      ${rows.map((e) => `<div class="funnel-card">
        <div class="funnel-title">${esc(
          vars.find((v) => v.variant_key === e.variant_key)?.label ?? e.variant_key)}</div>
        ${funnel(e)}
      </div>`).join("")}
    </div>
  </div>`;
}

export {
  viewExperiments, isLive, primaryOf, verdict, variationsOf, liveVariations,
  integrityIssues, expCard, effectBlock, programBlock, rollupBanner,
};
