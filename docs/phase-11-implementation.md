# Phase 11 implementation: productization and onboarding

Phase 11 is the phase that makes the platform sellable to a second state. The
build brief's acceptance check is: **a new fake state is created, configured and
passes the smoke suite in under a day, by someone who has not seen the code.**

Today that is impossible, and not for a small reason. A fresh database cannot be
onboarded at all: there is no way to create a tenant, a role, a user or a zone
outside `packages/db/src/seed.ts`. This plan closes that by making onboarding a
**first-run web flow backed by one provisioning service**, then uses the first
real tenant (Katsina) as the acceptance run.

## What already exists (delivered before this phase)

| Area                                       | Where                                      | State       |
| ------------------------------------------ | ------------------------------------------ | ----------- |
| Tenant config schema, loader, validator    | `packages/config`                          | completed   |
| System role definitions (7 roles)          | `packages/domain/src/tenancy.ts`           | completed   |
| Tenant config read/write + audit           | `apps/api/src/routes/config.ts` (ADR 0047) | completed   |
| Demo provisioning (the only path)          | `packages/db/src/seed.ts`, `seed-cash.ts`  | completed   |
| Staff auth, sessions, refresh, throttle    | `apps/api/src/routes/auth.ts` (ADR 0046)   | completed   |
| Admin shell, permission-aware nav, theming | `apps/admin`                               | completed   |
| Config viewer, audit search                | `ConfigViewerPage.tsx`, `AuditPage.tsx`    | completed   |
| Generated API client                       | `packages/api-client`                      | completed   |
| Integration + smoke harnesses              | `scripts/ci/integration.sh`, `smoke.sh`    | completed   |
| Onboarding runbook, `tenant:create`        | —                                          | **missing** |
| Zone management (routes + screen)          | —                                          | **missing** |
| User management (routes + screen)          | —                                          | **missing** |

## Gaps this phase closes

1. **No tenant creation path.** `repositories.tenants.create()` is called only by
   the seed and by tests. `apps/api/src/routes/` has no `tenants.ts`, `users.ts`,
   `roles.ts` or `zones.ts`. On an empty database the login form is a dead end.
2. **The seed is the de-facto provisioner, and it is unsafe.** `pnpm setup` runs
   it unconditionally, so a real deployment would receive `alpha.admin` with a
   password written in the source.
3. **`user:manage` and `zone:manage` are permissions with no route behind them.**
   A newly provisioned tenant would have one admin and no way to add an officer,
   a collector, a finance user or a zone. Onboarding would produce a demo-able but
   non-operational tenant.
4. **No credential lifecycle.** `users` has `password_hash` and nothing else: no
   email, no forced-change flag, no endpoint to set a password.
5. **The demo tenant copy is inline in the seed**, so a provisioned tenant would
   need hand-written USSD/SMS catalogues with no source for the text.
6. **Onboarding documentation does not exist**, `tenants/_template/README.md`
   still claims the schema "arrives in Phase 1", and there is no provider
   decision guide or versioning/upgrade policy.

## Scope decisions

- **Onboarding is a web flow, not a CLI.** A state official never installs
  anything. `pnpm setup` prepares the machine (dependencies, `.env`, containers,
  migrations) and prints the onboarding URL; the wizard runs in `apps/admin`.
- **The setup endpoints exist only while the deployment has no tenant.** After the
  first tenant is created they return `404`, so the capability cannot be replayed.
  No `SETUP_TOKEN` in this phase: the person running setup and the person using
  the wizard are the same team today. Revisit when a deployment is internet-facing
  or hosts several tenants (recorded as deferred, below).
- **The temporary account can do exactly one thing.** Provisioning creates
  `admin` / `password` with `must_change_credentials`; every route except
  complete-onboarding and logout refuses it, so the window is not a data-access
  window.
- **Step 4 replaces both credentials.** The new username and password are
  validated server-side: username must not be `admin`, must match
  `^[a-z0-9._-]{3,40}$`; password must be at least 6 characters, must not be
  `password`, and must not equal the username. Completion returns a session, so
  the person lands signed in (auto-login).
- **Email is a required account identifier, not a channel.** It is unique per
  tenant and stored from day one because password reset will need it, but no
  email is sent in this phase, and self-service reset stays deferred until an
  email provider exists.
- **Zones are optional per tenant and are never a wizard question.** A tenant with
  zero zones is valid today (`assets.zone_id`, `scans.zone_id` and
  `cash_intakes.zone_id` are nullable), so the tenant decides after sign-in by
  creating zones from Configuration or by leaving the list empty.
