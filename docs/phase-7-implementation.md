# Phase 7 implementation: collector cash wallet

This document is the working plan for Phase 7 of `AGENTS.md`. It covers the
collector wallet, the float ceiling, cash intake against an asset, dedicated
deposit instructions, deposit matching, the deadline sweeper, and freeze /
unfreeze.

Phase 6 is delivered and committed. The Phase 4 settlement path already posts
`Dr GATEWAY_CLEARING / Cr ASSET_WALLET` and then allocates wallet credit to
revenue via `ObligationService.ensurePaidForBusinessDay`; Phase 7 does not
duplicate that machinery. Cash changes only the funding account of the first
posting, which is why this phase is mostly schema, attribution and UI work
rather than new accounting.

## Scope decisions carried into this phase

- **Cash settles a day through the existing settlement path.** The only change
  to `ensurePaidForBusinessDay` is an optional `fundingAccount` (default
  `GATEWAY_CLEARING`) and an optional `collectorUserId` carried onto the ledger
  entries. One allocation engine, one revenue-recognition rule, one
  idempotency story. Phases 4–6 behaviour is byte-identical when the new
  parameters are omitted.
- **Wallet balance is derived, never stored.** `COLLECTOR_CASH` ledger entries
  filtered by `collector_user_id` are the balance. `collector_wallets` holds
  only state and settings (status, freeze facts, an optional per-collector
  ceiling override). This is the rule already stated in
  `packages/db/src/repositories/ledger.ts` for every wallet.
- **Deposit attribution is a dedicated provider reference, resolved before
  asset attribution.** A new `collector_deposit_instructions` table maps
  `(tenant, provider, reference)` to a collector. Webhook intake checks it
  before `payment_instructions`, so a collector deposit can never be
  mis-read as a driver paying for a vehicle. Finance manual matching is the
  fallback when the provider reference is not recognised.
- **An over-deposit or unmatched deposit stays in suspense.** It does not
  silently credit the next day or an unrelated asset. Finance resolves it by
  matching it to a cash intake once the asset works that day and a payment is
  allowed; until then it sits in the existing suspense queue, visibly, next to
  gateway suspense.
- **The collector intake surface is the admin web form in Phase 7.** A
  collector does not need offline intake yet. The intake is nevertheless built
  as one idempotent POST keyed by a client-generated reference, which is the
  same shape an offline outbox entry needs, so adding an offline collector
  surface later is a client change plus a permission, not a server redesign.
  The officer field PWA stays officer-only this phase.
- **Freeze stops intake, never verification.** A frozen collector cannot take
  cash; scans, verification and driver payments are unaffected. Freezing is
  available to a zone supervisor or finance admin; unfreezing is
  finance-admin-only for now, with the permission model and service signature
  already shaped for zone-scoped supervisor unfreeze later.
- **Receipts are their own subject type.** `sms_log` gains `cash_intake_id` and
  a `cash_receipt` kind with its own dedupe index, instead of inventing a
  `payments` row. A `payments` row would falsely assert money arrived through a
  gateway and would pollute reconciliation.
- **Config, not code.** Cash behaviour comes from `cashRules`
  (`enabled`, `floatCeilingMinor`, `depositDeadlineHours`,
  `freezeOnShortfall`) and from tenant message templates. No tenant literals,
  no hardcoded currency or timezone; the business day comes from
  `todayInTimeZone(config.locale.timezone)`.

## Preconditions: clear the decks

1. Working tree green and committed at the Phase 6 tip (`303525b` or later).
   Phase 7 starts from a clean tree so the migration and the settlement-path
   change are reviewable in isolation.
2. Docker running, `.env` present from `pnpm setup`, and
   `TEST_DATABASE_URL` exported for the DB-gated suites. The Phase 6 route and
   repository suites were never executed locally in the previous session
   because Docker was down; prove them green before adding cash tables.
3. Record the current `pnpm test` baseline (including the DB-gated suites) so a
   later failure is attributable.

## Step 0: Record decisions and ADRs (completed)

D35–D39 are in `docs/decisions-needed.md`; ADRs 0031–0033 are written and
indexed. Add to `docs/decisions-needed.md` before code:

