import { sql } from "kysely";
import type { Kysely } from "kysely";
import { hashToken } from "@tpirs/crypto";
import type { Database } from "./connection.js";
import { APP_ROLE } from "./tenant-scope.js";

/**
 * Turns a webhook URL token into a tenant id, and nothing else.
 *
 * The lookup runs as the application role, which has no privilege on
 * `webhook_endpoints`, so the only way in is the `SECURITY DEFINER` function
 * created by migration 0006 (ADR 0017). That keeps the token hash table out of
 * reach of every ordinary query while still allowing an unauthenticated,
 * pre-tenant request to find out which tenant it belongs to.
 *
 * Returns `undefined` for an unknown or revoked token; the caller must answer
 * the same way for both.
 */
export async function resolveWebhookEndpoint(
  db: Kysely<Database>,
  provider: string,
  token: string,
): Promise<string | undefined> {
  if (provider.trim() === "" || token.trim() === "") return undefined;
  const tokenHash = hashToken(token);
  return db.transaction().execute(async (trx) => {
    await sql`set local role ${sql.raw(APP_ROLE)}`.execute(trx);
    // The camel-case plugin renames result keys, so keep the alias a single
    // lowercase word: `tenant_id` would arrive as `tenantId`.
    const result = await sql<{ tenant: string | null }>`
      select resolve_webhook_endpoint(${provider}, ${tokenHash}) as tenant
    `.execute(trx);
    return result.rows[0]?.tenant ?? undefined;
  });
}
