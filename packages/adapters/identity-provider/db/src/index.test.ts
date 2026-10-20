import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PortError } from "@tpirs/ports";
import { createDb, migrateUp, repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import path from "node:path";
import { createDbIdentityProvider } from "./index.js";
import { generateTotpSecret, hashPassword, totpCode } from "@tpirs/crypto";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../../../db/migrations");

const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

describeIntegration("db identity provider (integration)", () => {
  let db: AnyDb;
  let tenantId: string;
  const password = "correct-horse-battery-staple";
  let totpSecret: string;

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    totpSecret = generateTotpSecret();
    const passwordHash = await hashPassword(password);
    await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const tenant = await repos.tenants.create({
        slug: `acme-${Date.now().toString()}`,
        name: "Acme",
        legalEntity: "Acme Revenue",
        config: {},
      });
      tenantId = tenant.id;
      const user = await repos.users.create({
        tenantId: tenant.id,
        username: "officer1",
        displayName: "Officer One",
        passwordHash,
        totpSecret,
      });
      const role = await repos.roles.create({
        tenantId: tenant.id,
        key: "officer",
        name: "Field Officer",
        permissions: ["asset:read"],
      });
      await repos.roles.assignToUser({ tenantId: tenant.id, userId: user.id, roleId: role.id });
    });
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await db.destroy();
  });

  it("authenticates with password and TOTP, then verifies and revokes", async () => {
    const identity = createDbIdentityProvider({ db });
    const code = totpCode(totpSecret);
    const session = await identity.authenticate({
      tenantId,
      username: "officer1",
      password,
      totpCode: code,
    });
    expect(session.user.tenantId).toBe(tenantId);
    expect(session.user.roles).toContain("officer");
    const verified = await identity.verifySession(session.token);
    expect(verified.userId).toBe(session.user.userId);
    await identity.revokeSession(session.token);
    await expect(identity.verifySession(session.token)).rejects.toThrow(PortError);
  });

  it("rejects a bad password", async () => {
    const identity = createDbIdentityProvider({ db });
    await expect(
      identity.authenticate({ tenantId, username: "officer1", password: "nope" }),
    ).rejects.toThrow(PortError);
  });

  it("rejects a missing or wrong TOTP code when the user has a secret", async () => {
    const identity = createDbIdentityProvider({ db });
    await expect(
      identity.authenticate({ tenantId, username: "officer1", password }),
    ).rejects.toThrow(PortError);
    await expect(
      identity.authenticate({ tenantId, username: "officer1", password, totpCode: "000000" }),
    ).rejects.toThrow(PortError);
  });

  it("binds a device on authentication", async () => {
    const identity = createDbIdentityProvider({ db });
    const code = totpCode(totpSecret);
    const session = await identity.authenticate({
      tenantId,
      username: "officer1",
      password,
      totpCode: code,
      device: { deviceId: "android-1", platform: "android" },
    });
    const bound = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).devices.findActive({ userId: session.user.userId, deviceId: "android-1" }),
    );
    expect(bound?.deviceId).toBe("android-1");
  });

  it("does not authenticate a user from another tenant", async () => {
    const identity = createDbIdentityProvider({ db });
    const otherTenantId = await withSystem(db, async (tx) => {
      const tenant = await repositories(tx).tenants.create({
        slug: `other-${Date.now().toString()}`,
        name: "Other",
        legalEntity: "Other Revenue",
        config: {},
      });
      return tenant.id;
    });
    await expect(
      identity.authenticate({
        tenantId: otherTenantId,
        username: "officer1",
        password,
        totpCode: totpCode(totpSecret),
      }),
    ).rejects.toThrow(PortError);
  });
});
