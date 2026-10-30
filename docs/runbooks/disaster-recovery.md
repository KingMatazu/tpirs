# Runbook: disaster recovery

For the mechanics of backup and restore see
[`backup-and-restore.md`](./backup-and-restore.md). This runbook is the decision
path: what happened, who decides, what must be true before traffic returns
(Phase 10, Step 9; D52, ADR 0043).

## Targets

| Measure | Target for the pilot | Basis                                                      |
| ------- | -------------------- | ---------------------------------------------------------- |
| RPO     | 24 hours             | nightly logical dump; the gateway holds the payment record |
| RTO     | 2 hours              | measured restore plus verification and smoke test          |

Both are re-stated by the drill on the target hardware. A target nobody has
measured is a wish.

## Who decides

- **Incident commander:** the on-call engineer until the state's operations team
  takes over. One person declares an incident and one person communicates.
- **Data-loss decisions** (restore over live data, accept a gap, re-import a
  settlement window) belong to the finance owner and the incident commander
  together, recorded in the incident log with a timestamp.
- **Secret rotation** is the incident commander's call; it is never deferred to
  "after the incident" when a key is suspected compromised.

## Decision path

1. **Is the API answering?** `GET /v1/health` and `GET /v1/ready`. Not ready →
   database or dependency. Continue.
2. **Is the database reachable?** If not, is it the process, the network or the
   data? A restart that fails twice is a data incident, not a process incident.
3. **Is the data intact?** Row counts, ledger balance, migration table — the same
   three checks `restore.sh` runs. If they fail, treat as data loss.
4. **Can we restore inside the RTO?** Run the drill path against a scratch
   database first. Never discover a broken backup by restoring over production.
5. **Is the failure still happening?** A restore into a host that is still
   compromised repeats the incident. Rotate the credential first.

## Scenarios

### Database loss or corruption

1. Stop the API and the worker.
2. Back up whatever survives — it may hold rows the nightly dump does not.
3. Restore into a scratch database, let the checks pass, promote it
   ([backup-and-restore.md](./backup-and-restore.md#promoting-a-scratch-restore)).
4. Re-import the settlement statement for the gap window; the provider's record
   is authoritative for money that arrived.
5. Reconcile the gap day and sign it off with a note explaining the incident.

**Expected loss:** up to 24 hours of payments that the gateway will re-present,
plus SMS delivery records. The ledger can be rebuilt from settlement; the audit
trail cannot be recreated, which is why it is append-only and dumped nightly.

### Object storage loss

Photos and exports are gone; money is not. The API keeps working (a missing photo
renders as unavailable). Owners and officers re-upload evidence on request.
Nothing here blocks traffic; it is a data-quality incident, not a financial one.

### Region or host loss

Provision the target, restore the latest dump, rotate the credentials the old
host held, update DNS, then smoke test. The deploy target's runbook owns the
infrastructure steps; this runbook owns the data steps.

### Bad migration

1. Stop the worker first: it schedules reconciliation and would run against a
   half-migrated schema.
2. Roll back with `pnpm db:migrate:down` if the migration is reversible — CI
   proves every migration rolls back to zero, so this is the expected path.
3. If it is not reversible, restore the last dump taken before the deploy.
4. Record which migration, which deploy SHA, and whether data was lost.

### Leaked QR signing key

A forged sticker could be made to verify as a real asset.

1. Rotate the key (`SECRET_QR_TOKEN_SIGNING_KEY`) — see rotation below.
2. Re-issue stickers: the token is derived from the asset's stored QR payload, so
   new tokens verify against the new key while old printed stickers stop working.
   Plan a reprint with the state; until then officers fall back to manual search
   and the SMS check.
3. Review scans in the window for assets whose sticker could not have been
   printed.

### Compromised staff session or password

1. Revoke the user's sessions (`POST /v1/auth/logout` server-side revocation is
   per token; a bulk revoke is a database update of `sessions` — never a ledger
   or audit row).
2. Force a password reset and, where enabled, re-enrol TOTP.
3. Read the audit trail for that user: every state-changing request is recorded
   with actor, request id and before/after.

### Payment provider outage

No new payments arrive; verification keeps working from the ledger, and the field
app keeps working from its paid-set cache. Do **not** invent "unpaid" states —
under `pay_per_use` a day without a payment is not a debt. Finance re-imports
the settlement statement when the provider recovers.

## Secret rotation

Rotation is manual today; automation waits for a real secrets manager (recorded
as deferred in the Phase 10 plan).

| Secret                        | Where                                              | Rotation effect                                                   |
| ----------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| `SECRET_QR_TOKEN_SIGNING_KEY` | env / secrets provider, ref `qr-token-signing-key` | printed stickers stop verifying; reprint planned with the state   |
| Webhook endpoint tokens       | per tenant, stored as a SHA-256 hash               | the provider must be updated; the old token stops resolving       |
| Payment provider API keys     | `SecretsProvider`, referenced by tenant config     | no data change; re-check settlement import afterwards             |
| SMS/USSD provider credentials | `SecretsProvider`                                  | deliveries fail until updated; outbox retries                     |
| Database credentials          | deploy target                                      | restart API and worker after rotating; connections are pooled     |
| Staff sessions                | `sessions` table                                   | revoking a session forces sign-in; the refresh chain fails closed |

Rotation order when a key may be compromised: revoke first, rotate second,
investigate third. A rotation that leaves the old key valid for a day is not a
rotation.

## Before traffic returns

All of these must be true, and the result is written into the incident log:

- [ ] API `/v1/health` and `/v1/ready` answer.
- [ ] `sh scripts/ci/smoke.sh` passes.
- [ ] Ledger debits equal credits.
- [ ] Row counts match the manifest of the restored dump.
- [ ] The migration table shows every migration applied.
- [ ] A verify scan of a known paid asset returns `paid`; one of an unpaid asset
      returns `no_payment_recorded` (never "unpaid").
- [ ] The worker's heartbeat is present and its outbox backlog is draining.
- [ ] The gap window is reconciled and signed off, or explicitly logged as open.

## After the incident

- Write the timeline: detection, decision points, restore duration, data gap.
- Re-run the drill on the hardware that failed and record it in
  [`backup-and-restore.md`](./backup-and-restore.md).
- If the incident found a missing alert, add it to `infra/alerts/tpirs.rules.yml`
  with a runbook entry ([`alerting.md`](./alerting.md)).
