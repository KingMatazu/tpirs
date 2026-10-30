# Security controls: what exists, where it is proven

This is the inventory an auditor, a pen tester or a new engineer reads first. It
lists each control, where it lives, and **how it is proven** — a test, a script,
a drill, or (where nothing proves it yet) an explicit "asserted only" marker.
Entries are added as controls land; the Phase 10 plan
([`../phase-10-implementation.md`](../phase-10-implementation.md)) tracks the
gaps it closes.

Last reviewed: 2026-10-30 (Phase 10, Step 0).

## Identity and session

| Control                                                                                   | Where                                                                   | Proven by                                                             |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Staff password login, optional TOTP                                                       | `packages/adapters/identity-provider/db`, `apps/api/src/routes/auth.ts` | identity-provider conformance suite; `routes.test.ts` login cases     |
| Short-lived bearer in memory, refresh in httpOnly cookie                                  | ADR 0026, `apps/admin/src/session.ts`                                   | `session.test.ts` (refresh exactly once, fail closed)                 |
| Refresh token rotation, single use                                                        | `packages/db/src/repositories/session*`, `routes/auth.ts`               | `routes.test.ts` refresh cases                                        |
| Cookie scope: `HttpOnly`, `SameSite=strict`, `/v1/auth/refresh`, `Secure` only over HTTPS | `apps/api/src/routes/auth.ts`                                           | `routes.test.ts` asserts the cookie shape for a non-production config |
| Device binding for field sessions                                                         | `packages/db/src/repositories/device.ts`, `apps/api/src/auth.ts`        | `routes.test.ts` device-mismatch case                                 |
| Login and refresh throttling                                                              | Phase 10 Step 7 (planned)                                               | _not yet — see the Phase 10 plan_                                     |

## Authorisation

| Control                                                       | Where                                           | Proven by                                                  |
| ------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| Permissions as data; roles are default permission sets        | `packages/domain/src/tenancy.ts`, `authz.ts`    | `authz.test.ts`                                            |
| `system_admin` cannot touch ledger data; auditor is read-only | `packages/domain/src/tenancy.ts`                | `authz.test.ts`; route-level checks below                  |
| Every mutating route checks a permission                      | `apps/api/src/routes/*.ts`                      | per-route tests; the route × role matrix arrives in Step 5 |
| Cross-tenant reads are refused                                | `packages/db/src/tenant-scope.ts`, RLS policies | application tests listed under "Tenant isolation"          |

## Tenant isolation

| Control                                                                 | Where                                                                              | Proven by                                                         |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `tenant_id` on every tenant-owned table                                 | `packages/db/migrations`                                                           | Step 6 adds an automated coverage guard over `information_schema` |
| Row-level security policies per table                                   | migrations 0002–0014                                                               | `tenant-scope.ts` tests; cross-tenant cases in the repositories   |
| Application role cannot bypass RLS; worker drains use a documented path | `packages/db/src/tenant-scope.ts`, `pending-sms.ts`, `pending-channel-messages.ts` | repository tests; Step 6 extends this to every table              |

## Financial integrity

| Control                                                                | Where                                                                         | Proven by                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| Double-entry ledger, debits equal credits                              | `packages/domain/src/ledger.ts`, `packages/application/src/ledger-service.ts` | property tests (`fast-check`), ledger service tests |
| Ledger and audit tables append-only (trigger + revoked privileges)     | migrations 0002, 0004, 0012                                                   | migration tests that assert UPDATE/DELETE fail      |
| Corrections are reversing entries with a second approver               | ADR 0013, `ledger-service.ts`, `routes/reversals.ts`                          | `ledger-service.test.ts` dual-approval cases        |
| Idempotency keys on money-affecting POSTs                              | `packages/api-client/src/index.ts`, route handlers                            | `api-client` tests; per-route replay tests          |
| Webhook signature verification, dedupe, suspense for unmatched amounts | ADR 0016/0017, `routes/webhooks.ts`                                           | webhook route tests, payment service tests          |

## Abuse controls and transport

| Control                                                 | Where                                                       | Proven by                               |
| ------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------- |
| Rate limits on verify / USSD / SMS                      | ADR 0024, `routes/verify.ts`, `routes/field.ts`             | route tests (429 + `Retry-After`)       |
| Request IDs on every response and log line              | `apps/api/src/server.ts`                                    | `server.test.ts`                        |
| One error envelope, no stack traces or SQL in responses | `apps/api/src/errors.ts`, `server.ts`                       | `server.test.ts`, per-route error cases |
| Body size limits, timeouts, security headers            | Phase 10 Step 7 (planned)                                   | _not yet_                               |
| Dependency audit on critical/high                       | `scripts/ci/audit.sh`, `docs/security/audit-allowlist.json` | the gate itself, run in CI              |

## Data protection

| Control                                             | Where                                              | Proven by                          |
| --------------------------------------------------- | -------------------------------------------------- | ---------------------------------- |
| Minimal personal data; phone verification by OTP    | `packages/application/src/otp-service.ts`          | service tests                      |
| Secrets referenced, never stored in config          | `packages/adapters/secrets-provider/env`, ADR 0022 | channel-provider composition tests |
| Photos served through the API, never presigned URLs | ADR 0008                                           | storage route tests                |
| Backups, restore drill and retention                | Phase 10 Steps 8–9 (planned)                       | _not yet_                          |

## Audit trail

| Control                                                          | Where                                                 | Proven by                          |
| ---------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------- |
| Every state-changing request audited with actor and before/after | `apps/api/src/audit.ts`, migrations 0002              | audit route tests; `audit.test.ts` |
| Audit rows immutable                                             | migration 0002 trigger                                | migration tests                    |
| Audit search for finance and auditors                            | `GET /v1/audit`, `apps/admin/src/pages/AuditPage.tsx` | route + page tests                 |

## How to use this document

- **Pen test / adversarial review:** start from the "not yet" rows and the
  authorisation and tenant-isolation tables; `docs/security/pen-test-scope.md`
  (Step 12) defines the engagement.
- **Auditor:** the "Proven by" column is the evidence index. Anything marked
  "asserted only" is a claim without a test, and should be treated as such.
- **New engineer:** if you add a control, add a row with its proof in the same
  change. A control with no proof is a comment.
