# Phase 6 implementation: verification, delta sync and the officer field app

This document is the working plan for Phase 6 of `AGENTS.md`. It covers the
verification endpoints, the paid-set delta feed, scan logging, dispute
creation, and the officer field app that runs offline on low-end Android
devices.

`apps/field` does not exist yet. Phase 6 reopens the officer tooling deferred
by D29; the offline-store recommendation recorded there is adopted as the
starting design (see Step 0).

## Scope decisions carried into this phase

- **The field app is a PWA, not a native app.** React + Vite, served by the
  API origin, installed to the home screen. Camera scanning uses the platform
  `BarcodeDetector` where available and a JS decoder fallback. The app must
  remain usable on a low-end Android phone in direct sunlight; heavy UI
  libraries are out.
- **Offline can confirm payment and can never deny it.** The offline store
  holds the paid set only. A missing entry renders `NOT_IN_OFFLINE_LIST`; the
  string `UNPAID` never exists as a field-app result. This is a type-level and
  test-level rule, not a copy rule.
- **The server is the only authority for payment status.** When online, the
  field app submits a scan (or lookup) and renders the server's answer. Offline
  observations are queued as facts with the status the officer saw, and the
  server recomputes the authoritative status when the queue drains.
- **Pay-per-use wording stays neutral.** Wire values are `PAID` and
  `NO_PAYMENT_RECORDED`. The UI says "No payment recorded today", never
  "unpaid", "defaulter", or "debt". No reminders are introduced.
- **Scanning resolves the sticker key client-side when offline.** The QR token
  is `<opaque payload>.<checksum>`. The client may split off the payload and use
  it as a lookup key in the cached paid set, but it cannot and must not verify
  the HMAC offline (the key never leaves the server). A payload not in the paid
  set is not a claim of non-payment.
- **No tenant literals.** Zone names, fee amounts, languages, SMS keyword,
  sender ID, app name and colours come from tenant config. Field UI copy comes
  from bundled locale catalogues, not from hardcoded tenant strings.
- **No new money paths.** Scans and disputes never post ledger entries. A
  dispute is a ticket; resolution and any reversal remain Phase 8 work behind
  dual approval.
- **All clients use `packages/api-client`.** New routes are declared in Fastify
  schemas so `openapi.json` and `schema.gen.ts` regenerate; `apps/field` fetches
  nothing by hand.

## Preconditions: clear the decks

The Phase 5/UI-track work in the working tree must be green and committed
before Step 1. That means:

1. Delete the temporary `apps/admin/src/test-support/debug.test.ts`.
2. Complete `apps/admin/src/test-support/tenant.ts` with every canonical
   channel message key in both seeded languages (including the reachable
   `status`/`pay` action keys).
3. Fix the admin test transport so the relative-URL `Request` shim and fetch
   stub are installed before `packages/api-client` constructs its singleton
   (use a vitest `setupFiles` entry; `beforeAll` is too late because
   `openapi-fetch` captures both at `createClient()` time).
4. Run `pnpm format` → `pnpm lint` → `pnpm typecheck` → `pnpm test`, then commit
   the admin/refresh/audit work.
5. Close the Phase 5 verify-limiter gap: ADR 0024 and D5 say
   `GET /v1/verify/:token` is limited to 60 requests/minute per IP with `429`
   and `Retry-After`, but `apps/api/src/routes/verify.ts` has no limiter today.
   Add it in Step 1 so verification is protected before the field app starts
   hammering it.

## Step 0: Record decisions and ADRs

Add these to `docs/decisions-needed.md` and write the ADRs before code:

