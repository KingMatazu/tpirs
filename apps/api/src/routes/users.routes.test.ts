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

function tenantConfig(slug: string, nationalIdPattern?: string) {
  const base = defaultTenantConfig({
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
  return nationalIdPattern === undefined ? base : { ...base, collectors: { nationalIdPattern } };
}

interface UserJson {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  nationalId: string | null;
  homeAddress: string | null;
  status: "active" | "disabled";
  roles: string[];
  mustChangeCredentials: boolean;
}

/** The field paths a 422 reported, in the order the service listed them. */
function issuePaths(response: { json(): unknown }): string[] {
  return (response.json() as { error: { issues: { path: string }[] } }).error.issues.map(
    (issue) => issue.path,
  );
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
      await repos.roles.create({
        tenantId: tenantA.id,
        key: "collector",
        name: "Collector",
        permissions: ["cash:intake"],
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
        // A different state, a different ID: nine digits instead of eleven.
        config: tenantConfig(slugB, "^[0-9]{9}$"),
      });
      const bRole = await repos.roles.create({
        tenantId: tenantB.id,
        key: "account_manager",
        name: "Account Manager",
        permissions: ["user:read", "user:manage", "role:read"],
      });
      await repos.roles.create({
        tenantId: tenantB.id,
        key: "collector",
        name: "Collector",
        permissions: ["cash:intake"],
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
  const rotatedPassword = "rotated-pass-3";

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
    expect(catalogue.map((role) => role.key).sort()).toEqual([
      "account_manager",
      "collector",
      "staff",
    ]);
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

  it("requires the collector profile and records it", async () => {
    const base = {
      displayName: "Collector One",
      email: "collector.one@example.com",
      password: temporaryPassword,
      roleKeys: ["collector"],
    };

    const missing = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { ...base, username: "um.collector" },
    });
    expect(missing.statusCode).toBe(422);
    expect(issuePaths(missing).sort()).toEqual(["homeAddress", "nationalId", "phone"]);

    const wrongShape = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: {
        ...base,
        username: "um.collector",
        phone: "08012345678",
        nationalId: "12345",
        homeAddress: "12 Market Road",
      },
    });
    expect(wrongShape.statusCode).toBe(422);
    expect(issuePaths(wrongShape)).toEqual(["nationalId"]);

    const created = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: {
        ...base,
        username: "um.collector",
        phone: "08012345678",
        nationalId: "12345678901",
        homeAddress: "12 Market Road",
      },
    });
    expect(created.statusCode).toBe(201);
    const user = (created.json() as { user: UserJson }).user;
    expect(user.phone).toBe("08012345678");
    expect(user.nationalId).toBe("12345678901");
    expect(user.homeAddress).toBe("12 Market Road");
    expect(user.roles).toEqual(["collector"]);
  });

  it("applies each tenant's own national ID pattern", async () => {
    const other = await login(slugB, "ub.manager", seedPassword);
    const token = other.token ?? "";
    const payload = {
      displayName: "Collector B",
      email: "collector.b@example.com",
      password: temporaryPassword,
      roleKeys: ["collector"],
      phone: "+2348000000001",
      homeAddress: "5 Market Road",
    };

    const nine = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: { authorization: `Bearer ${token}` },
      payload: { ...payload, username: "ub.collector", nationalId: "123456789" },
    });
    expect(nine.statusCode).toBe(201);
    expect((nine.json() as { user: UserJson }).user.nationalId).toBe("123456789");

    // The eleven-digit default would have accepted this one; tenant B's config
    // does not, which is the point of the pattern being configuration.
    const eleven = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: { authorization: `Bearer ${token}` },
      payload: { ...payload, username: "ub.collector2", nationalId: "12345678901" },
    });
    expect(eleven.statusCode).toBe(422);
    expect(issuePaths(eleven)).toEqual(["nationalId"]);
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

  it("rejects a weak replacement password and leaves the account flagged", async () => {
    const signedIn = await login(slugA, "um.created", resetPassword);
    const token = signedIn.token ?? "";

    const weak = await app.inject({
      method: "POST",
      url: "/v1/auth/change-password",
      headers: { authorization: `Bearer ${token}` },
      payload: { password: "short" },
    });
    expect(weak.statusCode).toBe(422);
    expect(
      (weak.json() as { error: { issues: { path: string }[] } }).error.issues.map(
        (issue) => issue.path,
      ),
    ).toContain("password");

    // Still locked: a refused replacement must not half-apply.
    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect((me.json() as { mustChangeCredentials: boolean }).mustChangeCredentials).toBe(true);
  });

  it("lets a flagged account replace its password and keeps its username", async () => {
    const before = await login(slugA, "um.created", resetPassword);
    const oldToken = before.token ?? "";

    const rotated = await app.inject({
      method: "POST",
      url: "/v1/auth/change-password",
      headers: { authorization: `Bearer ${oldToken}` },
      payload: { password: rotatedPassword },
    });
    expect(rotated.statusCode).toBe(200);
    const session = rotated.json() as {
      token: string;
      user: { username?: string; mustChangeCredentials: boolean };
    };
    expect(session.user.mustChangeCredentials).toBe(false);

    // The session that made the call was authorised by the password that has
    // just stopped working, so it is gone; the replacement is already issued.
    const stale = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(stale.statusCode).toBe(401);
    const current = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(current.statusCode).toBe(200);

    // The temporary password no longer signs in; the chosen one does, unflagged.
    expect((await login(slugA, "um.created", resetPassword)).status).toBe(401);
    const fresh = await login(slugA, "um.created", rotatedPassword);
    expect(fresh.status).toBe(200);
    expect(fresh.mustChangeCredentials).toBe(false);

    // The username is the one the administrator handed over, unchanged.
    const list = await app.inject({
      method: "GET",
      url: "/v1/users",
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(
      (list.json() as { users: UserJson[] }).users.some((user) => user.username === "um.created"),
    ).toBe(true);

    // Rotation is a one-off, not a general password-change route.
    const again = await app.inject({
      method: "POST",
      url: "/v1/auth/change-password",
      headers: { authorization: `Bearer ${session.token}` },
      payload: { password: "another-pass-4" },
    });
    expect(again.statusCode).toBe(404);
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
    expect(actions).toContain("auth.credentials_changed");

    const trail = JSON.stringify(entries);
    expect(trail).not.toContain(temporaryPassword);
    expect(trail).not.toContain(resetPassword);
    expect(trail).not.toContain(rotatedPassword);
    expect(trail).not.toContain(seedPassword);
    // Personal data stays out of the append-only trail for the same reason.
    expect(trail).not.toContain("12345678901");
  });
});
