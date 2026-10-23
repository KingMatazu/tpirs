import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Phase 5: cross-tenant drain of the channel outbox.
 *
 * `channel_messages` is tenant-scoped by row-level security, but the worker
 * that delivers SMS replies has no tenant to scan with. Rather than grant the
 * application role a cross-tenant read of message bodies, expose one narrow
 * `SECURITY DEFINER` function that returns only the tenant, message id, and
 * channel of pending outbound rows. The worker then opens a normal
 * tenant-scoped transaction per row to claim and send it.
 *
 * This mirrors `list_pending_sms` from migration 0007 (ADR 0016, ADR 0020) for
 * the channel outbox, which has a different lifecycle from receipts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create function list_pending_channel_messages(p_limit integer)
    returns table (tenant_id uuid, message_id uuid, channel channel_kind)
    language sql
    stable
    security definer
    set search_path = public, pg_temp
    as $$
      select tenant_id, id, channel
      from channel_messages
      where direction = 'outbound'
        and status = 'pending'
      order by created_at, id
      limit greatest(p_limit, 0)
    $$
  `.execute(db);
  await sql`revoke all on function list_pending_channel_messages(integer) from public`.execute(db);
  await sql`grant execute on function list_pending_channel_messages(integer) to tpirs_app`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop function if exists list_pending_channel_messages(integer) cascade`.execute(db);
}
