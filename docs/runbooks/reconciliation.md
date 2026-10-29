# Runbook: reconciliation

Every night the worker reconciles the business day that just closed. The run
compares what the platform says happened with what the bank and the field
actually saw, records a checklist and an exception queue, and lets finance sign
the day off. This runbook covers configuring it, importing statements, reading
the checklist, working the queue and signing off.

Background: ADR 0035 (settlement import), ADR 0036 (settlement posting and the
fee leg), ADR 0037 (runs, exceptions and sign-off), ADR 0040 (cron scheduling).
Decisions D41–D48 in `docs/decisions-needed.md`. The plain-language explanation
of the fee leg is in [`docs/Takenotes.md`](../Takenotes.md).

## 1. Configuration

Everything below lives under `reconciliation` in the tenant config and is
validated at load. A typo fails when the config is written, not at 02:00.

| Field                | Meaning                                                              | Default |
| -------------------- | -------------------------------------------------------------------- | ------- |
| `enabled`            | Whether the worker runs the nightly reconciliation at all            | `true`  |
| `schedule`           | Cron in the tenant timezone (numeric five-field form)                | —       |
| `toleranceMinor`     | Whole-day slack for ledger, clearing and float differences           | `0`     |
| `feeToleranceMinor`  | How much of a payment the gateway may keep before it is an exception | `0`     |
| `suspenseAgeingDays` | Suspense older than this raises a warning                            | `7`     |
| `notifyRole`         | Role that sees reconciliation and anomaly alerts                     | —       |
| `anomalyRules`       | Advisory rules; every rule ships disabled                            | `[]`    |
| `settlementImport`   | Where the statement comes from and how its columns map               | omitted |

A statement mapping is per tenant because banks export differently:

```yaml
reconciliation:
  settlementImport:
    provider: "paystack" # the gateway the references belong to
    defaultCurrency: "NGN" # optional; falls back to locale.currency
    columns:
      reference: "reference"
      amount: "amount"
      fee: "fee"
      currency: "currency"
      settledAt: "settled_at"
      description: "narration"
    dateFormat: "YYYY-MM-DD HH:mm:ss"
    amountInMinorUnits: true
    decimalSeparator: "."
```

Omit the section until a statement export exists: reconciliation still runs
against gateway events; it just cannot settle gateway fees from a file.

## 2. Import a statement

```sh
POST /v1/settlements/import
Authorization: Bearer <finance token>          # permission: reconciliation:run
Content-Type: application/json

{
  "filename": "paystack-2026-06-15.csv",
  "content": "reference,amount,fee,currency,settled_at,narration\nref-1,20000,300,NGN,2026-06-15,Settlement\n"
}
```

The response is the import summary:

```json
{
  "outcome": "imported",
  "importId": "…",
  "fileHash": "…",
  "rowCount": 1,
  "rejectedCount": 0,
  "postedCount": 1,
  "unmatchedCount": 0,
  "skipped": []
}
```

What happens to each row:

1. **Identity.** The file hash identifies the statement. Re-uploading the same
   bytes returns `outcome: "duplicate"`, `postedCount: 0` and inserts nothing.
   Overlapping date ranges are safe: rows are also hashed.
2. **Matching.** A row matches exactly one payment carrying the same provider
   reference, in the same currency, in `applied` or `credited` state. Zero or
   several candidates leave it unmatched — the platform never guesses.
3. **Posting.** When the arithmetic works (`payment − bank` is a non-negative
   fee inside `feeToleranceMinor`), one balanced transaction moves the money:

   ```
   Dr SETTLEMENT_BANK    bank amount
   Dr GATEWAY_FEES       payment − bank (leg omitted when zero)
   Cr GATEWAY_CLEARING   payment amount
   ```

   The idempotency key is `settlement:<row id>`, so a replay cannot post twice.

4. **Anything else stays `unmatched`.** `skipped` names the reason:
   `no_unique_payment`, `currency_mismatch`, `over_settlement` or
   `fee_beyond_tolerance`. The reconciliation run raises the exception.

`GET /v1/reconciliation/exceptions` shows the rows that need a human.

## 3. Read the run and its checklist

```sh
GET /v1/reconciliation/runs?from=2026-06-15&to=2026-06-15
Authorization: Bearer <finance token>          # permission: reconciliation:read

GET /v1/reconciliation/runs/<runId>
```

Each run is one attempt at one business day. A checklist line has a check name,
a severity (`blocking`, `warning`, `info`), the subject it measured (a collector,
a settlement row, a provider reference, or the tenant for whole-day checks),
expected/actual amounts or counts, and `withinTolerance`.

| Check                     | Severity | Question it answers                                          |
| ------------------------- | -------- | ------------------------------------------------------------ |
| `settlement_rows_matched` | blocking | Did every statement row of the day settle?                   |
| `settlement_amounts`      | blocking | Did the posting carry what the statement and payment said?   |
| `clearing_balance`        | blocking | Is the gateway still holding money for this tenant?          |
| `ledger_balances`         | blocking | Do the day's debits equal its credits?                       |
| `revenue_recognised`      | blocking | Does revenue equal what was allocated to the day's periods?  |
| `cash_float`              | blocking | Does intakes − deposits equal the derived collector balance? |
| `cash_overdue`            | warning  | Is cash held past the deposit deadline?                      |
| `suspense_ageing`         | warning  | Has suspense been sitting too long?                          |
| `duplicate_references`    | blocking | Did two payments of the day carry one provider reference?    |

