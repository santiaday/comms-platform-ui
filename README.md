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
# the existing comms_writer SQL-endpoint bearer (reads now via SELECT, writes back later)
COMMS_WRITER_BEARER='<comms_writer bearer>' npm start
# open http://localhost:8080
```

Uses the one `comms_writer` identity/bearer — the UI reads today and will write
back later, so there's deliberately **no separate read-only bearer**.

## Environment

| var | default | purpose |
|---|---|---|
| `PORT` | `8080` | listen port (DeployBay injects) |
| `COMMS_WRITER_BEARER` | — (required) | `X-Internal-Secret` for the SQL endpoint (the existing `comms_writer` bearer) |
| `COMMS_IDENTITY` | `comms_writer` | `X-Identity` sent to the endpoint |
| `QUERY_ENDPOINT_URL` | prod `/db/agent_platform/sql` | the platform SQL endpoint |
| `CONFIDENCE_SAMPLES` | `50000` | Monte-Carlo draws for P(best) |

## Deploy (DeployBay)

The `Dockerfile` is the deploy unit. DeployBay builds the image and injects
`PORT` + `COMMS_WRITER_BEARER` (+ optional `QUERY_ENDPOINT_URL`) as runtime env.
No build step — the server runs TypeScript directly via `tsx`.

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
