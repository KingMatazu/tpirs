# `@tpirs/collector` — the collector PWA

The phone UI a collector uses in the street to take the daily levy in cash. It
is the collector's primary interface: one flow, one hand, daylight.

## The flow

| Screen        | What it does                                                                   | API                               |
| ------------- | ------------------------------------------------------------------------------ | --------------------------------- |
| Home          | cash in hand vs the float ceiling, collected today, drivers today              | `GET /v1/cash/wallets/{userId}`   |
| Find          | short code or plate search, with today's payment status                        | `GET /v1/verifications/search?q=` |
| Confirm       | fee from the tenant's rule, already-paid / float-low / frozen / offline states | config + wallet                   |
| Cash received | posts the intake with a browser-minted idempotency key                         | `POST /v1/cash/intakes`           |
| Done          | the receipt number the driver can quote                                        | intake response                   |
| Deposit       | open cash, the deadline, the dedicated deposit reference                       | `GET /v1/cash/wallets/{userId}`   |

## Deliberate choices

- **Cash is never recorded offline.** An intake is only real when the ledger
  posts it; the app shows the offline state instead of taking money it cannot
  receipt. Nothing API-shaped is cached by the service worker.
- **The amount is entered in major units** (`NGN 200.00`) and converted to minor
  units only on submit, using the tenant's currency digits.
- **The client reference is not a field.** The app mints one per intake; it is the
  idempotency key that makes a retry return the same receipt (ADR 0031).
- **The decision logic lives in `src/lib/flow.ts`** and is unit-tested; the server
  enforces the same rules again, so the phone never authorises anything.
- **No session in localStorage.** A shared handset must not keep a session after
  the app closes; the bearer lives in memory and the refresh token in the D26
  cookie.

## Run it

```sh
pnpm dev                      # API + admin + field + collector (port 5175)
pnpm --filter @tpirs/collector dev
```

Sign in with a collector account (`alpha-state` / `alpha.collector` /
`alpha-collector-password`).

## Not yet

- QR scanning from the camera (search by code/plate works; the sticker QR can be
  pasted from the dashboard for now).
- Register vehicle: the button is intentionally absent rather than dead; the
  registry lives in the dashboard until this flow gets its own form.
