# Phase 10 implementation: hardening

Phase 10 turns the delivered platform (phases 0–9) into something an operator can
run in production: measurable under peak-hour load, provably isolated between
tenants, restorable from backup, and observable when a failure path is exercised.
It adds no product features. Every change here is either a guard (test, script,
gate) or an operational artefact (runbook, alert rule, budget).

The acceptance check from `AGENTS.md`:

> **No open critical or high findings; restore drill passed; load targets met.**

This plan is the working checklist for that. Steps are marked `(pending)` and
flipped to `(completed)` as each lands, one commit per step.

## What already exists (delivered before this phase)

| Control                                                             | Where                                                                            | State     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------- |
| Row-level security + tenant scoping                                 | migrations, `packages/db/src/tenant-scope.ts`                                    | completed |
| Append-only ledger and audit tables                                 | migrations (rejecting triggers + revoked privileges)                             | completed |
| Audit on every mutating request                                     | `apps/api/src/audit.ts`                                                          | completed |
| Permission model, role sets, `system_admin` cannot touch the ledger | `packages/domain/src/tenancy.ts`, `authz.ts`                                     | completed |
| Dual-approval reversals                                             | `packages/application/src/ledger-service.ts`, ADR 0013                           | completed |
| Webhook signature verify, dedupe, outbox                            | `apps/api/src/routes/webhooks.ts`, ADRs 0016/0017                                | completed |
| Rate limits on verify / USSD / SMS                                  | ADR 0024, `apps/api/src/routes/{verify,field}.ts`                                | completed |
| Request IDs + one error envelope                                    | `apps/api/src/server.ts`, `errors.ts`                                            | completed |
| Health and readiness endpoints                                      | `GET /v1/health`, `GET /v1/ready`                                                | completed |
| Telemetry port + console JSON sink                                  | `packages/adapters/telemetry/otel`                                               | completed |
| Graceful shutdown (API + worker)                                    | `apps/api/src/index.ts`, `apps/worker/src/index.ts`                              | completed |
| CI: lint/types/build, integration, migration check                  | `scripts/ci/{verify,integration,migration-check}.sh`, `.github/workflows/ci.yml` | completed |
| Nightly deep property tests                                         | `.github/workflows/nightly.yml`, ADR 0014                                        | completed |
| Smoke test (health, ready, request id)                              | `scripts/ci/smoke.sh`                                                            | completed |
| Local infra (Postgres, Redis, SeaweedFS)                            | `infra/docker-compose.yml`                                                       | completed |

## Gaps this phase closes

| Gap                                                      | Consequence today                                         | Step |
| -------------------------------------------------------- | --------------------------------------------------------- | ---- |
| No metrics endpoint or scrapeable format                 | counters go to stdout JSON; nothing can alert on them     | 1–2  |
| No performance budgets                                   | "slow" is a feeling, not a threshold                      | 2    |
| No load tests                                            | peak-hour webhook and verify behaviour is unmeasured      | 3    |
| No dependency audit in CI                                | a vulnerable transitive package ships silently            | 4    |
| No route × role matrix                                   | permissions are tested per route, not proven exhaustively | 5    |
| No "every tenant table has RLS" guard                    | a new table can forget RLS and nothing fails              | 6    |
| No body/timeout limits, security headers, login throttle | slowloris, brute force and header gaps are unaddressed    | 7    |
| No backup/restore scripts or drill                       | restore time is unknown until the day it is needed        | 8–9  |
| No DR runbook                                            | recovery is improvised                                    | 9    |
| No alert rules for failure paths                         | failures are found by users                               | 10   |
| Load and security gates are not in CI                    | regressions pass review                                   | 11   |
| No pen-test scope or findings register                   | "no open high findings" cannot be evidenced               | 12   |

## Scope decisions

- **No behaviour change without an ADR.** Every hardening change that alters
  runtime behaviour (metrics route, request limits, login throttle, headers)
  gets a short ADR and a test, in the same commit.
- **Prove, do not assert.** Each control ends with a test, a script, or a
  recorded drill result. A checkbox in this file without evidence stays pending.
- **No new runtime dependency without an ADR.** The load harness and any metrics
  library are judged against a zero-dependency alternative first.
