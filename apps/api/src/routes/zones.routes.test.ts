import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { buildApp } from "../server.js";
import type { AppConfig } from "../config.js";
import { createMockTelemetry } from "@tpirs/telemetry-mock";
import { createDb, migrateUp, repositories, withSystem } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { createDbIdentityProvider } from "@tpirs/identity-provider-db";
import { hashPassword } from "@tpirs/crypto";
import { defaultTenantConfig } from "@tpirs/config";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../../../packages/db/migrations");
const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  logLevel: "silent",
  deploymentRegion: "test",
  databaseUrl: "",
  metricsEnabled: false,
};

function tenantConfig(slug: string) {
  return defaultTenantConfig({
    name: "Zone Test",
    slug,
    legalEntity: "Zone Test Revenue",
    supportEmail: "z@example.com",
    supportPhone: "+1",
    timezone: "Africa/Lagos",
    currency: "NGN",
    numberFormat: "en-NG",
    dateFormat: "dd/MM/yyyy",
    ussdCode: "*123#",
    smsSenderId: "ZONETEST",
    bikeFeeMinor: 20000,
    tuktukFeeMinor: 30000,
  });
}

/**
 * Zone management (11.0b). The interesting properties are the tenant
 * boundaries: a zone is pure tenant data, so one tenant must never see another's
 * list, and a rename against a foreign id must fail closed with `404` rather
 * than `403` (which would confirm the id exists).
 */
describeIntegration("api zones e2e (integration)", () => {
  let db: AnyDb;
  let app: FastifyInstance;
  const slugA = `zone-e2e-a-${Date.now().toString()}`;
  const slugB = `zone-e2e-b-${Date.now().toString()}`;
  const password = "zone-e2e-password";

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    const passwordHash = await hashPassword(password);
    await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const tenantA = await repos.tenants.create({
        slug: slugA,
        name: "Zone E2E A",
        legalEntity: "Zone E2E A Revenue",
        config: tenantConfig(slugA),
      });
      const managerRole = await repos.roles.create({
        tenantId: tenantA.id,
        key: "zone_manager",
        name: "Zone Manager",
        permissions: ["zone:read", "zone:manage"],
      });
      const readerRole = await repos.roles.create({
        tenantId: tenantA.id,
        key: "zone_reader",
        name: "Zone Reader",
        permissions: ["zone:read"],
      });
      for (const [username, roleId] of [
        ["ze.manager", managerRole.id],
        ["ze.reader", readerRole.id],
      ] as const) {
        const user = await repos.users.create({
          tenantId: tenantA.id,
          username,
          displayName: username,
          passwordHash,
          totpSecret: null,
        });
        await repos.roles.assignToUser({ tenantId: tenantA.id, userId: user.id, roleId });
      }

      const tenantB = await repos.tenants.create({
        slug: slugB,
        name: "Zone E2E B",
        legalEntity: "Zone E2E B Revenue",
        config: tenantConfig(slugB),
      });
      const bRole = await repos.roles.create({
        tenantId: tenantB.id,
        key: "zone_manager",
        name: "Zone Manager",
        permissions: ["zone:read", "zone:manage"],
      });
      const bUser = await repos.users.create({
        tenantId: tenantB.id,
        username: "zb.manager",
        displayName: "zb.manager",
        passwordHash,
        totpSecret: null,
      });
      await repos.roles.assignToUser({ tenantId: tenantB.id, userId: bUser.id, roleId: bRole.id });
    });

    app = await buildApp({
      config,
      telemetry: createMockTelemetry(),
      db,
      identity: createDbIdentityProvider({ db }),
    });
    await app.ready();
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await app.close();
    await db.destroy();
  });

  async function login(tenantSlug: string, username: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { tenantSlug, username, password },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { token: string }).token;
  }

  interface ZoneJson {
    id: string;
    parentZoneId: string | null;
    name: string;
  }

  let managerToken = "";
  let readerToken = "";
  let otherTenantToken = "";
  let parentId = "";

  it("starts with an empty, valid list", async () => {
    managerToken = await login(slugA, "ze.manager");
    const response = await app.inject({
      method: "GET",
      url: "/v1/zones",
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { zones: ZoneJson[] }).zones).toEqual([]);
  });

  it("creates a top-level zone and records an audit entry", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/zones",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { name: "  Central  " },
    });
    expect(response.statusCode).toBe(201);
    const zone = (response.json() as { zone: ZoneJson }).zone;
    expect(zone.name).toBe("Central");
    expect(zone.parentZoneId).toBeNull();
    parentId = zone.id;

    const audit = await withSystem(db, async (tx) =>
      repositories(tx).audit.list({ action: "zone.create", limit: 5 }),
    );
    expect(audit.some((entry) => entry.entityId === zone.id)).toBe(true);
  });

  it("creates a child zone inside a parent", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/zones",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { name: "Central Market", parentZoneId: parentId },
    });
    expect(response.statusCode).toBe(201);
    expect((response.json() as { zone: ZoneJson }).zone.parentZoneId).toBe(parentId);
  });

  it("rejects a duplicate name in the same parent with 409", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/zones",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { name: "Central" },
    });
    expect(response.statusCode).toBe(409);
  });

  it("rejects a parent that does not exist", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/zones",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { name: "Orphan", parentZoneId: "00000000-0000-4000-8000-000000000000" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("renames a zone and audits the before/after", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/zones/${parentId}`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { name: "Central District" },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { zone: ZoneJson }).zone.name).toBe("Central District");

    const audit = await withSystem(db, async (tx) =>
      repositories(tx).audit.list({ action: "zone.rename", limit: 5 }),
    );
    const entry = audit.find((candidate) => candidate.entityId === parentId);
    expect(entry?.beforeData).toMatchObject({ name: "Central" });
    expect(entry?.afterData).toMatchObject({ name: "Central District" });
  });

  it("refuses a rename that collides with another top-level zone", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/zones",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { name: "Riverside" },
    });
    expect(create.statusCode).toBe(201);

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/zones/${parentId}`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { name: "Riverside" },
    });
    expect(response.statusCode).toBe(409);
  });

  it("lets zone:read list but forbids zone:manage", async () => {
    readerToken = await login(slugA, "ze.reader");
    const list = await app.inject({
      method: "GET",
      url: "/v1/zones",
      headers: { authorization: `Bearer ${readerToken}` },
    });
    expect(list.statusCode).toBe(200);
    // Central District, its child Central Market, and Riverside.
    expect((list.json() as { zones: ZoneJson[] }).zones).toHaveLength(3);

    const create = await app.inject({
      method: "POST",
      url: "/v1/zones",
      headers: { authorization: `Bearer ${readerToken}` },
      payload: { name: "Not Allowed" },
    });
    expect(create.statusCode).toBe(403);
  });

  it("fails closed for another tenant's zone", async () => {
    otherTenantToken = await login(slugB, "zb.manager");

    const foreignList = await app.inject({
      method: "GET",
      url: "/v1/zones",
      headers: { authorization: `Bearer ${otherTenantToken}` },
    });
    expect((foreignList.json() as { zones: ZoneJson[] }).zones).toEqual([]);

    const rename = await app.inject({
      method: "PATCH",
      url: `/v1/zones/${parentId}`,
      headers: { authorization: `Bearer ${otherTenantToken}` },
      payload: { name: "Hijacked" },
    });
    expect(rename.statusCode).toBe(404);
  });
});
