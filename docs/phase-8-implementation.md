# Phase 8 implementation: reconciliation, reporting, anomaly detection

This document is the working plan for Phase 8 of `AGENTS.md`. It covers the
nightly reconciliation runs, the settlement import that feeds them, the
exceptions queue and its tolerances, the finance reports and their exports, the
configurable anomaly rules, and the auditor's read-only view.

Phase 7 is delivered and committed. Phase 8 builds on three things that already
exist: the ledger's derived balances (ADR 0010/0031), the scan register written
by the field app (`scans.authoritative_status`), and the collector cash
identity `intake − posted deposits = derived float` proven by the Phase 7
day-close test. It adds no new money mechanics except the settlement posting
described below, and it deliberately reuses the Phase 7 cash checks rather than
inventing a second definition of "the float is wrong".

## Scope decisions carried into this phase

- **Reconciliation compares; it never invents money.** A run is per tenant per
  business day (tenant timezone), append-only and idempotent. A completed run is
  immutable. A later re-run is a new `run_seq`, so a late payment produces
  evidence, not an edit. Sign-off is the only transition a run allows.
- **Settlement import is a separate port (D21).** A bank-statement CSV has no
  signature, no provider event id and no intent lifecycle, so it cannot honestly
  implement `PaymentProvider`. `SettlementImport` feeds reconciliation only.
  Idempotency is a file hash plus a row hash, so re-uploading the same statement
  or overlapping date ranges cannot double count.
- **A matched settlement posts, and it posts the fee leg.** Gateway money
  currently sits in `GATEWAY_CLEARING` forever, so a matched statement row must
  move it. Because gateways settle net of fees, the posting (idempotent on the
  settlement row id) is:

  ```
  Dr SETTLEMENT_BANK    bank amount
  Dr GATEWAY_FEES       payment amount - bank amount
  Cr GATEWAY_CLEARING   payment amount
  ```

  It posts only when the difference is within
  `reconciliation.feeToleranceMinor`. Anything else posts nothing and becomes an
  exception. The plain-language explanation of this rule, its v1 limits and a
  worked example live in [`docs/Takenotes.md`](./Takenotes.md).

- **Compliance rate is `paid scans ÷ total scans`.** The numerator is
  `scans.authoritative_status = 'paid'`; the denominator excludes `unknown`,
  which is reported separately rather than allowed to depress the rate silently.
  Grouping is by business day, zone, officer and asset type. It is never
  paid-days ÷ registered assets: under `pay_per_use` an idle vehicle owes
  nothing.
- **A vehicle with no payments is never an anomaly.** No rule keys on an idle
  asset. Anomalies look at collectors, zones and officers deviating from their
  own trailing baseline, which is what the build brief asks for.
- **Reports read existing tables.** No reporting projector and no second source
  of truth; the report queries aggregate `payments`, `ledger_entries`,
  `cash_intakes`, `cash_deposits`, `scans` and `reconciliation_*`. Exports go
  through `ExportService`, so a new format is an adapter, not a route change.
- **Alerts are persisted and audited, not texted.** `notifyRole` selects who
  sees an alert; the persisted `anomaly_events` row plus the audit entry are the
  v1 delivery, matching the D40 precedent. A staff SMS channel arrives with a
  channel that can receive it.
- **Config, not code.** Tolerances, schedule, anomaly rules, statement column
  mapping and fee tolerance all come from tenant config and are validated at
  startup. No tenant literals, no bank formats, no currency or timezone in core.
- **This phase ships the minimum admin surface acceptance needs.** Two pages —
  reconciliation (runs, checklist, exception queue, sign-off) and reports
  (range, table, download). Phase 9 owns the polished dashboard; these pages
  exist so a finance user can actually sign off rather than only in a test.

## Preconditions

- Phases 0–7 green: `pnpm lint`, `pnpm typecheck`, `pnpm test`,
  `scripts/ci/integration.sh`, `scripts/ci/migration-check.sh`.
- Migration 0013 applied (deposit identity is the webhook event).
- Decisions D41–D48 recorded in `docs/decisions-needed.md`; ADRs 0034–0039
  written before the code they describe lands.
- Three new dependencies accepted with ADRs (see below).

## Dependencies and ADRs

