# ADR 0032: Cash deposit attribution

## Status

Accepted

## Context

A collector holds cash that belongs to the platform, up to a configured
ceiling. The platform learns that the cash came back when it lands in the
settlement bank account, which Phase 4 already observes as a provider webhook.
Intake attributes a payment to an asset by looking up `payment_instructions` on
the provider reference (ADR 0018): a virtual account or a narration reference
belongs to exactly one asset.

A collector deposit is not a payment for an asset. If it went through the asset
lookup, one of two bad things would happen: an unmatched reference would land in
gateway suspense and be investigated as a driver's missing payment, or — worse,
if a reference collided — a collector's deposit would credit a vehicle that
nobody paid for. Finance would then be reconciling money that is already on the
books in the right place, looking for a driver who does not exist.

The deposit also needs a fallback. Some providers do not offer per-collector
virtual accounts, and cash can arrive with a reference that was mistyped at the
bank counter.

## Decision

- **Deposits carry their own reference table.** `collector_deposit_instructions`
  maps `(tenant_id, provider, reference)` to one collector, with
  `kind = virtual_account | narration` and an `active | revoked` status. The
  reference format is chosen by the provider adapter's declared capabilities;
  core code never invents one (the same rule as D3 for assets).
- **The adapter mints the reference, through an optional port member.**
  `PaymentProvider.createDepositAttribution?` returns the kind and the value the
  collector pays with. It is optional because a provider with no per-collector
  deposit mechanics cannot honour one; provisioning then fails loudly with a
  `PortError` instead of core manufacturing a reference the gateway's webhook
  would not recognise. Only one instruction per `(collector, provider)` is
  active at a time — provisioning rotates, revoking the previous row in the same
  transaction — and the reference itself must be fresh per rotation, because
  `(tenant, provider, reference)` is unique.
- **Deposit resolution runs before asset attribution.** Webhook intake resolves
  the tenant from the endpoint token (ADR 0017), then checks
  `collector_deposit_instructions`, and only then `payment_instructions`. The
  ordering is the decision: a reference that is a deposit is never inspected as
  a payment reference, so the two namespaces cannot cross-credit.
- **A matched deposit is a transfer, not revenue.** It posts
  `Dr SETTLEMENT_BANK / Cr COLLECTOR_CASH (collectorUserId)`, which clears the
  collector's derived cash position. No obligation is touched: the day was
  already settled at intake.
- **Matching is oldest-open-intake-first.** A deposit covers the collector's
  open intakes in the order the cash was taken, recorded in a deposit
  allocation row per intake. Oldest-first is the only order that matches what a
  deadline means: the intake closest to being overdue is the one the deposit is
  paying for.
- **A remainder or an unknown reference stays in suspense.** The deposit is
  recorded with `status = 'suspense'`, and the surplus is not credited to a
  wallet, a vehicle, or the next day. Finance resolves it by matching it to an
  intake once the asset works that day and a payment is allowed (the confirmed
  answer to the open question). Keeping the surplus visible and inert is what
  makes the day-close arithmetic checkable: intake minus deposits equals the
  derived balance, with suspense counted separately.
- **Finance manual match is the fallback, and it is audited.** A finance user
  can attach a suspense deposit to an existing intake
  (`POST /v1/cash/deposits/:id/match`), which posts the same two legs and
  leaves any remainder in suspense. The action is idempotent, permission-gated
  on `cash:deposit:match`, and written to the audit log with the actor and the
  before/after state.
- **Replay safety is a unique constraint.** `cash_deposits` is unique on
  `(tenant_id, provider, provider_reference)`, so a provider retry is a no-op
  exactly like a replayed payment webhook (ADR 0016).

## Consequences

- A collector deposit can never be mistaken for a driver's payment, and a
  driver's payment can never clear a collector's float.
- The suspense queue shows two kinds of item — unrecognised gateway money and
  unrecognised collector cash — distinguishable by type, so finance does not
  have to guess which ledger account is short.
- Some providers need no new integration surface at all: a narration reference
  on the existing webhook is enough, because the instruction table, not the
  provider, decides who owns the reference.
- The deadline sweeper and the reconciliation report both read the same
  allocation rows, so "how much of this collector's cash is still out" has one
  answer.
- Deposits that arrive before the intake they fund (a collector paying in
  early) sit in suspense until finance matches them; the system does not hold
  unearned credit on a collector's behalf.

## Alternatives considered

- **Attribute deposits through `payment_instructions` with a synthetic asset.**
  Rejected: it would need a fake asset per collector, which pollutes the
  registry, the paid set and every report that counts assets.
- **Manual matching only, no deposit reference.** Rejected for Phase 7: it
  leaves the common case to a human and makes the deadline meaningless,
  because nothing arrives automatically. It remains available as the fallback.
- **Auto-credit an over-deposit to the collector's next obligation.** Rejected
  by the confirmed decision: it turns a bank mistake into a free day for a
  vehicle that may never have worked, and it hides the discrepancy from
  finance.
- **A separate webhook endpoint per collector deposit.** Rejected: it
  multiplies endpoint tokens and per-tenant configuration for no gain, since
  the provider reference already carries the discrimination.
- **Reconciling deposits only in the Phase 8 nightly job.** Rejected: the
  acceptance check for this phase requires a simulated day to close, and a
  float that only clears nightly would let a collector exceed the ceiling
  during the day.