| ID  | Decision                                  | Recommendation                                                                                                                                                                                                         |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D35 | Over-deposit and unmatched deposit        | Keep as `cash_deposits.status = 'suspense'` until finance matches it to an intake for a day the asset actually worked. Never auto-credit a wallet or another asset. Resolved (user decision).                          |
| D36 | Cash intake for a day already paid        | Reject with a typed `already_paid` error and let the collector verify before taking money; the alternative (accept and credit the wallet) creates counter cash that cannot be explained to the driver. Resolved.       |
| D37 | Unfreeze authority                        | `finance_admin` only in Phase 7. `zone_supervisor` may freeze (its own zone), not unfreeze. Resolved with a recorded trigger: zone-scoped supervisor unfreeze once a user↔zone assignment exists.                      |
| D38 | Cash receipt copy                         | A tenant-configured cash receipt template plus a `cash.receipt` channel message key, validated like `smsReceiptTemplate` (known placeholders only, all enabled languages present when `messages` exists). Resolved.    |
| D39 | Collector-to-zone scoping for supervisors | Scope supervisor views and freeze authority by the **asset's** `zone_id` recorded on the intake. There is no user↔zone table today; adding one is a later HR/identity concern. Open, with the trigger recorded in D37. |

New ADRs:

- `0031-collector-cash-wallet.md` — cash as a funding account of the existing
  settlement path, derived balances, `cash_intakes` as the counter record,
  receipt as an `sms_log` subject, ceiling as an application-level check under
  a wallet row lock. Alternatives considered: a separate cash allocation
  engine; a stored wallet balance; a synthetic `payments` row.
- `0032-cash-deposit-attribution.md` — dedicated deposit instruction resolved
  before asset attribution, oldest-open-intake matching, suspense for the
  remainder, manual match as an audited finance action.
- `0033-float-ceiling-and-freeze.md` — ceiling semantics, deadline computation
  in the tenant timezone, overdue marking, freeze on shortfall per config,
  freeze/unfreeze permission split, and why freeze never blocks verification.

## Step 1: Domain rules (`packages/domain/src/cash.ts`) (completed)

Pure functions, no imports from db or Fastify:

- `WalletStatus = "active" | "frozen"`, with `canIntake(status)` and a guarded
  transition table (`freeze` idempotent, `unfreeze` only from `frozen`).
- `assertWithinCeiling({ balanceMinor, intakeMinor, ceilingMinor })` — the
  ceiling caps undeposited cash (`balance + intake`), not a single intake.
- `depositAgeHours(intakeAt, now, timezone)` and `isOverdue({ …,
depositDeadlineHours })` — computed from UTC instants, never from a client
  clock.
- `classifyDeposit({ depositMinor, openIntakeMinor })` →
  `"matched" | "partial" | "surplus"`, driving the suspense decision.
- `CashError` codes as a union (`cash_disabled`, `wallet_frozen`,
  `ceiling_exceeded`, `already_paid`, `amount_mismatch`, `duplicate_reference`)
  so the API maps them without string matching.
- Extend `LedgerPosting` in `packages/domain/src/ledger.ts` with optional
  `collectorUserId`; the balance invariant is unaffected but the property test
  that debits equal credits must keep passing with the field populated.

Tests: ceiling boundary is inclusive/exclusive exactly once
(`balance + intake === ceiling` passes); freeze is idempotent; deadline
arithmetic across a DST change in a tenant timezone; deposit classification
table; amounts remain integer minor units in one currency.

## Step 2: Schema and repositories (migration `0012_collector_cash.ts`) (completed)

Shipped as migration `0012_collector_cash.ts` and
`packages/db/src/repositories/collector-cash.ts`, plus the typed table
interfaces in `packages/db/src/connection.ts`. Two deltas from the plan below,
both recorded here because the plan text is the baseline:

- Balances: `LedgerRepository.accountBalance` is credit-positive (asset wallets
  are liabilities), so collector float reads go through the new
  `collectorCashBalance(tenantId, collectorUserId?)`, which is debit-positive
  and only ever sums `COLLECTOR_CASH` (ADR 0031).
- Immutability: money-identity triggers guard `cash_intakes`, `cash_deposits`
  and (fully append-only) `cash_deposit_allocations`; the Phase 6 SMS content
  trigger was replaced in migration `0012` to include `cash_intake_id`.

Every table is tenant-scoped with the Phase 1 RLS pattern, real indexes and a
complete `down()`; `pnpm ci:migration-check` must pass.

### Enum and ledger changes

- `alter type sms_kind add value 'cash_receipt'`. Postgres forbids using a new
  enum value in the transaction that adds it, so the migration must not also
  write rows with that kind (the seed backfill, if any, stays out of this
  migration).
- `ledger_entries.collector_user_id uuid null references users(id)` plus
  `(tenant_id, collector_user_id)` index. Nullable, so every existing row and
  every gateway posting is untouched; the immutability trigger from `0005`
  needs no change.

### `collector_wallets`

