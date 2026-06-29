import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assemble } from "../src/metrics-client.js";
import { computeConfidence } from "../src/confidence.js";

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
  it("is conclusive for a strong split", () => {
    const r = computeConfidence([{ key: "A", attained: 80, denominator: 100 }, { key: "B", attained: 20, denominator: 100 }], 0.95);
    assert.ok(r.conclusive && r.leader === "A");
  });
});
