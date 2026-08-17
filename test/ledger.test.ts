import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildLedgerUrl,
  isKnownRoute,
  resolveLedgerConfig,
  coverageFlags,
  coverageHealth,
} from "../src/ledger-client.js";

// Synthetic values only — no production hosts, emails, or identifiers.
const BASE = "https://ledger.invalid/prod";

describe("resolveLedgerConfig", () => {
  it("requires both env vars — there is deliberately no default URL", () => {
    assert.ok("error" in resolveLedgerConfig({}));
    assert.ok("error" in resolveLedgerConfig({ LEDGER_API_URL: BASE }));
    assert.ok("error" in resolveLedgerConfig({ LEDGER_BEARER: "s" }));
  });

  it("strips a trailing slash so URL joining cannot double up", () => {
    const cfg = resolveLedgerConfig({ LEDGER_API_URL: BASE + "///", LEDGER_BEARER: "s" });
    assert.ok(!("error" in cfg));
    if ("error" in cfg) return;
    assert.equal(cfg.baseUrl, BASE);
  });
});

describe("isKnownRoute", () => {
  it("accepts the four routes and a uuid message id", () => {
    assert.ok(isKnownRoute("coverage"));
    assert.ok(isKnownRoute("messages"));
    assert.ok(isKnownRoute("person"));
    assert.ok(isKnownRoute("message/11111111-2222-3333-4444-555555555555"));
  });

  it("rejects traversal and unknown routes", () => {
    assert.ok(!isKnownRoute("message/../../secrets"));
    assert.ok(!isKnownRoute("message/not-a-uuid"));
    assert.ok(!isKnownRoute("admin"));
    assert.ok(!isKnownRoute(""));
  });
});

describe("buildLedgerUrl", () => {
  it("forwards only allowlisted params", () => {
    const p = new URLSearchParams({
      source_key: "hubspot",
      channel: "email",
      evil: "1",
      sql: "drop",
    });
    const url = buildLedgerUrl(BASE, "messages", p);
    assert.ok(url.includes("source_key=hubspot"));
    assert.ok(url.includes("channel=email"));
    assert.ok(!url.includes("evil"), "non-allowlisted param must be dropped");
    assert.ok(!url.includes("sql"), "non-allowlisted param must be dropped");
  });

  it("drops every param for coverage", () => {
    const url = buildLedgerUrl(BASE, "coverage", new URLSearchParams({ limit: "5" }));
    assert.equal(url, `${BASE}/comms-ledger/coverage`);
  });

  it("url-encodes forwarded values", () => {
    const url = buildLedgerUrl(
      BASE,
      "person",
      new URLSearchParams({ id_type: "email", id_value: "a b&c@example.invalid" }),
    );
    assert.ok(!url.includes(" "), "spaces must be encoded");
    assert.ok(url.includes("id_value=a+b%26c%40example.invalid"));
  });

  it("ignores empty values rather than sending blank filters", () => {
    const url = buildLedgerUrl(BASE, "messages", new URLSearchParams({ source_key: "" }));
    assert.equal(url, `${BASE}/comms-ledger/messages`);
  });
});

describe("coverageFlags", () => {
  it("returns nothing for a healthy source", () => {
    assert.deepEqual(coverageFlags({ n_communications: 100 }), []);
  });

  it("flags sends with no engagement as bad, and says why", () => {
    const flags = coverageFlags({ n_communications: 482, no_engagement: true });
    assert.equal(flags.length, 1);
    assert.equal(flags[0]!.key, "no_engagement");
    assert.equal(flags[0]!.tone, "bad");
    assert.match(flags[0]!.hint, /unmeasured, not 0%/);
  });

  it("reproduces the live HubSpot signature: no engagement + unattributable + unbound", () => {
    const keys = coverageFlags({
      n_communications: 482,
      no_engagement: true,
      unattributable: true,
      unbound: true,
    }).map((f) => f.key);
    assert.deepEqual(keys, ["no_engagement", "unattributable", "unbound"]);
  });

  it("flags a declared-but-silent source", () => {
    const flags = coverageFlags({ n_communications: 0, declared_silent: true });
    assert.equal(flags[0]!.key, "declared_silent");
    assert.equal(flags[0]!.tone, "warn");
  });
});

describe("coverageHealth", () => {
  it("is ok only when a source has flowed and has no flags", () => {
    assert.equal(coverageHealth({ n_communications: 4740 }), "ok");
  });

  it("is unknown — not ok — when a source has produced nothing", () => {
    // Absence of data is not evidence of health.
    assert.equal(coverageHealth({ n_communications: 0 }), "unknown");
  });

  it("is broken when any flag is severe, degraded when only warnings", () => {
    assert.equal(coverageHealth({ n_communications: 482, no_engagement: true }), "broken");
    assert.equal(coverageHealth({ n_communications: 20, unbound: true }), "degraded");
  });
});
