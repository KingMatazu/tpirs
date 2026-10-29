# Phase 9 implementation: admin dashboard completion

Phase 9 turns the dashboard built alongside phases 5–8 into the full,
roles-aware admin surface the build brief asks for. The UI track
([`ui-track-implementation.md`](./ui-track-implementation.md)) already delivered
the shell and the phase 5–8 screens; this plan completes the remaining screens,
adds the missing backend for reversals, and proves the acceptance check:
**switching tenants re-themes and re-labels the dashboard with no code changes.**

## What already exists (delivered before this phase)

| Area                                               | Where                                        | State     |
| -------------------------------------------------- | -------------------------------------------- | --------- |
| API client + tokens                                | `packages/api-client`, `packages/ui-tokens`  | completed |
| Auth shell + session                               | `apps/admin/src/session.ts`, `LoginPage.tsx` | completed |
| Permission-aware nav                               | `apps/admin/src/pages/Layout.tsx`            | completed |
| Tenant theming                                     | `apps/admin/src/components/Theme.tsx`        | completed |
| Config viewer                                      | `apps/admin/src/pages/ConfigViewerPage.tsx`  | completed |
| Channels + USSD simulator                          | `ChannelsPage.tsx`, `UssdSimulatorPage.tsx`  | completed |
| Audit search                                       | `AuditPage.tsx` + `GET /v1/audit`            | completed |
| Collectors (cash)                                  | `CollectorsPage.tsx`                         | completed |
| Reconciliation + exceptions                        | `ReconciliationPage.tsx`                     | completed |
| Reports + exports                                  | `ReportsPage.tsx`                            | completed |
| Disputes / reversals / registry / payments screens | —                                            | missing   |
| Reversals API (list/approve)                       | —                                            | missing   |
| Dashboard language switch                          | —                                            | missing   |

## Scope decisions

- **Clients only talk to the API.** Every screen uses `@tpirs/api-client`;
  no component fetches a URL by hand. A backend gap is closed in the API and
  the client regenerated, not worked around in the browser.
- **Permissions are data.** Navigation and mutation controls are gated on the
  permission strings the session already carries. The server enforces the same
  rule; the UI only hides what would 403.
- **Theming is tokens.** Colours, app name and formats come from tenant config
  through `@tpirs/ui-tokens`. No tenant literals in `apps/admin`.
- **i18n is data.** Dashboard copy comes from a catalogue keyed by the
  tenant's `locale.enabledLanguages`, using the `@tpirs/i18n` translator
  pattern. The switch re-labels the shell and the phase 9 screens; older
  screens are migrated incrementally (recorded below).
- **Append-only stays append-only.** Reversals are requests approved by a
  second, different finance user; the screen never edits a ledger row.

## Step 0: Reconcile the plan (completed)

- Rewrite this plan and the UI-track status to match the tree: mark delivered
  screens, name the missing ones, and keep one source of truth for what Phase 9
  still owes.
- Commit: `docs(phase-9): outline the dashboard completion`.

## Step 1: Shell, language switch and tenant acceptance (completed)

- Keep tenant branding and permission-aware nav as delivered; add a language
  selector driven by `locale.enabledLanguages` (only shown when a tenant enables
  more than one), wired through a dashboard catalogue and the shared translator.
- Show the tenant name/slug in the shell so a multi-tenant deployment is
  unambiguous.
- Prove the acceptance check with a test: rendering the shell with the alpha and
  beta fixtures changes the app name, nav labels (English/French), currency and
  colours from config/tokens alone. Switching tenants in practice is sign-out +
  sign-in; there is no cross-tenant session.
- Commit: `feat(admin): language switch and tenant-aware shell`.

## Step 2: Registry screens (completed)

- Asset list with search and status filter; asset detail rendering attributes
  from the tenant's asset-type schema (never a hardcoded field list).
- Photo upload/viewer and sticker preview/SVG download.
- Suspend (reason required) and audited correction flows; both permission-gated
  on `asset:manage`.