| Column                      | Notes                                              |
| --------------------------- | -------------------------------------------------- |
| `id`                        | uuid pk                                            |
| `tenant_id`                 | FK tenants                                         |
| `collector_user_id`         | FK users; `unique (tenant_id, collector_user_id)`  |
| `status`                    | `active` / `frozen`, default `active`              |
| `frozen_at`                 | nullable timestamptz                               |
| `frozen_reason`             | nullable text                                      |
| `overdue_since`             | nullable timestamptz, set by the sweeper           |
| `float_ceiling_minor`       | nullable bigint override; config ceiling when null |
| `deposit_instruction_id`    | nullable FK, current dedicated deposit reference   |
| `created_at` / `updated_at` | timestamptz                                        |

### `collector_deposit_instructions`

`id`, `tenant_id`, `collector_user_id`, `provider`, `reference`, `kind`
(`virtual_account` / `narration`), `status` (`active` / `revoked`),
`created_at`, `revoked_at`, with `unique (tenant_id, provider, reference)` and
a partial unique index for one active instruction per collector and provider.

### `cash_intakes`

| Column                           | Notes                                                                       |
| -------------------------------- | --------------------------------------------------------------------------- |
| `id`                             | uuid pk                                                                     |
| `tenant_id`, `collector_user_id` | from the session, never from the body                                       |
| `client_reference`               | client-generated; `unique (tenant_id, collector_user_id, client_reference)` |
| `asset_id`, `zone_id`            | asset FK plus a zone snapshot for supervisor scoping (D39)                  |
| `obligation_period_id`           | FK, nullable only on a historical anomaly                                   |
| `business_date`                  | server-computed                                                             |
| `amount_minor`, `currency`       | `check (amount_minor > 0)`                                                  |
| `transaction_id`                 | the ledger transaction that settled the day                                 |
| `receipt_number`                 | human-facing, unique per tenant                                             |
| `recorded_at`                    | server time                                                                 |

Indexes: `(tenant_id, collector_user_id, recorded_at desc)`,
`(tenant_id, zone_id, recorded_at desc)`, `(tenant_id, business_date)`.

### `cash_deposits`

`id`, `tenant_id`, `collector_user_id` (nullable until matched), `provider`,
`provider_reference`, `amount_minor`, `currency`, `status`
(`matched` / `partial` / `suspense`), `matched_intake_ids` via a join table or
an ordered `cash_deposit_allocations` row set (prefer the allocation table: a
deposit may clear several intakes), `transaction_id`, `raw_event_id`,
`created_at`. `unique (tenant_id, provider, provider_reference)` gives webhook
replay safety.

### `sms_log`

Add `cash_intake_id uuid references cash_intakes(id)`, extend the
`has_a_subject` check to include it, and add
`unique (cash_intake_id, kind) where cash_intake_id is not null`. Existing
`payments`/`obligation_periods` subjects keep their indexes.

### Permissions backfill

`ALL_PERMISSIONS` grows by `cash:read`, `cash:intake`, `cash:deposit:read`,
`cash:deposit:match`, `cash:freeze`, `cash:unfreeze`. Role mapping:

| Role              | New permissions                  |
| ----------------- | -------------------------------- |
| `collector`       | `cash:read`, `cash:intake`       |
| `zone_supervisor` | `cash:read`, `cash:freeze`       |
| `finance_admin`   | all six                          |
| `auditor`         | `cash:read`, `cash:deposit:read` |

Roles are inserted once, so the migration must grant the new permissions to
roles carrying the built-in role key (the `0011` pattern), not just the seed.

### Repository (`packages/db/src/repositories/collector-cash.ts`)

- `upsertWallet`, `findWallet`, `lockWallet` (`select … for update`), guarded
  `freeze` / `unfreeze` returning the affected row or throwing a conflict.
- `insertIntakeIfAbsent` (unique on `client_reference`), `findIntake`,
  `listIntakes` (cursor), `openIntakesForCollector` ordered oldest-first.
- `insertDepositIfAbsent`, `attachDeposit`, `listDeposits` (cursor),
  `listSuspenseDeposits`.
- `balanceForCollector(tenantId, collectorUserId?)` — a derived sum over
  `ledger_entries` joined to `accounts` where `code = 'COLLECTOR_CASH'`;
  tenant-wide when the collector is omitted.
- `overdueWallets(tenantId, olderThan)` for the sweeper.
- Thread `collectorUserId` through `repositories/ledger.ts` inserts and
  `accountBalance(…, collectorUserId?)`.

DB-gated tests: cross-tenant wallet read fails under RLS; intake replay returns
the original row; a frozen wallet refuses a new intake; a deposit replay is a
no-op; `balanceForCollector` equals the sum of intake amounts minus the sum of
matched deposit allocations for a seeded day.

