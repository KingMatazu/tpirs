import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import type { AnyDb } from "@tpirs/db";
import { createDb, migrateUp } from "@tpirs/db";
import type { TenantConfig } from "@tpirs/config";
import { ForbiddenError } from "@tpirs/domain";
import { createMockSettlementImport } from "@tpirs/settlement-import-mock";
import { createSettlementImportService } from "./settlement-import-service.js";
import { ReconciliationRunError, ReconciliationService } from "./reconciliation-service.js";
import type { ReconciliationTolerances } from "./reconciliation-service.js";
import { ExceptionService } from "./exception-service.js";
import type { CashTenant } from "./test-support/cash-day.js";
import { assetAt, intakeFor, makeCashTenant } from "./test-support/cash-day.js";
import {
  auditorActor,
  backdateIntake,
  financeActor,
  insertDuplicatePayment,
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

const TOLERANCES: ReconciliationTolerances = {
  toleranceMinor: 0n,
  feeToleranceMinor: 1_000n,
  depositDeadlineHours: 8,
  suspenseAgeingDays: 7,
};

/**
 * Phase 8 reconciliation runs (ADR 0037, D41/D43): one append-only attempt per
 * business day, carried-forward exceptions, sign-off gated on the queue rather
 * than on a checklist the run could quietly disagree with.
 */
describeIntegration("reconciliation runs (integration)", () => {
  let db: AnyDb;
  const configs = new Map<string, TenantConfig>();
  let services: ReturnType<typeof wirePhase8Services>;
  let reconciliation: ReconciliationService;
  let exceptions: ExceptionService;

  const importStatement = async (
    tenant: CashTenant,
    rows: Parameters<typeof statementRow>[0][],
    marker: string,
  ): Promise<void> => {
    const service = createSettlementImportService({
      db,
      settlementImport: createMockSettlementImport({ rows: rows.map((row) => statementRow(row)) }),
    });
    await service.importStatement({
      tenantId: tenant.tenantId,
      provider: "mock",
      filename: "statement.csv",
      content: statementContent(marker),
      mapping: RECON_MAPPING,
      defaultCurrency: "NGN",
      feeToleranceMinor: TOLERANCES.feeToleranceMinor,
      actor: financeActor(tenant),
    });
  };

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    services = wirePhase8Services(db, configs);
    reconciliation = new ReconciliationService({ db, now: () => new Date("2026-06-16T02:00:00Z") });
    exceptions = new ExceptionService({ db, now: () => new Date("2026-06-16T02:00:00Z") });
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await db.destroy();
  });

  it("completes a clean day, signs it off, and opens a new run for a late payment", async () => {
    const tenant = await makeCashTenant(db, configs, { assetCount: 2 });
    const firstRef = await payLevyDay(services.paymentService, {
      tenantId: tenant.tenantId,
      assetId: assetAt(tenant, 0).assetId,
      businessDate: RECON_DAY,
    });
    await importStatement(
      tenant,
      [{ reference: firstRef, amountMinor: 20_000, feeMinor: 300, marker: "clean" }],
      "clean",
    );

    const first = await reconciliation.run({
      tenantId: tenant.tenantId,
      businessDate: RECON_DAY,
      timeZone: "Etc/UTC",
      tolerances: TOLERANCES,
      actor: financeActor(tenant),
    });
    expect(first.status).toBe("completed");
    expect(first.runSeq).toBe(1);
    expect(first.exceptionCount).toBe(0);

    // The checklist is persisted, ordered by check, and every blocking line
    // passed — otherwise sign-off below would be refused.
    const checklist = first.checklist as { check: string; withinTolerance: boolean | null }[];
    expect(checklist.length).toBeGreaterThan(0);
    expect(checklist.map((item) => item.check)).toContain("clearing_balance");
    expect(
      checklist.filter((item) => item.withinTolerance === false).map((item) => item.check),
    ).toEqual([]);

    // A late payment the same day is evidence, not an edit: a new run opens.
    const secondRef = await payLevyDay(services.paymentService, {
      tenantId: tenant.tenantId,
      assetId: assetAt(tenant, 1).assetId,
      businessDate: RECON_DAY,
    });
    await importStatement(
      tenant,
      [{ reference: secondRef, amountMinor: 20_000, feeMinor: 0, marker: "late" }],
      "late",
    );
    const second = await reconciliation.run({
      tenantId: tenant.tenantId,
      businessDate: RECON_DAY,
      timeZone: "Etc/UTC",
      tolerances: TOLERANCES,
      actor: financeActor(tenant),
    });
    expect(second.runSeq).toBe(2);
    expect(second.exceptionCount).toBe(0);

    const signedOff = await reconciliation.signOff({
      tenantId: tenant.tenantId,
      runId: second.id,
      actor: financeActor(tenant),
      note: "checked against the bank statement",
    });
    expect(signedOff.status).toBe("signed_off");
    expect(signedOff.signOffNote).toBe("checked against the bank statement");

    await expect(
      reconciliation.signOff({
        tenantId: tenant.tenantId,
        runId: second.id,
        actor: financeActor(tenant),
        note: "again",
      }),
    ).rejects.toMatchObject({ code: "run_already_signed_off" });

    // The first attempt is untouched.
    const original = await reconciliation
      .list(tenant.tenantId)
      .then((runs) => runs.find((run) => run.id === first.id));
    expect(original?.status).toBe("completed");
  });

  it("carries an unmatched statement row forward as a blocking exception until resolved", async () => {
    const tenant = await makeCashTenant(db, configs);
    await importStatement(
      tenant,
      [{ reference: "ghost-ref", amountMinor: 20_000, feeMinor: 0, marker: "ghost" }],
      "ghost",
    );

    const run = await reconciliation.run({
      tenantId: tenant.tenantId,
      businessDate: RECON_DAY,
      timeZone: "Etc/UTC",
      tolerances: TOLERANCES,
      actor: financeActor(tenant),
    });
    expect(run.exceptionCount).toBe(1);

    const open = await exceptions.list(tenant.tenantId, { status: "open" });
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe("settlement_rows_matched");
    expect(open[0]?.severity).toBe("blocking");
    const exceptionId = open[0]?.id ?? "";

    // Sign-off is refused while a blocking exception is open.
    await expect(
      reconciliation.signOff({
        tenantId: tenant.tenantId,
        runId: run.id,
        actor: financeActor(tenant),
        note: "trying anyway",
      }),
    ).rejects.toMatchObject({ code: "blocking_exceptions" });

    // Resolving needs a note, and an auditor may not resolve at all.
    await expect(
      exceptions.resolve({
        tenantId: tenant.tenantId,
        id: exceptionId,
        actor: financeActor(tenant),
        note: "   ",
      }),
    ).rejects.toThrow(/note/);
    await expect(
      exceptions.resolve({
        tenantId: tenant.tenantId,
        id: exceptionId,
        actor: auditorActor(tenant),
        note: "auditor wants to clear it",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // A finance user resolves it with a reason; now the run can be signed off.
    const resolved = await exceptions.resolve({
      tenantId: tenant.tenantId,
      id: exceptionId,
      actor: financeActor(tenant),
      note: "bank line belongs to another tenant; excluded from this statement",
    });
    expect(resolved.status).toBe("resolved");

    const signedOff = await reconciliation.signOff({
      tenantId: tenant.tenantId,
      runId: run.id,
      actor: financeActor(tenant),
      note: "resolved with finance",
    });
    expect(signedOff.status).toBe("signed_off");
  });

  it("flags a provider reference carried by two payments", async () => {
    const tenant = await makeCashTenant(db, configs);
    const reference = await payLevyDay(services.paymentService, {
      tenantId: tenant.tenantId,
      assetId: assetAt(tenant, 0).assetId,
      businessDate: RECON_DAY,
    });
    // A second row reusing the reference, as a racing provider retry or a bad
    // import would leave it.
    await insertDuplicatePayment(db, {
      tenantId: tenant.tenantId,
      assetId: assetAt(tenant, 0).assetId,
      providerReference: reference,
      amountMinor: 20_000,
      businessDate: RECON_DAY,
    });

    const run = await reconciliation.run({
      tenantId: tenant.tenantId,
      businessDate: RECON_DAY,
      timeZone: "Etc/UTC",
      tolerances: TOLERANCES,
      actor: financeActor(tenant),
    });
    const open = await exceptions.list(tenant.tenantId, { status: "open" });
    const duplicate = open.find((item) => item.kind === "duplicate_references");
    expect(duplicate).toBeDefined();
    expect(duplicate?.subjectId).toBe(reference);
    expect(run.status).toBe("completed");

    await expect(
      reconciliation.signOff({
        tenantId: tenant.tenantId,
        runId: run.id,
        actor: financeActor(tenant),
        note: "duplicate is fine, trust me",
      }),
    ).rejects.toMatchObject({ code: "blocking_exceptions" });
  });

  it("records overdue cash as a warning that does not block sign-off", async () => {
    const tenant = await makeCashTenant(db, configs);
    await services.cashService.recordIntake({
      ...intakeFor(tenant, assetAt(tenant, 0), "overdue-cash"),
      businessDate: RECON_DAY,
    });
    // The repository stamps `recorded_at` from the wall clock; age the intake so
    // it is genuinely past the eight-hour deadline when the run happens.
    await backdateIntake(db, tenant.tenantId, "overdue-cash", new Date("2026-06-15T09:00:00Z"));

    // Run the next morning: the intake is older than the eight-hour deadline.
    const run = await reconciliation.run({
      tenantId: tenant.tenantId,
      businessDate: RECON_DAY,
      timeZone: "Etc/UTC",
      tolerances: TOLERANCES,
      actor: financeActor(tenant),
    });
    expect(run.status).toBe("completed");

    const open = await exceptions.list(tenant.tenantId, { status: "open" });
    const overdue = open.find((item) => item.kind === "cash_overdue");
    expect(overdue?.severity).toBe("warning");

    // Warnings record but never block: finance can still sign the day.
    const signedOff = await reconciliation.signOff({
      tenantId: tenant.tenantId,
      runId: run.id,
      actor: financeActor(tenant),
      note: "collector deposits next morning",
    });
    expect(signedOff.status).toBe("signed_off");
  });

  it("blocks sign-off when gateway money is still sitting in clearing", async () => {
    const tenant = await makeCashTenant(db, configs);
    await payLevyDay(services.paymentService, {
      tenantId: tenant.tenantId,
      assetId: assetAt(tenant, 0).assetId,
      businessDate: RECON_DAY,
    });

    const run = await reconciliation.run({
      tenantId: tenant.tenantId,
      businessDate: RECON_DAY,
      timeZone: "Etc/UTC",
      tolerances: TOLERANCES,
      actor: financeActor(tenant),
    });
    expect(run.status).toBe("completed");

    const open = await exceptions.list(tenant.tenantId, { status: "open" });
    const clearing = open.find((item) => item.kind === "clearing_balance");
    expect(clearing?.severity).toBe("blocking");
    expect(clearing?.actualMinor).toBe(0n - BigInt(20_000));

    await expect(
      reconciliation.signOff({
        tenantId: tenant.tenantId,
        runId: run.id,
        actor: financeActor(tenant),
        note: "no statement imported yet",
      }),
    ).rejects.toBeInstanceOf(ReconciliationRunError);
  });
});