A dependency is only added with the alternatives recorded (build brief rule).
`pnpm 11` blocks postinstall scripts, so each package must work without one or
be added to `allowBuilds` with a note.

| Need              | Choice                                                                                                                                   | Alternatives considered                             | ADR  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---- |
| Cron schedule     | `cron-parser` — computes the next occurrence, timezone-aware; the worker keeps its own timer and does not hand scheduling to the library | `croner`; hand-rolled `HH:MM` reader; fixed polling | 0036 |
| PDF export        | `pdf-lib` — pure JS, no native build, no postinstall                                                                                     | `pdfkit`; headless browser                          | 0034 |
| XLSX export       | `exceljs` — MIT, no native build                                                                                                         | SheetJS community edition; hand-rolled OOXML        | 0035 |
| CSV export        | none — the format is a line writer                                                                                                       | a CSV library                                       | 0034 |
| Settlement import | none — CSV parsing with a configured column map                                                                                          | full CSV library                                    | 0037 |

## Data model (migration 0014)

All tables carry `tenant_id`, are covered by row-level security, and get
composite indexes. Money is `bigint` minor units; times are UTC timestamps;
business days are `date` in the tenant's timezone.

- **`settlement_imports`** — `id`, `tenant_id`, `provider`,
  `source ('statement' | 'api')`, `filename`, `file_hash`, `period_start`,
  `period_end`, `row_count`, `imported_by_user_id`, `imported_at`, `status`.
  `unique (tenant_id, provider, file_hash)` makes a re-upload a no-op.
- **`settlement_rows`** — `id`, `tenant_id`, `import_id`, `row_hash`,
  `provider_reference`, `amount_minor`, `currency`, `fee_minor`, `settled_at`,
  `payment_id` (null until matched), `transaction_id` (null until posted),
  `status ('unmatched' | 'matched' | 'posted' | 'excluded')`.
  `unique (tenant_id, import_id, row_hash)` plus a plain index on
  `(tenant_id, provider_reference)` for matching.
- **`reconciliation_runs`** — `id`, `tenant_id`, `business_date`, `run_seq`,
  `status ('running' | 'completed' | 'failed' | 'signed_off')`, `checklist`
  (JSONB: per-check expected/actual/difference/within-tolerance),
  `tolerance_snapshot`, `fee_tolerance_snapshot`, `exception_count`,
  `started_at`, `completed_at`, `signed_off_by_user_id`, `signed_off_at`,
  `sign_off_note`. `unique (tenant_id, business_date, run_seq)`. No update or
  delete except the sign-off columns (rejecting trigger for the rest).
- **`reconciliation_exceptions`** — `id`, `tenant_id`, `run_id`,
  `dedupe_key` (kind + subject, stable across runs), `kind`, `severity`
  (`blocking` / `warning` / `info`), `subject_type`, `subject_id`,
  `expected_minor`, `actual_minor`, `difference_minor`, `currency`,
  `business_date`, `detail` (JSONB), `first_seen_run_id`, `last_seen_run_id`,
  `status` (`open` / `resolved` / `waived`), `resolution_note`,
  `resolved_by_user_id`, `resolved_at`. Unresolved exceptions are carried into
  the next run by `dedupe_key` rather than duplicated.
- **`anomaly_events`** — `id`, `tenant_id`, `rule_key`, `subject_type`,
  `subject_id`, `window_start`, `window_end`, `observed`, `baseline`,
  `threshold`, `severity`, `detail`, `status` (`open` / `acknowledged`),
  `acknowledged_by_user_id`, `acknowledged_at`. A unique key on `(tenant_id,
rule_key, subject_type, subject_id, window_end)` dedupes repeat runs.
- **`GATEWAY_FEES` account.** A new `gateway_fees` value on the
  `account_type` enum, added to `STANDARD_ACCOUNTS` in
  `packages/db/src/repositories/ledger.ts` (class `expense`), so
  `ensureStandardAccounts` provisions it for every tenant. Existing tenants get
  it on their next account ensure / migration backfill.

`down()` restores the prior state: drop the five tables in reverse dependency
order, delete rows that reference `gateway_fees` (there are none on a fresh
migration check), then rebuild the enum without the new value — Postgres cannot
drop a single enum value, so the down migration recreates the type and rewrites
the `accounts.account_type` column.

