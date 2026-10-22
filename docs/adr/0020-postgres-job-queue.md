# 0020: A Postgres-backed job queue for background work

## Context

Phase 4 introduces the first work that must happen outside a request: sending
receipts, retrying failed deliveries, and sweeping the payment outbox. The
`JobQueue` port exists and has only a mock adapter, which is in-memory and loses
everything on restart. A real adapter is required before receipts can be promised
to a driver.

Redis is already in the local compose file, so a Redis queue would be a small
addition. It would also add a second system whose failure and durability
semantics have to be reasoned about next to the database that holds the money,
and it would be inconsistent with the outbox decision (ADR 0016), where payment
intake deliberately stays in Postgres.

## Decision

- Implement `@tpirs/job-queue-postgres` against the existing `JobQueue` port:
  `enqueue`, `registerHandler`, `start`, `stop`, with `dedupeKey`, `runAt`, and
  `maxAttempts` honoured.
- Jobs live in a `jobs` table. Workers claim with
  `SELECT ... FOR UPDATE SKIP LOCKED`, so several workers can run concurrently
  without a distributed lock service.
- Failures increment `attempts` and set `run_at` with exponential backoff. A job
  that exhausts `maxAttempts` is marked dead rather than deleted, so a receipt
  that could not be delivered remains visible to operations.
- `dedupeKey` is a unique index while the job is live, so re-enqueueing a receipt
  for the same payment is a no-op rather than a second SMS.
- The adapter runs the shared `JobQueue` conformance suite from `@tpirs/contracts`
  like every other adapter.
- Payment intake does not use this queue. `webhook_events` remains the intake
  outbox (ADR 0016); the queue carries follow-on work only.
- A Redis adapter can be added behind the same port later without changing
  callers; the conformance suite is what makes that a swap rather than a rewrite.

## Consequences

- One fewer critical dependency to run, back up, and monitor for the first
  deployment.
- Job state is queryable with SQL and can be joined to `sms_log` and `payments`
  when investigating a driver complaint.
- Throughput is bounded by Postgres rather than by an in-memory queue. At state
  scale (thousands of receipts per day, not per second) this is far above what is
  needed, and `SKIP LOCKED` keeps workers from serialising on each other.
- `FOR UPDATE SKIP LOCKED` requires Postgres 9.5+, which every supported version
  already exceeds.

## Alternatives considered

- **Redis queue now.** Rejected for Phase 4: it adds a system with separate
  durability and observability while the volumes are small and the money path is
  still being built. The port keeps the option open.
- **`pg-boss` or another queue library.** Rejected: it would own the schema and
  the retry semantics of a table we want to read directly during reconciliation,
  and the port is small enough that an adapter is less coupling than a framework.
- **No queue, synchronous sends.** Rejected: a slow SMS gateway would hold the
  payment transaction or the webhook response, which ADR 0016 exists to prevent.
- **A cron job with a `sent_at IS NULL` scan.** Rejected: it cannot express
  per-job retry, backoff, or dead-lettering, all of which receipts need.
