# ADR 0038: Compliance reporting from scan results

## Status

Accepted

## Context

The brief is unusually specific about this number: under `pay_per_use`,
compliance is **paid scans divided by total scans**, never paid days divided by
registered assets, "because idle vehicles legitimately owe nothing".

The data exists. Phase 6 writes a `scans` row for every officer check, carrying
`observed_status` (what the officer's screen showed), `authoritative_status`
(what the server recomputed), `business_date`, `zone_id` (snapshotted from the
asset at scan time) and `officer_user_id`. Phase 4 and 7 write `payments` and
ledger entries.

Two questions remained: what to do with `unknown` scans, and what a "zone" means
when an asset is reassigned.

## Decision

- **The numerator is `authoritative_status = 'paid'` scans.** The server's
  recomputed status, not the officer's offline observation: an offline screen can
  only say "not in my list", so counting observations would punish officers for
  working without signal.
- **`unknown` is excluded from the denominator and reported in its own column.**
  A rate is `paid ÷ (paid + no_payment_recorded)`. `unknown` means the platform
  could not determine a status (a lookup failure, a suspended asset at the edges
  of the rules), so folding it into either side would misreport either the
  driver or the platform.
- **A rate with an empty denominator is omitted, not shown as 0%.** A zone with
  no scans is not zero-compliant; it is unmeasured.
- **Grouping is by business day, zone, officer and asset type**, each available
  as its own report. Date ranges are business days in the tenant timezone.
- **The zone is the one snapshotted on the scan.** Reassigning an asset later
  does not rewrite a month of history, and a zone report answers "what happened
  in this park", which is the question a zone supervisor asks.
- **Reports read the operational tables directly.** There is no reporting
  projector and no second copy of the data: the queries aggregate `scans`,
  `payments`, `ledger_entries`, `cash_intakes`, `cash_deposits` and the
  reconciliation tables, and the column set is declared next to the query.
- **Exports go through `ExportService`** (ADR 0034), so CSV, PDF and XLSX support
  is an adapter concern, with a cap of 100k rows or one month per request.
- **"No payments for this asset" is never a compliance signal.** It does not
  appear as a row, a flag or an anomaly. Idle assets are absent from the
  numerator and denominator alike, exactly as `pay_per_use` intends.

## Consequences

- A state can be told "of the vehicles our officers checked in Zone 4 last month,
  78% showed a payment for that day, and 2% could not be determined", which is a
  defensible statement. "60% of registered vehicles paid" would not be.
- The rate moves with enforcement effort as well as with payment behaviour:
  scanning more vehicles in a non-paying area lowers the rate. That is honest —
  it measures what officers saw — and the accompanying scan-volume columns make
  the effect visible.
- Because `unknown` is reported rather than absorbed, a broken lookup path shows
  up as a data-quality metric instead of a slow drift in the headline number.
- Adding a report is a query plus a column list; nothing needs to be projected or
  backfilled, so a new report is available for historical data immediately.
- Direct queries cost the operational tables some load. At pilot volume that is
  an index question, not an architecture one; if a report becomes expensive the
  fix is a materialised view, not a second source of truth.

## Alternatives considered

- **Paid days ÷ registered assets** — rejected by the brief and by arithmetic: it
  penalises a fleet for being idle and rewards a tenant for registering fewer
  vehicles.
- **Counting `observed_status`** — rejected: offline observations are "paid" or
  "not in my list", so the number would measure connectivity, not compliance.
- **Treating `unknown` as non-compliant** — rejected: it blames the driver for a
  platform lookup failure and creates exactly the false accusation the product is
  built to avoid.
- **A nightly reporting projector** — rejected: it would need backfills,
  reconciliation against the source tables, and a story for late-arriving scans,
  for a dataset that fits comfortably in a query.
- **Using the asset's current zone** — rejected: a reassignment would silently
  rewrite history and let a supervisor inherit or lose another zone's numbers.