- **The seed becomes opt-in.** `pnpm setup` provisions nothing; `pnpm setup
--seed` installs the alpha/beta demo tenants for local development. The demo
  seed refuses to run against `NODE_ENV=production` unless `ALLOW_DEMO_SEED=true`.
- **One provisioning path.** `@tpirs/db` must not depend on `@tpirs/application`
  (`seed-cash.ts` already records why), so the row-writing routine lives in
  `packages/db/src/provisioning.ts` and the rules live in
  `packages/application/src/onboarding-service.ts`. Both the setup endpoints and
  the demo seed call the same routine, so they cannot drift.
- **The default config comes from the catalogue package.** `@tpirs/config` gains a
  workspace dependency on `@tpirs/i18n` so `defaultTenantConfig()` can ship
  complete `en`/`fr` channel copy. The validator still rejects an incomplete
  catalogue, and a test asserts every runtime key exists in every language.
- **Provisioning is audited, and the ledger is untouched.** `tenant.provision` and
  `auth.credentials_changed` rows carry `tenant_id = null` (permitted by the
  existing `audit_log` policy), never a password hash.

## Decisions recorded in this phase

These are settled by this plan and will be written up as they land:

| Decision                              | Record                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| Password policy                       | 6-character floor, `password` rejected, must differ from username — `decisions-needed.md` |
| Email as identifier only              | No sender exists; reset deferred until one does — runbook note                            |
| Setup window closes permanently       | Zero-tenant gate, `404` afterwards — ADR                                                  |
| Zones optional, no config flag        | Nullable references make zero zones valid — ADR                                           |
| Provisioning is a service, not a seed | One routine shared by setup and demo seed — ADR                                           |
| `@tpirs/config` → `@tpirs/i18n`       | Catalogue copy cannot be invented by config — ADR                                         |

## Step 0: Reconcile the plan and fixtures (planned)

- Land this plan, and update `AGENTS.md`, `README.md` and
  `docs/runbooks/local-development.md`, whose `pnpm setup` description changes.
- Commit: `docs(phase-11): plan onboarding and productization`.

## Step 1: Schema (planned)

Migration `0019_onboarding.ts`:

- `users.email citext`, unique per tenant where present, backfilled for seeded
  users (`<username>@<tenant-slug>.example.gov`) so the column can be required by
  new writes without breaking existing rows.
- `users.must_change_credentials boolean not null default false`.
- No new tables. Onboarding state is derived (`select count(*) from tenants`).

## Step 2: Message catalogue and default config (planned)

- `packages/i18n/src/channel-catalogs.ts`: complete `en`/`fr` catalogues, copy
  moved out of `seed.ts` and made app-neutral (no `{appName}` placeholder, which
  the menu prompt cannot supply).
- `packages/config/src/defaults.ts`: `defaultTenantConfig(answers)` producing a
  fully valid `TenantConfig` from ~12 wizard answers, plus `SUPPORTED_LANGUAGES`.
- `defaults.test.ts`: every `CHANNEL_MESSAGE_KEYS` entry and every key the menu
  graph references is present in every language, and the factory output passes
  `validateTenantConfig`.

## Step 3: Provisioning routine and onboarding service (planned)

- `packages/db/src/provisioning.ts`: `provisionTenantRows(db, { config, admin, zones })`
  — create tenant, the seven `SYSTEM_ROLES` with their permissions, zones, and
  the first user with `must_change_credentials`. Idempotent per slug; returns the
  tenant id and user id. System-scoped (`withSystem`), documented as the only
  legitimate caller of that helper outside tests.
- `packages/application/src/onboarding-service.ts`:
  `needsSetup(db)`, `startOnboarding(...)` (validate answers → default config →
  `validateTenantConfig` → provisioning routine → audit), and
  `completeOnboarding(...)` (credential rules, rename, new password hash, clear
  the flag, audit, issue a session).

## Step 4: Seed refactor and guards (planned)

- `seed.ts` keeps only demo fixtures and the demo cash day; tenant, role, zone and
  user rows come from the shared routine. `runSeed` refuses `NODE_ENV=production`
  unless `ALLOW_DEMO_SEED=true`.

## Step 5: Setup API and the credential gate (planned)

- `GET /v1/setup/status` — `{ needsSetup }`, unauthenticated, `404`-free but
  rate-limited like login.
- `POST /v1/setup/tenant` — creates the tenant; `404` once a tenant exists;
  `422` with per-path issues when the answers fail validation.
- `POST /v1/setup/complete` — sets the new username and password, returns the
  session pair, and `404`s once the flag is clear or a tenant exists.
- `apps/api/src/auth.ts`: a `must_change_credentials` principal may reach only
  `POST /v1/auth/complete-onboarding` and logout; everything else is
  `403 must_change_credentials`.
