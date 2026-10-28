import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createDb, migrateUp, repositories, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import type { TenantConfig } from "@tpirs/config";
import { createConfigFeeEngine } from "@tpirs/fee-engine-config";
import { createMockPaymentProvider } from "@tpirs/payment-provider-mock";
import { CollectorCashService } from "./collector-cash-service.js";
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

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../db/migrations");
const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

/**
 * Phase 7 acceptance check 1: "a simulated day reconciles to zero".
 *
 * Three bikes take cash from one collector in the morning; three deposits land
 * in the settlement bank during the day. At close the collector holds nothing:
 * intake minus posted deposits equals the derived `COLLECTOR_CASH` balance (all
 * zero), every intake is matched, and the tenant's ledger still balances. This is
 * the arithmetic a finance user signs off, so it is asserted as an identity
 * rather than as a set of individual postings.
 */
describeIntegration("collector cash: one simulated day closes to zero (integration)", () => {
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

  it("takes three intakes, matches three deposits, and leaves nothing held", async () => {
    const tenant = await makeCashTenant(db, configs, {
      assetCount: 3,
      ceilingMinor: BIKE_FEE * 3,
    });
    const reference = await provisionInstruction(db, service, tenant);

    // Morning: the collector takes today's fee for three bikes.
    const intakes = [];
    for (const [index, asset] of tenant.assets.entries()) {
      intakes.push(
        await service.recordIntake(intakeFor(tenant, asset, `day-close-${String(index + 1)}`)),
      );
    }

    const open = await readCashPosition(db, tenant);
    expect(open.balanceMinor).toBe(BigInt(BIKE_FEE * 3));
    expect(open.openIntakes).toBe(3);
    expect(open.openIntakeTotalMinor).toBe(BigInt(BIKE_FEE * 3));
    expect(open.postedDepositTotalMinor).toBe(0n);

    // Evening: three deposits reach the collector's dedicated destination, one
    // per intake. Each webhook clears the oldest open intake.
    for (let index = 0; index < 3; index += 1) {
      const webhook = await deliverDeposit(paymentService, {
        tenantId: tenant.tenantId,
        reference,
        amountMinor: BIKE_FEE,
      });
      expect(webhook.outcome).toBe("deposit_matched");
      expect(webhook.accepted).toBe(true);
    }

    const closed = await readCashPosition(db, tenant);
    // The day-close identity: what was taken minus what was handed over is the
    // float still held — here, nothing.
    expect(closed.intakeTotalMinor - closed.postedDepositTotalMinor).toBe(closed.balanceMinor);
    expect(closed.balanceMinor).toBe(0n);
    expect(closed.openIntakes).toBe(0);
    expect(closed.openIntakeTotalMinor).toBe(0n);
    expect(closed.postedDepositTotalMinor).toBe(BigInt(BIKE_FEE * 3));
    expect(closed.suspenseDeposits).toBe(0);

    // Append-only truth still balances, and the money landed where it should:
    // revenue recognised, settlement bank credit-positive negative.
    expect(closed.debitsMinor).toBe(closed.creditsMinor);
    const accounts = await withTenant(db, tenant.tenantId, async (tx) => {
      const repos = repositories(tx);
      return {
        revenue: await repos.ledger.accountBalance(tenant.tenantId, "REVENUE_LEVY"),
        settlement: await repos.ledger.accountBalance(tenant.tenantId, "SETTLEMENT_BANK"),
        deposits: await repos.collectorCash.listDeposits(tenant.tenantId, {
          collectorUserId: tenant.collectorUserId,
          limit: 50,
        }),
        intakeRows: await repos.collectorCash.listIntakes(tenant.tenantId, {
          collectorUserId: tenant.collectorUserId,
          limit: 50,
        }),
      };
    });
    expect(accounts.revenue).toBe(BigInt(BIKE_FEE * 3));
    expect(accounts.settlement).toBe(0n - BigInt(BIKE_FEE * 3));
    expect(accounts.deposits.rows.every((row) => row.status === "matched")).toBe(true);
    expect(accounts.intakeRows.rows.every((row) => row.status === "matched")).toBe(true);
    // Every intake settled the day it was taken, through the ordinary path.
    expect(accounts.intakeRows.rows.map((row) => row.businessDate)).toEqual(
      intakes.map((intake) => intake.businessDate),
    );
  });

  it("keeps the day reconciled when one deposit arrives before all the cash is taken", async () => {
    const tenant = await makeCashTenant(db, configs, { assetCount: 2 });
    const reference = await provisionInstruction(db, service, tenant);

    await service.recordIntake(intakeFor(tenant, assetAt(tenant, 0), "partial-day-1"));
    const firstDeposit = await deliverDeposit(paymentService, {
      tenantId: tenant.tenantId,
      reference,
      amountMinor: BIKE_FEE,
    });
    expect(firstDeposit.outcome).toBe("deposit_matched");

    // The next intake starts a fresh float rather than reusing the cleared one.
    await service.recordIntake(intakeFor(tenant, assetAt(tenant, 1), "partial-day-2"));
    const midday = await readCashPosition(db, tenant);
    expect(midday.balanceMinor).toBe(BigInt(BIKE_FEE));
    expect(midday.openIntakes).toBe(1);

    await deliverDeposit(paymentService, {
      tenantId: tenant.tenantId,
      reference,
      amountMinor: BIKE_FEE,
    });
    const close = await readCashPosition(db, tenant);
    expect(close.intakeTotalMinor - close.postedDepositTotalMinor).toBe(close.balanceMinor);
    expect(close.balanceMinor).toBe(0n);
    expect(close.debitsMinor).toBe(close.creditsMinor);
  });
});
