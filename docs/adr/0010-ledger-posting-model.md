# 0010: Double-entry ledger, wallet-first crediting, and a single unit of work

## Context

Phase 3 introduces the financial truth of the platform: every payment must be
recorded in an append-only double-entry ledger, and every obligation period
must settle from money that is actually on the books. Build brief section 6
requires a chart of accounts (asset wallet, collector wallet, tenant revenue,
gateway clearing, suspense), transactional posting, and a property that
debits equal credits.

Two shapes were possible:

- **Direct recognition.** A payment debits gateway clearing and credits
  revenue in one posting. Simple, but it silently discards overpayments: the
  driver pays three days at once, and two days of that money disappears.
- **Wallet first.** A payment always lands in the asset wallet. A separate
  allocation step then moves wallet credit into revenue, period by period.

The second shape is what the brief describes ("a payment always credits the
asset wallet first, then the allocation engine applies it"), and it is the only
shape that can represent a surplus, a shortfall, or a prepay without inventing
new accounts later.

## Decision

- The chart of accounts is seeded per tenant, per currency, by
  `AccountRepository.ensureStandardAccounts`: `ASSET_WALLET`, `REVENUE_LEVY`,
  `GATEWAY_CLEARING`, `SETTLEMENT_BANK`, `SUSPENSE`, `COLLECTOR_CASH`.
  Account classes are `asset`, `liability`, `revenue`.
- A posting is a _transaction_ (one row, one source, one idempotency key) with
  two or more _entries_. `validateBalancedTransaction` in
  `packages/domain/src/ledger.ts` rejects a posting whose debits and credits
  differ, whose currency is mixed, or that has fewer than two entries. The
  database repeats the check (ADR 0012).
- **Wallet first.** A payment posts `GATEWAY_CLEARING debit → ASSET_WALLET
credit` and nothing else. Both legs carry the asset, so the gateway clearing
  balance is attributable per asset during reconciliation. Allocation then
  posts `ASSET_WALLET debit → REVENUE_LEVY credit` per period.
- Money that no period claims stays in the wallet. Surplus is never recognised
  as revenue and never lost (decisions-needed D8 tracks the refund policy).
- Under `pay_per_use` a period settles **only in full** (decisions-needed D9).
  A shortfall leaves the credit in the wallet and the day unpaid, because a
  day with no payment is never a debt. Under `scheduled`, partial allocation
  is allowed and the remainder stays in the wallet.
- Under `pay_per_use` only the current payment is available for allocation;
  prior surplus is not applied to a new day. Under `scheduled` the whole
  wallet balance is available.
- Allocation order is tenant config (`obligations.allocationOrder`:
  `oldest_first` or `today_first`), not code.
- **`LedgerService` is transaction-bound.** It never opens a transaction of
  its own; the caller owns the unit of work through `withLedger(db, tenantId,
fn)`, which sets the application role and `app.tenant_id` and therefore
  activates row-level security. A ledger posting and the state change it
  causes commit or roll back together.
- Repositories query the transaction they were given directly. They must not
  call `withTenant`: Kysely 0.28 does not support nesting a transaction inside
  a transaction, and the tenant scope is already active on the transaction the
  caller supplied.
- Concurrency: `ObligationRepository.lockAssetObligations` locks the asset
  row and then the obligation rows of that asset, so two concurrent payments
  for one asset cannot both settle the same period. The lock is taken on the
  asset row because the period may not exist yet.

## Consequences

- Balances are derived from entries, never stored. `accountBalance` sums
  credits minus debits for one account, optionally for one asset.
- A payment is idempotent per payment id: the wallet posting uses
  `payment:{id}:wallet` and each allocation uses
  `payment:{id}:allocation:{periodId}` as its idempotency key, so a replayed
  webhook or a retried job changes nothing.
- The obligation period snapshots the rule and the amount that priced it
  (`fee_rule_key`, `fee_amount_snapshot_minor`) so a later fee change cannot
  rewrite history.
- Reversal posts mirrored entries in the same transaction as the approval
  (ADR 0013), so an approved reversal can never exist without its reversing
  transaction.
- The application layer owns the ordering rules; the domain layer owns the
  arithmetic. `planAllocation` is a pure function, which is what makes the
  property tests in `packages/domain/src/allocation.property.test.ts`
  possible.

## Alternatives considered

- **Direct recognition in one posting.** Rejected: it cannot represent a
  surplus or a shortfall, and it would make the "never falsely accusatory"
  rule hard to honour for partially paid days.
- **A stored balance column per wallet.** Rejected: a derived balance is
  always reconcilable with the entries; a stored one drifts and would need its
  own audit trail.
- **One transaction per posting.** Rejected: the posting and the period
  update must be atomic, and a service that owns its transaction cannot be
  composed with the caller's unit of work.
- **Row-level locking on the period row only.** Rejected: the period for
  today may not exist yet under `pay_per_use`, so the lock has to start at the
  asset row.
