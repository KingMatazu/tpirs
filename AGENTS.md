# AGENTS.md: Revenue Collection Platform (Build Brief)

## Working in this repo (verified against the codebase)

**Toolchain:** Node 24 (`.node-version`), pnpm 11.1.3 (`corepack enable`), turbo, vitest, TypeScript strict, type-aware ESLint (`strictTypeChecked` + stylistic), Prettier (printWidth 100).

**Commands** (repo root, all in `package.json`):

| Command                                                        | What it does                                             |
| -------------------------------------------------------------- | -------------------------------------------------------- |
| `pnpm install`                                                 | install workspace dependencies                           |
| `pnpm setup`                                                   | copy `.env`, start containers, migrate, seed (first run) |
| `pnpm dev`                                                     | all dev servers via turbo; API on :3000                  |
| `pnpm dev:infra`                                               | Postgres/Redis/MinIO containers only                     |
| `pnpm lint` / `typecheck` / `test` / `build`                   | turbo runs that task in every package                    |
| `pnpm format`                                                  | Prettier write; unformatted new files fail lint-staged   |
| `pnpm db:migrate` / `db:migrate:down` / `db:check` / `db:seed` | migrate, roll back, prove reversibility, seed            |

**Order before finishing a change:** `pnpm format` → `pnpm lint` → `pnpm typecheck` → `pnpm test`. CI (`scripts/ci/verify.sh`) runs install → lint → typecheck → build, then `scripts/ci/integration.sh` (scratch Postgres + full suite) and `scripts/ci/migration-check.sh` (every migration must roll back to zero). Husky hooks: pre-commit = `pnpm lint-staged` (eslint `--fix --max-warnings 0` + prettier); pre-push = `pnpm typecheck` + `pnpm test`.

**Testing gotchas:**

- One package: `pnpm --filter @tpirs/<name> test` (runs `vitest run`); one file: append `-- src/<file>.test.ts`.
- DB-backed suites (auth, audit, RLS, identity, registry) are `describe.skip` unless `TEST_DATABASE_URL` is set — a plain `pnpm test` can pass without ever touching Postgres. Real run: `sh scripts/ci/integration.sh` (spins up scratch Postgres, migrates, exports the var), or `pnpm dev:infra` + `pnpm db:migrate` with `TEST_DATABASE_URL` exported.
- Cross-package imports resolve to built `dist/` (`main: ./dist/index.js`), never `src`. After editing a dependency, rebuild before testing dependents — running vitest directly inside a package uses stale `dist`. Root `pnpm test`/`pnpm typecheck` are safe: turbo declares `dependsOn: ^build`.

**Adding a package or adapter:**

- Workspace globs (`pnpm-workspace.yaml`) cover `apps/*`, `packages/*`, `packages/adapters/*/*`, `packages/adapters/*/*/*` — nested adapter folders are picked up automatically.
- Copy the sibling package shape exactly: scripts `build` (`tsc -b`), `typecheck` (`tsc -b && tsc -p tsconfig.test.json`), `lint` (`eslint src`), `test` (`vitest run`), plus a `vitest.config.ts`.
- Adapter package names are inconsistent (`@tpirs/telemetry-mock`, `@tpirs/adapters-s3-storage`, `@tpirs/identity-provider-db`, `@tpirs/asset-schema-registry-config`) — read the `package.json` name before using `--filter`; do not guess a pattern.
- pnpm 11 blocks postinstall scripts; only `esbuild` is allowed via `allowBuilds` in `pnpm-workspace.yaml`.
- Every adapter must run its shared suite from `@tpirs/contracts` — pattern in `packages/contracts/README.md`.

**Environment:**

- `.env` (gitignored) is created from `.env.example` by `pnpm setup`. The db CLI (`packages/db/src/env.ts`, used by migrate/seed) auto-loads it; `pnpm dev` apps load it via `tsx --env-file-if-exists=../../.env`. Anything else (scripts, tests, one-off commands) reads `process.env` directly — export variables yourself.
- Local ports: Postgres **5433**, Redis **6380**, MinIO 9000/9001, API 3000 (see `docs/runbooks/local-development.md`).
- Full reset: `docker compose -f infra/docker-compose.yml down -v`, then `pnpm setup`.

