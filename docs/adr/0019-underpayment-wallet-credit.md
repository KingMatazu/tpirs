# 0019: Underpayment as declaration-gated wallet credit

## Context

Under `pay_per_use` a day is either paid in full or not paid; there is no partial
period. A driver who transfers slightly less than the fee creates a payment that
cannot settle a day. Two instinctive responses are both wrong:

- **Send it to suspense.** Finance then has to intervene on every short payment,
  at fleet scale, while the driver is at the roadside and cannot proceed.
- **Apply it automatically as part-payment, or let a later balance silently settle
  the day.** That spends money the driver did not declare for that day, and
  invents a debt or a revenue recognition for a day they may not have worked.

The rule the platform has to keep is that money moves against a declaration: a
driver says "I am working today", and only then is the fee taken.

## Decision

- A payment below the fee credits the asset wallet and leaves the day unpaid.
  Nothing is allocated. The payment state is `credited`, and it has no business
  date until a declaration settles a period.
- Credit is never consumed by the passage of time, and never consumed because a
  later unrelated payment happens to make the balance whole. A payment for the
  current day is itself a declaration, so that payment applies; pre-existing
  credit stays inert.
- The driver spends credit in one of two ways: paying for the day, or choosing
  "pay today from balance" in the USSD menu, which applies exactly one day if the
  balance covers the fee.
- If the balance does not cover the fee at declaration time, nothing is applied.
  The driver receives an SMS stating the exact shortfall and can request a
  reference for `fee − balance`.
- `payments.underpaymentPolicy` selects `wallet` (default) or `suspense`.
  Suspense exists for states that want finance to review every short payment.
  Currency mismatches and unattributable payments go to suspense regardless of
  this setting, because no policy can make them attributable.
- `ensurePaidForBusinessDay` is reachable only from those two entry points, so no
  caller can drain a balance by accident. This is enforced by the service
  boundary and covered by a test.
- Verification keeps its meaning: an asset with credit but no declaration shows
  UNPAID, and that is not a debt.

## Consequences

- A driver who pays 80% of the fee sees "you are 20% short" and can settle the
  difference the same day, without finance.
- The wallet balance is a real liability on the books and appears in finance
  views as held credit, not as revenue.
- Declaration is idempotent through the existing unique constraint on
  `(tenant, asset, period)` and a `wallet-apply:<asset>:<date>` ledger key, so a
  double-tap in USSD cannot settle two days.
- A driver who never declares loses nothing; the credit remains until it is spent
  or refunded under the policy in D8.

## Alternatives considered

- **Suspense for every shortfall.** Rejected as the default: it converts a routine
  rounding error into a finance ticket. Kept as a configurable policy.
- **Partial periods.** Rejected: a half-paid day would need a notion of partial
  compliance that the brief explicitly does not want.
- **Auto-apply when the balance becomes sufficient.** Rejected: it is the silent
  deduction the declaration rule exists to prevent.
- **Refund the shortfall immediately.** Rejected: refunds cost more than the
  money involved and leave the driver unable to pay the remainder.
