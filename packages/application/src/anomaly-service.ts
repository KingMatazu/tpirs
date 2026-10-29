import { addDays, anomalyWindow, businessDate, evaluateAnomalyRule } from "@tpirs/domain";
import type { AnomalyRule, BusinessDate } from "@tpirs/domain";
import type { AnomalyEventRow } from "@tpirs/db";
import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import type { Telemetry } from "@tpirs/ports";

/**
 * Anomaly evaluation after a reconciliation run (D46, ADR 0039).
 *
 * Rules observe collectors, zones, officers and the tenant as a whole — never
 * a single asset; absence of payments for a vehicle is not an event. The
 * service gathers each subject's trailing day-series from the database and
 * hands the numbers to the pure evaluation in `@tpirs/domain`, which decides
 * whether the observation fires. Events persist under the
 * `(rule, subject, window_end)` dedupe key, so a re-run is never a new alert.
 */
export class AnomalyService {
  constructor(
    private readonly deps: {
      readonly db: AnyDb;
      readonly now?: () => Date;
      readonly telemetry?: Telemetry;
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * Evaluates every enabled rule for the run's business day.
   *
   * `depositDeadlineHours` comes from the tenant cash rules and defines what
   * "lagging" means for `collector_deposit_lag`; on that rule `thresholdMinor`
   * is the multiple of the deadline an intake may protrude past before it
   * counts (1 = the deadline itself, 2 = twice the deadline, …).
   */
  async evaluateForRun(input: {
    readonly tenantId: string;
    readonly businessDate: string;
    readonly rules: readonly AnomalyRule[];
    readonly depositDeadlineHours: number;
  }): Promise<AnomalyEventRow[]> {
    const evaluationDate = businessDate(input.businessDate);
    const now = this.now();

    return withTenant(this.deps.db, input.tenantId, async (tx) => {
      const repos = repositories(tx);
      const checks = repos.checks;
      const created: AnomalyEventRow[] = [];

      const record = async (
        rule: AnomalyRule,
        observation: ReturnType<typeof evaluateAnomalyRule>,
      ): Promise<void> => {
        if (!observation.fires) return;
        const window = anomalyWindow(rule, evaluationDate);
        const { event, created: isNew } = await repos.anomalies.record(input.tenantId, {
          ruleKey: observation.ruleKey,
          subjectType: observation.subjectType,
          subjectId: observation.subjectId,
          windowStart: window.windowStart,
          windowEnd: window.windowEnd,
          observed: observation.observed,
          baseline: observation.baseline,
          threshold: observation.threshold,
          severity: observation.severity,
          detail: observation.detail,
        });
        if (!isNew) return;
        created.push(event);
        this.deps.telemetry?.counter("anomaly.raised", 1, {
          tenantId: input.tenantId,
          ruleKey: observation.ruleKey,
          subjectType: observation.subjectType,
        });
        this.deps.telemetry?.log("info", "anomaly raised", {
          tenantId: input.tenantId,
          ruleKey: observation.ruleKey,
          subjectType: observation.subjectType,
          subjectId: observation.subjectId,
          observed: observation.observed,
          baseline: observation.baseline,
        });
      };

      for (const rule of input.rules) {
        const window = anomalyWindow(rule, evaluationDate);

        // Trailing intake volume per collector.
        if (rule.key === "collector_volume_drop") {
          const rows = await checks.collectorIntakeCounts(
            input.tenantId,
            window.windowStart,
            evaluationDate,
          );
          const perSubject = baselineSeries(
            window.windowStart,
            window.windowEnd,
            rows.map((row) => ({
              subjectId: row.collectorUserId,
              businessDate: row.businessDate,
              value: row.count,
            })),
          );
          for (const [subjectId, baselineValues] of perSubject) {
            const observedAt = rows.find(
              (row) => row.collectorUserId === subjectId && row.businessDate === evaluationDate,
            );
            await record(
              rule,
              evaluateAnomalyRule({
                rule,
                subjectType: "collector",
                subjectId,
                observed: observedAt?.count ?? 0,
                baselineValues,
              }),
            );
          }
        }

        // Intakes that stayed open too long, right now.
        if (rule.key === "collector_deposit_lag") {
          const multiple = rule.thresholdMinor ?? 1;
          const cutoffMs = now.getTime() - multiple * input.depositDeadlineHours * 3_600_000;
          const overdueCount = await checks.collectorsWithOverdueIntakes(
            input.tenantId,
            new Date(cutoffMs),
          );
          for (const [subjectId, count] of overdueCount) {
            await record(
              rule,
              evaluateAnomalyRule({
                rule,
                subjectType: "collector",
                subjectId,
                observed: count,
                baselineValues: [],
              }),
            );
          }
        }

        // Zone compliance rate from scans; never paid days over registered assets (D44).
        if (rule.key === "zone_compliance_drop") {
          const rows = await checks.zoneComplianceCounts(
            input.tenantId,
            window.windowStart,
            evaluationDate,
          );
          const perZone = groupRows(rows, (row) => row.zoneId);
          for (const [zoneId, zoneRows] of perZone) {
            const baselineValues: number[] = [];
            for (let day = window.windowStart; day <= window.windowEnd; day = addDays(day, 1)) {
              const frame = zoneRows.find((row) => row.businessDate === day);
              if (frame === undefined) continue;
              const known = frame.paid + frame.notPaid;
              if (known > 0) baselineValues.push((frame.paid / known) * 100);
            }
            const today = zoneRows.find((row) => row.businessDate === evaluationDate);
            if (today === undefined) continue;
            const knownToday = today.paid + today.notPaid;
            if (knownToday === 0) continue;
            await record(
              rule,
              evaluateAnomalyRule({
                rule,
                subjectType: "zone",
                subjectId: zoneId,
                observed: (today.paid / knownToday) * 100,
                baselineValues,
              }),
            );
          }
        }

        // Scans per officer, moving away from the mean in either direction.
        if (rule.key === "officer_scan_volume_change") {
          const rows = await checks.officerScanCounts(
            input.tenantId,
            window.windowStart,
            evaluationDate,
          );
          const perSubject = baselineSeries(
            window.windowStart,
            window.windowEnd,
            rows.map((row) => ({
              subjectId: row.officerUserId,
              businessDate: row.businessDate,
              value: row.count,
            })),
          );
          for (const [subjectId, baselineValues] of perSubject) {
            const observedAt = rows.find(
              (row) => row.officerUserId === subjectId && row.businessDate === evaluationDate,
            );
            await record(
              rule,
              evaluateAnomalyRule({
                rule,
                subjectType: "officer",
                subjectId,
                observed: observedAt?.count ?? 0,
                baselineValues,
              }),
            );
          }
        }

        // Suspense standing above the configured ceiling, right now.
        if (rule.key === "suspense_growth") {
          const totals = await checks.suspenseTotals(input.tenantId);
          await record(
            rule,
            evaluateAnomalyRule({
              rule,
              subjectType: "tenant",
              subjectId: input.tenantId,
              observed: Number(totals.paymentsMinor) + Number(totals.depositsMinor),
              baselineValues: [],
            }),
          );
        }
      }

      return created;
    });
  }
}

/**
 * One baseline value-list per subject across the window days strictly before
 * the evaluation day, every day present (zero where nothing happened).
 */
function baselineSeries(
  windowStart: BusinessDate,
  windowEnd: BusinessDate,
  rows: readonly { subjectId: string; businessDate: string; value: number }[],
): Map<string, number[]> {
  const days: BusinessDate[] = [];
  for (let day = windowStart; day <= windowEnd; day = addDays(day, 1)) days.push(day);
  const perSubject = new Map<string, number[]>();
  for (const row of rows) {
    if (row.businessDate < windowStart || row.businessDate > windowEnd) continue;
    const values = perSubject.get(row.subjectId) ?? days.map(() => 0);
    const index = days.indexOf(businessDate(row.businessDate));
    if (index >= 0) values[index] = row.value;
    perSubject.set(row.subjectId, values);
  }
  return perSubject;
}

function groupRows<T extends { businessDate: string }>(
  rows: readonly T[],
  keyOf: (row: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const list = grouped.get(keyOf(row)) ?? [];
    list.push(row);
    grouped.set(keyOf(row), list);
  }
  return grouped;
}