- `auth/me` exposes the flag so the dashboard can redirect.
- Regenerate `packages/api-client` (API build, then client build).

## Step 6: Admin onboarding wizard (planned)

- `apps/admin/src/pages/SetupPage.tsx`: 4 steps — state details (name, slug
  derived and editable, legal entity, support email, email for the account,
  currency, timezone, language); levy amounts in **major units** (`NGN 300.00`)
  plus USSD code and SMS sender id; review; then new username and password with
  live rule validation.
- First-run detection before the login screen: `needsSetup` wins.
- Neutral tokens while no tenant config exists (the page renders outside
  `Layout`, like `LoginPage`).
- On completion: store the session and land on the first permitted route.
- Tests: wizard renders on a fresh install, rejects `admin`/`password`, blocks a
  5-character password, and lands the new admin inside the dashboard.

## Step 7: `pnpm setup` semantics (planned)

- `scripts/setup.mjs`: no seed by default; `--seed` installs demo tenants; prints
  the onboarding URL; `ALLOW_DEMO_SEED` guard for non-interactive runs.
- `scripts/ci/backup-check.sh` and `.env.example` updated to the new flags.

## Step 8: Zone management, 11.0b (planned)

- `GET/POST/PATCH /v1/zones` behind `zone:read` / `zone:manage` (nested zones
  already supported by the table).
- Configuration panel in `apps/admin` to add and rename zones, and to explain
  that leaving the list empty is valid.
- Tests: create + rename + cross-tenant isolation; a collector cannot manage.

## Step 9: User management, 11.0b (planned)

- `GET/POST/PATCH /v1/users` behind `user:read` / `user:manage`: create with
  email, assign a role, disable, and reset a password (admin-set temporary
  password, since there is no sender yet).
- Configuration panel listing users, roles and status; role assignment uses the
  seven seeded roles read from `role:read`.
- Negative tests: a user cannot grant themselves a role, an officer cannot reach
  the endpoint, and no password ever appears in an audit row or a log line.

## Step 10: Documentation and productization (planned)

- `docs/onboarding/README.md`: the checklist a new deployment follows — config
  values needed, settlement account, gateway choice, USSD shortcode and sender-id
  approval, sticker production, staff and officer training, register migration.
- `tenants/_template` refreshed (config plus a README that describes the current
  flow, not Phase 1).
- Provider decision guide: capabilities matrix generated from each adapter's
  declared capabilities, with the conformance suite as the acceptance bar.
- Versioning, licensing and upgrade policy: how a tenant takes a core release
  without forking.

## Step 11: Katsina acceptance run (planned)

- `tenants/katsina-state/tenant.config.yaml` committed as a reference config.
- Provisioned **through the wizard**, exactly as a customer would: state details,
  email, fees, then new credentials, then auto-login.
- Recorded in the acceptance table with the elapsed time, and a note of every
  place the runbook needed a person who had seen the code.

## Step 12: Gates and delivery (planned)

`pnpm format` → `pnpm lint` → `pnpm typecheck` → `pnpm test`, then
`scripts/ci/integration.sh`, `pnpm smoke` (extended to drive
setup → complete → login over HTTP) and `scripts/ci/migration-check.sh` for
`0019`.

## Acceptance mapping

| Brief requirement                                           | Delivered by                                          |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| `tenant:create` tooling scaffolded from `tenants/_template` | Steps 2, 3, 5, 6                                      |
| Validate config                                             | Step 2 (validator unchanged, factory tested)          |
| Provision infra                                             | Deferred — D1 is open and the deploy target is `noop` |
| Seed roles                                                  | Step 3                                                |
| Run smoke tests                                             | Steps 10, 12                                          |
| Onboarding checklist and runbook                            | Step 10                                               |
| Provider decision guide                                     | Step 10                                               |
| Demo tenant with synthetic data                             | `pnpm setup --seed` (Step 4/7)                        |
| Licensing and versioning policy, upgrade path               | Step 10                                               |
| A new state created and smoke-tested in under a day         | Step 11                                               |

## Deferred

- **`SETUP_TOKEN`.** Off by design in this phase; required before any deployment
  is reachable from the internet or hosts more than one tenant.
- **Email provider and self-service password reset.** Email is an identifier
  until a sender exists; an admin sets temporary passwords in the meantime.
- **Infrastructure provisioning.** D1 (hosting and data residency) is unresolved
  and the deploy target is `noop`, so "provision infra" would be a stub.
- **A vendor-facing provisioning console.** Discussed and dropped for now; the
  HTTP contract it would call is delivered here, so it becomes a thin client.
- **Multi-tenant onboarding.** The zero-tenant gate deliberately supports the
  dedicated-deployment default only.
