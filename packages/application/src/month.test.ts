import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantConfig } from "@tpirs/config";
import { createDb, migrateUp, repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb, ReconciliationRunRow } from "@tpirs/db";
import { sql } from "kysely";
import { businessDate, money } from "@tpirs/domain";
import { createCsvSettlementImport } from "@tpirs/settlement-import-csv";
import { createMockExportService } from "@tpirs/export-service-mock";
import { ReconciliationService } from "./reconciliation-service.js";
import { AnomalyService } from "./anomaly-service.js";
import { ReportService } from "./report-service.js";
import { createSettlementImportService } from "./settlement-import-service.js";
import { makeMonthTenant, monthDays, runMonthActivity } from "./test-support/month.js";
import type { MonthTenant } from "./test-support/month.js";
import {
  backdateIntake,
  financeActor,
  payLevyDay,
  wirePhase8Services,
} from "./test-support/recon.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../db/migrations");
const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

const TOLERANCES = {
  toleranceMinor: 0n,
  feeToleranceMinor: 1_000n,
  depositDeadlineHours: 8,
  suspenseAgeingDays: 7,
};

/**
 * Phase 8 acceptance: a full simulated month reconciles and is signed off by a
 * test finance user, and the discrepancy scenario produces exactly the
 * exceptions the plan names.
 */
