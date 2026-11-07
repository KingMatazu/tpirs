# Runbook: collector cash

Park collectors who do not use the app take cash at the roadside. The platform
records the intake, settles the day through the ordinary settlement path, and
knows exactly how much of the State's cash the collector is holding.

Background: ADR 0031 (cash as a funding account), ADR 0032 (deposit
attribution), ADR 0033 (float ceiling, deadline, freeze), ADR 0069 (Virtual
Terminal funding and the prepaid model). Config lives under `cashRules` in the
tenant config; nothing here is state-specific.

| `cashRules` field      | Meaning                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| `enabled`              | Whether cash collection is allowed at all                                     |
| `floatCeilingMinor`    | Postpaid: most cash one collector may hold; a wallet can override it          |
| `depositDeadlineHours` | Postpaid: how long an intake may stay open before it is a shortfall           |
| `freezeOnShortfall`    | Postpaid: whether a missed deadline freezes the wallet automatically          |
| `model`                | `postpaid` (default) or `prepaid` (ADR 0069)                                  |
| `maxBalanceMinor`      | Prepaid: the most credit a collector may hold (default ₦50,000)               |
| `intakeGuard`          | Prepaid: `hard` (default, no negative position) or `grace`                    |
| `graceMinor`           | Prepaid with `grace`: how far an intake may cross zero                        |
| `funding`              | The rail; only `virtual_terminal` today (`pay_with_transfer` is the fallback) |

## Two models, one ledger

`COLLECTOR_CASH` is the State's asset, so the derived balance is **positive when
the collector holds State cash** and **negative when the platform holds the
collector's prepaid credit**.

- **Postpaid** (the default): the collector takes cash first and deposits it by
  `depositDeadlineHours`; `balance + intake <= floatCeilingMinor`, and a deposit
  covers open intakes (suspense when it cannot).
- **Prepaid** (ADR 0069): the collector funds the wallet first and each intake
  draws it down. `balance + intake <= graceMinor` (0 under the hard guard). A
  top-up credits the wallet regardless of open intakes, so there is no suspense.
  Intakes are recorded `matched` immediately and never enter the deadline sweep.

Switch a tenant by editing config — no deploy:

```yaml
cashRules:
  enabled: true
  floatCeilingMinor: 5000000
  depositDeadlineHours: 24
  freezeOnShortfall: true
  model: prepaid
  maxBalanceMinor: 5000000
  intakeGuard: hard
  graceMinor: 0
  funding: virtual_terminal
```

## 0. Fund a prepaid wallet (Virtual Terminal)

A pre-funded collector transfers **any amount, at any time** to a terminal's
dedicated account. Paystack names the terminal in the webhook
(`metadata.virtual_terminal.code`), which is how the credit is attributed.

Provision or rotate from the dashboard: **Collectors → Open → Funding terminal**
(permission `payment:manage`), or:

```sh
POST /v1/cash/collectors/<collectorUserId>/deposit-instruction
Authorization: Bearer <finance token>          # permission: payment:manage
Content-Type: application/json

{ "provider": "paystack", "rotate": true }
```

The response carries `reference` (the `VT_…` code) and, where the market issues
one, `accountNumber`, `accountName`, `bank` and `pageUrl`. The collector app's
**Fund wallet** screen renders them with a copy button and a live balance.

- A plain repeat returns the live terminal; only `"rotate": true` replaces it.
  Rotation deactivates the old terminal at Paystack first, so an old number can
  never keep crediting the collector.
- Deactivate with `DELETE /v1/cash/collectors/<collectorUserId>/deposit-instruction`
  (also part of the leaver procedure). A remote failure leaves the row active —
  never a hidden destination the bank still credits.
- Credit is **gross**: `Dr GATEWAY_CLEARING / Cr COLLECTOR_CASH`. The gateway fee
  is expensed when the settlement line posts, so the collector gets the full
  float and the State carries the fee (1% capped ₦300 on a terminal transfer).
- The app polls the wallet every 5 seconds while **Fund wallet** is open. The
  webhook credits in the same request that receives it; Paystack retries for 72
  hours if a delivery is missed.
