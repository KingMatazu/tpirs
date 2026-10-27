# Field Operations Runbook

## Status

Phase 6 field verification and offline operations are complete.

## Shift Start

1. Login online (password + TOTP) at least once per shift
2. Sync paid set for current business day
3. If sync fails, app runs in offline mode - scans show NOT_IN_OFFLINE_LIST but no denials
4. Cache branding and officer identity

## Scanning

- **Online**: Scan QR or manual search → POST /v1/scans → display server result
- **Offline**: Scan QR → lookup in cached paid set → if found show PAID, else show NOT_IN_OFFLINE_LIST with SMS fallback instructions
- **Never show UNPAID** - absence means not in cache, not non-payment
- Queue offline scans for sync

## Disputes

- Create dispute with reason from config, description, optional photo (downscaled)
- Photo attached as base64 in request, stored in object storage
- Queued offline if network unavailable
- Status remains OPEN until resolved in Phase 8

## Sync

- Auto-sync on launch, reconnect, foreground, or manual "Sync now"
- Flush outbox oldest-first with exponential backoff
- On 401, refresh once then pause for login
- Fetch paid set as snapshot if date changed or no cursor, else follow delta pages
- Apply entries idempotently

## Offline Grace

- After initial login, app may operate offline for configurable grace window
- Access token in memory only; refresh cookie enables re-auth
- Queued items authorized/reconciled server-side on sync

## Stale Cache

- If paid set can't be fetched at shift start, banner shows "Cache stale"
- All scans return NOT_IN_OFFLINE_LIST
- SMS fallback available

## Field Test Checklist

- [x] Low-end Android device test
- [x] Direct sunlight readability
- [x] Airplane mode - scan paid asset (from cache) shows PAID
- [x] Airplane mode - scan unpaid asset shows NOT_IN_OFFLINE_LIST (no UNPAID text)
- [x] Reconnect and sync drains outbox
- [x] Scan log shows pending then synced
- [x] Dispute creation offline queues correctly
- [x] Camera permission denied - manual entry works
- [x] Killed and reopened app maintains queue
- [x] Page contains no "UNPAID" text

## SMS Fallback

"When no payment recorded in cache: Ask driver to text {keyword} {shortCode} to {senderId}"
