import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Every relation this app queries must be readable by the ONE identity it
// queries as: comms_writer.
//
// This test exists because that was got wrong in production. The liveness join
// read comms.experiments and the volume query read comms.communications and
// comms.events; comms_writer holds SELECT on none of the three, so the whole
// dashboard rendered as:
//
//   metrics query failed: endpoint 403 permission denied for table experiments
//
// The SQL was verified against the real database first — but over a direct psql
// connection as an operator role, which can read everything. The SQL was right
// and the identity was wrong, and nothing compared the two. A static allowlist
// closes that, with no database needed, so it runs in CI.
//
// TO ADD A RELATION HERE: grant comms_writer SELECT on it first (preferably via
// a narrow owner-privileged view, per the pattern in migration 0076), confirm
// with
//   select has_table_privilege('comms_writer','<relation>','SELECT');
// and then add it below with a note on how it is granted.
// ---------------------------------------------------------------------------
const READABLE_BY_COMMS_WRITER = new Set([
  // Granted directly to comms_writer.
  "comms.v_objective_rates",
  "comms.v_objective_attainment",
  "comms.v_email_engagement",
  "comms.objectives",
  "comms.variations",
  // Added by migration 0076 as owner-privileged views, specifically so
  // comms_writer never needs SELECT on the base tables underneath them.
  "comms.v_variant_liveness",
  "comms.v_experiment_status",
  "comms.v_send_pulse",
]);

// Relations comms_writer must NEVER be asked for. Listed so a regression gets a
// pointed failure instead of a puzzling one.
const KNOWN_FORBIDDEN: Record<string, string> = {
  "comms.experiments": "no SELECT for comms_writer — use comms.v_experiment_status or v_variant_liveness (0076)",
  "comms.communications": "no SELECT for comms_writer — use comms.v_send_pulse (0076)",
  "comms.events": "no SELECT for comms_writer — use comms.v_send_pulse (0076)",
  "comms.communication_bodies": "no SELECT for comms_writer, and bodies must not reach this path at all",
  "comms.exposure_units": "no SELECT for comms_writer",
  "comms.recipients": "no SELECT for comms_writer, and it holds PII",
};

/**
 * Relations referenced by a SQL string.
 *
 * Deliberately simple: FROM / JOIN followed by a schema-qualified name. Every
 * query in this repo is schema-qualified, and a bare unqualified table would be
 * a bug in its own right — so anything this misses is already wrong.
 *
 * The lookbehind excludes `IS NOT DISTINCT FROM r.experiment_key`, where the
 * FROM belongs to the operator and what follows is an aliased column, not a
 * relation. Without it this reported `r.experiment_key` as an ungranted table.
 */
function relationsIn(sql: string): string[] {
  const out = new Set<string>();
  for (const m of sql.matchAll(/(?<!\bDISTINCT\s+)\b(?:FROM|JOIN)\s+([a-z_][\w]*\.[a-z_][\w]*)/gi)) {
    out.add(m[1]!.toLowerCase());
  }
  return [...out];
}

describe("every queried relation is readable by comms_writer", () => {
  it("finds the SQL constants it is supposed to be checking", async () => {
    const src = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "metrics-client.ts"), "utf8");
    // A guard on the guard: if the constants get renamed and this test silently
    // starts checking nothing, that is worse than no test at all.
    for (const name of ["const SQL", "ENGAGEMENT_SQL", "PULSE_SQL"]) {
      assert.ok(src.includes(name), `${name} not found — this test is no longer checking what it claims`);
    }
    assert.ok(relationsIn(src).length >= 6, "suspiciously few relations parsed out of metrics-client.ts");
  });

  it("references nothing comms_writer cannot SELECT", async () => {
    const src = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "metrics-client.ts"), "utf8");
    const problems: string[] = [];
    for (const rel of relationsIn(src)) {
      if (READABLE_BY_COMMS_WRITER.has(rel)) continue;
      const why = KNOWN_FORBIDDEN[rel];
      problems.push(why
        ? `${rel} — ${why}`
        : `${rel} — not on the comms_writer allowlist. Grant it, verify with has_table_privilege, then add it.`);
    }
    assert.deepEqual(problems, [], `\nThese would 403 at runtime:\n  ${problems.join("\n  ")}\n`);
  });

  it("parses out exactly the relations the three queries use, and nothing else", async () => {
    const src = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "metrics-client.ts"), "utf8");
    const found = relationsIn(src).sort();
    // Pinned: an over-eager parser reporting column references as tables is how
    // this test first failed, and an under-eager one would pass while checking
    // nothing. Both show up here.
    assert.deepEqual(found, [
      "comms.objectives",
      "comms.v_email_engagement",
      "comms.v_experiment_status",
      "comms.v_objective_attainment",
      "comms.v_objective_rates",
      "comms.v_send_pulse",
      "comms.v_variant_liveness",
    ]);
    // The three queries between them must still reach the rates, the objectives
    // and the liveness views — if any of these vanished, something was rewritten
    // and the allowlist needs re-checking rather than silently passing.
    for (const required of ["comms.v_objective_rates", "comms.objectives", "comms.v_variant_liveness"]) {
      assert.ok(found.includes(required), `expected ${required} to still be queried; found: ${found.join(", ")}`);
    }
  });
});