- A transfer over `maxBalanceMinor` is still credited (the money has arrived),
  audited as `cash.topup.over_cap`, and the wallet shows the excess. It is not a
  reason to refuse the collector's money.

**Paystack must be enabled for Virtual Terminals** on the pilot business, and the
collector's dedicated NUBAN appears only where the market issues one. Without a
NUBAN the app shows `pageUrl` instead. Neither is a code path: the API returns
whichever fields exist.

## 1. Provision a deposit instruction (postpaid or a second rail)

The same route also provisions the older `virtual_account`/`narration`
destinations for a provider that offers them. The reference is minted by the
payment adapter — never by core code — and exactly one instruction per
`(collector, provider)` is active at a time.

The portal's **Collectors → Open → Funding terminal** card shows the destination
next to the wallet once it exists.

## 2. Take cash (an intake)

From the dashboard: **Collectors → Open** a wallet → **Take cash**, pick the
asset, and confirm. The amount pre-fills from the newest fee rule already in
effect; the server still refuses anything that is not exactly the day's fee.
The form mints a client reference in the browser, so a double submit returns the
same receipt instead of taking the cash twice.

Via the API:

```sh
POST /v1/cash/intakes
Authorization: Bearer <collector token>          # permission: cash:intake
Idempotency-Key: cash-<collector>-<uuid>

{
  "collectorUserId": "<collectorUserId>",
  "clientReference": "cash-<collector>-<uuid>",
  "amountMinor": "20000",
  "currency": "NGN",
  "assetId": "<assetId>"
}
```

A collector may only record their own intake; finance and supervisors may
record on a collector's behalf. What happens inside one transaction:

1. the day is settled exactly as a gateway payment would
   (`Dr COLLECTOR_CASH / Cr ASSET_WALLET`, then the allocation to
   `REVENUE_LEVY`);
2. the intake row is written and, when the wallet crosses the deadline
   window, the receipt SMS is queued through `channels.cashReceiptTemplate`.

Refusals are stable codes: `wallet_frozen` and `already_paid` (409),
`ceiling_exceeded` (409, postpaid), `insufficient_float` (409, prepaid),
`amount_mismatch` (400, wrong fee or currency), `asset_unknown` (404, forged or
unknown sticker), `cash_disabled` (400). Nothing is written when the intake is
refused.

## 3. Match a suspense deposit

A deposit that arrives before the intake it funds — or that is larger than the
open intakes — posts nothing and waits in suspense. Finance matches it by hand:

```sh
POST /v1/cash/deposits/<depositId>/match
Authorization: Bearer <finance token>          # permission: cash:deposit:match

{ "intakeId": "<intakeId>" }
```

The dashboard does the same from the wallet's **Deposits** card: pick a
suspense deposit, pick an open intake, **Match deposit**. The match posts
`Dr SETTLEMENT_BANK / Cr COLLECTOR_CASH` for what the intake still needs and
writes one allocation row. The same call again is a replay (`replayed: true`),
not a second posting. A remainder stays suspense and can be matched later.

Automatic matching needs no operator: a deposit to an active instruction
resolves oldest-open-intake-first by itself. The transfer's identity is the
gateway event, not the reference, so daily deposits to the same destination are
distinct transfers (migration 0013).

## 4. Freeze and unfreeze

Freezing stops the next intake; a day already settled stays settled, and a
deposit still clears the float.

- **Freeze** — `POST /v1/cash/wallets/<collectorUserId>/freeze` with
  `{ "reason": "..." }`, permission `cash:freeze` (supervisor or finance).
- **Unfreeze** — `POST /v1/cash/wallets/<collectorUserId>/unfreeze` with a
  reason, permission `cash:unfreeze` (**finance only**). A supervisor sees the
  button disabled with "Only finance can unfreeze".

The deadline sweeper runs on the worker's schedule. For every cash-enabled
tenant it finds wallets whose oldest open intake is older than
`depositDeadlineHours`, records an audit entry once per deadline window
(`cash.wallet.overdue`), and — when `freezeOnShortfall` is true — freezes the
wallet with the deadline in the reason (`cash.wallet.frozen`). With the flag
off it only flags, and the collector keeps working. A deposit that clears the
open intakes removes `overdue_since`; an unfreeze does not clear a real
shortfall, so the next sweep flags it again.

