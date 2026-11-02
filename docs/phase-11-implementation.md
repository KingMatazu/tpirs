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

## Step 5: Setup API and the credential gate (delivered)

- `GET /v1/setup/status` — `{ needsSetup }`, unauthenticated, rate limited like
  login.
- `POST /v1/setup/tenant` — creates the tenant from the wizard's answers;
  `404` once a tenant exists; `422` with every failing path at once. Answers are
  the config factory's input plus `adminEmail`; money stays in minor units on the
  wire and the dashboard converts, as everywhere else in this contract.
- **`POST /v1/auth/complete-onboarding` rather than `/v1/setup/complete`.** The
  step that replaces the provisioning credentials is authenticated (by the
  temporary session) and issues the session the person continues with, so it
  belongs with the other session routes. A separate unauthenticated
  `/v1/setup/complete` would have been a second way to claim a tenant, and the
  rules it enforces — the caller is the temporary account, and only that account
  may rotate — are auth rules.
- `apps/api/src/auth.ts`: `enforceCredentialRotation()` runs after
  `authenticate` and refuses every route except `complete-onboarding`, `logout`,
  `refresh` and `me` with `403 must_change_credentials`. The flag is read from
  the `users` row on every request, so a token minted before the flag clears
  cannot outlive it.
- Session and `/v1/auth/me` responses expose `mustChangeCredentials` so a client
  routes on it instead of guessing from a `403`.
- Recorded as ADR 0049.
- **Tests use a database that is genuinely empty.** The shared integration
  database carries tenants from every other suite, and a tenant cannot be deleted
  (append-only `audit_log`), so `setup.routes.test.ts` creates and drops its own
  database. `migrateUp` had to run there too, which is why migration `0002` now
  creates `tpirs_app` only if it is absent — roles are cluster-wide while the
  schema is per database, and `down` already used `if exists`.
- Regenerate `packages/api-client` (API build, then client build).

## Step 6: Admin onboarding wizard (4 parts)

Split into four shippable parts; each lands with its own tests:

1. **Detection and shell (delivered).** `useSession` learns `needsSetup` by
   calling `GET /v1/setup/status` during `initialize`; `App` shows the wizard
   before the sign-in screen when onboarding is needed; `SetupPage` renders the
   neutral-token shell and the four-step indicator outside `Layout`.
2. **State, levy and review (steps 1–3) (delivered).** The real form: tenant
   identity, currency, timezone, language; levy amounts in major units converted
   to minor on submit via `@tpirs/ui-tokens`' `parseMajorToMinor`; USSD code and
   SMS sender id; a review; `POST /v1/setup/tenant` with `issues` mapped to
   fields and a rejection landing the operator on the first failing field;
   advance to step 4 carrying the slug.
3. **Credentials (step 4) (delivered).** Live rule validation (no `admin`, no
   `password`, six characters, not the username), the wizard signs in with the
   temporary account automatically and hands off to a `CredentialForm`, which
   calls `POST /v1/auth/complete-onboarding` and stores the returned session.
4. **Forced-credential redirect and the full acceptance tests (delivered).**
   `mustChangeCredentials` rides on the session and `/v1/auth/me`; `App` sends an
   authenticated-but-flagged account straight to `CredentialForm` rather than a
   dashboard every request would refuse, and completing onboarding lands the new
   admin inside the dashboard.

Original scope:

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

## Step 7: `pnpm setup` semantics (delivered)

- `scripts/setup.mjs`: no seed by default; `--seed` installs demo tenants; prints
  the onboarding URL; `ALLOW_DEMO_SEED` guard for non-interactive runs.
- `scripts/ci/backup-check.sh` and `.env.example` updated to the new flags.
- Docs (`README.md`, `AGENTS.md`, `docs/runbooks/local-development.md`) no
  longer describe `pnpm setup` as seeding.

## Step 8: Zone management, 11.0b (delivered)

- `GET/POST/PATCH /v1/zones` behind `zone:read` / `zone:manage` (nested zones
  already supported by the table). Create takes an optional `parentZoneId`;
  rename is name-only, because a re-parent is how a tree becomes a cycle.
- `apps/admin/src/pages/ZonesPage.tsx` — a permission-aware **Zones** screen
  (its own nav entry, since `zone_supervisor` holds `zone:manage` but not
  `tenant:read`). It renders the tree, adds a zone under a chosen parent, renames
  in place, and says plainly that an empty list is valid.
- Migration `0020` adds a partial unique index for top-level names: the original
  `unique (tenant_id, parent_zone_id, name)` never covered roots, because SQL
  treats two `NULL` parents as distinct.
- Tests: create + child + rename + duplicate `409` + cross-tenant isolation; a
  read-only role lists but cannot mutate; the admin screen covers the empty
  state and both mutations.

## Step 9: User management, 11.0b (delivered)

