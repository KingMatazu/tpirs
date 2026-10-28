import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createDb, migrateUp, repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";
import { businessDate, CashError, ForbiddenError, money, principal } from "@tpirs/domain";
import type { BusinessDate } from "@tpirs/domain";
import { createConfigFeeEngine } from "@tpirs/fee-engine-config";
import { createMockPaymentProvider, mockWebhookSignature } from "@tpirs/payment-provider-mock";
import type { PaymentProvider } from "@tpirs/ports";
import { createPaymentService } from "./payment-service.js";
import { CollectorCashService } from "./collector-cash-service.js";
import { createCashDeadlineSweeper } from "./cash-deadline-sweeper.js";
import { createVerificationService } from "./verification-service.js";

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
  options: {
    ceilingMinor?: number;
    disabled?: boolean;
    freezeOnShortfall?: boolean;
    depositDeadlineHours?: number;
  } = {},
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
      enabled: !options.disabled,
      floatCeilingMinor: options.ceilingMinor ?? 1_000_000,
      depositDeadlineHours: options.depositDeadlineHours ?? 8,
      freezeOnShortfall: options.freezeOnShortfall ?? true,
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
  let paymentService: ReturnType<typeof createPaymentService>;
  let provider: ReturnType<typeof createMockPaymentProvider>;
  const configs = new Map<string, TenantConfig>();

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    const loadConfig = (id: string) => Promise.resolve(configs.get(id));
    const feeEngine = createConfigFeeEngine({ loadConfig });
    service = new CollectorCashService({
      db,
      loadConfig,
      feeEngine,
      providerFor: (name) => (name === "mock" ? provider : undefined),
      now: () => new Date("2026-06-15T09:00:00Z"),
    });
    provider = createMockPaymentProvider();
    paymentService = createPaymentService({
      db,
      loadConfig,
      feeEngine,
      providerFor: (name): PaymentProvider | undefined => (name === "mock" ? provider : undefined),
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
    readonly financeUserId: string;
    readonly ownerPhone: string;
  }

  /** A fresh tenant with one bike asset and one collector, so no test shares a wallet. */
  async function makeTenant(
    options: {
      ceilingMinor?: number;
      disabled?: boolean;
      freezeOnShortfall?: boolean;
      depositDeadlineHours?: number;
    } = {},
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
      const finance = await repos.users.create({
        tenantId: tenant.id,
        username: `finance-${stamp}`,
        displayName: "Finance",
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
      return {
        tenantId: tenant.id,
        collectorId: collector.id,
        financeUserId: finance.id,
        ownerPhone: owner.phone,
      };
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
      financeUserId: created.financeUserId,
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

  // ------------------------------------------------- deposits (ADR 0032)

  /** Provisions a mock deposit instruction for the tenant's collector. */
  async function provisionInstruction(tenant: TenantFixture) {
    await service.provisionDepositInstruction({
      tenantId: tenant.tenantId,
      collectorUserId: tenant.collectorUserId,
      provider: "mock",
    });
    return withTenant(db, tenant.tenantId, async (tx) =>
      repositories(tx).collectorCash.findActiveInstructionForCollector(
        tenant.tenantId,
        tenant.collectorUserId,
        "mock",
      ),
    );
  }

  /**
   * Delivers one webhook as the gateway would, with a valid mock signature.
   * `eventId` pins the provider event so a test can replay the *same* transfer
   * (the deposit identity is the event, not the destination reference).
   */
  async function deliverDepositWebhook(
    tenantId: string,
    reference: string,
    body: { amount: number; currency?: string; status?: "success" | "failed" } = {
      amount: BIKE_FEE,
    },
    eventId?: string,
  ) {
    const endpointToken = await paymentService.provisionEndpoint({
      tenantId,
      provider: "mock",
    });
    const rawBody = JSON.stringify({
      providerEventId: eventId ?? `dep-${Math.random().toString(36).slice(2, 10)}`,
      providerReference: reference,
      amount: { amount: body.amount, currency: body.currency ?? "NGN" },
      status: body.status ?? "success",
      paidAt: "2026-06-15T12:00:00Z",
    });
    return paymentService.ingestWebhookEvent({
      provider: "mock",
      endpointToken,
      headers: { "x-signature": mockWebhookSignature(rawBody) },
      rawBody,
    });
  }

  /** Provisions an instruction, takes an intake, then delivers a deposit webhook. */
  async function depositFixture(
    options: {
      depositMinor?: number;
      disabled?: boolean;
      currency?: string;
      status?: "success" | "failed";
    } = {},
  ) {
    const tenant = await makeTenant(options);
    const instruction = await provisionInstruction(tenant);
    if (instruction === undefined) throw new Error("instruction not found");
    const intake = await service.recordIntake({ ...baseInput(tenant), clientReference: "cli-1" });
    const webhook = await deliverDepositWebhook(tenant.tenantId, instruction.reference, {
      amount: options.depositMinor ?? BIKE_FEE,
      ...(options.currency === undefined ? {} : { currency: options.currency }),
      ...(options.status === undefined ? {} : { status: options.status }),
    });
    const after = await withTenant(db, tenant.tenantId, async (tx) => {
      const repos = repositories(tx);
      const deposit =
        webhook.depositId === undefined
          ? undefined
          : await repos.collectorCash.findDepositById(tenant.tenantId, webhook.depositId);
      const allocations =
        webhook.depositId === undefined
          ? []
          : await repos.collectorCash.listDepositAllocations(tenant.tenantId, webhook.depositId);
      const intakeRow = await repos.collectorCash.findIntakeById(tenant.tenantId, intake.intakeId);
      return {
        deposit,
        allocations,
        intakeRow,
        settlement: await repos.ledger.accountBalance(tenant.tenantId, "SETTLEMENT_BANK"),
        balance: await repos.ledger.collectorCashBalance(tenant.tenantId, tenant.collectorUserId),
      };
    });
    return { tenant, instruction, intake, webhook, ...after };
  }

  it("provisions a deposit instruction from the adapter and rotates it", async () => {
    const tenant = await makeTenant();
    const first = await service.provisionDepositInstruction({
      tenantId: tenant.tenantId,
      collectorUserId: tenant.collectorUserId,
      provider: "mock",
    });
    expect(first.kind).toBe("narration");
    expect(first.reference).toMatch(/^cash-dep-/);

    const second = await service.provisionDepositInstruction({
      tenantId: tenant.tenantId,
      collectorUserId: tenant.collectorUserId,
      provider: "mock",
    });
    expect(second.id).not.toBe(first.id);
    const active = await withTenant(db, tenant.tenantId, async (tx) =>
      repositories(tx).collectorCash.findActiveInstructionForCollector(
        tenant.tenantId,
        tenant.collectorUserId,
        "mock",
      ),
    );
    expect(active?.id).toBe(second.id);
  });

  it("matches a deposit webhook, clears the float and covers the intake", async () => {
    const fixture = await depositFixture();

    // The delivery is attributed to the deposit instruction before any payment
    // lookup, so it can never apply to the asset (ADR 0032).
    expect(fixture.webhook.outcome).toBe("deposit_matched");
    expect(fixture.webhook.accepted).toBe(true);
    expect(fixture.deposit?.status).toBe("matched");
    expect(fixture.allocations).toHaveLength(1);
    expect(fixture.allocations[0]?.amountMinor).toBe(BigInt(BIKE_FEE));
    expect(fixture.intakeRow?.status).toBe("matched");
    expect(fixture.balance).toBe(0n); // float cleared exactly

    const framework = await withTenant(db, fixture.tenant.tenantId, async (tx) =>
      repositories(tx).ledger.accountBalance(fixture.tenant.tenantId, "SETTLEMENT_BANK"),
    );
    // Credit-positive convention: the bank took in money, so it is negative.
    expect(framework).toBe(0n - BigInt(BIKE_FEE));
  });

  it("answers a replayed deposit webhook with the recorded outcome and no change", async () => {
    const tenant = await makeTenant();
    const instruction = await provisionInstruction(tenant);
    if (instruction === undefined) throw new Error("instruction not found");
    await service.recordIntake({ ...baseInput(tenant), clientReference: "cli-1" });
    const eventId = `dep-replay-${Math.random().toString(36).slice(2, 8)}`;
    const first = await deliverDepositWebhook(
      tenant.tenantId,
      instruction.reference,
      { amount: BIKE_FEE },
      eventId,
    );
    expect(first.outcome).toBe("deposit_matched");

    // The same transfer delivered twice: `webhook_events` answers duplicate and
    // nothing else happens.
    const second = await deliverDepositWebhook(
      tenant.tenantId,
      instruction.reference,
      { amount: BIKE_FEE },
      eventId,
    );
    expect(second.outcome).toBe("duplicate");
    const after = await withTenant(db, tenant.tenantId, async (tx) => {
      const repos = repositories(tx);
      return {
        deposits: (await repos.collectorCash.listDeposits(tenant.tenantId, { limit: 100 })).rows
          .length,
        balance: await repos.ledger.collectorCashBalance(tenant.tenantId, tenant.collectorUserId),
      };
    });
    expect(after.deposits).toBe(1);
    expect(after.balance).toBe(0n);
  });

  it("records a second transfer to the same destination as its own deposit", async () => {
    const tenant = await makeTenant();
    const instruction = await provisionInstruction(tenant);
    if (instruction === undefined) throw new Error("instruction not found");
    await service.recordIntake({ ...baseInput(tenant), clientReference: "cli-two-1" });

    // The destination reference is long-lived: an evening deposit every day uses
    // the same value, and only the provider event distinguishes the transfers
    // (migration 0013).
    const first = await deliverDepositWebhook(tenant.tenantId, instruction.reference);
    expect(first.outcome).toBe("deposit_matched");
    const second = await deliverDepositWebhook(tenant.tenantId, instruction.reference);
    // Nothing is open for the second transfer, so it waits in suspense (D35).
    expect(second.outcome).toBe("deposit_suspense");

    const after = await withTenant(db, tenant.tenantId, async (tx) => {
      const repos = repositories(tx);
      const rows = (await repos.collectorCash.listDeposits(tenant.tenantId, { limit: 100 })).rows;
      return {
        deposits: rows.length,
        statuses: rows.map((row) => row.status),
        balance: await repos.ledger.collectorCashBalance(tenant.tenantId, tenant.collectorUserId),
      };
    });
    expect(after.deposits).toBe(2);
    expect(after.statuses).toContain("matched");
    expect(after.statuses).toContain("suspense");
    expect(after.balance).toBe(0n);
  });

  it("keeps an over-deposit in suspense with the exact surplus visible", async () => {
    const fixture = await depositFixture({ depositMinor: BIKE_FEE + 5_000 });

    // D35: an over-deposit posts nothing; it waits until an intake covers it,
    // so the day-close arithmetic counts intake and deposits separately.
    expect(fixture.webhook.outcome).toBe("deposit_suspense");
    expect(fixture.deposit?.status).toBe("suspense");
    expect(fixture.allocations).toHaveLength(0);
    expect(fixture.intakeRow?.status).toBe("open");
    expect(fixture.balance).toBe(BigInt(BIKE_FEE));
  });

  it("covers a larger float when several intakes precede the deposit", async () => {
    // Two bikes, two intakes, one deposit that covers both exactly.
    const tenant = await makeTenant({ ceilingMinor: BIKE_FEE * 2 });
    const instruction = await provisionInstruction(tenant);
    if (instruction === undefined) throw new Error("instruction not found");
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
        attributes: { plate_number: "KJA-TWO" },
        qrPayload: "cash-two",
        qrToken: "cash-two-token",
        shortCode: "C2",
        createdByUserId: null,
      });
    });
    await service.recordIntake({ ...baseInput(tenant), clientReference: "cli-a" });
    await service.recordIntake({
      tenantId: tenant.tenantId,
      collectorUserId: tenant.collectorUserId,
      assetId: secondBike.id,
      amount: money("NGN", BIKE_FEE),
      clientReference: "cli-b",
    });

    const webhook = await deliverDepositWebhook(tenant.tenantId, instruction.reference, {
      amount: BIKE_FEE * 2,
    });
    expect(webhook.outcome).toBe("deposit_matched");
    const after = await withTenant(db, tenant.tenantId, async (tx) => {
      const repos = repositories(tx);
      return {
        balance: await repos.ledger.collectorCashBalance(tenant.tenantId, tenant.collectorUserId),
        intakes: (
          await repos.collectorCash.openIntakesForCollector(tenant.tenantId, tenant.collectorUserId)
        ).length,
      };
    });
    expect(after.balance).toBe(0n);
    expect(after.intakes).toBe(0);
  });

  it("matches a suspense deposit manually, posting just what the intake takes", async () => {
    const fixture = await depositFixture({ depositMinor: BIKE_FEE + 5_000 });
    expect(fixture.deposit?.status).toBe("suspense");

    const matched = await service.matchDeposit({
      tenantId: fixture.tenant.tenantId,
      depositId: fixture.webhook.depositId ?? "",
      intakeId: fixture.intake.intakeId,
      approvedByUserId: fixture.tenant.financeUserId,
    });
    expect(matched.outcome).toBe("partial"); // 5,000 of the deposit stays unposted
    expect(fixture.balance).toBe(BigInt(BIKE_FEE));

    const after = await withTenant(db, fixture.tenant.tenantId, async (tx) => {
      const repos = repositories(tx);
      const updated = await repos.collectorCash.findDepositById(
        fixture.tenant.tenantId,
        matched.depositId,
      );
      const intakeRow = await repos.collectorCash.findIntakeById(
        fixture.tenant.tenantId,
        fixture.intake.intakeId,
      );
      return {
        status: updated?.status,
        intakeStatus: intakeRow?.status,
        balance: await repos.ledger.collectorCashBalance(
          fixture.tenant.tenantId,
          fixture.tenant.collectorUserId,
        ),
      };
    });
    expect(after.status).toBe("partial");
    expect(after.intakeStatus).toBe("matched");
    expect(after.balance).toBe(0n); // intake fully covered by the posted part

    // The identical manual match is a no-op, not a second posting.
    const replay = await service.matchDeposit({
      tenantId: fixture.tenant.tenantId,
      depositId: matched.depositId,
      intakeId: fixture.intake.intakeId,
      approvedByUserId: fixture.tenant.financeUserId,
    });
    expect(replay.replayed).toBe(true);
    const settled = await withTenant(db, fixture.tenant.tenantId, async (tx) =>
      repositories(tx).ledger.collectorCashBalance(
        fixture.tenant.tenantId,
        fixture.tenant.collectorUserId,
      ),
    );
    expect(settled).toBe(0n);
  });

  it("refuses a cross-tenant deposit match as an unknown deposit", async () => {
    const other = await makeTenant(); // different tenant entirely
    const fixture = await depositFixture({ depositMinor: BIKE_FEE + 5_000 });
    await expect(
      service.matchDeposit({
        tenantId: other.tenantId,
        depositId: fixture.webhook.depositId ?? "",
        intakeId: other.assetId,
        approvedByUserId: other.financeUserId,
      }),
    ).rejects.toMatchObject({ code: "deposit_unknown" });
  });

  it("prices a mismatched currency into suspense instead of posting it", async () => {
    const fixture = await depositFixture({ currency: "USD" });
    expect(fixture.webhook.outcome).toBe("deposit_suspense");
    expect(fixture.deposit?.status).toBe("suspense");
    expect(fixture.balance).toBe(BigInt(BIKE_FEE));
  });

  // ----------------------------------------- freeze and unfreeze (ADR 0033)

  /**
   * A zone supervisor as the API would build it: a real user row (the audit
   * entry has a foreign key) holding `cash:freeze` and not `cash:unfreeze`.
   */
  function supervisor(tenant: TenantFixture) {
    return principal({
      userId: tenant.financeUserId,
      tenantId: tenant.tenantId,
      displayName: "Supervisor",
      roles: ["zone_supervisor"],
      permissions: ["cash:read", "cash:freeze", "cash:intake"],
    });
  }

  function financeActor(tenant: TenantFixture) {
    return principal({
      userId: tenant.financeUserId,
      tenantId: tenant.tenantId,
      displayName: "Finance",
      roles: ["finance_admin"],
      permissions: ["cash:read", "cash:freeze", "cash:unfreeze", "cash:deposit:match"],
    });
  }

  function collectorActor(tenant: TenantFixture) {
    return principal({
      userId: tenant.collectorUserId,
      tenantId: tenant.tenantId,
      displayName: "Collector",
      roles: ["collector"],
      permissions: ["cash:read", "cash:intake"],
    });
  }

  /** The wallet row as it stands now, straight from the database. */
  async function walletOf(tenant: TenantFixture) {
    return withTenant(db, tenant.tenantId, async (tx) =>
      repositories(tx).collectorCash.findWallet(tenant.tenantId, tenant.collectorUserId),
    );
  }

  async function auditFor(tenant: TenantFixture, action: string, entityId?: string) {
    return withTenant(db, tenant.tenantId, async (tx) =>
      repositories(tx).audit.search({
        action,
        limit: 20,
        ...(entityId === undefined ? {} : { entityId }),
      }),
    );
  }

  it("freezes with a reason, audits the actor and reports the derived position", async () => {
    const tenant = await makeTenant();
    await service.recordIntake(baseInput(tenant));

    const view = await service.freeze({
      tenantId: tenant.tenantId,
      collectorUserId: tenant.collectorUserId,
      reason: "cash not deposited by the deadline",
      actor: supervisor(tenant),
    });

    expect(view.status).toBe("frozen");
    expect(view.frozenReason).toBe("cash not deposited by the deadline");
    expect(view.frozenAt).toBeInstanceOf(Date);
    expect(view.balanceMinor).toBe(BigInt(BIKE_FEE));
    expect(view.openIntakeTotalMinor).toBe(BigInt(BIKE_FEE));

    const wallet = await walletOf(tenant);
    const audited = await auditFor(tenant, "cash.wallet.frozen", wallet?.id);
    expect(audited).toHaveLength(1);
    expect(audited[0]?.actorUserId).toBe(tenant.financeUserId);
  });

  it("refuses a collector freezing their own wallet", async () => {
    const tenant = await makeTenant();
    await expect(
      service.freeze({
        tenantId: tenant.tenantId,
        collectorUserId: tenant.collectorUserId,
        reason: "let me back in",
        actor: collectorActor(tenant),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await walletOf(tenant))?.status).not.toBe("frozen");
  });

  it("refuses a freeze with no reason", async () => {
    const tenant = await makeTenant();
    await expect(
      service.freeze({
        tenantId: tenant.tenantId,
        collectorUserId: tenant.collectorUserId,
        reason: "   ",
        actor: supervisor(tenant),
      }),
    ).rejects.toMatchObject({ code: "reason_required" });
  });

  it("treats a repeated freeze as a no-op, without a second audit entry", async () => {
    const tenant = await makeTenant();
    const first = await service.freeze({
      tenantId: tenant.tenantId,
      collectorUserId: tenant.collectorUserId,
      reason: "missed deadline",
      actor: supervisor(tenant),
    });
    const second = await service.freeze({
      tenantId: tenant.tenantId,
      collectorUserId: tenant.collectorUserId,
      reason: "missed deadline, again",
      actor: supervisor(tenant),
    });

    expect(second.status).toBe("frozen");
    expect(second.frozenAt?.toISOString()).toBe(first.frozenAt?.toISOString());
    expect(second.frozenReason).toBe("missed deadline");
    expect(await auditFor(tenant, "cash.wallet.frozen")).toHaveLength(1);
  });

  it("keeps unfreeze finance-only and clears the overdue flag", async () => {
    const tenant = await makeTenant();
    await service.freeze({
      tenantId: tenant.tenantId,
      collectorUserId: tenant.collectorUserId,
      reason: "missed deadline",
      actor: supervisor(tenant),
    });
    await withTenant(db, tenant.tenantId, async (tx) =>
      repositories(tx).collectorCash.markOverdue(
        tenant.tenantId,
        tenant.collectorUserId,
        new Date("2026-06-16T09:00:00Z"),
      ),
    );

    await expect(
      service.unfreeze({
        tenantId: tenant.tenantId,
        collectorUserId: tenant.collectorUserId,
        reason: "deposit confirmed at the bank",
        actor: supervisor(tenant),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const view = await service.unfreeze({
      tenantId: tenant.tenantId,
      collectorUserId: tenant.collectorUserId,
      reason: "deposit confirmed at the bank",
      actor: financeActor(tenant),
    });
    expect(view.status).toBe("active");
    expect(view.frozenReason).toBeNull();
    expect(view.overdueSince).toBeNull();
    expect(await auditFor(tenant, "cash.wallet.unfrozen")).toHaveLength(1);
  });

  it("refuses the next intake while frozen and keeps verification working", async () => {
    const tenant = await makeTenant();
    await service.recordIntake(baseInput(tenant));
    await service.freeze({
      tenantId: tenant.tenantId,
      collectorUserId: tenant.collectorUserId,
      reason: "missed deadline",
      actor: supervisor(tenant),
    });

    // The intake is refused with the code the API turns into 409.
    await expect(service.recordIntake(baseInput(tenant))).rejects.toMatchObject({
      code: "wallet_frozen",
    });

    // Freezing a collector's wallet is not a statement about the vehicles whose
    // cash they took: the day stays paid (ADR 0033).
    const verification = createVerificationService({
      db,
      loadConfig: (id) => Promise.resolve(configs.get(id)),
      now: () => new Date("2026-06-15T09:00:00Z"),
    });
    const status = await verification.statusForAsset(tenant.tenantId, tenant.assetId);
    expect(status.paymentStatus).toBe("paid");
  });

  // ----------------------------------- deposit deadline sweeper (ADR 0033)

  const HOUR_MS = 3_600_000;

  /**
   * The sweeper at a chosen instant, examining only this file's tenants.
   *
   * The production sweeper reads every tenant in one system transaction; the
   * test injects the `configs` map so a shared database's other tenants (and
   * runs from previous sessions) cannot leak into the summary.
   */
  function sweeperAt(now: Date) {
    return createCashDeadlineSweeper({
      db,
      cash: service,
      tenants: async () => [...configs].map(([id, config]) => ({ id, config })),
      now: () => now,
    });
  }

  it("leaves a collector alone until the deadline passes", async () => {
    const tenant = await makeTenant({ freezeOnShortfall: false });
    await service.recordIntake(baseInput(tenant));

    const summary = await sweeperAt(new Date()).sweep();

    expect(summary.flagged).toBe(0);
    expect(summary.frozen).toBe(0);
    expect((await walletOf(tenant))?.overdueSince).toBeNull();
    expect(await auditFor(tenant, "cash.wallet.overdue")).toHaveLength(0);
  });

  it("flags an overdue collector once, without freezing when the tenant said so", async () => {
    const tenant = await makeTenant({ freezeOnShortfall: false });
    await service.recordIntake(baseInput(tenant));
    const afterDeadline = new Date(Date.now() + 9 * HOUR_MS);

    const first = await sweeperAt(afterDeadline).sweep();
    expect(first.flagged).toBeGreaterThan(0);

    const wallet = await walletOf(tenant);
    expect(wallet?.status).toBe("active");
    expect(wallet?.overdueSince).not.toBeNull();
    const audited = await auditFor(tenant, "cash.wallet.overdue", wallet?.id);
    expect(audited).toHaveLength(1);
    expect(audited[0]?.actorUserId).toBeNull();

    // The same sweep again: one notice per deadline window.
    const second = await sweeperAt(afterDeadline).sweep();
    expect(second.flagged).toBe(0);
    expect(await auditFor(tenant, "cash.wallet.overdue", wallet?.id)).toHaveLength(1);
  });

  it("freezes an overdue collector when the tenant asks for it", async () => {
    const tenant = await makeTenant({ freezeOnShortfall: true });
    await service.recordIntake(baseInput(tenant));

    const summary = await sweeperAt(new Date(Date.now() + 9 * HOUR_MS)).sweep();
    expect(summary.frozen).toBeGreaterThan(0);

    const wallet = await walletOf(tenant);
    expect(wallet?.status).toBe("frozen");
    expect(wallet?.overdueSince).not.toBeNull();
    expect(wallet?.frozenReason).toContain("8h");

    const audited = await auditFor(tenant, "cash.wallet.frozen", wallet?.id);
    expect(audited).toHaveLength(1);
    expect(audited[0]?.actorUserId).toBeNull();
  });

  it("clears the overdue flag once a deposit covers every intake", async () => {
    const tenant = await makeTenant({ freezeOnShortfall: false });
    const instruction = await provisionInstruction(tenant);
    if (instruction === undefined) throw new Error("instruction not found");
    await service.recordIntake(baseInput(tenant));
    await withTenant(db, tenant.tenantId, async (tx) =>
      repositories(tx).collectorCash.markOverdue(
        tenant.tenantId,
        tenant.collectorUserId,
        new Date("2026-06-16T09:00:00Z"),
      ),
    );
    expect((await walletOf(tenant))?.overdueSince).not.toBeNull();

    const webhook = await deliverDepositWebhook(tenant.tenantId, instruction.reference);
    expect(webhook.outcome).toBe("deposit_matched");
    expect((await walletOf(tenant))?.overdueSince).toBeNull();
  });
});
