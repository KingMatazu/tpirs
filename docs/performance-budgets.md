# Performance budgets

Budgets are thresholds, not aspirations: the load harness
(`scripts/load/`) reads this table as code and exits non-zero when a run
breaches one, and the alert rules in `infra/alerts/` use the same numbers. A
budget change is a diff in three places at once — this file, the harness
constants and the rule file — which is deliberate.

Recorded for D50/D51 (`docs/decisions-needed.md`, ADRs 0041/0042).

## The budgets

Measured on the API process, single replica, with the worker running alongside
(the pilot topology). Latencies are server-side, per request, at the stated
offered load.

| Path                                | Load                               | p95    | p99    | Error budget                      |
| ----------------------------------- | ---------------------------------- | ------ | ------ | --------------------------------- |
| `POST /webhooks/{provider}`         | 50 rps sustained, 200 rps for 60 s | 300 ms | 800 ms | 5xx < 0.1 %                       |
| `GET /v1/verify/:token`             | 200 rps, warm cache                | 150 ms | 400 ms | 5xx < 0.1 %                       |
| `GET /v1/sync/paid?since=`          | 10 rps, 50 000 paid rows           | 800 ms | 2 s    | 5xx < 0.1 %                       |
| `GET /v1/payments`                  | 20 rps, 100 000 payments           | 400 ms | 1 s    | 5xx < 0.1 %                       |
| `GET /v1/verify/:token` (USSD path) | 30 rps                             | 250 ms | 600 ms | 5xx < 0.1 %                       |
| `POST /v1/auth/login`               | 5 rps, valid and invalid mix       | 400 ms | 1 s    | 5xx < 0.1 %                       |
| Webhook accepted → ledger posted    | steady 50 rps                      | 5 s    | 15 s   | lag only                          |
| Nightly reconciliation, 100k assets | one run                            | 10 min | —      | finishes before the next schedule |

Why these numbers:

- **Webhooks** are the peak-hour path: a state's drivers pay in bursts before a
  shift. The route must answer fast because the provider retries on timeout, and
  the ledger work happens on the queue — hence the separate end-to-end lag budget.
- **Verify** is the officer path on a phone in the street. 150 ms at p95 is what
  makes a scan feel instant; the USSD variant is looser because the provider adds
  its own latency.
- **Sync** is bounded by payload size, not by compute: 50 000 paid rows is a
  deliberately large offline set.
- **Login** is not a hot path, but a throttled or slow login during a morning
  rush is what an operator notices first.

## Metric mapping

Each budget is measured from a metric in the Phase 10 contract, so the same
number is available in production:

| Budget                    | Metric                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| Request latency and error | `http_request_duration_seconds{route,method}`, `http_requests_total{route,method,status}` |
| Verify-specific latency   | `verify_lookup_duration_seconds`, `verify_lookups_total{result}`                          |
| Webhook end-to-end lag    | `webhook_events_total{provider,outcome}` and the outbox age                               |
| Reconciliation duration   | `reconciliation_last_run_age_seconds{tenant}`                                             |

## Machine profile

Every recorded run names the machine it ran on, because a shared CI runner and a
pilot server are not comparable:

| Run date   | Machine   | Notes                                  |
| ---------- | --------- | -------------------------------------- |
| _none yet_ | _pending_ | filled by the first full run in Step 3 |

### Baseline from the first run (2026-10-30)

Measured with `scripts/load/run.sh` on the machine profile above, with the abuse
limiter disabled for the run (the budgets measure the route, not the throttle):

| Scenario                | Offered | Achieved | p50    | p95    | p99    | Verdict                 |
| ----------------------- | ------- | -------- | ------ | ------ | ------ | ----------------------- |
| `GET /v1/verify/:token` | 20 rps  | 20 rps   | 20 ms  | 33 ms  | 142 ms | within budget           |
| `GET /v1/verify/:token` | 200 rps | ~124 rps | 387 ms | 554 ms | 623 ms | **saturated** — not met |
| `GET /v1/payments`      | 20 rps  | 20 rps   | 25 ms  | 42 ms  | 61 ms  | within budget           |
| `GET /v1/sync/paid`     | 10 rps  | 10 rps   | 30 ms  | 47 ms  | 57 ms  | within budget           |

Reading of the saturated row: at 20 rps a verify costs ~20 ms, so the route is
not slow — the host cannot hold 200 rps of it (single API process, Postgres in a
container on the same CPU, no connection-pool tuning). The 150 ms p95 target is
therefore a **pilot-hardware** target, not something this laptop can certify.
Step 13 re-runs the full-rate scenario on the target and either confirms the
budget or records a re-baseline with its machine profile.

## Re-baselining

1. Run the full-rate scenario from `scripts/load/run.sh` on the target hardware.
2. If a budget is breached and the cause is hardware rather than code, record the
   new number here with the date and the machine, and update the harness
   constants and the alert rule in the same commit.
3. If the cause is code, fix the code — do not move the budget to match the
   regression. The only exception is a deliberate product decision, recorded as
   an ADR.
4. Percentiles from a developer laptop are indicative only; they never replace a
   CI or pilot measurement.

## Known limits of these numbers

- **One replica.** `Cache` and `LockService` are mock adapters, so rate limiting
  and USSD locks are per process. Two replicas would change both the limits and
  the load distribution, and the budgets would need re-measuring.
- **Warm cache.** The verify budget assumes the rate limiter's cache is warm; a
  cold process pays a few extra milliseconds per lookup.
- **No network shaping.** The harness talks to `localhost`; a real deployment
  adds TLS termination and the provider's own latency to the webhook path.
