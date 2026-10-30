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
import { createMockPaymentProvider } from "@tpirs/payment-provider-mock";
import { createDb, migrateUp, repositories, withSystem, withTenant } from "@tpirs/db";
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

const FEE_MINOR = 20_000;

function validConfig(slug: string): unknown {
  return validateTenantConfig({
    identity: {
      name: "Cash Test State",
      slug,
      legalEntity: "Cash Test Revenue",
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
      appName: "Cash Test Levy",
      logoUrl: "https://x/logo.svg",
      colors: { primary: "#0a5a4a", secondary: "#053b33", accent: "#f2c200" },
      smsSenderId: "CASHTEST",
      receiptHeader: "Cash Test",
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
        qrFormat: "CT-{id}",
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
          amountMinor: FEE_MINOR,
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    // The deposit-instruction route resolves the tenant's configured payment
    // adapter, never a provider name in code (D21).
    providers: [{ port: "PaymentProvider", adapter: "mock" }],
    channels: {
      ussdCode: "*1#",
      smsKeyword: "CASH",
      otpMessageTemplate: "Cash Test code: {code}",
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
    compliance: { retentionDays: 1, dataResidency: "x", consentTextKey: "c" },
  });
}

describeIntegration("api collector cash (integration)", () => {
  let db: AnyDb;
  let app: FastifyInstance;
  const sms = createMockSmsProvider();
  const slug = `cash-api-${Date.now().toString()}`;
  const password = "cash-api-password";

  let tenantId: string;
  let assetId: string;
  let collectorId: string;
  let otherCollectorId: string;
  let depositId: string;
  let intakeId: string;

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    const passwordHash = await hashPassword(password);
    const stamp = Date.now().toString();

    await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const tenant = await repos.tenants.create({
        slug,
        name: "Cash API",
        legalEntity: "Cash API Revenue",
        config: validConfig(slug),
      });
      tenantId = tenant.id;

      const role = async (key: string, permissions: string[]) => {
        const created = await repos.roles.create({
          tenantId: tenant.id,
          key,
          name: key,
          permissions: permissions as never,
        });
        return created.id;
      };
      const collectorRole = await role("collector", ["asset:read", "cash:read", "cash:intake"]);
      const supervisorRole = await role("zone_supervisor", [
        "asset:read",
        "cash:read",
        "cash:freeze",
      ]);
      const financeRole = await role("finance_admin", [
        "payment:read",
        "payment:manage",
        "cash:read",
        "cash:intake",
        "cash:deposit:read",
        "cash:deposit:match",
        "cash:freeze",
        "cash:unfreeze",
      ]);
      const auditorRole = await role("auditor", ["cash:read", "cash:deposit:read"]);

      const user = async (username: string, roleId: string) => {
        const created = await repos.users.create({
          tenantId: tenant.id,
          username,
          displayName: username,
          passwordHash,
          totpSecret: null,
        });
        await repos.roles.assignToUser({
          tenantId: tenant.id,
          userId: created.id,
          roleId,
        });
        return created.id;
      };

      collectorId = await user("cash.collector", collectorRole);
      otherCollectorId = await user("cash.collector2", collectorRole);
      await user("cash.supervisor", supervisorRole);
      await user("cash.finance", financeRole);
      await user("cash.auditor", auditorRole);

      const asset = await repos.assets.create({
        tenantId: tenant.id,
        zoneId: null,
        ownerId: null,
        assetTypeKey: "bike",
        attributes: { plate_number: `CASH${stamp.slice(-4)}` },
        qrPayload: `cash-${stamp}`,
        qrToken: `cash-token-${stamp}`,
        shortCode: `C${stamp.slice(-5)}`,
        createdByUserId: null,
      });
      assetId = asset.id;
    });

    // Wallets are created by provisioning; the second collector needs one so
    // the freeze tests have a wallet that no intake touches.
    await withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      await repos.collectorCash.ensureWallet(tenantId, collectorId);
      await repos.collectorCash.ensureWallet(tenantId, otherCollectorId);
      const deposit = await repos.collectorCash.insertDepositIfAbsent(tenantId, {
        provider: "mock",
        providerReference: `dep-${stamp}`,
        amountMinor: BigInt(FEE_MINOR),
        currency: "NGN",
        collectorUserId: collectorId,
      });
      depositId = deposit.deposit.id;
    });

    const services = await buildServices({
      db,
      objectStorage: createMockObjectStorage(),
      secrets: createMockSecretsProvider({ "qr-token-signing-key": "cash-api-qr-key" }),
      sms,
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

  it("requires authentication", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/cash/wallets" });
    expect(response.statusCode).toBe(401);
  });

  it("records a cash intake once and returns the same receipt on replay", async () => {
    const token = await login("cash.collector");
    const payload = {
      collectorUserId: collectorId,
      clientReference: `intake-${slug}`,
      amountMinor: String(FEE_MINOR),
      assetId,
    };
    const first = await app.inject({
      method: "POST",
      url: "/v1/cash/intakes",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": `intake-${slug}` },
      payload,
    });
    expect(first.statusCode).toBe(200);
    const body = first.json() as {
      intakeId: string;
      receiptNumber: string;
      balanceMinor: string;
      replayed: boolean;
    };
    expect(body.replayed).toBe(false);
    // COLLECTOR_CASH is a debit balance: the collector holds the cash.
    expect(body.balanceMinor).toBe(String(FEE_MINOR));
    expect(body.receiptNumber).toMatch(/^R-/);
    intakeId = body.intakeId;

    const replay = await app.inject({
      method: "POST",
      url: "/v1/cash/intakes",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(replay.statusCode).toBe(200);
    const replayed = replay.json() as { intakeId: string; replayed: boolean };
    expect(replayed.intakeId).toBe(intakeId);
    expect(replayed.replayed).toBe(true);
  });

  it("refuses an intake on behalf of another collector", async () => {
    const token = await login("cash.collector");
    const response = await app.inject({
      method: "POST",
      url: "/v1/cash/intakes",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        collectorUserId: otherCollectorId,
        clientReference: `borrowed-${slug}`,
        amountMinor: String(FEE_MINOR),
        assetId,
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it("lists only the caller's wallet for a collector, and refuses another wallet", async () => {
    const token = await login("cash.collector");
    const list = await app.inject({
      method: "GET",
      url: "/v1/cash/wallets",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    const wallets = (list.json() as { wallets: { collectorUserId: string }[] }).wallets;
    expect(wallets.map((wallet) => wallet.collectorUserId)).toEqual([collectorId]);

    const other = await app.inject({
      method: "GET",
      url: `/v1/cash/wallets/${otherCollectorId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(other.statusCode).toBe(403);

    const own = await app.inject({
      method: "GET",
      url: `/v1/cash/wallets/${collectorId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(own.statusCode).toBe(200);
    const detail = own.json() as {
      wallet: { balanceMinor: string; status: string };
      intakes: { id: string; status: string }[];
    };
    expect(detail.wallet.status).toBe("active");
    expect(detail.intakes.map((intake) => intake.id)).toContain(intakeId);
  });

  it("lets a supervisor freeze with a reason, but not unfreeze", async () => {
    const token = await login("cash.supervisor");
    const headers = { authorization: `Bearer ${token}` };

    const blank = await app.inject({
      method: "POST",
      url: `/v1/cash/wallets/${otherCollectorId}/freeze`,
      headers,
      payload: { reason: "   " },
    });
    expect(blank.statusCode).toBe(400);

    const frozen = await app.inject({
      method: "POST",
      url: `/v1/cash/wallets/${otherCollectorId}/freeze`,
      headers,
      payload: { reason: "cash not banked" },
    });
    expect(frozen.statusCode).toBe(200);
    expect((frozen.json() as { wallet: { status: string } }).wallet.status).toBe("frozen");

    const unfreeze = await app.inject({
      method: "POST",
      url: `/v1/cash/wallets/${otherCollectorId}/unfreeze`,
      headers,
      payload: { reason: "verified" },
    });
    expect(unfreeze.statusCode).toBe(403);

    const finance = await login("cash.finance");
    const unfrozen = await app.inject({
      method: "POST",
      url: `/v1/cash/wallets/${otherCollectorId}/unfreeze`,
      headers: { authorization: `Bearer ${finance}` },
      payload: { reason: "deposit confirmed by bank" },
    });
    expect(unfrozen.statusCode).toBe(200);
    expect((unfrozen.json() as { wallet: { status: string } }).wallet.status).toBe("active");
  });

  it("lets an auditor read the cash register and mutate nothing", async () => {
    const token = await login("cash.auditor");
    const headers = { authorization: `Bearer ${token}` };

    const wallets = await app.inject({ method: "GET", url: "/v1/cash/wallets", headers });
    expect(wallets.statusCode).toBe(200);

    const deposits = await app.inject({
      method: "GET",
      url: `/v1/cash/deposits?collectorUserId=${collectorId}`,
      headers,
    });
    expect(deposits.statusCode).toBe(200);
    expect(
      (deposits.json() as { deposits: { id: string; status: string }[] }).deposits.map((d) => d.id),
    ).toContain(depositId);

    const freeze = await app.inject({
      method: "POST",
      url: `/v1/cash/wallets/${collectorId}/freeze`,
      headers,
      payload: { reason: "auditor curiosity" },
    });
    expect(freeze.statusCode).toBe(403);

    const intake = await app.inject({
      method: "POST",
      url: "/v1/cash/intakes",
      headers,
      payload: {
        collectorUserId: collectorId,
        clientReference: `auditor-${slug}`,
        amountMinor: String(FEE_MINOR),
        assetId,
      },
    });
    expect(intake.statusCode).toBe(403);
  });

  it("matches a suspense deposit to an open intake once", async () => {
    const token = await login("cash.finance");
    const headers = { authorization: `Bearer ${token}` };
    const payload = { intakeId };

    const matched = await app.inject({
      method: "POST",
      url: `/v1/cash/deposits/${depositId}/match`,
      headers,
      payload,
    });
    expect(matched.statusCode).toBe(200);
    const body = matched.json() as {
      outcome: string;
      allocatedMinor: string;
      replayed: boolean;
      collectorUserId: string;
    };
    expect(body.outcome).toBe("matched");
    expect(body.allocatedMinor).toBe(String(FEE_MINOR));
    expect(body.replayed).toBe(false);

    // The deposit has no unposted remainder, so the identical call is a replay
    // rather than a second posting.
    const replay = await app.inject({
      method: "POST",
      url: `/v1/cash/deposits/${depositId}/match`,
      headers,
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { replayed: boolean }).replayed).toBe(true);

    // The collector owes nothing: intake minus posted deposits is zero.
    const wallet = await app.inject({
      method: "GET",
      url: `/v1/cash/wallets/${collectorId}`,
      headers,
    });
    const view = wallet.json() as {
      wallet: { balanceMinor: string; openIntakeTotalMinor: string };
    };
    expect(view.wallet.balanceMinor).toBe("0");
    expect(view.wallet.openIntakeTotalMinor).toBe("0");
  });

  it("opens an intake reversal request without moving money", async () => {
    const token = await login("cash.finance");
    const headers = { authorization: `Bearer ${token}` };
    const response = await app.inject({
      method: "POST",
      url: `/v1/cash/intakes/${intakeId}/reverse`,
      headers,
      payload: { reason: "driver disputed the receipt" },
    });
    // 202: the request waits for a second finance user.
    expect(response.statusCode).toBe(202);
    const body = response.json() as { reversalRequestId: string; status: string };
    expect(body.status).toBe("pending");

    const wallet = await app.inject({
      method: "GET",
      url: `/v1/cash/wallets/${collectorId}`,
      headers,
    });
    expect((wallet.json() as { wallet: { balanceMinor: string } }).wallet.balanceMinor).toBe("0");

    const missing = await app.inject({
      method: "POST",
      url: "/v1/cash/intakes/00000000-0000-4000-8000-000000000000/reverse",
      headers,
      payload: { reason: "nothing there" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("refuses a forged asset reference and cash in the wrong currency", async () => {
    const token = await login("cash.collector");
    const headers = { authorization: `Bearer ${token}` };

    // A sticker the registry never issued: the intake is refused rather than
    // settling an asset by guesswork.
    const forged = await app.inject({
      method: "POST",
      url: "/v1/cash/intakes",
      headers,
      payload: {
        collectorUserId: collectorId,
        clientReference: `forged-${slug}`,
        amountMinor: String(FEE_MINOR),
        token: "not-a-real-sticker",
      },
    });
    expect(forged.statusCode).toBe(404);
    expect((forged.json() as { error: { code: string } }).error.code).toBe("asset_unknown");

    // The tenant collects NGN; a collector cannot hand over another currency
    // and have the platform price it by accident.
    const currency = await app.inject({
      method: "POST",
      url: "/v1/cash/intakes",
      headers,
      payload: {
        collectorUserId: collectorId,
        clientReference: `currency-${slug}`,
        amountMinor: String(FEE_MINOR),
        currency: "USD",
        assetId,
      },
    });
    expect(currency.statusCode).toBe(400);
    expect((currency.json() as { error: { code: string } }).error.code).toBe("amount_mismatch");
  });

  it("refuses every finance route to a collector", async () => {
    const token = await login("cash.collector");
    const headers = { authorization: `Bearer ${token}` };

    const freeze = await app.inject({
      method: "POST",
      url: `/v1/cash/wallets/${otherCollectorId}/freeze`,
      headers,
      payload: { reason: "I am not a supervisor" },
    });
    expect(freeze.statusCode).toBe(403);

    const unfreeze = await app.inject({
      method: "POST",
      url: `/v1/cash/wallets/${otherCollectorId}/unfreeze`,
      headers,
      payload: { reason: "nor finance" },
    });
    expect(unfreeze.statusCode).toBe(403);

    const deposits = await app.inject({
      method: "GET",
      url: "/v1/cash/deposits",
      headers,
    });
    expect(deposits.statusCode).toBe(403);

    const match = await app.inject({
      method: "POST",
      url: `/v1/cash/deposits/${depositId}/match`,
      headers,
      payload: { intakeId },
    });
    expect(match.statusCode).toBe(403);
  });

  it("provisions a deposit instruction from the tenant's configured provider", async () => {
    const token = await login("cash.finance");
    const response = await app.inject({
      method: "POST",
      url: `/v1/cash/collectors/${collectorId}/deposit-instruction`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      instruction: { provider: string; reference: string; kind: string; status: string };
    };
    expect(body.instruction.provider).toBe("mock");
    expect(body.instruction.kind).toBe("narration");
    expect(body.instruction.reference).toMatch(/^cash-dep-/);
    expect(body.instruction.status).toBe("active");
  });
});
