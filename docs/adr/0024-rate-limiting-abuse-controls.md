# 0024: Rate limiting and abuse controls for channels and public verify

## Context

Unauthenticated endpoints (public verify, USSD callbacks, inbound SMS callbacks) are abuse-prone. We need shared abuse controls using existing ports (`Cache`, `Clock`) without creating a new infrastructure dependency. Tenant limits exist for channels (USSD/SMS settings), but the verify endpoint has no tenant context until after asset lookup, and callbacks need protection before processing. Under `pay_per_use`, we must never send unpaid-day reminders or use debt wording (enforced by templates/logic).

## Decision

- **Shared fixed-window limiter.** `createRateLimiter({ cache, clock })` in `@tpirs/application` provides `consume(key, { limit, windowSeconds })` returning `{ allowed, remaining, retryAfterSeconds }`. Keys are namespaced (e.g., `verify:ip:{ip}`, `ussd:ip:{ip}`, `ussd:msisdn:{msisdn}`, `sms:msisdn:{msisdn}`).
- **Verify route.** `GET /v1/verify/:token` uses a platform constant `VERIFY_RATE_LIMIT = { limit: 60, windowSeconds: 60 }` per IP (not tenant config) because tenant is unknown pre-lookup; on exceed returns 429 with `Retry-After` and standard error envelope (D5).
- **USSD.** Cache-first checks, per-IP and per-MSISDN limits from tenant config, with locks around actions. Retries don’t consume quota unnecessarily; malformed callbacks return provider-compatible errors.
- **SMS.** Rate limiting plus `SmsCostGuard` counts sent channel replies and `sms_log` receipts per tenant and per recipient per business day (timezone from config); receipts are never suppressed. No scheduled reminders under `pay_per_use`.
- **Callbacks tenancy.** Endpoint tokens resolve tenant before rate-limited processing where possible; unknown/revoked/disabled adapters return 404 identically.

## Consequences

- Abuse is throttled without vendor-specific features.
- Platform limits protect endpoints that cannot be tenant-scoped early.
- Cost is controlled and pay-per-use policy is enforced.

## Alternatives considered

- **Redis rate limiter only.** Rejected: we need to work with `Cache` port and avoid hard dependency; Redis adapter can be added later.
- **Tenant config for verify limit.** Rejected: requires tenant resolution before lookup (impossible without leaking existence); platform constant is safer and simpler.
- **Per-endpoint custom logic.** Rejected: shared limiter ensures consistent behavior and testability.
