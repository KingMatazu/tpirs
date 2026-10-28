# ADR 0040: Cron scheduling with `cron-parser`

## Status

Accepted

## Context

Tenant config stores `reconciliation.schedule` as a cron expression (the seeded
tenants use `0 2 * * *`), and `TenantConfig` validation accepts it as a string.
Nothing evaluates it. The worker already runs a timer that drives the SMS outbox
sweeper, the channel outbox sweeper and the cash deadline sweeper, so a scheduler
has somewhere to live.

Options were: parse the expression, hand-roll an `HH:MM` reader, or ignore the
config and sweep on a fixed interval. The last one is not really an option —
it silently disobeys configuration that a tenant can see and edit, and a tenant
that reconciles at 23:00 for a shift that ends at 22:00 would be swept at the
wrong time.

Cron parsing is also a place where plausible-looking code is wrong in
timezones: DST transitions, day-of-month arithmetic, `*/N` steps, lists and
ranges. That is exactly the kind of logic worth borrowing rather than writing.

## Decision

- **`cron-parser` for next-occurrence computation**, wrapped in one small
  function — `nextOccurrence(schedule, after, timeZone)` — so the dependency is
  replaceable in a single file and the rest of the worker never imports it.
- **The worker keeps its own timer.** On each tick it asks, per tenant, whether
  the next occurrence after the last checked instant has passed. It does not hand
  scheduling over to the library, does not build a long-lived scheduler per
  tenant, and does not sleep until 02:00.
- **The timezone is `locale.timezone` from tenant config.** All comparisons are
  instant-based; the business date enqueued is
  `todayInTimeZone(config.locale.timezone, ...)`, so a DST shift moves the run by
  an hour at most and never produces yesterday's date.
- **The job is idempotent on `(tenantId, businessDate)`.** Enqueuing the same
  pair twice is a no-op at the queue, so two worker processes, a restart, or a
  tick that straddles the scheduled minute cannot run a day twice. A day that
  already has a completed run is skipped, so a restarted worker does not redo
  yesterday.
- **An invalid expression fails at config load.** Validation parses the
  expression through the same helper, so a typo is a startup error with a precise
  path rather than a 02:00 telemetry event.
- **A failed run is retried on the next tick**, with the failure recorded on the
  run row (ADR 0037). The scheduler never marks a day done on the strength of
  having enqueued it.
- **Reconciliation runs as a queued job, not inside the tick.** The timer must
  keep sweeping the SMS outbox and cash deadlines while a reconciliation run
  computes.

## Consequences

- One new dependency, confined to a helper. The rest of the worker is unchanged
  and the existing timer remains the only clock the process has.
- Full cron expressions work, including steps, lists and ranges, so a tenant can
  express "every day at 01:30 and 02:00 during the first week of the month" if it
  ever needs to — the library supports it and the config validator allows it.
- Tick frequency becomes a latency question, not a correctness one: a 60-second
  tick means a run starts within a minute of its scheduled time, and a missed
  tick is caught up on the next one because the decision is "has the next
  occurrence passed", not "is it now exactly 02:00".
- Config validation now depends on the cron library too, so an upgrade to it is
  visible in two places rather than one.
- Because the schedule is evaluated per tenant per tick, the cost grows with the
  number of tenants, not with the number of runs: a handful of string parses per
  minute, which is cheaper than a per-tenant timer table and easier to reason
  about.

## Alternatives considered

- **A hand-rolled `HH:MM` reader** — rejected: it would accept a config it cannot
  honour (a real cron expression), and the failure would be a silently wrong
  run time rather than a validation error.
- **A fixed polling sweep that skips completed days** — rejected: it ignores
  `reconciliation.schedule` entirely, and the nearest available compromise
  ("sweep hourly") reconciles at times no finance user chose.
- **`croner`** — a good alternative with a similar API; `cron-parser` was chosen
  because only the next-occurrence calculation is needed, and the smaller
  surface is easier to keep behind the helper.
- **Giving the library the timer (`cron.schedule(...)`)** — rejected: it would put
  a second scheduling mechanism inside the process alongside the existing
  interval, so shutdown, restart and test-time clock injection would each need
  handling twice.
- **A database-driven scheduler table with `next_run_at` columns** — rejected for
  now: config already holds the schedule, and duplicating it into rows creates a
  second source of truth that has to be synchronised on config change.