## Reconciliation checks

Each run produces one checklist item per check and, where a difference is
outside tolerance, one exception per subject. Checks are computed in SQL where
the data is large, and compared in pure domain functions so tolerance and
severity have one implementation.

| Check                     | Compares                                                               | Subject         | Blocks sign-off                  |
| ------------------------- | ---------------------------------------------------------------------- | --------------- | -------------------------------- |
| `settlement_rows_matched` | Every settlement row has a payment                                     | provider row    | yes, if unmatched row amount > 0 |
| `settlement_amounts`      | Settlement row amount vs payment amount, within `feeToleranceMinor`    | provider row    | yes                              |
| `clearing_balance`        | `GATEWAY_CLEARING` balance is 0 within `toleranceMinor` after postings | provider        | yes                              |
| `ledger_balances`         | Debits = credits for the business day                                  | tenant          | yes                              |
| `revenue_recognised`      | `REVENUE_LEVY` credits = paid obligation amounts for the day           | tenant          | yes                              |
| `cash_float`              | Per collector: intakes − posted deposits = derived `COLLECTOR_CASH`    | collector       | yes                              |
| `cash_overdue`            | Open intakes older than `depositDeadlineHours`                         | collector       | no (warning)                     |
| `suspense_ageing`         | Payments/deposits in suspense older than the config window             | payment/deposit | no (warning)                     |
| `duplicate_references`    | Same provider reference on two payments                                | payment         | yes                              |

Cash checks reuse Phase 7's derived-balance rule, so "the float is wrong" has
one definition. `cash_overdue` mirrors the sweeper's finding rather than
freezing again: reconciliation records, the sweeper acts.

## Settlement posting

A settlement row is matched to a payment by `provider_reference` inside the
tenant. Matching is not posting. A row posts only when:

1. exactly one payment matches the reference;
2. the row currency equals the tenant currency;
3. the difference between the payment amount and the bank amount is
   non-negative or zero (the bank never receives more than was charged) and
   within `reconciliation.feeToleranceMinor`;
4. the row has not posted before (idempotent on `settlement_rows.id`).

The posting is one balanced transaction:

```
Dr SETTLEMENT_BANK   bank amount
Dr GATEWAY_FEES      difference (may be zero)
Cr GATEWAY_CLEARING  payment amount
```

with `source_type = 'settlement'`, `source_id = settlement_rows.id`, and
idempotency key `settlement:<row id>`. Paying more than was charged
(over-settlement) never posts: it stays an exception with the surplus visible,
exactly like a Phase 7 over-deposit staying in suspense. A lump-sum statement
line that covers many payments is also an exception in v1; splitting it is a
finance decision, not an automatic one.

## Report catalogue

All reports take a business-day range and return rows plus a total. Money is a
minor-unit string on the wire, with the currency named once per report.

| Key                         | Rows                     | Contents                                                       |
| --------------------------- | ------------------------ | -------------------------------------------------------------- |
| `daily-collections`         | one per business day     | levy revenue, payments, cash intake, refunds                   |
| `collections-by-zone`       | one per zone             | revenue, scans, compliance rate                                |
| `collections-by-asset-type` | one per asset type       | revenue, active assets, scans                                  |
| `collector-position`        | one per collector        | intakes, posted deposits, float, overdue intakes               |
| `compliance-rate`           | one per day/zone/officer | paid scans, no-payment scans, unknown (excluded from the rate) |
| `exceptions-summary`        | one per run/day          | open, resolved, waived by severity and kind                    |

Exports go through `ExportService` with columns declared by the report. The
route streams the bytes as an attachment; the filename carries the report key
and range. A single export is capped at 100,000 rows or one calendar month;
larger ranges are refused with a `range_too_large` error until a queued export
exists (Phase 10 if load tests demand it). PDF uses the tenant's branding from
config (app name, header, footer) and the tenant locale for dates and money;
XLSX carries one sheet per report with a header row and typed cells; CSV uses
RFC 4180 quoting and minor-unit integers.

## Anomaly rules

