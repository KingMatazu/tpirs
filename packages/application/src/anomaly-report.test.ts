import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDb, migrateUp, repositories, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import type { TenantConfig } from "@tpirs/config";
import { businessDate } from "@tpirs/domain";
import type { AnomalyRule } from "@tpirs/domain";
import { createMockExportService } from "@tpirs/export-service-mock";
import { AnomalyService } from "./anomaly-service.js";
import { ReportError, ReportService } from "./report-service.js";
import type { ReportInput } from "./report-service.js";
import type { CashTenant } from "./test-support/cash-day.js";
import {
  assetAt,
  deliverDeposit,
  intakeFor,
  makeCashTenant,
  provisionInstruction,
} from "./test-support/cash-day.js";
import {
  backdateIntake,
  financeActor,
  payLevyDay,
  RECON_DAY,
  wirePhase8Services,
} from "./test-support/recon.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../db/migrations");
const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

const EVAL_DAY = businessDate("2026-06-20");

/**
 * Phase 8 anomalies and reports (ADR 0039, D44/D46/D49).
 *
 * Anomalies observe collectors, zones, officers and the tenant against their
 * own trailing baseline; an idle asset is never an anomaly. Reports read the
 * operational tables and compute compliance from scans, never from paid days
 * over registered assets.
 */