- **Honest language.** If no external pen test is performed, the record says
  "internal adversarial review" — never "pen tested".
- **Backups are platform-level.** The repo ships scripts, a drill and a runbook;
  the storage vendor, retention and off-site copy belong to the deploy target.
- **Alerts ship as rules plus metric names.** Delivery (PagerDuty, e-mail, SMS)
  is a deploy-time adapter, recorded as such.
- **One replica is the default.** `Cache` and `LockService` are still mock-only,
  so rate limits and USSD locks are per process. Scaling the API past one
  replica is a decision item, not a Phase 10 deliverable (see Deferred).
- **Windows dev, Linux CI.** Load and restore drills run in CI or a Linux
  container; the Windows laptop only runs short smoke loads.

## Decisions recorded (D50–D55)

Answered before implementation; each has an ADR. Details and rejected
alternatives live in `docs/decisions-needed.md` and `docs/adr/`.

| ID  | Question                               | Decision                                                                                           | ADR  |
| --- | -------------------------------------- | -------------------------------------------------------------------------------------------------- | ---- |
| D50 | How is load generated and asserted?    | Node + `undici` harness under `scripts/load/`; budgets as thresholds in code; 10% webhook replay   | 0041 |
| D51 | How are metrics exposed and protected? | Prometheus text on `GET /metrics`, behind `METRICS_ENABLED`, internal-only, names are the contract | 0042 |
| D52 | Backup scope, RPO and RTO?             | Nightly `pg_dump --format=custom` + object-store copy + manifest; RPO 24 h, RTO 2 h                | 0043 |
| D53 | Where do alerts go?                    | `infra/alerts/tpirs.rules.yml` now; delivery is a deploy-target adapter, documented as a gap       | 0044 |
| D54 | Pen test: external or internal?        | Internal adversarial review, two engineers, vendor-ready scope doc; labelled honestly              | 0045 |
| D55 | Login brute-force policy?              | Per-IP + per-username fixed windows, throttle never lockout, TOTP on its own counter               | 0046 |

## Step 0: Reconcile and inventory (completed)

- Write this plan; record D50–D55 in `docs/decisions-needed.md` with ADRs 0041–0046
  (done before implementation started).
- Inventory the security surface into `docs/security/README.md`: which controls
  exist, where they are tested, and which are only asserted in prose. This is
  the document the pen test and the auditor read first.
- Delivered as [`security/README.md`](./security/README.md): six control groups,
  a "proven by" column per control, and explicit "not yet" rows for the controls
  this phase has not landed (login throttling, request limits and headers,
  backups). Anything without a test is marked as a claim, not as coverage.
- Commit: `docs(phase-10): outline hardening`.

## Step 1: Metrics endpoint and metric contract (completed)

- New `packages/adapters/telemetry/prometheus` (or extend the OTel adapter's
  sink) exposing counters and histograms in Prometheus text format, wired
  through the existing `Telemetry` port — no vendor SDK, no new runtime
  dependency (hand-rolled text rendering is ~60 lines and is what ADR 0042
  records).
- `GET /metrics` in `apps/api/src/server.ts`, registered like `/v1/health`,
  gated on `METRICS_ENABLED=true`, excluded from the audit hook and from the
  OpenAPI document (`schema: { hide: true }`).
- Metric contract (names are the alert contract in Step 10):
  `http_requests_total{method,status,route}`,
  `http_request_duration_seconds{route,method}` (histogram),
  `verify_lookups_total{result}`,
  `verify_lookup_duration_seconds`,
  `sync_paid_set_rows` (histogram),
  `webhook_events_total{provider,outcome}`,
  `outbox_backlog_age_seconds{queue}`,
  `job_queue_depth{queue}`,
  `worker_last_heartbeat_seconds`,
  `reconciliation_last_run_age_seconds{tenant}`,
  `sms_sent_total{provider,outcome}`,
  `rate_limit_rejections_total{scope}`.
- **Cardinality rule:** no label may carry a tenant slug, asset reference,
  plate, MSISDN, user id or request id. Tenant-scoped series use the tenant id
  only where a series per tenant is genuinely needed (reconciliation age), and
  the route label is the Fastify route pattern (`/v1/verify/:token`), never the
  resolved path.