- `GET /v1/users`, `POST /v1/users`, `PATCH /v1/users/:id`,
  `POST /v1/users/:id/password` behind `user:read` / `user:manage`, plus
  `GET /v1/roles` behind `role:read` for the role picker. Create takes an email
  and at least one role; edit covers display name, status and the role set; the
  password route sets a new **temporary** password and ends the account's live
  sessions.
- `apps/admin/src/pages/UsersPage.tsx` — a **Users** screen on `user:read`:
  create with role checkboxes, enable/disable, edit roles, reset a password. It
  hides the editors on the signed-in administrator's own row, because the server
  refuses self-service and the screen should not offer what it will reject.
- A created account is flagged `mustChangeCredentials`, so the credential gate
  built in Step 6 sends it to `CredentialForm` at first sign-in; that screen's
  copy is now neutral ("Choose your credentials") instead of wizard-only.
- Rules live in `@tpirs/application/src/user-service.ts`: username/email/password
  validation (min 6, not `password`, not the username), the self-service ban,
  and "reset ends sessions" in one transaction.
- Tests: create + first-sign-in gate + disable + reset + session revocation +
  self-edit `409` + `403` for a role without `user:manage` + cross-tenant `404` +
  an audit assertion that no password text ever reaches the trail.

## Step 10: Documentation and productization (delivered)

- `docs/onboarding/README.md` — the deployment checklist: day-one decisions and
  approvals, install and environment values, the four wizard steps and what they
  write, zones and staff accounts, provider bindings, verification with
  `pnpm smoke`, register migration and sticker production, training, operations
  runbooks, and a **known gaps** list (payment webhook endpoint provisioning, no
  mail sender, mock OTP/cache/clock wiring, no TOTP field, no bulk import,
  manual infrastructure).
- `tenants/_template/README.md` — rewritten for the current flow: the live config
  is in the database and written by the wizard or the config API; the file is a
  reviewed reference and a schema canary, not a startup input. The YAML stays
  current and a config test loads it through the real validator.
- [`docs/onboarding/provider-decision-guide.md`](../onboarding/provider-decision-guide.md)
  — how a tenant selects an adapter, where each port is wired, the payment-gateway
  criteria (settlement account control, settlement reporting, webhook signing,
  feature-phone reach), SMS/USSD approvals, the acceptance bar for a new adapter,
  and the wiring gaps.
- [`docs/onboarding/provider-matrix.md`](../onboarding/provider-matrix.md) —
  generated by `scripts/provider-matrix.mjs` (exposed as
  `pnpm docs:providers` / `pnpm docs:providers:check`) from each adapter's own
  `capabilities()` call, so the table cannot drift from the code.
- [`docs/versioning-and-upgrades.md`](../versioning-and-upgrades.md) — whole-repo
  release tags, the compatibility promise (API, config, migrations, permissions,
  ports), licensing status and the decision required before resale, the release
  checklist, the tenant upgrade procedure, the support window, and the "config,
  then plugin, then core" rule that prevents forks.
- `README.md` and `docs/runbooks/local-development.md` point at the onboarding
  path and use `pnpm setup` (no seed) as the default quick start.

## Step 11: Katsina acceptance run (delivered)

`tenants/katsina-state/` holds the reference config the run produced, plus a
README explaining that it was exported from a real deployment rather than written
by hand and that its approved-but-fake values must be replaced. A config test
loads it through the real validator, so a schema change that would reject an
existing tenant fails the suite.

The run was performed against a **scratch database**, not the development
database:

```sh
docker exec tpirs-postgres-1 psql -U tpirs -d postgres -c "create database tpirs_katsina"
DATABASE_URL=postgres://tpirs:tpirs@localhost:5433/tpirs_katsina pnpm --filter @tpirs/db migrate up
DATABASE_URL=...tpirs_katsina API_PORT=3100 pnpm --filter @tpirs/api exec tsx src/index.ts
```

Then the wizard's exact HTTP sequence (the same calls `SetupPage` and
`CredentialForm` make) was driven against `:3100`: status → create tenant →
temporary sign-in → complete onboarding → authenticated read of the config.

| Check                                                 | Result                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| `GET /v1/setup/status` on an empty database           | `{"needsSetup":true}`                                         |
| `POST /v1/setup/tenant` with the Katsina answers      | `201`, `temporaryUsername: "admin"`                           |
| Temporary sign-in (`admin` / `password`)              | `200`, `mustChangeCredentials: true`, role `system_admin`     |
| `POST /v1/auth/complete-onboarding` (`katsina.admin`) | `200` with a session token and `mustChangeCredentials: false` |
| `GET /v1/auth/me` with that token (auto-login)        | `200`, the full `system_admin` permission set                 |
| `GET /v1/tenants/current/config`                      | the exported config, now `tenants/katsina-state`              |
| `pnpm smoke http://127.0.0.1:3100`                    | OK, with a request id on every response                       |
| `GET /v1/setup/status` after provisioning             | `{"needsSetup":false}`                                        |
| Replay of `POST /v1/setup/tenant`                     | `404` with the standard envelope                              |
| Sign-in with the new credentials, flag cleared        | `200`, `mustChangeCredentials: false`                         |

