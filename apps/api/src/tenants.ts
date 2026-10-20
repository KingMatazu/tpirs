import type { AnyDb } from "@tpirs/db";

/** Resolves a tenant slug to its id using system privileges (login is pre-tenant). */
export async function resolveTenantIdBySlug(db: AnyDb, slug: string): Promise<string | undefined> {
  const row = await db
    .selectFrom("tenants")
    .select(["id"])
    .where("slug", "=", slug)
    .executeTakeFirst();
  return row?.id;
}

/** Reads the current configuration document for a tenant (system scope). */
export async function readTenantConfig(
  db: AnyDb,
  tenantId: string,
): Promise<{ config: unknown; version: number } | undefined> {
  const row = await db
    .selectFrom("tenants")
    .select(["config", "configVersion"])
    .where("id", "=", tenantId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return { config: row.config, version: row.configVersion };
}
