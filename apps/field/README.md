# @tpirs/field

Officer PWA: scan a sticker, see today's payment status, raise a dispute. Works
offline; a cache miss is never reported as a debt.

## What is built

- **Sign-in** (`src/screens/LoginScreen.tsx`, `src/session.ts`) — tenant slug,
  username, password and an optional authenticator code. The bearer lives in
  memory only and the refresh cookie is httpOnly; nothing about the session is
  persisted, because handsets are shared. Login registers the device
  (`deviceId` + platform), which the server records as a binding.
- **Tenant config** (`src/lib/tenant.ts`) — fetched from
  `GET /v1/tenants/current/config` after sign-in and cached in `localStorage`,
  because the app has to draw its branding and dispute reasons on first paint
  while offline. A cache that no longer validates is dropped rather than crashing
  the app at launch.
- **Theme** — `@tpirs/ui-tokens` turns the tenant's branding into CSS custom
  properties. No component branches on a tenant.

- **Paid-set sync** (`src/offline/sync.ts`) — a snapshot on the first sync of the
  day, a delta after that, following the server's cursor page by page and saving
  it after each page so a phone that dies mid-sync resumes. The cache is cleared
  when the business date changes: yesterday's payments say nothing about today.
  A 429, a dead zone or the page cap stops the sync and says so; queued work is
  never dropped.
- **Scanning** (`src/scanner/index.ts`) — a real QR scanner: native
  `BarcodeDetector` where the browser has it, `jsqr` loaded lazily where it does
  not, and manual entry of the short code or plate number as a first-class tab.
- **Result card** (`src/screens/ResultScreen.tsx`) — `paid`, `not in the offline
list`, or `code not recognised`. Never "unpaid": the cache can confirm a
  payment but cannot prove a negative, and the card hands the officer the SMS
  check instead of a verdict.

## What is not built yet

Recording the scan on the server (online verification and the outbox), disputes,
and the scan log. The plan and the acceptance checks are in
`docs/phase-6-field-app-implementation.md`; the API those steps call already
exists (`/v1/scans`, `/v1/disputes`).

## Rules this app must keep

- Never render `UNPAID`. Offline answers are `paid` or `not_in_offline_list`
  (`resolveOfflineScan` in `@tpirs/domain`).
- Cash is never recorded here; the collector app owns it.
- No API response is cached by the service worker — the paid set lives in
  IndexedDB so it can be cleared on business-date rollover.

## Commands

`pnpm dev` (port 5174, from the repo root `pnpm dev` starts all apps),
`pnpm test`, `pnpm typecheck`, `pnpm build`.
