// The Experiments view.
//
// This screen was rebuilt around one correction: an ARM is not a variant key.
//
// The Demo Driver email test has two arms — human-written copy and GPT-5 copy —
// served by 38 variant keys across nine audiences. Reading those keys as arms
// produced a card headlined
//
//   DemoDriver-2+Days-E1-Emerging-A-Generic vs DemoDriver-2+Days-E1-Emerging-D-GPT5
//   vs DemoDriver-2+Days-E1-MM-A-Generic vs ...          [28 live arms]
//
// over a leaderboard racing "SameDay · SMB" against "NextDay · MM". Those are
// audiences, not treatments; ranking them measures who was written to.
//
// So the card now leads with the arms, states the difference between them as one
// signed number with an interval drawn against zero, says plainly when the
// allocation makes that comparison unsafe, and keeps the audience breakdown and
// the per-variant detail one disclosure away each.

import { $, esc, icon, pct, num, plural, chanChip, timeAgo, humanOutcome } from "./fmt.js";
import { intervalBar, stackBar, funnel, effectBar } from "./charts.js";
import { state, loadMetrics, errorBanner, skeleton } from "./data.js";

/** Distinct variant keys across an experiment's components, for the detail table. */
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
const isLive = (card) => card.phase_is_current === true;
const primaryOf = (card) => (card.components ?? [])[0] ?? null;

/** Arms of a component, retired ones last. */
const armsOf = (c) => [...(c?.arms ?? [])].sort((a, b) => Number(b.live) - Number(a.live));
const liveArms = (card) => (primaryOf(card)?.arms ?? []).filter((a) => a.live);