Rules are pure functions over a trailing window (default 14 days), evaluated
after each reconciliation run. Every rule is off in `tenants/_template` until a
tenant has enough history and opts in; the decision is recorded, because a
noisy alert queue is worse than none.

| Rule key                     | Subject   | Fires when                                                                 | Default |
| ---------------------------- | --------- | -------------------------------------------------------------------------- | ------- |
| `collector_volume_drop`      | collector | intake volume falls more than `thresholdPercent` below the trailing mean   | off     |
| `collector_deposit_lag`      | collector | an intake stays open longer than the configured multiple of the deadline   | off     |
| `zone_compliance_drop`       | zone      | compliance rate falls more than `thresholdPercent` below its trailing mean | off     |
| `officer_scan_volume_change` | officer   | scan volume moves more than `thresholdPercent` from the trailing mean      | off     |
| `suspense_growth`            | tenant    | suspense total grows beyond the configured ceiling                         | off     |

No rule reads a single asset's payment history. The absence of payments for a
vehicle is not an event; the test suite asserts that explicitly.

## Step 0: Plan, decisions and ADRs

- Record D41–D48 in `docs/decisions-needed.md` with the proposed answers below.
- ADRs 0034–0039 (export adapters, settlement import, reconciliation runs,
  compliance reporting, anomaly rules, cron scheduling). Follow the existing
  short format: context, decision, consequences, alternatives.
- This file is the plan; keep it current as decisions land.
- Commit: `docs: phase 8 plan and decisions`.

| Decision | Proposed answer                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| D41      | Runs are versioned and append-only; sign-off is the only transition; a re-run after sign-off creates a new version                       |
| D42      | Statement identity is file hash + row hash; matching is by provider reference inside the tenant                                          |
| D43      | Exceptions have `open/resolved/waived`; resolution needs `reconciliation:run` and a note; unresolved items carry forward by `dedupe_key` |
| D44      | Compliance denominator excludes `unknown`, reported separately                                                                           |
| D45      | Fee difference posts to `GATEWAY_FEES` within `feeToleranceMinor`; anything else is an exception                                         |
| D46      | Anomaly rules are config-driven, off by default, deduped per window, delivered as persisted events + audit                               |
| D47      | Exports are synchronous with a 100k-row / one-month cap; CSV, PDF, XLSX                                                                  |
| D48      | The worker computes the next run from the config cron expression with `cron-parser`; the timer interval is the check cadence             |

## Step 1: Ports, contracts and export adapters

- `packages/ports/src/settlement-import.ts`: declared capabilities (accepted
  formats, required columns), a `parse` entry point returning normalized rows
  and the file hash. Export from `index.ts`.
- `packages/contracts/src/settlement-import.ts`: shared suite (hash determinism,
  duplicate rows, unknown columns, malformed amounts/dates, currency). Register
  it in the harness.
- `packages/adapters/settlement-import/mock` and `.../csv`. The CSV adapter reads
  the column mapping from tenant config; no bank format lives in core.
- `packages/adapters/export-service/{csv,pdf,xlsx}` with package names
  `@tpirs/export-service-csv`, `-pdf`, `-xlsx`. The existing mock stays for
  tests. All four pass the `ExportService` conformance suite; CSV is parsed
  back, XLSX is re-opened with `exceljs`, PDF is checked for a valid structure
  and the expected text.
- Commit: `feat(adapters): settlement import and export adapters`.

## Step 2: Schema and migration 0014

- The five tables above, the `gateway_fees` enum value, and the standard
  account. RLS policies, tenant indexes, immutability triggers on runs, and a
  rejecting trigger on the settlement-object columns.
- `down()` reversible on an empty database; `pnpm ci:migration-check` is part of
  the gates.
- Repository methods: `settlementImports.record/findByHash`,
  `settlements.listUnmatched/listForRange/markPosted`,
  `reconciliation.createRun/completeRun/signOff/findLatest`,
  `exceptions.upsertForRun/list/resolve`,
  `anomalies.record/list/acknowledge`.
- Tests: cross-tenant isolation, duplicate file/row hashes, run immutability,
  sign-off idempotence.
- Commit: `feat(db): reconciliation, settlement and anomaly tables`.

## Step 3: Domain rules

