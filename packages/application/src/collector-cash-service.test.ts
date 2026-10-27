import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createDb, migrateUp, repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";
import { businessDate, CashError, money } from "@tpirs/domain";
import type { BusinessDate } from "@tpirs/domain";
import { createConfigFeeEngine } from "@tpirs/fee-engine-config";
import { CollectorCashService } from "./collector-cash-service.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../db/migrations");
const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

const BIKE_FEE = 20_000;
const TODAY: BusinessDate = businessDate("2026-06-15");

/**
 * A config like the seeded states, but the caller chooses the float ceiling:
 * most tests need one big enough to take a fee, the ceiling test needs one
 * that runs out exactly.
 */
function testConfig(
  slug: string,
  floats: { ceilingMinor?: number; disabled?: boolean } = {},
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
        attributes: [],
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
      cashReceiptTemplate: "Cash {receiptNo}: {amount} for {assetRef} on {date}.",
      menus: [],
    },
    cashRules: {
      enabled: !floats.disabled,
      floatCeilingMinor: floats.ceilingMinor ?? 1_000_000,
      depositDeadlineHours: 8,
      freezeOnShortfall: true,
    },
    payments: { underpaymentPolicy: "wallet" },
    featureFlags: { disputes: true, prepay: false, offlineMode: true, anomalyAlerts: true },
    reconciliation: { schedule: "0 2 * * *", toleranceMinor: 0, notifyRole: "finance_admin" },
    compliance: { retentionDays: 1, dataResidency: "ng", consentTextKey: "c" },
  });
}