## Step 3: Funding account on `ensurePaidForBusinessDay` (completed)

Small diff, high blast radius. Land it as its own commit with the existing
payment / obligation / ledger suites green before any cash code exists.

- `EnsurePaidInput` gains `fundingAccount?: "GATEWAY_CLEARING" | "COLLECTOR_CASH"`,
  `collectorUserId?: string | null` and `sourceType?: string`, all optional with
  byte-identical defaults for the Phases 4–6 callers.
- The wallet-credit posting uses `input.fundingAccount ?? "GATEWAY_CLEARING"`,
  attaches the collector only for `COLLECTOR_CASH`, and uses
  `sourceType: "cash_intake"` for cash funding. `LedgerPosting.collectorUserId`
  threads through `PostingSpec`, the reversal reconstruction and the repo
  posting input (ADR 0031).
- `ensurePaidForBusinessDay` is now a thin wrapper over `settleInScope(scope,
input)`, so the cash intake can run lock + checks + settlement + intake
  record + SMS in ONE `withLedger` transaction (`withTenant` cannot nest).
- Tests: the phase 4/5/6 suites pass unchanged; new tests prove a
  `COLLECTOR_CASH` funding posting produces the same allocation outcomes with
  the collector attributed on the debit leg, and that an unspecified funding
  account keeps `GATEWAY_CLEARING` with no collector.

## Step 4: `CollectorCashService` — intake (completed)

`packages/application/src/collector-cash-service.ts`; the method is
`recordIntake` (an admin-form-first shape; an offline-collector path can wrap
the same logic later):

1. Refuse when `config.cashRules.enabled` is false (`cash_disabled`, no ledger
   write).
2. Resolve the asset in-scope by `assetId` / QR token / reference — the same
   order the scan service uses, but without opening nested transactions.
   Nothing matches → `asset_unknown`.
3. `lockWallet` and refuse on `frozen`; assert the ceiling against the derived
   `COLLECTOR_CASH` balance (wallet-level override wins over config).
4. Price the business day through `FeeEngine`; reject `already_paid` (D36)
   and require the exact fee in the tenant's currency (`amount_mismatch`).
5. Settle through `settleInScope` with `fundingAccount: "COLLECTOR_CASH"`,
   source `cash_intake`, idempotency key `cash:${clientReference}`.
6. Insert `cash_intakes` (unique client reference; a true replay returns the
   original row and skips every check), enqueue the `cash_receipt` SMS with
   `cash_intake_id` attribution, return receipt + derived balance.

- The receipt body comes from `channels.cashReceiptTemplate` when configured,
  else the code's default template (D38); the recipient is the owner's phone,
  exactly like a gateway payment receipt.
- `reverseIntake` stays on the existing `reversal_requests` dual-approval path;
  mirrored entries already preserve `collector_user_id`.

Tests (DB-gated application suite, 9 cases): success path (day paid, wallet
drained, revenue credited, open intake, SMS to the owner), exact replay
returns the original intake with no second SMS, `cash_disabled`,
`already_paid`, ceiling breach leaves ledger and periods untouched,
`wallet_frozen`, `amount_mismatch` (short and wrong-currency),
`asset_unknown` by reference and token, and `CashError` as the thrown type.

## Step 5: Deposits, matching and suspense (completed)

Application layer only; the HTTP routes land in Step 7.

- **The adapter owns the reference format.** `PaymentProvider` gains an
  _optional_ `createDepositAttribution?(request)` returning
  `{ kind: "virtual_account" | "narration", value }`. Only the mock implements
  it today; a provider without it makes provisioning throw
  `PortError("PaymentProvider", "invalid_request", …)` rather than letting core
  invent a reference the gateway cannot recognise (ADR 0032).
  `provisionDepositInstruction` revokes the previous active instruction and
  inserts the new one in a single `withTenant` transaction, so exactly one live
  destination exists per `(collector, provider)`. The idempotency key includes a
  fresh opaque id, so rotation yields a new reference and cannot collide with
  the unique `(tenant, provider, reference)` constraint.
- **Resolution order** in `payment-service.ts#processEvent`:
  `collectorCash.findActiveInstruction` runs **before**
  `paymentInstructions.findByReference`, so a deposit reference can never
  cross-credit an asset, and an asset reference is never mistaken for a deposit.