describeIntegration("a simulated month reconciles and is signed off (integration)", () => {
  let db: AnyDb;
  const configs = new Map<string, TenantConfig>();
  let services: ReturnType<typeof wirePhase8Services>;
  let reconciliation: ReconciliationService;
  let reports: ReportService;
  let tenant: MonthTenant;
  const days = monthDays();
  const runsByDay = new Map<string, ReconciliationRunRow>();

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    services = wirePhase8Services(db, configs);
    reconciliation = new ReconciliationService({ db });
    reports = new ReportService({ db, exporters: { csv: createMockExportService() } });
    const settlementImport = createSettlementImportService({
      db,
      settlementImport: createCsvSettlementImport(),
    });

    tenant = await makeMonthTenant(db, configs);
    await runMonthActivity({
      db,
      tenant,
      paymentService: services.paymentService,
      cashService: services.cashService,
      settlementImport,
      days,
    });

    for (const day of days) {
      const run = await reconciliation.run({
        tenantId: tenant.tenantId,
        businessDate: day,
        timeZone: "Etc/UTC",
        tolerances: TOLERANCES,
        actor: { kind: "system" },
      });
      runsByDay.set(day, run);
    }
    for (const day of days) {
      const run = runsByDay.get(day);
      if (run === undefined) throw new Error(`month has no run for ${day}`);
      await reconciliation.signOff({
        tenantId: tenant.tenantId,
        runId: run.id,
        actor: financeActor(tenant),
        note: `month close ${day}`,
      });
    }
  }, 600_000);

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await db.destroy();
  });

  it("completes every day with no exception and no blocking checklist line", () => {
    expect(runsByDay.size).toBe(days.length);
    for (const day of days) {
      const run = runsByDay.get(day);
      expect(run?.status).toBe("completed");
      expect(run?.exceptionCount).toBe(0);
      const checklist = run?.checklist as { check: string; withinTolerance: boolean | null }[];
      const failing = checklist.filter((item) => item.withinTolerance === false);
      expect(
        failing.map((item) => item.check),
        `day ${day}`,
      ).toEqual([]);
    }
  });

  it("leaves no gateway money in clearing and keeps the ledger balanced", async () => {
    const state = await withTenant(db, tenant.tenantId, async (tx) => {
      const repos = repositories(tx);
      return {
        clearing: await repos.ledger.accountBalance(tenant.tenantId, "GATEWAY_CLEARING"),
        fees: await repos.ledger.accountBalance(tenant.tenantId, "GATEWAY_FEES"),
      };
    });
    expect(state.clearing).toBe(0n);
    // Gateways settled net: the cut is a cost, never a payment.
    expect(state.fees < 0n).toBe(true);

    const totals = await withTenant(db, tenant.tenantId, async (tx) => {
      const rows = await tx
        .selectFrom("ledgerEntries")
        .select(["direction", "amountMinor"])
        .execute();
      return rows.reduce(
        (sum, row) => {
          if (row.direction === "debit") sum.debit += row.amountMinor;
          else sum.credit += row.amountMinor;
          return sum;
        },
        { debit: 0n, credit: 0n },
      );
    });
    expect(totals.debit).toBe(totals.credit);
  });

  it("recognises exactly the levy collected", async () => {
    const revenue = await withTenant(db, tenant.tenantId, async (tx) =>
      repositories(tx).ledger.accountBalance(tenant.tenantId, "REVENUE_LEVY"),
    );
    const allocations = await withTenant(db, tenant.tenantId, async (tx) =>
      tx
        .selectFrom("obligationPeriods")
        .select((eb) => eb.fn.sum("amountPaidMinor").as("total"))
        .executeTakeFirst(),
    );
    expect(revenue).toBe(BigInt(String(allocations?.total ?? 0)));
    expect(revenue > 0n).toBe(true);
  });

  it("closes the collector float to zero every day", async () => {
    const cash = await withTenant(db, tenant.tenantId, async (tx) => {
      const repos = repositories(tx);
      const intakes = await repos.collectorCash.listIntakes(tenant.tenantId, {
        collectorUserId: tenant.collectorUserId,
        limit: 1000,
      });
      return {
        balance: await repos.ledger.collectorCashBalance(tenant.tenantId, tenant.collectorUserId),
        openIntakes: intakes.rows.filter((row) => row.status === "open").length,
        openTotal: await repos.collectorCash.sumOpenIntakes(
          tenant.tenantId,
          tenant.collectorUserId,
        ),
      };
    });
    expect(cash.balance).toBe(0n);
    expect(cash.openIntakes).toBe(0);
    expect(cash.openTotal).toBe(0n);
  });

  it("computes compliance from scans, per zone, over the month", async () => {
    const report = await reports.run(
      {
        tenantId: tenant.tenantId,
        actor: financeActor(tenant),
        from: days[0] ?? "2026-06-01",
        to: days.at(-1) ?? "2026-06-30",
        timeZone: "Etc/UTC",
      },
      "compliance",
    );

    const byZone = new Map<string, { paid: number; notPaid: number; unknown: number }>();
    for (const row of report.rows) {
      const zoneId = row["zoneId"];
      if (typeof zoneId !== "string") continue;
      const entry = byZone.get(zoneId) ?? { paid: 0, notPaid: 0, unknown: 0 };
      entry.paid += Number(row["paidScans"] ?? 0);
      entry.notPaid += Number(row["notPaidScans"] ?? 0);
      entry.unknown += Number(row["unknownScans"] ?? 0);
      byZone.set(zoneId, entry);
    }

    expect(byZone.size).toBe(tenant.zones.length);
    for (const zone of tenant.zones) {
      const actual = byZone.get(zone.id);
      expect(actual, `zone ${zone.name}`).toBeDefined();
      if (actual === undefined) continue;
      const scans = await withTenant(db, tenant.tenantId, async (tx) =>
        sql<{ total: string; paid: string }>`
          select count(*)::text as total,
                 count(*) filter (where authoritative_status = 'paid')::text as paid
          from scans
          where tenant_id = ${tenant.tenantId} and zone_id = ${zone.id}
        `.execute(tx),
      );
      const counts = scans.rows[0];
      expect(actual.paid).toBe(Number(counts?.paid ?? "0"));
      // The denominator is paid + no_payment_recorded; unknown is reported but
      // never allowed to depress the rate (D44).
      expect(actual.paid + actual.notPaid + actual.unknown).toBe(Number(counts?.total ?? "0"));
    }
  });

  it("audits every sign-off and versions a re-run instead of editing history", async () => {
    const audits = await withSystem(db, async (tx) =>
      repositories(tx).audit.search({
        action: "reconciliation.run.signed_off",
        limit: 100,
      }),
    );
    const runIds = new Set([...runsByDay.values()].map((run) => run.id));
    const mine = audits.filter((entry) => entry.entityId !== null && runIds.has(entry.entityId));
    expect(mine).toHaveLength(days.length);
    expect(mine.every((entry) => entry.actorUserId === tenant.financeUserId)).toBe(true);

    const lastDay = days.at(-1);
    if (lastDay === undefined) throw new Error("month has no days");
    const original = runsByDay.get(lastDay);
    if (original === undefined) throw new Error("month has no last run");

    const rerun = await reconciliation.run({
      tenantId: tenant.tenantId,
      businessDate: lastDay,
      timeZone: "Etc/UTC",
      tolerances: TOLERANCES,
      actor: { kind: "system" },
    });
    expect(rerun.runSeq).toBe(original.runSeq + 1);
    expect(rerun.status).toBe("completed");

    const history = await reconciliation.list(tenant.tenantId, { from: lastDay, to: lastDay });
    const signed = history.find((run) => run.id === original.id);
    expect(signed?.status).toBe("signed_off");
    expect(signed?.signOffNote).toBe(`month close ${lastDay}`);
  });

  it("names the exact exceptions when the evidence disagrees", async () => {
    const stamp = `${Date.now().toString(36)}`;
    const discrepancy = await makeMonthTenant(db, configs, {
      assetCount: 6,
      slugPrefix: "disc",
      anomalyRules: [
        {
          key: "zone_compliance_drop",
          enabled: true,
          windowDays: 1,
          thresholdPercent: 30,
          severity: "warning",
        },
        {
          key: "collector_deposit_lag",
          enabled: true,
          windowDays: 7,
          thresholdMinor: 1,
          severity: "warning",
        },
        {
          key: "suspense_growth",
          enabled: true,
          windowDays: 7,
          thresholdMinor: 1_000,
          severity: "warning",
        },
      ],
    });
    const [asset0, asset1, asset2, asset3, asset4, idle] = discrepancy.assets;
    if (
      asset0 === undefined ||
      asset1 === undefined ||
      asset2 === undefined ||
      asset3 === undefined ||
      asset4 === undefined ||
      idle === undefined
    ) {
      throw new Error("discrepancy tenant is missing assets");
    }
    const zoneId = asset0.zoneId;
    const dayA = businessDate("2026-07-01");
    const dayB = businessDate("2026-07-02");

    const scan = async (assetId: string, day: string, status: "paid" | "no_payment_recorded") =>
      withTenant(db, discrepancy.tenantId, async (tx) =>
        repositories(tx).scans.insertIfAbsent({
          tenantId: discrepancy.tenantId,
          assetId,
          officerUserId: discrepancy.officerUserId,
          deviceId: "disc-device",
          clientScanId: randomUUID(),
          source: "qr",
          observedStatus: status,
          authoritativeStatus: status,
          businessDate: day,
          scannedAt: new Date(`${day}T10:00:00Z`),
          zoneId,
        }),
      );

    // Baseline: a fully compliant zone.
    await scan(asset0.assetId, dayA, "paid");
    await scan(asset1.assetId, dayA, "paid");

    // Day B: one row inside tolerance, one beyond it, one over-settlement and
    // one payment with no statement row at all.
    const withinReference = await payLevyDay(services.paymentService, {
      tenantId: discrepancy.tenantId,
      assetId: asset0.assetId,
      businessDate: dayB,
    });
    const gapReference = await payLevyDay(services.paymentService, {
      tenantId: discrepancy.tenantId,
      assetId: asset1.assetId,
      businessDate: dayB,
    });
    const overReference = await payLevyDay(services.paymentService, {
      tenantId: discrepancy.tenantId,
      assetId: asset2.assetId,
      businessDate: dayB,
    });
    await payLevyDay(services.paymentService, {
      tenantId: discrepancy.tenantId,
      assetId: asset3.assetId,
      businessDate: dayB,
    });

    const settlementImport = createSettlementImportService({
      db,
      settlementImport: createCsvSettlementImport(),
    });
    const content =
      [
        "reference,amount,fee,currency,settled_at,narration",
        // Exactly the tolerance: the boundary must pass and post.
        `${withinReference},20000,1000,NGN,${dayB},Boundary`,
        // One unit beyond the tolerance: it must not post.
        `${gapReference},20000,3000,NGN,${dayB},Gap`,
        // The bank received more than the driver was charged.
        `${overReference},21000,0,NGN,${dayB},Over`,
      ].join("\n") + "\n";
    const importInput = {
      tenantId: discrepancy.tenantId,
      provider: "mock",
      filename: "discrepancies.csv",
      content,
      mapping: {
        reference: "reference",
        amount: "amount",
        fee: "fee",
        currency: "currency",
        settledAt: "settled_at",
        description: "narration",
        settledAtFormat: "YYYY-MM-DD" as const,
        amountInMinorUnits: true,
        decimalSeparator: "." as const,
      },
      defaultCurrency: "NGN",
      feeToleranceMinor: 1_000n,
      actor: financeActor(discrepancy),
    };
    const first = await settlementImport.importStatement(importInput);
    expect(first.postedCount).toBe(1);
    expect(first.unmatchedCount).toBe(2);

    // The same bytes again: no rows, no postings, no second import.
    const replay = await settlementImport.importStatement(importInput);
    expect(replay.outcome).toBe("duplicate");
    expect(replay.postedCount).toBe(0);
    const importedRows = await withTenant(db, discrepancy.tenantId, async (tx) =>
      repositories(tx).settlements.list(discrepancy.tenantId, {}),
    );
    expect(importedRows).toHaveLength(3);
    const boundary = importedRows.find((row) => row.providerReference === withinReference);
    expect(boundary?.status).toBe("posted");

    // An overdue collector: cash taken on day A and never banked.
    await services.cashService.recordIntake({
      tenantId: discrepancy.tenantId,
      collectorUserId: discrepancy.collectorUserId,
      assetId: asset4.assetId,
      amount: money("NGN", 20_000),
      clientReference: `disc-overdue-${stamp}`,
      businessDate: dayA,
    });
    await backdateIntake(
      db,
      discrepancy.tenantId,
      `disc-overdue-${stamp}`,
      new Date("2026-06-30T09:00:00Z"),
    );

    // Day B is much less compliant than the baseline.
    await scan(asset0.assetId, dayB, "paid");
    await scan(asset4.assetId, dayB, "no_payment_recorded");
    await scan(idle.assetId, dayB, "no_payment_recorded");

    const run = await reconciliation.run({
      tenantId: discrepancy.tenantId,
      businessDate: dayB,
      timeZone: "Etc/UTC",
      tolerances: TOLERANCES,
      actor: { kind: "system" },
    });
    const open = await withTenant(db, discrepancy.tenantId, async (tx) =>
      repositories(tx).exceptions.list(discrepancy.tenantId, { status: "open", limit: 100 }),
    );
    const kinds = open.map((row) => `${row.kind}:${row.severity}`);
    // Two rows the statement could not honestly post, one open clearing balance
    // (the payment with no statement row plus the two unmatched payments) and
    // the overdue collector, which is only ever a warning.
    expect(kinds.filter((kind) => kind === "settlement_rows_matched:blocking")).toHaveLength(2);
    expect(kinds).toContain("clearing_balance:blocking");
    expect(kinds).toContain("cash_overdue:warning");
    expect(kinds.some((kind) => kind.startsWith("revenue_recognised"))).toBe(false);
    expect(run.status).toBe("completed");

    const clearing = open.find((row) => row.kind === "clearing_balance");
    // The boundary payment drained; the other three payments still sit in clearing.
    expect(clearing?.actualMinor).toBe(0n - 60_000n);

    // Anomalies: the zone's rate fell, the collector is lagging, and no idle
    // asset ever becomes an event.
    const raised = await new AnomalyService({ db }).evaluateForRun({
      tenantId: discrepancy.tenantId,
      businessDate: dayB,
      rules: [
        { key: "zone_compliance_drop", severity: "warning", windowDays: 1, thresholdPercent: 30 },
        { key: "collector_deposit_lag", severity: "warning", windowDays: 7, thresholdMinor: 1 },
        { key: "suspense_growth", severity: "warning", windowDays: 7, thresholdMinor: 1_000 },
      ],
      depositDeadlineHours: 8,
    });
    const byRule = new Map(raised.map((event) => [event.ruleKey, event]));
    expect(byRule.get("zone_compliance_drop")?.subjectType).toBe("zone");
    expect(byRule.get("zone_compliance_drop")?.subjectId).toBe(zoneId);
    expect(byRule.get("collector_deposit_lag")?.subjectType).toBe("collector");
    expect(byRule.has("suspense_growth")).toBe(false);
    expect(raised.every((event) => event.subjectType !== "asset")).toBe(true);
    expect(raised.some((event) => event.subjectId === idle.assetId)).toBe(false);
  }, 300_000);
});
