import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createDb, migrateUp, repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";
import { businessDate, money } from "@tpirs/domain";
import type { BusinessDate } from "@tpirs/domain";
import { createConfigFeeEngine } from "@tpirs/fee-engine-config";
import { ObligationError, ObligationService } from "./obligation-service.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../db/migrations");

const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

const BIKE_FEE = 20_000;

function testConfig(
  slug: string,
  currency: string,
  model: "pay_per_use" | "scheduled",
): TenantConfig {
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
      timezone: "Africa/Lagos",
      currency,
      numberFormat: "en-NG",
      dateFormat: "dd/MM/yyyy",
    },
    branding: {
      appName: slug,
      logoUrl: "https://x/logo.svg",
      colors: { primary: "#000", secondary: "#111", accent: "#222" },
      smsSenderId: "X",
      receiptHeader: "h",
      receiptFooter: "f",
    },
    assetTypes: [
      {
        key: "bike",
        label: "Bike",
        attributes: [],
        qrFormat: `${slug}-{id}`,
        shortCodeFormat: `${slug[0]?.toUpperCase() ?? "X"}{id}`,
        stickerSpec: "60x60mm",
      },
    ],
    obligations: {
      model,
      frequency: "daily",
      prepaidAllowed: false,
      arrearsPolicy: model === "scheduled" ? "accrue" : "none",
      allocationOrder: "oldest_first",
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
    providers: [],
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
    featureFlags: { disputes: true, prepay: false, offlineMode: true, anomalyAlerts: true },
    reconciliation: { schedule: "0 2 * * *", toleranceMinor: 0, notifyRole: "finance_admin" },
    compliance: { retentionDays: 1, dataResidency: "x", consentTextKey: "c" },
  });
}

