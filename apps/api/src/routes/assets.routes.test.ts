import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import path from "node:path";
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
import { createDb, migrateUp, repositories, withSystem } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { createDbIdentityProvider } from "@tpirs/identity-provider-db";
import { hashPassword, createQrTokenSigner } from "@tpirs/crypto";
import { buildQrToken } from "@tpirs/domain";
import { validateTenantConfig } from "@tpirs/config";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../../../packages/db/migrations");
const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

const QR_KEY_REF = "qr-token-signing-key";
const QR_KEY = "test-qr-signing-key";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  logLevel: "silent",
  deploymentRegion: "test",
  databaseUrl: "",
};

function validConfig(slug: string): unknown {
  return validateTenantConfig({
    identity: {
      name: "Asset Test State",
      slug,
      legalEntity: "Asset Test Revenue",
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
      appName: "Asset Test Levy",
      logoUrl: "https://x/logo.svg",
      colors: { primary: "#0a5a4a", secondary: "#053b33", accent: "#f2c200" },
      smsSenderId: "ATLEVY",
      receiptHeader: "Asset Test",
      receiptFooter: "Thanks",
    },
    assetTypes: [
      {
        key: "bike",
        label: "Bike",
        attributes: [
          {
            key: "plate_number",
            label: "Plate number",
            type: "string",
            required: true,
            pattern: "^[A-Z0-9]{5,8}$",
          },
        ],
        qrFormat: "AT-{id}",
        shortCodeFormat: "B{id}",
        stickerSpec: "60x60mm vinyl",
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
      smsKeyword: "LEVY",
      otpMessageTemplate: "Asset Test code: {code}",
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
    compliance: { retentionDays: 1, dataResidency: "x", consentTextKey: "c" },
  });
}

describeIntegration("api asset registry e2e (integration)", () => {
  let db: AnyDb;
  let app: FastifyInstance;
  const sms = createMockSmsProvider();
  const slugA = `asset-e2e-a-${Date.now().toString()}`;
  const slugB = `asset-e2e-b-${Date.now().toString()}`;
  const password = "asset-e2e-password";

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    const passwordHash = await hashPassword(password);
    await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const tenantA = await repos.tenants.create({
        slug: slugA,
        name: "Asset E2E A",
        legalEntity: "Asset E2E A Revenue",
        config: validConfig(slugA),
      });
      const managerRole = await repos.roles.create({
        tenantId: tenantA.id,
        key: "manager",
        name: "Manager",
        permissions: ["asset:read", "asset:manage"],
      });
      const readerRole = await repos.roles.create({
        tenantId: tenantA.id,
        key: "reader",
        name: "Reader",
        permissions: ["asset:read"],
      });
      const manager = await repos.users.create({
        tenantId: tenantA.id,
        username: "ae.manager",
        displayName: "AE Manager",
        passwordHash,
        totpSecret: null,
      });
      const reader = await repos.users.create({
        tenantId: tenantA.id,
        username: "ae.reader",
        displayName: "AE Reader",
        passwordHash,
        totpSecret: null,
      });
      await repos.roles.assignToUser({
        tenantId: tenantA.id,
        userId: manager.id,
        roleId: managerRole.id,
      });
      await repos.roles.assignToUser({
        tenantId: tenantA.id,
        userId: reader.id,
        roleId: readerRole.id,
      });

      const tenantB = await repos.tenants.create({
        slug: slugB,
        name: "Asset E2E B",
        legalEntity: "Asset E2E B Revenue",
        config: validConfig(slugB),
      });
      const bManagerRole = await repos.roles.create({
        tenantId: tenantB.id,
        key: "manager",
        name: "Manager",
        permissions: ["asset:read", "asset:manage"],
      });
      const bManager = await repos.users.create({
        tenantId: tenantB.id,
        username: "bt.manager",
        displayName: "BT Manager",
        passwordHash,
        totpSecret: null,
      });
      await repos.roles.assignToUser({
        tenantId: tenantB.id,
        userId: bManager.id,
        roleId: bManagerRole.id,
      });
    });

    const services = await buildServices({
      db,
      objectStorage: createMockObjectStorage(),
      secrets: createMockSecretsProvider({ [QR_KEY_REF]: QR_KEY }),
      sms,
      cache: createMockCache(),
      locks: createMockLockService(),
      clock: createMockClock(),
      qrKeyRef: QR_KEY_REF,
    });
    const loadConfig = makeTenantConfigLoader(db);
    app = await buildApp({
      config,
      telemetry: createMockTelemetry(),
      db,
      identity: createDbIdentityProvider({ db }),
      services,
      loadConfig,
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

  let managerToken = "";
  let readerToken = "";
  let otherTenantToken = "";
  let assetId = "";
  let qrToken = "";
  let shortCode = "";

  it("registers an asset end to end and records an audit entry", async () => {
    managerToken = await login(slugA, "ae.manager");
    const response = await app.inject({
      method: "POST",
      url: "/v1/assets",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: {
        assetTypeKey: "bike",
        attributes: { plate_number: "ABC123" },
        owner: { displayName: "Ada Owner", phone: "+2348011112222" },
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      asset: { id: string; qrToken: string; shortCode: string; status: string };
    };
    expect(body.asset.id).toBeTruthy();
    expect(body.asset.qrToken).toContain(".");
    expect(body.asset.shortCode.startsWith("B")).toBe(true);
    expect(body.asset.status).toBe("active");
    assetId = body.asset.id;
    qrToken = body.asset.qrToken;
    shortCode = body.asset.shortCode;

    const audit = await withSystem(db, async (tx) =>
      repositories(tx).audit.search({ action: "asset.register", limit: 5 }),
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]?.entityId).toBe(assetId);
  });

  it("rejects attributes that violate the tenant's schema", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/assets",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { assetTypeKey: "bike", attributes: { plate_number: "bad plate!!" } },
    });
    expect(response.statusCode).toBe(422);
    const body = response.json() as { error: { code: string; issues: { path: string }[] } };
    expect(body.error.code).toBe("unprocessable_entity");
    expect(body.error.issues.some((issue) => issue.path === "plate_number")).toBe(true);
  });

  it("denies registration to a role without asset:manage", async () => {
    readerToken = await login(slugA, "ae.reader");
    const response = await app.inject({
      method: "POST",
      url: "/v1/assets",
      headers: { authorization: `Bearer ${readerToken}` },
      payload: { assetTypeKey: "bike", attributes: { plate_number: "XYZ987" } },
    });
    expect(response.statusCode).toBe(403);
  });

  it("fails closed when another tenant asks for the asset", async () => {
    otherTenantToken = await login(slugB, "bt.manager");
    const response = await app.inject({
      method: "GET",
      url: `/v1/assets/${assetId}`,
      headers: { authorization: `Bearer ${otherTenantToken}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it("serves registered photos through the API", async () => {
    const photoBytes = "hello-photo-bytes";
    const attach = await app.inject({
      method: "POST",
      url: `/v1/assets/${assetId}/photos`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: {
        contentType: "image/png",
        content: Buffer.from(photoBytes).toString("base64"),
      },
    });
    expect(attach.statusCode).toBe(201);

    const detail = await app.inject({
      method: "GET",
      url: `/v1/assets/${assetId}`,
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(detail.statusCode).toBe(200);
    const photos = (detail.json() as { photos: { id: string; url: string }[] }).photos;
    expect(photos).toHaveLength(1);
    const photoUrl = photos[0]?.url;
    expect(photoUrl).toBeDefined();

    const download = await app.inject({
      method: "GET",
      url: photoUrl ?? "/missing",
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("image/png");
    expect(download.body).toBe(photoBytes);
  });

  it("exports a printable SVG sticker carrying the short code", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/assets/${assetId}/sticker`,
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/svg+xml");
    expect(response.body).toContain("<svg");
    expect(response.body).toContain("Asset Test Levy");
    expect(response.body).toContain(shortCode);
  });

  it("resolves a scanned token through the public verify endpoint", async () => {
    const response = await app.inject({ method: "GET", url: `/v1/verify/${qrToken}` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      status: string;
      shortCode: string;
      assetTypeLabel: string;
      attributes: Record<string, unknown>;
      photos: { url: string }[];
    };
    expect(body.status).toBe("active");
    expect(body.shortCode).toBe(shortCode);
    expect(body.assetTypeLabel).toBe("Bike");
    expect(body.attributes.plate_number).toBe("ABC123");
    expect(body.photos).toHaveLength(1);
  });

  it("returns the same 404 for forged and unknown tokens", async () => {
    const forged = await app.inject({ method: "GET", url: "/v1/verify/abc.def" });
    expect(forged.statusCode).toBe(404);

    const signer = createQrTokenSigner(QR_KEY);
    const unknownToken = buildQrToken("never-registered-payload", signer);
    const unknown = await app.inject({ method: "GET", url: `/v1/verify/${unknownToken}` });
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { error: { code: string } }).error.code).toBe(
      (forged.json() as { error: { code: string } }).error.code,
    );
  });

  it("reflects suspension through verify", async () => {
    const noReason = await app.inject({
      method: "POST",
      url: `/v1/assets/${assetId}/suspend`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: {},
    });
    expect(noReason.statusCode).toBe(400);

    const suspend = await app.inject({
      method: "POST",
      url: `/v1/assets/${assetId}/suspend`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { reason: "sticker reported stolen" },
    });
    expect(suspend.statusCode).toBe(200);
    expect((suspend.json() as { asset: { status: string } }).asset.status).toBe("suspended");

    const verified = await app.inject({ method: "GET", url: `/v1/verify/${qrToken}` });
    expect(verified.statusCode).toBe(200);
    expect((verified.json() as { status: string }).status).toBe("suspended");
  });

  it("verifies an owner's phone end to end through the SMS provider", async () => {
    const ownerResponse = await app.inject({
      method: "POST",
      url: "/v1/owners",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { displayName: "Bola Owner", phone: "+2348033334444" },
    });
    expect(ownerResponse.statusCode).toBe(201);
    const ownerId = (ownerResponse.json() as { owner: { id: string } }).owner.id;

    const request = await app.inject({
      method: "POST",
      url: "/v1/owners/verify/request",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { ownerId },
    });
    expect(request.statusCode).toBe(200);
    expect((request.json() as { sent: boolean }).sent).toBe(true);

    const sent = sms.sent.at(-1);
    expect(sent).toBeDefined();
    const match = /(\d{6})/u.exec(sent?.text ?? "");
    expect(match).not.toBeNull();
    const code = match?.[1] ?? "";

    const wrong = await app.inject({
      method: "POST",
      url: "/v1/owners/verify/confirm",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { ownerId, code: "000000" === code ? "111111" : "000000" },
    });
    expect(wrong.statusCode).toBe(422);

    const confirm = await app.inject({
      method: "POST",
      url: "/v1/owners/verify/confirm",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { ownerId, code },
    });
    expect(confirm.statusCode).toBe(200);
    const owner = (confirm.json() as { owner: { phoneVerifiedAt: string | null } }).owner;
    expect(owner.phoneVerifiedAt).not.toBeNull();
  });
});
