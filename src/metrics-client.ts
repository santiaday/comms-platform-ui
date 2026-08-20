// Reads the comms data layer (read-only) via the platform SQL endpoint and
// assembles the per objective × component × experiment metric with live
// Bayesian confidence. One parameterless SELECT over comms.v_objective_rates +
// comms.objectives; the reader bearer is injected server-side, never exposed.

import { computeConfidence } from "./confidence.js";
import { shortVariant } from "./naming.js";

// NOTE: there is deliberately NO default endpoint URL here. This repo is
// public; the address of the internal SQL endpoint is configuration, not
// source. `QUERY_ENDPOINT_URL` is required at runtime and the server fails
// loudly without it (see server.ts:resolveConfig).
//
// Single platform identity: comms_writer. The UI reads (SELECT) today and will
// write back later, so it shares the one bearer — no separate read-only identity.
export const IDENTITY = "comms_writer";

export interface VariantMetric {
  variant_key: string | null;
  /** variant_key with the experiment prefix stripped, e.g. "D · GPT5". */
  short_key: string;
  showed: number;
  not_showed: number;
  pending: number;
  denominator: number;
  rate: number | null;
  wilson_low: number | null;
  wilson_high: number | null;
  prob_best: number;
  /**
   * Currently sending. v_objective_rates keeps every variant that ever sent, so
   * without this the retired SMS arms B and C sit beside the running A and D
   * looking identical. The UI hides these by default.
   */
  live: boolean;
  /** Arm this variant serves ("a", "d", …) — null if never registered. */
  arm: string | null;
  /** That arm's share of traffic right now, e.g. 50. Null when not running. */
  split_pct: number | null;
}
export interface ComponentMetric {
  objective_key: string;
  objective_version: number;
  rank: number;
  label: string;
  outcome_type: string;
  eval_mode: string;
  experiment_key: string | null;
  confidence_threshold: number;
  variants: VariantMetric[];
  leader: string | null;
  prob_leader_best: number;
  conclusive: boolean;
  /** draft | running | paused | ended — null if the experiment was never registered. */
  experiment_status: string | null;
  /** How many of these variants are actually sending right now. 0 = archive. */
  live_variants: number;
  /** Channel these sends went out on, for a chip on the card. */
  channel: string | null;
  /** Most recent send across this component's arms. */
  last_sent_at: string | null;
}

export interface EndpointConfig {
  endpointUrl: string;
  identity: string;
  bearer: string;
}

interface RateRow {
  objective_key: string; objective_version: number; rank: number; label: string;
  outcome_type: string; eval_mode: string; experiment_key: string | null; variant_key: string | null;
  n_attained: number; n_failed: number; n_pending: number; n_denominator: number;
  // Wilson score interval, computed in comms.v_objective_rates. Surfacing it is
  // the difference between "27.5% vs 25.4%" (which reads as a real gap) and
  // showing that the two intervals overlap almost entirely — which is why
  // nearly every experiment here is correctly "not conclusive".
  wilson_low?: number | null; wilson_high?: number | null;
  confidence_threshold: number;
  variant_live?: boolean | null;
  experiment_live?: boolean | null;
  experiment_status?: string | null;
  /** Whether this variant/experiment exists in the registry at all. */
  variant_registered?: boolean | null;
  experiment_registered?: boolean | null;
  /** Most recent send for this arm — the fallback signal for "still running". */
  last_sent_at?: string | null;
  channel?: string | null;
  arm?: string | null;
  /** jsonb -> text, so it arrives as a string like "50". */
  arm_split_pct?: string | null;
}

/**
 * How recently an unregistered arm must have sent to count as still running.
 *
 * Only used when the registry has nothing to say. Two weeks is wide enough to
 * survive a quiet weekend or a paused sequence without declaring a working
 * program dead, and short enough that a genuinely finished test drops out.
 */
export const LIVE_WINDOW_DAYS = 14;

/**
 * Is this arm currently sending?
 *
 * Registration is authoritative when it exists: SMS arms B and C are retired
 * because someone retired them, and C sent as recently as this morning — an
 * observation must not overturn that decision.
 *
 * When an arm was never registered, though, `is_active` is absent rather than
 * false, and treating absent as "retired" was flatly wrong: it marked all 18
 * Demo Driver email experiments dormant on a day they sent 49 emails, and the
 * Experiments page rendered "Nothing running in this program right now" over
 * 4,111 decided outcomes. With no decision on record, recent sends are the
 * best evidence available.
 */
