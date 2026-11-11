import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Every existing collector gets a wallet (ADR 0071).
 *
 * The application now creates a wallet when a collector account is created, but
 * that cannot reach accounts that already exist. Without a row, the collector's
 * wallet endpoint answers `wallet_unknown`, so the app has no balance to show
 * and no place to hang a funding destination, and the dashboard's Collectors
 * screen (which lists wallets) does not show the person at all — finance cannot
 * provision a terminal for somebody the screen cannot open.
 *
 * The backfill is idempotent and covers the case that motivated it: the first
 * collector account an administrator created on a fresh tenant before this
 * change.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    insert into collector_wallets (tenant_id, collector_user_id)
    select distinct u.tenant_id, u.id
    from users u
    join user_roles ur on ur.user_id = u.id and ur.tenant_id = u.tenant_id
    join roles r on r.id = ur.role_id
    where r.key = 'collector'
      and u.deleted_at is null
    on conflict (tenant_id, collector_user_id) do nothing
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // A wallet with history is real money's record and must never be deleted by a
  // rollback. Only the rows this backfill could have created — no intake and no
  // funding destination — are removed.
  await sql`
    delete from collector_wallets w
    where not exists (
        select 1 from cash_intakes i
        where i.tenant_id = w.tenant_id and i.collector_user_id = w.collector_user_id
      )
      and not exists (
        select 1 from collector_deposit_instructions d
        where d.tenant_id = w.tenant_id and d.collector_user_id = w.collector_user_id
      )
  `.execute(db);
}
