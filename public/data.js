// The data layer: one place that knows what has been fetched, what failed, and
// what the UI is holding open. Views read it; nothing else writes it.

import { esc, icon } from "./fmt.js";

const state = {
  metrics: null,          // { programs: ProgramGroup[], pulse: PulseDay[], ... }
  metricsError: null,
  coverage: null,
  archiveOpen: new Set(), // program keys whose retired experiments are expanded
  loading: false,
};

async function getJson(url) {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    return await r.json();
  } catch (e) {
    return { ok: false, error: `request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function loadMetrics(force = false) {
  if (state.metrics && !force) return state.metrics;
  const body = await getJson("/api/metrics");
  if (body?.ok === true) { state.metrics = body; state.metricsError = null; }
  else { state.metrics = null; state.metricsError = body?.error ?? "metrics unavailable"; }
  return state.metrics;
}
async function loadCoverage(force = false) {
  if (state.coverage && !force) return state.coverage;
  state.coverage = await getJson("/api/ledger/coverage");
  return state.coverage;
}

/** The two scaffolding pieces every view needs for the states before data. */
const errorBanner = () => state.metricsError
  ? `<div class="banner">${icon("alert")} ${esc(state.metricsError)}</div>` : "";
const skeleton = (h) => `<div class="skeleton" style="height:${h}px"></div>`;

export { state, getJson, loadMetrics, loadCoverage, errorBanner, skeleton };
