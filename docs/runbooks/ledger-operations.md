# Runbook: ledger operations

Day-to-day questions about the money in the platform: where a balance comes
from, how to check that a transaction is sound, and how to correct one.

The ledger is append-only. Nothing in it is ever updated or deleted, and the
database enforces that (ADR 0012). Every "correction" is a new transaction.

## The accounts

| Code               | Class     | What it holds                                             |
| ------------------ | --------- | --------------------------------------------------------- |
| `ASSET_WALLET`     | liability | Credit a driver has paid that no obligation period claims |
| `REVENUE_LEVY`     | revenue   | Levy revenue that has been recognised by an allocation    |
| `GATEWAY_CLEARING` | asset     | Money the payment gateway owes us                         |
| `SETTLEMENT_BANK`  | asset     | Money that has reached the bank account                   |
| `SUSPENSE`         | liability | Money that arrived but could not be attributed            |
| `COLLECTOR_CASH`   | asset     | Residual cash held by a park collector                    |

A balance is **derived**, never stored: credits minus debits over the
entries. A positive `ASSET_WALLET` balance is money the platform holds on a
driver's behalf. A positive `REVENUE_LEVY` balance is revenue that has been
recognised.

Money moves in two steps (ADR 0010):

1. a payment posts `GATEWAY_CLEARING debit → ASSET_WALLET credit`;
2. an allocation posts `ASSET_WALLET debit → REVENUE_LEVY credit` per period.

So a wallet balance is "paid but not yet allocated", and the difference
between what was paid and what was allocated is always visible.

## Check a balance

Run against the tenant's database. `tenant_id` is the tenant's id:

```sql
select a.code,
       sum(case when le.direction = 'credit' then le.amount_minor
                else -le.amount_minor end) as balance_minor
from ledger_entries le
join accounts a on a.id = le.account_id
where le.tenant_id = '<tenant-id>'
group by a.code
order by a.code;
```

Per asset (the driver you are asking about):

```sql
select a.code,
       sum(case when le.direction = 'credit' then le.amount_minor
                else -le.amount_minor end) as balance_minor
from ledger_entries le
join accounts a on a.id = le.account_id
where le.tenant_id = '<tenant-id>'
  and le.asset_id = '<asset-id>'
group by a.code
order by a.code;
```

Amounts are in **minor units** of the account currency (kobo, pesewas, cents).
`20000` with currency `NGN` is ₦200.00.

## Check that a transaction is sound

Every committed transaction is balanced, has at least two entries, and uses a
single currency. The database asserts this at commit, so an existing
transaction is sound by construction. To confirm for one transaction:

```sql
select t.id, t.source_type, t.source_id, t.posted_at,
       count(le.id) as entries,
       count(distinct le.currency) as currencies,
       sum(case when le.direction = 'debit' then le.amount_minor else 0 end) as debits,
       sum(case when le.direction = 'credit' then le.amount_minor else 0 end) as credits
from transactions t
join ledger_entries le on le.transaction_id = t.id
where t.id = '<transaction-id>'
group by t.id, t.source_type, t.source_id, t.posted_at;
```

`entries` must be at least 2, `currencies` must be 1, and `debits` must equal
`credits`.

## Check an asset's obligations

```sql
select period_key, business_date, status, amount_minor, amount_paid_minor,
       currency, fee_rule_key, fee_amount_snapshot_minor
from obligation_periods
where tenant_id = '<tenant-id>' and asset_id = '<asset-id>'
order by business_date;
```

`fee_rule_key` and `fee_amount_snapshot_minor` are the price that applied
when the period was settled, so a later fee change never rewrites history.

Under `pay_per_use` a day with no payment has **no row at all**. That is not a
debt and not an anomaly: the vehicle simply was not used for work. Only a
`scheduled` tenant accumulates rows for days that were not paid.

## Correct a transaction (reverse it)

Reversal needs two people: a requester and a different approver with finance
approval. The system admin cannot touch ledger data.

1. **Request.** `LedgerService.requestReversal(tenantId, { originalTransactionId, reason, requestedByUserId })`
   creates a `reversal_requests` row with status `pending`. No money moves.
2. **Approve.** `LedgerService.approveReversal(tenantId, { reversalRequestId, approverUserId, hasFinanceApproval: true })`
   posts the mirrored entries and marks the request approved **in the same
   transaction**. The mirrored entries flip the direction of every original
   entry, so the pair nets to zero for every account.

The reversing transaction has `source_type = 'reversal'` and `source_id` set
to the original transaction id, so the pair is traceable in both directions.
The approval is idempotent on `reversal:{request-id}`: approving twice cannot
post twice.

To find requests waiting for approval:

```sql
select id, original_transaction_id, reason, requested_by_user_id, created_at
from reversal_requests
where tenant_id = '<tenant-id>' and status = 'pending'
order by created_at;
```

Never fix a wrong entry by updating or deleting it. The append-only trigger
rejects it, and the application role has no `UPDATE` or `DELETE` privilege on
`transactions` or `ledger_entries`.

## When a posting is rejected

| Message                                             | Meaning                                                      |
| --------------------------------------------------- | ------------------------------------------------------------ |
| `ledger entries and transactions are append-only`   | Someone tried to edit history. Reverse it instead.           |
| `ledger transaction ... is not balanced`            | Debits and credits differ. The posting never committed.      |
| `ledger transaction ... needs at least two entries` | A single-sided posting. Every transaction has two sides.     |
| `ledger transaction ... mixes N currencies`         | A transaction used more than one currency.                   |
| `ledger entry currency must match account currency` | The entry currency differs from the account currency.        |
| `permission denied for table ledger_entries`        | The application role tried to update or delete. Use the API. |
| `obligation period is paid for more than it owes`   | A period was marked paid for more than its amount.           |

A rejected posting leaves no partial rows: the whole transaction rolls back.

## Related

- ADR 0010 — the ledger posting model and wallet-first crediting
- ADR 0012 — immutability and the deferred balance constraint
- ADR 0013 — reversal by mirrored entries with dual approval
- ADR 0015 — why money is `bigint` and business dates are strings
