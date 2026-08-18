# comms-platform-ui

Read-only dashboard for the **Communications Outcomes** platform — show-rate and
A/B confidence per objective × variant, updated hourly from Salesforce by the
harvester in `revops-agents`.

Zero-framework, zero-runtime-dependency Node + TypeScript server (run via `tsx`),
containerized for **DeployBay** — same shape as `demo-risk-ui`. The browser never
sees a bearer and never sends SQL: `GET /api/metrics` is proxied server-side to
the platform SQL endpoint, and Bayesian confidence is computed in the server.

## What it shows

Per objective (e.g. `demo_driver_morning_sms`) and component (primary/secondary):
- variant **rate** = `Show / (Show + No-Show + Canceled + Rescheduled)` (disposition mode),
- **hit / miss / pending** counts,
- **P(best)** — Bayesian probability each variant has the highest true rate,
- a **winner verdict** when the leader's P(best) ≥ the objective's confidence threshold.

## Run locally

```sh
npm install
# Both are required — there is no baked-in endpoint URL (see Security).
QUERY_ENDPOINT_URL='<platform SQL endpoint>' \
COMMS_WRITER_BEARER='<comms_writer bearer>' \
LEDGER_API_URL='<webhooks API base URL>' \
LEDGER_BEARER='<comms-ledger bearer>' \
  npm start
# open http://localhost:8080
```

Uses the one `comms_writer` identity/bearer — the UI reads today and will write
back later, so there's deliberately **no separate read-only bearer**.

## Ledger tab

A second, source-agnostic mode: **every** tracked communication, its engagement,
and its outcome — not only the ones enrolled in an experiment.

It opens on a **coverage grid** (source × channel) showing volume, freshness,
what share is engaged, what share can be joined to an outcome, and what share
carries an objective. Click a row for its messages, a message for its detail,
and any message for that person's full cross-channel timeline. There's also a
person search by email / `sf_lead` / `hubspot_contact` / etc.

Two rules it follows:

- **Null is never rendered as zero.** "not measured" means no engagement source
  is wired up for that channel — not that engagement was 0%. Conflating those is
  how an eight-day HubSpot logging outage went unnoticed in August 2026.
- **Gaps are explained, not hidden.** A communication with no attainment shows
  *why* ("no objective binding", "no sf_lead ref") instead of an empty cell.

Data comes from the private `/comms-ledger/*` API in `revops-agents`, which
reads the `comms.v_ledger_*` views. **No SQL or schema lives in this repo** —
see Security below.

## Environment

| var | default | purpose |
|---|---|---|
| `PORT` | `8080` | listen port (DeployBay injects) |
| `COMMS_WRITER_BEARER` | — (required) | `X-Internal-Secret` for the SQL endpoint (the existing `comms_writer` bearer) |
| `COMMS_IDENTITY` | `comms_writer` | `X-Identity` sent to the endpoint |
| `QUERY_ENDPOINT_URL` | — (**required**) | the platform SQL endpoint. No default is baked in — see Security. |
| `CONFIDENCE_SAMPLES` | `50000` | Monte-Carlo draws for P(best) |
| `LEDGER_API_URL` | — (required for the Ledger tab) | base URL of the private comms-ledger API |
| `LEDGER_BEARER` | — (required for the Ledger tab) | `X-Internal-Secret` for that API |

## Security — this repo is public

Nothing sensitive may land here. Concretely:

- **No infrastructure addresses.** `QUERY_ENDPOINT_URL` and `LEDGER_API_URL` are
  required env vars with **no defaults**; the server fails loudly when unset.
  (Until 2026-08-17 this repo committed the production API Gateway URL as a
  default. It was not a credential, but it published the address of the internal
  SQL endpoint, the database name, and the identity name.)
- **No SQL, no schema.** Every query lives in `revops-agents`. This repo forwards
  allowlisted parameters and renders the response.
- **`/api/health` reports booleans only** — never the endpoint it talks to.
- **Bearers stay server-side.** The browser calls same-origin `/api/*`; the
  server attaches credentials. The browser never holds one.
- **No production data in fixtures.** Tests use `@example.com` / `.invalid`.

`npm run scan` enforces all of this in CI, scanning every tracked file as raw
bytes. It does not shell out to `grep`: `file(1)` misreports UTF-8 sources
containing em-dashes as binary, and some `grep` wrappers silently skip them —
which is nearly how the committed URL above escaped a manual audit.

## Deploy (DeployBay)

The `Dockerfile` is the deploy unit. DeployBay builds the image and injects
`PORT`, `COMMS_WRITER_BEARER` and `QUERY_ENDPOINT_URL` (plus `LEDGER_API_URL` +
`LEDGER_BEARER` for the Ledger tab) as runtime env. No build step — the server
runs TypeScript directly via `tsx`.

## Where to set the goal/outcome & confidence threshold

Today these live in the `revops-agents` data layer:
- **goal/outcome** → `comms.objectives` + `comms.objective_components`
  (`outcome_type`, `target_window`, `window_from`, `eval_mode`, `fail_if_outcomes`).
- **confidence threshold** → `comms.objectives.confidence_threshold`.

In-dashboard editing of these is the next milestone (a small authenticated write
path); the dashboard already surfaces the current values.

## Scope

UI only. All data/outcome logic lives in `revops-agents` (`services/runtime`,
`comms` schema). This repo just renders what the platform exposes.
