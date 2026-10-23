# @tpirs/db

Kysely connection factory, SQL migrations, and CLI scripts (`migrate up|down|status|check`, `seed`). All schema access goes through repository interfaces defined by consumers — this package owns only the connection, the migration runner, and the schema itself. `migrate check` applies every migration to the configured database and then rolls back to zero, proving migrations are reversible; CI runs it against a scratch Postgres.

Two details matter when reading this package:

- **Type mapping.** `pg` returns `int8` as a string and `date` as a JS `Date`, which contradicts the schema types declared in `connection.ts`. The two parsers are overridden there so money arrives as `bigint` and a business date arrives as the `"YYYY-MM-DD"` string the domain works with (ADR 0015).
- **Tenant scope.** `withTenant` opens a transaction, sets the application role, and sets `app.tenant_id` so row-level security confines every statement to one tenant. It must not be called with a transaction: Kysely does not support nesting transactions, and the repositories in `repositories/ledger.ts` therefore query the transaction they were given directly.

Phase 3 added the ledger schema and its invariants: migration `0004` creates the chart of accounts, transactions, ledger entries, obligation periods, and reversal requests, and makes the ledger append-only; migration `0005` grants the application role the `UPDATE` it needs to mark a period paid, adds the "a period is never paid for more than it owes" checks, and asserts the double-entry balance with a deferred constraint trigger that runs once at commit (ADR 0012).

## Phase 4: Payments

Migration 0006_payments introduces webhook endpoints, payment intents, payments, payment_attributions, and sms_log with tenant-scoped RLS and SECURITY DEFINER helpers for cross-tenant webhook resolution and suspense access. Migration 0007_job_queue adds a Postgres-backed jobs table with lease/heartbeat, retry/backoff, and a list_pending_sms SECURITY DEFINER function for the outbox sweeper. Payments are attributed by intent (ADR 0018); partial payments credit the asset wallet first (ADR 0019); receipts go through a transactional outbox and the Postgres job queue (ADR 0020); webhooks are tokenised per endpoint (ADR 0017).