export function isArmLive(r: RateRow, now: number = Date.now()): boolean {
  if (r.variant_registered) {
    // A live arm inside a paused experiment is not sending either — but only
    // hold that against it when the experiment is actually registered.
    return !!r.variant_live && (!r.experiment_registered || !!r.experiment_live);
  }
  if (!r.last_sent_at) return false;
  const t = new Date(r.last_sent_at).getTime();
  if (!Number.isFinite(t)) return false;
  return now - t <= LIVE_WINDOW_DAYS * 86_400_000;
}

// Live-ness is joined in, not inferred. comms.v_objective_rates is historical by
// design — every variant that ever sent keeps its row forever — so without this
// the dashboard shows retired arms (SMS "B", "C") beside running ones with no way
// to tell them apart. `variant_live` and `experiment_live` let the UI default to
// what is actually running while keeping the history one toggle away.
//
// LEFT JOINs on purpose: plenty of historical variants were never registered in
// comms.variations at all (the 18 fragmented Demo Driver email keys predate it).
// Those come back NULL, which the assembler treats as "not currently running"
// rather than dropping the row and losing the history.
//
// Liveness comes from comms.v_variant_liveness / v_experiment_status, NOT from
// comms.experiments directly. comms_writer holds no SELECT on that table, so
// joining it produced a 403 and a dashboard that was one red banner. Migration
// 0076 added those two views for exactly this query. Anything added here has to
// be readable by comms_writer — test/query-grants.test.ts enforces it.
const SQL = `
  SELECT r.objective_key, r.objective_version, r.rank, r.label, r.outcome_type, r.eval_mode,
         r.experiment_key, r.variant_key,
         r.n_attained::int AS n_attained, r.n_failed::int AS n_failed,
         r.n_pending::int AS n_pending, r.n_denominator::int AS n_denominator,
         r.wilson_low::float8 AS wilson_low, r.wilson_high::float8 AS wilson_high,
         o.confidence_threshold::float8 AS confidence_threshold,
         COALESCE(lv.variant_is_active, false)             AS variant_live,
         COALESCE(xs.is_running, false)                     AS experiment_live,
         xs.status                                          AS experiment_status,
         (lv.variant_key    IS NOT NULL)                    AS variant_registered,
         (xs.experiment_key IS NOT NULL)                    AS experiment_registered,
         act.last_sent_at                                   AS last_sent_at,
         act.channel                                        AS channel,
         lv.arm                                             AS arm,
         lv.arm_split_pct                                   AS arm_split_pct
    FROM comms.v_objective_rates r
    JOIN comms.objectives o
      ON o.objective_key = r.objective_key AND o.version = r.objective_version
    LEFT JOIN comms.v_variant_liveness  lv ON lv.variant_key    = r.variant_key
    LEFT JOIN comms.v_experiment_status xs ON xs.experiment_key = r.experiment_key
    LEFT JOIN (
           SELECT objective_key, objective_version, rank, experiment_key, variant_key,
                  max(sent_at)                              AS last_sent_at,
                  mode() WITHIN GROUP (ORDER BY channel)     AS channel
             FROM comms.v_objective_attainment
            GROUP BY 1, 2, 3, 4, 5
         ) act
      ON  act.objective_key     =            r.objective_key
      AND act.objective_version =            r.objective_version
      AND act.rank              =            r.rank
      AND act.experiment_key    IS NOT DISTINCT FROM r.experiment_key
      AND act.variant_key       IS NOT DISTINCT FROM r.variant_key
   ORDER BY r.objective_key, r.objective_version, r.rank, r.experiment_key, r.variant_key`;

// ---------------------------------------------------------------------
// Email engagement (per experiment × variant) — the "metrics per email".
// ---------------------------------------------------------------------
export interface EngagementVariant {
  variant_key: string | null;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced: number;
  unsubscribed: number;
  complained: number;
  delivery_rate: number | null; // delivered / sent
  open_rate: number | null;     // opened / delivered  (MPP-inflated — directional)
  click_rate: number | null;    // clicked / delivered
  reply_rate: number | null;    // replied / delivered
  bounce_rate: number | null;   // bounced / sent
}
export interface EngagementExperiment {
  objective_key: string | null;
  experiment_key: string | null;
  variants: EngagementVariant[];
}

