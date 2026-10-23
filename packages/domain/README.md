# @tpirs/domain

Pure business primitives shared by every package: `Money` (integer minor units

- ISO currency), opaque branded IDs, business dates, and the error taxonomy.
  Zero imports from frameworks, ORMs, or vendor SDKs — this package must stay
  pure TypeScript.

Phase 3 added the financial core, all of it pure and all of it property-tested:

- **`ledger.ts`** — `validateBalancedTransaction` (a posting is accepted iff
  its debits equal its credits, its currency is single, and it has at least
  two entries) and `mirrorPostings` (the reversed entries a reversal posts).
- **`allocation.ts`** — `planAllocation`, the engine that applies wallet
  credit to obligation periods. Under `pay_per_use` a period settles only in
  full; under `scheduled` partial allocation is allowed. The plan is total and
  deterministic, so the same inputs always produce the same allocations.
- **`fee-engine.ts`** — `selectFeeRule`, the single place that decides which
  effective-dated rule prices an asset on a date. The `FeeEngine` port is a
  thin shell over it (ADR 0011).

The property suites (`*.property.test.ts`) use `fast-check` through the
harness in `src/test-support/`, which is excluded from the build so it is
never emitted into `dist`. `FAST_CHECK_RUNS` raises the number of generated
cases; the nightly CI job runs a deep pass (ADR 0014).

## Phase 5: Driver channels

- **`ussd.ts`** — `advanceUssdSession`, the pure state machine behind USSD.
  Input is the provider's cumulative `text`, so a session is replayed rather
  than stored server-side and a retried callback is idempotent (ADR 0023).
  It walks the tenant's typed menu graph and returns a `continue`/`end` result;
  it knows nothing about aggregators, HTTP, or config loading.