- `packages/domain/src/reconciliation.ts`: tolerance comparison
  (inclusive boundary), difference classification, severity, checklist
  assembly, fee-split arithmetic (bank + fee = payment; never negative).
- `packages/domain/src/anomaly.ts`: trailing-baseline evaluation, percentage
  and absolute thresholds, window boundaries in the tenant timezone, dedupe key.
- Property tests: debits equal credits per day; tolerance boundary; bank + fee
  equals payment; idle asset never produces an anomaly.
- Commit: `feat(domain): reconciliation and anomaly rules`.

## Step 4: Application services

- `SettlementImportService`: hash, dedupe, normalize, match, post matched rows
  with the fee leg, mark unmatched rows `unmatched`, write the import summary.
- `ReconciliationService`: open a run, compute the checklist, carry forward
  open exceptions, complete, and sign off (permission + note + audit). A
  signed-off run is immutable; re-running creates `run_seq + 1`.
- `ExceptionService`: resolve/waive with a required note, permission and audit.
- `AnomalyService`: evaluate configured rules for a run window, record deduped
  events, emit telemetry.
- `ReportService`: the six report queries, row caps, column definitions, and
  export through the injected `ExportService` registry (format → adapter).
- Postgres-backed tests per service: late payment → new run version; duplicate
  upload posts nothing; over-settlement and lump sum become exceptions;
  signed-off run refuses mutation; auditor cannot resolve.
- Commit: `feat(application): reconciliation and reporting services`.

## Step 5: Config

- `reconciliation`: add `feeToleranceMinor`, `suspenseAgeingDays`, and
  `anomalyRules[]` (`key`, `enabled`, `windowDays`, `thresholdPercent`,
  `thresholdMinor`, `severity`); add `settlementImport` (`provider`,
  `columns` mapping, `dateFormat`, `amountInMinorUnits`).
- Validate every path with a precise error; unknown cron expressions fail at
  load, not at 02:00.
- Update `tenants/_template/tenant.config.yaml`, `packages/config` tests and the
  admin test fixture; every new key documented next to its default.
- Commit: `feat(config): reconciliation tolerances, anomaly rules and statement mapping`.

## Step 6: Worker scheduling

- Add `cron-parser` behind a small `nextOccurrence(schedule, after, timeZone)`
  helper so the library is replaceable in one file.
- Register a `reconciliation:run` job handler and a per-tenant schedule check:
  on each tick, if the next occurrence has passed and the business day has no
  completed run, enqueue `(tenantId, businessDate)`. The idempotency key is the
  pair, so two workers cannot double-run.
- After a completed run, evaluate anomaly rules. Failures are telemetry and a
  `failed` run, never a silently skipped day.
- Tests with an injected clock and queue: schedule fires once, disabled
  schedule does nothing, restart mid-day does not re-run, a failed run is
  retried on the next tick.
- Commit: `feat(worker): nightly reconciliation and anomaly evaluation`.

## Step 7: API, contract and permissions

- Routes:
  - `POST /v1/settlements/import` (`reconciliation:run`)
  - `GET /v1/reconciliation/runs`, `GET /v1/reconciliation/runs/:id`
  - `POST /v1/reconciliation/runs/:id/sign-off` (`reconciliation:run`)
  - `GET /v1/reconciliation/exceptions`
  - `POST /v1/reconciliation/exceptions/:id/resolve|waive` (`reconciliation:run`)
  - `GET /v1/reports/:key`, `GET /v1/reports/:key/export` (`report:read`)
  - `GET /v1/anomalies`, `POST /v1/anomalies/:id/acknowledge` (`reconciliation:read` /
    `reconciliation:run`)
- Fastify route generics and JSON schemas; regenerate the client with
  `pnpm --filter @tpirs/api build` then `pnpm --filter @tpirs/api-client build`.
- Negative tests: auditor can read but not run, resolve, import or sign off;
  collector gets 403; cross-tenant run/exception is 404; a bad range or format
  is 400; an over-cap export is 400 `range_too_large`.
- Commit: `feat(api): reconciliation, settlement import and report routes`.

## Step 8: Minimal admin surface

- `ReconciliationPage`: run list with status and checklist, exception queue with
  severity filters, resolve/waive (reason required), sign-off (reason required).
- `ReportsPage`: report picker, business-day range, rendered table, download
  CSV/PDF/XLSX.
