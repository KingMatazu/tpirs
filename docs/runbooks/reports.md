# Runbook: reports

Finance reads six reports over a business-day range and downloads them as CSV,
PDF or XLSX. Reports aggregate the operational tables directly — there is no
reporting projector and no second source of truth — so a report can only show
what the ledger, the scan register and the cash tables already prove.

Background: ADR 0034 (export adapters), ADR 0038 (compliance reporting),
D44 (compliance denominator), D47 (formats and limits), D49 (fee lines, still
open for the pilot). Config lives under `reconciliation`; the reports
themselves take no per-tenant code.

## 1. The six reports

| Key                         | Grain                    | What it shows                                                                |
| --------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `daily_collections`         | one row per business day | Revenue recognised, payments count/total, cash intake count/total, refunds   |
| `collections_by_zone`       | one row per zone         | Revenue and scan outcomes (paid, no-payment, unknown) by zone                |
| `collections_by_asset_type` | one row per asset type   | Revenue, assets by status, scans                                             |
| `collector_positions`       | one row per collector    | Intakes in range, posted deposits, derived float today, overdue open intakes |
| `compliance`                | day × zone × officer     | Paid, no-payment and unknown scans, plus the compliance percentage           |
| `exceptions_summary`        | day × kind × severity    | Open, resolved and waived exceptions, counted                                |

Money crosses the API as **minor-unit strings** (`"20000"` is ₦200.00); counts
are integers, dates are `YYYY-MM-DD` business dates, and every column declares
its `kind` (`money`, `count`, `text`) so a client can format it without
guessing.

## 2. Reading a report

```sh
GET /v1/reports/daily_collections?from=2026-06-15&to=2026-06-15
Authorization: Bearer <finance token>          # permission: report:read
```

```json
{
  "report": {
    "reportKey": "daily_collections",
    "from": "2026-06-15",
    "to": "2026-06-15",
    "generatedAt": "2026-06-16T02:00:05.000Z",
    "columns": [{ "key": "revenueMinor", "header": "revenueMinor", "kind": "money" }],
    "rows": [{ "businessDate": "2026-06-15", "revenueMinor": "20000", "paymentsCount": 1 }],
    "totals": { "revenueMinor": "20000" }
  }
}
```

`totals` carries the sum of each money column the report declares; a report
with nothing to add up omits it. An unknown report key is `404`; a malformed or
inverted range is `400 invalid_range`.

## 3. The compliance rate

```
compliance = paid scans ÷ (paid scans + no_payment_recorded scans)
```

- **The numerator is scans with `authoritative_status = 'paid'`.**
- **`unknown` scans are excluded from the denominator and reported separately.**
  An offline check or an aged cache carries no verdict; letting it dilute the
  rate would silently punish a zone for a phone problem.
- **It is never paid days ÷ registered assets.** Under `pay_per_use` a vehicle
  that does not work owes nothing, so that ratio punishes a fleet for being
  idle and rewards a tenant that registers fewer vehicles. A day with no
  payment is not a compliance failure.

Grouping is by business day, zone and officer. `zone_compliance_drop` anomaly
rules use the same definition against a trailing baseline.

## 4. Ranges, limits and formats

- **One calendar month per call**: at most 31 business days. Wider ranges are
  refused with `400 range_too_large` rather than truncated.
- **100,000 rows per export**; above that the call is refused
  (`result_too_large`) until a queued export exists.
- **Formats**: `csv` (RFC 4180 quoting, minor-unit integers), `pdf` (tenant
  branding and locale) and `xlsx` (one sheet, typed header row). A deployment
  that has not supplied an exporter refuses that format explicitly
  (`400 format_unavailable`).

```sh
GET /v1/reports/compliance/export?from=2026-06-01&to=2026-06-30&format=csv
Authorization: Bearer <finance token>          # permission: report:read
```

The response is the file with its own content type and
`content-disposition: attachment; filename="compliance-2026-06-01-2026-06-30.csv"`.
The dashboard's **Reports** screen renders the table and offers the three
downloads.

## 5. What is deliberately not here

- **No gross/fee/net split yet (D49).** `daily_collections` shows revenue
  recognised, payments total and refunds; gateway fees are visible in the
  ledger (`GATEWAY_FEES`) and in the reconciliation checklist, not as a report
  column. The exact gross-collections / fee / net-receipts column set is to be
  settled with the first finance user during the pilot rather than guessed.
- **No queued or streamed exports** beyond the 100k-row cap.
- **No multi-currency settlement or FX differences.**
- **No zone-scoped supervisor visibility** (D39); a report is tenant-wide.

## 6. Permissions

`report:read` is enough to read and export every report. Finance and auditors
hold it; collectors do not. The reports are read-only, so there is no
`report:run` permission and nothing to audit on a read.

## 7. Troubleshooting

| Symptom                                   | Likely cause and next step                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `400 range_too_large`                     | Range exceeds 31 days; split it or export month by month.                   |
| `404 unknown_report`                      | Key typo; use one of the six keys above.                                    |
| `400 format_unavailable`                  | The deployment has no exporter for that format.                             |
| Compliance looks low in one zone          | Check the unknown count first; then scan outcomes by officer for that day.  |
| A day is missing from `daily_collections` | The report lists every day in range, including empty ones; check the range. |
| Money values look 100× too large          | They are minor units: `"20000"` is 200.00 in a two-decimal currency.        |
