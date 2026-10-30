# UI track: the web admin dashboard

This document is the working plan for the web UI of `AGENTS.md`. It ran
**alongside phases 5–8** so that Phase 9 (the official admin-dashboard phase)
would be assembly rather than a big-bang build. Phase 9 completes the remaining
screens and the shell acceptance; its working plan is
[`phase-9-implementation.md`](./phase-9-implementation.md). This document covers
`apps/admin` only; the officer field app and its offline store are deferred
entirely (D29).

**Status: closed 2026-10-30.** Every screen the brief asks for is delivered and
tested; three items are knowingly left open and listed under
[Closing the track](#closing-the-track-2026-10-30).

## Scope decisions carried into this track

- **Stack: React + Vite SPAs, TypeScript end to end** (D27). Components are a
  shadcn-style copy-in layer (Tailwind styling, Radix behavior), forms are
  react-hook-form + zod, server state is TanStack Query, session/nav state is
  zustand. UI e2e tests were planned in Playwright; they are not wired, and the
  flows are covered by jsdom page tests plus the API integration suite.
- **Clients only talk to the API.** No component fetches a URL by hand;
  everything goes through `packages/api-client`, generated from the OpenAPI
  document the server emits (D28).
- **Session:** short-lived bearer in memory, refresh token in an httpOnly,
  `SameSite=strict` cookie scoped to `/v1/auth/refresh`, `Secure` only over
  HTTPS, server-side rotation (D26).
- **Theming is data.** Colors, app name, logo, currency, and number/date
  formats come from tenant config through `packages/ui-tokens` as CSS custom
  properties. No tenant literals anywhere in `apps/*`.
- **Admin-only for now.** The field PWA, the offline store (D29), officer
  scan log, disputes inbox, and any native app are deferred with officer
  tooling.
- **Pay-per-use wording is strict**, as everywhere else: a day with no payment
  is "no payment recorded today", never "unpaid" or a debt.

ADRs to record at implementation: `0025-ui-delivery-and-api-client.md`,
`0026-dashboard-session-model.md`, `0027-ui-tokens-and-component-base.md`.

## Step 0: Contracts, client, tokens (backend phases 0–4 already exist)

1. Add JSON Schemas to the existing Fastify routes and emit the OpenAPI 3
   document with `@fastify/swagger`, served at a versioned path. The
   document is the contract; every new route updates it in the same change
   (D28).
2. Add `packages/api-client`: generated types plus `openapi-fetch`, exported
   with the shared plumbing — idempotency-key attachment on money-affecting
   POSTs, request-ID extraction, and the error-envelope parser.
3. Add `packages/ui-tokens`: maps `tenantConfig.branding` and `locale` into
   CSS custom properties and format helpers. Swapping tenants re-themes with
   zero code changes — the Phase 9 acceptance criterion — so the token
   pipeline is built first, not last.
4. Scaffold `apps/admin`: Vite + React + strict TS, Tailwind, Radix/shadcn
   copy-in components, TanStack Query, zustand, react-hook-form with zod
   schemas derived from the generated types, Playwright wired to the turbo
   `test` task.
5. Wire the new packages into turbo (`dependsOn: ^build` so `apps/admin`
   builds after `packages/api-client` and `packages/ui-tokens`), lint, and
   CI. `pnpm-workspace.yaml` globs already cover `apps/*` and `packages/*`.

## Step 1: Auth shell and app conventions

1. Login screen: `tenantSlug` + password + TOTP against the existing
   `/v1/auth/login`; `/v1/auth/me` drives roles; logout.
2. D26 session handling: access token in memory; transparent
   refresh-and-retry on the first 401 after a reload. Requires a new
   `/v1/auth/refresh` route and API plumbing — added and documented in this
   step, not before the UI needs it.
3. Shared conventions: error-envelope toasts that always surface the
   request ID; cursor-pagination primitives; idempotency keys on every
   money-affecting POST the UI issues.
4. Navigation shell with placeholder entries so later screens slot in
   without re-architecture.

## Step 2: Registry screens (backend phase 2, exists)

- Asset list with search and filters; asset detail rendering attributes
  dynamically from the `AssetSchemaRegistry` schema (string, number, date,
  enum, required, pattern) — never hardcoded field lists.
- Photo upload and viewer; sticker preview and SVG download (public
  `GET /v1/assets/:id/sticker`).
- Suspend and audited correction flows (the PATCH is audited server-side;
  the UI shows the resulting audit trail entry).
- Owners: create, detail, OTP verify request/confirm.

## Step 3: Payments screens (backend phase 4, exists)

- Payments list with daily totals.
- Suspense list and resolve flow — an idempotent, role-gated POST with a
  confirmation dialog naming the amount, asset, and provider reference.
- Per-payment outbox/receipt delivery status so finance can see that a
  receipt sent (or is retries pending) without touching the provider page.
- Under `pay_per_use`, unpaid-day copy follows the strict wording; no
  reminders and no debt language anywhere.

## Step 4: Config viewer

Read-only display of the validated tenant config grouped as the schema
groups it: identity, locale, branding, asset types, obligation rules,
providers, channels, cash rules, flags. Role-gated visibility (finance admin
and system admin; auditor read-only). The `PUT /v1/tenants/current/config`
route exists but the UI deliberately stays read-only until Phase 9 builds
proper, role-aware config screens with audited confirmation.

## Step 5: Driver channels (lands with phase 5 backend)

1. Channels section of the config viewer: USSD menu graph shown read-only
   from `channels.menus`, message catalogue per language, session and
   rate/cost limits.
2. USSD simulator: runs the same pure `advanceUssdSession` engine from
   `@tpirs/domain` in the browser against the tenant's config and i18n
   translator. This is the tool that makes the Phase 5 acceptance check
   ("menu changes made only in tenant config alter behavior") demonstrable
   without a phone.

## Step 6: Audit screen (prerequisite: backend gap)

No audit listing route exists today — only the append-only audit table and
its middleware. Add `GET /v1/audit` (tenant-scoped, cursor pagination,
filters for actor, kind, and date range) plus its OpenAPI schema, then build
the searchable audit trail screen on it. Audit rows are never editable, so
the screen is read-only by construction.

## Step 7: Collectors (lands with phase 7 backend)

Collectors list, per-collector wallet and float position, cash intake
history, deposit matching, deposit-deadline status, freeze state and
permission-gated unfreeze, zone supervisor roll-ups. Freeze and unfreeze are
config-driven behaviors; the UI reads the state the backend computes and
never duplicates the policy.

## Step 8: Reconciliation, reports, anomalies (lands with phase 8 backend)

- Reconciliation run history and the exceptions queue, with tolerances
  displayed next to every difference.
- Reports through `ExportService` (CSV/PDF/XLSX downloads) by day, zone,
  collector, and asset type. Compliance copy must follow the phase 8 rule:
  computed from scan results (paid scans ÷ total scans), never from paid
  days ÷ registered assets.
- Configurable anomaly alert feed; auditor read-only view. Under
  `pay_per_use`, a vehicle with no payments is never shown as an anomaly.

## Step 9: Phase 9 assembly (the brief's official dashboard phase)

Tracked in [`phase-9-implementation.md`](./phase-9-implementation.md):

- Roles-aware navigation rendered from permissions-as-data; system admins do
  not see ledger screens.
- i18n language switch driven by `locale.enabledLanguages`, using the
  `@tpirs/i18n` translator pattern for dashboard copy.
- Reversals workflow with dual approval: requester and approver must be
  distinct users, enforced server-side, reflected in the UI as a
  second-approval action on the queue.
- Registry, payments/suspense and a disputes inbox complete the screen list.
- Final acceptance of the whole track: switching tenants re-themes and
  re-labels the dashboard with no code changes.

## Acceptance gates for the track

| Gate                                                                                                                                                    | Result                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm format` → `pnpm lint` → `pnpm typecheck` → `pnpm test`, `apps/admin` with its own `vitest.config.ts`                                              | met — 187 tests across 24 files at close-out                                 |
| Playwright e2e: login (TOTP) → find asset → sticker → payment → resolve suspense → audit trail                                                          | **waived** — not wired; see "Remaining" below                                |
| Negative tests: refresh exactly once then fail closed; cross-tenant 403 with the error envelope and request id; double-submitted money POST is harmless | met — `session.test.ts`, `App.test.tsx`, `paymentsView`/`PaymentsPage` tests |
| Re-theme test across the two seed tenants; no tenant literals in `apps/*`                                                                               | met — `Layout.test.tsx` ("re-themes and re-labels from the beta fixture")    |
| OpenAPI emission part of CI so contract and server cannot drift                                                                                         | met — `packages/api-client/scripts/generate.mjs`, run by its `build`         |

## Status (updated 2026-10-30)

| Step | Scope                                                               | Status                                          |
| ---- | ------------------------------------------------------------------- | ----------------------------------------------- |
| 0    | OpenAPI emission, `api-client`, `ui-tokens`, admin scaffold         | completed (Playwright e2e not wired — deferred) |
| 1    | Auth shell, D26 session, toasts, pagination, nav shell              | completed (TOTP input included)                 |
| 2    | Registry screens                                                    | completed (Phase 9)                             |
| 3    | Payments and suspense screens                                       | completed (Phase 9)                             |
| 4    | Config viewer (read-only)                                           | completed                                       |
| 5    | Channels viewer and USSD simulator                                  | completed                                       |
| 6    | Audit backend (`GET /v1/audit`) and audit screen                    | completed                                       |
| 7    | Collectors (cash wallet, deposits, freeze/unfreeze)                 | completed                                       |
| 8    | Reconciliation, reports and anomaly feed                            | completed (Phase 8)                             |
| 9    | Phase 9 assembly: registry/payments/disputes/reversals, i18n switch | completed (Phase 9)                             |

Delivered in the track: `packages/ui-tokens` (tokens + Intl helpers, tests),
`apps/admin` (scaffold, login with the D26 cookie/refresh session store, the TOTP
field, error-envelope toasts with request IDs, cursor pagination,
permission-aware nav), the config viewer, channels + in-browser USSD simulator
(pure `advanceUssdSession` + `createTranslator`), the audit
route/repository/screen, collectors, reconciliation, reports, and — with Phase 9 —
the registry, payments/suspense, disputes inbox and reversals screens plus a
catalogue-driven language switch and the tenant-aware shell acceptance test. ADRs
0025–0027 record the decisions.

## Closing the track (2026-10-30)

The track is closed: every screen the brief asks for exists and is tested, and
the acceptance gate that mattered — switching tenants re-themes and re-labels the
dashboard with no code changes — is proven by the two-fixture shell test. Three
items are knowingly left open, recorded here so nobody reads the closure as a
claim they were done.

### Remaining, with reasons

- **Page translation (deferred to Phase 11).** Only the shell and navigation are
  catalogue-driven: `apps/admin/src/lib/uiCopy.ts` currently holds `nav.*` and
  `shell.*` keys, and the language switch re-labels exactly those. **Every page**
  — the Phase 9 screens included, not only the pre-Phase-9 ones — still renders
  English literals. Migrating them is a mechanical sweep of several hundred
  strings across a dozen pages that touches every page test; it changes no
  behaviour, blocks no other work, and is better done as one deliberate pass than
  opportunistically. The scope comment at the top of `uiCopy.ts` describes the
  older split and will be corrected in that pass.
- **Playwright e2e (deferred, second time).** The main flows are covered twice
  over: jsdom page tests for each screen and the API integration suite for the
  routes they call. A browser download in CI, a dev-server harness and flaky-run
  triage is real cost for a third copy of the same assertions. Recorded as a
  known gap — this track does not claim browser-level coverage.
- **Dispute resolution (blocked on policy).** The inbox is read-only by design;
  who may resolve a dispute and what evidence it requires is still unrecorded.
  The screen says so in the UI rather than hiding the action silently.

## Deferred items

- Officer field PWA, IndexedDB offline store (D29), scan log and native Android
  app. The disputes inbox is read-only; resolution needs a recorded policy first.
- Dashboard page translation into the catalogue, in the languages a tenant
  enables (Phase 11).
- Playwright e2e for the main flows.
- OpenAPI documentation playground UI (Swagger UI / Elements) — cosmetic, add
  once the document exists.
- OpenAPI-driven admin screens for config editing (with audited confirmation
  flows); the viewer stays read-only.