- Nav entries gated on `reconciliation:read` and `report:read`; follow the
  `CollectorsPage` conventions (fixture config, `cleanup()` in `afterEach`,
  `stubRelativeRequests()` + stubbed fetch, primitive zustand selectors).
- Tests: permission states, checklist rendering, sign-off body, export request
  and download filename, auditor sees no mutation controls. Phase 9 polishes
  layout and adds the remaining dashboard screens.
- Commit: `feat(admin): reconciliation and reports screens`.

## Step 9: Acceptance — a simulated month

- Shared fixture `packages/application/src/test-support/month.ts`: a tenant with
  one zone tree, 20+ assets, and 30 business days of deterministic activity —
  gateway payments (some underpaid into the wallet), cash intakes and deposits,
  field scans with `paid` and `no_payment_recorded`, and statement rows carrying
  gross, fee and bank amount.
- Run reconciliation for every day: all runs complete, no blocking exception,
  `GATEWAY_CLEARING` is 0, revenue equals the expected levy, cash closes to
  zero, and the compliance report equals paid scans ÷ known scans for each zone.
- Finance signs off the month: every run carries the actor and note, the audit
  trail lists them, and a re-run after sign-off creates a new version instead of
  editing history.
- Discrepancy scenario: a missing statement row, a fee beyond tolerance, an
  over-settlement, a duplicate statement upload, an overdue collector and a
  zone compliance drop. Assert the exact exception kinds/severities, that the
  tolerance boundary passes, that the duplicate upload posts and records
  nothing, and that no idle asset raises an anomaly.
- Commit: `test(reconciliation): simulated month reconciles and is signed off`.

## Step 10: Documentation

- `docs/runbooks/reconciliation.md`: importing a statement, mapping columns,
  posting and fee policy, reading the checklist, working the exception queue,
  sign-off, and re-running after a late payment.
- `docs/runbooks/reports.md`: report definitions, compliance-rate caveat
  (`unknown` excluded), export limits and formats.
- `docs/Takenotes.md`: the fee leg explained without jargon (already written).
- ADR index, `README.md` and `AGENTS.md` phase state (Phase 8 delivered,
  Phase 9 next).
- Commit: `docs(reconciliation): runbooks and phase 8 delivery notes`.

## Step 11: Gates

In order: `pnpm format` → `pnpm lint` → `pnpm typecheck` → `pnpm test`, then
`sh scripts/ci/integration.sh` and `sh scripts/ci/migration-check.sh` (both need
Docker). Push only when all five are green; one red package blocks the pre-push
hook for the whole repo.

## Acceptance mapping

| `AGENTS.md` acceptance check                                                            | Where it is proven                                                    |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Nightly reconciliation jobs, exceptions queue, tolerances                               | Step 4 service tests + Step 6 worker tests + Step 9 month             |
| Reports by day, zone, collector, asset type and compliance rate through `ExportService` | Step 1 export conformance, Step 4 report tests, Step 8 page, Step 9   |
| Compliance rate from scans, never paid days ÷ assets                                    | Step 4 `compliance-rate` query + Step 3/9 property and month tests    |
| Configurable anomaly rules and alerts; auditor read-only                                | Step 5 config, Step 3/4 rules, Step 7 403 tests, Step 9               |
| A full simulated month reconciles and is signed off by a test finance user              | Step 9                                                                |
| Money is append-only and auditable                                                      | Step 2 triggers, Step 4 audit entries, Step 9 re-run versioning       |
| No tenant literals                                                                      | Step 5 config/template work; grep for currency, timezone, bank format |

## Deferred items

- Queued/streamed exports beyond the 100k-row cap.
- Provider settlement feeds where the adapter cannot yet declare
  `supportsSettlementFetch` (Paystack sandbox checks in
  `docs/decisions-needed.md` remain open).
- Multi-currency settlement and FX differences.
- Automatic splitting of lump-sum statement lines.
- A staff SMS/email channel for anomaly and exception notices (D40 precedent).
- Zone-scoped supervisor visibility for collections (D39).
- Anomaly tuning against real pilot data; all rules ship disabled.
- Archiving of old reconciliation runs under `compliance.retentionDays`.
