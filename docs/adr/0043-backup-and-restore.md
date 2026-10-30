# ADR 0043: Nightly logical backups, RPO 24 h, RTO 2 h

## Status

Accepted

## Context

The ledger is the system of record for money that has already been collected, and
the audit log is the evidence trail behind it. Losing either is not a bug, it is
an incident the state has to explain. Until Phase 10 there was no backup story at
all: `infra/docker-compose.yml` keeps a named volume, which protects against a
container restart and nothing else.

Options considered:

1. **Managed snapshots from the hosting provider** — the least work, but the
   provider is not chosen yet (D1) and the deploy target is still `noop`, so it
   would encode a vendor into the plan before the vendor exists.
2. **Continuous WAL archiving / point-in-time recovery** — the strongest
   guarantee, minutes of data loss at most, but it needs an archive destination,
   a retention policy and an operator who can drive a PITR restore. That is a
   real infrastructure commitment for a pilot that has not signed an SLA.
3. **Nightly logical dump plus an object-store copy** — portable across any
   Postgres, restorable into a scratch database by one script, and honest about
   its 24-hour window.

## Decision

- **Nightly `pg_dump --format=custom`** of the database, plus a copy of the object
  store (the SeaweedFS volume, or an `s3 sync` through the storage adapter), plus
  a manifest: git SHA, migration version, per-table row counts and SHA-256 sums
  for both artefacts.
- **RPO 24 hours, RTO 2 hours for the pilot.** Stated as the target, measured by
  the drill, and revisited if the state signs an SLA tighter than a day.
- **Restores go to a scratch database by default.** `restore.sh` refuses to touch
  a target it was not explicitly given, so the drill and a real recovery use the
  same code path and the dangerous direction needs a deliberate argument.
- **The drill is the deliverable, not the script.** `scripts/db/restore-drill.sh`
  backs up, restores, runs `migrate check`, verifies integrity (debits equal
  credits, audit row count, tenant configs load, RLS enabled on every tenant
  table), starts the API against the restored database and runs the smoke test.
  Its output — date, dump size, restore duration, verification result — is
  recorded in `docs/runbooks/backup-and-restore.md`.
- **Retention and off-site copies belong to the deploy target.** The repo ships
  the script, the manifest and the drill; where the dumps live, how long they are
  kept and whether they leave the region is the state's decision and the target's
  configuration.
- **Object storage is copied, not snapshotted.** A volume copy is not
  point-in-time consistent with the database dump, so the DR runbook says what to
  do with photos referenced by restored rows: a missing photo is a re-upload, a
  stale photo is harmless, and neither blocks revenue.

## Consequences

- Any Postgres can be restored from, including a different provider, which keeps
  D1 open.
- Up to a day of payments can be lost in a disaster. The reconciliation and
  settlement import can rebuild what the gateway holds, and the DR runbook makes
  that the first recovery step rather than an afterthought.
- A logical dump is slow on a large database and takes a consistent snapshot via
  `pg_dump`'s transaction, so the API can keep serving during the backup; the
  cost is I/O, not downtime.
- The drill becomes a recurring obligation (monthly), because an untested backup
  is a rumour. The runbook carries the schedule and the sign-off.
- Secrets are not in the dump beyond what the schema stores — password hashes and
  session rows are, so a dump is treated as sensitive material: encrypted at rest
  at the destination, never committed, never attached to a ticket.

## Alternatives considered

- **Continuous WAL archiving (PITR)** — rejected for the pilot: it needs an
  archive destination and an operator runbook that does not exist yet, and no SLA
  has been signed that requires better than 24 hours. Revisit when one is.
- **Provider snapshots only** — rejected: it binds recovery to a vendor that has
  not been chosen and cannot be exercised locally in a drill.
- **Logical dump per table with `COPY`** — rejected: it reimplements `pg_dump`
  with worse consistency guarantees.
- **Backing up the object store only** — rejected: the photos are evidence, the
  ledger is money. Losing the ledger is the incident.
