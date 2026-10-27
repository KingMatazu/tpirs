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

## Step 0: Record decisions and ADRs

Add to `docs/decisions-needed.md` before code:

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

## Step 1: Domain rules (`packages/domain/src/cash.ts`)

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

## Step 2: Schema and repositories (migration `0012_collector_cash.ts`)

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

## Step 3: Funding account on `ensurePaidForBusinessDay`

Small diff, high blast radius. Land it as its own commit with the existing
payment / obligation / ledger suites green before any cash code exists.

- `EnsurePaidInput` gains `fundingAccount?: "GATEWAY_CLEARING" | "COLLECTOR_CASH"`
  and `collectorUserId?: string | null`, both optional.
- The wallet-credit posting uses `input.fundingAccount ?? "GATEWAY_CLEARING"`
  and passes `collectorUserId` into `LedgerService.postTransaction`.
- No other behaviour changes: the fee resolution, allocation, rounding and
  idempotency keying stay exactly as they are.
- Tests: the phase 4/5/6 suites pass unchanged; one new test proves a
  `COLLECTOR_CASH` funding posting produces the same allocation outcomes and a
  balanced transaction.

## Step 4: `CollectorCashService` — intake

`packages/application/src/collector-cash-service.ts`:

- `intake({ tenantId, principal, assetRef, amount, clientReference })`:
  1. Refuse when `config.cashRules.enabled` is false (typed error, no ledger
     write).
  2. Resolve the asset with the same token / short-code / reference resolution
     the scan service uses.
  3. `lockWallet` and refuse on `frozen`; then assert the ceiling against the
     derived balance.
  4. Price the business day through `FeeEngine`, then reject `already_paid`
     (D36) before any money is taken.
  5. Call `ensurePaidForBusinessDay({ fundingAccount: "COLLECTOR_CASH",
collectorUserId, idempotencyKey: `cash:${clientReference}` })`.
  6. Insert `cash_intakes`, enqueue the `cash_receipt` SMS in the same
     transaction through `repos.smsLog.enqueue`, return the receipt and the new
     balance.
- `reverseIntake(...)` uses the existing `reversal_requests` dual-approval
  path; it posts mirrored entries and marks the day back to `unpaid` (the
  Phase 6 paid-set behaviour already requires that on reversal).

Tests (application level, DB-gated where they touch Postgres): replay of the
same `clientReference` changes nothing and returns the original receipt;
ceiling breach rejects without posting; frozen rejects without posting; a day
already paid rejects; a cash intake makes `GET /v1/verify/:token` report
`paid` for that business day; the response payload contains no field that
could be read as "unpaid".

## Step 5: Deposits, matching and suspense

- Provisioning: `POST /v1/cash/collectors/:collectorUserId/deposit-instruction`
  (finance only) creates or rotates an instruction, choosing virtual account vs
  narration from the provider adapter's declared capabilities. Never invent a
  reference format in core code.
- Webhook intake (`PaymentService.handleWebhook`): after the tenant is resolved
  from the endpoint token, look up `collector_deposit_instructions` by
  `(provider, reference)` **before** `payment_instructions`.
  - Match: insert `cash_deposits`, post `Dr SETTLEMENT_BANK / Cr COLLECTOR_CASH
(collectorUserId)`, allocate across the collector's oldest open intakes,
    and mark fully covered intakes settled. A deposit that clears everything
    brings the collector's derived balance back to zero.
  - Remainder or unknown reference: `cash_deposits.status = 'suspense'` with no
    ledger posting until finance acts (D35). It appears in the existing finance
    suspense list plus a cash-deposit tab.
- Manual match: `POST /v1/cash/deposits/:id/match` (finance, audited,
  idempotent, requires the target intake to exist for a day the asset actually
  worked). Matching posts the same two legs; a partial match leaves the rest in
  suspense.
- Tests: a deposit webhook replay changes nothing; a deposit larger than the
  open intakes leaves exactly the surplus in suspense; the day-close invariant
  holds.

## Step 6: Deadlines, freeze and the worker

- `packages/application/src/cash-deadline-sweeper.ts`, registered on the
  existing Postgres job queue alongside the SMS and channel sweepers in
  `apps/worker/src/worker.ts`.
- For each tenant with cash enabled: find wallets with open intakes older than
  `cashRules.depositDeadlineHours`, set `overdue_since`, queue the supervisor
  notice (idempotent: one notice per wallet per deadline window), and freeze
  when `freezeOnShortfall` is true. Freezing writes an audit entry with the
  sweeper as the actor.
- `CollectorCashService.freeze(...)` / `unfreeze(...)`: permission-guarded
  (`cash:freeze` / `cash:unfreeze`), reason required, audited, idempotent.
  Unfreeze is finance-only; the service takes the caller's principal so a later
  zone-scoped supervisor rule is a policy change, not a signature change.
- Tests with a fake clock and an explicit business date: a run before the
  deadline is a no-op; a run after it flags once; `freezeOnShortfall: false`
  flags without freezing; a frozen collector's next intake returns `409`;
  verification for that collector's assets still works.

## Step 7: API and contracts

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

- `Idempotency-Key` required on every money POST; add the new paths to
  `defaultMoneyPostMatches` in `packages/api-client/src/index.ts`.
- Route-level rate limits reuse the `field.ts` pattern; list endpoints use the
  standard opaque cursor.
- Regenerate in order: `pnpm --filter @tpirs/api build` →
  `pnpm --filter @tpirs/api-client build`, commit the `schema.gen.ts` diff.
- RBAC tests: a collector cannot read another collector's wallet or intake; a
  supervisor sees only intakes in its zones and cannot unfreeze; finance sees
  the tenant and can both; the auditor reads and cannot mutate.

## Step 8: Admin surface (`apps/admin`)

- `CollectorsPage`: wallet list with derived balance, status, oldest open
  intake age, and last deposit. Nav entry gated on `cash:read`, following
  `NAV_ENTRIES`.
- Wallet detail: freeze / unfreeze with a required reason, open intakes,
  deposits and their match state, and a "take cash" form (asset lookup, amount
  pre-filled from the fee, client reference generated in the browser).
- Deposit match dialog: pick a suspense deposit, pick an open intake, confirm.
- Tests use the existing conventions: `test-support/tenant.ts` fixture, stubbed
  transport through `stubRelativeRequests()` + `setRuntimeFetch(...)`, manual
  `cleanup()` in `afterEach`, and the tenant fixture must carry the new cash
  message keys in every seeded language or the config validator fails the
  suite.

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