- Tests: text format parses; counters move on a request; labels never include a
  plate or token; `/metrics` 404s when disabled.
- Delivered as `packages/adapters/telemetry/prometheus` (name
  `@tpirs/adapters-prometheus-telemetry`) wrapping the port and forwarding logs
  to the OTel console sink; request spans are not forwarded, so a per-request
  span does not become a log line on every call. The span duration still lands in
  the histogram, and attributes set during the span (the route pattern) become
  its labels.
- Emitted so far: `http_requests_total`, `http_request_duration_seconds`,
  `verify_lookups_total`, `rate_limit_rejections_total{scope="verify"}`. Step 10
  added the gauge method and the remaining emitters (webhook outcomes, worker
  heartbeat, outbox backlog age, reconciliation timestamp); the contract in
  `infra/alerts/metric-contract.json` is the current list.
- Commit: `feat(api): expose prometheus metrics behind a flag`.

## Step 2: Performance budgets (completed)

- `docs/performance-budgets.md` with the initial budgets below, the load
  profile that measures them, and how to re-baseline after a hardware or
  provider change.
- Encode the same numbers as thresholds in the load harness (Step 3) so a
  budget change is a one-line diff in two places, not prose drift.

| Path                                | Load                                 | p95    | p99    | Error budget                     |
| ----------------------------------- | ------------------------------------ | ------ | ------ | -------------------------------- |
| `POST /webhooks/{provider}`         | 50 rps sustained, 200 rps burst 60 s | 300 ms | 800 ms | 5xx < 0.1%                       |
| `GET /v1/verify/:token`             | 200 rps, warm cache                  | 150 ms | 400 ms | 5xx < 0.1%                       |
| `GET /v1/sync/paid?since=`          | 10 rps, 50k paid rows                | 800 ms | 2 s    | 5xx < 0.1%                       |
| `GET /v1/payments` (finance list)   | 20 rps, 100k payments                | 400 ms | 1 s    | 5xx < 0.1%                       |
| `GET /v1/verify/:token` (USSD path) | 30 rps                               | 250 ms | 600 ms | 5xx < 0.1%                       |
| Webhook accepted → ledger posted    | steady 50 rps                        | 5 s    | 15 s   | lag only                         |
| Nightly reconciliation, 100k assets | one run                              | 10 min | —      | must finish before next schedule |

- Record the machine profile each run was measured on (CI runner class), so
  numbers are comparable.
- Delivered in [`performance-budgets.md`](./performance-budgets.md), including
  the metric mapping, the re-baselining procedure and the known limits (one
  replica, warm cache, no network shaping).
- Commit: `docs(performance): set initial budgets`.

## Step 3: Load-test harness (completed)

- `scripts/load/` with:
  - `seed.mjs` — provisions a scratch tenant, users, assets and paid-set rows
    through the repositories (not raw SQL) so the data is schema-valid.
  - `scenarios/*.mjs` — `webhooks`, `verify`, `sync`, `payments`, `mixed`.
  - `run.mjs` — Node + undici worker pool, fixed-rate or closed-loop, collects
    latency percentiles and status counts, compares against Step 2 budgets,
    exits non-zero on a breach.
  - `assert.mjs` — post-run invariants: ledger debits equal credits, no
    duplicate payments for a replayed webhook, suspense count matches the
    intentionally unmatched batch, outbox drained, no 5xx in the run log.
- `scripts/load/run.sh` — same shape as `scripts/ci/integration.sh`: scratch
  Postgres on `:55433`, migrate, seed, start API + worker, run the scenario,
  tear down. Reuses `TEST_DATABASE_URL` conventions.
- Webhook load must sign payloads with the tenant's endpoint secret and include
  a deliberate replay percentage (10%) to prove idempotency under load.
- Tests: the harness itself gets a smoke test at low rate in CI (Step 11).
- Delivered as `scripts/load/` — `lib.mjs` (fixed-rate driver with bounded
  concurrency, percentiles, budget comparison), `scenarios.mjs` (`health`,
  `verify`, `payments`, `sync`), `run.mjs` (CLI, JSON report, non-zero exit on a
  breach), `seed.mjs` (mints a valid QR token for a seeded asset) and `run.sh`
  (scratch Postgres on `:55435`, migrate, seed, build, start the API, run, tear
  down).
