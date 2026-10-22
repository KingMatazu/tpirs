# 0012: Ledger immutability and the deferred balance constraint

## Context

Build brief section 1 requires append-only financial truth: "ledger and audit
tables are never updated or deleted, enforced at the database level". Phase 3
also requires property tests proving that debits equal credits.

Application-level checks are not enough. A bug in a repository, a manual
`psql` session, or a future service could write an unbalanced or mutated
ledger row. The guarantee has to live in the database, and it has to hold even
for the role that owns the tables.

Enforcing the balance in the database has one wrinkle: a transaction is
inserted as one row per entry, so the balance is only knowable after the last
entry is inserted. A row-level `BEFORE INSERT` trigger would see a half-written
transaction and reject every posting.

## Decision

- `transactions` and `ledger_entries` are append-only, enforced twice:
  - a `BEFORE UPDATE OR DELETE` trigger that raises
    `ledger entries and transactions are append-only`, and
  - revoked `UPDATE` and `DELETE` privileges for the application role.
    The trigger covers the table owner; the revoked privileges cover the
    application role. Neither alone is sufficient.
- `obligation_periods` is a _state_ table, not an append-only one, so the
  application role holds `SELECT`, `INSERT`, and `UPDATE` on it. `DELETE` is
  revoked: deleting a period would erase the record of what was owed.
- **The double-entry invariant is a deferred constraint trigger.** Migration
  `0005_ledger_invariants.ts` creates `check_transaction_balanced()` and
  attaches it to `ledger_entries` as
  `AFTER INSERT OR UPDATE OR DELETE ... DEFERRABLE INITIALLY DEFERRED FOR EACH
ROW`. The function counts the entries of the affected transaction, requires
  at least two, requires a single currency, and requires
  `sum(debits) = sum(credits)`. Because the trigger is deferred, it fires once
  at `COMMIT`, when the final set of entries is visible, and the check is
  evaluated against the whole transaction rather than a partial one.
- Two check constraints guard the obligation periods:
  `amount_paid_minor <= amount_minor`, and
  `status <> 'paid' or amount_paid_minor = amount_minor` (a period marked
  paid is always paid in full).
- Corrections are never an edit. A mistake is corrected by a reversal, which
  posts mirrored entries (ADR 0013).

## Consequences

- An unbalanced posting fails at commit time with a message naming the
  transaction and both totals, even if the application layer let it through.
- The deferred trigger is one statement per transaction at commit, so the
  cost is negligible next to the inserts.
- A trigger that raises inside a transaction aborts the whole transaction, so
  a rejected posting leaves no partial rows behind.
- Because the trigger runs as the invoker, it reads `ledger_entries` under the
  same row-level security the rest of the transaction runs under. A
  cross-tenant transaction therefore cannot be balanced by entries the caller
  cannot see.
- Migration `0005` is reversible: dropping the trigger, the function, and the
  two check constraints restores the state of migration `0004`, and the
  `scripts/ci/migration-check.sh` job proves that migrations roll back to
  zero.

## Alternatives considered

- **Balance checked only in the application.** Rejected: the brief asks for
  database-level enforcement, and an application-only check cannot stop a
  direct SQL write.
- **A `BEFORE INSERT` row trigger.** Rejected: it would see one entry at a
  time and could never know the transaction total.
- **A `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY IMMEDIATE`.** Rejected: it
  would still fire per row; the point of deferring is that the check happens
  once, at commit.
- **Checking the balance in a stored procedure that posts the entries.**
  Rejected: the service would have to own the write path, and any other
  writer would bypass the check.
- **Revoking privileges only, without triggers.** Rejected: the table owner
  can always update its own rows, and a future migration run would be a
  privileged writer.
