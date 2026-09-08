import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assemble, assembleExperiments } from "../src/metrics-client.js";

// The browser modules are plain ES modules with no top-level DOM access, so the
// card renders here exactly as it renders in the page. That matters: this is a
// rendering change, and the defect it fixes was only ever visible on screen.
// @ts-expect-error -- untyped browser module
const view = await import("../public/view-experiments.js");

const HERE = dirname(fileURLToPath(import.meta.url));

async function groups() {
  const raw = await readFile(join(HERE, "fixtures", "rates-2026-09-08.ndjson"), "utf8");
  const rows = raw.trim().split("\n").map((l) => JSON.parse(l));
  return assembleExperiments(assemble(rows, 4000), []);
}
const allCards = (gs: any[]) => gs.flatMap((g) => g.experiments);
const byTitle = (gs: any[], title: string, current = true) =>
  allCards(gs).find((c: any) => c.title === title && c.phase_is_current === current);

/** Tag balance — the cheap way to catch a broken template literal. */
function tagBalance(html: string): string[] {
  const VOID = new Set(["br", "hr", "img", "input", "line", "rect", "circle", "path", "use", "meta", "col"]);
  const stack: string[] = [];
  const problems: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, name, attrs, selfClose] = m;
    const tag = name!.toLowerCase();
    if (VOID.has(tag) || selfClose === "/" || attrs!.trimEnd().endsWith("/")) continue;
    if (closing) {
      const open = stack.pop();
      if (open !== tag) problems.push(`</${tag}> closes <${open ?? "nothing"}>`);
    } else stack.push(tag);
  }
  if (stack.length) problems.push(`unclosed: ${stack.join(", ")}`);
  return problems;
}

describe("a card is one experiment in one audience", async () => {
  const gs = await groups();

  it("splits DemoDriver-Model into one card per audience", () => {
    const model = allCards(gs).filter((c: any) => c.experiment_key === "DemoDriver-Model");
    assert.ok(model.length >= 18, `expected a card per audience, got ${model.length}`);
    const titles = new Set(model.map((c: any) => c.title));
    assert.equal(titles.size, model.length, "two cards share a title — the audience is not in the grain");
    assert.ok(!titles.has("Model"), 'the pooled "Model" card must be gone');
  });

  it("titles cards by audience, in words", () => {
    const c = byTitle(gs, "2+ days out · Touch 1 · Emerging");
    assert.ok(c, "no card for 2+Days · E1 · Emerging");
    assert.equal(c.audience, "2+Days · E1 · Emerging");
    assert.equal(c.is_audience_split, true);
  });

  it("puts exactly the two variations that ran there on it", () => {
    const c = byTitle(gs, "2+ days out · Touch 1 · Emerging");
    const vars = c.components[0].variations;
    assert.deepEqual(vars.map((v: any) => v.label), ["A · Generic", "D · GPT-5"]);
    assert.equal(vars[0].is_control, true, "the control leads");
    assert.equal(c.single_arm, false);
  });

  it("surfaces a head-to-head the registry arm was hiding", () => {
    // 2+Days · E1 · SMB runs D-GPT5 against E-GPT5. Both serve arm "ai", so
    // keying rows on the arm collapsed them into one row with no comparison.
    const c = byTitle(gs, "2+ days out · Touch 1 · SMB");
    const vars = c.components[0].variations;
    assert.equal(vars.length, 2, "two GPT-5 variants must not be merged");
    assert.deepEqual(vars.map((v: any) => v.label).sort(), ["D · GPT-5", "E · GPT-5"]);
    assert.deepEqual([...new Set(vars.map((v: any) => v.arm))], ["ai"], "they do share an arm");
    assert.ok(c.components[0].effect?.diff != null, "and they are still compared");
  });

  it("declines to claim a registered split it cannot speak to", () => {
    // Both variations serve "ai" at 50% each; 50/50 describes generic-vs-ai, not
    // D-vs-E, so the card must not print it.
    const c = byTitle(gs, "2+ days out · Touch 1 · SMB");
    for (const v of c.components[0].variations) assert.equal(v.intended_pct, null);
    assert.equal(c.components[0].srm, null);
  });

  it("compares only within the audience — one stratum, nothing orphaned", () => {
    for (const c of allCards(gs)) {
      const e = c.components[0]?.effect;
      if (!e || e.diff == null) continue;
      assert.equal(e.n_strata_paired, 1, `${c.title} spans ${e.n_strata_paired} audiences`);
      assert.equal(e.n_orphan, 0, `${c.title} has orphaned outcomes on a single-audience card`);
      assert.equal(e.simpson, false, "one audience cannot disagree with itself");
    }
  });
});