- The abuse limiter is disabled for a load run (`LOAD_TEST_DISABLE_RATE_LIMITS`,
  honoured only outside production) because a budget must measure the route, not
  the throttle that protects it. The API logs a warning when it is on.
- The **webhook scenario is not delivered here**: it needs a provisioned endpoint
  token (stored only as a hash) and a provider-signed body, so it lands with the
  CI wiring in Step 11 rather than pretending an unsigned POST proves anything
  about intake. Recorded as the one gap in this step.
- Baseline recorded in [`performance-budgets.md`](./performance-budgets.md):
  verify/payments/sync are within budget at their nominal rates; verify saturates
  near 124 rps on a laptop, so its 200 rps target is a pilot-hardware target.
- Commit: `test(load): add the load harness and scenarios`.

Recorded in ADR 0041 (D50): Node + `undici`, no new dependency, budgets as code.

## Step 4: Dependency audit gate (completed)

- `scripts/ci/audit.sh`: `pnpm audit --audit-level high --prod` plus the full
  tree, failing on any high or critical advisory that has a fix.
- `docs/security/audit-allowlist.md`: each accepted advisory with the reason it
  cannot be fixed yet, the mitigating control, and an expiry date. The script
  fails when an entry is past its expiry, so the allowlist cannot rot.
- Wire it into CI as its own step so a transient registry outage is
  distinguishable from a real finding.
- Delivered as `scripts/ci/audit.sh` + `scripts/ci/audit.mjs`, with the policy in
  `docs/security/audit-allowlist.json` (machine-readable, expiry required). The
  gate found a real production high — zod, memory exhaustion — and it was fixed
  rather than allowlisted (zod 4.6.6, `@hookform/resolvers` 5). The two criticals
  are Vitest 3's tinypool, dev-only, allowlisted until 2026-12-31.
- Policy refinement: a **production** critical/high cannot be allowlisted at all;
  the allowlist only silences dev-only findings. Expired entries fail, and entries
  whose advisory disappeared are reported for deletion.
- Commit: `ci: fail the build on high and critical advisories`.

## Step 5: Route × role access matrix (completed)

- `apps/api/src/routes/access-matrix.test.ts`, driven by a table that pairs each
  registered route with the permission it requires, cross-checked against
  `app.printRoutes()` so a new route without a matrix entry fails the test.
- Assertions per role from `packages/domain/src/tenancy.ts`:
  - unauthenticated → `401` on everything except the documented public set
    (`/v1/health`, `/v1/ready`, `/v1/openapi.json`, `/v1/verify/:token`,
    `/webhooks/*`, channel callbacks, `/metrics` when enabled);
  - each role's allowed set matches its default permission set — no more, no less;
  - `system_admin` is refused on every ledger and reversal mutation;
  - `auditor` is refused on every mutating route;
  - a collector cannot read another collector's wallet.
- Negative cases in the same file: forged QR (flipped HMAC byte), expired and
  revoked session, device-binding mismatch, permission claim tampering.
- Delivered as `apps/api/src/routes/access-matrix.test.ts`: a source scan over
  `src/routes` classifies every registered route as public (with a written
  reason), authenticated without a permission (`/v1/auth/me`), or permissioned,
  and asserts the permission the handler actually calls. Loop-registered routes
  (wallet freeze/unfreeze, exception resolve) are asserted separately because
  their path is a variable. Role defaults are checked too: `system_admin` has no
  ledger or money permission, `auditor` holds only `:read`/`:export`, the officer
  holds no money-moving permission, and every matrix permission belongs to a
  role. Verified the guard bites: adding an unguarded route fails the suite.
- Note: the request-level negative cases (forged QR, replayed webhook, expired
  session) already exist in the per-route suites and the payment/ledger service
  tests; this file is the completeness guard, not a duplicate.
- Commit: `test(api): prove the route and role access matrix`.

## Step 6: RLS coverage guard and cross-tenant sweep (completed)

