# ADR 0036: Settlement posting and the fee leg

## Status

Accepted

## Context

Phase 4 records a payment as `Dr GATEWAY_CLEARING / Cr ASSET_WALLET`, and the
allocation engine then moves wallet credit to `REVENUE_LEVY`. Phase 7 added a
second funding account (`COLLECTOR_CASH`) whose deposits post
`Dr SETTLEMENT_BANK / Cr COLLECTOR_CASH`.

Nothing ever moves gateway money into the bank. `GATEWAY_CLEARING` is an asset
account that only grows, so the books say the gateway owes the tenant an amount
that increases forever while the bank balance increases too. Both statements
cannot be true, and reconciliation is where that becomes visible.

A matched settlement row is the moment to fix it, with one complication: real
gateways settle **net of fees**. Paystack charges a percentage (with a cap and
some fixed items), and the account is credited with the payment minus that. A
matched row that moves only `SETTLEMENT_BANK` and `GATEWAY_CLEARING` cannot
balance against a net amount, and one that moves only the bank amount leaves
`GATEWAY_CLEARING` non-zero forever.

## Decision

- **A new account for the fee.** Migration 0014 adds `gateway_fees` to
  `account_type` and `GATEWAY_FEES` to `STANDARD_ACCOUNTS`
  (`account_class = 'expense'`), so `ensureStandardAccounts` provisions it for
  every tenant, including existing ones on their next ensure.
- **The posting has three legs and one unit of work.**

  ```
  Dr SETTLEMENT_BANK   bank amount
  Dr GATEWAY_FEES      payment amount - bank amount
  Cr GATEWAY_CLEARING  payment amount
  ```

  `source_type = 'settlement'`, `source_id = settlement_rows.id`, idempotency key
  `settlement:<row id>`, written in one transaction with the row's
  `payment_id`/`transaction_id`/`status` update. Either the money moves and the
  row is marked posted, or nothing happens.

- **A tolerance decides whether a difference is a fee.** The difference must be
  non-negative and within `reconciliation.feeToleranceMinor` (new config, with
  the tenant's own default). Inside it, the difference is booked as a fee.
  Outside it, **nothing posts** and the row becomes an exception with expected,
  actual and difference recorded.
- **Over-settlement never posts.** If the bank received more than the payment
  was for, the difference is not a negative fee and is not a windfall: the row
  becomes an exception. The same reasoning as Phase 7's over-deposit staying in
  suspense (D35) — an unexplained surplus must stay visible, not be absorbed.
- **Ambiguity and lump sums are exceptions, not guesses.** A reference that
  matches zero or several payments, a currency mismatch, or one statement line
  covering many payments posts nothing. Splitting a lump sum is a finance
  decision, not an automatic one.
- **Sign-off requires the result, not the intention.** A run cannot be signed off
  while a blocking exception is open or while the per-provider
  `GATEWAY_CLEARING` balance is outside `toleranceMinor` after postings. The
  clearing account reaching zero is the proof that the fee leg did its job.

## Consequences

- `GATEWAY_CLEARING` becomes a real clearing account: it rises when drivers pay
  and returns to zero when the bank statement is reconciled, per day and per
  provider.
- Fees are visible as a cost of collection in the ledger, so a report can show
  gross collections, fees and net receipts as three related numbers instead of
  one unexplained gap (D49).
- A fee increase at the gateway shows up as exceptions, not as silently wrong
  money: the tenant either accepts the new level by raising
  `feeToleranceMinor` or investigates.
- The tenant's tolerance is a guess until real statements exist. It is meant to
  be set low (a few percent of a typical levy) and tuned against evidence, and
  the first weeks of a pilot will legitimately produce some fee exceptions.
- Reversals are unaffected: a settlement posting is an ordinary ledger
  transaction, so the existing dual-approval reversal path applies and does not
  need a settlement-specific variant.
- Multi-currency settlement and FX differences are out of scope: a row whose
  currency is not the tenant's currency is an exception.

## Alternatives considered

- **Reconcile without posting** — rejected: it leaves the clearing account
  permanently overstated, so the day's checklist can never show zero and the
  "the gateway owes us" figure loses all meaning.
- **Post only exact-amount matches** — rejected: a real gateway's net settlement
  is never exact, so nothing would post and the account would keep growing.
- **Model each gateway's fee schedule (percentage, cap, fixed items)** — rejected:
  fees change without notice, differ per merchant and per channel, and a wrong
  model posts wrong money confidently. A tolerance plus a visible expense
  account is honest about what is known.
- **Post the fee to `SUSPENSE`** — rejected: suspense means "nobody knows what
  this is". A gateway fee inside the agreed tolerance is a known, explainable
  cost, and mixing the two would make both harder to work.
- **Net the fee into `REVENUE_LEVY`** — rejected: it would understate levy
  revenue by the cost of collecting it and make revenue reconciliation
  unverifiable against paid obligations.
- **Let over-settlement credit a fee-recovery account** — rejected: it invents a
  reason for money whose provenance is unknown; the exception queue is the honest
  place for it.
