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

- **Recording** (`src/lib/record.ts`) — a scan is posted to `/v1/scans` when the
  phone is online, and queued in the outbox when it is not. The `clientScanId` is
  generated once, when the scan happens, so a retry cannot count the same scan
  twice. A dead zone, a throttle or a server error queues it; a 404 does not,
  because the sticker is not ours and retrying forever would only delay the
  truth. A full queue (`field.maxQueueItems`) is reported, never silently
  dropped.

- **Outbox flush** (`src/offline/flush.ts`) — drains the queue oldest first, on
  sign-in, when the radio returns, on a 30 s timer and on demand. At most 25 items
  per pass; a 429 stops the pass and its `Retry-After` is honoured; a dead zone
  ends it rather than retrying every item; a refused scan (404/422) is kept,
  marked failed and never retried; a 401 renews the session once. Backoff is
  exponential with jitter, capped at 30 minutes, so a fleet that lost signal
  together does not come back together.

## What is not built yet

Disputes and the scan log. The plan and the acceptance checks are in
`docs/phase-6-field-app-implementation.md`; `/v1/disputes` already exists.

## Rules this app must keep

- Never render `UNPAID`. Offline answers are `paid` or `not_in_offline_list`
  (`resolveOfflineScan` in `@tpirs/domain`).
- Cash is never recorded here; the collector app owns it.
- No API response is cached by the service worker — the paid set lives in
  IndexedDB so it can be cleared on business-date rollover.

## Commands

`pnpm dev` (port 5174, from the repo root `pnpm dev` starts all apps),
`pnpm test`, `pnpm typecheck`, `pnpm build`.