- `packages/db/src/rls-coverage.test.ts`: read `information_schema` for every
  table with a `tenant_id` column and assert `relrowsecurity` is on, at least one
  policy exists, and the app role cannot bypass it. A new table that forgets RLS
  fails this test — this is the durable guard, not a one-off check.
- Extend the cross-tenant suite: for each repository, a handle scoped to tenant A
  returns nothing for tenant B's ids (read, update, delete), and an insert with a
  mismatched `tenant_id` is rejected by the policy rather than the application.
- Assert the worker's cross-tenant access is confined to the two documented
  drains (`pending-sms.ts`, `pending-channel-messages.ts`) and that both filter
  by tenant after reading.
- Delivered as `packages/db/src/rls-coverage.test.ts` (integration-gated like the
  other DB suites). It reads `information_schema` and fails when a table with a
  `tenant_id` column has no RLS, or has RLS but no policy without being on the
  documented system-only list. It also proves the mechanism on real rows: the
  app role has `rolbypassrls = false`, a scoped read cannot see another tenant
  even with an explicit `where tenant_id = <other>`, a scoped insert under
  another tenant is refused by the policy, and the system scope still sees both.
- The guard immediately found a real state: `webhook_endpoints` has RLS enabled
  with no policy. That is correct (it is read under the system scope before a
  tenant is known, ADR 0017) and is now an explicit, documented exception rather
  than an accident.
- Commit: `test(db): guard row-level security coverage`.

## Step 7: API surface hardening (completed)

- Fastify limits in `apps/api/src/server.ts`: `bodyLimit`, `connectionTimeout`,
  `requestTimeout`, `keepAliveTimeout`, and a max header size; document the
  chosen numbers and why (a webhook body is small; a sticker photo upload is
  multipart and has its own limit).
- Security headers on every response (`x-content-type-options: nosniff`,
  `referrer-policy: no-referrer`, `x-frame-options: DENY`, HSTS only when
  `nodeEnv === "production"`). CORS stays absent by design — same-origin
  clients — and that decision is written down, not implied.
- Login and refresh throttle (D55, ADR 0046): fixed windows per IP
  (`login:ip:<ip>` 60/min, `auth.refresh:ip:<ip>` 30/min) and per username
  (`login:user:<tenant>:<username>` 5/min, `login:totp:user:<userId>` 5/min),
  through the existing `RateLimiter`, returning the standard `429` envelope with
  `Retry-After`. Throttle, never lock out; the limiter runs before the identity
  lookup so it cannot enumerate usernames.
- Log redaction: pino `redact` for `authorization`, `cookie`, `set-cookie`, body
  fields named `password`, `totpCode`, `refreshToken`; assert no plate, MSISDN or
  token appears in the webhook raw-payload log line.
- 5xx responses keep the envelope and request id, never a stack trace or SQL.
- Tests for each: header presence, body-limit 413, timeout behaviour, throttle
  after N attempts, redaction snapshot.
- Delivered:
  - **Limits** — global `bodyLimit` 1 MiB, `connectionTimeout`/`requestTimeout`
    30 s, `keepAliveTimeout` 72 s; the two upload paths opt into their own
    ceiling (photos 8 MiB, settlement import 16 MiB). Header size stays a Node
    flag (`--max-http-header-size`) and is documented rather than half-supported.
  - **Headers** — `nosniff`, `DENY`, `no-referrer`, `same-origin` opener policy on
    every response including errors; HSTS only when `nodeEnv === "production"`.
    CORS stays absent by design, now written down.
  - **Login throttling (D55, ADR 0046)** — `login:ip:<ip>` 60/min,
    `login:user:<tenant>:<username>` 5/min, `auth.refresh:ip:<ip>` 30/min and
    `login:totp:<tenant>:<username>` 5/min through the existing fixed-window
    limiter, consumed before the tenant or user lookup so a throttled answer
    cannot enumerate usernames. `429` carries the standard envelope and
    `Retry-After`; nothing locks out.
  - **Redaction** — pino `redact` over `authorization`, `cookie`, `set-cookie`
    and the three body secrets, exported as `LOG_REDACT_PATHS` so a test can
    assert the list rather than trusting it.