describeIntegration("anomaly evaluation and finance reports (integration)", () => {
  let db: AnyDb;
  const configs = new Map<string, TenantConfig>();
  let services: ReturnType<typeof wirePhase8Services>;

  const anomalyService = (now: Date): AnomalyService => new AnomalyService({ db, now: () => now });

  const intakeOn = (tenant: CashTenant, assetIndex: number, day: string, marker: string) =>
    services.cashService.recordIntake({
      ...intakeFor(tenant, assetAt(tenant, assetIndex), marker),
      businessDate: businessDate(day),
    });

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

  it("fires a collector volume drop against the trailing mean and dedupes a re-run", async () => {
    const tenant = await makeCashTenant(db, configs);
    // Three days of one intake each, then silence on the evaluation day.
    await intakeOn(tenant, 0, "2026-06-17", "drop-1");
    await intakeOn(tenant, 0, "2026-06-18", "drop-2");
    await intakeOn(tenant, 0, "2026-06-19", "drop-3");

    const rules: AnomalyRule[] = [
      { key: "collector_volume_drop", severity: "warning", windowDays: 3, thresholdPercent: 30 },
    ];
    const service = anomalyService(new Date("2026-06-20T09:00:00Z"));
    const events = await service.evaluateForRun({
      tenantId: tenant.tenantId,
      businessDate: EVAL_DAY,
      rules,
      depositDeadlineHours: 8,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.ruleKey).toBe("collector_volume_drop");
    expect(events[0]?.subjectType).toBe("collector");
    expect(events[0]?.subjectId).toBe(tenant.collectorUserId);
    expect(Number(events[0]?.observed)).toBe(0);
    expect(Number(events[0]?.baseline)).toBe(1);

    // Same rule, same subject, same window: one event, not an alert storm.
    const again = await service.evaluateForRun({
      tenantId: tenant.tenantId,
      businessDate: EVAL_DAY,
      rules,
      depositDeadlineHours: 8,
    });
    expect(again).toHaveLength(0);
  });

  it("never treats an idle asset as an anomaly", async () => {
    const tenant = await makeCashTenant(db, configs);
    const events = await anomalyService(new Date("2026-06-20T09:00:00Z")).evaluateForRun({
      tenantId: tenant.tenantId,
      businessDate: EVAL_DAY,
      // Every rule that exists; the tenant has a registered asset that never
      // paid and never will under pay-per-use.
      rules: [
        { key: "collector_volume_drop", severity: "warning", windowDays: 7, thresholdPercent: 30 },
        { key: "zone_compliance_drop", severity: "warning", windowDays: 7, thresholdPercent: 30 },
        {
          key: "officer_scan_volume_change",
          severity: "warning",
          windowDays: 7,
          thresholdPercent: 30,
        },
        { key: "collector_deposit_lag", severity: "warning", windowDays: 7, thresholdMinor: 1 },
      ],
      depositDeadlineHours: 8,
    });
    expect(events).toEqual([]);
    expect(events.every((event) => event.subjectType !== "asset")).toBe(true);
  });

  it("fires deposit lag only once the intake is older than the deadline", async () => {
    const tenant = await makeCashTenant(db, configs);
    await intakeOn(tenant, 0, "2026-06-15", "lag-intake");
    await backdateIntake(db, tenant.tenantId, "lag-intake", new Date("2026-06-15T09:00:00Z"));
    const rules: AnomalyRule[] = [
      { key: "collector_deposit_lag", severity: "warning", windowDays: 7, thresholdMinor: 1 },
    ];

    // 09:00 intake; at 16:00 the eight-hour deadline has not passed.
    const early = await anomalyService(new Date("2026-06-15T16:00:00Z")).evaluateForRun({
      tenantId: tenant.tenantId,
      businessDate: RECON_DAY,
      rules,
      depositDeadlineHours: 8,
    });
    expect(early).toEqual([]);

    // At 17:30 it has: recorded 09:00 < cutoff 09:30.
    const late = await anomalyService(new Date("2026-06-15T17:30:00Z")).evaluateForRun({
      tenantId: tenant.tenantId,
      businessDate: RECON_DAY,
      rules,
      depositDeadlineHours: 8,
    });
    expect(late).toHaveLength(1);
    expect(late[0]?.subjectType).toBe("collector");
  });

  it("fires suspense growth above the ceiling on the tenant subject", async () => {
    const tenant = await makeCashTenant(db, configs);
    const reference = await provisionInstruction(db, services.cashService, tenant);
    const deposit = await deliverDeposit(services.paymentService, {
      tenantId: tenant.tenantId,
      reference,
      amountMinor: 7_777,
    });
    expect(deposit.outcome).toBe("deposit_suspense");

    const rules: AnomalyRule[] = [
      { key: "suspense_growth", severity: "warning", windowDays: 7, thresholdMinor: 5_000 },
    ];
    const events = await anomalyService(new Date("2026-06-15T17:30:00Z")).evaluateForRun({
      tenantId: tenant.tenantId,
      businessDate: RECON_DAY,
      rules,
      depositDeadlineHours: 8,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.ruleKey).toBe("suspense_growth");
    expect(events[0]?.subjectType).toBe("tenant");
    // The anomaly table stores these as numeric(18,4), so compare numerically.
    expect(Number(events[0]?.observed)).toBe(7_777);
  });

  it("measures zone compliance from scan outcomes and officer volume from scans", async () => {
    const tenant = await makeCashTenant(db, configs);
    const asset = assetAt(tenant, 0);
    const zone = await withTenant(db, tenant.tenantId, async (tx) =>
      repositories(tx).zones.create({
        tenantId: tenant.tenantId,
        parentZoneId: null,
        name: "Market Gate",
      }),
    );

    // A paid day for the asset, so the baseline scan is a paid scan.
    await payLevyDay(services.paymentService, {
      tenantId: tenant.tenantId,
      assetId: asset.assetId,
      businessDate: businessDate("2026-06-19"),
    });

    const scan = async (input: {
      readonly clientScanId: string;
      readonly businessDate: string;
      readonly authoritativeStatus: "paid" | "no_payment_recorded" | "unknown";
      readonly scannedAt: string;
    }) =>
      withTenant(db, tenant.tenantId, async (tx) =>
        repositories(tx).scans.insertIfAbsent({
          tenantId: tenant.tenantId,
          assetId: asset.assetId,
          officerUserId: tenant.financeUserId,
          deviceId: "device-1",
          clientScanId: randomUUID(),
          source: "qr",
          observedStatus: input.authoritativeStatus,
          authoritativeStatus: input.authoritativeStatus,
          businessDate: input.businessDate,
          scannedAt: new Date(input.scannedAt),
          zoneId: zone.id,
        }),
      );

    // Baseline: one paid scan. Evaluation day: two scans, neither paid.
    await scan({
      clientScanId: "scan-baseline",
      businessDate: "2026-06-19",
      authoritativeStatus: "paid",
      scannedAt: "2026-06-19T10:00:00Z",
    });
    await scan({
      clientScanId: "scan-today-1",
      businessDate: EVAL_DAY,
      authoritativeStatus: "no_payment_recorded",
      scannedAt: "2026-06-20T10:00:00Z",
    });
    await scan({
      clientScanId: "scan-today-2",
      businessDate: EVAL_DAY,
      authoritativeStatus: "unknown",
      scannedAt: "2026-06-20T11:00:00Z",
    });

    const rules: AnomalyRule[] = [
      { key: "zone_compliance_drop", severity: "warning", windowDays: 1, thresholdPercent: 30 },
      {
        key: "officer_scan_volume_change",
        severity: "warning",
        windowDays: 1,
        thresholdPercent: 20,
      },
    ];
    const events = await anomalyService(new Date("2026-06-20T12:00:00Z")).evaluateForRun({
      tenantId: tenant.tenantId,
      businessDate: EVAL_DAY,
      rules,
      depositDeadlineHours: 8,
    });

    const byRule = new Map(events.map((event) => [event.ruleKey, event]));
    // Baseline 100% paid, today 0% of decided scans (the unknown scan carries
    // no verdict and is excluded from the rate).
    expect(byRule.get("zone_compliance_drop")?.subjectType).toBe("zone");
    expect(byRule.get("zone_compliance_drop")?.subjectId).toBe(zone.id);
    expect(Number(byRule.get("zone_compliance_drop")?.observed)).toBe(0);
    expect(Number(byRule.get("zone_compliance_drop")?.baseline)).toBe(100);
    // One scan yesterday, two today: a volume change either way.
    expect(byRule.get("officer_scan_volume_change")?.subjectId).toBe(tenant.financeUserId);
  });

  it("reports the day's revenue, cash and scan-based compliance", async () => {
    const tenant = await makeCashTenant(db, configs, { assetCount: 2 });
    await payLevyDay(services.paymentService, {
      tenantId: tenant.tenantId,
      assetId: assetAt(tenant, 0).assetId,
      businessDate: RECON_DAY,
    });
    await intakeOn(tenant, 1, RECON_DAY, "report-intake");
    await backdateIntake(db, tenant.tenantId, "report-intake", new Date("2026-06-15T09:00:00Z"));

    const zone = await withTenant(db, tenant.tenantId, async (tx) =>
      repositories(tx).zones.create({
        tenantId: tenant.tenantId,
        parentZoneId: null,
        name: "Central Market",
      }),
    );
    const scan = async (
      label: string,
      authoritativeStatus: "paid" | "no_payment_recorded" | "unknown",
    ) =>
      withTenant(db, tenant.tenantId, async (tx) =>
        repositories(tx).scans.insertIfAbsent({
          tenantId: tenant.tenantId,
          assetId: assetAt(tenant, 0).assetId,
          officerUserId: tenant.financeUserId,
          deviceId: label,
          clientScanId: randomUUID(),
          source: "qr",
          observedStatus: authoritativeStatus,
          authoritativeStatus,
          businessDate: RECON_DAY,
          scannedAt: new Date(`${RECON_DAY}T10:00:00Z`),
          zoneId: zone.id,
        }),
      );
    await scan("report-scan-paid", "paid");
    await scan("report-scan-not-paid", "no_payment_recorded");
    await scan("report-scan-unknown", "unknown");

    const reports = new ReportService({
      db,
      exporters: { csv: createMockExportService() },
      // Next morning, so the intake is overdue for the position report.
      now: () => new Date("2026-06-16T02:00:00Z"),
    });
    const input: ReportInput = {
      tenantId: tenant.tenantId,
      actor: financeActor(tenant),
      from: RECON_DAY,
      to: RECON_DAY,
      timeZone: "Etc/UTC",
    };

    const daily = await reports.run(input, "daily_collections");
    expect(daily.rows).toHaveLength(1);
    // Revenue is recognised for both funding paths: the gateway levy and the
    // collector's cash intake, each for the same business day.
    expect(daily.rows[0]?.["revenueMinor"]).toBe("40000");
    expect(daily.rows[0]?.["paymentsCount"]).toBe(1);
    expect(daily.rows[0]?.["paymentsTotalMinor"]).toBe("20000");
    expect(daily.rows[0]?.["cashIntakeCount"]).toBe(1);
    expect(daily.rows[0]?.["cashIntakeTotalMinor"]).toBe("20000");
    expect(daily.totals["revenueMinor"]).toBe("40000");

    const compliance = await reports.run(input, "compliance");
    expect(compliance.rows).toHaveLength(1);
    expect(compliance.rows[0]?.["paidScans"]).toBe(1);
    expect(compliance.rows[0]?.["notPaidScans"]).toBe(1);
    expect(compliance.rows[0]?.["unknownScans"]).toBe(1);
    // Paid over decided scans: 1 of 2, not 1 of 3 and not 1 of 2 assets.
    expect(compliance.rows[0]?.["compliancePercent"]).toBe(50);

    const positions = await reports.run(input, "collector_positions");
    expect(positions.rows).toHaveLength(1);
    expect(positions.rows[0]?.["intakeCount"]).toBe(1);
    expect(positions.rows[0]?.["intakeTotalMinor"]).toBe("20000");
    expect(positions.rows[0]?.["floatMinor"]).toBe("20000");
    expect(positions.rows[0]?.["overdueOpenIntakes"]).toBe(1);

    const byZone = await reports.run(input, "collections_by_zone");
    expect(byZone.rows.find((row) => row["zoneId"] === zone.id)?.["scansCount"]).toBe(3);

    const exportResult = await reports.exportReport({
      ...input,
      reportKey: "daily_collections",
      format: "csv",
      filenameBase: "daily-collections",
    });
    expect(exportResult.rowCount).toBe(1);
    expect(exportResult.bytes.length).toBeGreaterThan(0);
    expect(exportResult.filename).toBe("daily-collections.csv");
  });

  it("refuses an oversized range and a format with no exporter", async () => {
    const tenant = await makeCashTenant(db, configs);
    const reports = new ReportService({ db, exporters: {} });
    const input: ReportInput = {
      tenantId: tenant.tenantId,
      actor: financeActor(tenant),
      from: RECON_DAY,
      to: RECON_DAY,
      timeZone: "Etc/UTC",
    };

    await expect(
      reports.run({ ...input, from: "2026-05-01" }, "daily_collections"),
    ).rejects.toMatchObject({ code: "range_too_large" });
    await expect(
      reports.run({ ...input, from: "2026-06-16", to: "2026-06-15" }, "daily_collections"),
    ).rejects.toMatchObject({ code: "invalid_range" });
    await expect(
      reports.exportReport({
        ...input,
        reportKey: "daily_collections",
        format: "pdf",
        filenameBase: "daily",
      }),
    ).rejects.toBeInstanceOf(ReportError);
  });
});
