// Bayesian A/B confidence — P(each variant has the highest true rate).
// Beta-Binomial, Monte-Carlo over the joint posterior. Sequential-safe (you
// can peek hourly). Mirrors services/runtime/src/lib/comms-outcomes/confidence.ts.
//
// Prior: empirical-Bayes shrinkage toward the POOLED rate across the arms, with
// strength `priorStrength` pseudo-observations (+ a small Jeffreys floor for
// positivity). This is what stops a tiny arm from looking decisive — a 5/7 arm
// under a flat Jeffreys prior wins ~77% of draws; shrunk toward the pooled rate
// with ~20 pseudo-obs it correctly reads as "we don't know yet." Bigger arms
// (their own data >> prior) are barely moved, so real signal still surfaces.
//
// A winner is only "conclusive" when P(best) >= threshold AND the leader has at
// least `minN` decided observations — a fluke small sample can never declare a
// winner even if its posterior spikes.

export interface VariantCounts {
  key: string;
  attained: number;
  denominator: number;
}
export interface VariantConfidence extends VariantCounts {
  rate: number | null;
  prob_best: number;
}
export interface ExperimentConfidence {
  variants: VariantConfidence[];
  leader: string | null;
  prob_leader_best: number;
  threshold: number;
  conclusive: boolean;
  total_n: number;
}

function randn(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function gammaSample(k: number): number {
  if (k < 1) return gammaSample(k + 1) * Math.pow(Math.random(), 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let iter = 0; iter < 1000; iter++) {
    const x = randn();
    let v = 1 + c * x;
    if (v <= 0) continue;
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d;
}
function betaSample(a: number, b: number): number {
  const x = gammaSample(a);
  const y = gammaSample(b);
  return x / (x + y);
}

// Defaults: ~20 pseudo-obs of shrinkage, and a leader needs >=30 decided obs
// before any "winner" call. Override per-call via opts, or change here.
export const DEFAULT_PRIOR_STRENGTH = 20;
export const DEFAULT_MIN_N = 30;

export function computeConfidence(
  variants: VariantCounts[],
  threshold: number,
  opts: { samples?: number; priorStrength?: number; minN?: number } = {},
): ExperimentConfidence {
  const samples = opts.samples ?? 50_000;
  const priorStrength = opts.priorStrength ?? DEFAULT_PRIOR_STRENGTH;
  const minN = opts.minN ?? DEFAULT_MIN_N;
  const out: VariantConfidence[] = variants.map((v) => ({
    ...v,
    rate: v.denominator > 0 ? v.attained / v.denominator : null,
    prob_best: 0,
  }));
  const active = out.filter((v) => v.denominator > 0);
  const total_n = active.reduce((s, v) => s + v.denominator, 0);
  if (active.length === 0) {
    return { variants: out, leader: null, prob_leader_best: 0, threshold, conclusive: false, total_n: 0 };
  }
  if (active.length === 1) {
    active[0]!.prob_best = 1;
    return { variants: out, leader: active[0]!.key, prob_leader_best: 1, threshold, conclusive: false, total_n };
  }

  // Empirical-Bayes prior: shrink every arm toward the pooled rate. a0/b0 are
  // the prior's pseudo-attained / pseudo-missed; the +0.5 keeps shapes positive
  // even when the pooled rate is 0 or 1.
  const pooledAttained = active.reduce((s, v) => s + v.attained, 0);
  const pooledRate = pooledAttained / total_n;
  const a0 = pooledRate * priorStrength + 0.5;
  const b0 = (1 - pooledRate) * priorStrength + 0.5;

  const wins = new Map<string, number>(active.map((v) => [v.key, 0]));
  for (let i = 0; i < samples; i++) {
    let bestKey = active[0]!.key;
    let bestRate = -1;
    for (const v of active) {
      const r = betaSample(v.attained + a0, (v.denominator - v.attained) + b0);
      if (r > bestRate) { bestRate = r; bestKey = v.key; }
    }
    wins.set(bestKey, (wins.get(bestKey) ?? 0) + 1);
  }
  for (const v of out) if (v.denominator > 0) v.prob_best = (wins.get(v.key) ?? 0) / samples;
  const leaderV = active.slice().sort((a, b) => b.prob_best - a.prob_best)[0]!;
  return {
    variants: out,
    leader: leaderV.key,
    prob_leader_best: leaderV.prob_best,
    threshold,
    // Winner requires both statistical confidence AND enough data on the leader.
    conclusive: active.length >= 2 && leaderV.prob_best >= threshold && leaderV.denominator >= minN,
    total_n,
  };
}