describe("allocation warnings are per audience", async () => {
  const gs = await groups();

  it("fires where one variation took nearly all the sends", () => {
    const c = byTitle(gs, "2+ days out · Touch 1 · Emerging"); // 66 vs 649
    assert.equal(c.components[0].srm.mismatch, true);
    const issues = view.integrityIssues(c.components[0]);
    assert.equal(issues.length, 1);
    assert.match(issues[0].body, /D · GPT-5 took 91%/);
  });

  it("stays quiet where the audience was split evenly", () => {
    const c = byTitle(gs, "Same day · Touch 1 · Emerging"); // 210 vs 211
    assert.equal(c.components[0].srm.mismatch, false);
    assert.deepEqual(view.integrityIssues(c.components[0]), []);
  });

  it("no longer claims the arms came from different populations", () => {
    // They did not: both variations on a card went to the same audience. A
    // lopsided split makes the comparison imprecise, not biased.
    const c = byTitle(gs, "2+ days out · Touch 1 · Emerging");
    const body = view.integrityIssues(c.components[0])[0].body;
    assert.doesNotMatch(body, /same pool of people/);
    assert.match(body, /went to\s+this same audience/);
  });
});

describe("the cross-audience roll-up", async () => {
  const gs = await groups();
  const demoEmail: any = gs.find((g: any) => g.program === "demo_driver_email");

  it("is one line on the program, not a card", () => {
    assert.equal(demoEmail.rollups.length, 1);
    assert.ok(!allCards(gs).some((c: any) => c.title === "Model"));
  });

  it("states the within-audience answer and flags the pooled reversal", () => {
    const r: any = demoEmail.rollups[0];
    assert.equal(r.control_label, "Generic");
    assert.equal(r.contender_label, "AI");
    assert.ok(r.diff < 0, "within audience, the AI copy is behind");
    assert.ok(r.pooled_diff > 0, "pooled, it leads");
    assert.equal(r.simpson, true);
    assert.equal(r.n_strata_paired, 10);
    assert.ok(r.n_orphan > 2000);
    assert.match(view.rollupBanner(r), /the opposite\s+sign/);
  });

  it("appears only where an experiment actually spans audiences", () => {
    for (const g of gs) {
      if (g.program === "demo_driver_email") continue;
      assert.deepEqual(g.rollups, [], `${g.program} should have no roll-up`);
    }
  });
});

describe("intervals never claim precision they do not have", async () => {
  const gs = await groups();

  it("gives 0-of-18 against 0-of-20 a real interval, not zero width", () => {
    const c = byTitle(gs, "Send test 3");
    const e = c.components[0].effect;
    assert.equal(e.diff, 0);
    assert.ok(e.ci_low < -0.05 && e.ci_high > 0.05,
      `no-information comparison reported [${e.ci_low}, ${e.ci_high}]`);
    assert.equal(e.p_value, 1);
    assert.equal(c.components[0].conclusive, false);
  });

  it("never reports a zero-width interval anywhere", () => {
    for (const c of allCards(gs)) {
      for (const comp of c.components ?? []) {
        const e = comp.effect;
        if (!e || e.diff == null) continue;
        assert.ok(e.ci_high - e.ci_low > 1e-9,
          `${c.title} / ${comp.outcome_type} has a zero-width interval`);
        assert.ok(e.ci_low <= e.diff && e.diff <= e.ci_high,
          `${c.title} interval does not contain its own estimate`);
      }
    }
  });

  it("only calls a winner when the interval clears zero", () => {
    for (const c of allCards(gs)) {
      for (const comp of c.components ?? []) {
        if (!comp.conclusive || !comp.effect || comp.effect.diff == null) continue;
        assert.ok(comp.effect.ci_low > 0 || comp.effect.ci_high < 0,
          `${c.title} is conclusive with an interval spanning zero`);
      }
    }
  });
});