interface EngagementRow {
  objective_key: string | null; experiment_key: string | null; variant_key: string | null;
  sent: number; delivered: number; opened: number; clicked: number; replied: number;
  bounced: number; unsubscribed: number; complained: number;
}

const ENGAGEMENT_SQL = `
  SELECT objective_key, experiment_key, variant_key,
         sent::int, delivered::int, opened::int, clicked::int, replied::int,
         bounced::int, unsubscribed::int, complained::int
    FROM comms.v_email_engagement
   ORDER BY experiment_key, variant_key`;

export class MetricsError extends Error {}

export async function fetchObjectiveMetrics(
  cfg: EndpointConfig,
  opts: { samples?: number } = {},
): Promise<ComponentMetric[]> {
  const resp = await fetch(cfg.endpointUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Identity": cfg.identity,
      "X-Internal-Secret": cfg.bearer,
    },
    body: JSON.stringify({ sql: SQL, params: [] }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new MetricsError(`endpoint ${resp.status}: ${text.slice(0, 300)}`);
  let json: { ok?: boolean; rows?: RateRow[]; error?: unknown };
  try { json = JSON.parse(text); } catch { throw new MetricsError(`bad endpoint JSON: ${text.slice(0, 200)}`); }
  if (json.ok !== true || !Array.isArray(json.rows)) {
    throw new MetricsError(`endpoint error: ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
  }
  return assemble(json.rows, opts.samples);
}

/**
 * Fetch per-email engagement (delivery/open/click/reply/bounce) grouped by
 * experiment. Channel-scoped server-side (comms.v_email_engagement only sees
 * channel='email'), so this returns exactly the email experiments. Separate
 * from objective metrics so a missing view (pre-0048) degrades to "no
 * engagement" rather than breaking the whole dashboard.
 */
export async function fetchEmailEngagement(cfg: EndpointConfig): Promise<EngagementExperiment[]> {
  const resp = await fetch(cfg.endpointUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Identity": cfg.identity, "X-Internal-Secret": cfg.bearer },
    body: JSON.stringify({ sql: ENGAGEMENT_SQL, params: [] }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new MetricsError(`engagement endpoint ${resp.status}: ${text.slice(0, 300)}`);
  let json: { ok?: boolean; rows?: EngagementRow[]; error?: unknown };
  try { json = JSON.parse(text); } catch { throw new MetricsError(`bad engagement JSON: ${text.slice(0, 200)}`); }
  if (json.ok !== true || !Array.isArray(json.rows)) {
    throw new MetricsError(`engagement endpoint error: ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
  }
  return assembleEngagement(json.rows);
}

const rate = (num: number, den: number): number | null =>
  den > 0 ? Math.round((num / den) * 1e4) / 1e4 : null;

export function assembleEngagement(rows: EngagementRow[]): EngagementExperiment[] {
  const groups = new Map<string, EngagementExperiment>();
  for (const r of rows) {
    const k = `${r.objective_key ?? ""}::${r.experiment_key ?? ""}`;
    let g = groups.get(k);
    if (!g) { g = { objective_key: r.objective_key, experiment_key: r.experiment_key, variants: [] }; groups.set(k, g); }
    g.variants.push({
      variant_key: r.variant_key,
      sent: r.sent, delivered: r.delivered, opened: r.opened, clicked: r.clicked,
      replied: r.replied, bounced: r.bounced, unsubscribed: r.unsubscribed, complained: r.complained,
      delivery_rate: rate(r.delivered, r.sent),
      open_rate: rate(r.opened, r.delivered),
      click_rate: rate(r.clicked, r.delivered),
      reply_rate: rate(r.replied, r.delivered),
      bounce_rate: rate(r.bounced, r.sent),
    });
  }
  return [...groups.values()].sort((a, b) => (a.experiment_key ?? "").localeCompare(b.experiment_key ?? ""));
}

// NUL as the separator, written as an escape rather than an embedded byte:
// a raw NUL makes git treat this whole file as binary, and the diff on the
// file with the most logic in it renders as "Binary file not shown".
const SEP = "\u0000";
const groupKey = (r: RateRow) =>
  [r.objective_key, r.objective_version, r.rank, r.experiment_key ?? ""].join(SEP);

export function assemble(rows: RateRow[], samples?: number): ComponentMetric[] {
  const groups = new Map<string, RateRow[]>();
  for (const r of rows) {
    const k = groupKey(r);
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  const out: ComponentMetric[] = [];
  for (const grp of groups.values()) {
    const first = grp[0]!;
    const threshold = Number(first.confidence_threshold);
    // A null/empty variant_key is NOT an experiment arm — it's comms with no
    // variant tag (e.g. sends whose contaminated variant refs were removed).
    // Exclude them from the A/B chart and the P(best) math so they can't skew
    // the comparison. Fall back to the whole group only if there are no tagged
    // arms at all (a genuinely variant-less experiment).
    const tagged = grp.filter((r) => r.variant_key != null && r.variant_key !== "");
    const arms = tagged.length > 0 ? tagged : grp;
    const conf = computeConfidence(
      arms.map((r) => ({ key: r.variant_key ?? "(none)", attained: r.n_attained, denominator: r.n_denominator })),
      threshold,
      { samples },
    );
    const probByKey = new Map(conf.variants.map((v) => [v.key, v.prob_best]));
    const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
    out.push({
      objective_key: first.objective_key,
      objective_version: first.objective_version,
      rank: first.rank,
      label: first.label,
      outcome_type: first.outcome_type,
      eval_mode: first.eval_mode,
      experiment_key: first.experiment_key,
      confidence_threshold: threshold,
      variants: arms.map((r) => ({
        variant_key: r.variant_key,
        short_key: shortVariant(r.variant_key, first.experiment_key),
        showed: r.n_attained,
        not_showed: r.n_failed,
        pending: r.n_pending,
        denominator: r.n_denominator,
        rate: r.n_denominator > 0 ? round4(r.n_attained / r.n_denominator) : null,
        wilson_low: r.wilson_low ?? null,
        wilson_high: r.wilson_high ?? null,
        prob_best: round4(probByKey.get(r.variant_key ?? "(none)") ?? 0),
        live: isArmLive(r),
        arm: r.arm ?? null,
        split_pct: r.arm_split_pct == null || r.arm_split_pct === ""
          ? null
          : Number.isFinite(Number(r.arm_split_pct)) ? Number(r.arm_split_pct) : null,
      })),
      leader: conf.leader,
      prob_leader_best: round4(conf.prob_leader_best),
      conclusive: conf.conclusive,
      experiment_status: first.experiment_status ?? null,
      channel: arms.find((r) => r.channel)?.channel ?? null,
      last_sent_at: arms.reduce<string | null>(
        (m, r) => (r.last_sent_at && (!m || r.last_sent_at > m) ? r.last_sent_at : m), null),
      live_variants: arms.filter((r) => isArmLive(r)).length,
    });
  }
  return out.sort((a, b) => a.objective_key.localeCompare(b.objective_key) || a.rank - b.rank
    || (a.experiment_key ?? "").localeCompare(b.experiment_key ?? ""));
}

// ---------------------------------------------------------------------
// Experiment-shaped view.
//
// The dashboard used to render one card per (objective × component), so an
// experiment's primary and secondary outcomes appeared as two cards separated
// by every other experiment's primary — you could not see "did the demo happen
// AND did it convert" together, which is the actual question.
//
// This regroups the same data by EXPERIMENT, pairs its components, and attaches
// that experiment's email engagement, so one card answers one question.
// ---------------------------------------------------------------------

import { experimentName, programLabel, type Program } from "./naming.js";

export interface ExperimentCard {
  objective_key: string;
  experiment_key: string | null;
  program: Program;
  program_label: string;
  title: string;
  facets: string[];
  confidence_threshold: number;
  /** Primary first, then secondary. */
  components: ComponentMetric[];
  /** Engagement for this experiment, when it is an email experiment. */
  engagement: EngagementVariant[] | null;
  /** Total decided observations across the primary component. */
  primary_denominator: number;
  /** True when only one arm is tagged — no A/B is possible, so show a rate not a race. */
  single_arm: boolean;
}

export interface ProgramGroup {
  program: Program;
  label: string;
  experiments: ExperimentCard[];
  /** Roll-ups for the program header. */
  n_experiments: number;
  n_conclusive: number;
  total_decided: number;
}

export function assembleExperiments(
  components: ComponentMetric[],
  engagement: EngagementExperiment[],
): ProgramGroup[] {
  const engByExp = new Map(engagement.map((e) => [e.experiment_key ?? "", e.variants]));

  const byExp = new Map<string, ComponentMetric[]>();
  for (const c of components) {
    const k = `${c.objective_key}::${c.experiment_key ?? ""}`;
    const g = byExp.get(k);
    if (g) g.push(c); else byExp.set(k, [c]);
  }

  const cards: ExperimentCard[] = [];
  for (const comps of byExp.values()) {
    const first = comps[0]!;
    const name = experimentName(first.objective_key, first.experiment_key);
    const ordered = [...comps].sort((a, b) => a.rank - b.rank);
    const primary = ordered[0];
    cards.push({
      objective_key: first.objective_key,
      experiment_key: first.experiment_key,
      program: name.program,
      program_label: name.programLabel,
      title: name.title,
      facets: name.facets,
      confidence_threshold: first.confidence_threshold,
      components: ordered,
      engagement: engByExp.get(first.experiment_key ?? "") ?? null,
      primary_denominator: primary ? primary.variants.reduce((s, v) => s + v.denominator, 0) : 0,
      single_arm: (primary?.variants.length ?? 0) < 2,
    });
  }

  const byProgram = new Map<Program, ExperimentCard[]>();
  for (const c of cards) {
    const g = byProgram.get(c.program);
    if (g) g.push(c); else byProgram.set(c.program, [c]);
  }

  // Busiest experiments first inside a program; programs by total volume.
  const groups: ProgramGroup[] = [...byProgram.entries()].map(([program, exps]) => {
    exps.sort((a, b) => b.primary_denominator - a.primary_denominator || a.title.localeCompare(b.title));
    return {
      program,
      label: programLabel(program),
      experiments: exps,
      n_experiments: exps.length,
      n_conclusive: exps.filter((e) => e.components.some((c) => c.conclusive)).length,
      total_decided: exps.reduce((s, e) => s + e.primary_denominator, 0),
    };
  });
  groups.sort((a, b) => b.total_decided - a.total_decided);
  return groups;
}

// ---------------------------------------------------------------------
// Pulse — 14 days of volume, so the top of the page answers "what has
// actually been going out, and is anyone answering" before you read a
// single experiment card.
//
// Deliberately counts SENDS THAT DREW A REPLY rather than reply events.
// On 2026-08-20 variant C produced 10 reply events from 3 people while
// variant A produced 5 from 5 — on raw events C looked twice as engaging
// when it was actually confusing people into a back-and-forth. Distinct
// replied-sends is the honest denominator.
// ---------------------------------------------------------------------
export interface PulseDay {
  day: string;
  channel: string;
  sends: number;
  replied_sends: number;
}

// Reads comms.v_send_pulse rather than comms.communications + comms.events:
// comms_writer has SELECT on neither base table, and a dashboard that needs a
// daily count should not be handed the whole message ledger to get it. The
// aggregation and the 14-day window live in the view (migration 0076).
const PULSE_SQL = `
  SELECT day::text AS day, channel, sends, replied_sends
    FROM comms.v_send_pulse
   ORDER BY 1, 2`;

export async function fetchPulse(cfg: EndpointConfig): Promise<PulseDay[]> {
  const resp = await fetch(cfg.endpointUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Identity": cfg.identity, "X-Internal-Secret": cfg.bearer },
    body: JSON.stringify({ sql: PULSE_SQL, params: [] }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new MetricsError(`pulse endpoint ${resp.status}: ${text.slice(0, 300)}`);
  let json: { ok?: boolean; rows?: PulseDay[]; error?: unknown };
  try { json = JSON.parse(text); } catch { throw new MetricsError(`bad pulse JSON: ${text.slice(0, 200)}`); }
  if (json.ok !== true || !Array.isArray(json.rows)) {
    throw new MetricsError(`pulse endpoint error: ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
  }
  return json.rows;
}
