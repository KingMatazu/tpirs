import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createDb, migrateUp, repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";
import { businessDate, money } from "@tpirs/domain";
import type { BusinessDate } from "@tpirs/domain";
import { createConfigFeeEngine } from "@tpirs/fee-engine-config";
import { createMockPaymentProvider } from "@tpirs/payment-provider-mock";
import type { MockPaymentProvider } from "@tpirs/payment-provider-mock";
import type { PaymentProvider } from "@tpirs/ports";
import { PortError } from "@tpirs/ports";
import { createDriverChannelService, DRIVER_MESSAGE_KEYS } from "./driver-channel-service.js";
import type { DriverChannelService } from "./driver-channel-service.js";
import { ObligationService } from "./obligation-service.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../db/migrations");
const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

const BIKE_FEE = 20_000;
const TODAY: BusinessDate = businessDate("2026-06-15");
const YESTERDAY: BusinessDate = businessDate("2026-06-14");
const PLATE = "KJA-123";

function testConfig(slug: string): TenantConfig {
  return validateTenantConfig({
    identity: {
      name: `State ${slug}`,
      slug,
      legalEntity: `${slug} Revenue`,
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
      appName: slug,
      logoUrl: "https://x/logo.svg",
      colors: { primary: "#000", secondary: "#111", accent: "#222" },
      smsSenderId: "X",
      receiptHeader: "State Revenue",
      receiptFooter: "f",
    },
    assetTypes: [
      {
        key: "bike",
        label: "Bike",
        attributes: [
          { key: "plate_number", label: "Plate number", type: "string", required: true },
        ],
        qrFormat: `${slug}-{id}`,
        shortCodeFormat: `${slug[0]?.toUpperCase() ?? "X"}{id}`,
        stickerSpec: "60x60mm",
      },
    ],
    obligations: {
      model: "pay_per_use",
      frequency: "daily",
      prepaidAllowed: false,
      arrearsPolicy: "none",
      allocationOrder: "today_first",
      graceDays: 0,
      feeRules: [
        {
          key: "bike-daily",
          assetTypeKey: "bike",
          amountMinor: BIKE_FEE,
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    providers: [{ port: "PaymentProvider", adapter: "mock" }],
    channels: {
      ussdCode: "*1#",
      smsKeyword: "LEVY",
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
    payments: { underpaymentPolicy: "wallet" },
    featureFlags: { disputes: true, prepay: false, offlineMode: true, anomalyAlerts: true },
    reconciliation: { schedule: "0 2 * * *", toleranceMinor: 0, notifyRole: "finance_admin" },
    compliance: { retentionDays: 1, dataResidency: "x", consentTextKey: "c" },
  });
}

interface TenantFixture {
  readonly tenantId: string;
  readonly assetId: string;
}

describeIntegration("driver channel service (integration)", () => {
  let db: AnyDb;
  let service: DriverChannelService;
  let provider: MockPaymentProvider;
  let obligations: ObligationService;
  const config = testConfig("driver");
  const configs = new Map<string, TenantConfig>();

  const failingProvider: PaymentProvider = {
    name: "mock",
    capabilities: () => ({
      supportsVirtualAccounts: false,
      supportsPaymentReferences: true,
      supportsSettlementFetch: false,
      attributionKinds: ["intent_reference"],
    }),
    createPaymentIntent: () =>
      Promise.reject(new PortError("PaymentProvider", "unavailable", "gateway down")),
    verifyWebhook: () => Promise.resolve({ ok: true }),
    normalizeWebhook: () => {
      throw new Error("not used");
    },
    fetchSettlements: () => Promise.resolve([]),
  };

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    const loadConfig = (id: string) => Promise.resolve(configs.get(id));
    const feeEngine = createConfigFeeEngine({ loadConfig });
    provider = createMockPaymentProvider();
    service = createDriverChannelService({
      db,
      loadConfig,
      feeEngine,
      providerFor: (name) => (name === "mock" ? provider : undefined),
      now: () => new Date("2026-06-15T09:00:00Z"),
    });
    obligations = new ObligationService(db, feeEngine);
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await db.destroy();
  });

  async function makeTenant(): Promise<TenantFixture> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tenant = await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const created = await repos.tenants.create({
        slug: `driver-${stamp}`,
        name: "Driver",
        legalEntity: "Driver Revenue",
        config: {},
      });
      const owner = await repos.owners.create({
        tenantId: created.id,
        displayName: "Driver",
        phone: "+2348012345678",
      });
      await repos.assets.create({
        tenantId: created.id,
        zoneId: null,
        ownerId: owner.id,
        assetTypeKey: "bike",
        attributes: { plate_number: PLATE },
        qrPayload: `driver-${stamp}`,
        qrToken: `driver-${stamp}-token`,
        shortCode: "D1",
        createdByUserId: null,
      });
      return created;
    });
    configs.set(tenant.id, config);

    const asset = await withTenant(db, tenant.id, async (tx) =>
      repositories(tx).assets.findByShortCode("D1"),
    );
    if (asset === undefined) throw new Error("asset not found");
    return { tenantId: tenant.id, assetId: asset.id };
  }

  async function settleDay(
    fixture: TenantFixture,
    day: BusinessDate,
    amount: number,
  ): Promise<void> {
    await obligations.ensurePaidForBusinessDay({
      tenantId: fixture.tenantId,
      config,
      assetId: fixture.assetId,
      assetTypeKey: "bike",
      businessDate: day,
      amount: money("NGN", amount),
      idempotencyKey: `seed:${fixture.tenantId}:${day}`,
    });
  }

  async function walletBalance(fixture: TenantFixture): Promise<bigint> {
    return obligations.getWalletBalance(fixture.tenantId, fixture.assetId);
  }

  it("reports a recorded payment as paid, resolving a plate case-insensitively", async () => {
    const fixture = await makeTenant();
    await settleDay(fixture, TODAY, BIKE_FEE);

    const reply = await service.status({
      tenantId: fixture.tenantId,
      assetRef: PLATE.toLowerCase(),
    });

    expect(reply.kind).toBe("status");
    if (reply.kind !== "status") return;
    expect(reply.status).toBe("paid");
    expect(reply.settled).toBe(true);
    expect(reply.messageKey).toBe(DRIVER_MESSAGE_KEYS.statusPaid);
    expect(reply.variables["assetRef"]).toBe(PLATE.toLowerCase());
  });

  it("reports a day with no payment as 'no payment recorded', never as debt", async () => {
    const fixture = await makeTenant();

    const reply = await service.status({ tenantId: fixture.tenantId, assetRef: PLATE });

    expect(reply.kind).toBe("status");
    if (reply.kind !== "status") return;
    expect(reply.status).toBe("none");
    expect(reply.settled).toBe(false);
    expect(reply.messageKey).toBe(DRIVER_MESSAGE_KEYS.statusNone);
  });

  it("treats a waived day as settled", async () => {
    const fixture = await makeTenant();
    await withTenant(db, fixture.tenantId, async (tx) =>
      repositories(tx).obligations.create(fixture.tenantId, {
        assetId: fixture.assetId,
        periodKey: TODAY,
        businessDate: TODAY,
        amountMinor: BigInt(BIKE_FEE),
        currency: "NGN",
        status: "waived",
      }),
    );

    const reply = await service.status({ tenantId: fixture.tenantId, assetRef: PLATE });

    expect(reply.kind).toBe("status");
    if (reply.kind !== "status") return;
    expect(reply.status).toBe("waived");
    expect(reply.settled).toBe(true);
    expect(reply.messageKey).toBe(DRIVER_MESSAGE_KEYS.statusPaid);
  });

  it("returns a configured unknown-reference reply for an asset nobody owns", async () => {
    const fixture = await makeTenant();

    const status = await service.status({ tenantId: fixture.tenantId, assetRef: "ZZZ999" });
    const pay = await service.pay({ tenantId: fixture.tenantId, assetRef: "ZZZ999" });

    expect(status.kind).toBe("unknown_asset");
    expect(status.messageKey).toBe(DRIVER_MESSAGE_KEYS.assetUnknown);
    expect(pay.kind).toBe("unknown_asset");
  });

  it("creates only one intent when the same pay action is replayed", async () => {
    const fixture = await makeTenant();
    const before = provider.intents.length;

    const first = await service.pay({ tenantId: fixture.tenantId, assetRef: PLATE });
    const second = await service.pay({ tenantId: fixture.tenantId, assetRef: PLATE });

    expect(first.kind).toBe("payment_request");
    expect(second.kind).toBe("payment_request");
    if (first.kind !== "payment_request" || second.kind !== "payment_request") return;
    expect(first.reference).toBe(second.reference);
    expect(first.amountMinor).toBe(BigInt(BIKE_FEE));
    expect(provider.intents).toHaveLength(before + 1);
  });

  it("does not issue an intent for a day that is already settled", async () => {
    const fixture = await makeTenant();
    await settleDay(fixture, TODAY, BIKE_FEE);
    const before = provider.intents.length;

    const reply = await service.pay({ tenantId: fixture.tenantId, assetRef: PLATE });

    expect(reply.kind).toBe("already_paid");
    expect(reply.messageKey).toBe(DRIVER_MESSAGE_KEYS.statusPaid);
    expect(provider.intents).toHaveLength(before);
  });

  it("returns the asset's configured virtual-account instruction instead of a new intent", async () => {
    const fixture = await makeTenant();
    await withTenant(db, fixture.tenantId, async (tx) =>
      repositories(tx).paymentInstructions.create(fixture.tenantId, {
        assetId: fixture.assetId,
        provider: "mock",
        reference: "VA-ASSET-1",
        kind: "virtual_account",
        amountMinor: null,
        currency: null,
      }),
    );
    const before = provider.intents.length;

    const reply = await service.pay({ tenantId: fixture.tenantId, assetRef: PLATE });

    expect(reply.kind).toBe("payment_request");
    if (reply.kind !== "payment_request") return;
    expect(reply.reference).toBe("VA-ASSET-1");
    expect(reply.existingInstruction).toBe(true);
    expect(reply.attributionKind).toBe("virtual_account");
    expect(provider.intents).toHaveLength(before);
  });

  it("reports wallet coverage without spending it on a plain pay action", async () => {
    const fixture = await makeTenant();
    await settleDay(fixture, YESTERDAY, BIKE_FEE * 2);
    expect(await walletBalance(fixture)).toBe(BigInt(BIKE_FEE));
    const before = provider.intents.length;

    const reply = await service.pay({ tenantId: fixture.tenantId, assetRef: PLATE });

    expect(reply.kind).toBe("nothing_required");
    expect(reply.messageKey).toBe(DRIVER_MESSAGE_KEYS.payCovered);
    expect(provider.intents).toHaveLength(before);
    expect(await walletBalance(fixture)).toBe(BigInt(BIKE_FEE));
  });

  it("settles today from wallet credit when pay-from-balance is chosen", async () => {
    const fixture = await makeTenant();
    await settleDay(fixture, YESTERDAY, BIKE_FEE * 2);

    const reply = await service.payFromBalance({ tenantId: fixture.tenantId, assetRef: PLATE });

    expect(reply.kind).toBe("paid_from_balance");
    expect(reply.messageKey).toBe(DRIVER_MESSAGE_KEYS.payBalance);
    expect(await walletBalance(fixture)).toBe(0n);
    const status = await service.status({ tenantId: fixture.tenantId, assetRef: PLATE });
    expect(status.kind === "status" && status.settled).toBe(true);
  });

  it("reports the exact shortfall when the wallet cannot cover the fee", async () => {
    const fixture = await makeTenant();

    const reply = await service.payFromBalance({ tenantId: fixture.tenantId, assetRef: PLATE });

    expect(reply.kind).toBe("insufficient_balance");
    if (reply.kind !== "insufficient_balance") return;
    expect(reply.shortfallMinor).toBe(BigInt(BIKE_FEE));
    expect(reply.messageKey).toBe(DRIVER_MESSAGE_KEYS.payInsufficient);
    expect(reply.variables["amount"]).toContain("200");
  });

  it("maps a provider failure to a safe driver-facing reply", async () => {
    const fixture = await makeTenant();
    const failing = createDriverChannelService({
      db,
      loadConfig: (id) => Promise.resolve(configs.get(id)),
      feeEngine: createConfigFeeEngine({ loadConfig: (id) => Promise.resolve(configs.get(id)) }),
      providerFor: (name) => (name === "mock" ? failingProvider : undefined),
      now: () => new Date("2026-06-15T09:00:00Z"),
    });

    const reply = await failing.pay({ tenantId: fixture.tenantId, assetRef: PLATE });

    expect(reply.kind).toBe("payment_failed");
    if (reply.kind !== "payment_failed") return;
    expect(reply.messageKey).toBe(DRIVER_MESSAGE_KEYS.payFailed);
    expect(reply.reason).toContain("unavailable");
  });

  it("dispatches engine actions without duplicating the use cases", async () => {
    const fixture = await makeTenant();

    const reply = await service.execute({
      tenantId: fixture.tenantId,
      assetRef: PLATE,
      action: "status",
    });

    expect(reply.kind).toBe("status");
    if (reply.kind !== "status") return;
    expect(reply.status).toBe("none");
  });
});
