# @tpirs/application

Use-case services wiring pure domain logic to ports and repositories: asset registry (`register`, `attachPhoto`, `getPhoto`, `getSticker`, `search`, `setStatus`, `correctAttributes`, `verifyQrToken`), owner registry, and OTP phone verification. No HTTP types and no vendor SDKs; `apps/api` composes these services into routes.

Tenant-varying behaviour (QR/short-code formats, sticker spec, branding, OTP message text) is read from validated tenant config at call time. `verifyQrToken` resolves opaque payloads cross-tenant under the system scope — see ADR 0007. Sticker SVG rendering (`sticker.ts`, `qrcode` library) is isolated here so a future `ReceiptRenderer` adapter can reuse it — ADR 0009.

Phase 3 added the financial services:

- **`ledger-service.ts`** — `LedgerService` posts balanced double-entry transactions and is bound to a transaction the caller owns: a posting and the state change it causes commit or roll back together. `withLedger(db, tenantId, fn)` is the tenant-scoped unit of work (it sets the application role and `app.tenant_id`, so row-level security applies). Reversals are requested first and approved second, by a different person, and post the mirrored entries in the same transaction as the approval (ADR 0013).
- **`obligation-service.ts`** — settles obligations from a payment. The flow is wallet-first: the payment credits the asset wallet, then the allocation engine moves wallet credit to revenue period by period. Money no period claims stays in the wallet, so a surplus is never lost and never silently becomes revenue (ADR 0010). The price that applied is snapshotted on the period (`fee_rule_key`, `fee_amount_snapshot_minor`).

Both services are idempotent per payment: a replayed webhook or a retried job
returns the original transactions instead of posting again.

## Phase 5: Driver channels

- **`ussd-service.ts`** — receives a tenant-resolved callback, applies the shared rate limiter and per-session locks, runs the pure `advanceUssdSession` engine over tenant menus, and returns the provider-shaped reply. The cache is consulted before the limiter so a genuine retry does not burn quota.
- **`driver-channel-service.ts`** — the driver-facing commands shared by USSD and SMS: check status for an asset reference or short code, report the current business day, and issue payment instructions. All copy comes from tenant message catalogs; under `pay_per_use` a day with no payment is never described as a debt.
- **`inbound-sms-service.ts`** — parses a provider callback, resolves the keyword from tenant config, applies the cost guard, and enqueues any reply transactionally (ADR 0021).
- **`sms-cost-guard.ts`**, **`rate-limiter.ts`** — per-tenant/per-recipient daily caps and a shared fixed-window limiter over `Cache`/`Clock` (ADR 0024).
- **`channel-renderer.ts`**, **`channel-outbox-sweeper.ts`**, **`channel-delivery-service.ts`** — render configured templates and deliver queued replies from the worker through the tenant's `SmsProvider`.