- Owner create/detail and OTP verify request/confirm (`asset:manage`).
- Commit: `feat(admin): registry screens`.

## Step 3: Payments and suspense (completed)

- Payments list with status filter, daily totals, and a per-payment outbox view
  so finance can see whether a receipt is pending/sent.
- Suspense queue with resolve (assign asset by id/reference) behind a
  confirmation naming the amount and provider reference; permission
  `payment:manage`.
- Strict `pay_per_use` wording: "no payment recorded", never "unpaid"/debt.
- Commit: `feat(admin): payments and suspense screens`.

## Step 4: Disputes inbox (completed)

- Read-only list with status filter and a detail view (reason, description,
  asset, zone, business date, evidence references). Resolution stays out of
  scope until the dispute-resolution policy is recorded; the screen says so.
- Permission `dispute:read`.
- Commit: `feat(admin): disputes inbox`.

## Step 5: Reversals backend and dual-approval screen (completed)

- API: `GET /v1/reversals` (`ledger:read`), `POST /v1/reversals/:id/approve`
  and `POST /v1/reversals/:id/reject` (`ledger:approve`). Approval goes through
  the existing `LedgerService.approveReversal`, which already refuses the
  requester approving their own request and posts mirrored entries; rejection
  records the actor and reason. Add `list` to the reversal repository.
- Admin: pending/recent reversal requests with the original transaction, reason
  and requester; approve/reject with a note. The approver must be a different
  user; the screen explains that instead of hiding the button silently.
- Commit: `feat(admin): reversal requests with dual approval`.

## Step 6: Phase 5–8 screens (completed before this phase)

- Collectors, reconciliation, reports, config viewer, audit search, channels and
  the USSD simulator are delivered and tested; they are linked from the nav and
  need no Phase 9 rework beyond the shell changes.

## Step 7: Acceptance and negative tests (completed)

- Re-theme/re-label test across the two fixtures (Step 1).
- Permission states: an auditor sees no mutation controls on reversals,
  payments or registry; a collector sees only what their permissions allow.
- A request-id error envelope renders in the standard error path.
- `grep` proves no tenant names, currencies or timezones in `apps/admin/src`.
- Commit: included with the steps above.

## Step 8: Gates and delivery notes (completed)

- `pnpm format` → `pnpm lint` → `pnpm typecheck` → `pnpm test`, then
  `scripts/ci/integration.sh` and `scripts/ci/migration-check.sh`.
- Update the UI-track status, README/AGENTS phase state (Phase 9 delivered,
  Phase 10 next) and this plan.
- Commit: `docs(phase-9): delivery notes`.

## Acceptance mapping

| `AGENTS.md` Phase 9 check                                                                                      | Where it is proven                                               |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Built only on `api-client` and `ui-tokens`                                                                     | Every page imports `api`/`unwrap`; theming via `Theme.tsx`       |
| Roles-aware navigation                                                                                         | `Layout.tsx` filters `NAV_ENTRIES` by permission; tests per role |
| Tenant branding                                                                                                | `Theme.tsx` + tokens; re-theme test                              |
| i18n                                                                                                           | dashboard catalogue + language switch test                       |
| Screens: registry, payments, suspense, disputes, reversals, reconciliation, reports, collectors, config, audit | the pages listed above                                           |
| Switching tenants re-themes and re-labels with no code changes                                                 | two-fixture shell test + no-literal grep                         |

## Deferred

- Dispute resolution (needs a recorded policy for who may resolve and what
  evidence is required).
- Config editing with audited confirmation (the viewer stays read-only).
- Playwright e2e: the suite remains jsdom-based; the main flows are covered by
  page tests and the API integration suite.
- Translating every pre-Phase-9 page: the shell and Phase 9 screens are
  catalogue-driven; the older pages keep English literals until they are
  touched (recorded in the UI-track doc).
