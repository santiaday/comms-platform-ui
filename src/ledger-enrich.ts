// Enrichment for ledger responses, applied in the proxy.
//
// The browser should not re-implement things the server already knows and
// already tests. Two facts kept leaking into the client:
//
//   1. How to shorten a variant key. `shortVariant` lives in naming.ts and is
//      unit-tested; a second copy in app.js would drift the first time a new
//      model tag appears.
//   2. What a coverage flag means. `coverageFlags` carries the hints that
//      explain *why* "no events" is not "0% engagement" — the distinction that
//      let an eight-day HubSpot outage go unnoticed. Those hints belong in
//      tooltips, so they have to reach the browser.
//
// Both are pure functions over already-fetched JSON. Unknown shapes pass
// through untouched: the proxy must never be the reason a page goes blank.

import { shortVariant } from "./naming.js";
import { coverageFlags, coverageHealth } from "./ledger-client.js";

type Row = Record<string, unknown>;

const isRow = (v: unknown): v is Row =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Add `short_variant` to every message in a messages/thread response. */
export function enrichMessages(body: unknown): unknown {
  if (!isRow(body) || !Array.isArray(body["messages"])) return body;
  const messages = body["messages"].map((m) =>
    isRow(m)
      ? { ...m, short_variant: shortVariant(str(m["variant_key"]), str(m["experiment_key"])) }
      : m);
  return { ...body, messages };
}

/** Add `flags` (with hints) and `health` to every coverage row. */
export function enrichCoverage(body: unknown): unknown {
  if (!isRow(body) || !Array.isArray(body["coverage"])) return body;
  const coverage = body["coverage"].map((r) =>
    isRow(r) ? { ...r, flags: coverageFlags(r), health: coverageHealth(r) } : r);
  return { ...body, coverage };
}

/** Dispatch on route. Anything unrecognised is returned unchanged. */
export function enrichLedgerBody(route: string, body: unknown): unknown {
  const head = route.split("/")[0];
  if (head === "messages" || head === "thread" || head === "message") return enrichMessages(body);
  if (head === "coverage") return enrichCoverage(body);
  return body;
}