- **Webhook deposit** (`CollectorCashService.ingestDeposit`): inserts
  `cash_deposits` (unique per `(tenant, provider, reference)`; a replay returns
  the recorded outcome and changes nothing). Then:
  - failed status, currency ≠ tenant currency, or no attributed collector →
    `suspense`, no posting;
  - deposit ≤ the collector's total remaining open intake coverage → post
    `Dr SETTLEMENT_BANK / Cr COLLECTOR_CASH(collectorUserId)` for the full
    amount, allocate oldest-first (partial coverage allowed), mark fully covered
    intakes `matched`, status `matched`;
  - deposit > open coverage, or nothing open → status `suspense`, **zero**
    ledger postings (D35). The surplus waits until an intake can cover it, which
    keeps day-close as "intake minus posted deposits equals balance".
- **Manual match** (`CollectorCashService.matchDeposit`): default amount is
  `min(deposit remaining, intake remaining)`, clamped both ways. Posts the same
  two legs for exactly the requested amount, appends one
  `cash_deposit_allocations` row (unique on `(deposit, intake)`), marks the
  intake `matched` when covered, and sets `partial` or `matched` from what the
  deposit has now posted. An identical repeat is a no-op replay; a different
  amount for an already-covered pair is `deposit_state`; amount overruns are
  `invalid_amount`; unknown deposit/intake is `deposit_unknown`. The approver id
  is recorded as `transactions.created_by_user_id`.
- `SmsLogRepository.markProcessed` takes `paymentId: string | null`, because a
  deposit event produces no `payments` row (`webhook_events.payment_id` is
  nullable).
- New `CashErrorCode`s: `deposit_unknown`, `deposit_state` (plus `asset_unknown`
  from Step 4). `IngestOutcome` gains `deposit_matched` / `deposit_suspense`, and
  `IngestWebhookResult` carries `depositId`.

Tests (DB-gated application suite, 8 new cases): provisioning returns an
adapter-shaped narration and rotation keeps exactly one active instruction;
a matched webhook clears the float to zero and covers the intake; a replayed
deposit webhook leaves one `cash_deposits` row and the same balance; an
over-deposit stays in suspense with no allocation; one deposit covering two
intakes clears both; a manual match posts only what the intake takes and repeats
as a no-op; a cross-tenant match is `deposit_unknown`; a mismatched currency
goes to suspense instead of posting.

## Step 6: Deadlines, freeze and the worker (completed)

Application and worker only; the HTTP routes land in Step 7.

- **Wallet state lives in its own service.** `cash-wallet-service.ts` owns
  `freeze`, `unfreeze` and the wallet view (derived balance + open-intake
  total), because the deadline sweeper needs state transitions and must not
  depend on the fee engine intake pricing needs. `CollectorCashService.freeze
/ .unfreeze` delegate to it, so there is exactly one implementation behind
  both entry points. A transition takes the caller's `CashActor` — a
  `Principal` (checked: own tenant, `cash:freeze` / `cash:unfreeze`) or
  `{ kind: "system" }` (the sweeper, trusted by construction) — so a later
  zone-scoped supervisor rule is a policy change, not a signature change
  (ADR 0033).
- **Reasons are required and every transition is audited once.** A blank reason
  is `CashError("reason_required")`; a real transition records
  `cash.wallet.frozen` / `cash.wallet.unfrozen` with the actor, the before and
  after state, and the reason. A repeated freeze/unfreeze returns the current
  view and writes **no** second audit entry — a double click is not a state
  change. `unfreeze` also clears `overdue_since`: the next sweep re-flags if
  the money is still out, which is a new deadline window, not an amnesty.
- **The sweeper is `cash-deadline-sweeper.ts`.** One sweep lists the tenants
  (default: every tenant in one system transaction — the worker has no tenant
  to scan with), validates each config in process (a broken config is reported
  and skipped, never guessed at), and for each cash-enabled tenant queries
  wallets whose _open_ intakes are past `depositDeadlineHours` measured from
  `recorded_at` as an instant (ADR 0033: hours, not calendar days).
- **Idempotency is a conditional UPDATE.** `markOverdue` sets `overdue_since`
  only when it is null and the wallet is active, and returns whether it
  changed, so two concurrent sweeps (or a retried run) produce one flag and
  one `cash.wallet.overdue` audit entry. The entry carries the oldest open
  intake, its timestamp, the open-intake count and total, and the derived
  balance, with minor units as strings (audit payloads are JSON).
- **The notice is an audit entry, not an SMS (D40).** Staff carry no phone in
  this schema; the supervisor view reads the audit entry and the wallet flag.
  Catalogue keys and outbox rows arrive when staff phones do — the recorded
  trigger, kept in D40 alongside the D38 note.
- **`freezeOnShortfall: false` flags and notices without freezing.** With it
  true, the sweeper freezes through the same service as a human, as
  `{ kind: "system" }`, with the shortfall as the reason.
