import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assemble, assembleEngagement } from "../src/metrics-client.js";
import { computeConfidence } from "../src/confidence.js";

const erow = (o: Partial<any>) => ({
  objective_key: "demo_driver_email", experiment_key: "DemoDriver-2+Days-E1-SMB", variant_key: "D",
  sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, bounced: 0, unsubscribed: 0, complained: 0,
  ...o,
});

describe("assembleEngagement", () => {
  it("groups by experiment and computes standard email rates", () => {
    const out = assembleEngagement([
      erow({ variant_key: "D", sent: 100, delivered: 95, opened: 40, clicked: 10, replied: 5, bounced: 5 }),
      erow({ variant_key: "E", sent: 50, delivered: 50, opened: 30, clicked: 8, replied: 4, bounced: 0 }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.experiment_key, "DemoDriver-2+Days-E1-SMB");
    const d = out[0]!.variants.find((v) => v.variant_key === "D")!;
    assert.equal(d.delivery_rate, 0.95);                          // delivered / sent
    assert.equal(d.open_rate, Math.round((40 / 95) * 1e4) / 1e4); // opened / delivered
    assert.equal(d.reply_rate, Math.round((5 / 95) * 1e4) / 1e4);
    assert.equal(d.bounce_rate, 0.05);                            // bounced / sent
  });

  it("returns null rates (not 0%) when the denominator is zero — unpolled is not 0%", () => {
    const out = assembleEngagement([erow({ variant_key: "D", sent: 1, delivered: 0 })]);
    const d = out[0]!.variants[0]!;
    assert.equal(d.delivery_rate, 0);   // 0 delivered of 1 sent IS measurable
    assert.equal(d.open_rate, null);    // opened/delivered with delivered=0 -> unknown, not 0%
    assert.equal(d.reply_rate, null);
  });

  it("splits distinct experiments into separate groups", () => {
    const out = assembleEngagement([
      erow({ experiment_key: "X", sent: 1 }),
      erow({ experiment_key: "Y", sent: 1 }),
    ]);
    assert.equal(out.length, 2);
  });
});

const row = (o: Partial<any>) => ({
  objective_key: "demo_driver_morning_sms", objective_version: 1, rank: 1, label: "primary",
  outcome_type: "demo_showed", eval_mode: "disposition", experiment_key: "DemoDriver-SMS-MorningOf",
  variant_key: "A", n_attained: 0, n_failed: 0, n_pending: 0, n_denominator: 0, confidence_threshold: 0.95,
  ...o,
});

describe("assemble", () => {
  it("groups variants into one component and computes a leader", () => {
    const out = assemble([
      row({ variant_key: "A", n_attained: 13, n_failed: 21, n_denominator: 34 }),
      row({ variant_key: "B", n_attained: 7, n_failed: 9, n_denominator: 16 }),
    ], 20_000);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.variants.length, 2);
    assert.equal(out[0]!.leader, "B"); // 44% > 38%
    assert.ok(!out[0]!.conclusive); // small N, not 95%
    const a = out[0]!.variants.find((v) => v.variant_key === "A")!;
    assert.equal(a.rate, 0.3824);
  });

  it("separates components (rank) and experiments into distinct cards", () => {
    const out = assemble([
      row({ rank: 1, variant_key: "A", n_attained: 5, n_failed: 5, n_denominator: 10 }),
      row({ rank: 2, label: "secondary", outcome_type: "converted_to_opp", eval_mode: "window", variant_key: "A" }),
    ], 5_000);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((c) => c.rank).sort(), [1, 2]);
  });
});

describe("computeConfidence sanity", () => {
  it("is conclusive for a strong split with ample data", () => {
    const r = computeConfidence([{ key: "A", attained: 80, denominator: 100 }, { key: "B", attained: 20, denominator: 100 }], 0.95);
    assert.ok(r.conclusive && r.leader === "A");
  });

  it("does NOT let a tiny sample dominate P(best) or declare a winner", () => {
    // 9/9 (100%) vs 8/16 (50%): a flat prior would give ~100% P(best).
    const r = computeConfidence([{ key: "gift", attained: 9, denominator: 9 }, { key: "b", attained: 8, denominator: 16 }], 0.95);
    const gift = r.variants.find((v) => v.key === "gift")!;
    assert.ok(gift.prob_best < 0.98, `shrunk P(best) should be < 0.98, got ${gift.prob_best}`);
    assert.equal(r.conclusive, false); // leader n=9 < minN(30) → never a winner
  });

  it("gates 'conclusive' on the leader's decided sample size (minN)", () => {
    // Strong split but leader has only 20 decided → not conclusive by minN.
    const small = computeConfidence([{ key: "A", attained: 18, denominator: 20 }, { key: "B", attained: 2, denominator: 20 }], 0.95);
    assert.equal(small.conclusive, false);
    // Same rates, ample data → conclusive.
    const big = computeConfidence([{ key: "A", attained: 90, denominator: 100 }, { key: "B", attained: 10, denominator: 100 }], 0.95);
    assert.ok(big.conclusive);
  });
});

describe("assemble drops the (none) / untagged arm", () => {
  it("excludes null variant_key rows from arms and P(best)", () => {
    const out = assemble([
      row({ variant_key: "A", n_attained: 55, n_failed: 55, n_denominator: 110 }),
      row({ variant_key: "B", n_attained: 43, n_failed: 34, n_denominator: 77 }),
      row({ variant_key: null as any, n_attained: 5, n_failed: 2, n_denominator: 7 }),
    ], 20_000);
    assert.equal(out.length, 1);
    const keys = out[0]!.variants.map((v) => v.variant_key);
    assert.deepEqual(keys.sort(), ["A", "B"]); // (none) gone
    assert.notEqual(out[0]!.leader, "(none)");
    // P(best) across the two real arms sums to ~1 (nothing leaked to (none)).
    const total = out[0]!.variants.reduce((s, v) => s + v.prob_best, 0);
    assert.ok(Math.abs(total - 1) < 0.02, `P(best) should sum to ~1, got ${total}`);
  });
});
