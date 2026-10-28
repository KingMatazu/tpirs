import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Phase 7 correction: a deposit is identified by the provider event, not by the
 * destination reference.
 *
 * Migration 0012 made `cash_deposits` unique on
 * `(tenant_id, provider, provider_reference)`. That reads the reference as the
 * transfer id, but the reference is the *destination*: the collector's
 * long-lived virtual account or narration (`collector_deposit_instructions`,
 * ADR 0032). A collector who deposits every evening uses the same destination
 * every time, so the second deposit looked like a replay of the first and never
 * posted. The acceptance check "a simulated day reconciles to zero" cannot pass
 * with more than one deposit per collector under that constraint.
 *
 * The transfer identity is the webhook event, which `webhook_events` already
 * dedupes per provider, and whose row id `cash_deposits` already carries as
 * `webhook_event_id`. So:
 *
 * - the unique key becomes `webhook_event_id` (nullable rows, such as a deposit
 *   recorded by an operator, do not collide);
 * - `(tenant_id, provider, provider_reference)` stays as a plain index, because
 *   finance still looks deposits up by destination;
 * - genuine replays remain a no-op: `webhook_events` rejects the duplicate
 *   event before the deposit is ever inserted, and this unique index is the
 *   second line of defence inside the transaction.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cash_deposits drop constraint cash_deposits_tenant_id_provider_provider_reference_key`.execute(
    db,
  );
  await sql`create index cash_deposits_reference_idx on cash_deposits (tenant_id, provider, provider_reference)`.execute(
    db,
  );
  await sql`
    create unique index cash_deposits_webhook_event_idx
      on cash_deposits (webhook_event_id)
      where webhook_event_id is not null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Restoring the old constraint needs one deposit per destination. A database
  // that already recorded several keeps the first transfer and drops the later
  // ones with their allocations — they are the rows the old schema could not
  // represent. The migration check runs this on an empty database.
  // `min(uuid)` does not exist, so the first transfer per destination is the
  // first row of a window partition (timestamps then ids break ties).
  await sql`
    delete from cash_deposit_allocations a
    using (
      select id from (
        select id,
          row_number() over (
            partition by tenant_id, provider, provider_reference
            order by created_at, id
          ) as rank
        from cash_deposits
      ) ranked
      where ranked.rank > 1
    ) later
    where a.deposit_id = later.id
  `.execute(db);
  await sql`
    delete from cash_deposits
    where id in (
      select id from (
        select id,
          row_number() over (
            partition by tenant_id, provider, provider_reference
            order by created_at, id
          ) as rank
        from cash_deposits
      ) ranked
      where ranked.rank > 1
    )
  `.execute(db);
  await sql`drop index if exists cash_deposits_webhook_event_idx`.execute(db);
  await sql`drop index if exists cash_deposits_reference_idx`.execute(db);
  await sql`
    alter table cash_deposits
      add constraint cash_deposits_tenant_id_provider_provider_reference_key
      unique (tenant_id, provider, provider_reference)
  `.execute(db);
}
