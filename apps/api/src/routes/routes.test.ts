import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { buildApp } from "../server.js";
import type { AppConfig } from "../config.js";
import { createMockTelemetry } from "@tpirs/telemetry-mock";
import { createDb, migrateUp, repositories, withSystem } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { createDbIdentityProvider } from "@tpirs/identity-provider-db";
import { createRateLimiter } from "@tpirs/application";
import type { RateLimiter } from "@tpirs/application";
import { createMockCache } from "@tpirs/cache-mock";
import { createMockClock } from "@tpirs/clock-mock";
import { hashPassword } from "@tpirs/crypto";
import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";

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

function validConfig(slug: string): TenantConfig {
  return validateTenantConfig({
    identity: {
      name: "Test State",
      slug,
      legalEntity: "Test State Revenue",
      supportContacts: { email: "a@b.co", phone: "+1" },
    },
    locale: {
      defaultLanguage: "en",
      enabledLanguages: ["en"],
      timezone: "Africa/Lagos",
      currency: "NGN",
      numberFormat: "en-NG",
      dateFormat: "dd/MM/yyyy",
    },
    branding: {
      appName: "Test",
      logoUrl: "https://x/logo.svg",
      colors: { primary: "#000", secondary: "#111", accent: "#222" },
      smsSenderId: "TEST",
      receiptHeader: "Test",
      receiptFooter: "Test",
    },
    assetTypes: [
      {
        key: "bike",
        label: "Bike",
        attributes: [],
        qrFormat: "QR-{id}",
        shortCodeFormat: "B{id}",
        stickerSpec: "60x60mm",
      },
    ],
    obligations: {
      model: "pay_per_use",
      frequency: "daily",
      prepaidAllowed: false,
      arrearsPolicy: "none",
      graceDays: 0,
      feeRules: [
        {
          key: "bike-daily",
          assetTypeKey: "bike",
          amountMinor: 20000,
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    providers: [],
    channels: {
      ussdCode: "*1#",
      smsKeyword: "X",
      otpMessageTemplate: "code {code}",
      smsReceiptTemplate: "Receipt {receiptNo}: {amount} for {assetRef} on {date}.",
      menus: [],
    },
    cashRules: {
      enabled: true,
      floatCeilingMinor: 1,
      depositDeadlineHours: 1,
      freezeOnShortfall: true,
    },
    featureFlags: { disputes: true, prepay: false, offlineMode: true, anomalyAlerts: true },
    reconciliation: { schedule: "0 2 * * *", toleranceMinor: 0, notifyRole: "finance_admin" },
    field: {
      offlineGraceHours: 8,
      maxQueueItems: 1000,
      disputeReasons: [{ code: "other", label: "Other" }],
    },
    compliance: { retentionDays: 1, dataResidency: "x", consentTextKey: "c" },
  });
}

describeIntegration("api auth/config/audit (integration)", () => {
  let db: AnyDb;
  let app: FastifyInstance;
  let identity: ReturnType<typeof createDbIdentityProvider>;
  const slug = `route-test-${Date.now().toString()}`;
  const password = "route-test-password";
  let tenantId: string;

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    const passwordHash = await hashPassword(password);
    await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const tenant = await repos.tenants.create({
        slug,
        name: "Route Test",
        legalEntity: "Route Test Revenue",
        config: validConfig(slug),
      });
      tenantId = tenant.id;
      const adminRole = await repos.roles.create({
        tenantId: tenant.id,
        key: "system_admin",
        name: "System Admin",
        // audit:read so the actor-filter test reaches the handler rather than
        // stopping at the permission check.
        permissions: ["tenant:read", "tenant:configure", "audit:read"],
      });
      const officerRole = await repos.roles.create({
        tenantId: tenant.id,
        key: "officer",
        name: "Officer",
        permissions: ["asset:read"],
      });
      const admin = await repos.users.create({
        tenantId: tenant.id,
        username: "rt.admin",
        displayName: "RT Admin",
        passwordHash,
        totpSecret: null,
      });
      const officer = await repos.users.create({
        tenantId: tenant.id,
        username: "rt.officer",
        displayName: "RT Officer",
        passwordHash,
        totpSecret: null,
      });
      await repos.roles.assignToUser({
        tenantId: tenant.id,
        userId: admin.id,
        roleId: adminRole.id,
      });
      await repos.roles.assignToUser({
        tenantId: tenant.id,
        userId: officer.id,
        roleId: officerRole.id,
      });
    });
    identity = createDbIdentityProvider({ db });
    // The shared app is not about throttling: a limiter that never refuses keeps
    // the login-heavy tests below from tripping each other's counters.
    app = await buildApp({
      config,
      telemetry: createMockTelemetry(),
      db,
      identity,
      rateLimiter: allowAllLimiter(),
    });
    await app.ready();
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await app.close();
    await db.destroy();
  });

  function allowAllLimiter(): RateLimiter {
    return {
      consume: () =>
        Promise.resolve({ allowed: true, limit: 1_000, remaining: 999, retryAfterSeconds: 0 }),
    };
  }

  async function login(username: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { tenantSlug: slug, username, password },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { token: string }).token;
  }

  it("rejects unknown credentials", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { tenantSlug: slug, username: "rt.admin", password: "wrong" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("logs in and returns the caller's permissions via /me", async () => {
    const loginResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { tenantSlug: slug, username: "rt.admin", password },
    });
    expect(loginResponse.statusCode).toBe(200);
    const cookie = String(loginResponse.headers["set-cookie"] ?? "");
    expect(cookie).toContain("tpirs_refresh=");
    expect(cookie).toContain("HttpOnly");
    // The test config is not production, so local http:// keeps the cookie.
    expect(cookie).not.toContain("Secure");

    const token = await login("rt.admin");
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { roles: string[]; permissions: string[] };
    expect(body.roles).toContain("system_admin");
    expect(body.permissions).toContain("tenant:configure");
  });

  it("requires authentication for protected routes", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/tenants/current/config" });
    expect(response.statusCode).toBe(401);
  });

  it("denies a role without the required permission", async () => {
    const token = await login("rt.officer");
    // The audit log is the permission-gated read an officer cannot have; the
    // tenant config is deliberately readable by every signed-in role.
    const response = await app.inject({
      method: "GET",
      url: "/v1/audit",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it("reads and updates config, validating input and auditing the change", async () => {
    const token = await login("rt.admin");
    const headers = { authorization: `Bearer ${token}` };

    const before = await app.inject({ method: "GET", url: "/v1/tenants/current/config", headers });
    expect(before.statusCode).toBe(200);
    const beforeVersion = (before.json() as { version: number }).version;

    const invalid = await app.inject({
      method: "PUT",
      url: "/v1/tenants/current/config",
      headers,
      payload: { identity: {} },
    });
    expect(invalid.statusCode).toBe(422);

    const updated = await app.inject({
      method: "PUT",
      url: "/v1/tenants/current/config",
      headers,
      payload: validConfig(slug),
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as { version: number }).version).toBe(beforeVersion + 1);

    const audit = await withSystem(db, async (tx) =>
      repositories(tx).audit.search({ action: "tenant.config.update", limit: 5 }),
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]?.entityId).toBe(tenantId);
  });

  it("lets an officer read the tenant config but not write it", async () => {
    const token = await login("rt.officer");
    const headers = { authorization: `Bearer ${token}` };

    // Every screen renders from the config, and the officer holds none of the
    // admin permissions, so the read must not require one.
    const config = await app.inject({
      method: "GET",
      url: "/v1/tenants/current/config",
      headers,
    });
    expect(config.statusCode).toBe(200);
    expect(
      (config.json() as { config: { branding: { appName: string } } }).config.branding.appName,
    ).toBe("Test");

    const write = await app.inject({
      method: "PUT",
      url: "/v1/tenants/current/config",
      headers,
      payload: validConfig(slug),
    });
    expect(write.statusCode).toBe(403);
  });

  it("refuses a non-uuid actor filter instead of failing in the database", async () => {
    const token = await login("rt.admin");
    const response = await app.inject({
      method: "GET",
      url: "/v1/audit?actor=dfgjgh",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string; message: string; requestId: string } };
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toBe("actor must be a user id");
    expect(body.error.requestId).toBe(response.headers["x-request-id"]);
  });

  it("throttles repeated login attempts for one username", async () => {
    const throttled = await buildApp({
      config,
      telemetry: createMockTelemetry(),
      db,
      identity,
      rateLimiter: createRateLimiter({ cache: createMockCache(), clock: createMockClock() }),
    });
    await throttled.ready();
    try {
      const attempt = () =>
        throttled.inject({
          method: "POST",
          url: "/v1/auth/login",
          payload: { tenantSlug: slug, username: "rt.officer", password: "wrong-password" },
        });

      for (let index = 0; index < 5; index += 1) {
        expect((await attempt()).statusCode).toBe(401);
      }
      const blocked = await attempt();
      expect(blocked.statusCode).toBe(429);
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      const body = blocked.json() as { error: { code: string; requestId: string } };
      expect(body.error.code).toBe("rate_limited");
      expect(body.error.requestId).toBe(blocked.headers["x-request-id"]);
    } finally {
      await throttled.close();
    }
  });

  it("throttles refresh attempts per source address", async () => {
    const throttled = await buildApp({
      config,
      telemetry: createMockTelemetry(),
      db,
      identity,
      rateLimiter: createRateLimiter({ cache: createMockCache(), clock: createMockClock() }),
    });
    await throttled.ready();
    try {
      const attempt = () => throttled.inject({ method: "POST", url: "/v1/auth/refresh" });
      for (let index = 0; index < 30; index += 1) {
        expect((await attempt()).statusCode).toBe(401);
      }
      expect((await attempt()).statusCode).toBe(429);
    } finally {
      await throttled.close();
    }
  });

  it("refuses a body above the 1 MiB limit", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { tenantSlug: slug, username: "rt.admin", password: "x".repeat(1_200_000) },
    });
    expect(response.statusCode).toBe(413);
  });

  it("forbids updating the audit log directly", async () => {
    await expect(
      withSystem(db, async (tx) =>
        tx.updateTable("auditLog").set({ action: "tampered" }).execute(),
      ),
    ).rejects.toThrow(/append-only/);
  });
});