const signed = (v, dp = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(dp)}pp`;
const armLabelOf = (c, key) => (c.arms ?? []).find((a) => a.arm === key)?.label ?? key ?? "—";

/**
 * One line a human can act on.
 *
 * Where a stratified effect exists it decides, because P(best) is computed on
 * the arms' pooled totals — the very comparison the stratification rejects. On
 * Demo Driver those two disagree outright, and a card is not allowed to
 * contradict itself.
 *
 * Returns PLAIN text. Both call sites (this view and the overview) escape it,
 * and escaping inside here as well double-escaped every label that contained
 * an ampersand.
 */
function verdict(c, card) {
  if (!c) return { tone: "waiting", icon: "clock", text: "no data yet" };
  const arms = armsOf(c);
  const decided = arms.reduce((a, v) => a + (v.denominator ?? 0), 0);

  if (card?.single_arm || arms.length < 2) {
    const best = arms.reduce((b, a) => ((a.rate ?? -1) > (b ?? -1) ? a.rate : b), null);
    return { tone: "single", icon: "info",
      text: decided ? `single arm — ${pct(best)} of ${plural(decided, "outcome")}`
                    : "single arm, no outcomes yet" };
  }

  const e = c.effect;
  if (e && e.diff == null) {
    return { tone: "thin", icon: "alert",
      text: `not comparable — no audience ran both arms` };
  }
  if (e) {
    if (e.n_comparable < 30) {
      return { tone: "thin", icon: "clock",
        text: `too thin — ${e.n_comparable} of ~30 comparable outcomes` };
    }
    if (c.conclusive) {
      return { tone: "conclusive", icon: "check",
        text: `${armLabelOf(c, c.leader)} wins by ${signed(Math.abs(e.diff))}` };
    }
    const halfWidth = (e.ci_high - e.ci_low) / 2;
    return { tone: "waiting", icon: "clock",
      text: `no difference — ${signed(e.diff)} ± ${(halfWidth * 100).toFixed(1)}pp` };
  }

  // Three or more arms: no single effect, so P(best) is the honest summary.
  if (decided < 30) {
    return { tone: "thin", icon: "clock", text: `too thin — ${decided} of ~30 decided outcomes needed` };
  }
  const need = c.confidence_threshold ?? 0.95;
  if (c.conclusive) {
    return { tone: "conclusive", icon: "check",
      text: `winner: ${armLabelOf(c, c.leader)} at ${pct(c.prob_leader_best, 0)} confidence` };
  }
  const gap = Math.max(0, Math.round((need - (c.prob_leader_best ?? 0)) * 100));
  return { tone: "waiting", icon: "clock",
    text: `no winner yet — leader at ${pct(c.prob_leader_best, 0)}, needs ${pct(need, 0)} (${gap}pp to go)` };
}

async function viewExperiments(view) {
  view.innerHTML = skeleton(140);
  const m = await loadMetrics();
  const groups = m?.programs ?? [];
  const totalLive = groups.reduce((a, g) => a + (g.experiments ?? []).filter(isLive).length, 0);
  const totalDormant = groups.reduce((a, g) => a + (g.experiments ?? []).filter((c) => !isLive(c)).length, 0);
  const flagged = groups.reduce((a, g) =>
    a + (g.experiments ?? []).filter((c) => isLive(c) && integrityIssues(primaryOf(c)).length).length, 0);
  $("#nav-exp-count").textContent = totalLive ? String(totalLive) : "";

  view.innerHTML = `
    ${errorBanner()}
    <div class="page-head">
      <h2>Experiments</h2>
      <p>${plural(totalLive, "comparison")} running${totalDormant ? ` · ${plural(totalDormant, "concluded one")} tucked away` : ""}${
        flagged ? ` · <strong>${flagged}</strong> with an allocation problem` : ""}.
         Each card compares <strong>arms</strong> — the thing being tested — pooled over every
         variant that serves them, and scored only over the window those arms ran together.
         The difference is drawn against zero: a bar touching the dashed line is not a result yet.</p>
    </div>
    ${groups.length ? groups.map(programBlock).join("")
      : `<div class="card"><div class="empty">${icon("flask", 28)}
           <div>No experiments are reporting.</div></div></div>`}`;
}

function programBlock(g) {
  const live = (g.experiments ?? []).filter(isLive);
  const dormant = (g.experiments ?? []).filter((c) => !isLive(c));
  // Anything with an allocation problem first — it is the card most likely to
  // be read as a result when it is not one. Then decided, then weight of evidence.
  const sorted = [...live].sort((a, b) => {
    const fa = integrityIssues(primaryOf(a)).length ? 0 : 1;
    const fb = integrityIssues(primaryOf(b)).length ? 0 : 1;
    const ca = primaryOf(a)?.conclusive ? 0 : 1;
    const cb = primaryOf(b)?.conclusive ? 0 : 1;
    return fa - fb || ca - cb || b.primary_denominator - a.primary_denominator;
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
          ${icon("archive", 14)} ${open ? "Hide" : "Show"} ${plural(dormant.length, "concluded comparison")}
          <span class="tiny muted">— finished, kept for the record</span>
        </button>
        ${open ? dormant.map((c) => expCard(c, true, false)).join("") : ""}
      </div>` : ""}
  </section>`;
}

/** "since 20 Aug" while running, "20 Aug – 24 Aug" once it has finished. */
function phaseWindow(card) {
  const d = (t) => new Date(t).toLocaleDateString([], { day: "numeric", month: "short" });
  if (!card.phase_from) return "";
  return card.phase_to ? `${d(card.phase_from)} – ${d(card.phase_to)}` : `since ${d(card.phase_from)}`;
}

// Only the primary outcome constitutes a verdict. A conclusive reply rate is a
// useful signal, but shipping on it would answer a different question than the
// one the experiment asks.
const hasVerdict = (card) => !!primaryOf(card)?.conclusive && !card.single_arm;

/**
 * Reasons this comparison cannot be read at face value.
 *
 * Both are about allocation, not about the result, and both were completely
 * invisible before: the card printed the REGISTERED split ("50%") next to each
 * arm as though it were an observation.
 */
function integrityIssues(c) {
  const out = [];
  if (!c) return out;
  if (c.srm?.mismatch) {
    // Name the OVER-allocated arm. Both sides of a two-arm skew carry the same
    // gap, and "Generic received 31%" makes the reader work out who got the rest.
    const over = [...c.srm.arms].sort((a, b) => b.gap_pp - a.gap_pp)[0];
    const total = c.srm.arms.reduce((s, a) => s + a.observed, 0);
    out.push({
      key: "srm",
      title: "Traffic is not split the way it was registered",
      body: `${esc(armLabelOf(c, over.arm))} received ${Math.round((over.observed / total) * 100)}%
             of decided outcomes against the ${over.intended_pct}% registered for it —
             ${over.gap_pp.toFixed(1)}pp more than its share. A gap this large is not
             randomisation noise (p &lt; 0.001), so the two arms were not drawn from the same
             pool of people and their overall rates are not comparable.`,
    });
  }
  const e = c.effect;
  if (e && e.n_orphan > 0 && e.n_comparable > 0 && e.n_orphan / (e.n_orphan + e.n_comparable) >= 0.15) {
    out.push({
      key: "orphan",
      title: `${num(e.n_orphan)} outcomes cannot be compared at all`,
      body: `${e.n_strata_total - e.n_strata_paired} of ${e.n_strata_total} audiences only ever ran one
             arm, so ${Math.round((e.n_orphan / (e.n_orphan + e.n_comparable)) * 100)}% of this
             experiment contributes nothing to the difference below. It is counted in the arm
             totals and excluded from the estimate.`,
    });
  }
  return out;
}

function integrityBanner(c) {
  const issues = integrityIssues(c);
  if (!issues.length) return "";
  return `<div class="integrity">
    ${issues.map((i) => `<div class="integrity-row">
      ${icon("alert", 15)}
      <div><strong>${esc(i.title)}</strong><div class="tiny">${i.body}</div></div>
    </div>`).join("")}
  </div>`;
}

/**
 * The headline: one signed difference, drawn against zero.
 *
 * The contrast line is the point of the whole exercise. Where pooling every send
 * disagrees with comparing within audience, the card says so in words, because
 * the pooled number is the one a reader would otherwise compute in their head
 * from the two arm rates directly beneath.
 */
function effectBlock(c) {
  const e = c.effect;
  if (!e) return "";
  if (e.diff == null) {
    return `<div class="effect none">
      ${icon("alert", 15)}
      <div><strong>No audience ever ran both arms.</strong>
      <div class="tiny">These two arms went to different people, so nothing here is a comparison.
        ${num(e.n_orphan)} decided outcomes, ${e.n_strata_total} audiences, none of them shared.</div></div>
    </div>`;
  }
  const decisive = e.ci_low > 0 || e.ci_high < 0;
  const contender = armLabelOf(c, e.contender_arm);
  const control = armLabelOf(c, e.control_arm);
  return `<div class="effect ${decisive ? "decisive" : "flat"}">
    <div class="effect-head">
      <span class="effect-what">${esc(contender)} vs ${esc(control)}<span class="tiny muted">, within audience</span></span>
      <span class="effect-num">${signed(e.diff)}</span>
    </div>
    ${effectBar(e)}
    <div class="effect-read tiny">
      95% interval ${signed(e.ci_low)} to ${signed(e.ci_high)} &middot; p = ${e.p_value < 0.001 ? "&lt;0.001" : e.p_value.toFixed(2)}
      &middot; ${num(e.n_comparable)} comparable outcomes across ${plural(e.n_strata_paired, "audience")}
      &middot; ${esc(contender)} ahead in ${e.contender_leads} of ${e.n_strata_paired}
    </div>
    ${e.simpson ? `<div class="effect-warn tiny">
      ${icon("alert", 13)} <strong>Pooling every send says ${signed(e.pooled_diff)} — the opposite sign.</strong>
      That reversal is the allocation, not the copy: the arms were given different
      audiences, and some audiences show up far more than others. The
      within-audience figure above is the one that answers the question.</div>` : ""}
  </div>`;
}

function expCard(card, isArchive, expanded = !isArchive) {
  const primary = primaryOf(card);
  const v = verdict(primary, card);
  const arms = armsOf(primary);
  const live = liveArms(card);
  const flagged = integrityIssues(primary).length > 0;
  return `<section class="card exp${flagged ? " flagged" : ""}">
    <div class="exp-head" role="button" tabindex="0" data-toggle="exp"
         aria-expanded="${expanded}">
      <div style="min-width:0">
        <div class="exp-title">${esc(card.title)}</div>
        ${arms.length ? `<div class="exp-arms">${
          arms.map((a) => `<span class="armchip${a.live ? "" : " off"}">${esc(a.label)}${
            a.is_control ? `<span class="tiny">control</span>` : ""}</span>`).join(
            `<span class="vs">vs</span>`)}</div>` : ""}
        <div class="exp-sub">
          ${primary?.channel ? chanChip(primary.channel) : ""}
          ${card.phase_from ? `<span class="chip" title="${esc(card.phase_from)}${card.phase_to ? ` to ${esc(card.phase_to)}` : ""}">${
              esc(phaseWindow(card))}</span>` : ""}
          ${card.has_multiple_phases ? `<span class="chip info" title="This experiment ran more than one comparison; each is scored only over the window its arms overlapped">comparison ${card.phase_no}</span>` : ""}
          ${card.experiment_key ? `<span class="chip mono">${esc(card.experiment_key)}</span>`
            : `<span class="chip warn" title="No experiment registered — these sends cannot be compared">untagged</span>`}
          ${live.length ? `<span class="chip ok">${plural(live.length, "live arm")}</span>`
            : `<span class="chip" title="${esc(primary?.last_sent_at ? `last sent ${new Date(primary.last_sent_at).toLocaleString()}` : "no sends recorded")}">
                 ${primary?.last_sent_at ? `last sent ${esc(timeAgo(primary.last_sent_at))}` : "no sends"}</span>`}
          ${flagged ? `<span class="chip bad">${icon("alert", 12)} allocation</span>` : ""}
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
      ${integrityBanner(primary)}
      ${primary ? effectBlock(primary) : ""}
      ${(card.components ?? []).map((c) => componentBlock(c, card, isArchive)).join("")}
      ${primary ? strataBlock(primary, card) : ""}
      ${primary ? variantBlock(primary, card) : ""}
      ${card.engagement?.length ? engagementBlock(card) : ""}
    </div>
  </section>`;
}

function componentBlock(c, card, isArchive) {
  const all = armsOf(c);
  // Hide retired arms inside a running comparison — that is precisely the
  // "why am I looking at SMS variant B" problem. The archive shows everything.
  const shown = isArchive ? all : all.filter((a) => a.live);
  const use = shown.length ? shown : all;
  const hidden = all.length - use.length;
  const max = Math.min(1, Math.max(0.02, ...use.map((a) => a.wilson_high ?? a.rate ?? 0)) * 1.12);
  const decided = use.reduce((a, v) => a + v.denominator, 0);
  const leadRate = Math.max(...use.map((a) => a.rate ?? 0));

  return `<div class="component">
    <div class="component-head">
      <span class="chip ${c.rank === 1 ? "info" : ""}"${c.rank >= 3
        ? ' title="A leading indicator: it resolves the moment a reply does or does not arrive, hours before the demo outcome is known"' : ""
      }>${c.rank === 1 ? "Primary" : c.rank === 2 ? "Secondary" : "Leading"}</span>
      <span class="what">${esc(humanOutcome(c.outcome_type))}</span>
      <span class="tiny muted mono">${esc(c.outcome_type)} · ${esc(c.eval_mode)}</span>
      <span class="spacer"></span>
      <span class="tiny muted">${num(decided)} decided${hidden ? ` · ${hidden} retired hidden` : ""}</span>
    </div>
    <div class="arms">
      ${use.map((a) => {
        const leader = use.length > 1 && (a.rate ?? 0) === leadRate;
        const one = a.variant_keys.length === 1 ? a.variant_keys[0] : null;
        const skew = a.intended_pct != null && Math.abs(a.observed_pct - a.intended_pct) >= 5;
        return `<div class="arm ${leader ? "leader" : ""}">
          <div class="arm-name">
            <span class="label" title="${esc(a.variant_keys.join(", ") || a.arm)}">${esc(a.label)}</span>
            ${a.is_control ? `<span class="chip">control</span>` : ""}
            ${a.live ? "" : `<span class="chip">retired</span>`}
          </div>
          <div class="arm-rate">${pct(a.rate)}</div>
          ${intervalBar(a, max, leader)}
          <div class="arm-vol" title="${num(a.attained)} attained, ${num(a.failed)} failed, ${num(a.pending)} still open">
            ${num(a.attained)}/${num(a.denominator)}${a.pending ? ` <span class="muted">+${num(a.pending)}</span>` : ""}
          </div>
          <div class="arm-bar">${stackBar(a.attained, a.failed, a.pending)}</div>
          <div class="arm-share ${skew ? "skew" : ""}"
               title="Share of decided outcomes this arm actually received${
                 a.intended_pct != null ? `, against the ${a.intended_pct}% registered for it` : ""}">
            ${a.observed_pct.toFixed(0)}%${a.intended_pct != null
              ? ` <span class="muted">of ${a.intended_pct}%</span>` : ""}
          </div>
          <div class="arm-actions">
            ${one ? `<button class="btn ghost tiny"
              data-href="#/messages?variant_key=${encodeURIComponent(one)}"
              title="Every send of this arm">${icon("chat", 12)} sends</button>` : ""}
            ${one ? `<button class="btn ghost tiny"
              data-href="#/messages?variant_key=${encodeURIComponent(one)}&replied=true"
              title="Only the ones that got a reply">${icon("reply", 12)} replies</button>` : ""}
            ${!one && a.variant_keys.length ? `<span class="tiny muted nowrap">${
              plural(a.variant_keys.length, "variant")} · ${plural(a.n_strata, "audience")}</span>` : ""}
          </div>
        </div>`;
      }).join("")}
    </div>
    ${c.rank === 1 && use.length > 1 && !card.single_arm ? `<p class="tiny muted foot">
      Bars are the Wilson 95% interval on each arm's own rate; the share column is the traffic
      each arm actually got. For whether the arms differ, read the signed figure above — it is
      the only one computed within audience.</p>` : ""}
    ${c.rank === 1 && card.single_arm ? `<p class="tiny muted foot">
      Only one arm is tagged here, so this is a rate to watch — not a race to win.</p>` : ""}
  </div>`;
}

/**
 * The audience breakdown.
 *
 * This is the evidence for the headline. It is also the answer to "so where DOES
 * the difference come from" — which, on Demo Driver, is the audience and not the
 * copy: the spread across these rows is many times the spread between arms.
 */
function strataBlock(c, card) {
  const e = c.effect;
  if (!e || !e.strata?.length || (e.strata.length === 1 && e.strata[0].stratum == null)) return "";
  const key = `${card.experiment_key ?? card.title}::strata`;
  const open = state.archiveOpen.has(key);
  const contender = armLabelOf(c, e.contender_arm);
  const control = armLabelOf(c, e.control_arm);
  const widest = Math.max(0.02, ...e.strata.map((s) => Math.abs(s.diff)));

  return `<div class="component">
    <button class="archive-toggle" data-archive="${esc(key)}" aria-expanded="${open}">
      ${icon("chev", 14)} ${open ? "Hide" : "Show"} the ${plural(e.strata.length, "audience")} where both arms ran
      <span class="tiny muted">— ${e.n_strata_total - e.n_strata_paired} more ran only one</span>
    </button>
    ${open ? `<table class="strata">
      <thead><tr>
        <th>Audience</th>
        <th class="num">${esc(control)}</th>
        <th class="num">${esc(contender)}</th>
        <th class="num">Difference</th>
        <th class="spark"></th>
      </tr></thead>
      <tbody>
        ${e.strata.map((s) => `<tr>
          <td class="mono tiny">${esc(s.stratum ?? "all")}</td>
          <td class="num">${pct(s.control_rate)}<span class="tiny muted"> ${s.control_attained}/${s.control_denominator}</span></td>
          <td class="num">${pct(s.contender_rate)}<span class="tiny muted"> ${s.contender_attained}/${s.contender_denominator}</span></td>
          <td class="num ${s.diff > 0 ? "up" : s.diff < 0 ? "down" : ""}">${signed(s.diff)}</td>
          <td class="spark">${diffSpark(s.diff, widest)}</td>
        </tr>`).join("")}
      </tbody>
    </table>
    <p class="tiny muted foot">Each row compares the two arms inside one audience, which is the only
      way they are comparable. The headline figure is these rows combined, weighted by how much
      separation each can resolve — not by how many sends it happens to hold.</p>` : ""}
  </div>`;
}

/** A small diverging bar so a column of signed numbers reads as a shape. */
function diffSpark(diff, widest) {
  const half = Math.min(50, Math.abs(diff / widest) * 50);
  const x = diff >= 0 ? 50 : 50 - half;
  return `<svg viewBox="0 0 100 12" preserveAspectRatio="none" class="spark-svg" aria-hidden="true">
    <line x1="50" y1="0" x2="50" y2="12" stroke="var(--border)" vector-effect="non-scaling-stroke"/>
    <rect x="${x.toFixed(1)}" y="3" width="${Math.max(half, 0.8).toFixed(1)}" height="6"
          fill="${diff >= 0 ? "var(--ok)" : "var(--bad)"}" opacity=".55" rx="1"/>
  </svg>`;
}

/**
 * Per-variant detail, folded away.
 *
 * The variant keys still matter — they are what you filter the ledger by — they
 * just are not arms. Kept behind a disclosure so they are reachable without
 * being the first thing anyone reads.
 */
function variantBlock(c, card) {
  const rows = (c.variants ?? []).filter((v) => v.variant_key);
  if (rows.length < 2 || rows.length === (c.arms ?? []).length) return "";
  const key = `${card.experiment_key ?? card.title}::variants`;
  const open = state.archiveOpen.has(key);
  const byArm = new Map((c.arms ?? []).flatMap((a) => a.variant_keys.map((k) => [k, a.label])));
  const sorted = [...rows].sort((a, b) => (b.denominator ?? 0) - (a.denominator ?? 0));
  return `<div class="component">
    <button class="archive-toggle" data-archive="${esc(key)}" aria-expanded="${open}">
      ${icon("chev", 14)} ${open ? "Hide" : "Show"} the ${plural(rows.length, "variant")} behind these arms
    </button>
    ${open ? `<table class="strata">
      <thead><tr><th>Variant</th><th>Arm</th><th class="num">Rate</th><th class="num">Decided</th><th></th></tr></thead>
      <tbody>
        ${sorted.map((v) => `<tr>
          <td class="mono tiny">${esc(v.variant_key)}</td>
          <td class="tiny">${esc(byArm.get(v.variant_key) ?? "—")}${v.live ? "" : ` <span class="chip">retired</span>`}</td>
          <td class="num">${pct(v.rate)}</td>
          <td class="num tiny">${num(v.showed)}/${num(v.denominator)}</td>
          <td><button class="btn ghost tiny"
                data-href="#/messages?variant_key=${encodeURIComponent(v.variant_key)}"
                title="Every send of this variant">${icon("chat", 12)} sends</button></td>
        </tr>`).join("")}
      </tbody>
    </table>
    <p class="tiny muted foot">These are cells, not treatments: each one fixes an audience as well as
      an arm, so the spread down this column is mostly who was written to.</p>` : ""}
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
      <span class="tiny muted">per variant, per email</span>
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

export {
  viewExperiments, distinctVariants, liveVariants, isLive, primaryOf, verdict,
  armsOf, liveArms, integrityIssues, expCard, effectBlock, strataBlock,
};
