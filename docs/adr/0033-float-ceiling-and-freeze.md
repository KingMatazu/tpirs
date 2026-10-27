# ADR 0033: Float ceiling, deposit deadline and freeze

## Status

Accepted

## Context

Cash in a collector's pocket is money the tenant does not yet have in its
account. Two risks follow: the amount at risk grows without limit, and a
collector who keeps the cash for a week looks, in the books, exactly like one
who deposited it yesterday. The brief asks for a float ceiling, a deposit
deadline, and an automatic freeze on shortfall, all configurable per tenant.

`TenantCashRules` already carries `enabled`, `floatCeilingMinor`,
`depositDeadlineHours` and `freezeOnShortfall`. Nothing enforces them yet, and
the derived balance design (ADR 0031) means the ceiling cannot be a database
constraint.

Two questions had to be answered rather than assumed: who may freeze, and who
may unfreeze. A collector must never be able to unblock themselves, but a
supervisor standing in the zone is the person who discovers the problem.

## Decision

- **The ceiling caps undeposited cash, not a single intake.** The check is
  `balance + intake ≤ ceiling` where `balance` is the derived
  `COLLECTOR_CASH` position. The ceiling comes from
  `cashRules.floatCeilingMinor`, with an optional per-collector override on
  `collector_wallets` for the collector whose route carries more cash.
- **Enforcement is a row lock plus a pure function.** `CollectorCashService`
  locks the wallet row, computes the balance, and calls the domain's
  `assertWithinCeiling`. Two concurrent intakes for one collector serialise on
  the lock; the rule itself stays in `packages/domain` where it is property
  tested. This is weaker than a database invariant and the code says so.
- **The deadline is measured in hours from the intake, in the tenant
  timezone.** `depositDeadlineHours` is applied to each open intake's
  `recorded_at` instant, not to a calendar day, so a collector who takes cash at
  16:00 is not "late" at midnight while a 24-hour window is still open. The
  business day printed on a receipt still comes from
  `todayInTimeZone(config.locale.timezone)`.
- **A sweeper, not a trigger, marks overdue.** A job on the existing Postgres
  queue runs on a schedule, finds wallets with open intakes past the deadline,
  sets `overdue_since`, and queues one supervisor notice per wallet per
  deadline window (deduplicated, so a repeated sweep does not spam the same
  supervisor). The sweeper is idempotent: running it twice changes nothing.
- **Freeze is a state transition on the wallet, and it blocks intake only.**
  A frozen wallet refuses `POST /v1/cash/intakes` with `409`. Verification,
  scanning, driver USSD/SMS payments and reconciliation are untouched: freezing
  a collector must never stop an officer from checking whether a vehicle paid,
  and it must never turn a collector's missing deposit into a driver's problem.
- **Permissions split freeze from unfreeze.** `cash:freeze` is held by the zone
  supervisor and finance; `cash:unfreeze` is held by finance only for now. The
  service takes the caller's principal, so allowing a supervisor to unfreeze
  their own zone later is a policy change against a recorded trigger
  (an explicit user-to-zone assignment, which does not exist yet), not a
  signature change.
- **Every transition is audited with a reason.** Freeze and unfreeze require a
  reason string and write an audit entry naming the actor; the sweeper's
  automatic freeze records the sweeper as the actor and the shortfall that
  caused it. `freezeOnShortfall: false` marks overdue and notifies without
  freezing, which is the setting a tenant uses while it is still training
  collectors.
- **Nothing is deleted or reversed by a freeze.** The cash stays on the books,
  the intakes stay open, and the balance stays derived. Clearing the position
  requires a deposit, a matched suspense deposit, or an approved reversal —
  never an administrative edit.

## Consequences

- The acceptance checks are ordinary tests: a day of intakes plus matching
  deposits closes to zero, and one overdue wallet with `freezeOnShortfall:
true` produces an audit entry, a frozen wallet, and a `409` on the next
  intake; with the flag false it produces the audit entry and the notice only.
- A collector who is frozen while holding cash can still be verified, still
  appears in reports, and still owes the same amount — the freeze stops the
  bleeding rather than rewriting history.
- Timezone handling is confined to display: deadlines are instants, business
  dates are tenant-local, and the sweeper compares instants, so a DST change
  does not move a deadline by an hour in the wrong direction.
- Tenants can start with `freezeOnShortfall: false` and tighten it once
  collector training is done, without a code change.
- The read path (wallet list, supervisor view) can be slow on very large
  ledgers because the balance is a sum. If it becomes a problem the fix is an
  index or a nightly snapshot, not a stored balance.

## Alternatives considered

- **Freeze on every missed deadline regardless of config.** Rejected: a
  misconfigured deadline would stop a whole zone's collectors on day one, and
  the brief explicitly makes the behaviour configurable.
- **A database trigger that freezes on insert.** Rejected: it cannot compute a
  derived balance, cannot write an audit entry with a human-readable reason,
  and would fire inside the money transaction where a failure is expensive.
- **Blocking verification for a frozen collector's assets.** Rejected as
  dangerous: an officer would see "no payment recorded" for a vehicle whose
  driver paid cash and holds a receipt, which is exactly the false accusation
  the platform is built to avoid. Also rejected: marking the day unpaid on
  freeze, for the same reason.
- **A calendar-day deadline ("deposit by end of day").** Rejected: it makes a
  16:00 intake four hours late and an 09:00 intake fifteen hours early, and it
  interacts badly with shifts that cross midnight. Hours from the intake are
  honest about what is being measured.
- **Supervisor unfreeze in Phase 7.** Deferred with a recorded trigger rather
  than guessed: the zone relationship is per-asset today, and letting a
  supervisor unfreeze by asset zone would let any supervisor unfreeze a
  collector who worked one asset in that zone.
