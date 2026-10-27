# ADR 0029: Offline field app (PWA)

## Status

Accepted

## Context

Officers need to verify payments offline on low-end Android devices in sunlight. Must never falsely accuse or show UNPAID.

## Decision

- **PWA**: React + Vite, installed to home screen, same-origin as API
- **Offline store (IndexedDB via idb)**: `paidSet` (by qrPayload, indexed by shortCode), `assetCache` (photos/metadata), `outbox` (append-only scan/dispute commands), `syncState` (cursor/businessDate), `fieldSession`
- **Service worker**: App shell only via Workbox; API data never in HTTP cache
- **Offline rule**: Only confirm PAID from cache or show NOT_IN_OFFLINE_LIST. Never infer UNPAID
- **QR lookup**: Split token payload client-side for lookup only; no HMAC verification offline
- **Auth**: Access token in memory only; httpOnly refresh cookie for silent re-auth (D26). Shift grace configurable
- **Update policy**: Prompt user to reload, never mid-scan
- **Photos**: Bounded cache (recent scans), downscaled evidence for disputes

## Consequences

- Safe offline operation
- Works on low-end devices
- No false accusations
- Sync queue handles reconciliation
