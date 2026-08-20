import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { enrichMessages, enrichCoverage, enrichLedgerBody } from "../src/ledger-enrich.js";

describe("enrichMessages", () => {
  test("adds a readable arm name using the shared naming rules", () => {
    const out = enrichMessages({
      ok: true,
      messages: [{
        communication_id: "c1",
        experiment_key: "DemoDriver-SMS-MorningOf",
        variant_key: "DemoDriver-SMS-MorningOf-D-GPT5",
      }],
    }) as { messages: Array<Record<string, unknown>> };
    assert.equal(out.messages[0]!["short_variant"], "D · GPT-5");
    // the original fields survive
    assert.equal(out.messages[0]!["communication_id"], "c1");
  });

  test("untagged sends get a label rather than a blank cell", () => {
    const out = enrichMessages({ messages: [{ variant_key: null, experiment_key: null }] }) as
      { messages: Array<Record<string, unknown>> };
    assert.equal(out.messages[0]!["short_variant"], "untagged");
  });

  test("does not mutate the upstream body", () => {
    const body = { messages: [{ variant_key: "X-A", experiment_key: "X" }] };
    enrichMessages(body);
    assert.equal("short_variant" in body.messages[0]!, false);
  });

  test("passes through a body with no messages array", () => {
    const body = { ok: false, error: "nope" };
    assert.deepEqual(enrichMessages(body), body);
  });
});

describe("enrichCoverage", () => {
  test("attaches flags with their hints and an overall health verdict", () => {
    const out = enrichCoverage({
      ok: true,
      coverage: [{ source_key: "s1", n_communications: 10, no_events_at_all: true }],
    }) as { coverage: Array<Record<string, unknown>> };
    const row = out.coverage[0]!;
    assert.equal(row["health"], "broken");
    const flags = row["flags"] as Array<{ key: string; hint: string }>;
    assert.equal(flags[0]!.key, "no_events_at_all");
    // The hint is the whole point of shipping flags to the browser: it is what
    // keeps "unmeasured" from being read as "0%".
    assert.match(flags[0]!.hint, /unmeasured/);
  });

  test("a source with sends and no flags is healthy, not unknown", () => {
    const out = enrichCoverage({ coverage: [{ source_key: "s", n_communications: 5 }] }) as
      { coverage: Array<Record<string, unknown>> };
    assert.equal(out.coverage[0]!["health"], "ok");
    assert.deepEqual(out.coverage[0]!["flags"], []);
  });
});

describe("enrichLedgerBody", () => {
  test("dispatches on the route head, so thread/<uuid> is enriched too", () => {
    const out = enrichLedgerBody("thread/8f14e45f-ceea-467a-9a3e-1c5a4f0d1b2c", {
      messages: [{ variant_key: "E-A", experiment_key: "E" }],
    }) as { messages: Array<Record<string, unknown>> };
    assert.equal(out.messages[0]!["short_variant"], "A");
  });

  test("leaves unknown routes alone", () => {
    const body = { ok: true, anything: 1 };
    assert.deepEqual(enrichLedgerBody("person", body), body);
  });
});
