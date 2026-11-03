import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import pg from "pg";
import { buildApp } from "../build-app.js";
import type { AppConfig } from "../config.js";
import { createMockTelemetry } from "@tpirs/telemetry-mock";
import { createDb, migrateUp } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { createDbIdentityProvider } from "@tpirs/identity-provider-db";
import type { RateLimiter } from "@tpirs/application";

/**
 * First-run onboarding, against a database that is genuinely new.
 *
 * This suite creates its own database instead of using the shared test one,
 * because the behaviour under test is "a deployment with no tenant" and the
 * shared database has tenants from every other suite. Dropping a tenant is not an
 * option either: the audit trail is append-only by a rejecting trigger, so a
 * tenant that has been seen cannot be unseen. A fresh database is the only
 * honest reproduction of a fresh install — and it is exactly the thing `pnpm
 * setup` will hand an operator.
 */
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

interface ScratchDatabase {
  readonly url: string;
  drop(): Promise<void>;
}

async function createScratchDatabase(baseUrl: string): Promise<ScratchDatabase> {
  // Unique per run: two agents (or a retried suite) must not collide, and a
  // leftover cannot mask a failure by being reused.
  const name = `tpirs_setup_${Date.now().toString()}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      const cleanup = new pg.Client({ connectionString: baseUrl });
      await cleanup.connect();
      try {
        // FORCE: the app pool is closed first, but a lingering pg backend must
        // not turn a green suite into a failed cleanup.
        await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

function allowAllLimiter(): RateLimiter {
  return {
    consume: () =>
      Promise.resolve({ allowed: true, limit: 1_000, remaining: 999, retryAfterSeconds: 0 }),
  };
}

describeIntegration("first-run setup (fresh database)", () => {
  const slug = `katsina-${Date.now().toString()}`;
  let scratch: ScratchDatabase;
  let db: AnyDb;
  let app: FastifyInstance;

  const answers = {
    name: "Katsina State",
    slug,
    legalEntity: "Katsina State Revenue Authority",
    supportEmail: "support@katsina-state.example.gov",
    supportPhone: "+2348000000000",
    timezone: "Africa/Lagos",
    currency: "NGN",
    ussdCode: "*347*1#",
    smsSenderId: "KATSINALE",
    bikeFeeMinor: 30000,
    tuktukFeeMinor: 45000,
    adminEmail: "aisha@katsina-state.example.gov",
  };

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    scratch = await createScratchDatabase(TEST_URL);
    db = createDb({ connectionString: scratch.url });
    // Creating a database and applying ~20 migrations is the slowest setup in
    // the suite, and the full-repo run has every other package building at the
    // same time. The budget is generous on purpose: a timeout here would be a
    // statement about the machine, not about onboarding.
    await migrateUp(db, migrationsDir);
    app = await buildApp({
      config,
      telemetry: createMockTelemetry(),
      db,
      identity: createDbIdentityProvider({ db }),
      rateLimiter: allowAllLimiter(),
    });
    await app.ready();
  }, 180_000);

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    if (app !== undefined) await app.close();
    if (db !== undefined) await db.destroy();
    if (scratch !== undefined) await scratch.drop();
  }, 60_000);

  /** Mints a session for the account the setup route created. */
  async function login(username: string, password: string) {
    return app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { tenantSlug: slug, username, password },
    });
  }

  it("reports that an empty deployment needs setup", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/setup/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ needsSetup: true });
  });

  it("answers with every problem at once rather than the first", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/setup/tenant",
      payload: { ...answers, timezone: "Nowhere", currency: "ngn1", adminEmail: "not-an-email" },
    });
    expect(response.statusCode).toBe(422);
    const body = response.json() as { error: { issues: { path: string }[] } };
    const paths = body.error.issues.map((issue) => issue.path);
    // Paths are the config's own paths, so a form can point at the field it
    // rendered rather than at a message about it.
    expect(paths).toContain("locale.timezone");
    expect(paths).toContain("locale.currency");
    expect(paths).toContain("adminEmail");
    // Nothing was provisioned by a rejected request.
    const status = await app.inject({ method: "GET", url: "/v1/setup/status" });
    expect(status.json()).toEqual({ needsSetup: true });
  });

  it("provisions the tenant from the wizard's answers", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/setup/tenant",
      // Lower case currency: the route normalises it rather than failing a
      // validator three layers down.
      payload: { ...answers, currency: "ngn" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ tenantSlug: slug, temporaryUsername: "admin" });

    const status = await app.inject({ method: "GET", url: "/v1/setup/status" });
    expect(status.json()).toEqual({ needsSetup: false });
  });

  it("stops existing once the deployment has a tenant", async () => {
    const status = await app.inject({ method: "GET", url: "/v1/setup/status" });
    expect(status.json()).toEqual({ needsSetup: false });
    const again = await app.inject({ method: "POST", url: "/v1/setup/tenant", payload: answers });
    // Indistinguishable from a route that was never registered: a finished
    // deployment reveals nothing about what setup accepts.
    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({ error: { code: "not_found" } });

    // Fastify validates bodies before handlers, so this also proves the window
    // is checked in preValidation: an empty body must not turn the closed route
    // into a 400 that describes the fields it accepts.
    const malformed = await app.inject({ method: "POST", url: "/v1/setup/tenant", payload: {} });
    expect(malformed.statusCode).toBe(404);
    expect(malformed.json()).toMatchObject({
      error: { code: "not_found", message: "Route not found" },
    });
  });

  it("confines the provisioning account to the credential step", async () => {
    const response = await login("admin", "password");
    expect(response.statusCode).toBe(200);
    const session = response.json() as { token: string; user: { mustChangeCredentials: boolean } };
    expect(session.user.mustChangeCredentials).toBe(true);

    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ mustChangeCredentials: true });

    const blocked = await app.inject({
      method: "GET",
      url: "/v1/tenants/current/config",
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ error: { code: "must_change_credentials" } });
  });

  it("refuses the provisioning credentials as the new ones", async () => {
    const session = (await login("admin", "password")).json() as { token: string };
    const headers = { authorization: `Bearer ${session.token}` };

    const sameUsername = await app.inject({
      method: "POST",
      url: "/v1/auth/complete-onboarding",
      headers,
      payload: { username: "admin", password: "katsina-2026" },
    });
    expect(sameUsername.statusCode).toBe(422);
    expect(sameUsername.json()).toMatchObject({ error: { issues: [{ path: "username" }] } });

    const tempPassword = await app.inject({
      method: "POST",
      url: "/v1/auth/complete-onboarding",
      headers,
      payload: { username: "aisha.bello", password: "password" },
    });
    expect(tempPassword.statusCode).toBe(422);

    const tooShort = await app.inject({
      method: "POST",
      url: "/v1/auth/complete-onboarding",
      headers,
      payload: { username: "aisha.bello", password: "levy" },
    });
    expect(tooShort.statusCode).toBe(422);
    expect(tooShort.json()).toMatchObject({ error: { issues: [{ path: "password" }] } });
  });

  it("hands back a working session and lifts the restriction", async () => {
    const session = (await login("admin", "password")).json() as { token: string };
    const completed = await app.inject({
      method: "POST",
      url: "/v1/auth/complete-onboarding",
      headers: { authorization: `Bearer ${session.token}` },
      payload: { username: "aisha.bello", password: "levy-2026" },
    });
    expect(completed.statusCode).toBe(200);
    const fresh = completed.json() as { token: string; user: { mustChangeCredentials: boolean } };
    expect(fresh.user.mustChangeCredentials).toBe(false);

    // The token that set up the tenant was issued to a password that no longer
    // exists, so it is gone too.
    const stale = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(stale.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/v1/tenants/current/config",
      headers: { authorization: `Bearer ${fresh.token}` },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ config: { identity: { slug } } });

    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${fresh.token}` },
    });
    expect(me.json()).toMatchObject({ mustChangeCredentials: false });
  });

  it("retires the provisioning account", async () => {
    expect((await login("admin", "password")).statusCode).toBe(401);
    const renamed = await login("aisha.bello", "levy-2026");
    expect(renamed.statusCode).toBe(200);
    const session = renamed.json() as { token: string; user: { mustChangeCredentials: boolean } };
    expect(session.user.mustChangeCredentials).toBe(false);

    // Completion is not a general password-change route: it closes with the
    // provisioning flag, just as tenant creation closes with the first tenant.
    const repeated = await app.inject({
      method: "POST",
      url: "/v1/auth/complete-onboarding",
      headers: { authorization: `Bearer ${session.token}` },
      payload: { username: "someone.else", password: "different-2026" },
    });
    expect(repeated.statusCode).toBe(404);
  });
});