- One honest deviation from ADR 0046: the identity port checks password and TOTP
  together, so the TOTP counter is consumed whenever a code is presented, not
  strictly after a correct password. That is the closest signal without splitting
  the port, and a wrong password with a code is harmless to count.
- Commit: `feat(api): harden request limits, headers and login throttling`.

## Step 8: Backup and restore scripts (completed)

- `scripts/db/backup.sh <out-dir>`: `pg_dump --format=custom` for the database,
  a `tar` of the object-store volume (or `aws s3 sync` against the S3 adapter),
  a manifest with the git SHA, migration version, row counts and SHA-256 sums.
- `scripts/db/restore.sh <backup-dir> [target-url]`: restores into a scratch
  database by default, refusing to touch a URL that is not explicitly passed.
- Retention: keep N nightly dumps + one monthly (configurable by env); the
  off-site copy belongs to the deploy target and is documented as such.
- Tests: a script-level test that a backup of the seeded DB restores and passes
  `pnpm db:check`.
- Delivered:
  - `scripts/db/backup.sh` writes `database.dump` (`pg_dump --format=custom`), the
    object-store tarball when `OBJECT_STORAGE_BACKUP_PATH` is set (otherwise a
    manifest entry saying it was not included), `row-counts.txt`, `manifest.json`
    (timestamp, database, migration, git SHA, per-table counts) and
    `checksums.sha256`. Retention keeps the newest `BACKUP_KEEP` (default 7).
  - `scripts/db/restore.sh` restores into a **scratch database by default**
    (created on the `DATABASE_URL` server), refuses to overwrite the live
    database without an explicit URL _and_ `--force`, verifies the checksums, then
    checks per-table row counts against the manifest, that the ledger balances to
    zero, and that the migration table is populated.
  - `scripts/db/lib.sh` picks local `pg_dump`/`pg_restore` when present and falls
    back to the `postgres:16-alpine` image otherwise, rewriting `localhost` to
    `host.docker.internal` and handling Git Bash's path mangling.
  - `scripts/ci/backup-check.sh` proves it on every change: scratch Postgres →
    migrate → seed → backup → restore into a scratch DB → assert nothing is
    pending in `migrate status`. Wired into `.github/workflows/ci.yml`.
- One deviation from the plan text: the restored copy is checked with
  `migrate status` rather than `migrate check`, because `check` rolls the whole
  schema back to zero and therefore only works on an empty database. On a
  restored copy the right question is whether any migration is still pending.
- Verified locally: backup of a seeded database (39 tables, migration
  `0014_reconciliation`), restore into `tpirs_restore_<ts>`, row counts match,
  ledger balances, 14 migrations present.
- Commit: `feat(ops): add backup and restore scripts`.

## Step 9: Restore drill and disaster-recovery runbook (completed)

- `scripts/db/restore-drill.sh`: backup → restore into a scratch Postgres →
  `migrate check` → integrity queries (debits equal credits, audit row count,
  tenant configs load, RLS enabled on every tenant table) → start the API
  against the restored database → `scripts/ci/smoke.sh`. Prints a pass/fail
  summary and the measured wall-clock restore time.
- Run it for real and record the result (date, dump size, restore duration,
  verification output) in `docs/runbooks/backup-and-restore.md`.
- `docs/runbooks/disaster-recovery.md`: scenarios (database loss, object-store
  loss, region loss, bad migration, leaked QR signing key, compromised staff
  session, provider outage), the decision tree, who declares an incident, RTO
  and RPO per scenario (D52, ADR 0043: RPO 24 h, RTO 2 h for the pilot),
  communication steps, and the integrity checks that must pass before traffic
  returns.
- Secret rotation runbook: QR signing key (and what happens to printed
  stickers), webhook endpoint tokens, provider API keys, staff session revocation.
- Delivered:
  - `scripts/db/restore-drill.sh` runs the whole path on a throwaway database —
    migrate, seed, back up, restore into a scratch database, start the API
    against the restored copy, smoke test — and prints the measured durations.
    Executed: dump 194 KB, backup 8 s, restore 19 s, smoke passed (laptop
    measurement, recorded in the runbook).
  - [`backup-and-restore.md`](./runbooks/backup-and-restore.md): artefacts,
    commands, retention, the scratch-first restore, promoting a restore, the
    object-store caveat, and the recorded drill results table.
  - [`disaster-recovery.md`](./runbooks/disaster-recovery.md): targets, who
    decides, a five-step decision path, seven scenarios (database loss, object
    store, region, bad migration, leaked QR key, compromised session, provider
    outage), the secret-rotation table, and the pre-traffic checklist.