## 5. Reconcile a wallet by hand

Everything below is read-only SQL against the tenant's database. Replace
`<tenant-id>` and `<collector-id>` (the collector's `users.id`). Amounts are
minor units.

Derived float (what the collector still holds — never stored):

```sql
select sum(case when le.direction = 'debit' then le.amount_minor
                else -le.amount_minor end) as float_minor
from ledger_entries le
join accounts a on a.id = le.account_id
where le.tenant_id = '<tenant-id>'
  and le.collector_user_id = '<collector-id>'
  and a.code = 'COLLECTOR_CASH';
```

Wallet state and open intakes:

```sql
select status, frozen_reason, overdue_since, float_ceiling_minor
from collector_wallets
where tenant_id = '<tenant-id>' and collector_user_id = '<collector-id>';

select id, business_date, receipt_number, amount_minor, status, recorded_at
from cash_intakes
where tenant_id = '<tenant-id>' and collector_user_id = '<collector-id>'
order by recorded_at desc
limit 50;

select coalesce(sum(amount_minor), 0) as open_intake_minor, count(*) as open_intakes
from cash_intakes
where tenant_id = '<tenant-id>' and collector_user_id = '<collector-id>'
  and status = 'open';
```

Deposits and what each one covered:

```sql
select d.id, d.provider, d.provider_reference, d.amount_minor, d.status,
       d.webhook_event_id, d.created_at,
       coalesce(sum(a.amount_minor), 0) as allocated_minor
from cash_deposits d
left join cash_deposit_allocations a on a.deposit_id = d.id
where d.tenant_id = '<tenant-id>' and d.collector_user_id = '<collector-id>'
group by d.id
order by d.created_at desc;
```

The day-close identity a finance user signs off:

```
sum(intakes) − sum(posted deposits) = float held by the collector
```

where "posted" means every deposit that is not `suspense`. A clean day leaves
both sides at zero: nothing open, nothing in suspense.

The whole tenant still balances (this must always return two equal numbers):

```sql
select
  sum(case when direction = 'debit' then amount_minor else 0 end) as debits,
  sum(case when direction = 'credit' then amount_minor else 0 end) as credits
from ledger_entries
where tenant_id = '<tenant-id>';
```

## Troubleshooting

| Symptom                                           | Likely cause and next step                                                                                                                                                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deposit row exists with `status = 'suspense'`     | No open intake covered it, or the amount exceeded them. Match it manually once the intake exists, or check the currency (`deposits` in a foreign currency never post).                                                                   |
| A second deposit from the same collector vanished | It did not: look for two `cash_deposits` rows with the same `provider_reference` and different `webhook_event_id`. One event per transfer is the identity.                                                                               |
| Collector cannot take cash                        | Prepaid: `insufficient_float` — the wallet has no credit left; the collector funds it. Postpaid: `wallet_frozen` (read `frozen_reason`, confirm the deposit, finance unfreezes) or `ceiling_exceeded` (float at the configured ceiling). |
| A top-up does not appear                          | Check `webhook_events` for the delivery and `cash_deposits` for a row whose `provider_reference` is the `VT_…` code. If the terminal has no NUBAN, the collector used a page the business has not enabled.                               |
| A top-up credited the wrong collector             | The terminal code in `metadata.virtual_terminal.code` is the attribution. A code that belongs to no active instruction is ignored, never applied to a payment; find the transfer in Paystack and record it manually.                     |
| `cash.topup.over_cap` in the audit trail          | The transfer exceeded `maxBalanceMinor`. The wallet was credited in full; the excess is visible to finance and no further top-up is needed until it is spent.                                                                            |
| Intake returns `already_paid`                     | The asset's day is already settled (gateway or another collector). Cash must not be credited twice for one day.                                                                                                                          |
| Receipt SMS missing                               | Check `sms_log` for the intake id; delivery is retried by the outbox sweeper. Template comes from `channels.cashReceiptTemplate`.                                                                                                        |

## Demo data

`pnpm db:seed` settles one complete cash day for `alpha.collector`: a wallet, an
active instruction, one intake, one matching deposit, float 0. Use it to walk
through the screen without taking real cash; re-running the seed leaves it
alone once the wallet exists.
