import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { sql } from "kysely";
import type { AnyDb } from "../connection.js";
import { createDb, migrateUp, repositories, withSystem } from "../index.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../migrations");

const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

/**
 * Roles are per tenant and keyed by a system key, so `system_admin` exists once
 * per tenant. A lookup by key alone is therefore ambiguous — the seed found that
 * the hard way: it reused the first tenant's role rows for the second, and every
 * user in the second tenant ended up with no permissions.
 */
describeIntegration("role lookup is tenant-scoped (integration)", () => {
  let db: AnyDb;
  let tenantA: string;
  let tenantB: string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    const created = await withSystem(db, async (tx) =>
      sql<{ id: string }>`
        insert into tenants (slug, name, legal_entity, config)
        values
          (${`roles-a-${stamp}`}, 'Roles A', 'Roles A Entity', '{}'::jsonb),
          (${`roles-b-${stamp}`}, 'Roles B', 'Roles B Entity', '{}'::jsonb)
        returning id
      `.execute(tx),
    );
    tenantA = created.rows[0]?.id ?? "";
    tenantB = created.rows[1]?.id ?? "";
  });

  afterAll(async () => {
    if (TEST_URL === undefined || db === undefined) return;
    await withSystem(db, async (tx) => {
      await sql`delete from role_permissions where role_id in (
        select id from roles where tenant_id in (select id from tenants where slug like 'roles-%')
      )`.execute(tx);
      await sql`delete from roles where tenant_id in (
        select id from tenants where slug like 'roles-%'
      )`.execute(tx);
      await sql`delete from tenants where slug like 'roles-%'`.execute(tx);
    });
    await db.destroy();
  });

  it("returns the role that belongs to the requested tenant", async () => {
    await withSystem(db, async (tx) => {
      const roles = repositories(tx).roles;
      await roles.create({
        tenantId: tenantA,
        key: "auditor",
        name: "Auditor",
        permissions: ["audit:read"],
      });
      await roles.create({
        tenantId: tenantB,
        key: "auditor",
        name: "Auditor",
        permissions: ["ledger:read"],
      });
    });

    await withSystem(db, async (tx) => {
      const roles = repositories(tx).roles;
      const forA = await roles.findByKey("auditor", tenantA);
      const forB = await roles.findByKey("auditor", tenantB);
      expect(forA?.permissions).toEqual(["audit:read"]);
      expect(forB?.permissions).toEqual(["ledger:read"]);
      expect(forA?.id).not.toBe(forB?.id);
    });
  });
});
