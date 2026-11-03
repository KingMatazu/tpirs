import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { buildApp } from "../build-app.js";
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
    name: "User Test",
    slug,
    legalEntity: "User Test Revenue",
    supportEmail: "u@example.com",
    supportPhone: "+1",
    timezone: "Africa/Lagos",
    currency: "NGN",
    numberFormat: "en-NG",
    dateFormat: "dd/MM/yyyy",
    ussdCode: "*123#",
    smsSenderId: "USERTEST",
    bikeFeeMinor: 20000,
    tuktukFeeMinor: 30000,
  });
}

interface UserJson {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  status: "active" | "disabled";
  roles: string[];
  mustChangeCredentials: boolean;
}

/**
 * Staff account management (11.0b). The properties worth proving here are the
 * ones a bad implementation gets wrong: a temporary password really is
 * temporary, disabling really ends access, a reset really ends the old sessions,
 * an administrator cannot widen their own account, and no password reaches the
 * audit trail.
 */
describeIntegration("api users e2e (integration)", () => {
  let db: AnyDb;
  let app: FastifyInstance;
  const slugA = `user-e2e-a-${Date.now().toString()}`;
  const slugB = `user-e2e-b-${Date.now().toString()}`;
  const seedPassword = "seed-password-1";

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    const passwordHash = await hashPassword(seedPassword);
    await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const tenantA = await repos.tenants.create({
        slug: slugA,
        name: "User E2E A",
        legalEntity: "User E2E A Revenue",
        config: tenantConfig(slugA),
      });
      const managerRole = await repos.roles.create({
        tenantId: tenantA.id,
        key: "account_manager",
        name: "Account Manager",
        permissions: ["user:read", "user:manage", "role:read"],
      });
      const staffRole = await repos.roles.create({
        tenantId: tenantA.id,
        key: "staff",
        name: "Staff",
        permissions: ["asset:read"],
      });
      for (const [username, roleId] of [
        ["um.manager", managerRole.id],
        ["um.staff", staffRole.id],
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
        name: "User E2E B",
        legalEntity: "User E2E B Revenue",
        config: tenantConfig(slugB),
      });
      const bRole = await repos.roles.create({
        tenantId: tenantB.id,
        key: "account_manager",
        name: "Account Manager",
        permissions: ["user:read", "user:manage", "role:read"],
      });
      const bUser = await repos.users.create({
        tenantId: tenantB.id,
        username: "ub.manager",
        displayName: "ub.manager",
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

  async function login(
    tenantSlug: string,
    username: string,
    password: string,
  ): Promise<{ status: number; token?: string; mustChangeCredentials?: boolean }> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { tenantSlug, username, password },
    });
    if (response.statusCode !== 200) return { status: response.statusCode };
    const body = response.json() as {
      token: string;
      user: { mustChangeCredentials: boolean };
    };
    return {
      status: 200,
      token: body.token,
      mustChangeCredentials: body.user.mustChangeCredentials,
    };
  }

  let managerToken = "";
  let staffToken = "";
  let otherTenantToken = "";
  let createdId = "";
  const temporaryPassword = "temporary-pass-1";
  const resetPassword = "reset-pass-2";

  it("lists accounts with their roles and the role catalogue", async () => {
    const manager = await login(slugA, "um.manager", seedPassword);
    expect(manager.status).toBe(200);
    managerToken = manager.token ?? "";

    const users = await app.inject({
      method: "GET",
      url: "/v1/users",
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(users.statusCode).toBe(200);
    const list = (users.json() as { users: UserJson[] }).users;
    expect(list.map((user) => user.username).sort()).toEqual(["um.manager", "um.staff"]);
    expect(list.find((user) => user.username === "um.manager")?.roles).toEqual(["account_manager"]);

    const roles = await app.inject({
      method: "GET",
      url: "/v1/roles",
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(roles.statusCode).toBe(200);
    const catalogue = (roles.json() as { roles: { key: string; permissions: string[] }[] }).roles;
    expect(catalogue.map((role) => role.key).sort()).toEqual(["account_manager", "staff"]);
    expect(catalogue.find((role) => role.key === "staff")?.permissions).toEqual(["asset:read"]);
  });

  it("creates an account whose password is temporary by construction", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: {
        username: "um.created",
        displayName: "Created User",
        email: "created@example.com",
        password: temporaryPassword,
        roleKeys: ["staff"],
      },
    });
    expect(response.statusCode).toBe(201);
    const user = (response.json() as { user: UserJson }).user;
    expect(user.mustChangeCredentials).toBe(true);
    expect(user.status).toBe("active");
    expect(user.roles).toEqual(["staff"]);
    createdId = user.id;
  });

  it("gates the new account at its first sign-in", async () => {
    const signedIn = await login(slugA, "um.created", temporaryPassword);
    expect(signedIn.status).toBe(200);
    expect(signedIn.mustChangeCredentials).toBe(true);

    // Every route but the credential step refuses a flagged account.
    const blocked = await app.inject({
      method: "GET",
      url: "/v1/tenants/current/config",
      headers: { authorization: `Bearer ${signedIn.token ?? ""}` },
    });
    expect(blocked.statusCode).toBe(403);
    expect((blocked.json() as { error: { code: string } }).error.code).toBe(
      "must_change_credentials",
    );
  });

  it("rejects a duplicate username, a weak password and an unknown role", async () => {
    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: {
        username: "um.staff",
        displayName: "Copy",
        email: "copy@example.com",
        password: "another-password",
        roleKeys: ["staff"],
      },
    });
    expect(duplicate.statusCode).toBe(409);

    const weak = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: {
        username: "um.weak",
        displayName: "Weak",
        email: "weak@example.com",
        password: "short",
        roleKeys: ["staff"],
      },
    });
    expect(weak.statusCode).toBe(422);
    expect(
      (weak.json() as { error: { issues: { path: string }[] } }).error.issues.map(
        (issue) => issue.path,
      ),
    ).toContain("password");

    const unknownRole = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: {
        username: "um.roleless",
        displayName: "Roleless",
        email: "roleless@example.com",
        password: "another-password",
        roleKeys: ["does_not_exist"],
      },
    });
    expect(unknownRole.statusCode).toBe(422);
    expect(
      (unknownRole.json() as { error: { issues: { path: string }[] } }).error.issues.map(
        (issue) => issue.path,
      ),
    ).toContain("roleKeys");
  });

  it("disables an account, which ends sign-in immediately", async () => {
    const disabled = await app.inject({
      method: "PATCH",
      url: `/v1/users/${createdId}`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { status: "disabled" },
    });
    expect(disabled.statusCode).toBe(200);
    expect((disabled.json() as { user: UserJson }).user.status).toBe("disabled");

    expect((await login(slugA, "um.created", temporaryPassword)).status).toBe(401);

    const enabled = await app.inject({
      method: "PATCH",
      url: `/v1/users/${createdId}`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { status: "active" },
    });
    expect(enabled.statusCode).toBe(200);
    expect((await login(slugA, "um.created", temporaryPassword)).status).toBe(200);
  });

  it("resets the password, ends open sessions and re-flags the account", async () => {
    const before = await login(slugA, "um.created", temporaryPassword);
    const oldToken = before.token ?? "";

    const reset = await app.inject({
      method: "POST",
      url: `/v1/users/${createdId}/password`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { password: resetPassword },
    });
    expect(reset.statusCode).toBe(200);
    expect((reset.json() as { user: UserJson }).user.mustChangeCredentials).toBe(true);

    // The session issued under the old password is gone.
    const stale = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(stale.statusCode).toBe(401);

    expect((await login(slugA, "um.created", temporaryPassword)).status).toBe(401);
    const fresh = await login(slugA, "um.created", resetPassword);
    expect(fresh.status).toBe(200);
    expect(fresh.mustChangeCredentials).toBe(true);
  });

  it("refuses to let an administrator change their own account", async () => {
    const self = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${managerToken}` },
    });
    const ownId = (self.json() as { userId: string }).userId;

    const attempt = await app.inject({
      method: "PATCH",
      url: `/v1/users/${ownId}`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { roleKeys: ["staff"] },
    });
    expect(attempt.statusCode).toBe(409);

    const resetSelf = await app.inject({
      method: "POST",
      url: `/v1/users/${ownId}/password`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { password: "self-reset-1" },
    });
    expect(resetSelf.statusCode).toBe(409);
  });

  it("denies a role without user:manage and fails closed across tenants", async () => {
    const staff = await login(slugA, "um.staff", seedPassword);
    staffToken = staff.token ?? "";
    const denied = await app.inject({
      method: "GET",
      url: "/v1/users",
      headers: { authorization: `Bearer ${staffToken}` },
    });
    expect(denied.statusCode).toBe(403);

    const other = await login(slugB, "ub.manager", seedPassword);
    otherTenantToken = other.token ?? "";
    const foreign = await app.inject({
      method: "PATCH",
      url: `/v1/users/${createdId}`,
      headers: { authorization: `Bearer ${otherTenantToken}` },
      payload: { status: "disabled" },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("records the actions without recording a password", async () => {
    const entries = await withSystem(db, async (tx) => repositories(tx).audit.list({ limit: 200 }));
    const actions = entries.map((entry) => entry.action);
    expect(actions).toContain("user.create");
    expect(actions).toContain("user.update");
    expect(actions).toContain("user.password.reset");

    const trail = JSON.stringify(entries);
    expect(trail).not.toContain(temporaryPassword);
    expect(trail).not.toContain(resetPassword);
    expect(trail).not.toContain(seedPassword);
  });
});
