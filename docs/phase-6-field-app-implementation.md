# Field app (officer PWA) — implementation plan

**Status:** in progress — steps 1 and 2 delivered; steps 3–10 next.
Reopens Phase 6 Step 5.
**Supersedes:** the Step 5 section of `docs/phase-6-implementation.md` (the plan was
written; the app was not built).
**Scope:** `apps/field` only. No backend behaviour changes except the two noted in
Step 1 (dead `field.json`, and a scanner dependency ADR).

---

## 1. Why this exists

`apps/field` is an 8-line placeholder:

```tsx
export function App() {
  return (
    <div className="min-h-screen bg-white p-4">
      <h1 className="text-2xl font-bold">TPIRS Field</h1>
      <p className="mt-2 text-gray-600">Officer field app</p>
    </div>
  );
}
```

Everything behind it is real and tested:

| Piece                 | Path                                                          | State                   |
| --------------------- | ------------------------------------------------------------- | ----------------------- |
| Public verify         | `GET /v1/verify/:token`                                       | done                    |
| Officer search        | `GET /v1/verifications/search?q=`                             | done                    |
| Paid-set delta feed   | `GET /v1/sync/paid?since=&limit=`                             | done                    |
| Record a scan         | `POST /v1/scans`                                              | done                    |
| List scans            | `GET /v1/scans`                                               | done                    |
| Disputes              | `POST/GET /v1/disputes`, `GET /v1/disputes/:id`               | done                    |
| Offline decision rule | `resolveOfflineScan` in `packages/domain/src/verification.ts` | done                    |
| IndexedDB schema      | `apps/field/src/offline/store.ts`                             | done (88 lines, unused) |
| PWA shell             | `vite.config.ts` (`VitePWA`, `registerType: "prompt"`)        | done                    |
| **The app**           | `apps/field/src/App.tsx`                                      | **missing**             |

So the officer channel — the enforcement surface, and the only place the
"never show UNPAID" rule can be seen by a human — cannot be used. This plan
builds it.

---

## 2. Scope

**In**

1. Login with password (+ TOTP when the tenant requires it), device registration.
2. Scan by camera QR or manual short code / plate entry.
3. Result card for `paid` / `no_payment_recorded` / `not_in_offline_list` / unreadable.
4. Offline paid-set cache with delta sync, business-date rollover, stale banner.
5. Offline scan and dispute outbox with idempotent flush and backoff.
6. Dispute creation from the result card.
7. Scan log (pending / synced) and manual "Sync now".
8. PWA install + update prompt, sunlight-readable styling, tenant branding.

**Out (deliberately)**

- Registering or editing assets (collector app owns that).
- Cash intake (collector app).
- Photos taken _by_ the officer — the evidence photo on a dispute is the only capture, and it is queued as base64 in `evidence`.
- Zone/device _enforcement_. The server records the device but does not refuse a new one (see §10).
- Offline verification of a vehicle that has no cached entry beyond
  `not_in_offline_list` — that is the rule, not a limitation.

---

## 3. Decisions to settle before code

### D-F1 — Where officer-facing copy lives

Options: (a) `@tpirs/i18n` catalogues, (b) a local `copy.ts` with keys, (c) inline strings.

**Recommendation: (b).** `@tpirs/i18n` is built for _driver_ channels (USSD menus and
SMS templates, tenant-supplied, validated at startup). Staff apps are English in v1 —
`apps/admin` and `apps/collector` both ship plain English. Putting the officer app on
the driver catalogue would mean inventing ~80 tenant-configurable keys that no tenant
asked for. A single `apps/field/src/copy.ts` module keeps strings greppable and makes a
later i18n pass mechanical (replace `copy.x` with `t("field.x")`).

### D-F2 — QR scanning implementation

Options: (a) native `BarcodeDetector`, (b) `jsqr` on canvas frames, (c) both, (d) manual
entry only.

**Decided: (c) behind one module, shipped in v1.** The scanner is part of the first
release, not a later addition: a real camera QR scanner plus manual entry of the short
code or plate number. `BarcodeDetector` is present on Chrome Android and costs nothing;
`jsqr` (~40 KB, pure JS, MIT) covers browsers without it. Manual entry is always
available and is the fallback when the camera is denied or the sticker is damaged. This
adds a runtime dependency, so it needs `docs/adr/00NN-field-qr-scanning.md` recording
the alternatives considered (`@zxing/browser` is larger; `BarcodeDetector` alone fails
on iOS Safari).

### D-F3 — Offline photo cache

**Recommendation:** cache the photo for the last 50 scanned assets as blobs in
`assetCache`, keyed by asset id, evicted oldest-first. A missing photo never changes a
status. Fetch with the bearer token; if the fetch fails offline, show the identifier
without the photo.