describeIntegration("CollectorCashService (integration)", () => {
  let db: AnyDb;
  let service: CollectorCashService;
  const configs = new Map<string, TenantConfig>();

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    const loadConfig = (id: string) => Promise.resolve(configs.get(id));
    service = new CollectorCashService({
      db,
      loadConfig,
      feeEngine: createConfigFeeEngine({ loadConfig }),
      now: () => new Date("2026-06-15T09:00:00Z"),
    });
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await db.destroy();
  });

  interface TenantFixture {
    readonly tenantId: string;
    readonly assetId: string;
    readonly token: string;
    readonly reference: string;
    readonly collectorUserId: string;
    readonly ownerPhone: string;
  }

  /** A fresh tenant with one bike asset and one collector, so no test shares a wallet. */
  async function makeTenant(
    options: { ceilingMinor?: number; disabled?: boolean } = {},
  ): Promise<TenantFixture> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const slug = `cash${stamp.replace(/[^a-z0-9]/g, "")}`.slice(0, 30);
    const created = await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const tenant = await repos.tenants.create({
        slug,
        name: "Cash",
        legalEntity: "Cash Revenue",
        config: {},
      });
      configs.set(tenant.id, testConfig(slug, options));
      const owner = await repos.owners.create({
        tenantId: tenant.id,
        displayName: "Driver",
        phone: "+2348012345678",
      });
      const collector = await repos.users.create({
        tenantId: tenant.id,
        username: `collector-${stamp}`,
        displayName: "Collector",
        passwordHash: "not-a-real-hash",
        totpSecret: null,
      });
      await repos.assets.create({
        tenantId: tenant.id,
        zoneId: null,
        ownerId: owner.id,
        assetTypeKey: "bike",
        attributes: { plate_number: `KJA-${stamp.slice(-4)}` },
        qrPayload: `cash-${stamp}`,
        qrToken: `cash-${stamp}-token`,
        shortCode: "C1",
        createdByUserId: null,
      });
      return { tenantId: tenant.id, collectorId: collector.id, ownerPhone: owner.phone };
    });
    const asset = await withTenant(db, created.tenantId, async (tx) => {
      const found = await repositories(tx).assets.findByShortCode("C1");
      if (found === undefined) throw new Error("asset not found");
      return { assetId: found.id, token: found.qrToken, reference: found.shortCode };
    });
    return {
      tenantId: created.tenantId,
      ...asset,
      collectorUserId: created.collectorId,
      ownerPhone: created.ownerPhone,
    };
  }

  function baseInput(tenant: TenantFixture) {
    return {
      tenantId: tenant.tenantId,
      collectorUserId: tenant.collectorUserId,
      reference: tenant.reference,
      amount: money("NGN", BIKE_FEE),
      clientReference: `cli-${Math.random().toString(36).slice(2, 10)}`,
    };
  }

  async function collectorBalance(tenant: TenantFixture): Promise<bigint> {
    return withTenant(db, tenant.tenantId, async (tx) =>
      repositories(tx).ledger.collectorCashBalance(tenant.tenantId, tenant.collectorUserId),
    );
  }

  it("takes cash, settles the day, records the intake and receipts the owner", async () => {
    const tenant = await makeTenant();
    const result = await service.recordIntake(baseInput(tenant));

    expect(result.replayed).toBe(false);
    expect(result.assetRef).toMatch(/^KJA-/);
    expect(result.receiptNumber).toMatch(/^R-/);
    expect(result.balanceMinor).toBe(BigInt(BIKE_FEE));
    expect(result.smsQueued).toBe(true);
    expect(result.businessDate).toBe(TODAY);

    // The day is settled exactly as a gateway payment would settle it, and the
    // collector's float now shows the cash the law expects them to hand over.
    const observed = await withTenant(db, tenant.tenantId, async (tx) => {
      const repos = repositories(tx);
      const period = await repos.obligations.findByAssetAndPeriod(
        tenant.tenantId,
        tenant.assetId,
        TODAY,
      );
      const wallet = await repos.ledger.accountBalance(
        tenant.tenantId,
        "ASSET_WALLET",
        tenant.assetId,
      );
      const revenue = await repos.ledger.accountBalance(
        tenant.tenantId,
        "REVENUE_LEVY",
        tenant.assetId,
      );
      const intake = await repos.collectorCash.findIntakeById(tenant.tenantId, result.intakeId);
      return { periodStatus: period?.status, wallet, revenue, intake };
    });
    expect(observed.periodStatus).toBe("paid");
    expect(observed.wallet).toBe(0n); // credited then drained by the allocation
    expect(observed.revenue).toBe(BigInt(BIKE_FEE));
    expect(observed.intake?.status).toBe("open");

    const receipt = await withTenant(db, tenant.tenantId, async (tx) =>
      repositories(tx).smsLog.findCashIntakeReceipt(tenant.tenantId, result.intakeId),
    );
    expect(receipt?.recipient).toBe(tenant.ownerPhone);
    expect(receipt?.body).toContain(result.receiptNumber);
    expect(receipt?.body).toContain("Cash");
  });

  it("answers an exact replay with the original intake and no second receipt", async () => {
    const tenant = await makeTenant();
    const clientReference = "cli-replay";
    const original = await service.recordIntake({ ...baseInput(tenant), clientReference });
    const replay = await service.recordIntake({ ...baseInput(tenant), clientReference });

    // A double click may not charge the wallet twice or queue a second SMS.
    expect(original.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.intakeId).toBe(original.intakeId);
    expect(replay.receiptNumber).toBe(original.receiptNumber);
    expect(replay.balanceMinor).toBe(original.balanceMinor);
    expect(replay.smsQueued).toBe(true);

    const receipt = await withTenant(db, tenant.tenantId, async (tx) =>
      repositories(tx).smsLog.findCashIntakeReceipt(tenant.tenantId, original.intakeId),
    );
    expect(receipt).toBeDefined();
    expect(await collectorBalance(tenant)).toBe(BigInt(BIKE_FEE));
  });

  it("refuses intake when the tenant has cash collection disabled", async () => {
    const tenant = await makeTenant({ disabled: true });
    await expect(service.recordIntake(baseInput(tenant))).rejects.toMatchObject({
      code: "cash_disabled",
    });
  });

  it("refuses intake when the day is already paid, writing nothing", async () => {
    const tenant = await makeTenant();
    await service.recordIntake({ ...baseInput(tenant), clientReference: "first" });
    const before = await collectorBalance(tenant);

    // A second intake regardless of reference would credit the wallet for a
    // settled day: refused, and nothing moves.
    await expect(
      service.recordIntake({ ...baseInput(tenant), clientReference: "second" }),
    ).rejects.toMatchObject({ code: "already_paid" });

    expect(await collectorBalance(tenant)).toBe(before);
  });

  it("refuses intake past the float ceiling and leaves the ledger untouched", async () => {
    const tenant = await makeTenant({ ceilingMinor: BIKE_FEE * 2 - 1 });
    const first = await service.recordIntake({ ...baseInput(tenant), clientReference: "ceil-1" });
    expect(first.balanceMinor).toBe(BigInt(BIKE_FEE));

    // A second bike whose cash would push the float over the ceiling.
    const secondBike = await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const owner = await repos.owners.create({
        tenantId: tenant.tenantId,
        displayName: "Driver 2",
        phone: "+2348000000002",
      });
      return repos.assets.create({
        tenantId: tenant.tenantId,
        zoneId: null,
        ownerId: owner.id,
        assetTypeKey: "bike",
        attributes: { plate_number: "KJA-EXTRA" },
        qrPayload: "cash-extra",
        qrToken: "cash-extra-token",
        shortCode: "C2",
        createdByUserId: null,
      });
    });

    await expect(
      service.recordIntake({
        tenantId: tenant.tenantId,
        collectorUserId: tenant.collectorUserId,
        assetId: secondBike.id,
        amount: money("NGN", BIKE_FEE),
        clientReference: "ceil-2",
      }),
    ).rejects.toMatchObject({ code: "ceiling_exceeded" });

    expect(await collectorBalance(tenant)).toBe(first.balanceMinor);
    const secondDay = await withTenant(db, tenant.tenantId, async (tx) =>
      repositories(tx).obligations.findByAssetAndPeriod(tenant.tenantId, secondBike.id, TODAY),
    );
    expect(secondDay).toBeUndefined();
  });
  it("refuses intake for a frozen wallet", async () => {
    const tenant = await makeTenant();
    await withTenant(db, tenant.tenantId, async (tx) =>
      repositories(tx).collectorCash.setWalletStatus(tenant.tenantId, tenant.collectorUserId, {
        status: "frozen",
        frozenReason: "shortfall",
      }),
    );

    await expect(service.recordIntake(baseInput(tenant))).rejects.toMatchObject({
      code: "wallet_frozen",
    });
  });

  it("refuses cash that does not match the exact fee", async () => {
    const tenant = await makeTenant();
    await expect(
      service.recordIntake({ ...baseInput(tenant), amount: money("NGN", BIKE_FEE - 1) }),
    ).rejects.toMatchObject({ code: "amount_mismatch" });
    await expect(
      service.recordIntake({ ...baseInput(tenant), amount: money("USD", BIKE_FEE) }),
    ).rejects.toMatchObject({ code: "amount_mismatch" });
  });

  it("refuses intake when no asset matches the reference", async () => {
    const tenant = await makeTenant();
    await expect(
      service.recordIntake({ ...baseInput(tenant), reference: "NOSUCH" }),
    ).rejects.toMatchObject({ code: "asset_unknown" });
    await expect(
      service.recordIntake({
        tenantId: tenant.tenantId,
        collectorUserId: tenant.collectorUserId,
        token: "not-a-sticker",
        amount: money("NGN", BIKE_FEE),
        clientReference: `cli-${Math.random().toString(36).slice(2, 10)}`,
      }),
    ).rejects.toMatchObject({ code: "asset_unknown" });
  });

  it("raises a typed CashError, not a plain error", async () => {
    const tenant = await makeTenant({ disabled: true });
    const error = await service.recordIntake(baseInput(tenant)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CashError);
  });
});
