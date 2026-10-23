# @tpirs/job-queue-postgres

A `JobQueue` adapter backed by a Postgres `jobs` table (ADR 0020). Background
work that must outlive a request - sending a receipt, retrying a delivery,
sweeping an outbox - is enqueued here and picked up by a worker.

## Why Postgres

Redis is already in the local compose file, but the money path is in Postgres
and the outbox decision (ADR 0016) already keeps intake there. A second system
would add separate durability and observability to reason about for no gain at
state scale. The port keeps Redis possible later; the conformance suite is what
makes that a swap rather than a rewrite.

## How it works

- Jobs live in `jobs` (migration `0007_job_queue`). Workers claim with
  `SELECT ... FOR UPDATE SKIP LOCKED`, so several run at once without a
  distributed lock service and without serialising on each other.
- `enqueue` stores a JSON payload, an optional `dedupeKey`, `runAt`, and
  `maxAttempts`. A dedupe key is unique while the job is live (pending or
  running), so enqueueing a receipt for the same payment twice is a no-op -
  one insert, one SMS.
- A failing handler increments `attempts` and reschedules with exponential
  backoff. A job that exhausts `maxAttempts` becomes `dead`, not deleted, so an
  undeliverable receipt stays visible to operations.
- `tick()` runs one claim-and-execute pass; `start()` runs it in a loop and
  `stop()` ends the loop cleanly.

## Usage

```ts
import { createPostgresJobQueue } from "@tpirs/job-queue-postgres";

const queue = createPostgresJobQueue({ db });
queue.registerHandler("sms.send", async (payload, context) => {
  // deliver, or throw to retry
});
await queue.start();
```

## Tests

The suite is `describe.skip` unless `TEST_DATABASE_URL` is set. Run it for real
with `sh scripts/ci/integration.sh`, or against a local scratch database:

```sh
docker run -d --name tpirs-scratch -e POSTGRES_PASSWORD=scratch \
  -e POSTGRES_USER=scratch -e POSTGRES_DB=tpirs -p 5499:5432 postgres:16-alpine
export TEST_DATABASE_URL="postgres://scratch:scratch@localhost:5499/tpirs"
pnpm --filter @tpirs/job-queue-postgres test
```
