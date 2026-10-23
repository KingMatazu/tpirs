import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "./connection.js";
import { APP_ROLE } from "./tenant-scope.js";

/** One pending channel-outbox row: which tenant it belongs to, and which message. */
export interface PendingChannelMessageRef {
  readonly tenantId: string;
  readonly messageId: string;
  readonly channel: string;
}

/**
 * Lists pending outbound channel messages across every tenant.
 *
 * The outbox is tenant-scoped by row-level security, but the worker that drains
 * it has no tenant to scan with. The only way in is the `SECURITY DEFINER`
 * function created by migration 0010, which returns tenant, message id, and
 * channel and nothing else (ADR 0021).
 *
 * The caller opens a normal tenant-scoped transaction per ref to claim and
 * deliver it, so no message content is ever read outside its tenant.
 */
export async function listPendingChannelMessages(
  db: Kysely<Database>,
  limit: number,
): Promise<readonly PendingChannelMessageRef[]> {
  return db.transaction().execute(async (trx) => {
    await sql`set local role ${sql.raw(APP_ROLE)}`.execute(trx);
    // Result keys arrive single-lowercase through the CamelCasePlugin; the
    // public type is camelCase, so the boundary is cast explicitly.
    const result = await sql`select tenant_id as tenant, message_id as message, channel as channel
        from list_pending_channel_messages(${limit})`.execute(trx);
    const rows = result.rows as Record<string, unknown>[];

    return rows.map((row) => ({
      tenantId: String(row["tenant"]),
      messageId: String(row["message"]),
      channel: String(row["channel"]),
    }));
  });
}
