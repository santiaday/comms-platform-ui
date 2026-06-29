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
 *   QUERY_ENDPOINT_URL   default = prod /db/agent_platform/sql
 *   COMMS_IDENTITY       default = comms_writer
 *   CONFIDENCE_SAMPLES   default = 50000 (Monte-Carlo draws)
 */
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  fetchObjectiveMetrics, DEFAULT_QUERY_ENDPOINT_URL, IDENTITY, MetricsError,
  type EndpointConfig,
} from "./metrics-client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");
const PORT = Number(process.env["PORT"] ?? "8080");

const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
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
  return {
    bearer,
    endpointUrl: process.env["QUERY_ENDPOINT_URL"] ?? DEFAULT_QUERY_ENDPOINT_URL,
    identity: process.env["COMMS_IDENTITY"] ?? IDENTITY,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === "/api/health") return sendJson(res, 200, { ok: true });

  if (path === "/api/metrics") {
    const cfg = resolveConfig();
    if ("error" in cfg) return sendJson(res, 503, { ok: false, error: cfg.error });
    try {
      const samples = Number(process.env["CONFIDENCE_SAMPLES"] ?? "50000");
      const objectives = await fetchObjectiveMetrics(cfg, { samples });
      return sendJson(res, 200, { ok: true, computed_at: new Date().toISOString(), objectives });
    } catch (err) {
      const msg = err instanceof MetricsError ? err.message : err instanceof Error ? err.message : String(err);
      return sendJson(res, 502, { ok: false, error: msg });
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
  console.log(JSON.stringify({ msg: "comms-platform-ui listening", port: PORT, endpoint: process.env["QUERY_ENDPOINT_URL"] ?? DEFAULT_QUERY_ENDPOINT_URL, configured: !!process.env["COMMS_WRITER_BEARER"] }));
});