describe("SMS and MQL are untouched by the split", async () => {
  const gs = await groups();

  it("keeps SMS morning-of as A vs D, control first", () => {
    const c = byTitle(gs, "SMS · Morning of");
    const vars = c.components[0].variations;
    assert.deepEqual(vars.map((v: any) => v.label), ["A · GPT-5", "D · GPT-5"]);
    assert.equal(vars[0].is_control, true);
    assert.equal(c.is_audience_split, false, "SMS runs to one audience");
  });

  it("still links each variation to its sends and its replies", () => {
    const html: string = view.expCard(byTitle(gs, "SMS · Morning of"), false, true);
    assert.match(html, /#\/messages\?variant_key=DemoDriver-SMS-MorningOf-A-GPT5/);
    assert.match(html, /replied=true/);
  });

  it("keeps the MQL A vs SEP comparison on one card", () => {
    const c = byTitle(gs, "Email 1");
    assert.deepEqual(c.components[0].variations.map((v: any) => v.label).sort(),
                     ["A · GPT-5.1", "SEP · GPT-5.1"]);
  });
});

describe("every card in the live snapshot", async () => {
  const gs = await groups();
  const all = allCards(gs);

  it("is either a head-to-head or plainly marked as untested", () => {
    const tested = all.filter((c: any) => !c.single_arm);
    assert.ok(tested.length >= 15, `only ${tested.length} head-to-head cards`);
    for (const c of tested) {
      assert.ok(c.components[0].variations.length >= 2, `${c.title} is marked tested with one variation`);
    }
    for (const c of all.filter((x: any) => x.single_arm)) {
      const v = view.verdict(view.primaryOf(c), c);
      assert.equal(v.tone, "single");
      assert.match(v.text, /not being tested/);
    }
  });

  it("names variations without repeating the audience", () => {
    const problems: string[] = [];
    for (const c of all) {
      for (const v of c.components[0]?.variations ?? []) {
        if (v.label.length > 28) problems.push(`${c.title}: run-on label "${v.label}"`);
        if (c.audience && v.label.includes(c.audience.split("·")[0]!.trim())) {
          problems.push(`${c.title}: label repeats the audience: "${v.label}"`);
        }
      }
    }
    assert.deepEqual(problems, []);
  });

  it("renders well-formed markup in every state", () => {
    const problems: string[] = [];
    for (const c of all) {
      for (const [archive, expanded] of [[false, true], [false, false], [true, true]] as const) {
        const bad = tagBalance(view.expCard(c, archive, expanded));
        if (bad.length) problems.push(`${c.title} [${archive},${expanded}]: ${bad.join("; ")}`);
      }
    }
    assert.deepEqual(problems, []);
    for (const g of gs) assert.deepEqual(tagBalance(view.programBlock(g)), [], `${g.program} block`);
  });

  it("gives every card a verdict it can render", () => {
    for (const c of all) {
      const v = view.verdict(view.primaryOf(c), c);
      assert.ok(["waiting", "single", "thin", "conclusive"].includes(v.tone), `${c.title}: "${v.tone}"`);
      assert.ok(v.text && !/undefined|NaN/.test(v.text), `${c.title}: "${v.text}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Regressions found by adversarial review, every one of which the suite above
// passed straight through. Each test here fails against the code as it was.
// ---------------------------------------------------------------------------
const slt = (vk: string, att: number, den: number, o: any = {}) => ({
  objective_key: "hubspot_tofu_email", objective_version: 1, rank: 1, label: "primary",
  outcome_type: "replied", eval_mode: "disposition", experiment_key: "SLT-09", variant_key: vk,
  n_attained: att, n_failed: den - att, n_pending: 0, n_denominator: den,
  confidence_threshold: 0.95, stratum: null, control_arm: null,
  phase_no: 1, phase_is_current: true, phase_is_comparison: true, ...o,
});

describe("regression: which variation is the control", () => {
  it("does not depend on how much traffic each got", () => {
    // Was `sort(by denominator desc)[1]` — the SMALLER arm — so the roles and
    // the sign of the headline swapped whenever one side pulled ahead by one send.
    const seen = new Set<string>();
    for (const [na, nb] of [[100, 101], [100, 99], [500, 10], [10, 500]] as const) {
      const e = assemble([slt("A", 30, na), slt("Control", 30, nb)], 500)[0]!.effect!;
      seen.add(`${e.control_arm}->${e.contender_arm}`);
    }
    assert.equal(seen.size, 1, `control/contender roles moved with volume: ${[...seen].join(", ")}`);
    assert.ok([...seen][0]!.startsWith("Control->"), "the variation named Control should be the control");
  });

  it("prefers the registered control arm over the name heuristic", () => {
    const e = assemble([
      slt("A", 30, 100, { arm: "a", control_arm: "a" }),
      slt("Control", 30, 100, { arm: "b", control_arm: "a" }),
    ], 500)[0]!.effect!;
    assert.equal(e.control_arm, "A");
  });

  it("marks exactly one row as the control, never two", () => {
    const c = assemble([
      slt("A", 30, 100, { arm: "a", control_arm: "a" }),
      slt("B", 30, 100, { arm: "a", control_arm: "a" }),
    ], 500)[0]!;
    assert.equal(c.variations.filter((v: any) => v.is_control).length, 1,
      'two rows on one arm both wore a "control" chip');
  });

  it("does not throw when two rows share a variant key", () => {
    // Should be impossible from the view, but a crash here blanks the page.
    const c = assemble([slt("A", 5, 20), slt("A", 7, 30)], 500)[0]!;
    assert.equal(c.variations.length, 2);
    assert.equal(c.effect, null, "no effect is better than a thrown page");
  });
});

describe("regression: the verdict must not restate the interval", () => {
  it("quotes the real asymmetric range instead of a symmetric ±", () => {
    const c = assemble([slt("A", 5, 20), slt("Control", 15, 100)], 500)[0]!;
    const card = { single_arm: false, components: [c] };
    const v = view.verdict(c, card);
    const e = c.effect!;
    // The old text was `diff ± (width/2)`, which for [-32.6, +6.1] printed
    // [-29.4, +9.4] — a header contradicting the bar drawn beneath it.
    assert.doesNotMatch(v.text, /±/, "the Newcombe interval is not symmetric");
    for (const bound of [e.ci_low!, e.ci_high!]) {
      const pp = `${Math.abs(bound * 100).toFixed(1)}pp`;
      assert.ok(v.text.includes(pp), `verdict "${v.text}" omits its own bound ${pp}`);
    }
  });
});

describe("regression: the cross-audience roll-up", () => {
  const model = (o: any) => ({
    objective_key: "demo_driver_email", objective_version: 1, rank: 1, label: "primary",
    outcome_type: "demo_showed", eval_mode: "disposition", experiment_key: "X-Model",
    confidence_threshold: 0.95, phase_no: 1, phase_is_current: true, phase_is_comparison: true,
    control_arm: "a", n_pending: 0, ...o,
  });
  const two = [
    model({ variant_key: "a1", arm: "a", stratum: "S1", phase_no: 1, n_attained: 50, n_failed: 50, n_denominator: 100 }),
    model({ variant_key: "b1", arm: "b", stratum: "S1", phase_no: 1, n_attained: 50, n_failed: 50, n_denominator: 100 }),
    model({ variant_key: "a2", arm: "a", stratum: "S1", phase_no: 2, n_attained: 10, n_failed: 90, n_denominator: 100 }),
    model({ variant_key: "b2", arm: "b", stratum: "S1", phase_no: 2, n_attained: 10, n_failed: 90, n_denominator: 100 }),
    model({ variant_key: "a3", arm: "a", stratum: "S2", phase_no: 1, n_attained: 30, n_failed: 70, n_denominator: 100 }),
    model({ variant_key: "b3", arm: "b", stratum: "S2", phase_no: 1, n_attained: 30, n_failed: 70, n_denominator: 100 }),
  ];

  it("keeps each phase a separate stratum instead of pooling them", () => {
    const r: any = assembleExperiments(assemble(two, 500), [])[0]!.rollups[0];
    // Two audiences, three (audience, phase) comparisons. Pooling S1's two
    // phases is the same mix-of-periods error the stratification exists to stop.
    assert.equal(r.n_strata_paired, 3, "phases were pooled back into one stratum");
  });

  it("survives a third arm, and names what it left out", () => {
    const three = [...two, model({
      variant_key: "c1", arm: "c", stratum: "S1", phase_no: 1,
      n_attained: 90, n_failed: 10, n_denominator: 100,
    })];
    const r: any = assembleExperiments(assemble(three, 500), [])[0]!.rollups[0];
    assert.ok(r, "a third arm in one audience erased the whole program line");
    assert.deepEqual(r.ignored_arms, ["C"]);
    assert.match(view.rollupBanner(r), /Not included: C/);
  });
});

describe("regression: no zero-width interval on the stratified path either", () => {
  it("widens when every stratum is degenerate", async () => {
    const { stratifiedCompare } = await import("../src/stratify.js");
    const z = stratifiedCompare([
      { stratum: "S1", arm: "a", attained: 0, denominator: 50 },
      { stratum: "S1", arm: "b", attained: 0, denominator: 50 },
      { stratum: "S2", arm: "a", attained: 0, denominator: 40 },
      { stratum: "S2", arm: "b", attained: 0, denominator: 40 },
    ], "a", "b");
    assert.equal(z.diff, 0);
    assert.ok(z.ci_high! - z.ci_low! > 0.01,
      `stratified all-zero case still reported [${z.ci_low}, ${z.ci_high}]`);
    assert.equal(z.p_value, 1);
  });
});

describe("regression: a row with no outcomes is not the leader", () => {
  it("does not crown an unresolved variation", () => {
    const c = assemble([slt("A", 0, 0), slt("Control", 0, 0)], 500)[0]!;
    const html: string = view.expCard({ single_arm: false, components: [c], title: "t", facets: [] }, false, true);
    assert.equal((html.match(/class="arm leader"/g) ?? []).length, 0,
      "a variation with no decided outcomes was styled as the leader");
  });
});