Revenue is compared against the amount **allocated** to the day's periods, not
the fee owed: under `pay_per_use` a short payment is a wallet credit that
settles nothing, and a partial allocation is still revenue received.

The open exception queue, not the checklist, is the sign-off gate. They are
built from the same numbers so they cannot disagree.

## 4. Work the exception queue

```sh
GET /v1/reconciliation/exceptions?status=open&severity=blocking
Authorization: Bearer <finance token>          # permission: reconciliation:read
```

An exception is one open condition, carried forward across runs by
`dedupe_key = kind:subjectType:subjectId`; it is not duplicated every day. Its
`firstSeenRunId` and `lastSeenRunId` answer "how long has this been open".

Resolve it when the condition is fixed, waive it when it is accepted as
harmless. Both need a note and the `reconciliation:run` permission, and both are
audited:

```sh
POST /v1/reconciliation/exceptions/<id>/resolve
POST /v1/reconciliation/exceptions/<id>/waive
Authorization: Bearer <finance token>          # permission: reconciliation:run

{ "note": "bank line belongs to another tenant; excluded from this statement" }
```

Typical causes:

- **`settlement_rows_matched`** — a fee beyond tolerance, an over-settlement, a
  lump sum covering several payments, or a statement line for another tenant.
  Resolve by fixing the statement or the mapping; waive only with evidence.
- **`clearing_balance`** — at least one payment has no posted statement row.
  Import the missing statement, then re-run the day.
- **`cash_overdue`** — a collector missed the deposit deadline. This is a
  warning; the cash sweeper may also have frozen the wallet
  (`docs/runbooks/collector-cash.md`).
- **`duplicate_references`** — two payments of the day share one provider
  reference. Investigate before resolving; one may be a provider retry.

## 5. Sign the day off

```sh
POST /v1/reconciliation/runs/<runId>/sign-off
Authorization: Bearer <finance token>          # permission: reconciliation:run

{ "note": "checked against the bank statement" }
```

Sign-off requires a completed run, a note, and **no open blocking exception for
that business day**. Warnings never block. The actor, time and note are stored
on the run and in the audit log; a signed-off run is immutable.

The dashboard's **Reconciliation** screen does the same: pick the day, read the
checklist, clear the queue, sign off.

## 6. Re-running after a late payment

There is no "edit". A late payment or a corrected statement produces a new
attempt:

```sh
GET /v1/reconciliation/runs?from=2026-06-15&to=2026-06-15
# run 1: completed or signed_off
# run 2: run_seq 2, a fresh checklist and exception carry-forward
```

A signed-off run stays exactly as it was; the new run is the current evidence.
The worker enqueues a day again only while its latest attempt is missing or
failed, so a late payment is picked up on the next tick after the statement is
imported.

## 7. The nightly schedule

The worker keeps one timer and, per tenant, computes the first schedule
occurrence after the business day closed. When it has passed and the day has no
completed/running attempt, it enqueues `(tenantId, businessDate)` with that pair
as the dedupe key, then runs reconciliation and evaluates the tenant's enabled
anomaly rules.

- A failed run is recorded as `failed` (with the reason) and retried on the next
  tick; a day is never silently skipped.
- `enabled: false` pauses the schedule without deleting the cron.
- A broken tenant config is reported to telemetry and skipped; it is not guessed
  at.

## 8. Permissions

| Permission            | Who                           | What it allows                               |
| --------------------- | ----------------------------- | -------------------------------------------- |
| `reconciliation:read` | finance, auditor, supervisors | runs, checklist, exceptions, anomalies       |
| `reconciliation:run`  | finance                       | import, sign-off, resolve/waive, acknowledge |
| `report:read`         | finance, auditor              | the reports and their exports                |

An auditor can read everything and change nothing; the API enforces this and
the dashboard hides the controls.

## 9. Troubleshooting

| Symptom                                  | Likely cause and next step                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `409 run_already_signed_off`             | The day is closed; a new attempt is a new `run_seq`, not a second sign-off.              |
| `409 blocking_exceptions` on sign-off    | Read the queue; resolve or waive every blocking row for that business date.              |
| `400 range_too_large` on a report        | Reports cover at most 31 days; split the range.                                          |
| `clearing_balance` never reaches zero    | Import the missing statement rows; check `skipped` reasons on the import.                |
| Every row `fee_beyond_tolerance`         | The tenant's `feeToleranceMinor` is too low, or the mapping reads the wrong fee.         |
| Rows unmatched with `no_unique_payment`  | Wrong `provider` or reference column in the mapping, or the payment is still `suspense`. |
| A day has no run after the schedule time | Check `enabled`, the cron and the tenant timezone; check worker telemetry.               |
