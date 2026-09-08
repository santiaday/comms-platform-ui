import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assemble, assembleExperiments } from "../src/metrics-client.js";

// The browser modules are plain ES modules with no top-level DOM access, so the
// card can be rendered here exactly as it renders in the page. That matters:
// this whole change is a rendering change, and the defect it fixes was visible
// only in the rendered output.
// @ts-expect-error -- untyped browser module
const view = await import("../public/view-experiments.js");

const HERE = dirname(fileURLToPath(import.meta.url));

async function cards() {
  const raw = await readFile(join(HERE, "fixtures", "rates-2026-09-08.ndjson"), "utf8");
  const rows = raw.trim().split("\n").map((l) => JSON.parse(l));
  return assembleExperiments(assemble(rows, 4000), []);
}
const findCard = (groups: any[], title: string, current = true) =>
  groups.flatMap((g) => g.experiments).find((c: any) => c.title === title && c.phase_is_current === current);

/** Tag balance, which is the cheap way to catch a broken template literal. */
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

describe("the Demo Driver email card", async () => {
  const groups = await cards();
  const card = findCard(groups, "Model");
  const primary = card.components[0];
  const html: string = view.expCard(card, false, true);

  it("has two arms, not thirty", () => {
    assert.equal(primary.arms.length, 2, "the registry says generic vs ai");
    assert.deepEqual(primary.arms.map((a: any) => a.label).sort(), ["AI", "Generic"]);
    assert.equal(card.single_arm, false);
  });

  it("never prints a run-on 'vs' list of variant keys", () => {
    // The exact defect: an arms_label built from 30 variant keys.
    const vs = html.split(/\bvs\b/).length - 1;
    assert.ok(vs <= 4, `"vs" appears ${vs} times — the header is listing keys again`);
    assert.ok(!/DemoDriver-2\+Days-E1-Emerging-A-Generic\s+vs/.test(html),
      "a variant key is being used as an arm name");
  });

  it("names the arms and marks the registered control", () => {
    assert.match(html, /class="armchip[^"]*">Generic/);
    assert.match(html, /class="armchip[^"]*">AI/);
    assert.equal(primary.arms.find((a: any) => a.is_control)?.arm, "generic");
    assert.match(html, /control/);
  });

  it("pools every variant of an arm into it", () => {
    const ai = primary.arms.find((a: any) => a.arm === "ai");
    const generic = primary.arms.find((a: any) => a.arm === "generic");
    assert.ok(ai.variant_keys.length > 5, "the AI arm spans many variant keys");
    assert.ok(generic.variant_keys.length > 5);
    assert.equal(
      ai.denominator + generic.denominator,
      primary.variants.reduce((s: number, v: any) => s + v.denominator, 0),
      "no outcome may be lost or double-counted in the rollup",
    );
  });

  it("shows the traffic each arm ACTUALLY got, beside what was registered", () => {
    const ai = primary.arms.find((a: any) => a.arm === "ai");
    assert.equal(ai.intended_pct, 50);
    assert.ok(ai.observed_pct > 60, `AI got ${ai.observed_pct}% — the card must not claim 50%`);
    assert.match(html, /arm-share skew/, "a 19pp gap has to be marked as a gap");
  });

  it("warns that the split is not what was registered", () => {
    assert.equal(primary.srm.mismatch, true);
    const issues = view.integrityIssues(primary);
    assert.ok(issues.some((i: any) => i.key === "srm"), "no SRM warning raised");
    assert.match(html, /Traffic is not split the way it was registered/);
  });

  it("warns that half the experiment has no comparator", () => {
    const issues = view.integrityIssues(primary);
    assert.ok(issues.some((i: any) => i.key === "orphan"));
    assert.ok(primary.effect.n_orphan > 2000);
    assert.match(html, /cannot be compared at all/);
  });

  it("leads with the within-audience difference, not the pooled one", () => {
    const e = primary.effect;
    assert.ok(e.diff < 0, "generic is ahead within audience");
    assert.ok(e.pooled_diff > 0, "pooling says the opposite");
    assert.equal(e.simpson, true);
    assert.match(html, /within audience/);
    assert.match(html, /the opposite sign/);
  });

  it("does not declare a winner on a straddling interval", () => {
    assert.equal(primary.conclusive, false);
    const v = view.verdict(primary, card);
    assert.equal(v.tone, "waiting");
    assert.match(v.text, /no difference/);
  });

  it("offers the audience breakdown that justifies the headline", () => {
    const open = view.strataBlock(primary, card);
    assert.match(open, /audiences where both arms ran/);
    assert.equal(primary.effect.strata.length, primary.effect.n_strata_paired);
  });

  it("renders well-formed markup", () => {
    assert.deepEqual(tagBalance(html), []);
  });
});