| ID  | Decision                                                                | Recommendation                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D6  | Online payment-status vocabulary and the meaning of no recorded payment | `PAID` / `NO_PAYMENT_RECORDED` / `UNKNOWN`. `NO_PAYMENT_RECORDED` is factual, not a debt; under `pay_per_use` it may mean the vehicle did not work. `UNKNOWN` remains reserved for a tenant without a ledger/config, never assumed.                                             |
| D29 | Field PWA offline store (reopen)                                        | Adopt the recorded recommendation: IndexedDB (`idb`) with paid-set cache, append-only idempotent outbox, and monotonic `since` cursor. Add a cached-asset store for identifiers and photos.                                                                                     |
| D30 | Offline sticker lookup key                                              | Parse the opaque payload locally and match it against the paid set. Never verify the checksum offline; never infer non-payment from absence. The feed must carry the payload and short code.                                                                                    |
| D31 | Field session and offline grace                                         | Online login at least once per shift; after that the app may enter field mode for a configurable grace window. The access token stays in memory (D26); the httpOnly refresh cookie handles silent re-auth. Queued items are authorised and attributed server-side at sync time. |
| D32 | Paid-set scope at scale                                                 | Tenant-wide paid set for the current business day in v1, paginated and capped. Zone-scoped feeds need an officer-to-zone assignment and are deferred with a recorded trigger (measured set size or officer zone onboarding).                                                    |
| D33 | Dispute evidence transport                                              | Optional single photo per dispute, downscaled client-side and posted as base64 JSON in the create request (the asset-photo pattern), avoiding a new multipart dependency. Evidence is stored through `ObjectStorage`.                                                           |
| D34 | Scan/dispute retention                                                  | Operational tables follow `compliance.retentionDays`; a purge job is Phase 8. Until then rows are append-only except dispute resolution fields.                                                                                                                                 |

New ADRs:

- `0028-verification-status-and-paid-set.md` — payment-status vocabulary,
  business date, paid-set snapshot/delta semantics, cursor, reversal tombstones.
- `0029-offline-field-app.md` — PWA stack, IndexedDB stores, offline decision
  rule, shift grace, photo caching, service-worker update policy.
- `0030-scan-and-dispute-ingest.md` — idempotent client UUIDs, observed vs
  authoritative status, evidence handling, permissions and audit.

Record the PWA/camera/storage dependency choices and the alternatives
considered in ADR 0029 (D27 already covers React/Vite/TanStack Query/zustand).

## Step 1: Domain rules and the verify limiter

`packages/domain` stays pure. Add:

- `verification.ts`
  - `PaymentStatus = "paid" | "no_payment_recorded" | "unknown"`.
  - `paymentStatusFromPeriod(period)` mapping `paid`/`waived` → `paid`,
    `unpaid`/`none` → `no_payment_recorded`. `none` is deliberately not an
    error under `pay_per_use`.
  - `OfflineScanResult = "paid" | "not_in_offline_list"` plus
    `resolveOfflineScan({ tokenPayload, paidPayloads })`. The function cannot
    return anything else; that is the type-level guarantee.
  - `readQrPayload(token)` — structural split only, explicitly documented as
    not an authenticity check. Return `undefined` for a malformed token so the
    UI can say "scan again" instead of inventing a status.
- `scan.ts` / `dispute.ts`
  - Scan source (`qr`, `manual`, `offline_queue`), observed status union, and
    input validation (UUID client id, timestamp not in the future by more than
    a small clock skew, optional coordinates within valid ranges).
  - Dispute status machine (`open` now; resolution states reserved for Phase 8)
    and allowed transitions.

Tests: property test that the offline resolver's output is always a member of
the two-value union; malformed/empty tokens; timezone boundary where the
client's local date differs from the server business date.

Verify limiter: in `apps/api/src/routes/verify.ts`, consume
`verify:ip:<request.ip>` with `{ limit: 60, windowSeconds: 60 }` before the
asset lookup, return `429` with the standard error envelope and `Retry-After`
on denial. Add a route test that the 61st request is rejected and that a
different IP is unaffected.

## Step 2: Schema and repositories (migration 0011)

Every table is tenant-scoped with the Phase 1 RLS pattern, indexes, and a
reversible `down`.

### `scans`