- **Cash arriving clears the flag.** After a webhook deposit or a manual match
  that leaves the collector with no open intakes, `overdue_since` is cleared,
  so the next deadline window starts from the next intake.
- **The worker runs the sweep on its own timer** (`cashSweepIntervalMs`,
  default 60 s) alongside the outbox sweepers, and the clock is injectable
  (`now`). The plan's "registered on the job queue" resolves to the worker
  timer, the same cadence mechanism the SMS and channel sweepers use: a sweep
  has no per-item delivery step to enqueue, and an idempotent sweep needs no
  retry bookkeeping — the timer is the retry.
- **Repository fix found by the new tests:** `overdueWallets`'s raw SQL read
  snake_case result keys that the CamelCasePlugin renames, so every wallet came
  back with an undefined `collectorUserId` (never exercised before Step 6).
  Columns are aliased to camelCase in the SQL and locked in by a repository
  test that also proves the flag-once behaviour.
- New `CashErrorCode`s: `reason_required`, `wallet_unknown` (a freeze/unfreeze
  or view for a collector with no wallet row).

Tests: 11 new DB-gated cases — freeze (reason, audit, view, permission refusal
for a collector, blank reason, no-op repeat), unfreeze (finance-only, clears the
overdue flag), frozen wallet refuses the next intake while verification still
answers `paid`, the four sweeper behaviours (no-op before the deadline; flag
once without freezing when configured; freeze when configured; flag cleared by
a covering deposit), plus the repository test for `overdueWallets` /
`markOverdue`. The worker suite proves the wiring (`start` runs the cash sweep;
`stop` clears both timers).

## Step 7: API and contracts (completed)

`apps/api/src/routes/cash.ts` plus schemas in `schemas.ts`:

| Route                                                           | Permission           |
| --------------------------------------------------------------- | -------------------- |
| `POST /v1/cash/intakes`                                         | `cash:intake`        |
| `GET /v1/cash/wallets`                                          | `cash:read`          |
| `GET /v1/cash/wallets/:collectorUserId`                         | `cash:read`          |
| `POST /v1/cash/wallets/:collectorUserId/freeze`                 | `cash:freeze`        |
| `POST /v1/cash/wallets/:collectorUserId/unfreeze`               | `cash:unfreeze`      |
| `GET /v1/cash/deposits`                                         | `cash:deposit:read`  |
| `POST /v1/cash/deposits/:id/match`                              | `cash:deposit:match` |
| `POST /v1/cash/intakes/:id/reverse`                             | `payment:manage`     |
| `POST /v1/cash/collectors/:collectorUserId/deposit-instruction` | `payment:manage`     |

- **Money is a string on the wire.** Requests carry `amountMinor` as integer
  minor units in a string and responses serialize every `bigint` the same way
  (`balanceMinor`, `allocatedMinor`, `floatCeilingMinor`); currency defaults to
  the tenant's `locale.currency` when the body omits it.
- **`Idempotency-Key` on every money POST.** The six new paths are in
  `defaultMoneyPostMatches`, so the generated client stamps a key before the
  request leaves the dashboard. The intake route also accepts the header as a
  fallback for `clientReference`, so a client that only sends the header still
  gets a replay-safe intake.
- **`CashErrorCode` → HTTP in one table.** `asset_unknown`, `wallet_unknown`,
  `intake_unknown` and `deposit_unknown` are 404; `wallet_frozen`,
  `already_paid`, `deposit_state`, `intake_state`, `duplicate_reference`,
  `ceiling_exceeded` and `provider_required` are 409; `amount_mismatch`,
  `invalid_amount`, `reason_required` and `cash_disabled` are 400. The envelope
  carries the domain code, so the dashboard can branch without parsing
  messages. `ForbiddenError` from the service keeps the global 403 path.
