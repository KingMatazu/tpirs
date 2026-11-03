# @tpirs/field

Officer PWA: scan a sticker, see today's payment status, raise a dispute, and
work a dead zone without ever accusing a driver of something the phone cannot
know.

## What it does

- **Sign-in** (`screens/LoginScreen.tsx`, `session.ts`) — tenant slug, username,
  password and an optional authenticator code. The bearer lives in memory and the
  refresh cookie is httpOnly; nothing about the session is persisted, because
  handsets are shared. Login registers the device (`deviceId` + platform), which
  the server records as a binding.
- **Tenant config** (`lib/tenant.ts`) — fetched from
  `GET /v1/tenants/current/config` after sign-in and cached in `localStorage`, so
  branding, the SMS fallback and the dispute reasons render on first paint while
  offline. A cache that no longer validates is dropped rather than crashing the
  app at launch.
- **Paid-set sync** (`offline/sync.ts`) — a snapshot on the first sync of the day,
  a delta afterwards, following the server's cursor page by page and saving it
  after each page so a phone that dies mid-sync resumes. The cache is cleared when
  the business date changes: yesterday's payments say nothing about today.
- **Scanning** (`scanner/index.ts`) — a real QR scanner: native
  `BarcodeDetector` where the browser has it, `jsqr` loaded lazily where it does
  not, and manual entry of the short code or plate as a first-class tab.
- **Result card** (`screens/ResultScreen.tsx`) — paid, no payment recorded, not in
  the offline list, could not confirm, or code not recognised. Never "unpaid": the
  cache can confirm a payment but cannot prove a negative, so the card offers the
  SMS check instead of a verdict.
- **Recording** (`lib/record.ts`) — posted to `/v1/scans` when online, queued when
  not. The `clientScanId` is generated once, when the scan happens, so a retry
  cannot count the same scan twice.
- **Outbox flush** (`offline/flush.ts`) — drains the queue oldest first, on
  sign-in, when the radio returns, on a 30 s timer and on demand. At most 25 items
  per pass; a 429 stops the pass and its `Retry-After` is honoured; a dead zone
  ends it; a refused scan is kept, marked failed and never retried; a 401 renews
  the session once.
- **Disputes** (`screens/DisputeScreen.tsx`, `lib/dispute.ts`) — reasons from the
  tenant config, a note, an optional photo downscaled before it leaves the phone,
  queued offline with the same id discipline as a scan.
- **Scan log** (`screens/ScanLogScreen.tsx`) — the shift's scans with sent /
  waiting / not-sent, and what the cache said next to what the ledger said.
- **Settings** (`screens/SettingsScreen.tsx`) — cache age, list size, queue depth,
  and a sync button, so a support call starts with numbers.

## Rules this app must keep

- Never render `UNPAID`. Offline answers are `paid` or `not_in_offline_list`
  (`resolveOfflineScan` in `@tpirs/domain`), and `copy.test.ts` fails if any
  officer-facing string uses the vocabulary of accusation.
- Cash is never recorded here; the collector app owns it.
- No API response is cached by the service worker — the paid set lives in
  IndexedDB so it can be cleared on business-date rollover.
- A queued scan is never dropped: it is uploaded, refused in a way a person can
  see, or still waiting.

## Icons

`public/*.png` are generated, not designed: `node scripts/generate-pwa-icons.mjs
--out apps/field/public --mark lens` (from the repo root) writes them from a
described shape (a lens: ring plus dot) using nothing but `node:zlib`. The
collector app uses the same script with `--mark cash`. Re-run it after changing
the mark; the output is committed so a build never depends on the script.

## Commands

`pnpm dev` (port 5174, or `pnpm dev` from the repo root for everything),
`pnpm test`, `pnpm typecheck`, `pnpm build`.