One row per scan the officer made, whether it arrived online or from the
offline outbox.

| Column                   | Notes                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `id`                     | uuid pk                                                                                 |
| `tenant_id`              | FK tenants                                                                              |
| `asset_id`               | FK assets                                                                               |
| `officer_user_id`        | resolved from the session, not trusted from the body                                    |
| `device_id`              | text, matching the device-binding identifier                                            |
| `client_scan_id`         | client-generated uuid; `unique (tenant_id, client_scan_id)`                             |
| `source`                 | `qr` / `manual` / `offline_queue`                                                       |
| `observed_status`        | what the officer's screen showed (`paid`, `no_payment_recorded`, `not_in_offline_list`) |
| `authoritative_status`   | recomputed server-side at ingest (`paid` or `no_payment_recorded`)                      |
| `business_date`          | server-computed business date for the observation                                       |
| `scanned_at`             | client time                                                                             |
| `recorded_at`            | server time                                                                             |
| `latitude` / `longitude` | nullable, best-effort location                                                          |
| `zone_id`                | nullable snapshot of the asset's zone                                                   |

Indexes: `(tenant_id, scanned_at desc)`, `(tenant_id, asset_id, scanned_at
desc)`, `(tenant_id, officer_user_id, scanned_at desc)`.

### `disputes`

| Column                                                  | Notes                                                   |
| ------------------------------------------------------- | ------------------------------------------------------- |
| `id`                                                    | uuid pk                                                 |
| `tenant_id`, `asset_id`, `opened_by_user_id`, `zone_id` | FKs / snapshot                                          |
| `client_dispute_id`                                     | uuid; `unique (tenant_id, client_dispute_id)`           |
| `status`                                                | `open` only in Phase 6; later states reserved           |
| `reason`                                                | tenant-configurable code list, validated against config |
| `description`                                           | free text, length-capped                                |
| `occurred_at`, `business_date`, `recorded_at`           | client fact + server fact                               |
| `latitude` / `longitude`                                | nullable                                                |
| `resolution_*`                                          | nullable; unused until Phase 8                          |

### `dispute_evidence`

`id`, `tenant_id`, `dispute_id`, `object_key`, `content_type`, `created_at`.
Never overwritten; a dispute may have at most one evidence photo in v1.

### Paid-set query support

No `paid_at` column is added. The feed cursor is `(updated_at, id)`, which
every membership change already touches. Two things must be proven:

1. `ObligationRepository.markPaid`/`updatePaidAmount` set `updated_at` (they
   do), and any future period-status write does too.
2. **Reversal removes membership.** Today `LedgerService.approveReversal`
   posts mirror entries but does not update the obligation period. Add a
   repository method and call it in the same transaction so a reversed
   allocation returns the period to `unpaid` (or reduces its paid amount) and
   bumps `updated_at`. Test that the asset disappears from the paid set.

Repository methods:

- `ObligationRepository.listForBusinessDateSince(tenantId, businessDate,
cursor, limit)` ordered by `(updated_at, id)` ascending, returning period,
  asset id, QR payload, short code and asset type. Snapshot mode starts with no
  cursor. Delta mode uses `updated_at > cursor.updatedAt OR (updated_at =
cursor.updatedAt AND id > cursor.id)`.
- `ScanRepository.insertIfAbsent`, `list` (cursor).
- `DisputeRepository.createIfAbsent`, `find`, `list` (cursor), `attachEvidence`.

Opaque cursors are base64url JSON `{ updatedAt, id }`; invalid cursors are a
`400`, like the audit cursor.

Seeding/permissions: add `scan:read`, `scan:record`, `dispute:create` to
`ALL_PERMISSIONS`; give the officer role all three, the zone supervisor
`scan:read`/`scan:record`, and the auditor `scan:read`. Existing tenants do not
pick this up from the seed (roles are inserted once), so add an idempotent
backfill in migration 0011 that grants the new permissions to roles carrying
the built-in role key, or extend the seed to sync built-in role permissions and
document the re-seed. Prefer the migration so a deploy is sufficient.

