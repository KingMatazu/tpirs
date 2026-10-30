# Runbook: alerts

Every rule in `infra/alerts/tpirs.rules.yml` has a section here with what it
means and the first three things to check. A rule without a first action is
noise (ADR 0044, D53).

**Delivery is not wired yet.** Until a deploy target points Alertmanager (or
another receiver) at these rules, they evaluate and nothing notifies. The daily
check is the reconciliation screen plus `GET /metrics` on the API; that gap is
stated in the Phase 10 delivery notes rather than hidden.

Metric names and labels are the contract in
[`infra/alerts/metric-contract.json`](../../infra/alerts/metric-contract.json); a
test fails when a rule drifts from what the code emits.

## High error rate

`sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 1%` for 5 minutes.

1. `GET /v1/health` and `/v1/ready` — is the process healthy and is the database
   reachable?
2. The API log for `requestId`s in the 5xx burst: the error envelope carries one,
   and the log line carries the same id.
3. Recent deploys: a schema change that did not run, or a dependency that is
   unreachable (object storage, provider API).

Escalate to the incident commander if it lasts past 15 minutes or touches
`/webhooks/*` (money intake).

## Verify latency

p95 for `GET /v1/verify/:token` above the 150 ms budget, or any route above 1 s,
for 10 minutes.

1. Database: slow queries, connection saturation, a missing index after a data
   import.
2. Host: CPU, memory, disk — the load harness's saturation point moves with the
   machine (see `docs/performance-budgets.md`).
3. Volume: a traffic spike from officers at shift change is expected; a spike
   with normal traffic is not.

## Webhook rejected

Any `webhook_events_total{outcome="rejected"}` in 10 minutes: a signature or an
endpoint token did not verify.

1. Did the provider rotate its secret, or did we? Check the endpoint token in the
   tenant config against the provider dashboard.
2. Is it one provider or all? One provider is a misconfiguration; all of them is
   a deployment that lost its secrets.
3. Replays of an old payload also land here — check whether the reference is one
   that already exists.

Never "fix" this by disabling signature verification. Payments that cannot be
verified go to suspense, not to a wallet.

## Webhook suspense

Payments are landing in suspense (`suspense` / `deposit_suspense`) — money
arrived that could not be attributed.

1. Open the suspense queue in the dashboard: amount, provider reference, and
   whether the reference looks like an asset id, a short code or a phone number.
2. Is the amount wrong (underpayment) or the reference unknown (a payer typed a
   stale code)?
3. Resolve with a note naming the amount and the reference; the resolution is
   audited and idempotent.

## Outbox backlog

A driver-facing message has been pending for over five minutes.

1. Is the worker running? Check the heartbeat alert next.
2. Is the provider accepting sends? Look at `sms_log.last_error` for the oldest
   pending row.
3. Is the cost guard or a rate limit suppressing sends? That is a configuration
   decision, not a fault.

## Worker down

No heartbeat for ten minutes. The worker drains SMS/channel outboxes, schedules
reconciliation and sweeps cash deadlines.

1. Process: is the worker running at all? Restart it; the queue is durable, so a
   restart loses nothing.
2. Database: the worker cannot start without it; check `/v1/ready` on the API.
3. Deploy: a restart during a deploy is expected — check the deploy window before
   paging anyone.

## Reconciliation overdue

A tenant has not completed a reconciliation run in over 26 hours.

1. Worker alive? The scheduler lives there.
2. Tenant config: `reconciliation.enabled` and the cron expression; an invalid
   expression fails at config load, not at 02:00.
3. The run row for yesterday: a failed attempt records why, and the scheduler
   retries on its next tick.

## Rate limit spike

Sustained rejections for one scope.

1. Which scope? `verify` suggests scanning abuse or a misconfigured field app;
   `login` suggests credential stuffing or a stuck client retrying.
2. Source addresses in the log: one address is a client, many is an attack.
3. Never raise a limit during an attack; raise it only after confirming a
   legitimate client (for example a state office behind one NAT).

## Verify traffic missing

No verification lookups at all for 30 minutes, while earlier lookups exist.

1. Are officers actually scanning? A quiet period is normal at night.
2. The field app: is it reaching the API, or is it serving from its offline
   cache?
3. The endpoint: a 5xx burst on verify would show in the error-rate alert too.

## Adding an alert

1. Add the rule to `infra/alerts/tpirs.rules.yml` with a `severity` and a
   `runbook:` link.
2. Add a section here with the first three checks.
3. If it needs a metric that does not exist, add it to the contract and emit it
   from the component that owns the value — a rule on a metric nobody emits is a
   promise the system does not keep.
4. Run `pnpm --filter @tpirs/api test -- src/metrics-contract.test.ts`.
