import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chiSquareP, normalTwoSidedP, stratifiedCompare, sampleRatioMismatch, type Cell,
} from "../src/stratify.js";

const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} not within ${tol} of ${b}`);

describe("tail probabilities", () => {
  it("matches the chi-square table", () => {
    near(chiSquareP(3.8415, 1), 0.05, 1e-4, "chi2(1) at 5%");
    near(chiSquareP(6.6349, 1), 0.01, 1e-4, "chi2(1) at 1%");
    near(chiSquareP(10.828, 1), 0.001, 1e-5, "chi2(1) at 0.1%");
    near(chiSquareP(5.9915, 2), 0.05, 1e-4, "chi2(2) at 5%");
    near(chiSquareP(16.919, 9), 0.05, 1e-3, "chi2(9) at 5%");
  });
  it("matches the normal table", () => {
    near(normalTwoSidedP(1.959964), 0.05, 1e-6, "z=1.96");
    near(normalTwoSidedP(2.575829), 0.01, 1e-6, "z=2.58");
    near(normalTwoSidedP(0), 1, 1e-12, "z=0");
  });
  it("is defined at the degenerate edges", () => {
    assert.equal(chiSquareP(0, 1), 1);
    assert.equal(chiSquareP(-1, 1), 1);
    assert.equal(chiSquareP(5, 0), 1);
  });
});

// The real thing, pulled from comms.v_objective_rates_phased on 2026-09-08:
// DemoDriver-Model, demo_showed, every stratum with any decided outcome.
// This is the fixture that matters -- it is the exact shape that made the Hub
// claim the AI arm was ahead.
const DEMO_DRIVER: Cell[] = [
  { stratum: "2+Days · E1 · Emerging",       arm: "ai",      attained: 172, denominator: 645 },
  { stratum: "2+Days · E1 · Emerging",       arm: "generic", attained:  18, denominator:  66 },
  { stratum: "2+Days · E1 · MM",             arm: "ai",      attained:  42, denominator: 122 },
  { stratum: "2+Days · E1 · MM",             arm: "generic", attained:  38, denominator: 123 },
  { stratum: "2+Days · E1 · SMB",            arm: "ai",      attained: 149, denominator: 385 },
  { stratum: "2+Days · Middle · Emerging",   arm: "ai",      attained:  65, denominator: 260 },
  { stratum: "2+Days · Middle · Emerging",   arm: "generic", attained:  22, denominator:  70 },
  { stratum: "2+Days · Middle · MM",         arm: "ai",      attained:  27, denominator:  72 },
  { stratum: "2+Days · Middle · MM",         arm: "generic", attained:  12, denominator:  23 },
  { stratum: "2+Days · Middle · SMB",        arm: "ai",      attained:  55, denominator: 134 },
  { stratum: "2+Days · Middle · SMB",        arm: "generic", attained:  18, denominator:  43 },
  { stratum: "2+Days · MorningOf · Emerging", arm: "ai",      attained:  66, denominator: 197 },
  { stratum: "2+Days · MorningOf · Emerging", arm: "generic", attained: 108, denominator: 291 },
  { stratum: "2+Days · MorningOf · MM",      arm: "ai",      attained:  62, denominator: 137 },
  { stratum: "2+Days · MorningOf · SMB",     arm: "ai",      attained: 136, denominator: 282 },
  { stratum: "NextDay · E1 · Emerging",      arm: "generic", attained: 161, denominator: 521 },
  { stratum: "NextDay · E1 · MM",            arm: "ai",      attained:  16, denominator:  32 },
  { stratum: "NextDay · E1 · MM",            arm: "generic", attained:  62, denominator: 136 },
  { stratum: "NextDay · E1 · SMB",           arm: "ai",      attained: 146, denominator: 301 },
  { stratum: "NextDay · MorningOf · Emerging", arm: "ai",    attained: 149, denominator: 407 },
  { stratum: "NextDay · MorningOf · MM",     arm: "ai",      attained:  12, denominator:  23 },
  { stratum: "NextDay · MorningOf · MM",     arm: "generic", attained:  18, denominator:  31 },
  { stratum: "NextDay · MorningOf · SMB",    arm: "ai",      attained:  30, denominator:  54 },
  { stratum: "NextDay · MorningOf · SMB",    arm: "generic", attained:  52, denominator:  92 },
  { stratum: "SameDay · E1 · Emerging",      arm: "ai",      attained:  92, denominator: 211 },
  { stratum: "SameDay · E1 · Emerging",      arm: "generic", attained:  86, denominator: 210 },
  { stratum: "SameDay · E1 · MM",            arm: "ai",      attained:  55, denominator: 108 },
  { stratum: "SameDay · E1 · SMB",           arm: "ai",      attained: 168, denominator: 277 },
];

describe("stratifiedCompare — the Demo Driver reversal", () => {
  const r = stratifiedCompare(DEMO_DRIVER, "generic", "ai");

  it("counts what is and is not comparable", () => {
    assert.equal(r.n_strata_total, 18);
    assert.equal(r.n_strata_paired, 10);
    assert.equal(r.n_comparable, 2835);
    // 8 strata only ever ran one arm. Those 2,418 decided outcomes -- 46% of the
    // experiment -- cannot speak to a difference and must not be pooled in.
    assert.equal(r.n_orphan, 2418);
  });

  it("reproduces the naive number the Hub used to show", () => {
    near(r.pooled_diff! * 100, +2.49, 0.02, "pooled over every send");
  });

  it("flips sign once each arm is compared only against its own audience", () => {
    assert.ok(r.diff! < 0, `stratified diff should favour generic, got ${r.diff}`);
    near(r.diff! * 100, -1.1, 0.6, "stratified diff (pp)");
    assert.equal(r.simpson, true);
  });

  it("is nowhere near significant, in either direction", () => {
    assert.ok(r.p_value! > 0.4, `p should be large, got ${r.p_value}`);
    assert.ok(r.ci_low! < 0 && r.ci_high! > 0, "interval must straddle zero");
    near(r.ci_low! * 100, -5.2, 1.0, "CI low");
    near(r.ci_high! * 100, +2.9, 1.0, "CI high");
  });

  it("shows the AI arm behind in most segments where both ran", () => {
    assert.equal(r.contender_leads, 3);
    assert.equal(r.strata.length, 10);
    // Biggest stratum first, so the card's breakdown leads with the most evidence.
    assert.equal(r.strata[0]!.stratum, "2+Days · E1 · Emerging");
  });

  it("orders the interval consistently with the point estimate", () => {
    assert.ok(r.ci_low! < r.diff! && r.diff! < r.ci_high!);
  });
});

describe("stratifiedCompare — mechanics", () => {
  it("sums several variant keys serving the same arm in one stratum", () => {
    const split = stratifiedCompare([
      { stratum: "S", arm: "a", attained: 5, denominator: 10 },
      { stratum: "S", arm: "a", attained: 5, denominator: 10 },
      { stratum: "S", arm: "b", attained: 6, denominator: 20 },
    ], "a", "b");
    assert.equal(split.strata[0]!.control_denominator, 20);
    assert.equal(split.strata[0]!.control_attained, 10);
    near(split.diff!, 0.3 - 0.5, 1e-12, "b - a");
  });

  it("ignores arms that are not part of this comparison", () => {
    const r = stratifiedCompare([
      { stratum: "S", arm: "a", attained: 5, denominator: 10 },
      { stratum: "S", arm: "b", attained: 5, denominator: 10 },
      { stratum: "S", arm: "c", attained: 0, denominator: 999 },
    ], "a", "b");
    assert.equal(r.n_comparable, 20);
    assert.equal(r.n_strata_total, 1);
  });

  it("treats a null stratum as one undivided stratum", () => {
    const r = stratifiedCompare([
      { stratum: null, arm: "a", attained: 10, denominator: 100 },
      { stratum: null, arm: "b", attained: 20, denominator: 100 },
    ], "a", "b");
    assert.equal(r.n_strata_paired, 1);
    assert.equal(r.strata[0]!.stratum, null);
    near(r.diff!, 0.1, 1e-12, "diff");
    assert.equal(r.simpson, false, "one stratum can never disagree with itself");
  });

  it("returns a null estimate rather than a fake one when nothing is paired", () => {
    const r = stratifiedCompare([
      { stratum: "S", arm: "a", attained: 5, denominator: 10 },
      { stratum: "T", arm: "b", attained: 9, denominator: 10 },
    ], "a", "b");
    assert.equal(r.diff, null);
    assert.equal(r.p_value, null);
    assert.equal(r.n_strata_paired, 0);
    assert.equal(r.n_orphan, 20);
    assert.equal(r.simpson, false);
  });

  it("detects a textbook Simpson reversal", () => {
    // b wins in both strata, loses pooled, because it is concentrated in the
    // hard one.
    const r = stratifiedCompare([
      { stratum: "easy", arm: "a", attained: 81, denominator: 90 },
      { stratum: "easy", arm: "b", attained: 10, denominator: 10 },
      { stratum: "hard", arm: "a", attained: 1, denominator: 10 },
      { stratum: "hard", arm: "b", attained: 20, denominator: 90 },
    ], "a", "b");
    assert.ok(r.pooled_diff! < 0, "pooled favours a");
    assert.ok(r.diff! > 0, "stratified favours b");
    assert.equal(r.simpson, true);
    assert.equal(r.contender_leads, 2);
  });

  it("does not cry Simpson when both views agree", () => {
    const r = stratifiedCompare([
      { stratum: "x", arm: "a", attained: 10, denominator: 100 },
      { stratum: "x", arm: "b", attained: 20, denominator: 100 },
      { stratum: "y", arm: "a", attained: 30, denominator: 100 },
      { stratum: "y", arm: "b", attained: 40, denominator: 100 },
    ], "a", "b");
    assert.equal(r.simpson, false);
    assert.equal(r.contender_leads, 2);
  });

  it("survives a stratum where nobody attained anything", () => {
    const r = stratifiedCompare([
      { stratum: "z", arm: "a", attained: 0, denominator: 40 },
      { stratum: "z", arm: "b", attained: 0, denominator: 40 },
    ], "a", "b");
    assert.equal(r.diff, 0);
    assert.equal(r.p_value, 1, "zero variance must not produce a p-value of 0");
  });
});

describe("sampleRatioMismatch", () => {
  it("fires on the Demo Driver 31/69 against a declared 50/50", () => {
    const srm = sampleRatioMismatch([
      { arm: "generic", observed: 1606, intended_pct: 50 },
      { arm: "ai",      observed: 3647, intended_pct: 50 },
    ])!;
    assert.equal(srm.mismatch, true);
    assert.ok(srm.chi2 > 700, `chi2 was ${srm.chi2}`);
    near(srm.worst_gap_pp, 19.43, 0.05, "worst gap");
    assert.equal(srm.df, 1);
  });

  it("stays quiet on ordinary randomisation noise", () => {
    const srm = sampleRatioMismatch([
      { arm: "a", observed: 1010, intended_pct: 50 },
      { arm: "b", observed:  990, intended_pct: 50 },
    ])!;
    assert.equal(srm.mismatch, false);
    assert.ok(srm.p_value > 0.05);
  });

  it("handles an uneven declared split", () => {
    const srm = sampleRatioMismatch([
      { arm: "a",   observed: 300, intended_pct: 30 },
      { arm: "sep", observed: 700, intended_pct: 70 },
    ])!;
    assert.equal(srm.mismatch, false);
    near(srm.chi2, 0, 1e-9, "perfect match");
    near(srm.worst_gap_pp, 0, 1e-9, "no gap");
  });

  it("declines to judge when no split was ever declared", () => {
    assert.equal(sampleRatioMismatch([
      { arm: "a", observed: 100, intended_pct: null },
      { arm: "b", observed: 900, intended_pct: null },
    ]), null);
    assert.equal(sampleRatioMismatch([
      { arm: "a", observed: 100, intended_pct: 50 },
    ]), null, "one arm is not a ratio");
  });

  it("ignores arms declared at 0% rather than dividing by zero", () => {
    const srm = sampleRatioMismatch([
      { arm: "a",       observed: 300, intended_pct: 30 },
      { arm: "sep",     observed: 700, intended_pct: 70 },
      { arm: "a_gpt41", observed:  50, intended_pct: 0  },
    ])!;
    assert.equal(srm.arms.length, 2);
    assert.ok(Number.isFinite(srm.chi2));
  });
});
