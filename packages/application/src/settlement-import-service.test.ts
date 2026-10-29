import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import type { AnyDb } from "@tpirs/db";
import { createDb, migrateUp, repositories, withTenant } from "@tpirs/db";
import type { TenantConfig } from "@tpirs/config";
import { ForbiddenError } from "@tpirs/domain";
import { createMockSettlementImport } from "@tpirs/settlement-import-mock";
import type { ImportedSettlementRow, SettlementImport } from "@tpirs/ports";
import { createSettlementImportService } from "./settlement-import-service.js";
import {
  assetAt,
  makeCashTenant,
  provisionInstruction,
  deliverDeposit,
} from "./test-support/cash-day.js";
import {
  auditorActor,
  financeActor,
  payLevyDay,
  RECON_DAY,
  RECON_MAPPING,
  statementContent,
  statementRow,
  wirePhase8Services,
} from "./test-support/recon.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../db/migrations");
const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

/**
 * Phase 8 settlement intake (D21, D45; ADR 0035/0036): a statement row is
 * evidence that posts only when it truly matches a payment, and only then does
 * the gateway's cut become a ledger cost. Duplicate bytes change nothing.
 */
describeIntegration("settlement import (integration)", () => {
  let db: AnyDb;
  const configs = new Map<string, TenantConfig>();
  let services: ReturnType<typeof wirePhase8Services>;

  const makeService = (
    rows: ImportedSettlementRow[],
  ): ReturnType<typeof createSettlementImportService> => {
    const adapter: SettlementImport = createMockSettlementImport({ rows });
    return createSettlementImportService({ db, settlementImport: adapter });
  };

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    services = wirePhase8Services(db, configs);
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await db.destroy();
  });

  it("posts the fee leg of a matched row and drains the clearing account", async () => {
    const tenant = await makeCashTenant(db, configs);
    const reference = await payLevyDay(services.paymentService, {
      tenantId: tenant.tenantId,
      assetId: assetAt(tenant, 0).assetId,
      businessDate: RECON_DAY,
    });

    // Before settlement the payment itself sits in clearing (credit-positive
    // balances: a debit subtracts).
    const before = await withTenant(db, tenant.tenantId, async (tx) =>
      repositories(tx).ledger.accountBalance(tenant.tenantId, "GATEWAY_CLEARING"),
    );
    expect(before).toBe(0n - BigInt(20_000));

    const service = makeService([
      statementRow({ reference, amountMinor: 20_000, feeMinor: 300, marker: "fee-leg" }),
    ]);
    const summary = await service.importStatement({
      tenantId: tenant.tenantId,
      provider: "mock",
      filename: "statement.csv",
      content: statementContent("fee-leg"),
      mapping: RECON_MAPPING,
      defaultCurrency: "NGN",
      feeToleranceMinor: 1_000n,
      actor: financeActor(tenant),
    });

    expect(summary.outcome).toBe("imported");
    expect(summary.rowCount).toBe(1);
    expect(summary.postedCount).toBe(1);
    expect(summary.unmatchedCount).toBe(0);
    expect(summary.skipped).toEqual([]);

    // Dr SETTLEMENT_BANK 19,700 + Dr GATEWAY_FEES 300 / Cr GATEWAY_CLEARING 20,000.
    const balances = await withTenant(db, tenant.tenantId, async (tx) => {
      const repos = repositories(tx);
      return {
        bank: await repos.ledger.accountBalance(tenant.tenantId, "SETTLEMENT_BANK"),
        fees: await repos.ledger.accountBalance(tenant.tenantId, "GATEWAY_FEES"),
        clearing: await repos.ledger.accountBalance(tenant.tenantId, "GATEWAY_CLEARING"),
        row: (await repos.settlements.list(tenant.tenantId, {})).at(0),
      };
    });
    expect(balances.bank).toBe(0n - BigInt(19_700));
    expect(balances.fees).toBe(0n - BigInt(300));
    expect(balances.clearing).toBe(0n);
    expect(balances.row?.status).toBe("posted");
    expect(balances.row?.transactionId).not.toBeNull();
  });

  it("treats a re-upload of the same bytes as a no-op", async () => {
    const tenant = await makeCashTenant(db, configs);
    const reference = await payLevyDay(services.paymentService, {
      tenantId: tenant.tenantId,
      assetId: assetAt(tenant, 0).assetId,
      businessDate: RECON_DAY,
    });
    const rows = [statementRow({ reference, amountMinor: 20_000, feeMinor: 0, marker: "replay" })];
    const adapter: SettlementImport = createMockSettlementImport({ rows });
    const service = createSettlementImportService({ db, settlementImport: adapter });
    const input = {
      tenantId: tenant.tenantId,
      provider: "mock",
      filename: "statement.csv",
      content: statementContent("replay"),
      mapping: RECON_MAPPING,
      defaultCurrency: "NGN",
      feeToleranceMinor: 1_000n,
      actor: financeActor(tenant),
    };

    const first = await service.importStatement(input);
    expect(first.outcome).toBe("imported");

    const second = await service.importStatement(input);
    expect(second.outcome).toBe("duplicate");
    expect(second.postedCount).toBe(0);
    expect(second.unmatchedCount).toBe(0);

    // No second import, no second posting, clearing stays drained to zero.
    const after = await withTenant(db, tenant.tenantId, async (tx) => {
      const repos = repositories(tx);
      return {
        clearing: await repos.ledger.accountBalance(tenant.tenantId, "GATEWAY_CLEARING"),
        rows: await repos.settlements.list(tenant.tenantId, {}),
      };
    });
    expect(after.clearing).toBe(0n);
    expect(after.rows).toHaveLength(1);
  });

  it("leaves rows it cannot post honestly unmatched, with a reason each", async () => {
    const tenant = await makeCashTenant(db, configs, { assetCount: 2 });
    const overRef = await payLevyDay(services.paymentService, {
      tenantId: tenant.tenantId,
      assetId: assetAt(tenant, 0).assetId,
      businessDate: RECON_DAY,
    });
    const gapRef = await payLevyDay(services.paymentService, {
      tenantId: tenant.tenantId,
      assetId: assetAt(tenant, 1).assetId,
      businessDate: RECON_DAY,
    });

    const service = makeService([
      // The bank received more than was charged: that is not a fee.
      statementRow({ reference: overRef, amountMinor: 21_000, feeMinor: 0, marker: "over" }),
      // The gateway kept more than the tolerance allows.
      statementRow({ reference: gapRef, amountMinor: 20_000, feeMinor: 3_000, marker: "gap" }),
      // A reference no payment ever carried.
      statementRow({ reference: "ghost-ref", amountMinor: 5_000, feeMinor: 0, marker: "ghost" }),
    ]);
    const summary = await service.importStatement({
      tenantId: tenant.tenantId,
      provider: "mock",
      filename: "statement.csv",
      content: statementContent("mixed"),
      mapping: RECON_MAPPING,
      defaultCurrency: "NGN",
      feeToleranceMinor: 1_000n,
      actor: financeActor(tenant),
    });

    expect(summary.outcome).toBe("imported");
    expect(summary.postedCount).toBe(0);
    expect(summary.unmatchedCount).toBe(3);
    const reasons = new Map(summary.skipped.map((skip) => [skip.providerReference, skip.reason]));
    expect(reasons.get(overRef)).toBe("over_settlement");
    expect(reasons.get(gapRef)).toBe("fee_beyond_tolerance");
    expect(reasons.get("ghost-ref")).toBe("no_unique_payment");

    const rows = await withTenant(db, tenant.tenantId, async (tx) =>
      repositories(tx).settlements.list(tenant.tenantId, {}),
    );
    expect(rows.every((row) => row.status === "unmatched")).toBe(true);
    // Nothing was posted, so clearing still holds both payments' money.
    const clearing = await withTenant(db, tenant.tenantId, async (tx) =>
      repositories(tx).ledger.accountBalance(tenant.tenantId, "GATEWAY_CLEARING"),
    );
    expect(clearing).toBe(0n - BigInt(40_000));
  });

  it("an auditor cannot import a statement", async () => {
    const tenant = await makeCashTenant(db, configs);
    const service = makeService([]);
    await expect(
      service.importStatement({
        tenantId: tenant.tenantId,
        provider: "mock",
        filename: "statement.csv",
        content: statementContent("auditor"),
        mapping: RECON_MAPPING,
        defaultCurrency: "NGN",
        feeToleranceMinor: 1_000n,
        actor: auditorActor(tenant),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a suspense deposit is unaffected: settlement only touches gateway money", async () => {
    const tenant = await makeCashTenant(db, configs);
    const reference = await provisionInstruction(db, services.cashService, tenant);
    // A deposit that matches no open intake goes to suspense; the settlement
    // pipeline below must not see or move it.
    const deposit = await deliverDeposit(services.paymentService, {
      tenantId: tenant.tenantId,
      reference,
      amountMinor: 7_777,
    });
    expect(deposit.outcome).toBe("deposit_suspense");

    const service = makeService([
      statementRow({
        reference: "no-such-payment",
        amountMinor: 7_777,
        feeMinor: 0,
        marker: "cash",
      }),
    ]);
    const summary = await service.importStatement({
      tenantId: tenant.tenantId,
      provider: "mock",
      filename: "statement.csv",
      content: statementContent("cash"),
      mapping: RECON_MAPPING,
      defaultCurrency: "NGN",
      feeToleranceMinor: 1_000n,
      actor: financeActor(tenant),
    });
    expect(summary.postedCount).toBe(0);
  });
});