### D-F4 — What `tenants/_template/field.json` becomes

`field.json` (`offlineGraceHours`, `maxQueueItems`, `disputeReasons`) is **dead data** —
nothing reads it. Options: (a) delete it, (b) fold it into the tenant config schema.

**Recommendation: (b).** The dispute reasons are user-facing choices and the queue cap
is a real limit, so both belong in config:

```ts
interface TenantFieldSettings {
  readonly offlineGraceHours: number; // stale-cache banner threshold
  readonly maxQueueItems: number; // outbox cap
  readonly disputeReasons: readonly { code: string; label: string }[];
}
// on TenantConfig: readonly field: TenantFieldSettings;
```

Validated at load (`offlineGraceHours >= 1`, `maxQueueItems >= 1`,
`disputeReasons` non-empty, codes unique, `other` present). Then the app reads it from
`GET /v1/tenants/current/config`, which is already readable by staff (ADR 0047). The
template file becomes `field:` in `tenant.config.yaml` and `tenants/_template/field.json`
is deleted.

### D-F5 — Outbox flush vs. the scan rate limit

`POST /v1/scans` allows 30 requests/minute. An officer who scans 60 vehicles offline
would flush into a 429 wall. **Recommendation:** flush at most 25 per pass, stop on the
first 429, honour `Retry-After`, and schedule the next pass after it. Never drop a
queued item on 429 — only on a 4xx that will never succeed (400/403/404), which moves
the item to a `failed` state shown in the scan log for the officer to see.

### D-F6 — Testing the IndexedDB layer

`fake-indexeddb` (test-only, ~30 KB) is not installed. **Recommendation:** add it. The
sync correctness that matters (cursor resume after a crash, rollover clearing the paid
set, outbox retry bookkeeping) is exactly what an in-memory fake tests well, and
testing it through the UI instead would be slower and flakier. Same ADR as D-F2.

---

## 4. Target structure

```
apps/field/src/
  main.tsx                    # router-less shell, providers
  App.tsx                     # session gate + screen switch
  copy.ts                     # D-F1
  session.ts                  # zustand: in-memory bearer, principal, deviceId
  api/client.ts               # same-origin client (mirror apps/collector)
  lib/
    scan-result.ts            # merge(online result | offline resolution) -> view model
    outbox.ts                 # planFlush / applyAttempt / backoff (pure)
    paid-set.ts               # applyDelta / shouldRollover (pure)
    format.ts                 # dates, attribute rendering
  offline/
    store.ts                  # existing; extended with helpers
    sync.ts                   # snapshot + delta loop, cursor persistence
  scanner/
    index.ts                  # BarcodeDetector -> jsqr -> manual
  screens/
    LoginScreen.tsx
    ScanScreen.tsx            # camera viewport + manual entry
    ResultScreen.tsx          # the status card
    DisputeScreen.tsx
    ScanLogScreen.tsx
    SettingsScreen.tsx        # sync now, cache age, sign out, version
  components/ui.tsx           # phone-first primitives (reuse apps/collector shape)
```

`apps/collector/src/{session.ts,api/client.ts,components/ui.tsx}` are the reference
implementations; copy the shape, not the code, so the two apps can diverge.

---

## 5. Steps

Each step ends green (`format → lint → typecheck → test` for `@tpirs/field`) and is one
commit.

### Step 1 — Config: make the field settings real (D-F4) — done

- Add `TenantFieldSettings` to `packages/config/src/schema.ts`, validation in
  `validate.ts`, defaults in the two seeded tenants and `tenants/_template/tenant.config.yaml`.
- Delete `tenants/_template/field.json`.
- Regenerate the API client (`pnpm --filter @tpirs/api build` → `api-client build`).
- Tests: valid config passes; empty `disputeReasons`, duplicate codes, `maxQueueItems: 0`
  each fail with a path.

**Done when:** `GET /v1/tenants/current/config` returns `field` for both tenants.

_Effort: S._

### Step 2 — Shell, session, branding — done

- `session.ts` mirroring the collector: bearer in memory only, refresh via cookie,
  `deviceId` generated once and persisted in `fieldSession`, sent as
  `device: { deviceId, platform: "android" }` on login.
- `LoginScreen` with tenant slug, username, password, optional TOTP field.
- Load and cache the tenant config for offline rendering (app name, colours, SMS
  keyword + sender id for the fallback copy).