/**
 * First-run setup on an internet-facing deployment (ADR 0052).
 *
 * The zero-tenant window is the only unauthenticated route that writes rows, so
 * a hosted deployment has to prove two things: with `SETUP_TOKEN` set, only a
 * caller holding it can create the tenant; and a production deployment that
 * forgot to set one fails closed instead of publishing an open setup form.
 * Local development and tests keep the old open behaviour, which is why the
 * suite above still posts without a header.
 */
describeIntegration("first-run setup token gate (fresh database)", () => {
  let scratch: ScratchDatabase;
  let db: AnyDb;
  const token = "deploy-setup-token-1";
  const slug = `gated-${Date.now().toString()}`;
  const gatedAnswers = {
    name: "Gated State",
    slug,
    legalEntity: "Gated State Revenue Authority",
    supportEmail: "support@gated.example.gov",
    supportPhone: "+2348000000000",
    timezone: "Africa/Lagos",
    currency: "NGN",
    ussdCode: "*347*2#",
    smsSenderId: "GATEDLEVY",
    bikeFeeMinor: 20000,
    tuktukFeeMinor: 30000,
    adminEmail: "admin@gated.example.gov",
  };

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    scratch = await createScratchDatabase(TEST_URL);
    db = createDb({ connectionString: scratch.url });
    await migrateUp(db, migrationsDir);
  }, 180_000);

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    if (db !== undefined) await db.destroy();
    if (scratch !== undefined) await scratch.drop();
  }, 60_000);

  it("fails closed on production when no setup token is configured", async () => {
    const app = await buildApp({
      config: { ...config, nodeEnv: "production" },
      telemetry: createMockTelemetry(),
      db,
      identity: createDbIdentityProvider({ db }),
      rateLimiter: allowAllLimiter(),
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/setup/tenant",
        payload: gatedAnswers,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: "setup_disabled" } });
      const status = await app.inject({ method: "GET", url: "/v1/setup/status" });
      expect(status.json()).toEqual({ needsSetup: true });
    } finally {
      await app.close();
    }
  });

  it("accepts only the configured token, then closes the window", async () => {
    const app = await buildApp({
      config: {
        ...config,
        nodeEnv: "production",
        setupToken: token,
        refreshCookieSameSite: "none",
      },
      telemetry: createMockTelemetry(),
      db,
      identity: createDbIdentityProvider({ db }),
      rateLimiter: allowAllLimiter(),
    });
    await app.ready();
    try {
      const missing = await app.inject({
        method: "POST",
        url: "/v1/setup/tenant",
        payload: gatedAnswers,
      });
      expect(missing.statusCode).toBe(401);
      expect(missing.json()).toMatchObject({ error: { code: "setup_token_required" } });

      const wrong = await app.inject({
        method: "POST",
        url: "/v1/setup/tenant",
        headers: { "x-setup-token": `${token}-wrong` },
        payload: gatedAnswers,
      });
      expect(wrong.statusCode).toBe(401);

      const created = await app.inject({
        method: "POST",
        url: "/v1/setup/tenant",
        headers: { "x-setup-token": token },
        payload: gatedAnswers,
      });
      expect(created.statusCode).toBe(201);

      // A split-origin deployment needs the refresh cookie to survive a
      // cross-site request: SameSite=None plus Secure (production is HTTPS).
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { tenantSlug: slug, username: "admin", password: "password" },
      });
      expect(login.statusCode).toBe(200);
      const cookie = String(login.headers["set-cookie"] ?? "");
      expect(cookie).toContain("SameSite=None");
      expect(cookie).toContain("Secure");

      // Once a tenant exists the token is irrelevant: the route is gone.
      const replay = await app.inject({
        method: "POST",
        url: "/v1/setup/tenant",
        headers: { "x-setup-token": token },
        payload: gatedAnswers,
      });
      expect(replay.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