- Commit: `docs(runbooks): backup, restore and disaster recovery`.

## Step 10: Alert rules for failure paths (completed)

- `infra/alerts/tpirs.rules.yml` (Prometheus rule format) covering:
  - 5xx rate above 1% for 5 min;
  - p95 latency above the Step 2 budget for 10 min, per route;
  - `webhook_events_total{outcome="failed"}` increasing, or any dead-letter row;
  - `outbox_backlog_age_seconds` above the SMS delivery target;
  - worker heartbeat missing for 10 min;
  - reconciliation run older than its schedule + 2 h;
  - `rate_limit_rejections_total` spike (abuse or a broken client);
  - audit write failures and RLS denials (both are security signals).
- `docs/runbooks/alerting.md`: what each alert means, the first three things to
  check, and the escalation path. Delivery is recorded as a deploy-time adapter
  (D53, ADR 0044) — the rules exist and are tested against synthetic metric
  values, even when no pager is wired.
- Test: a unit test that every alert's metric name exists in the Step 1
  contract, so renaming a metric breaks the build rather than the alert.
- Delivered:
  - `infra/alerts/tpirs.rules.yml` — ten rules across availability, payment
    intake, delivery and abuse, each with a severity and a runbook anchor.
  - `infra/alerts/metric-contract.json` — the eight metrics the API and worker
    emit, with their labels; the contract the rules are tested against.
  - `apps/api/src/metrics-contract.test.ts` — parses the rules (including YAML
    block scalars and CRLF checkouts), and fails when a rule names a metric or
    label the contract does not declare, when an alert lacks a severity or a
    runbook link, or when a declared metric is unused.
  - [`alerting.md`](./runbooks/alerting.md) — one section per alert with the
    first three checks, plus the delivery gap stated plainly.
  - New emissions: a `gauge` method on the `Telemetry` port (with the OTel, mock
    and Prometheus adapters and the conformance suite), `webhook_events_total`
    from the intake route, `worker_last_heartbeat_seconds` and
    `outbox_backlog_age_seconds` from the worker (via a `SECURITY DEFINER`
    function added in migration 0015, so the worker never reads outbox content),
    and `reconciliation_last_run_timestamp_seconds` from the job runner.
- Deviation from the contract in Step 1: `job_queue_depth` and
  `reconciliation_last_run_age_seconds` are replaced by
  `outbox_backlog_age_seconds` and `reconciliation_last_run_timestamp_seconds`.
  Queue depth is a leading indicator that needs a port change and tells an
  operator less than the age of the work; a timestamp is the shape that goes
  stale when the worker stops, which is what the alert needs.
- Commit: `feat(ops): add alert rules for failure paths`.

## Step 11: CI wiring — security gate and load smoke (pending)

- `scripts/ci/security.sh`: audit (Step 4) + access matrix (Step 5) + RLS
  coverage (Step 6) against a scratch Postgres, so the security suite runs with
  the same infrastructure as `integration.sh`.
- `scripts/ci/load.sh`: a 60-second run at one quarter of the target rate, used
  as a regression gate; full-rate scenarios stay nightly.
- `.github/workflows/ci.yml`: add the security job.
- `.github/workflows/nightly.yml`: add the full load run and upload the result
  (percentiles + status counts) as an artefact, plus a one-line trend entry in
  `docs/performance-budgets.md` per release.
- Keep total PR time bounded: the load smoke must stay under ~3 minutes.
- Commit: `ci: run the security suite and a load smoke on every change`.

## Step 12: Pen-test readiness and findings register (pending)

- `docs/security/pen-test-scope.md`: targets and URLs, test accounts per role,
  seeded data set, out-of-scope items (third-party providers, physical stickers),
  rules of engagement (rate limits, no destructive tests on shared data), and the
  evidence format expected back.