## Step 3: Application services

### `VerificationService`

- `verifyToken(token)` — existing `AssetService.verifyQrToken` lookup, then
  business date from `todayInTimeZone(config.locale.timezone)`, then
  `ObligationService.getPeriodStatus`, then `paymentStatusFromPeriod`.
  Returns the existing registration facts plus `businessDate` and
  `paymentStatus`. Public; no owner phone.
- `lookup(reference)` — authenticated exact lookup by short code or attribute
  (reuse `findByReference`), plus a prefix search method on the asset
  repository for search-as-you-type. Returns at most N matches with status.
  This route is rate-limited per user/IP because authenticated enumeration is
  still abuse.
- `authoritativeStatus(asset, businessDate)` — the single place that maps a
  period row to a wire status.

### `ScanService`

- `record(input)` — resolve the asset (token or reference), recompute the
  authoritative status, and insert with `ON CONFLICT (tenant_id,
client_scan_id) DO NOTHING`. A replay returns the original row; it never
  re-evaluates the status (the officer's screen and the server record must
  agree). `observed_status` is stored for discrepancy reporting.
- `list(filter)` — cursor list scoped by tenant, optionally officer/zone/date.
  Officers can list their own scans; supervisors with `scan:read` can list the
  tenant's. The field app shows the officer's own recent log.

### `PaidSetSyncService`

- `sync({ tenantId, since, limit })` — computes the business date server-side,
  queries periods for that date, and returns a page with `mode` (`snapshot`
  when `since` is absent), `businessDate`, `entries`, `nextCursor`,
  `hasMore`, and `serverTime`.
- Entry: `assetId`, `qrPayload`, `shortCode`, `assetTypeKey`, `attributes`
  (for the plate/identifier offline), `paid` (true for `paid`/`waived`),
  `changedAt`. `paid: false` entries are removals the client applies by
  `assetId`; snapshots clear the set before applying.
- Day rollover: the client compares `businessDate` with its cached value and
  discards the set on a mismatch. The cursor is scoped to that date; a cursor
  from another date is ignored and a snapshot is returned.
- Gated by `featureFlags.offlineMode`; disabled returns `403` with the standard
  envelope.

### `DisputeService`

- `create(input)` — idempotent on `client_dispute_id`; validates the reason
  against the tenant's configured dispute reasons; validates the asset belongs
  to the tenant; stores optional evidence via `ObjectStorage`; rejects when
  `featureFlags.disputes` is off. Emits the normal audit entry through the
  route middleware; no ledger write.