describe("the SMS card still works, and is not collapsed by the rollup", async () => {
  const groups = await cards();
  const card = findCard(groups, "SMS · Morning of");
  const primary = card.components[0];

  it("keeps A vs D as the current comparison", () => {
    assert.deepEqual(primary.arms.map((a: any) => a.label).sort(), ["A", "D"]);
    assert.equal(primary.arms.find((a: any) => a.is_control)?.arm, "a");
  });

  it("has one variant per arm, so per-arm ledger links still appear", () => {
    for (const a of primary.arms) assert.equal(a.variant_keys.length, 1);
    const html: string = view.expCard(card, false, true);
    assert.match(html, /#\/messages\?variant_key=/);
    assert.match(html, /replied=true/);
  });

  it("raises no allocation warning on a genuinely balanced test", () => {
    assert.deepEqual(view.integrityIssues(primary), []);
    assert.equal(primary.srm?.mismatch, false);
  });

  it("reports a flat, honest result rather than a winner", () => {
    assert.equal(primary.conclusive, false);
    assert.ok(Math.abs(primary.effect.diff) < 0.05);
    assert.deepEqual(tagBalance(view.expCard(card, false, true)), []);
  });
});

describe("every card in the live snapshot", async () => {
  const groups = await cards();
  const all = groups.flatMap((g: any) => g.experiments);

  it("covers all four programs", () => {
    assert.ok(all.length >= 15, `only ${all.length} cards assembled`);
    assert.ok(groups.length >= 4, `only ${groups.length} programs`);
  });

  it("renders well-formed markup, expanded and collapsed, live and archived", () => {
    const problems: string[] = [];
    for (const card of all) {
      for (const [archive, expanded] of [[false, true], [false, false], [true, true]] as const) {
        const bad = tagBalance(view.expCard(card, archive, expanded));
        if (bad.length) problems.push(`${card.program}/${card.title} [${archive},${expanded}]: ${bad.join("; ")}`);
      }
    }
    assert.deepEqual(problems, []);
  });

  it("never labels an arm with a run-on key", () => {
    // An UNREGISTERED variant legitimately is its own arm, and "A" or "Control"
    // is the right label for it — the defect was never a short label, it was a
    // label that carried the whole key (and, in the header, thirty of them).
    const problems: string[] = [];
    for (const card of all) {
      for (const c of card.components ?? []) {
        for (const a of c.arms ?? []) {
          if (a.label.length > 40) problems.push(`${card.title}: run-on arm label "${a.label}"`);
          if (a.label.includes(" vs ")) problems.push(`${card.title}: arm label lists arms: "${a.label}"`);
          if (card.experiment_key && a.label.startsWith(card.experiment_key)) {
            problems.push(`${card.title}: arm label repeats the experiment key: "${a.label}"`);
          }
        }
      }
    }
    assert.deepEqual(problems, []);
  });

  it("gives every card a verdict it can actually render", () => {
    for (const card of all) {
      const v = view.verdict(view.primaryOf(card), card);
      assert.ok(["waiting", "single", "thin", "conclusive"].includes(v.tone),
        `${card.title} produced tone "${v.tone}"`);
      assert.ok(v.text && !v.text.includes("undefined") && !v.text.includes("NaN"),
        `${card.title} verdict reads "${v.text}"`);
    }
  });

  it("only claims a winner where the interval actually excludes zero", () => {
    for (const card of all) {
      for (const c of card.components ?? []) {
        if (!c.conclusive || !c.effect || c.effect.diff == null) continue;
        assert.ok(c.effect.ci_low > 0 || c.effect.ci_high < 0,
          `${card.title} is "conclusive" with an interval spanning zero`);
      }
    }
  });
});
