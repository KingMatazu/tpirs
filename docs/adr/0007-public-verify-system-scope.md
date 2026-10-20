# 0007: Public QR verification resolves assets under the system scope

## Context

Officers scan a sticker QR and hit `GET /v1/verify/:token` without credentials
(field conditions, shared devices). The token is an opaque payload plus HMAC
checksum and deliberately reveals nothing about its tenant, so the lookup cannot
start from a tenant. Every other read runs inside a tenant's row-level-security
scope via `withTenant`; verification needs a deliberate exception.

## Decision

- `AssetService.verifyQrToken` verifies the HMAC first (forged checksums fail
  before any database access), then resolves the opaque payload with
  `withSystem`, which bypasses RLS for exactly this cross-tenant lookup.
- A bad checksum and an unknown-but-well-formed payload both surface as the
  same 404 (`AssetNotFoundError` / `InvalidQrTokenError` are indistinguishable
  to the caller), so probing cannot enumerate valid payloads.
- The response contains only registration facts (status, type, short code,
  attributes, photo URLs). No payment status exists until the ledger phase; an
  absent field must never be read as UNPAID (build brief section 6/8).

## Consequences

- `withSystem` remains forbidden for request handling _except_ this verified-token
  lookup; the token signature is the authentication for the cross-tenant read.
- Rate limiting is not yet applied to the public endpoint; it arrives with the
  driver channels phase (recorded in `docs/decisions-needed.md`).
- Key rotation (D2) will need a verification path that tries current and next
  keys; the current code uses a single key from `SecretsProvider`.

## Alternatives considered

- **Tenant hint in the QR payload**: rejected — the token must reveal nothing,
  and a tenant field would leak deployment structure to anyone holding a sticker.
- **Unauthenticated lookup restricted by IP allowlist**: field networks are
  unpredictable; the HMAC check plus fail-closed 404 is sufficient for Phase 2.