- `list`/`get` — tenant-scoped, `dispute:read`. Officers see their own
  creations (the field app's "my reports"); finance/auditor see all. Resolution
  is not exposed in Phase 6.

Audit: the existing `auditOnSuccess` middleware records scan and dispute POSTs.
The `scans` table remains the operational scan log; one audit row per scan is
acceptable at pilot volume. If volume becomes a problem, batch the offline
outbox flush into one audited request with an item count, but keep one `scans`
row per scan.

## Step 4: API and contracts

| Method | Path                       | Auth / gate                        | Purpose                                            |
| ------ | -------------------------- | ---------------------------------- | -------------------------------------------------- |
| GET    | `/v1/verify/:token`        | public, 60/min per IP              | Asset facts + today's payment status               |
| GET    | `/v1/verifications/search` | `asset:read`, per-user limit       | Manual lookup by short code/plate, with status     |
| POST   | `/v1/scans`                | `scan:record`                      | Resolve, log and return a scan result              |
| GET    | `/v1/scans`                | `scan:read`                        | Cursor scan log (own/zone filter)                  |
| GET    | `/v1/sync/paid`            | `asset:read` + `offlineMode`       | Paid-set snapshot/delta feed                       |
| POST   | `/v1/disputes`             | `dispute:create` + `disputes` flag | Idempotent dispute creation with optional evidence |
| GET    | `/v1/disputes`             | `dispute:read`                     | Cursor dispute list                                |
| GET    | `/v1/disputes/:id`         | `dispute:read`                     | Dispute detail and evidence reference              |

Wire examples (kept in `schemas.ts` so `openapi.json` is the source of truth):

```json
// POST /v1/scans
{
  "clientScanId": "6f2c...",
  "source": "qr",
  "token": "payload.checksum",
  "scannedAt": "2026-10-24T09:12:03Z",
  "observedStatus": "paid"
}
```

```json
// GET /v1/sync/paid?since=eyJ1cGRhdGVkQXQiOi...
{
  "mode": "delta",
  "businessDate": "2026-10-24",
  "entries": [
    {
      "assetId": "…",
      "qrPayload": "…",
      "shortCode": "AB123",
      "assetTypeKey": "vehicle",
      "attributes": { "plate": "KJA 123 XY" },
      "paid": true,
      "changedAt": "2026-10-24T09:12:04Z"
    }
  ],
  "nextCursor": "eyJ1cGRhdGVkQXQiOi...",
  "hasMore": false,
  "serverTime": "2026-10-24T09:13:00Z"
}
```

Details:

- Update `verifyTokenSchema`'s `paymentStatus` enum from `unknown` to
  `PAID`/`NO_PAYMENT_RECORDED`/`UNKNOWN`, add `businessDate`, and keep the
  response additive otherwise.
- `POST /v1/scans` accepts `token` or `reference`, exactly one, and the
  client UUID. It returns the same verification payload plus `scanId`,
  `observedStatus`, `authoritativeStatus`, and `businessDate`.
- Dispute input includes `assetId` or `reference`, `reason`, `description`,
  `occurredAt`, optional coordinates, and optional
  `{ contentType, contentBase64 }` evidence. The API body limit for this route
  is raised to 2 MB; the client downscales photos to fit.
- Add rate limits for the authenticated search and scan routes using the
  shared limiter (platform constants, not tenant literals).
- Regenerate `packages/api-client/openapi.json` and `schema.gen.ts`; verify
  `apps/admin` still typechecks (the verify enum change is additive).
- Add route tests for: 404 indistinguishability, 429, permission refusals,
  cross-tenant scan/dispute access, replay of `clientScanId`/`clientDisputeId`,
  feature-flag refusals, invalid/expired cursor, and a cursor page boundary at
  an identical `updated_at`.

## Step 5: Field app (`apps/field`)

### Stack and shell

- React + Vite + TypeScript, consuming `@tpirs/api-client`, `@tpirs/ui-tokens`,
  and a bundled locale catalogue through `@tpirs/i18n`'s translator.
- Service worker via `vite-plugin-pwa` (Workbox) for the app shell only; API
  data lives in IndexedDB, never in the HTTP cache.
- Update policy: prompt "A new version is ready" and reload on the officer's
  action, never mid-scan.
- Same-origin deployment so the D26 refresh cookie works; the app keeps the
  access token in memory only.

### Offline store (D29)

`idb` database with:

- `paidSet` — keyed by `qrPayload` and indexed by `shortCode`, populated from
  the sync feed; stores `assetId`, `shortCode`, `attributes`, `paid`,
  `businessDate`, `changedAt`. Render status by presence only.
- `assetCache` — last-seen asset facts and a bounded photo cache (e.g. the most
  recent 50 scans) for swapped-sticker detection. Photos are fetched with the
  bearer and stored as blobs; an evicted photo never changes the status.
- `outbox` — append-only scan/dispute commands keyed by client UUID, with
  attempt count and next-attempt time. Never merged or overwritten.
- `syncState` — `{ businessDate, cursor, lastSyncedAt }`.
- `fieldSession` — last successful login time, cached principal for display,
  device id. Not an authorisation source; the server re-authorises on sync.

### Flows

- **Shift start:** login (password + TOTP, device binding) while online,
  cache branding/config and the officer's identity, then sync the paid set.
  If the paid set cannot be fetched, the app still runs but every scan is
  `NOT_IN_OFFLINE_LIST` (never a denial) and the banner says the cache is stale.
- **Scan:** camera or manual entry. Online → `POST /v1/scans`, render the
  server result. Network failure → compute `resolveOfflineScan` from the cached
  set, queue the scan with the observed status, and show the offline banner.
- **Result card:** `PAID` (green), `NO_PAYMENT_RECORDED` (neutral, "No payment
  recorded today"), `NOT_IN_OFFLINE_LIST` (neutral, with the SMS-check
  instruction). Always show business date, short code, plate/identifier and
  photo when cached. Never show a red "UNPAID" state.
- **SMS fallback:** render the tenant's short-code keyword and sender ID from
  config, e.g. "Ask the driver to text {keyword} {shortCode} to {senderId}".
  The Phase 5 inbound SMS command already answers status.
- **Dispute:** reason from config, free-text note, optional photo (downscaled)
  and location; queued offline with a client UUID.
- **Sync:** on launch, reconnect, foreground and a manual "Sync now". Flush the
  outbox oldest-first with exponential backoff; on a 401 refresh once, then
  pause and ask for login. Fetch the paid set: snapshot when the date changes
  or no cursor, otherwise follow `nextCursor` until `hasMore` is false.
  Applying entries is idempotent; a crash mid-page replays from the last saved
  cursor.
- **Scan log:** local pending/synced list, with a clear "pending upload" badge.

### UI copy and theming

- All copy goes through locale catalogues (`en` plus the seeded second
  language) with placeholders for config values. Add the field keys next to
  the driver keys' naming convention (e.g. `field.result.paid`,
  `field.result.noPayment`, `field.result.notInList`).
