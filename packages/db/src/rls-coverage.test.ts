import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { sql } from "kysely";
import type { AnyDb } from "./connection.js";
import { createDb, migrateUp, withSystem, withTenant } from "./index.js";
import { APP_ROLE } from "./tenant-scope.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../migrations");

const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

/**
 * Tables with RLS enabled and no policy on purpose. They are read under the
 * system scope before a tenant is known, so a tenant-scoped policy cannot apply;
 * RLS-on with no policy fails closed for everyone but the owner, which is the
 * intended posture for a table holding provider secrets.
 */
const SYSTEM_ONLY_TABLES: Readonly<Record<string, string>> = {
  webhook_endpoints:
    "resolved by endpoint token before a tenant is known (ADR 0017); read under the system scope only",
};

/**
 * Row-level security coverage (Phase 10, Step 6).
 *
 * The durable guard is the first test: it reads `information_schema` and fails
 * when a table with a `tenant_id` column has no RLS or no policy. Adding a table
 * and forgetting its policy is therefore a red build, not a discovery during a
 * pen test.
 *
 * The rest proves the mechanism on real rows: the application role cannot bypass
 * RLS, a scoped read cannot see another tenant even with an explicit filter, and
 * a scoped write cannot plant a row under another tenant's id.
 */
describeIntegration("row-level security coverage (integration)", () => {
  let db: AnyDb;
  let tenantA: string;
  let tenantB: string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);

    await withSystem(db, async (tx) => {
      const created = await sql<{ id: string }>`
        insert into tenants (slug, name, legal_entity, config)
        values
          (${`rls-a-${stamp}`}, 'RLS A', 'RLS A Entity', '{}'::jsonb),
          (${`rls-b-${stamp}`}, 'RLS B', 'RLS B Entity', '{}'::jsonb)
        returning id
      `.execute(tx);
      tenantA = created.rows[0]?.id ?? "";
      tenantB = created.rows[1]?.id ?? "";
      await sql`
        insert into zones (tenant_id, name)
        values (${tenantA}, 'Zone A'), (${tenantB}, 'Zone B')
      `.execute(tx);
    });
  });

  afterAll(async () => {
    if (TEST_URL === undefined || db === undefined) return;
    await withSystem(db, async (tx) => {
      // Zones reference tenants without a cascade, so they go first. The pattern
      // also clears rows left behind by an earlier failed run.
      await sql`
        delete from zones
        where tenant_id in (select id from tenants where slug like 'rls-%')
      `.execute(tx);
      await sql`delete from tenants where slug like 'rls-%'`.execute(tx);
    });
    await db.destroy();
  });

  it("enables RLS with a policy on every table that has a tenant_id column", async () => {
    const result = await sql<{ tableName: string; rls: boolean; policies: number }>`
      select c.relname as table_name,
             c.relrowsecurity as rls,
             (select count(*)::int from pg_policies p
               where p.schemaname = 'public' and p.tablename = c.relname) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and exists (
          select 1 from information_schema.columns col
          where col.table_schema = 'public'
            and col.table_name = c.relname
            and col.column_name = 'tenant_id'
        )
      order by c.relname
    `.execute(db);

    expect(result.rows.length).toBeGreaterThan(10);

    const noRls = result.rows.filter((row) => !row.rls).map((row) => row.tableName);
    expect(noRls).toEqual([]);

    const noPolicy = result.rows.filter((row) => row.policies === 0).map((row) => row.tableName);
    // Only the documented system-only tables may have RLS without a policy.
    expect(noPolicy.filter((table) => !(table in SYSTEM_ONLY_TABLES))).toEqual([]);
    for (const table of noPolicy) {
      expect(SYSTEM_ONLY_TABLES[table]).toBeDefined();
    }
  });

  it("gives the application role no way around RLS", async () => {
    const result = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`
      select rolbypassrls, rolsuper from pg_roles where rolname = ${APP_ROLE}
    `.execute(db);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.rolbypassrls).toBe(false);
    expect(result.rows[0]?.rolsuper).toBe(false);
  });

  it("shows a scoped caller only its own tenant, even with an explicit filter", async () => {
    const scoped = await withTenant(db, tenantA, async (tx) => {
      const all = await sql<{ n: number }>`select count(*)::int as n from zones`.execute(tx);
      const other = await sql<{ n: number }>`
        select count(*)::int as n from zones where tenant_id = ${tenantB}
      `.execute(tx);
      return { all: all.rows[0]?.n ?? -1, other: other.rows[0]?.n ?? -1 };
    });
    expect(scoped.all).toBe(1);
    // The filter asks for the other tenant and RLS still returns nothing.
    expect(scoped.other).toBe(0);
  });

  it("refuses a scoped write that plants a row under another tenant", async () => {
    await expect(
      withTenant(db, tenantA, async (tx) => {
        await sql`insert into zones (tenant_id, name) values (${tenantB}, 'Smuggled')`.execute(tx);
      }),
    ).rejects.toThrow(/row-level security|policy/i);
  });

  it("lets the system scope see both tenants (the worker's documented path)", async () => {
    const total = await withSystem(db, async (tx) => {
      const result = await sql<{ n: number }>`
        select count(*)::int as n from zones where tenant_id in (${tenantA}, ${tenantB})
      `.execute(tx);
      return result.rows[0]?.n ?? -1;
    });
    expect(total).toBe(2);
  });
});
