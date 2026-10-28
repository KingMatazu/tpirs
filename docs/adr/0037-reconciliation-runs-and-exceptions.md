# ADR 0037: Reconciliation runs, exceptions and sign-off

## Status

Accepted

## Context

The brief asks for nightly reconciliation, an exceptions queue with tolerances,
and a finance sign-off on a simulated month. The hard part is not the queries; it
is time. A day's evidence keeps arriving after the day ends: a statement is
uploaded at noon the next day, a webhook lands at 00:05 with yesterday's
business date, a collector deposits the following morning. A single mutable
"day 3 March" object would be rewritten all day, and an auditor's first question
— "why did this pass on Tuesday and fail now?" — would be unanswerable.

Cash reconciliation already has a precedent for this (Phase 7): the float is
derived, and the sweeper records findings as appended audit entries rather than
editing anything.

## Decision

- **A run is an immutable attempt, identified by `(tenant, business_date,
run_seq)`.** Every attempt inserts a new row. Statuses are `running`,
  `completed`, `failed` and `signed_off`. A trigger rejects updates to any column
  other than the sign-off columns and rejects `delete` outright.
- **Sign-off is the only transition.** It requires `reconciliation:run`, a
  non-empty note, and writes an audit entry naming the actor. It records
  `signed_off_by_user_id`, `signed_off_at`, `sign_off_note` and the checklist
  state at that moment. A re-run after sign-off creates `run_seq + 1`; the
  signed-off version stays exactly as it was.
- **The run stores what it decided with.** `checklist` (JSONB, one entry per
  check with expected, actual, difference and within-tolerance),
  `tolerance_snapshot` and `fee_tolerance_snapshot` live on the run, so a later
  config change cannot rewrite the reason a past day passed.
- **One row per open exception, deduplicated by `dedupe_key` =
  `kind:subject_type:subject_id`.** A condition discovered on Monday and still
  true on Tuesday updates `last_seen_run_id` instead of adding a row; the row
  remembers `first_seen_run_id`, so "how long has this been open" is a query.
- **Resolution and waiver are facts, not deletions.** Both require
  `reconciliation:run`, a note and an audit entry. A condition that reappears
  after being resolved creates a _new_ row: reopening the old one would erase who
  closed it and why.
- **Severity decides what blocks sign-off.** `blocking`, `warning`, `info`. Only
  blocking exceptions stop sign-off, and the run keeps a count per severity so a
  filtered queue cannot hide a blocker.
- **A failed run is a recorded outcome.** Exceptions during computation mark the
  run `failed` with the reason, and the worker retries on its next tick. A day
  never silently has no run.

## Consequences

- The acceptance check "a month reconciles and is signed off" becomes a loop:
  compute a day, sign it, move on. A late payment afterwards produces version 2
  of that day and needs a second signature, which is the correct behaviour for a
  finance team that has already told the state the day was closed.
- Reporting reads the **latest completed-or-signed-off run per day**. The
  versioning is invisible to a dashboard; it is visible to an auditor, which is
  the point.
- The checklist is self-describing: a signed-off run can be re-read years later
  without re-running anything and without depending on config that may have
  changed.
- Exceptions are carry-forward, so a genuinely ignored problem shows up in the
  queue with a growing age rather than a growing row count.
- Storing snapshots duplicates a little data per run (two small integers, one
  JSON blob) in exchange for historical accuracy.
- The uniqueness constraint on `(tenant, business_date, run_seq)` makes a
  concurrent double-run impossible: the second insert fails and the caller
  treats it as "someone else is computing today".

## Alternatives considered

- **One mutable run per day, updated as evidence arrives** — rejected: it
  destroys the evidence that a late payment arrived, and "signed off" becomes a
  flag that later processes can quietly invalidate.
- **A run per check, no day-level object** — rejected: finance signs a day, not
  a query, and there would be nothing to freeze.
- **Storing only the latest state and recomputing history on demand** — rejected:
  a recomputation after a config change silently rewrites history.
- **Auto-closing exceptions that stop appearing** — rejected: closing is a
  human judgement with a reason, and a transient problem deserves to be seen as
  resolved rather than to vanish.
- **A `reopened` status** — rejected: two rows with distinct timestamps and
  actors are clearer than one row meaning two things.
