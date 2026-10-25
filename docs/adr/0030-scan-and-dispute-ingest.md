# ADR 0030: Scan and dispute ingest

## Status
Accepted

## Context
Need to log officer scans and accept disputes, supporting offline queue with idempotency.

## Decision
- **Idempotency**: Client-generated UUIDs (`clientScanId`, `clientDisputeId`) with unique constraints per tenant
- **Scan logging**: Store `observed_status` (what officer saw) and `authoritative_status` (server recomputed). One row per scan.
- **No money paths**: Scans/disputes never create ledger entries
- **Disputes**: Status `open` initially, evidence optional single photo (base64 JSON), stored via ObjectStorage
- **Permissions**: `scan:read`, `scan:record`, `dispute:create` added with backfill
- **Audit**: POST operations audited via middleware; operational tables are append-only for scans/disputes core fields
- **Rate limiting**: Applied to authenticated search and verify endpoints

## Consequences
- Full audit trail of field activity
- Safe offline replay
- No financial side effects from field operations
- Disputes route to review process (Phase 8)
