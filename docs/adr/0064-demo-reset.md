# ADR 0064: A demo reset truncates data and keeps the schema

## Status

Accepted

## Context

The pilot deployment accumulated test tenants, accounts and assets. Before
presenting to a state authority it has to start clean, and the cleanest starting
point is the first-run wizard: the audience watches a state be created rather than
looking at somebody's leftover test data.

Two obvious approaches are both wrong for this deployment:

- **Drop and recreate the schema.** On Supabase the `public` schema carries
  default grants to `anon`, `authenticated` and `service_role`, the app role
  `tpirs_app`, and RLS policies installed by migrations. Recreating it by hand is
  a sequence of grant statements that are easy to get subtly wrong, and the
  migrations would have to run again from zero — slow, and a failure leaves a
  half-built database on the morning of the demo.
- **Delete rows selectively.** The append-only rules are deliberate: audit and
  ledger rows are never updated or deleted by the application, and corrections are
  reversing entries. A "delete everything except…" script is the same operation
  with more ways to get it wrong.

## Decision

- **`pnpm db:reset-demo` truncates every table in `public` except
  `kysely_migration` and `kysely_migration_lock`, then restarts the standalone
  short-code sequence.** The schema, roles, grants, RLS policies and the migration
  record stay exactly as they are, so the next `migrate up` is a no-op and the API
  keeps working without a redeploy.
- **It is dry-run by default.** Without `--yes` it prints the target, the tenant /
  user / asset counts and the list of tables it would truncate, and changes
  nothing. With `--yes` the truncate runs in one transaction.
- **The same SQL is documented for the Supabase SQL editor**, so the reset does not
  require the database password to leave the operator's machine or be pasted into
  a chat.
- **The setup window reopens.** `isSetupRequired` is "no tenants", so an empty
  `tenants` table is precisely the condition the first-run wizard needs. On this
  deployment that wizard asks for `SETUP_TOKEN`, so the token must be known before
  the wipe.
- **This is the only sanctioned way for audit or ledger rows to disappear.** It is
  a whole-database reset performed by the owner between demos, not a business
  operation: nothing in the application gains a delete path, and selective
  removal of history remains forbidden.

## Consequences

- Everyone is signed out and every account, driver, sticker, payment and audit
  entry is gone. The printed stickers from before the reset no longer verify,
  because the assets they point at no longer exist — reprint from the new data.
- Short codes restart at the tenant's sequence floor (`B001000` with the default
  template), so a demo's first driver reads like a first driver.
- Supabase's own schemas (`auth`, `storage`) are untouched. The app does not use
  them today, but a future feature that does will survive a demo reset.
- Anything in `public` that is not ours would also be truncated. That is the
  contract of the command and is stated in the runbook; this deployment keeps its
  data in `public` only.
- There is no "reset one tenant" variant. A demo needs the whole state created in
  front of the audience; a per-tenant wipe would be a different tool with a
  different blast radius.

## Alternatives considered

- **`drop schema public cascade` + migrations.** Rejected above: grants, roles and
  RLS are migration-owned, and re-running twenty-seven migrations during a demo
  preparation adds failure modes for no benefit.
- **A fresh Supabase project.** Rejected: new connection strings, new Vercel env,
  new deploy — far more to get wrong than a truncate, and it discards the project
  the pilot has been running on.
- **Supabase's dashboard "reset" (where available).** Rejected as the documented
  path: it is plan-dependent and its exact behaviour (schema re-creation, extension
  grants) is not something the runbook can promise.
- **Keeping the data and hiding it behind a demo tenant.** Rejected: the existing
  rows are test noise, and the state authority should see a state being created,
  not an account list full of `um.created`.