- `docs/security/findings.md`: register with id, severity, area, owner, status,
  fix commit and retest evidence. Acceptance requires **zero open critical or
  high** entries — this file is the evidence, not a verbal assurance.
- This phase runs the **internal adversarial review** (D54, ADR 0045): two
  engineers, one attacking and one defending, neither signing off their own fix.
  The register and the delivery notes label the result "internal adversarial
  review", never "pen tested"; an external test stays open for procurement and
  the scope document is written vendor-ready.
- Commit: `docs(security): pen-test scope and findings register`.

## Step 13: Acceptance run and delivery notes (pending)

- Execute, in order: `pnpm format` → `pnpm lint` → `pnpm typecheck` →
  `pnpm test`, `scripts/ci/security.sh`, `scripts/ci/integration.sh`,
  `scripts/ci/migration-check.sh`, `scripts/ci/load.sh`, then the full-rate load
  run and `scripts/db/restore-drill.sh`.
- Fill the acceptance table below with numbers and dates; leave nothing as
  "expected".
- Update `README.md`, `AGENTS.md` (Phase 10 delivered, Phase 11 next),
  `docs/decisions-needed.md` (D50–D55 answered) and the new ADRs.
- Commit: `docs(phase-10): delivery notes`.

## Acceptance mapping

| `AGENTS.md` Phase 10 check                                            | Where it is proven                                                                     | Status  |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------- |
| No open critical or high findings                                     | `scripts/ci/audit.sh` green + `docs/security/findings.md` has no open critical/high    | pending |
| Access-control and cross-tenant tests                                 | Steps 5 and 6 suites, run by `scripts/ci/security.sh`                                  | pending |
| External pen test if possible                                         | `docs/security/pen-test-scope.md` + register (D54)                                     | pending |
| Restore drill passed                                                  | `scripts/db/restore-drill.sh` output recorded in `docs/runbooks/backup-and-restore.md` | pending |
| Disaster-recovery runbook                                             | `docs/runbooks/disaster-recovery.md`                                                   | pending |
| Load targets met (peak-hour webhooks, verify lookups, sync downloads) | Step 3 harness against Step 2 budgets, full run recorded                               | pending |
| Performance budgets and alerts                                        | `docs/performance-budgets.md` + `infra/alerts/tpirs.rules.yml`                         | pending |

## Risks and open questions

- **Per-process rate limits.** `Cache` and `LockService` are mock adapters, so
  limits and USSD locks do not span replicas. Fine for one API replica; a
  load test against two replicas would show weaker protection. Recorded as a
  decision, not silently accepted.
- **No alert delivery.** Rules without a pager can give false comfort; the
  runbook must say so until the pilot target wires delivery.
- **Object-store backups.** SeaweedFS volume copies are not point-in-time
  consistent with the database. The drill measures the drift and the DR runbook
  states what to do about photos referenced by restored rows.
- **Load numbers on CI hardware.** Percentiles from a shared runner are noisy;
  treat them as a regression signal, and re-baseline on the pilot hardware
  before promising an SLA.
- **Pen-test availability.** Procurement may not fund one in this phase; the
  acceptance wording allows the internal review path, but the record must be
  honest about which happened.
- **Login throttle vs. shared NAT.** Government offices share an egress IP;
  per-IP limits must be generous enough not to lock out a whole office, which is
  why D55 recommends per-username alongside per-IP.

## Deferred

- **Redis `Cache` and `LockService` adapters.** Needed before running more than
  one API replica; not needed for the single-replica pilot.
- **Continuous WAL archiving / point-in-time recovery.** Revisit if an SLA
  tighter than 24 h RPO is signed (D52).
- **Edge WAF / DDoS protection.** Belongs to the deploy target, not the app.
- **Automated secret rotation.** The runbook documents manual rotation; automation
  waits for a real secrets manager.
- **Chaos testing** (killing the worker mid-reconciliation, dropping the DB
  connection under load). Valuable, but after the restore drill proves the
  basics.
- **Playwright end-to-end suite.** The jsdom suite plus the API integration
  suite remain the contract; the field app's offline behaviour is covered by
  unit tests and a manual field checklist.
