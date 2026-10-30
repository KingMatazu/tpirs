# Penetration test scope and rules of engagement

Written so it can be handed to an external tester unchanged (D54, ADR 0045). The
same document is the script for the internal adversarial review this phase runs.

Last reviewed: 2026-10-30.

## Target

| Item         | Value                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------- |
| Application  | TPIRS revenue collection platform (API + admin dashboard + field PWA)                         |
| API base     | `https://<host>/v1` — a staging deployment with seeded data                                   |
| Dashboard    | `https://<host>/` (same origin; the dashboard proxies `/v1`)                                  |
| Field PWA    | `https://<host>:<field-port>/` when exposed, otherwise out of scope                           |
| Out of scope | payment/SMS/USSD provider dashboards, the hosting provider's control plane, physical stickers |

A test environment is provisioned from `pnpm setup` on a scratch database and is
destroyed afterwards. Never point a test at a database with real money in it.

## Accounts

| Tenant        | User              | Password                   | Role          | Use for                                    |
| ------------- | ----------------- | -------------------------- | ------------- | ------------------------------------------ |
| `alpha-state` | `alpha.admin`     | `alpha-admin-password`     | system admin  | config, users, audit; **no** ledger access |
| `alpha-state` | `alpha.officer`   | `alpha-officer-password`   | officer       | scans, disputes, paid-set sync             |
| `alpha-state` | `alpha.collector` | `alpha-collector-password` | collector     | cash intake, wallet                        |
| `beta-state`  | `beta.admin`      | `beta-admin-password`      | system admin  | second tenant for isolation tests          |
| `beta-state`  | `beta.finance`    | `beta-finance-password`    | finance admin | payments, reconciliation, reversals        |
| `beta-state`  | `beta.officer`    | `beta-officer-password`    | officer       | second tenant officer                      |

TOTP is off in the test environment (`REQUIRE_STAFF_TOTP=false`). If a test needs
it on, ask for a provisioning run with the flag enabled.

## Data

Seeded demo data: two tenants with different currencies, timezones and languages,
one registered asset with a sticker, one settled cash day, no real personal data.
Phone numbers are synthetic (`+2348000000…`).

## What to attack

Ordered by what would hurt most:

1. **Tenant isolation.** Can a `beta-state` session read, mutate or infer
   `alpha-state` rows by id, by reference, by scan, by export, or through the
   paid-set feed?
2. **Money movement.** Can an officer, collector or system admin post to the
   ledger, resolve suspense, approve their own reversal, or take cash beyond the
   float ceiling?
3. **Verification integrity.** Can a sticker token be forged, replayed after
   rotation, or made to return `paid` for an unpaid asset? Can the offline cache
   be tricked into showing `paid`?
4. **Webhook intake.** Can an unsigned or replayed payload create a payment, a
   duplicate ledger entry, or a second receipt? Can one tenant's endpoint token
   deliver into another tenant?
5. **Session handling.** Token theft, refresh replay, revocation lag, device
   binding, privilege escalation through role changes, logout that does not
   revoke.
6. **Injection and parsing.** SQL/NoSQL injection through every query parameter,
   template injection in SMS/USSD copy, path traversal in photo serving, XXE or
   decompression bombs in settlement import.
7. **Abuse controls.** Rate-limit bypass (header spoofing, key rotation),
   enumeration through error messages or timing, SMS cost amplification.
8. **Exposure.** Secrets in responses or logs, stack traces, `/metrics` reachable
   from outside, CORS misconfiguration, cacheable authenticated responses.

## Rules of engagement

- Testing runs against the staging deployment only; no destructive volume tests
  without written approval.
- DoS and load testing is **out of scope** here — the load harness owns it.
- No social engineering of staff, no testing of the hosting provider.
- Stop and report immediately if you find live personal data or a path to real
  money movement.
- Rate limits are on: expect `429`s and treat them as working controls.

## Evidence expected back

For each finding: an id, a severity (critical/high/medium/low), the area, a
reproduction with the exact request and response, the affected data, and a
suggested fix. Retests are recorded against the same id in
[`findings.md`](./findings.md).

## What is already covered by automation

Do not spend the budget re-proving these; try to break them instead:

- `apps/api/src/routes/access-matrix.test.ts` — every route classified public /
  authenticated / permissioned, and the role defaults.
- `packages/db/src/rls-coverage.test.ts` — every tenant table has RLS and a
  policy; scoped reads and writes are confined; the app role cannot bypass RLS.
- `scripts/security/probe.sh` — fourteen scripted attacks against a running API
  (unauthenticated access, privilege boundaries, tenant isolation, forged tokens,
  revocation, body limits, login throttling, header spoofing).
- `scripts/ci/audit.sh` — dependency advisories.
- `scripts/db/restore-drill.sh` — recovery, not security, but it exercises the
  data-integrity checks an attacker would try to subvert.

## Internal review record

The internal adversarial review for this phase was run by the platform team on
2026-10-30: `scripts/security/probe.sh` (14/14 checks passed) plus the suites
above, with the judgement-based observations recorded in
[`findings.md`](./findings.md). It is **not** an independent assessment, and the
delivery notes say so.
