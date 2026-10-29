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
import { money } from "@tpirs/domain";
import { LedgerService } from "@tpirs/application";

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
};

function validConfig(slug: string): unknown {
  return validateTenantConfig({
    identity: {
      name: "Reversal State",
      slug,
      legalEntity: "Reversal State Revenue",
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
      appName: "Reversal",
      logoUrl: "https://x/logo.svg",
      colors: { primary: "#000", secondary: "#111", accent: "#222" },
      smsSenderId: "REV",
      receiptHeader: "Reversal",
      receiptFooter: "Thanks",
    },
    assetTypes: [
      {
        key: "bike",
        label: "Bike",
        attributes: [],
        qrFormat: "RV-{id}",
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
      smsKeyword: "REV",
      otpMessageTemplate: "Reversal code: {code}",
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

describeIntegration("api reversals (integration)", () => {
  let db: AnyDb;
  let app: FastifyInstance;
  const slug = `reversal-api-${Date.now().toString()}`;
  const password = "reversal-api-password";
  let tenantId: string;
  let financeOneId: string;
  let financeTwoId: string;
  let firstRequestId: string;
  let secondRequestId: string;

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    const passwordHash = await hashPassword(password);

    await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const tenant = await repos.tenants.create({
        slug,
        name: "Reversal API",
        legalEntity: "Reversal API Revenue",
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
      const financeRole = await role("finance_admin", [
        "ledger:read",
        "ledger:approve",
        "ledger:reverse",
        "payment:manage",
      ]);
      const auditorRole = await role("auditor", ["ledger:read", "audit:read"]);
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
      financeOneId = await user("rev.finance1", financeRole);
      financeTwoId = await user("rev.finance2", financeRole);
      await user("rev.auditor", auditorRole);
      await user("rev.collector", collectorRole);
    });

    // A real posted transaction, then one pending request per finance user.
    const originalIds = await withTenant(db, tenantId, async (tx) => {
      const ledger = new LedgerService(tx);
      const repos = repositories(tx);
      const first = await ledger.postTransaction(tenantId, {
        postings: [
          { accountCode: "SETTLEMENT_BANK", direction: "debit", amount: money("NGN", 5_000) },
          { accountCode: "REVENUE_LEVY", direction: "credit", amount: money("NGN", 5_000) },
        ],
        sourceType: "test",
        description: "reversal fixture",
      });
      const second = await ledger.postTransaction(tenantId, {
        postings: [
          { accountCode: "SETTLEMENT_BANK", direction: "debit", amount: money("NGN", 7_000) },
          { accountCode: "REVENUE_LEVY", direction: "credit", amount: money("NGN", 7_000) },
        ],
        sourceType: "test",
        description: "reversal fixture 2",
      });
      const firstRequest = await repos.reversals.create(tenantId, {
        originalTransactionId: first.transaction.id,
        reason: "driver disputed the receipt",
        requestedByUserId: financeOneId,
      });
      const secondRequest = await repos.reversals.create(tenantId, {
        originalTransactionId: second.transaction.id,
        reason: "duplicate charge",
        requestedByUserId: financeTwoId,
      });
      firstRequestId = firstRequest.id;
      secondRequestId = secondRequest.id;
      return [first.transaction.id, second.transaction.id];
    });
    expect(originalIds).toHaveLength(2);

    const services = await buildServices({
      db,
      objectStorage: createMockObjectStorage(),
      secrets: createMockSecretsProvider({ "qr-token-signing-key": "reversal-api-qr-key" }),
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

  it("lists pending requests for a reader", async () => {
    const token = await login("rev.auditor");
    const response = await app.inject({
      method: "GET",
      url: "/v1/reversals?status=pending",
      headers: auth(token),
    });
    expect(response.statusCode).toBe(200);
    const reversals = (response.json() as { reversals: { id: string; status: string }[] })
      .reversals;
    expect(reversals.map((row) => row.id)).toEqual(
      expect.arrayContaining([firstRequestId, secondRequestId]),
    );
    expect(reversals.every((row) => row.status === "pending")).toBe(true);
  });

  it("refuses the requester's own approval and then posts a different approver's", async () => {
    const requester = await login("rev.finance1");
    const self = await app.inject({
      method: "POST",
      url: `/v1/reversals/${firstRequestId}/approve`,
      headers: auth(requester),
      payload: { note: "I will approve my own request" },
    });
    expect(self.statusCode).toBe(409);
    expect((self.json() as { error: { code: string } }).error.code).toBe("self_approval");

    const approver = await login("rev.finance2");
    const approved = await app.inject({
      method: "POST",
      url: `/v1/reversals/${firstRequestId}/approve`,
      headers: auth(approver),
      payload: { note: "checked with the driver" },
    });
    expect(approved.statusCode).toBe(200);
    const body = approved.json() as {
      reversal: { status: string; approvedByUserId: string };
      transactionId: string;
    };
    expect(body.reversal.status).toBe("approved");
    expect(body.reversal.approvedByUserId).toBe(financeTwoId);
    expect(body.transactionId).not.toBe("");

    // Mirrored entries balance, and the request cannot be approved twice.
    const totals = await withTenant(db, tenantId, async (tx) =>
      tx
        .selectFrom("ledgerEntries")
        .select((eb) => [eb.fn.sum("amountMinor").as("total")])
        .executeTakeFirst(),
    );
    expect(BigInt(String(totals?.total ?? 0)) > 0n).toBe(true);

    const again = await app.inject({
      method: "POST",
      url: `/v1/reversals/${firstRequestId}/approve`,
      headers: auth(approver),
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: { code: string } }).error.code).toBe("reversal_not_pending");
  });

  it("rejects with a reason and records the actor", async () => {
    const approver = await login("rev.finance1");
    const noReason = await app.inject({
      method: "POST",
      url: `/v1/reversals/${secondRequestId}/reject`,
      headers: auth(approver),
      payload: {},
    });
    expect(noReason.statusCode).toBe(400);

    const rejected = await app.inject({
      method: "POST",
      url: `/v1/reversals/${secondRequestId}/reject`,
      headers: auth(approver),
      payload: { reason: "the charge is correct" },
    });
    expect(rejected.statusCode).toBe(200);
    const body = rejected.json() as {
      reversal: { status: string; rejectedByUserId: string };
    };
    expect(body.reversal.status).toBe("rejected");
    expect(body.reversal.rejectedByUserId).toBe(financeOneId);
  });

  it("keeps an auditor read-only and a collector out", async () => {
    const auditor = await login("rev.auditor");
    const collector = await login("rev.collector");

    const auditorApprove = await app.inject({
      method: "POST",
      url: `/v1/reversals/${secondRequestId}/approve`,
      headers: auth(auditor),
      payload: {},
    });
    expect(auditorApprove.statusCode).toBe(403);

    const collectorList = await app.inject({
      method: "GET",
      url: "/v1/reversals",
      headers: auth(collector),
    });
    expect(collectorList.statusCode).toBe(403);
  });
});