**Git:** small, phase-scoped commits in conventional style (`chore: phase 0 foundations` matches history). commitlint is configured but not hooked — `lint-staged` is the only commit-time gate.

**Current repo state:** Phases 0–1 committed; Phase 2 (asset registry) complete and committed: photo serving, public `GET /v1/verify/:token` (ADR 0007), SVG sticker export via `qrcode` (ADR 0009), asset-registry e2e suite, seed users `alpha.collector`/`beta.officer`. `PHASE2-TODO-APPLY.md` is untracked scratch — delete it; never commit it. Tenant-config fixtures must include `channels.otpMessageTemplate` (with a `{code}` placeholder) or validation throws.

## 0. Mission and how to use this brief

Build a **white-label, multi-tenant revenue collection platform**. The first deployment is a state levy system for bikes and tuk-tuks. The firm will resell the same codebase to other states, so nothing may be hardcoded to one state, gateway, SMS provider, currency, language, or vehicle type.

First deployment, in one paragraph: owners register vehicles (assets) and get a QR sticker. Daily levy payments go from the driver into a state-controlled bank account via a payment gateway, and each payment is recorded in an append-only ledger. Drivers use SMS and USSD (feature phones). Road officers scan the QR on a smartphone app to see PAID/UNPAID for today, online or offline. Park agents register vehicles and take residual cash through a pre-funded wallet. Finance gets nightly reconciliation and an audit trail. The levy is **pay-per-use**: a vehicle owes the fee only on days it is used for work, so a day with no payment is never a debt.

**Rules for the agent**

1. Work phase by phase (section 9). Do not start a phase until the previous phase's acceptance checks pass.
2. Open small, reviewable changes. Write tests first for ledger, allocation, and webhook code.
3. If a requirement is ambiguous, do not guess. Add the question to `docs/decisions-needed.md` with options and a recommendation, then continue with the safest default behind a config flag.
4. Record every significant architecture choice as a short ADR in `docs/adr/`.
5. Never commit secrets. Never hardcode tenant-specific values (names, currency, timezone, fee amounts, provider keys, message text).

## 1. Non-negotiable design principles

1. **Ports and adapters (hexagonal).** Domain logic is pure TypeScript with zero imports from the web framework, ORM, or any vendor SDK. Everything external sits behind a port (interface) with at least two adapters (a real one and a mock/alternative).
2. **Every adapter passes a shared conformance suite.** Each port has a reusable contract test suite in `packages/contracts`. A new adapter is accepted only when it passes the suite. This is what makes swapping safe.
3. **Configuration over code.** A tenant is defined by a validated config (section 4). Onboarding a new state means writing config, templates, and branding, not changing core code.
4. **Generic domain language.** Use `asset` (not `vehicle`), `obligation` (not `daily fee`), `zone` (not `park`), `collector` (not `agent`) in core packages. The vehicle levy is the first _configuration_ of these concepts.
5. **API-first.** The backend exposes a versioned OpenAPI contract. The dashboard, field app, and any future client are replaceable because they only talk to that contract.
6. **Money and time are explicit.** Integer minor units plus an ISO currency code. UTC storage. Business day computed from the tenant's timezone.
7. **Append-only financial truth.** Ledger and audit tables are never updated or deleted, enforced at the database level.
8. **Offline-safe, never falsely accusatory.** An offline cache may confirm PAID, but must never conclude UNPAID.

## 2. Honest note on "swap everything"

Postgres is the one deliberate fixed choice. Any managed or self-hosted Postgres works, but the ledger relies on Postgres features (transactions, constraints, triggers, row-level security). Keep all queries behind repository interfaces so the ORM is replaceable, but do not spend effort abstracting away the database engine itself. Everything else in section 3 must be swappable.

## 3. Ports and adapters (the swap map)