- Branding (name, logo, colours) comes from `@tpirs/ui-tokens` seeded by tenant
  config, cached for offline rendering.
- Buttons are large, contrast is checked for sunlight, and the scan screen does
  not require GPS or a network round-trip before showing a result.

## Step 6: Tests

Domain:

- Offline resolver never returns anything except `paid`/`not_in_offline_list`;
  property test across random sets/tokens.
- Malformed token handling; payload split does not verify a forged checksum.
- Business-date boundary: server date differs from the device date; the app
  trusts the server date.
- Reversal: a reversed paid period leaves the paid set.

Application:

- Snapshot then delta produces the same set as a fresh snapshot.
- Cursor paging with duplicate `updated_at` values is stable and complete.
- `paid: false` removals remove membership; unknown asset ids are ignored.
- Scan idempotency and observed-vs-authoritative divergence.
- Dispute idempotency, feature-flag gating, invalid reason, cross-tenant asset.
- `pay_per_use` missing period → `NO_PAYMENT_RECORDED`, no rows created.

Database (DB-gated, run through `scripts/ci/integration.sh`):

- RLS isolation for `scans`, `disputes`, `dispute_evidence`.
- Unique client ids under concurrent inserts.
- Migration 0011 up/down and the permission backfill.
- Verify limiter state is shared through the cache adapter.

API:

- `GET /v1/verify/:token` returns `PAID`/`NO_PAYMENT_RECORDED`, 404 for bad
  tokens, and 429 with `Retry-After`.
- Replayed scan and dispute POSTs return the original record and change
  nothing (assert row counts and audit counts).
- Cursor validation, tenant isolation, permission matrix, feature flags.
- OpenAPI snapshot/regeneration; admin still typechecks.

Field app:

- Unit tests for the local status resolver, outbox reducer and sync cursor.
- Playwright: online paid scan; offline scan of an unpaid asset shows
  `NOT_IN_OFFLINE_LIST` and the page never contains "UNPAID"; reconnect drains
  the outbox and the scan log shows both records; offline dispute appears after
  reconnect.
