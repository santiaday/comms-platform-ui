/**
 * Comms Platform UI — HTTP server (read-only).
 *
 * Raw node:http, zero framework, zero runtime deps (mirrors demo-risk-ui).
 * Serves the static dashboard and a single same-origin JSON API
 * (`GET /api/metrics`) that reads the comms data layer via the platform SQL
 * endpoint with the reader bearer injected from the environment. The browser
 * never sees the bearer and never sends SQL.
 *
 * Env (DeployBay injects at runtime):
 *   PORT                 default 8080
 *   COMMS_WRITER_BEARER  X-Internal-Secret for the SQL endpoint (comms_writer identity)
 *   QUERY_ENDPOINT_URL   REQUIRED — the platform SQL endpoint. No default: this
 *                        repo is public and must not carry infrastructure URLs.
 *   COMMS_IDENTITY       default = comms_writer
 *   CONFIDENCE_SAMPLES   default = 50000 (Monte-Carlo draws)
 *   LEDGER_API_URL       REQUIRED for the ledger tab — base URL of the private
 *                        comms-ledger API. No default, same reason.
 *   LEDGER_BEARER        X-Internal-Secret for that API. Server-side only.
 */
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  fetchObjectiveMetrics, fetchEmailEngagement, assembleExperiments, IDENTITY, MetricsError,
  type EndpointConfig,
} from "./metrics-client.js";
import {
  resolveLedgerConfig, fetchLedger, isKnownRoute, LedgerError,
} from "./ledger-client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");
const PORT = Number(process.env["PORT"] ?? "8080");

const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/ledger.js": { file: "ledger.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/doorloop-logo.svg": { file: "doorloop-logo.svg", type: "image/svg+xml" },
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const p = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" });
  res.end(p);
}

function resolveConfig(): EndpointConfig | { error: string } {
  // One identity for the platform: comms_writer (reads now, writes back later).
  // We deliberately do NOT mint a separate read-only bearer.
  const bearer = process.env["COMMS_WRITER_BEARER"];
  if (!bearer) return { error: "COMMS_WRITER_BEARER is not set — provide the comms_writer SQL-endpoint bearer (see README)." };
  // No baked-in default: this repo is public, so the endpoint address is
  // configuration, not source. A missing value must fail loudly.
  const endpointUrl = process.env["QUERY_ENDPOINT_URL"];
  if (!endpointUrl) return { error: "QUERY_ENDPOINT_URL is not set — see README." };
  return {
    bearer,
    endpointUrl,
    identity: process.env["COMMS_IDENTITY"] ?? IDENTITY,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === "/api/health") {
    // Report only whether config is present — never the endpoint address.
    // /api/health is unauthenticated, and echoing infrastructure URLs to
    // anonymous callers is free reconnaissance.
    return sendJson(res, 200, {
      ok: true,
      configured: !!process.env["COMMS_WRITER_BEARER"] && !!process.env["QUERY_ENDPOINT_URL"],
      ledger_configured:
        !!process.env["LEDGER_API_URL"] && !!process.env["LEDGER_BEARER"],
    });
  }

  // Ledger proxy: /api/ledger/<route>. The browser calls same-origin; the
  // bearer is added here and never leaves the server. Upstream owns all SQL.
  if (path.startsWith("/api/ledger/")) {
    const route = path.slice("/api/ledger/".length);
    if (!isKnownRoute(route)) {
      return sendJson(res, 404, { ok: false, error: "unknown ledger route" });
    }
    const cfg = resolveLedgerConfig();
    if ("error" in cfg) return sendJson(res, 200, { ok: false, error: cfg.error });
    try {
      const upstream = await fetchLedger(cfg, route, url.searchParams);
      // Pass the upstream status through, except 5xx: the DeployBay gateway
      // rewrites those into an opaque HTML page, hiding the real reason.
      const status = upstream.status >= 500 ? 200 : upstream.status;
      return sendJson(res, status, upstream.body);
    } catch (err) {
      const msg = err instanceof LedgerError ? err.message : err instanceof Error ? err.message : String(err);
      return sendJson(res, 200, { ok: false, error: `ledger query failed: ${msg}` });
    }
  }

  if (path === "/api/metrics") {
    // Operational failures (missing bearer, upstream error) return 200 + {ok:false,error}
    // so the SPA can render a clear banner. A 5xx here gets swallowed by the
    // DeployBay gateway into an opaque HTML page, hiding the real reason.
    const cfg = resolveConfig();
    if ("error" in cfg) return sendJson(res, 200, { ok: false, error: cfg.error });
    try {
      const samples = Number(process.env["CONFIDENCE_SAMPLES"] ?? "50000");
      const objectives = await fetchObjectiveMetrics(cfg, { samples });
      // Engagement is best-effort: a missing view (pre-0048) or empty result
      // must not blank the objective metrics. Degrade to [] with a note.
      let engagement: unknown[] = [];
      let engagement_error: string | undefined;
      try {
        engagement = await fetchEmailEngagement(cfg);
      } catch (e) {
        engagement_error = e instanceof Error ? e.message : String(e);
      }
      // Experiment-shaped grouping is what the UI renders; the flat arrays stay
      // in the payload so nothing that consumed them breaks.
      const programs = assembleExperiments(objectives, engagement as never[]);
      return sendJson(res, 200, {
        ok: true, computed_at: new Date().toISOString(),
        programs, objectives, engagement, engagement_error,
      });
    } catch (err) {
      const msg = err instanceof MetricsError ? err.message : err instanceof Error ? err.message : String(err);
      return sendJson(res, 200, { ok: false, error: `metrics query failed: ${msg}` });
    }
  }

  const file = STATIC[path];
  if (file) {
    try {
      const buf = await readFile(join(PUBLIC_DIR, file.file));
      res.writeHead(200, { "content-type": file.type, "cache-control": "no-cache" });
      return res.end(buf);
    } catch {
      res.writeHead(404); return res.end("not found");
    }
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  // Log presence, not addresses — container logs get shipped around.
  console.log(JSON.stringify({
    msg: "comms-platform-ui listening",
    port: PORT,
    configured: !!process.env["COMMS_WRITER_BEARER"] && !!process.env["QUERY_ENDPOINT_URL"],
    ledger_configured: !!process.env["LEDGER_API_URL"] && !!process.env["LEDGER_BEARER"],
  }));
});