- Update prompt from `vite-plugin-pwa` (reload only on the officer's tap, never mid-scan).

**Done when:** `alpha.officer` signs in on :5174, sees the branded shell, and the
session survives a reload only through the refresh cookie.

_Effort: M._

### Step 3 — Paid-set sync

- `sync.ts`: no cursor → snapshot; cursor → follow `nextCursor` until `hasMore` is false;
  persist `{businessDate, cursor, lastSyncedAt}` after **each** page so a crash mid-page
  resumes.
- Business-date change → clear `paidSet` and take a fresh snapshot (never merge across days).
- `offlineMode: false` (403) → offline scan disabled entirely, banner says so.
- Stale cache: older than `field.offlineGraceHours` → amber banner "list may be out of date".

- Tests (pure + `fake-indexeddb`): resume from a saved cursor; rollover clears the set;
  re-applying a page is idempotent; a 403 disables offline mode.

**Done when:** the paid set for today's business date is in IndexedDB after login, and
the cursor advances.

_Effort: M._

### Step 4 — Scanner (D-F2)

- `scanner/index.ts`: `start()` returns a stream + a callback of decoded tokens;
  prefers `BarcodeDetector`, falls back to `jsqr`, exposes `available: boolean`.
- `ScanScreen`: viewport, torch toggle where supported, manual entry tab
  (short code or plate, case-insensitive), permission-denied state with the manual path
  as the primary action.
- ADR for the dependency.

- Tests: token extraction/normalisation (QR payload vs short code vs plate),
  `resolveOfflineScan` still returns `undefined` for a malformed token.

**Done when:** a sticker from `GET /v1/assets/:id/sticker` decodes on an Android phone
and in the manual tab.

_Effort: M._

### Step 5 — Result card

- `lib/scan-result.ts` maps everything to one view model:
  `paid` (green, "Paid for {date}"), `no_payment_recorded` (neutral, "No payment recorded
  today"), `not_in_offline_list` (neutral, "Not in the offline list — check by SMS"),
  `unknown` (neutral, "Could not confirm"), `unreadable` (neutral, "That code is not
  ours").
- Always show: business date, short code, plate/identifier, asset type, photo if cached.
- **Never** a red "UNPAID" state, and never the word "unpaid" in any string.
- Offline variant carries the SMS instruction built from config:
  "Ask the driver to text `{smsKeyword} {shortCode}` to `{smsSenderId}`".
- Online variant shows the server's authoritative status and a "recorded" tick.

- Tests: the mapping table, including that `not_in_offline_list` and `unknown` are never
  rendered as a denial; a property test that no status string contains "unpaid".

**Done when:** all five states are reachable on screen (seeded asset paid, seeded asset
unpaid, unknown short code, offline with a warm cache, offline with a cold cache).

_Effort: M._

### Step 6 — Record the scan (online and offline)

- Online: `POST /v1/scans` with `clientScanId` (UUID v4, generated per scan attempt),
  `source: "qr" | "manual"`, `token | reference`, `scannedAt` (ISO, device clock),
  optional `latitude`/`longitude` from the Geolocation API when granted.
- Offline: resolve locally, queue `{kind: "scan", payload}`, show the offline result,
  and label it "will sync".
- Server result wins: if the flush returns a different `authoritativeStatus`, the scan
  log updates and a toast says "Recorded as paid" / "No payment recorded".

- Tests: duplicate `clientScanId` is not sent twice; a 404 from the server renders
  "not ours" rather than a denial.

**Done when:** a scan taken with the network down appears in the dashboard's scan list
after reconnect.

_Effort: M._

### Step 7 — Outbox flush (D-F5)

- `lib/outbox.ts` (pure): `planFlush(items, now, budget)` → ordered ids;
  `applyAttempt(item, outcome)` → next attempt time with exponential backoff + jitter;
  terminal 4xx → `failed`, retryable (429/5xx/network) → keep.
- Flush triggers: login, `online` event, `visibilitychange` to visible, manual "Sync now",
  and a 30 s timer while authenticated and online.
- 401 → refresh once; a second 401 pauses the outbox and asks for login.
- Cap the outbox at `field.maxQueueItems`; when full, refuse a new offline scan with a
  clear message rather than silently dropping.

- Tests: backoff schedule, budget cap, 429 stops the pass without dropping items,
  401 pauses, cap enforcement.

**Done when:** 40 queued scans flush across at least two passes without a 429 storm, and
none are lost.

_Effort: M._

### Step 8 — Disputes

- From the result card: reason (from `field.disputeReasons`), note, optional photo
  (downscaled to ≤ 1024 px JPEG), location, `occurredAt`.
- `clientDisputeId` per attempt; offline → queued; `featureFlags.disputes: false` → the
  button is absent and a direct call is refused by the server anyway.

- Tests: reason list comes from config; queued dispute flushes; duplicate id no-ops.

**Done when:** a dispute raised offline shows up in `DisputesPage` with its photo.

_Effort: M._

### Step 9 — Scan log and settings

- Local list of today's scans: pending / synced / failed, with the observed and
  authoritative status side by side, newest first.
- `SettingsScreen`: cache age and last sync time, paid-set size, "Sync now", pending
  count, app version, sign out (clears the paid set, the outbox is preserved with a
  warning if non-empty).

**Done when:** the officer can see what has not uploaded yet, and sign out safely.

_Effort: S._

### Step 10 — PWA polish and docs

- Manifest icons (192/512, maskable), `theme_color` from tenant branding at runtime,
  standalone display, iOS `apple-touch-icon`.
- Sunlight contrast pass: body text ≥ 16 px, contrast ≥ 7:1 on the result card,
  tap targets ≥ 48 px, no reliance on colour alone (icon + text per state).
- `apps/field/README.md` rewritten (it currently describes a placeholder).
- Update `docs/runbooks/local-development.md` (field at :5174 already listed) and the
  Phase 6 acceptance table.

**Done when:** installable from Chrome on Android, opens offline, and the result card is
legible in direct sun.

_Effort: S._

---

## 6. Acceptance checks

Phase 6's own checks, now actually testable:

| Check                           | How it is proven                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offline never shows UNPAID      | Airplane mode, cold cache → `not_in_offline_list`; warm cache, unpaid asset → `not_in_offline_list`. Asserted in `scan-result` tests as well.            |
| Sync catches up after reconnect | 20 scans + 1 dispute queued offline, reconnect, all appear server-side once.                                                                             |
| Replay is harmless              | Re-POST the same `clientScanId` → one row (already covered server-side; assert the client never generates a second id for one attempt).                  |
| Cross-tenant                    | `alpha.officer` cannot read a `beta-state` asset id — server-side test exists; the app must not cache across tenants (clear the store on tenant change). |
| Stale cache is visible          | Set `field.offlineGraceHours` to 1 and advance the clock → amber banner.                                                                                 |
| Feature flag honoured           | `offlineMode: false` → offline scan disabled, message explains why.                                                                                      |
| Low-end device                  | 4-core Android, camera scan → result in under 2 s warm.                                                                                                  |

---

## 7. Test strategy

- **Pure unit** (fast, most of the value): `scan-result.ts`, `outbox.ts`, `paid-set.ts`,
  `scanner` token normalisation.
- **Store integration** with `fake-indexeddb`: sync resume, rollover, idempotent apply.
- **Screen tests** with Testing Library under jsdom (`globals: true` is already set):
  login, result card per status, dispute form validation, outbox badge.
- **Manual**: a real Android phone against `pnpm dev` — camera, airplane mode, sun.

No new end-to-end harness. The backend routes are already covered by
`apps/api/src/routes/*.test.ts` and the integration suite.

---

## 8. Gates and commits

Per step: `pnpm --filter @tpirs/field format|...` then the repo gates before the last
commit (`pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`).

Commit sequence (conventional, one per step):

```
feat(config): tenant field settings for the officer app
feat(field): session, branding and login
feat(field): paid-set sync with cursor resume and rollover
feat(field): qr scanning with native detector and jsqr fallback
feat(field): result card that never says unpaid
feat(field): record scans online and offline
feat(field): outbox flush with backoff and rate-limit handling
feat(field): raise a dispute from the result card
feat(field): scan log and sync settings
chore(field): pwa icons, contrast pass and readme
docs(adr): field qr scanning and test-only indexeddb dependency
```

---

## 9. Risks

| Risk                                          | Mitigation                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Camera is flaky on cheap Android              | Manual entry is a first-class path, not a fallback of last resort.                                            |
| Device clock wrong → `scannedAt` wrong        | Server stores both `scannedAt` (device) and its own receipt time; the UI shows "recorded at" from the server. |
| Outbox grows unbounded in a dead zone         | Cap from config, refuse new scans with a clear message, show the count on the home screen.                    |
| Two apps (officer + collector) drift in style | Share `@tpirs/ui-tokens` only; component sets stay separate by design.                                        |
| `jsqr` bundle size on slow networks           | Lazy-load the scanner chunk only when the camera tab opens.                                                   |

---

## 10. Known gaps this plan does not close

- **Device binding is recorded, not enforced.** `identity-provider/db` binds a device on
  login but does not refuse an unknown one. Enforcing it needs a policy decision
  (what happens on a lost phone) — worth its own ADR.
- **Zone attribution.** Scans record `zoneId: null` until the field session carries a
  zone. The dashboard's zone compliance report therefore cannot attribute officer scans
  to zones yet.
- **Offline sticker printing.** Sticker production is a dashboard/export job.