| Port                         | Responsibility                                                          | v1 adapters                                    | Alternatives to be possible                                |
| ---------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| `PaymentProvider`            | create payment intent, verify and normalize webhooks, fetch settlements | Paystack, Remita, Mock                         | Flutterwave, bank-statement CSV import, any future gateway |
| `SmsProvider`                | send SMS, delivery receipts, inbound SMS                                | Africa's Talking, Termii, Mock                 | Twilio, any aggregator                                     |
| `UssdProvider`               | translate provider callbacks to the internal session engine             | Africa's Talking, Mock                         | other aggregators or telco direct                          |
| `ObjectStorage`              | photos, exports, stickers                                               | S3-compatible, local disk                      | any S3-compatible store, Azure/GCS                         |
| `JobQueue`                   | background jobs, retries, schedules                                     | Redis queue, Postgres-based queue              | SQS, others                                                |
| `Cache` / `LockService`      | caching, distributed locks                                              | Redis, in-memory                               | others                                                     |
| `IdentityProvider`           | staff authentication                                                    | built-in password plus TOTP and device binding | OIDC/SSO (Keycloak, Azure AD, etc.)                        |
| `SecretsProvider`            | read credentials                                                        | environment, cloud secrets manager             | Vault, others                                              |
| `Telemetry`                  | logs, metrics, traces, errors                                           | OpenTelemetry plus a Sentry exporter           | any OTel-compatible backend                                |
| `Clock` / `BusinessCalendar` | now, business day, holidays                                             | system clock plus tenant timezone              | test clock                                                 |
| `FeeEngine`                  | compute what is owed for an asset on a date                             | flat, per-asset-type, effective-dated rules    | zone-based, tiered, custom plugin                          |
| `AssetSchemaRegistry`        | per-tenant asset types and validated attributes                         | vehicle (bike, tuk-tuk)                        | market stall, bus, any new type                            |
| `ReceiptRenderer`            | SMS text, PDF/printable receipts                                        | templates from tenant config                   | custom per tenant                                          |
| `ExportService`              | CSV/PDF/XLSX reports                                                    | CSV, PDF                                       | any format                                                 |

Frontend swappability: the admin dashboard and field app are separate clients of the OpenAPI contract. Generated API clients live in `packages/api-client`. Theming comes from design tokens, never hardcoded colors or logos.

