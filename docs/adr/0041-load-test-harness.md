# ADR 0041: Load generation with Node and `undici`

## Status

Accepted

## Context

Phase 10 needs load tests for the peak-hour paths: webhook intake, public verify
lookups, paid-set sync downloads, and the finance list. The load has to be
repeatable on a CI runner and on a Windows laptop, and it has to do more than
report latency — the interesting properties of this system are invariants that
only a realistic mix can break:

- a replayed webhook must not create a second payment or a second ledger posting;
- an unmatched amount must land in suspense, not in an asset wallet;
- total debits must equal total credits after a burst;
- the outbox must drain, and receipts must not be duplicated;
- `pay_per_use` verification must never answer from a cache miss as "unpaid".

That means the harness must sign provider payloads with the tenant's endpoint
secret, provision assets and paid-set rows through the repositories, and query
the database after the run. Options considered:

1. **k6** — the strongest HTTP load tool, with scripted scenarios and thresholds,
   but it is a separate binary with its own JS runtime and its own module system.
   Seeding and post-run assertions would still happen outside it, in Node, so the
   scenario would be split across two languages and two processes.
2. **`autocannon`** — a Node library, simple, but it generates plain requests
   against a URL. Signed webhook bodies, per-run data setup and invariant
   assertions are all outside its model; we would wrap it anyway.
3. **Node + `undici`** — no new dependency (`undici` is the runtime's HTTP client
   and is already what `fetch` is built on), one language for seeding, driving
   and asserting, and the same code path in CI and on Windows.

## Decision

- **The harness is Node scripts under `scripts/load/`, using `undici` for the
  client pool.** No new dependency, no separate binary, no second runtime.
- **Three phases in one process family:** `seed.mjs` provisions a scratch
  database through the repositories (never raw SQL), `run.mjs` drives the
  scenario at a fixed rate with a bounded concurrency pool, `assert.mjs` checks
  the post-run invariants against the same database.
- **Budgets are thresholds in code**, not prose: the run exits non-zero when a
  percentile or error rate from `docs/performance-budgets.md` is breached, so CI
  and a human read the same numbers.
- **Webhook load is signed and includes a deliberate replay share** (10%), because
  idempotency under concurrency is the property most likely to regress and the
  least likely to be caught by a single-request test.
- **`scripts/load/run.sh` mirrors `scripts/ci/integration.sh`**: scratch Postgres
  on `:55433`, migrate, seed, start API and worker, run, tear down. Load never
  points at a database a developer cares about.
- **Full-rate runs are nightly; PRs get a one-quarter-rate smoke** capped at about
  three minutes, so the gate is a regression signal rather than a queue tax.

## Consequences

- One language and one process tree for setup, load and verification, so a
  failing invariant can be debugged with the same tooling that produced it.
- No k6 threshold syntax, so the percentile maths is ours: a fixed-bucket
  histogram over collected durations, which is adequate at the volumes here and
  is tested like any other pure function.
- The harness competes with the API for CPU when both run on a laptop. Numbers
  from a developer machine are indicative only; CI and the pilot hardware are the
  reference points, and every recorded run names its machine profile.
- `undici` is tied to the Node version the repo already pins, so the harness
  inherits the same runtime upgrade cadence as the applications.
- Because seeding goes through repositories, a schema change that breaks seeding
  fails the load smoke — which is the desired early warning, not a nuisance.

## Alternatives considered

- **k6** — rejected for this phase: a second runtime and a split between the
  scenario file and the seeding/assertion code, for percentile reporting we can
  compute in twenty lines. Worth revisiting if we ever need protocol-level
  shaping (HTTP/2, connection reuse tricks) or a load-generator cluster.
- **`autocannon`** — rejected: it cannot express signed webhook bodies or
  post-run assertions, so it would be a dependency wrapped in the same Node code
  we would write anyway.
- **Load-testing in production-like staging only** — rejected: it makes the
  invariant checks a manual ritual. The suite has to run on a scratch database to
  be a gate.
- **Reusing the existing API test helpers as the load client** — rejected: they
  are built for assertions, not for sustained rate, and mixing the two makes both
  slower and less clear.
