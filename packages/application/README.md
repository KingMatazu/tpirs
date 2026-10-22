# @tpirs/application

Use-case services wiring pure domain logic to ports and repositories: asset registry (`register`, `attachPhoto`, `getPhoto`, `getSticker`, `search`, `setStatus`, `correctAttributes`, `verifyQrToken`), owner registry, and OTP phone verification. No HTTP types and no vendor SDKs; `apps/api` composes these services into routes.

Tenant-varying behaviour (QR/short-code formats, sticker spec, branding, OTP message text) is read from validated tenant config at call time. `verifyQrToken` resolves opaque payloads cross-tenant under the system scope — see ADR 0007. Sticker SVG rendering (`sticker.ts`, `qrcode` library) is isolated here so a future `ReceiptRenderer` adapter can reuse it — ADR 0009.

Phase 3 added the financial services:

- **`ledger-service.ts`** — `LedgerService` posts balanced double-entry transactions and is bound to a transaction the caller owns: a posting and the state change it causes commit or roll back together. `withLedger(db, tenantId, fn)` is the tenant-scoped unit of work (it sets the application role and `app.tenant_id`, so row-level security applies). Reversals are requested first and approved second, by a different person, and post the mirrored entries in the same transaction as the approval (ADR 0013).
- **`obligation-service.ts`** — settles obligations from a payment. The flow is wallet-first: the payment credits the asset wallet, then the allocation engine moves wallet credit to revenue period by period. Money no period claims stays in the wallet, so a surplus is never lost and never silently becomes revenue (ADR 0010). The price that applied is snapshotted on the period (`fee_rule_key`, `fee_amount_snapshot_minor`).

Both services are idempotent per payment: a replayed webhook or a retried job
returns the original transactions instead of posting again.
