import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "./connection.js";

/**
 * Outbox backlog age for alerting (Phase 10, Step 10).
 *
 * Both outboxes are tenant-scoped by RLS and the worker has no tenant to scan
 * with, so the query goes through the `SECURITY DEFINER` functions added by
 * migration 0015: each returns one number (seconds since the oldest pending row,
 * or null when the outbox is empty) and nothing else.
 */
export interface OutboxBacklog {
  /** Seconds the oldest pending receipt has been waiting; null when empty. */
  readonly sms: number | null;
  /** Seconds the oldest pending channel message has been waiting; null when empty. */
  readonly channel: number | null;
}

export async function outboxBacklog(db: Kysely<Database>): Promise<OutboxBacklog> {
  const result = await sql<{ sms: number | null; channel: number | null }>`
    select oldest_pending_sms_age_seconds() as sms,
           oldest_pending_channel_age_seconds() as channel
  `.execute(db);
  const row = result.rows[0];
  return { sms: row?.sms ?? null, channel: row?.channel ?? null };
}