Elapsed from tenant creation to authenticated config export: **53 seconds**, with
no retries. The wizard created one tenant, the seven system roles, the first
account and **no zones**.

**What this run does not prove.** No browser automation was available, so the
flow was driven over HTTP exactly as the wizard drives it; the wizard's own
component tests cover the form behaviour, but a human clicking through it was not
part of this run. Nor was a person who had never seen the code available, so the
brief's "by someone who has not seen the code" is **not** demonstrated here. The
places the run still needed code knowledge are recorded so Step 10's runbook can
absorb them:

1. Minting the payment webhook endpoint token has no route or screen
   (`payment.provisionEndpoint` is a service call). This is the one real
   productization gap the run found; it is listed in the onboarding guide.
2. Payment adapters are registered in `apps/api/src/index.ts`, so a new gateway
   is a composition-root change as well as a config binding. The provider guide
   says so, but a deployer cannot do it from the browser.
3. Creating the scratch database and pointing the API at it are operator steps,
   not wizard steps. They belong in the staging deployment runbook
   (`docs/runbooks/adding-a-deploy-target.md`) rather than in onboarding.
4. Config changes after onboarding go through `PUT /v1/tenants/current/config`;
   the dashboard still has no editor (D56). The onboarding guide says this, but
   it is the second place a deployer needs an engineer.
5. OTP delivery, cache, lock service and clock remain mock-wired; the onboarding
   guide lists them as known gaps.

## Step 12: Gates and delivery (delivered)

- `pnpm format` → `pnpm lint` → `pnpm typecheck` → `pnpm test`: each turbo run
  finished 94/94 (test included the admin credential-gate copy change and the
  config test that loads the Katsina reference).
- `sh scripts/ci/verify.sh` (the CI rehearsal): install, lint 94/94, typecheck
  94/94, build 94/94, then the new `pnpm docs:providers:check` — the generated
  matrix is current.
- `sh scripts/ci/integration.sh`: scratch Postgres on `:55433`, every migration,
  the full suite with `TEST_DATABASE_URL` set. 94/94 tasks; the DB-backed suites
  actually executed (api 110 tests, application 190, config 67, admin 232,
  worker 2, job queue 10) instead of skipping.
- `sh scripts/ci/migration-check.sh`: all migrations apply and roll back cleanly
  (through `0020`).
- `pnpm smoke` still checks health, readiness and the request id. It now also
  drives onboarding when `SMOKE_ONBOARD=1`: status → create tenant → temporary
  sign-in → credential replacement → authenticated read → setup window closed →
  replay `404`. Verified against a fresh scratch API: **3 seconds**, tenant
  `smoke-*`, then the database was dropped. The flag is documented as
  scratch-deployment-only because it creates a tenant.

## Acceptance mapping

| Brief requirement                                           | Delivered by                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `tenant:create` tooling scaffolded from `tenants/_template` | Steps 2, 3, 5, 6                                                     |
| Validate config                                             | Step 2 (validator unchanged, factory tested)                         |
| Provision infra                                             | Deferred — D1 is open and the deploy target is `noop`                |
| Seed roles                                                  | Step 3                                                               |
| Run smoke tests                                             | Steps 10, 12 (`pnpm smoke`, plus `SMOKE_ONBOARD=1`)                  |
| Onboarding checklist and runbook                            | Step 10                                                              |
| Provider decision guide                                     | Step 10 (guide + generated matrix)                                   |
| Demo tenant with synthetic data                             | `pnpm setup --seed` (Step 4/7)                                       |
| Licensing and versioning policy, upgrade path               | Step 10                                                              |
| A new state created and smoke-tested in under a day         | Step 11 (HTTP-driven; human/new-person check recorded as not proven) |

## Deferred

- **`SETUP_TOKEN`.** Off by design in this phase; required before any deployment
  is reachable from the internet or hosts more than one tenant.
- **A screen for payment webhook endpoints.** The token is minted by
  `payment.provisionEndpoint(...)`, a service call used by tests; a deployment
  needs engineering to provision it and hand the URL to the gateway. This is the
  first productization gap the acceptance run found.
- **Email provider and self-service password reset.** Email is an identifier
  until a sender exists; an admin sets temporary passwords in the meantime.
- **Real OTP delivery.** The composition root still passes the mock SMS provider
  to the OTP service; the per-tenant SMS adapter covers channel replies and
  receipts only.
- **Infrastructure provisioning.** D1 (hosting and data residency) is unresolved
  and the deploy target is `noop`, so "provision infra" would be a stub.
- **A vendor-facing provisioning console.** Discussed and dropped for now; the
  HTTP contract it would call is delivered here, so it becomes a thin client.
- **Multi-tenant onboarding.** The zero-tenant gate deliberately supports the
  dedicated-deployment default only.
