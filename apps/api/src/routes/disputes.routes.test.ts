import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp } from "../server.js";
import type { AppConfig } from "../config.js";
import { buildServices, makeTenantConfigLoader } from "../services.js";
import { createMockTelemetry } from "@tpirs/telemetry-mock";
import { createMockSmsProvider } from "@tpirs/sms-provider-mock";
import { createMockCache } from "@tpirs/cache-mock";
import { createMockClock } from "@tpirs/clock-mock";
import { createMockLockService } from "@tpirs/lock-service-mock";
import { createMockObjectStorage } from "@tpirs/object-storage-mock";
import { createMockSecretsProvider } from "@tpirs/secrets-provider-mock";
import { createMockPaymentProvider } from "@tpirs/payment-provider-mock";
import { createDb, migrateUp, repositories, withSystem } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { createDbIdentityProvider } from "@tpirs/identity-provider-db";
import { hashPassword } from "@tpirs/crypto";
import { validateTenantConfig } from "@tpirs/config";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../../../packages/db/migrations");
const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

const appConfig: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  logLevel: "silent",
  deploymentRegion: "test",
  databaseUrl: "",
  metricsEnabled: false,
};

function validConfig(slug: string): unknown {
  return validateTenantConfig({
    identity: {
      name: "Dispute State",
      slug,
      legalEntity: "Dispute State Revenue",
      supportContacts: { email: "a@b.co", phone: "+1" },
    },
    locale: {
      defaultLanguage: "en",
      enabledLanguages: ["en"],
      timezone: "Etc/UTC",
      currency: "NGN",
      numberFormat: "en-NG",
      dateFormat: "dd/MM/yyyy",
    },
    branding: {
      appName: "Dispute",
      logoUrl: "https://x/logo.svg",
      colors: { primary: "#000", secondary: "#111", accent: "#222" },
      smsSenderId: "DSP",
      receiptHeader: "Dispute",
      receiptFooter: "Thanks",
    },
    assetTypes: [
      {
        key: "bike",
        label: "Bike",
        attributes: [],
        qrFormat: "DP-{id}",
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
          amountMinor: 20_000,
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    providers: [{ port: "PaymentProvider", adapter: "mock" }],
    channels: {
      ussdCode: "*1#",
      smsKeyword: "DSP",
      otpMessageTemplate: "Dispute code: {code}",
      smsReceiptTemplate: "Receipt {receiptNo}: {amount} for {assetRef} on {date}.",
      menus: [],
    },
    cashRules: {
      enabled: true,
      floatCeilingMinor: 5_000_000,
      depositDeadlineHours: 8,
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

describeIntegration("api disputes (integration)", () => {
  let db: AnyDb;
  let app: FastifyInstance;
  const slug = `dispute-api-${Date.now().toString()}`;
  const password = "dispute-api-password";
  let assetId: string;
  let disputeId: string;

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    const passwordHash = await hashPassword(password);

    await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const tenant = await repos.tenants.create({
        slug,
        name: "Dispute API",
        legalEntity: "Dispute API Revenue",
        config: validConfig(slug),
      });
      const role = async (key: string, permissions: string[]) => {
        const created = await repos.roles.create({
          tenantId: tenant.id,
          key,
          name: key,
          permissions: permissions as never,
        });
        return created.id;
      };
      const officerRole = await role("officer", ["dispute:create", "dispute:read", "asset:read"]);
      const auditorRole = await role("auditor", ["dispute:read"]);
      const collectorRole = await role("collector", ["cash:intake"]);

      const user = async (username: string, roleId: string) => {
        const created = await repos.users.create({
          tenantId: tenant.id,
          username,
          displayName: username,
          passwordHash,
          totpSecret: null,
        });
        await repos.roles.assignToUser({ tenantId: tenant.id, userId: created.id, roleId });
        return created.id;
      };
      await user("dsp.officer", officerRole);
      await user("dsp.auditor", auditorRole);
      await user("dsp.collector", collectorRole);

      const asset = await repos.assets.create({
        tenantId: tenant.id,
        zoneId: null,
        ownerId: null,
        assetTypeKey: "bike",
        attributes: { plate_number: "DSP001" },
        qrPayload: `dsp-${slug}`,
        qrToken: `dsp-token-${slug}`,
        shortCode: "D001",
        createdByUserId: null,
      });
      assetId = asset.id;
    });

    const services = await buildServices({
      db,
      objectStorage: createMockObjectStorage(),
      secrets: createMockSecretsProvider({ "qr-token-signing-key": "dispute-api-qr-key" }),
      sms: createMockSmsProvider(),
      cache: createMockCache(),
      locks: createMockLockService(),
      clock: createMockClock(),
      qrKeyRef: "qr-token-signing-key",
      paymentProviders: { mock: createMockPaymentProvider() },
    });
    app = await buildApp({
      config: appConfig,
      telemetry: createMockTelemetry(),
      db,
      identity: createDbIdentityProvider({ db }),
      services,
      loadConfig: makeTenantConfigLoader(db),
    });
    await app.ready();
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await app.close();
    await db.destroy();
  });

  async function login(username: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { tenantSlug: slug, username, password },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { token: string }).token;
  }

  function auth(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  it("creates a dispute and lists it under the contract's `disputes` key", async () => {
    const officer = await login("dsp.officer");
    const created = await app.inject({
      method: "POST",
      url: "/v1/disputes",
      headers: auth(officer),
      payload: {
        clientDisputeId: randomUUID(),
        assetId,
        reason: "wrong_charge",
        description: "paid twice for the same day",
        occurredAt: "2026-06-15T10:00:00Z",
      },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as { disputeId: string; status: string };
    disputeId = body.disputeId;
    expect(body.status).toBe("open");

    const auditor = await login("dsp.auditor");
    const listed = await app.inject({
      method: "GET",
      url: "/v1/disputes",
      headers: auth(auditor),
    });
    expect(listed.statusCode).toBe(200);
    const page = listed.json() as {
      disputes: { id: string; status: string; assetId: string }[];
      nextCursor: string | null;
      hasMore: boolean;
    };
    // The route once sent the repository's `rows` key, which the serializer
    // stripped; the contract and the dashboard expect `disputes`.
    expect(page.disputes.some((row) => row.id === disputeId)).toBe(true);
    expect(page.disputes[0]?.assetId).toBe(assetId);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();

    const detail = await app.inject({
      method: "GET",
      url: `/v1/disputes/${disputeId}`,
      headers: auth(auditor),
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { dispute: { id: string } }).dispute.id).toBe(disputeId);
  });

  it("filters by status and keeps a collector out", async () => {
    const auditor = await login("dsp.auditor");
    const empty = await app.inject({
      method: "GET",
      url: "/v1/disputes?status=resolved",
      headers: auth(auditor),
    });
    expect(empty.statusCode).toBe(200);
    expect((empty.json() as { disputes: unknown[] }).disputes).toEqual([]);

    const collector = await login("dsp.collector");
    const denied = await app.inject({
      method: "GET",
      url: "/v1/disputes",
      headers: auth(collector),
    });
    expect(denied.statusCode).toBe(403);
  });
});
