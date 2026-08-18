import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { experimentName, shortVariant, programOf, programLabel } from "../src/naming.js";

describe("shortVariant — the main readability win", () => {
  it("strips the repeated experiment prefix and prettifies the model", () => {
    assert.equal(
      shortVariant("DemoDriver-2+Days-E1-Emerging-D-GPT5", "DemoDriver-2+Days-E1-Emerging"),
      "D · GPT-5",
    );
    assert.equal(
      shortVariant("DemoDriver-2+Days-E1-Emerging-A-Generic", "DemoDriver-2+Days-E1-Emerging"),
      "A · Generic",
    );
  });

  it("keeps a stray extra segment rather than guessing", () => {
    assert.equal(
      shortVariant("DemoDriver-2+Days-MorningOf-Emerging-E1-A-Generic", "DemoDriver-2+Days-MorningOf-Emerging"),
      "E1 · A · Generic",
    );
  });

  it("handles non-model variants and short keys", () => {
    assert.equal(
      shortVariant("DemoDriver-NextDay-MorningOf-MM-GiftOfferEmail", "DemoDriver-NextDay-MorningOf-MM"),
      "GiftOfferEmail",
    );
    assert.equal(shortVariant("A", "SLT-05"), "A");
    assert.equal(shortVariant("Control", "SLT-05"), "Control");
  });

  it("labels a null variant honestly instead of inventing one", () => {
    assert.equal(shortVariant(null, "DemoDriver-SMS-MorningOf"), "untagged");
  });

  it("leaves the key alone when it does not carry the prefix", () => {
    assert.equal(shortVariant("SomethingElse-X", "DemoDriver-2+Days"), "SomethingElse · X");
  });
});

describe("experimentName", () => {
  it("decodes the DemoDriver cohort/touch/segment triple", () => {
    const n = experimentName("demo_driver_email", "DemoDriver-2+Days-E1-Emerging");
    assert.equal(n.title, "2+ days out · Touch 1 · Emerging");
    assert.equal(n.program, "demo_driver_email");
    assert.deepEqual(n.facets, ["2+ days out", "Touch 1", "Emerging"]);
  });

  it("expands MM to Mid-market and MorningOf to Morning of", () => {
    assert.equal(
      experimentName("demo_driver_email", "DemoDriver-NextDay-MorningOf-MM").title,
      "Next day · Morning of · Mid-market",
    );
  });

  it("names SMS, MQL and HubSpot experiments in their own idiom", () => {
    assert.equal(experimentName("demo_driver_morning_sms", "DemoDriver-SMS-MorningOf").title, "SMS · Morning of");
    assert.equal(experimentName("mql_driver_email", "MQLDriver-Email-2-A").title, "Email 2");
    assert.equal(experimentName("hubspot_tofu_email", "SLT-05").title, "Send test 5");
  });

  it("falls through to the raw key for an unknown shape rather than mangling it", () => {
    const n = experimentName("something_new", "Totally-Novel-Key");
    assert.equal(n.title, "Totally-Novel-Key");
    assert.equal(n.program, "other");
  });

  it("handles a null experiment key", () => {
    assert.equal(experimentName("demo_driver_email", null).title, "—");
  });
});

describe("programOf", () => {
  it("buckets each objective into its program", () => {
    assert.equal(programOf("demo_driver_email", "DemoDriver-x"), "demo_driver_email");
    assert.equal(programOf("demo_driver_morning_sms", null), "demo_driver_sms");
    assert.equal(programOf("mql_driver_email", null), "mql_driver");
    assert.equal(programOf("hubspot_tofu_email", "SLT-01"), "hubspot_tofu");
  });

  it("recognises a HubSpot send test even with no objective bound yet", () => {
    assert.equal(programOf("", "SLT-09"), "hubspot_tofu");
  });

  it("gives every program a human label", () => {
    assert.equal(programLabel("demo_driver_sms"), "Demo Driver — SMS");
    assert.equal(programLabel("hubspot_tofu"), "HubSpot — Top of Funnel");
  });
});
