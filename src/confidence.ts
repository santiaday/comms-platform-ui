// Bayesian A/B confidence — P(each variant has the highest true rate).
// Beta-Binomial with Jeffreys prior, Monte-Carlo over the joint posterior.
// Sequential-safe (you can peek hourly) and degrades gracefully at small N.
// Mirrors services/runtime/src/lib/comms-outcomes/confidence.ts in revops-agents.

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

export function computeConfidence(
  variants: VariantCounts[],
  threshold: number,
  opts: { samples?: number } = {},
): ExperimentConfidence {
  const samples = opts.samples ?? 50_000;
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
  const wins = new Map<string, number>(active.map((v) => [v.key, 0]));
  for (let i = 0; i < samples; i++) {
    let bestKey = active[0]!.key;
    let bestRate = -1;
    for (const v of active) {
      const r = betaSample(v.attained + 0.5, v.denominator - v.attained + 0.5);
      if (r > bestRate) { bestRate = r; bestKey = v.key; }
    }
    wins.set(bestKey, (wins.get(bestKey) ?? 0) + 1);
  }
  for (const v of out) if (v.denominator > 0) v.prob_best = (wins.get(v.key) ?? 0) / samples;
  const leaderV = out.filter((v) => v.denominator > 0).sort((a, b) => b.prob_best - a.prob_best)[0]!;
  return {
    variants: out,
    leader: leaderV.key,
    prob_leader_best: leaderV.prob_best,
    threshold,
    conclusive: active.length >= 2 && leaderV.prob_best >= threshold,
    total_n,
  };
}