- **Reversal is a request, not a posting.** `POST /v1/cash/intakes/:id/reverse`
  returns **202** with `{ intakeId, reversalRequestId, status: "pending" }` and
  moves nothing: it opens a `reversal_requests` row through
  `LedgerService.requestReversal` (Step 3's dual-approval path). A second,
  different finance user approves it, which writes the mirrored entries and
  nets the collector's derived balance to zero. The plan's route table scopes
  this step to the request; the approval endpoint ships with the Phase 9
  reversals screen that consumes it. The intake stays `open` while the request
  is pending, because the cash is still in the collector's hands.
- **Wallet detail carries the intake register.** There is no separate
  `GET /v1/cash/intakes` in the table, so `GET /v1/cash/wallets/:collectorUserId`
  returns `{ wallet, intakes, nextCursor }` — the collector's intakes, newest
  first, `limit` defaulting to 50 — which is exactly what the Step 8 detail
  screen renders.
- **`deposit-instruction` resolves the provider from config**, not from code:
  the tenant's `providers` binding with `port: "PaymentProvider"` picks the
  adapter, and a body `provider` still overrides it so finance can test a second
  adapter. A tenant with no binding is `provider_required` (409) rather than a
  silent default; the adapter's `createDepositAttribution` supplies the
  reference and kind (ADR 0032).
- **Scoping is permission-shaped until D39 closes.** A collector (`cash:read`
  without `cash:freeze` / `cash:unfreeze` / `cash:deposit:read`) sees only their
  own wallet, and an intake for anyone else is 403; supervisors, finance and
  auditors see the tenant. The plan's "supervisor sees only its zones" needs a
  user↔zone assignment that does not exist yet, so D39 keeps that gap visible
  instead of inventing a scope from the asset's zone.
- Regenerated in order (`pnpm --filter @tpirs/api build` →
  `pnpm --filter @tpirs/api-client build`); the `schema.gen.ts` and
  `openapi.json` diffs are contract output, 37 paths.
- Route-level rate limits were **not** added: these endpoints are staff-only
  behind bearer auth, and the abuse controls in `field.ts` exist for
  unauthenticated driver traffic.

Tests: nine DB-gated cases in `apps/api/src/routes/cash.routes.test.ts` — auth
required; intake once plus replay; intake-for-another-collector 403; a
collector's wallet list filtered to self, another wallet 403, own detail with
its intakes; supervisor freeze (blank reason 400, then frozen), supervisor
unfreeze refused, finance unfreeze; auditor reads and is refused on freeze and
intake; suspense deposit matched to an open intake (then a no-op replay, and a
zero balance with no open intake total); reversal returns 202 with a pending
request, moves no money, and an unknown intake is 404; deposit instruction
provisioned through the mock adapter. `packages/api-client/src/index.test.ts`
adds the six money paths to the idempotency test.

## Step 8: Admin surface (`apps/admin`, completed)

- `CollectorsPage` (`apps/admin/src/pages/CollectorsPage.tsx`): wallet list with
  derived balance, status, oldest open intake age, and last deposit, overdue
  wallets first. Nav entry "Collectors" is gated on `cash:read` and follows
  `NAV_ENTRIES`; `App.tsx` maps `/collectors`.
- Wallet detail: freeze / unfreeze with a required reason, open intakes,
  deposits and their match state, and a "take cash" form (asset lookup, amount
  pre-filled from the fee, client reference generated in the browser).
- Deposit match: pick a suspense deposit, pick an open intake, confirm. It is an
  inline form rather than a modal dialog because `components/ui.tsx` has no
  dialog primitive yet; opening one would mean adding a dependency for a single
  screen. The route and payload are the same either way.
- **The list needed two new wallet fields to avoid N+1 client fetches.**
  `GET /v1/cash/wallets` now returns `oldestOpenIntakeAt` and `lastDepositAt` per
  wallet (`oldestOpenIntakeAt`/`lastDepositAt` on `CashWalletView`, backed by two
  grouped lookups in the collector-cash repository) — the two columns the plan
  asks for, computed in SQL instead of one detail request per row.
- **Permissions shape the affordances, the server still enforces.** Each button
  reads its own permission (`cash:intake`, `cash:freeze`, `cash:unfreeze`,
  `cash:deposit:read`, `cash:deposit:match`), so a supervisor sees a disabled
  "Unfreeze wallet" with "Only finance can unfreeze" instead of a button that
  403s, and an intake-only role never fires the deposits query (which needs
  `cash:deposit:read`).
- **The amount pre-fill is a convenience, never the decision.** It takes the
  newest fee rule effective on the current date (`prefillAmountMinor`), and the
  server still refuses anything that is not exactly the day's fee
  (`amount_mismatch`), so a stale rule surfaces as an error instead of taking
  the wrong cash. A rule that is not effective yet pre-fills nothing.
- **The client reference is minted in the browser and rotated after each
  intake**, so a double-click dedupes to the same receipt while the next driver
  gets a fresh key (ADR 0031).
- Pure rules live in `apps/admin/src/lib/collectorsView.ts` (pre-fill selection,
  overdue derivation, held-hours, match candidates, labels, reference minting)
  so they are unit-testable without rendering.
- Tests use the existing conventions: `test-support/tenant.ts` fixture, stubbed
  transport through `stubRelativeRequests()` + `vi.stubGlobal("fetch", ...)`,
  manual `cleanup()` in `afterEach`. The page test drives the whole workflow
  (list, no-permission state, take cash with its request body, freeze with a
  required reason, finance-only unfreeze, deposit match) and the helper test
  pins the pre-fill, overdue, held-hours, candidate and label rules.

## Step 9: Seed and tenant template

- Seed: a wallet for `alpha.collector`, an active deposit instruction, and one
  deterministic intake + matching deposit pair so the day-close demo can be
  run without touching the API by hand.
- `tenants/_template/tenant.config.yaml` and the admin test fixture: cash rules
  and the cash receipt / freeze notice message keys in every enabled language.
- `packages/config` validator: the cash receipt template placeholder check
  (D38), with an error naming the offending placeholder.

## Step 10: Tests and the verification gauntlet

- `collector-cash.day-close.test.ts` — the first acceptance check: N intakes
  and matching deposits for one collector leave `intake − deposits = 0`, equal
  to the derived `COLLECTOR_CASH` balance, with debits equal to credits across
  every posting.
- `collector-cash.freeze.test.ts` — the second acceptance check: a sweeper run
  past the deadline flags the shortfall and freezes per config; intake returns
  `409`; with `freezeOnShortfall: false` it flags without freezing.
- Negative tests: forged asset reference, replay of an intake, replay of a
  deposit webhook, wrong currency, ceiling breach, cross-tenant wallet access,
  a collector calling finance routes.
- Gates, in order: `pnpm format` → `pnpm lint` → `pnpm typecheck` →
  `pnpm test`, then `sh scripts/ci/integration.sh` and
  `pnpm ci:migration-check` (both need Docker).

## Step 11: Documentation

- This file (kept current as decisions land), ADRs 0031–0033.
- `docs/runbooks/collector-cash.md`: how to provision a deposit instruction,
  take cash, match a suspense deposit, freeze and unfreeze, and reconcile a
  wallet by hand.
- `README.md`, `AGENTS.md` phase state, and `docs/adr/README.md` index.

## Acceptance mapping

| `AGENTS.md` acceptance check                                             | Where it is proven                                                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| A simulated day reconciles to zero                                       | Step 10 `collector-cash.day-close.test.ts`; derived balance equals intake minus deposits |
| An intentional shortfall is flagged and freezes the collector per config | Step 10 `collector-cash.freeze.test.ts`; config flag toggles freeze (Step 6)             |
| Cash settles a day exactly like a gateway payment                        | Step 3 funding-account test + Step 4 verify-after-intake test                            |
| Money is append-only and auditable                                       | Step 2 triggers and Step 6 audit entries                                                 |
| No tenant literals                                                       | Step 9 config/template work; grep for hardcoded currency, language, ceiling              |

## Deferred items

- **Offline collector intake.** The admin form only in Phase 7; the intake
  contract (one idempotent POST keyed by a client reference, a receipt number
  returned synchronously) is deliberately the shape an offline outbox needs.
  Trigger: collector field devices and a paid-set-style cache budget.
- **Zone-scoped supervisor unfreeze.** Permission and service are shaped for
  it; the policy change waits on a user↔zone assignment (D37/D39).
- **Cash deposit import from bank statements.** Phase 8's `SettlementImport`
  port; Phase 7 relies on the provider reference plus manual match.
- **Automatic suspense ageing and write-off.** Phase 8 anomaly rules; a stale
  suspense deposit is visible but not auto-resolved here.
- **Collector statements and PDF receipts.** The SMS receipt and the admin
  record are the Phase 7 artefacts; `ExportService` reports are Phase 8.

## Risks and open questions

- **The funding-account change touches money code that already works.** Keep
  it the smallest possible diff, land it alone, and re-run the phase 4–6
  suites before building on it.
- **Adding a column to `ledger_entries` interacts with immutability.** The
  trigger rejects updates, so the column must be nullable and only ever
  written at insert time; the migration check proves the `down()` is clean.
- **Deposit attribution is an ordering problem.** Resolving deposits before
  payment instructions must be covered by a test where a deposit reference and
  a driver reference could plausibly collide, because getting the order wrong
  silently credits the wrong party.
- **Ceiling enforcement is a lock, not an invariant.** Two concurrent intakes
  for one collector are serialised by `lockWallet`; the database cannot express
  the ceiling because the balance is derived. A property test plus the row lock
  is the guarantee, and the ADR must say so plainly.
- **Postgres enum growth.** `ALTER TYPE … ADD VALUE` cannot be used in the same
  transaction that adds it; any seed or backfill writing `cash_receipt` must
  run after the migration commits.
- **D39 is genuinely unresolved.** Supervisor scoping by asset zone is an
  approximation: a collector working across zones will appear in more than one
  supervisor's view. The ADR records this as a known limitation rather than a
  hidden one.
