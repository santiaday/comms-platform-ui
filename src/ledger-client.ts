// Ledger mode — server-side proxy to the comms-ledger read API.
//
// THIS REPO IS PUBLIC. It deliberately contains no SQL, no schema knowledge,
// and no endpoint defaults. Every query lives behind the private API in
// revops-agents (services/webhooks/src/handlers/comms-ledger.ts); this module
// only forwards allowlisted parameters and passes the response through.
//
// The bearer is injected from the environment server-side and never reaches
// the browser — the same property the metrics path already has.

/** Query params we are willing to forward, per route. Anything else is dropped. */
const FORWARDABLE: Readonly<Record<string, readonly string[]>> = {
  coverage: [],
  messages: [
    "source_key",
    "channel",
    "direction",
    "experiment_key",
    "recipient_id",
    "from",
    "to",
    "limit",
    "cursor_sent_at",
    "cursor_id",
  ],
  person: ["recipient_id", "id_type", "id_value"],
};

export interface LedgerConfig {
  readonly baseUrl: string;
  readonly bearer: string;
}

export class LedgerError extends Error {}

/**
 * Resolve the ledger API config from the environment. Both values are
 * required: there is deliberately no baked-in URL, so a misconfigured deploy
 * fails loudly instead of silently pointing at something.
 */
export function resolveLedgerConfig(
  env: NodeJS.ProcessEnv = process.env,
): LedgerConfig | { error: string } {
  const baseUrl = env["LEDGER_API_URL"];
  if (!baseUrl) {
    return { error: "LEDGER_API_URL is not set — see README (no default is baked in)." };
  }
  const bearer = env["LEDGER_BEARER"];
  if (!bearer) {
    return { error: "LEDGER_BEARER is not set — see README." };
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), bearer };
}

/**
 * Build the upstream URL for a ledger route.
 *
 * `route` is one of the known keys (or `message/<uuid>`); params are filtered
 * against the per-route allowlist so a crafted browser query cannot smuggle
 * extra fields upstream. Returns the URL as a string.
 */
export function buildLedgerUrl(
  baseUrl: string,
  route: string,
  params: URLSearchParams,
): string {
  const allow = FORWARDABLE[route.split("/")[0] ?? ""] ?? [];
  const out = new URLSearchParams();
  for (const key of allow) {
    const v = params.get(key);
    if (v != null && v !== "") out.append(key, v);
  }
  const qs = out.toString();
  return `${baseUrl}/comms-ledger/${route}${qs ? `?${qs}` : ""}`;
}

/** True for the routes this proxy is willing to serve. */
export function isKnownRoute(route: string): boolean {
  if (route === "coverage" || route === "messages" || route === "person") return true;
  return /^message\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(route);
}

/**
 * Call the ledger API and return its parsed JSON body plus the upstream
 * status. Transport and parse failures raise LedgerError; upstream 4xx/5xx
 * bodies are returned as-is so the SPA can show the real reason.
 */
export async function fetchLedger(
  cfg: LedgerConfig,
  route: string,
  params: URLSearchParams,
): Promise<{ status: number; body: unknown }> {
  const url = buildLedgerUrl(cfg.baseUrl, route, params);
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { accept: "application/json", "X-Internal-Secret": cfg.bearer },
    });
  } catch (e) {
    throw new LedgerError(`ledger request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await resp.text();
  try {
    return { status: resp.status, body: JSON.parse(text) };
  } catch {
    throw new LedgerError(`bad ledger JSON (status ${resp.status}): ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Presentation helpers — pure, unit-tested, no I/O.
// ---------------------------------------------------------------------------

export interface CoverageFlag {
  readonly key: string;
  readonly label: string;
  readonly tone: "bad" | "warn" | "info";
  readonly hint: string;
}

/**
 * Turn a coverage row's boolean flags into ordered badges.
 *
 * Deliberately explicit about *why* each flag matters: a source with sends and
 * no events is not "0% engagement", it is unmeasured — the distinction that
 * let an eight-day HubSpot outage go unnoticed in August 2026.
 */
export function coverageFlags(row: Record<string, unknown>): CoverageFlag[] {
  const flags: CoverageFlag[] = [];
  if (row["declared_silent"]) {
    flags.push({
      key: "declared_silent",
      label: "silent",
      tone: "warn",
      hint: "Registered as a comms source but has never produced a communication.",
    });
  }
  if (row["observed_undeclared"]) {
    flags.push({
      key: "observed_undeclared",
      label: "unregistered",
      tone: "warn",
      hint: "Producing communications but missing from core.sources.",
    });
  }
  if (row["no_engagement"]) {
    flags.push({
      key: "no_engagement",
      label: "no engagement",
      tone: "bad",
      hint: "Has sends but zero engagement events ever — unmeasured, not 0%.",
    });
  }
  if (row["unattributable"]) {
    flags.push({
      key: "unattributable",
      label: "unattributable",
      tone: "bad",
      hint: "Under 5% of sends can be joined to any outcome, so nothing here can be credited.",
    });
  }
  if (row["unbound"]) {
    flags.push({
      key: "unbound",
      label: "no objective",
      tone: "warn",
      hint: "Under 5% carry an objective, so these sends are absent from the experiment readout.",
    });
  }
  if (row["stale"]) {
    flags.push({
      key: "stale",
      label: "stale",
      tone: "bad",
      hint: "No activity within this source's freshness window.",
    });
  }
  return flags;
}

/**
 * Health verdict for a coverage row. `unknown` (not `ok`) when a source has
 * produced nothing — absence of data is not evidence of health.
 */
export function coverageHealth(row: Record<string, unknown>): "ok" | "degraded" | "broken" | "unknown" {
  const flags = coverageFlags(row);
  if (flags.length === 0) {
    return Number(row["n_communications"] ?? 0) > 0 ? "ok" : "unknown";
  }
  return flags.some((f) => f.tone === "bad") ? "broken" : "degraded";
}