Adapters built **today**: a mock for every port, plus non-mock adapters for `ObjectStorage` (S3-compatible, local disk), `IdentityProvider` (db), `SecretsProvider` (env), `Telemetry` (OTel), and `AssetSchemaRegistry` (config). The remaining real adapters (Paystack, Remita, Africa's Talking, Termii, Redis queue, …) arrive with their phases.

## 4. Multi-tenancy and white-labelling

**Deployment model (support both, default to dedicated):**

- Default: one deployment per state (data residency and procurement expectations of governments).
- Also supported: several tenants in one deployment, isolated by `tenant_id` on every table plus Postgres row-level security. Build the schema tenant-aware from day one so both modes work with the same code.

**Hierarchy:** Tenant (state) → Zones (parks, markets, districts; nestable) → Collectors (agents) and Officers → Assets → Obligations → Payments.

**Tenant config** (YAML/JSON, validated by a schema at startup and stored in the database; changes are audited):

- identity: name, slug, legal entity, support contacts
- locale: default language, enabled languages, timezone, currency code, number and date formats
- branding: logo, colors, app name, SMS sender ID, receipt header/footer
- asset types: names, attribute schemas, QR and short-code format, sticker spec
- obligation rules: model (`pay_per_use` or `scheduled`), frequency (daily/weekly/monthly), fee rules with effective dates, prepaid allowed, arrears policy (`none` or `accrue`), grace rules. The first tenant uses `pay_per_use`, arrears `none`, prepaid off.
- providers: which adapter to use per port, plus _references_ to secrets (never the secrets)
- channels: USSD code, SMS keywords, menu definitions (data-driven, see section 6)
- cash rules: enable agent cash, float ceilings, deposit deadlines, freeze rules
- feature flags: disputes, prepay, offline mode, anomaly alerts
- reconciliation: schedule, tolerance, who is notified
- compliance: retention periods, data-residency notes, consent text

**Rules:** no `if (tenant === 'x')` branches anywhere. If a tenant needs unusual behavior, add a configuration option or a plugin hook (section 5), then configure it.

## 5. Repository layout

Target layout. Items marked _(later)_ do not exist yet — do not create them before their phase; everything else is present today.

```
/apps
  /api            # delivery layer (HTTP, webhooks, USSD/SMS callbacks); thin
  /admin          # web dashboard (later; consumes api-client only)
  /field          # mobile app for officers and collectors (later; consumes api-client only)
  /worker         # background job runner (stub)
/packages
  /domain         # pure business logic (ledger, allocation, obligations, verification, disputes)
  /ports          # TypeScript interfaces for every port in section 3
  /adapters       # one folder per adapter, grouped by port
  /contracts      # conformance test suites for each port
  /config         # tenant config schema and loader
  /application    # use-case services wiring domain + ports (read by apps/api)
  /crypto         # hashing and HMAC helpers (passwords, QR tokens)
  /db             # Kysely connection, migrations, seed, repositories
  /api-client     # generated from OpenAPI (later)
  /ui-tokens      # design tokens and theming (later)
  /i18n           # message catalogs and templating (later)
/tenants
  /_template      # starter config, templates, assets for a new state
  /<state-slug>   # config only: no code
/docs
  /adr  decisions-needed.md  runbooks  onboarding (planned)
/infra            # IaC, Docker, deployment manifests
/scripts          # setup and CI entrypoints (thin CI callers live here)
```

**Plugin hook:** a small, versioned plugin interface (for example custom fee rules or custom report columns) loaded from `tenants/<slug>/plugins`. Core must work with zero plugins.

## 6. Key domain designs

**Ledger.** Double-entry. Accounts: asset wallet, collector wallet, tenant revenue, gateway clearing, suspense. `ledger_entries` are append-only (revoke update/delete privileges plus a rejecting trigger). Corrections are reversing entries needing a second approver. Property test: total debits equal total credits.

**Obligations and allocation.** Two models, chosen per tenant:

- `pay_per_use` (first tenant): nothing is owed until the owner pays. A payment of the current fee records a paid period for the current business day (`obligation_periods`: asset, period, status, amount, unique on tenant + asset + period). No rows are pre-generated for unused days, no arrears accrue, and an absent row simply means no payment recorded for that day. Prepay is a config option, off by default.
- `scheduled`: periods are generated for every asset on the schedule, and unpaid periods follow the tenant's arrears policy (`none` or `accrue`), allocating oldest-first or today-first.
  A payment always credits the asset wallet first, then the allocation engine applies it per the model. UNPAID in verification means only "no payment recorded for this period"; it carries no debt meaning under `pay_per_use`.

**Payment intake.** Webhook: verify signature via the adapter, deduplicate on provider reference, store raw payload, return fast, process on the job queue, idempotent. Unmatched payments go to suspense and alert finance.

**Verification.** `GET /v1/verify/{token}` returns status for the current business period. QR token = opaque ID plus HMAC checksum, revealing nothing. Include plate/identifier and photo so officers can detect swapped stickers.

**Offline sync.** `GET /v1/sync/paid?since=` delta feed. The client stores the paid set. Results: PAID, or NOT_IN_OFFLINE_LIST (never UNPAID). Online checks, SMS checks, or driver receipts confirm unpaid status. Offline scans and disputes are queued and synced.

**USSD/SMS engine.** Provider-agnostic session state machine. Menus, prompts, and SMS templates are **data** from tenant config with i18n keys, not code. Inbound SMS commands (status check by plate or short code) go through the same engine.

**Collector cash wallet.** Float ceiling per collector. Cash intake debits the collector wallet and credits the asset instantly with an SMS receipt. The collector deposits cash into their dedicated payment account; the webhook restores the float. Reconciliation compares intake to deposits and can auto-freeze.

**Disputes.** Ticket with asset, time, location, evidence. Resolution looks up the provider reference. Reversal needs a second approver.

**Reconciliation.** Nightly: provider settlement vs ledger credits, ledger vs revenue entries, collector intake vs deposits, per zone and collector. Differences go to an exceptions queue. Anomaly rules are configurable.

**Security.** Roles and permissions as data (driver self-service, collector, officer, zone supervisor, finance admin, system admin, auditor). System admins cannot touch ledger data. Audit every state-changing request, scan, login, and config change. Staff two-factor and device binding. Data protection by design: minimal data, retention rules from config, encryption in transit and at rest.

## 7. API conventions

- REST, `/v1`, OpenAPI 3 as the source of truth; generate clients and server types from it.
- Idempotency keys on all POSTs that create money-affecting records.
- Cursor pagination, consistent error envelope, request IDs in every response and log line.
- Webhooks live under `/webhooks/{provider}` and call only the adapter plus domain services.
- Rate limiting and abuse controls on verification, USSD, and auth endpoints.

## 8. Quality bar (applies to every phase)

- Typed end to end, strict compiler settings, lint and format enforced in CI.
- Unit tests for domain, integration tests against real Postgres, conformance suites for every adapter, end-to-end tests for the main flows.
- Negative tests: forged QR, replayed webhook, duplicate payment, wrong amount, cross-tenant access attempts, privilege escalation.
- Every feature behind the tenant config model where behavior can vary.
- Docs updated in the same change: ADRs, runbooks, README per package.
- Definition of done: tests pass in CI, conformance suites pass, no tenant-specific literals, migrations reversible where possible, observability added (logs, metrics, alerts for failure paths).

## 9. Build phases

Each phase lists tasks and **acceptance checks**.

### Phase 0: Foundations

- Monorepo, package manager workspaces, TypeScript strict, lint/format, commit hooks, CI (lint, types, tests, build, migration check, deploy to staging).
- Local dev: containers for Postgres, Redis, object storage; one-command start; seed script.
- Define all ports in `packages/ports` and the conformance-suite skeletons in `packages/contracts`.
- Implement the mock adapter for every port.
- Observability baseline: structured logs with request IDs, error tracking, health endpoints.
- Environments: local, staging, production with separate secrets.

_Acceptance:_ CI green; every port has an interface, a mock adapter, and a passing conformance suite; staging deploys automatically.

### Phase 1: Tenancy, config, identity, audit

- Tenant, zone, and role models with `tenant_id` and row-level security everywhere.
- Config schema, loader, validation, and audited config changes. `tenants/_template`.
- Staff authentication (password plus TOTP, device binding for the field app), permission guards on every route.
- Audit log middleware and append-only audit table.
- Seed two fake tenants with different currency, timezone, fee rules, and languages.

_Acceptance:_ cross-tenant access tests fail closed; two fake tenants run side by side with no code differences; every mutating request produces an audit entry.

### Phase 2: Asset registry

- Generic `assets` plus `AssetSchemaRegistry`; first asset type: vehicle (bike, tuk-tuk).
- Owners, OTP phone verification through `SmsProvider`, photo upload through `ObjectStorage`.
- QR token and short-code generation (format from tenant config). Sticker spec and printable template export.
- Admin and collector flows to register, search, suspend, correct (audited).

_Acceptance:_ register an asset end to end under both fake tenants; sticker scans; schema validation rejects bad attributes.

### Phase 3: Ledger and obligations

- Chart of accounts, ledger service with transactional posting, immutability protections, and tests proving updates and deletes fail.
- `FeeEngine` with effective-dated flat and per-type rules; allocation engine implementing both `pay_per_use` (default) and `scheduled` models, with optional prepay.
- Reversal workflow with dual approval.

_Acceptance:_ property tests (debits equal credits); allocation tests across timezone boundaries and fee changes; under `pay_per_use`, no obligation rows or debts exist for days without payment; `scheduled` mode arrears policies (`none`, `accrue`) both pass.

### Phase 4: Payments

- `PaymentProvider` real adapters: Paystack and Remita; plus mock and bank-statement import.
- Per-asset payment instruction assignment (virtual account or reference, depending on adapter capabilities declared by the adapter).
- Webhook pipeline: verify, dedupe, store raw, async process, suspense, retries, dead-letter queue.
- SMS receipt through `SmsProvider` using tenant templates.
- Finance views: payments, unmatched payments, daily totals.

_Acceptance:_ the same end-to-end test passes unchanged against each adapter's sandbox or recorded fixtures; replaying a webhook changes nothing; wrong or unmatched amounts land in suspense.

### Phase 5: Driver channels

- Provider-agnostic USSD session engine; data-driven menus; `UssdProvider` adapters.
- SMS inbound commands; template catalog with i18n.
- Rate limiting, abuse controls, and SMS cost guards (send on events, not on schedules, by default). Under `pay_per_use`, never send reminders about unpaid days, since they are not debts.

_Acceptance:_ menu changes made only in tenant config alter behavior; every path works through the mock provider and the real adapter sandbox.

### Phase 6: Verification and offline

- Verify endpoints and the delta sync feed.
- Field app (officer): scan, result with identifier and photo, manual search, offline cache with the NOT_IN_OFFLINE_LIST rule, queued scans and disputes, SMS-check fallback.
- Scan log and dispute creation.

_Acceptance:_ with the network disabled the app never shows UNPAID; sync catches up after reconnect; field-tested on low-end Android devices and in sunlight.

### Phase 7: Collector cash wallet

- Collector wallets, float ceilings, dedicated deposit instructions, intake flow, SMS receipts.
- Deposit matching, deadlines, auto-freeze.
- Zone supervisor views.

_Acceptance:_ a simulated day reconciles to zero; an intentional shortfall is flagged and freezes the collector per config.

### Phase 8: Reconciliation, reporting, anomaly detection

- Nightly reconciliation jobs, exceptions queue, tolerances.
- Reports (by day, zone, collector, asset type; compliance rate) through `ExportService`. Under `pay_per_use`, compliance rate is computed from scan results (paid scans divided by total scans), never from paid days divided by registered assets, because idle vehicles legitimately owe nothing.
- Configurable anomaly rules and alerts; auditor read-only view. Under `pay_per_use`, a vehicle with no payments is not an anomaly; alert on collectors, zones, or officers whose volumes or scan outcomes deviate from trend.

_Acceptance:_ a full simulated month reconciles and is signed off by a test finance user.

### Phase 9: Admin dashboard

- Built only on `api-client` and `ui-tokens`. Roles-aware navigation, tenant branding, i18n.
- Screens: registry, payments, suspense, disputes, reversals (dual approval), reconciliation, reports, collectors, config viewer, audit search.

_Acceptance:_ switching tenants re-themes and re-labels the dashboard with no code changes.

### Phase 10: Hardening

- Load tests (peak-hour webhooks, verify lookups, sync downloads).
- Security review: dependency audit, access-control and cross-tenant tests, external pen test if possible.
- Backup and restore drill, disaster recovery runbook.
- Performance budgets and alerts.

_Acceptance:_ no open critical or high findings; restore drill passed; load targets met.

### Phase 11: Productization (selling to other states)

- `tenant:create` tooling: scaffold from `tenants/_template`, validate config, provision infra, seed roles, run smoke tests.
- Onboarding checklist and runbook: settlement account setup, gateway choice, USSD shortcode and SMS sender approvals, sticker production, agent and officer training, data migration of existing registers.
- Provider decision guide: capabilities matrix per adapter and how to add a new one using the conformance suite.
- Demo tenant with synthetic data; admin and API documentation; licensing and versioning policy; upgrade path so tenants can take new core releases without forks.

_Acceptance:_ a new fake state is created, configured, and passes the smoke suite in under a day by someone who has not seen the code.

### Phase 12: Pilot support and final touches

- Pilot tooling: parallel-run reports against the old paper process, feedback capture.
- Copy and accessibility pass on SMS, USSD, and app text per language.
- Operations handover: on-call, SLAs, incident process, backup test schedule.

## 10. Do not do

- Do not put vendor SDK calls outside `packages/adapters`.
- Do not branch on tenant identity in code.
- Do not let any client (dashboard, field app) talk to the database or bypass the API.
- Do not let the offline cache classify a vehicle as UNPAID.
- Do not update or delete ledger or audit rows, ever.
- Do not store secrets, card data, or unnecessary personal data.
- Do not add a dependency without recording the alternative considered in an ADR.
