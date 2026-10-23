# @tpirs/worker

Background job runner. It owns the work that must happen outside a request:
delivering receipt SMS, retrying a failed delivery, and sweeping the payment
outbox onto the queue.

## What it runs

- `jobs` (migration `0007_job_queue`) holds every job; the queue is claimed with
  `FOR UPDATE SKIP LOCKED` (ADR 0020).
- The **outbox sweeper** finds pending `sms_log` rows across all tenants - the
  one cross-tenant read in the system, and it returns ids only - and enqueues one
  `sms.deliver` job per message with the message id as its dedupe key.
- The **delivery handler** sends each message through the `SmsProvider` port and
  records the outcome on the outbox row. A failed send throws, so the queue owns
  the retry and its backoff.

The process entry point (`src/index.ts`) starts the worker and shuts it down
cleanly on `SIGINT`/`SIGTERM`. The wiring lives in `src/worker.ts` so it can be
exercised without touching the process lifecycle.

## Configuration

| Variable                | Meaning                                             |
| ----------------------- | --------------------------------------------------- |
| `DATABASE_URL`          | required; the Postgres the queue and outbox live in |
| `OTEL_SERVICE_NAME`     | telemetry service name (default `tpirs-worker`)     |
| `SMS_SWEEP_INTERVAL_MS` | how often the outbox is swept (default `5000`)      |

## Adapters

Only the mock SMS and Postgres job-queue adapters exist today. Real gateway
adapters arrive with their own phases; swapping one is a change in
`createDefaultWorker` and nowhere else.
