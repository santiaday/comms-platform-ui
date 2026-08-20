/* ============================================================================
   Communications Hub — single-page app.

   Written for one reader: the person who opens this every morning and needs to
   know, in seconds, whether anything requires action. Every decision below
   serves that.

   * Real routes. Hash routing gives every view a shareable URL and a history
     entry, so the browser Back button steps back instead of closing the window.
   * Uncertainty is drawn, not described. "27.6% vs 25.0%" reads as a real gap
     in a table; drawing both Wilson intervals on one scale shows they overlap
     almost entirely, which is why nearly every experiment here is honestly
     "not conclusive".
   * Dormant arms and experiments are demoted, never interleaved. A retired arm
     sitting beside a running one, styled identically, is how you end up reading
     SMS variant B as if it still mattered.
   * Opening a message opens the conversation. A lone message with no thread
     around it was the ledger's central failure.

   No dependencies, no build step, no external requests — one HTML, one CSS, one
   JS, which is also what keeps it working behind a strict CSP.
   ========================================================================= */

import { $, icon, esc, timeAgo } from "./fmt.js";
import { state } from "./data.js";
import { TITLES, parseHash, go } from "./router.js";
import { viewOverview } from "./view-overview.js";
import { viewExperiments } from "./view-experiments.js";
import { viewMessages, viewThread } from "./view-messages.js";
import { viewCoverage } from "./view-coverage.js";

async function render() {
  const route = parseHash();
  document.title = `${TITLES[route.name]} · Comms Hub`;
  $("#page-title").textContent = TITLES[route.name];
  for (const b of document.querySelectorAll(".navitem[data-route]")) {
    b.toggleAttribute("aria-current", b.dataset.route === route.name);
    if (b.dataset.route === route.name) b.setAttribute("aria-current", "page");
  }
  const view = $("#view");
  view.setAttribute("aria-busy", "true");
  try {
    if (route.name === "experiments")   await viewExperiments(view);
    else if (route.name === "messages") await viewMessages(view, route);
    else if (route.name === "coverage") await viewCoverage(view);
    else if (route.name === "thread")   await viewThread(view, route);
    else                                await viewOverview(view);
  } catch (err) {
    view.innerHTML = `<div class="banner">${icon("alert")} Could not render this view: ${esc(err?.message ?? err)}</div>`;
  }
  view.setAttribute("aria-busy", "false");
  stampFreshness();
  if (route.name !== "thread") window.scrollTo({ top: 0 });
}

// One delegated listener for every navigation, so freshly rendered HTML never
// needs re-wiring. data-href navigates (pushing history, so Back steps back).
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-back]")) { e.preventDefault(); history.back(); return; }

  const nav = e.target.closest("[data-href]");
  if (nav) { e.preventDefault(); go(nav.dataset.href); return; }

  const routeBtn = e.target.closest(".navitem[data-route]");
  if (routeBtn) { e.preventDefault(); go(`#/${routeBtn.dataset.route}`); return; }

  const arch = e.target.closest("[data-archive]");
  if (arch) {
    const k = arch.dataset.archive;
    if (state.archiveOpen.has(k)) state.archiveOpen.delete(k); else state.archiveOpen.add(k);
    render();
    return;
  }

  const toggle = e.target.closest('[data-toggle="exp"]');
  if (toggle) {
    const body = toggle.parentElement?.querySelector(".exp-body");
    if (body) { body.hidden = !body.hidden; toggle.setAttribute("aria-expanded", String(!body.hidden)); }
  }
});

// Rows and card headers are focusable, so Enter and Space must do what a click does.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const t = e.target.closest("[data-href],[data-toggle],[data-archive],[data-back]");
  if (!t || t.tagName === "SELECT" || t.tagName === "INPUT") return;
  e.preventDefault();
  t.click();
});

$("#refresh").onclick = async () => {
  const btn = $("#refresh");
  btn.disabled = true;
  state.metrics = null; state.coverage = null;
  await render();
  btn.disabled = false;
};

// Theme: an explicit choice persists and wins in both directions; with no
// choice stored the page follows the OS.
const THEME_KEY = "comms-hub-theme";
const saved = localStorage.getItem(THEME_KEY);
if (saved === "dark" || saved === "light") document.documentElement.dataset.theme = saved;
$("#theme").onclick = () => {
  const cur = document.documentElement.dataset.theme
    ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
};

function stampFreshness() {
  const at = state.metrics?.computed_at;
  $("#updated").textContent = at ? `updated ${timeAgo(at)}` : "";
}

window.addEventListener("hashchange", render);

(function boot() {
  if (!location.hash) history.replaceState(null, "", "#/overview");
  render();
  setInterval(stampFreshness, 15000);
})();

