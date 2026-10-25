# ADR 0028: Verification status and paid set

## Status
Accepted

## Context
Phase 6 introduces field verification and offline support. The build brief requires:
- `GET /v1/verify/:token` must not imply debt under `pay_per_use`
- Offline cache can confirm payment but must never conclude UNPAID
- Paid set uses delta sync with cursor-based pagination

## Decision
- **Payment status vocabulary**: `paid`, `no_payment_recorded`, `unknown`. `no_payment_recorded` is factual (no period/payment recorded), not a debt. `unknown` reserved for cases where ledger/config cannot be read.
- **Business date**: Computed per tenant timezone via `todayInTimeZone`. All status queries use server business date.
- **Paid set**: Snapshot when no cursor, delta when cursor provided. Entries keyed by `qrPayload`. `paid: false` removals; cursor is `(updatedAt, id)`. Day rollover clears cache on business date change.
- **Reversals**: Approved reversals must update obligation periods back to unpaid and bump `updated_at` so removed from paid set (trigger in migration 0011).
- **Offline**: Only `paid` or `not_in_offline_list`. No "unpaid" state.

## Consequences
- Clear separation between factual absence and debt
- Safe offline operation
- Reversals properly reflected in sync feed
- API contract updated (paymentStatus enum extended)