describeIntegration("ObligationService (integration)", () => {
  let db: AnyDb;
  let perUseTenantId: string;
  let scheduledTenantId: string;
  let perUseAssetId: string;
  let scheduledAssetId: string;
  let service: ObligationService;
  const perUseConfig = testConfig("peruse", "NGN", "pay_per_use");
  const scheduledConfig = testConfig("sched", "NGN", "scheduled");
  const configs = new Map<string, TenantConfig>();

  const today: BusinessDate = businessDate("2026-06-15");

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    const stamp = Date.now().toString();

    await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const perUse = await repos.tenants.create({
        slug: `peruse-${stamp}`,
        name: "Per Use",
        legalEntity: "Per Use Revenue",
        config: {},
      });
      const scheduled = await repos.tenants.create({
        slug: `sched-${stamp}`,
        name: "Scheduled",
        legalEntity: "Scheduled Revenue",
        config: {},
      });
      perUseTenantId = perUse.id;
      scheduledTenantId = scheduled.id;

      const perUseAsset = await repos.assets.create({
        tenantId: perUseTenantId,
        zoneId: null,
        ownerId: null,
        assetTypeKey: "bike",
        attributes: { plate_number: "PERUSE1" },
        qrPayload: `peruse-${stamp}-1`,
        qrToken: `peruse-${stamp}-1-token`,
        shortCode: "P1",
        createdByUserId: null,
      });
      const scheduledAsset = await repos.assets.create({
        tenantId: scheduledTenantId,
        zoneId: null,
        ownerId: null,
        assetTypeKey: "bike",
        attributes: { plate_number: "SCHED1" },
        qrPayload: `sched-${stamp}-1`,
        qrToken: `sched-${stamp}-1-token`,
        shortCode: "S1",
        createdByUserId: null,
      });
      perUseAssetId = perUseAsset.id;
      scheduledAssetId = scheduledAsset.id;
    });

    configs.set(perUseTenantId, perUseConfig);
    configs.set(scheduledTenantId, scheduledConfig);
    const loadConfig = (id: string) => Promise.resolve(configs.get(id));
    service = new ObligationService(db, createConfigFeeEngine({ loadConfig }));
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await db.destroy();
  });

  async function balances(tenantId: string, assetId: string) {
    return withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      return {
        wallet: await repos.ledger.accountBalance(tenantId, "ASSET_WALLET", assetId),
        revenue: await repos.ledger.accountBalance(tenantId, "REVENUE_LEVY", assetId),
        clearing: await repos.ledger.accountBalance(tenantId, "GATEWAY_CLEARING", assetId),
      };
    });
  }

  async function periods(tenantId: string, assetId: string) {
    return withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      return repos.obligations.findUnpaidForAsset(tenantId, assetId);
    });
  }

  it("credits the wallet first and then allocates the payment to revenue", async () => {
    const result = await service.ensurePaidForBusinessDay({
      tenantId: perUseTenantId,
      config: perUseConfig,
      assetId: perUseAssetId,
      assetTypeKey: "bike",
      businessDate: today,
      amount: money("NGN", BIKE_FEE),
      paymentId: "payment-1",
      idempotencyKey: "payment-1",
    });

    expect(result.walletTransaction).not.toBeNull();
    expect(result.allocationTransactions).toHaveLength(1);
    expect(result.allocatedMinor).toBe(BigInt(BIKE_FEE));
    expect(result.surplusMinor).toBe(0n);

    const after = await balances(perUseTenantId, perUseAssetId);
    expect(after.wallet).toBe(0n);
    expect(after.revenue).toBe(BigInt(BIKE_FEE));
    expect(after.clearing).toBe(-BigInt(BIKE_FEE));
  });

  it("snapshots the rule and the amount that priced the period", async () => {
    await withTenant(db, perUseTenantId, async (tx) => {
      const repos = repositories(tx);
      const row = await repos.obligations.findByAssetAndPeriod(
        perUseTenantId,
        perUseAssetId,
        today,
      );
      expect(row).toBeDefined();
      expect(row?.status).toBe("paid");
      expect(row?.amountPaidMinor).toBe(BigInt(BIKE_FEE));
      expect(row?.feeRuleKey).toBe("bike-daily");
      expect(row?.feeAmountSnapshotMinor).toBe(BigInt(BIKE_FEE));
      expect(row?.paidTransactionId).not.toBeNull();
    });
  });

  it("keeps an overpayment in the wallet instead of recognising extra revenue", async () => {
    const asset = await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      return repos.assets.create({
        tenantId: perUseTenantId,
        zoneId: null,
        ownerId: null,
        assetTypeKey: "bike",
        attributes: { plate_number: "OVERPAY" },
        qrPayload: "overpay-payload",
        qrToken: "overpay-token",
        shortCode: "OP1",
        createdByUserId: null,
      });
    });

    const result = await service.ensurePaidForBusinessDay({
      tenantId: perUseTenantId,
      config: perUseConfig,
      assetId: asset.id,
      assetTypeKey: "bike",
      businessDate: today,
      amount: money("NGN", BIKE_FEE + 5_000),
      paymentId: "payment-over",
      idempotencyKey: "payment-over",
    });

    expect(result.allocatedMinor).toBe(BigInt(BIKE_FEE));
    expect(result.surplusMinor).toBe(5_000n);

    const after = await balances(perUseTenantId, asset.id);
    expect(after.wallet).toBe(5_000n);
    expect(after.revenue).toBe(BigInt(BIKE_FEE));
  });

  it("settles nothing when the payment is short", async () => {
    const asset = await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      return repos.assets.create({
        tenantId: perUseTenantId,
        zoneId: null,
        ownerId: null,
        assetTypeKey: "bike",
        attributes: { plate_number: "SHORT" },
        qrPayload: "short-payload",
        qrToken: "short-token",
        shortCode: "SH1",
        createdByUserId: null,
      });
    });

    const result = await service.ensurePaidForBusinessDay({
      tenantId: perUseTenantId,
      config: perUseConfig,
      assetId: asset.id,
      assetTypeKey: "bike",
      businessDate: today,
      amount: money("NGN", 5_000),
      paymentId: "payment-short",
      idempotencyKey: "payment-short",
    });

    // A day that is not paid in full is not a debt: nothing is recognised.
    expect(result.allocatedMinor).toBe(0n);
    expect(result.allocationTransactions).toHaveLength(0);
    expect(result.surplusMinor).toBe(5_000n);

    const after = await balances(perUseTenantId, asset.id);
    expect(after.wallet).toBe(5_000n);
    expect(after.revenue).toBe(0n);

    const open = await withTenant(db, perUseTenantId, async (tx) => {
      const repos = repositories(tx);
      return repos.obligations.findByAssetAndPeriod(perUseTenantId, asset.id, today);
    });
    expect(open?.status).toBe("unpaid");
    expect(open?.amountPaidMinor).toBe(0n);
  });

  it("does nothing when the same payment is replayed", async () => {
    const asset = await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      return repos.assets.create({
        tenantId: perUseTenantId,
        zoneId: null,
        ownerId: null,
        assetTypeKey: "bike",
        attributes: { plate_number: "REPLAY" },
        qrPayload: "replay-payload",
        qrToken: "replay-token",
        shortCode: "RP1",
        createdByUserId: null,
      });
    });

    const first = await service.ensurePaidForBusinessDay({
      tenantId: perUseTenantId,
      config: perUseConfig,
      assetId: asset.id,
      assetTypeKey: "bike",
      businessDate: today,
      amount: money("NGN", BIKE_FEE),
      paymentId: "payment-replay",
      idempotencyKey: "payment-replay",
    });
    const second = await service.ensurePaidForBusinessDay({
      tenantId: perUseTenantId,
      config: perUseConfig,
      assetId: asset.id,
      assetTypeKey: "bike",
      businessDate: today,
      amount: money("NGN", BIKE_FEE),
      paymentId: "payment-replay",
      idempotencyKey: "payment-replay",
    });

    expect(second.walletTransaction?.id).toBe(first.walletTransaction?.id);
    const after = await balances(perUseTenantId, asset.id);
    expect(after.wallet).toBe(0n);
    expect(after.revenue).toBe(BigInt(BIKE_FEE));
  });

  it("creates no period for a day that was never paid", async () => {
    const asset = await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      return repos.assets.create({
        tenantId: perUseTenantId,
        zoneId: null,
        ownerId: null,
        assetTypeKey: "bike",
        attributes: { plate_number: "IDLE" },
        qrPayload: "idle-payload",
        qrToken: "idle-token",
        shortCode: "ID1",
        createdByUserId: null,
      });
    });

    await service.ensurePaidForBusinessDay({
      tenantId: perUseTenantId,
      config: perUseConfig,
      assetId: asset.id,
      assetTypeKey: "bike",
      businessDate: today,
      amount: money("NGN", BIKE_FEE),
      paymentId: "payment-idle",
      idempotencyKey: "payment-idle",
    });

    const all = await withTenant(db, perUseTenantId, async (tx) => {
      const repos = repositories(tx);
      return repos.obligations.findUnpaidForAsset(perUseTenantId, asset.id);
    });
    // The paid period is no longer unpaid, and no other day was created.
    expect(all).toHaveLength(0);

    const tomorrow = await withTenant(db, perUseTenantId, async (tx) => {
      const repos = repositories(tx);
      return repos.obligations.findByAssetAndPeriod(
        perUseTenantId,
        asset.id,
        businessDate("2026-06-16"),
      );
    });
    expect(tomorrow).toBeUndefined();
  });

  it("rejects a payment in a currency the tenant does not charge", async () => {
    await expect(
      service.ensurePaidForBusinessDay({
        tenantId: perUseTenantId,
        config: perUseConfig,
        assetId: perUseAssetId,
        assetTypeKey: "bike",
        businessDate: today,
        amount: money("GHS", BIKE_FEE),
        paymentId: "payment-wrong-currency",
        idempotencyKey: "payment-wrong-currency",
      }),
    ).rejects.toThrow(ObligationError);
  });

  it("materialises scheduled periods and drains them oldest first", async () => {
    const generated = await service.generateScheduledPeriods(scheduledTenantId, scheduledConfig, {
      businessDate: today,
      arrearsWindowPeriods: 2,
    });
    expect(generated.created).toBe(3);

    const result = await service.ensurePaidForBusinessDay({
      tenantId: scheduledTenantId,
      config: scheduledConfig,
      assetId: scheduledAssetId,
      assetTypeKey: "bike",
      businessDate: today,
      amount: money("NGN", BIKE_FEE * 3),
      paymentId: "payment-scheduled",
      idempotencyKey: "payment-scheduled",
    });

    expect(result.allocatedMinor).toBe(BigInt(BIKE_FEE * 3));
    expect(result.allocationTransactions).toHaveLength(3);

    const after = await balances(scheduledTenantId, scheduledAssetId);
    expect(after.wallet).toBe(0n);
    expect(after.revenue).toBe(BigInt(BIKE_FEE * 3));

    const open = await periods(scheduledTenantId, scheduledAssetId);
    expect(open).toHaveLength(0);
  });

  it("generates nothing for a pay_per_use tenant", async () => {
    const generated = await service.generateScheduledPeriods(perUseTenantId, perUseConfig, {
      businessDate: today,
      arrearsWindowPeriods: 5,
    });
    expect(generated.created).toBe(0);
    expect(generated.skipped).toBe(0);
  });
});
