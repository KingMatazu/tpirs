import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createDb, migrateUp, repositories, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import type { TenantConfig } from "@tpirs/config";
import { principal } from "@tpirs/domain";
import { createConfigFeeEngine } from "@tpirs/fee-engine-config";
import { createMockPaymentProvider } from "@tpirs/payment-provider-mock";
import { CollectorCashService } from "./collector-cash-service.js";
import { createCashDeadlineSweeper } from "./cash-deadline-sweeper.js";
import { createPaymentService } from "./payment-service.js";
import {
  assetAt,
  BIKE_FEE,
  CASH_NOW,
  deliverDeposit,
  intakeFor,
  makeCashTenant,
  provisionInstruction,
  readCashPosition,
} from "./test-support/cash-day.js";
import type { CashTenant } from "./test-support/cash-day.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../db/migrations");
const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

const HOUR_MS = 3_600_000;
/** The sweeper runs the morning after a collector missed an 8-hour deadline. */
const AFTER_DEADLINE = (): Date => new Date(Date.now() + 9 * HOUR_MS);

/**
 * Phase 7 acceptance check 2: "an intentional shortfall is flagged and freezes
 * the collector per config".
 *
 * The collector takes cash and never deposits it. One sweep past
 * `cashRules.depositDeadlineHours` records the shortfall once, freezes the
 * wallet when `freezeOnShortfall` says so, and the next intake is refused. With
 * the flag off the same sweep only flags, and the collector keeps working —
 * which is the whole point of putting the behaviour in config rather than code.
 */
describeIntegration("collector cash: a missed deadline flags and freezes per config", () => {
  let db: AnyDb;
  let service: CollectorCashService;
  let paymentService: ReturnType<typeof createPaymentService>;
  const configs = new Map<string, TenantConfig>();

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    const loadConfig = (id: string) => Promise.resolve(configs.get(id));
    const feeEngine = createConfigFeeEngine({ loadConfig });
    const provider = createMockPaymentProvider();
    service = new CollectorCashService({
      db,
      loadConfig,
      feeEngine,
      providerFor: (name) => (name === "mock" ? provider : undefined),
      now: () => CASH_NOW,
    });
    paymentService = createPaymentService({
      db,
      loadConfig,
      feeEngine,
      providerFor: (name) => (name === "mock" ? provider : undefined),
      now: () => CASH_NOW,
    });
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await db.destroy();
  });

  function sweeperAt(now: Date) {
    return createCashDeadlineSweeper({
      db,
      cash: service,
      tenants: async () => [...configs].map(([id, config]) => ({ id, config })),
      now: () => now,
    });
  }

  async function walletOf(tenant: CashTenant) {
    return withTenant(db, tenant.tenantId, async (tx) =>
      repositories(tx).collectorCash.findWallet(tenant.tenantId, tenant.collectorUserId),
    );
  }

  async function auditActions(tenant: CashTenant): Promise<string[]> {
    return withTenant(db, tenant.tenantId, async (tx) => {
      const entries = await repositories(tx).audit.list({ limit: 200 });
      return entries.map((entry) => entry.action);
    });
  }

  it("freezes the collector, refuses the next intake, and unfreezes only on finance approval", async () => {
    const tenant = await makeCashTenant(db, configs, {
      assetCount: 2,
      depositDeadlineHours: 8,
      freezeOnShortfall: true,
    });
    await service.recordIntake(intakeFor(tenant, assetAt(tenant, 0), "shortfall-1"));
    expect(await readCashPosition(db, tenant)).toMatchObject({
      balanceMinor: BigInt(BIKE_FEE),
      openIntakes: 1,
    });

    const sweep = await sweeperAt(AFTER_DEADLINE()).sweep();
    expect(sweep.flagged).toBeGreaterThanOrEqual(1);
    expect(sweep.frozen).toBeGreaterThanOrEqual(1);

    const wallet = await walletOf(tenant);
    expect(wallet?.status).toBe("frozen");
    expect(wallet?.overdueSince).not.toBeNull();
    // The freeze reason carries the tenant's deadline, not a hardcoded phrase.
    expect(wallet?.frozenReason).toContain("8h");

    // The notice and the freeze are both recorded, with the sweeper as actor.
    const actions = await auditActions(tenant);
    expect(actions).toContain("cash.wallet.overdue");
    expect(actions).toContain("cash.wallet.frozen");

    // A frozen collector cannot take more cash, in this or any asset.
    const before = await readCashPosition(db, tenant);
    await expect(
      service.recordIntake(intakeFor(tenant, assetAt(tenant, 1), "shortfall-2")),
    ).rejects.toMatchObject({ code: "wallet_frozen" });
    expect(await readCashPosition(db, tenant)).toMatchObject({
      balanceMinor: before.balanceMinor,
      intakeTotalMinor: before.intakeTotalMinor,
    });

    // Finance unfreezes with a reason; the cash is still outstanding, so the
    // flag is cleared for now and the next sweep will flag it again.
    await service.unfreeze({
      tenantId: tenant.tenantId,
      collectorUserId: tenant.collectorUserId,
      reason: "Collector is in hospital; deposit promised tomorrow",
      actor: principal({
        userId: tenant.financeUserId,
        tenantId: tenant.tenantId,
        displayName: "Finance",
        roles: ["finance_admin"],
        permissions: ["cash:unfreeze"],
      }),
    });
    const reopened = await service.recordIntake(
      intakeFor(tenant, assetAt(tenant, 1), "shortfall-3"),
    );
    expect(reopened.replayed).toBe(false);
    expect((await readCashPosition(db, tenant)).balanceMinor).toBe(BigInt(BIKE_FEE * 2));
  });

  it("only flags when the tenant left freezeOnShortfall off, and a deposit clears it", async () => {
    const tenant = await makeCashTenant(db, configs, {
      assetCount: 2,
      depositDeadlineHours: 8,
      freezeOnShortfall: false,
    });
    const reference = await provisionInstruction(db, service, tenant);
    await service.recordIntake(intakeFor(tenant, assetAt(tenant, 0), "flagged-1"));

    const sweep = await sweeperAt(AFTER_DEADLINE()).sweep();
    expect(sweep.flagged).toBeGreaterThanOrEqual(1);

    const flagged = await walletOf(tenant);
    expect(flagged?.status).toBe("active");
    expect(flagged?.overdueSince).not.toBeNull();
    expect(await auditActions(tenant)).toContain("cash.wallet.overdue");
    expect(await auditActions(tenant)).not.toContain("cash.wallet.frozen");

    // Flagged, not blocked: the collector may keep taking cash.
    await service.recordIntake(intakeFor(tenant, assetAt(tenant, 1), "flagged-2"));
    expect((await readCashPosition(db, tenant)).openIntakes).toBe(2);

    // Paying in clears the flag; the wallet returns to a clean state.
    for (let index = 0; index < 2; index += 1) {
      const webhook = await deliverDeposit(paymentService, {
        tenantId: tenant.tenantId,
        reference,
        amountMinor: BIKE_FEE,
      });
      expect(webhook.outcome).toBe("deposit_matched");
    }
    expect((await walletOf(tenant))?.overdueSince).toBeNull();
    const closed = await readCashPosition(db, tenant);
    expect(closed.balanceMinor).toBe(0n);
    expect(closed.openIntakes).toBe(0);
    expect(closed.debitsMinor).toBe(closed.creditsMinor);
  });
});