- Manual field checklist (low-end Android, direct sunlight, airplane mode,
  killed-and-reopened app, camera permission denied): record device models and
  results in the runbook. This is evidence for the acceptance check, not an
  automated test.

## Step 7: Documentation and gates (completed)

- [x] ADRs 0028–0030; D6/D29 resolved and D30–D34 recorded in
      `docs/decisions-needed.md`.
- [x] `docs/runbooks/field-operations.md`: shift start, offline grace, sync,
      dispute evidence, stale-cache behaviour, field-test checklist.
- [x] Update `docs/driver-channels.md` where SMS status and the field fallback
      meet.
- [x] Package READMEs (`apps/field`, `packages/db`, `packages/application`,
      `packages/domain`), the ADR index, and the repo-state paragraph in
      `AGENTS.md`.
- [x] Update `tenants/_template` and the seed with the new permissions and, if
      adopted, the `field` config section (offline grace hours, max queue items,
      dispute reasons). Keep it optional with defaults so existing configs validate.
- [x] Gates: `pnpm format` → `pnpm lint` → `pnpm typecheck` → `pnpm test`, then
      `sh scripts/ci/integration.sh` and `sh scripts/ci/migration-check.sh`.
      Regenerate the API client before the final typecheck.

Status note: the Phase 6 implementation is complete and the remaining work is the
post-implementation cleanup and maintenance gates already reflected in the repo.

## Acceptance mapping

| Brief acceptance check                                  | Evidence                                                                                                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| With the network disabled the app never shows UNPAID    | Type-level two-value offline result, unit property test, Playwright assertion that "UNPAID" is absent, field checklist |
| Sync catches up after reconnect                         | Playwright online/offline/online flow; outbox idempotency tests; paid-set snapshot/delta equivalence                   |
| Field-tested on low-end Android devices and in sunlight | Documented manual checklist with device models and results                                                             |
| Scan log and dispute creation                           | `scans`/`disputes` tables, routes, officer screens, RLS and replay tests                                               |
| Verify endpoint returns today's status                  | `GET /v1/verify/:token` returns `PAID`/`NO_PAYMENT_RECORDED` + `businessDate`                                          |
| Delta feed                                              | `GET /v1/sync/paid` snapshot/delta with opaque cursor and day rollover                                                 |

## Deferred items

- Dispute resolution, reversal linkage and the finance inbox (Phase 8/9).
- Native app packaging, background sync, push notifications.
- Zone-scoped paid sets until an officer-to-zone assignment exists (D32).
- Public unauthenticated photo serving for the verify page; the field app uses
  authenticated fetches (Phase 2/9 decision).
- Scan/dispute retention purge (Phase 8/10), CSV exports of scans (Phase 8).
- Multi-photo evidence, offline image upload resumption beyond a single
  downscaled photo.

## Risks and open questions

- **Offline auth is the sharp edge.** D31's shift grace is usable but relies on
  the refresh cookie surviving the app being closed. Test on the target
  Android browser; if cookies are evicted, the fallback is a re-login and the
  outbox stays pending, which is acceptable but should be explained in the UI.
- **Paid-set size.** A tenant-wide day of paid assets may be too large for a
  low-end phone. Measure with the pilot data; the documented fallback is D32
  zone scoping.
- **Photos offline.** Only recently scanned assets have cached photos. The
  offline PAID result shows identifier/short code and a placeholder; this must
  be explicit in the field-test script so it is not mistaken for a missing
  photo.
- **Reversal integration.** If the Phase 3 reversal path cannot safely unset a
  period, the paid set will keep a reversed payment. The reversal change is a
  required part of Step 2, not an optional cleanup.
- **Permission backfill.** Changing `SYSTEM_ROLES` does not update existing
  tenant role rows; the migration backfill must be tested against a seeded
  database.
- **Verify wire change.** `paymentStatus` moves from a single `"unknown"` enum
  to a real status; any external consumer must be regenerated. Only the
  api-client and admin consume it today.
