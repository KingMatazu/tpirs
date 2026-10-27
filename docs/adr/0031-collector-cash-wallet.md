# ADR 0031: Collector cash wallet

## Status

Accepted

## Context

Phase 7 lets a collector take residual cash from a driver at the roadside and
credit the vehicle for that business day immediately, by SMS receipt. The
brief requires a float ceiling per collector, a dedicated deposit route back to
the platform, and an audit trail; the acceptance check is that a simulated day
closes to zero.

The money machinery for "a payment settles today" already exists. Phase 4
intake posts a balanced transaction (debit the gateway clearing account, credit
the asset wallet), then `ObligationService.ensurePaidForBusinessDay` runs the
allocation engine, which moves wallet credit to revenue and records the paid
period. Every rule that matters — the fee engine, `pay_per_use` versus
`scheduled`, underpayment as wallet credit (D19), idempotency on the payment
key, the paid-set `updated_at` bump that verification depends on — lives on
that path and is tested there.

Cash is not a different kind of money; it is the same money arriving through a
different door. What differs is only where the value sat before it reached the
asset wallet: a gateway clearing account in the payment case, cash held by a
collector in the cash case.

## Decision

- **Cash is a funding account, not a second settlement engine.**
  `ensurePaidForBusinessDay` gains two optional inputs: `fundingAccount`
  (default `GATEWAY_CLEARING`, the alternative being the existing
  `COLLECTOR_CASH` account in `STANDARD_ACCOUNTS`) and `collectorUserId`,
  carried onto the ledger entries so the cash balance is attributable per
  collector. Omitting both leaves every Phase 4–6 posting byte-identical.
- **Posting shape.** A cash intake posts `Dr COLLECTOR_CASH / Cr ASSET_WALLET`
  for the amount taken, then the ordinary allocation posts wallet to revenue.
  A matched deposit posts `Dr SETTLEMENT_BANK / Cr COLLECTOR_CASH`, which
  returns the collector's position to zero. The collector's outstanding float
  is therefore an asset of the tenant that the collector owes back, not a
  liability invented for the occasion.
- **Balances are derived, never stored.** The collector balance is the sum of
  `COLLECTOR_CASH` entries filtered by `collector_user_id`. This follows the
  existing rule for every wallet in `packages/db/src/repositories/ledger.ts`.
  `collector_wallets` holds only state and settings: status, freeze facts,
  overdue marker, and an optional per-collector ceiling override.
- **`cash_intakes` is the counter record.** One row per intake, keyed by a
  client-generated reference with a unique constraint per tenant and
  collector, carrying the asset, the zone snapshot, the obligation period, the
  ledger transaction, the business date and a receipt number. It is a record
  of fact about a cash handover; it is not a parallel payment.
- **The receipt is an `sms_log` subject.** `sms_log` gains `cash_intake_id`
  and a `cash_receipt` kind, with a unique index per intake and kind and the
  subject check extended accordingly. The existing outbox sweeper then sends
  it and records delivery attempts exactly as it does for payment receipts,
  with no new delivery path.
- **The cash path is idempotent end to end.** The intake idempotency key is
  `cash:<clientReference>`, so a retried form submission or a future offline
  outbox replay returns the original receipt instead of taking cash twice.
- **Ceiling enforcement is an application check under a lock.** Because the
  balance is derived, the database cannot express "undeposited cash must not
  exceed the ceiling" as a constraint. `CollectorCashService` locks the
  collector wallet row (`select … for update`), computes the derived balance,
  and refuses the intake when `balance + amount` would exceed the ceiling.
  Serialising per collector is what makes the check sound.
- **Permissions are explicit.** `cash:read`, `cash:intake`,
  `cash:deposit:read`, `cash:deposit:match`, `cash:freeze` and `cash:unfreeze`
  are added to `ALL_PERMISSIONS`; the collector role gets read and intake, the
  zone supervisor read and freeze, finance all six, the auditor the two read
  permissions. A migration grants them to roles carrying the built-in role key,
  because roles are inserted once and existing tenants would otherwise never
  see the new keys.

## Consequences

- One allocation engine, one revenue-recognition rule, one idempotency story
  for gateway money and cash alike. A behaviour change in allocation cannot
  drift between the two intake paths.
- Verification needs no cash-specific knowledge: a cash intake settles a day
  through the same obligation period a gateway payment would, so `GET
/v1/verify/:token` and the paid-set feed work unchanged.
- The derived balance costs a `sum()` per wallet read. At the volumes of a
  state pilot (thousands of intakes per day, not per second) that is cheaper
  than keeping a materialised balance correct against an append-only ledger,
  and it cannot disagree with the books.
- A cash intake is visible to reconciliation as `COLLECTOR_CASH` movement, not
  as a `payments` row, so provider settlement totals are not polluted by money
  that never touched a gateway.
- The floating-point and currency rules are inherited: integer minor units,
  one ISO currency per intake, fee currency must match the cash currency or
  the intake is refused.

## Alternatives considered

- **A separate cash allocation engine.** Rejected: it would duplicate the
  fee-resolution, allocation-ordering and idempotency logic that Phase 3
  already tests, and the two paths would diverge the first time a rule
  changed.
- **A stored wallet balance column.** Rejected: it can disagree with an
  append-only ledger after a reversal, a backfill or a failed transaction, and
  the disagreement would be silent until reconciliation.
- **A synthetic `payments` row per intake, reusing the existing receipt
  path.** Rejected: `payments` exists to record money that arrived through a
  provider and is reconciled against settlement files. A cash row would assert
  a gateway event that never happened, and the receipt dedupe indexes are
  keyed to payment subjects.
- **A `CashWallet` aggregate with its own ledger table.** Rejected: two
  ledgers cannot both be the truth, and the brief's property — total debits
  equal total credits — is only checkable across one.
- **A check constraint on the ceiling.** Not possible against a derived
  balance, so the ceiling is an application check under a row lock; ADR 0033
  records the trade-off.
