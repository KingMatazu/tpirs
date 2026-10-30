# Security findings register

Every finding, accepted risk and observation from the internal adversarial review
(D54, ADR 0045). An external engagement records its findings here too, against
the same ids.

**Status:** no open critical or high findings. Five accepted risks, each with an
owner and a date, and one medium fixed during manual testing.

Last review: 2026-10-30, internal adversarial review by the platform team.

## Summary

| Severity | Open | Accepted | Fixed |
| -------- | ---- | -------- | ----- |
| Critical | 0    | 0        | 0     |
| High     | 0    | 0        | 1     |
| Medium   | 0    | 3        | 2     |
| Low      | 0    | 2        | 0     |

## Findings

### F-01: Every payment webhook was refused (fixed)

- **Severity:** high (functional, not exploitable)
- **Area:** payment intake / composition root
- **Found:** 2026-10-30, while writing the webhook load scenario (Step 11).
- **Detail:** `apps/api/src/index.ts` never wired `paymentProviders`, so
  `requireProvider` threw for every delivery and no payment could be recorded.
  The adapters existed and passed their conformance suites, which is why the
  unit and integration layers did not notice.
- **Fix:** the Paystack and Remita adapters are wired in the composition root.
  `scripts/load/run.sh webhooks` now proves intake end to end (200/200 accepted).
- **Retest:** 2026-10-30 — 200 signed payloads, all `200`, 10% replays deduped.

### F-08: A bad query filter returned 500 and echoed the database message (fixed)

- **Severity:** medium (wrong status plus information disclosure)
- **Area:** audit search, reconciliation exception filter
- **Found:** 2026-10-30, by manual testing — `GET /v1/audit?actor=dfgjgh`
  returned `500` with `invalid input syntax for type uuid: "dfgjgh"` in the
  response body.
- **Detail:** query-string ids were passed straight into `uuid` columns, so a
  typo became a Postgres cast error. The error handler also echoed any 5xx
  message to the client, so the response leaked SQL-level detail.
- **Fix:** `isUuid()` validates `actor` and `runId` before the query and returns
  `400 bad_request` with the standard envelope; `clientErrorMessage()` replaces
  every 5xx message with "Internal server error" and keeps the detail in
  telemetry alongside the request id.
- **Retest:** 2026-10-30 — the same request returns `400` with
  `actor must be a user id`; `server.test.ts` asserts a 5xx never echoes the
  original message.

### F-02: Rate limiting and USSD locks are per process (accepted)

- **Severity:** medium
- **Area:** abuse controls, `Cache`/`LockService`
- **Detail:** both ports are mock adapters, so counters live in one process's
  memory. With two API replicas the effective login/verify limit doubles, and a
  USSD lock does not span processes.
- **Why accepted:** the pilot runs one API replica (recorded in the Phase 10
  plan). Scaling out without the Redis adapters would weaken the control.
- **Owner:** platform team. **Review:** before any multi-replica deployment.

### F-03: Alert rules exist but nothing notifies (accepted)

- **Severity:** medium
- **Area:** operations, `infra/alerts/`
- **Detail:** the rules evaluate; delivery is a deploy-target adapter (D53). An
  operator who assumes someone is paged would be wrong.
- **Why accepted:** the deploy target is still `noop`; wiring a vendor now would
  pick one before procurement does. The gap is stated in the alerting runbook
  and the delivery notes.
- **Owner:** platform team. **Review:** at pilot onboarding.

### F-04: Webhook endpoint tokens do not expire (accepted)

- **Severity:** medium
- **Area:** payment intake, `webhook_endpoints`
- **Detail:** a token is created per tenant and provider and stays valid until
  revoked. There is no rotation schedule and no automatic expiry.
- **Why accepted:** rotation is manual and documented in the disaster-recovery
  runbook; providers must be updated in the same change, so automating it needs
  provider-side coordination the pilot does not have.
- **Owner:** platform team. **Review:** Phase 11 onboarding checklist.

### F-05: The audit trail is append-only but not tamper-evident (accepted)

- **Severity:** medium
- **Area:** audit log
- **Detail:** UPDATE/DELETE are blocked by trigger and privilege, but a database
  superuser can disable a trigger. There is no hash chain or external anchor, so
  an insider with superuser rights could alter history and leave no trace.
- **Why accepted:** the superuser is the trust boundary of the deployment; the
  nightly dump and the state's own database controls are the compensating
  measure. A hash chain is a real improvement, not a Phase 10 deliverable.
- **Owner:** platform team. **Review:** when the state's audit requirements are
  known (Phase 11).

### F-06: `/metrics` is unauthenticated when enabled (accepted)

- **Severity:** low
- **Area:** observability
- **Detail:** the endpoint carries aggregate counts only — no personal or
  financial data — but it reveals traffic shape and route names.
- **Why accepted:** it is disabled by default (`METRICS_ENABLED=false`) and the
  runbook requires it to stay on the internal network. A token would complicate
  scraping for little gain (ADR 0042).
- **Owner:** platform team. **Review:** at pilot onboarding.

### F-07: System administrators can change roles and tenant config (accepted, by design)

- **Severity:** low
- **Area:** authorisation model
- **Detail:** a `system_admin` cannot touch the ledger, but can grant any role to
  any user in their tenant, including `finance_admin`, and can edit tenant
  config (fee rules, channel copy).
- **Why accepted:** this is the documented separation (build brief §6): the
  system admin runs the platform, finance runs the money, and every change is
  audited. It is recorded here so nobody reads it as an oversight.
- **Owner:** platform team. **Review:** with the state's IT governance.

## What was checked and passed

Not findings, but the evidence behind "no open critical or high":

| Check                                                              | Result                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Unauthenticated access to payments, audit, metrics                 | 401 / 401 / 404                                                               |
| Officer creating an asset                                          | 403                                                                           |
| Finance reading the audit log                                      | 403                                                                           |
| System admin reading the ledger (`/v1/reversals`)                  | 403                                                                           |
| Cross-tenant asset and sticker read                                | denied (403)                                                                  |
| Forged QR checksum, malformed token                                | 404                                                                           |
| Bearer after logout                                                | 401                                                                           |
| Body above 1 MiB                                                   | 413                                                                           |
| Sixth login attempt for one username                               | 429 with `Retry-After`                                                        |
| Spoofed `X-Forwarded-For` on a throttled username                  | still 429                                                                     |
| Route × role matrix (`access-matrix.test.ts`)                      | 10/10                                                                         |
| RLS coverage and cross-tenant confinement (`rls-coverage.test.ts`) | 5/5                                                                           |
| Dependency audit (`scripts/ci/audit.sh`)                           | no production high/critical; two dev-only criticals allowlisted to 2026-12-31 |

Reproduce with:

```sh
sh scripts/security/probe.sh http://localhost:3000   # seeded API
sh scripts/ci/security.sh                            # audit + matrix + RLS
```

## Recording a new finding

1. Take the next id (`F-08`, …) and state severity, area, reproduction.
2. If it is fixed in the same change, record the commit and the retest.
3. If it is accepted, name the owner, the reason and a review date — an accepted
   risk without a date is an ignored one.
4. Re-run `scripts/security/probe.sh` and `scripts/ci/security.sh` and update the
   table at the top.
