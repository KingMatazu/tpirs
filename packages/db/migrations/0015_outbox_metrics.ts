import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Phase 10: the two read-only queries the worker needs for alerting.
 *
 * Both outboxes are tenant-scoped by RLS, and the worker has no tenant to scan
 * with. Rather than widen the application role's access to `sms_log` or
 * `channel_messages`, each function is `SECURITY DEFINER` and returns a single
 * number: the age in seconds of the oldest still-pending row, or null when the
 * outbox is empty. No content, no ids, no tenant identity leaves the function.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create function oldest_pending_sms_age_seconds() returns double precision
    language sql
    security definer
    set search_path = public
    as $$
      select extract(epoch from (now() - min(created_at)))::double precision
      from sms_log
      where status = 'pending'
    $$
  `.execute(db);

  await sql`
    create function oldest_pending_channel_age_seconds() returns double precision
    language sql
    security definer
    set search_path = public
    as $$
      select extract(epoch from (now() - min(created_at)))::double precision
      from channel_messages
      where status = 'pending'
    $$
  `.execute(db);

  // The worker runs as the application role; without this it cannot call them.
  await sql`grant execute on function oldest_pending_sms_age_seconds() to tpirs_app`.execute(db);
  await sql`grant execute on function oldest_pending_channel_age_seconds() to tpirs_app`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`revoke all on function oldest_pending_sms_age_seconds() from tpirs_app`.execute(db);
  await sql`revoke all on function oldest_pending_channel_age_seconds() from tpirs_app`.execute(db);
  await sql`drop function if exists oldest_pending_sms_age_seconds()`.execute(db);
  await sql`drop function if exists oldest_pending_channel_age_seconds()`.execute(db);
}
