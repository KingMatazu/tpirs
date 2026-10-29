import { describe, expect, it } from "vitest";
import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";
import type { Telemetry } from "@tpirs/ports";
import { cashConfig } from "./test-support/cash-day.js";
import { createReconciliationJobRunner, reconciliationTolerances } from "./reconciliation-job.js";
import type { AnomalyEvaluationInput, ReconciliationJobRun } from "./reconciliation-job.js";
import type { ReconciliationRunInput } from "./reconciliation-service.js";

function jobConfig(overrides: { anomalyAlerts?: boolean } = {}): TenantConfig {
  const base = cashConfig(`job${Date.now().toString(36)}`.slice(0, 30));
  return validateTenantConfig({
    ...base,
    featureFlags: { ...base.featureFlags, anomalyAlerts: overrides.anomalyAlerts ?? true },
    reconciliation: {
      ...base.reconciliation,
      toleranceMinor: 5,
      feeToleranceMinor: 250,
      suspenseAgeingDays: 5,
      anomalyRules: [
        {
          key: "collector_volume_drop",
          enabled: true,
          windowDays: 14,
          thresholdPercent: 30,
          severity: "warning",
        },
        {
          key: "suspense_growth",
          enabled: false,
          windowDays: 7,
          thresholdMinor: 500_000,
          severity: "warning",
        },
      ],
    },
  });
}

interface Harness {
  readonly runs: ReconciliationRunInput[];
  readonly evaluations: AnomalyEvaluationInput[];
  readonly errors: unknown[];
  readonly logs: { level: string; message: string }[];
  readonly runner: ReturnType<typeof createReconciliationJobRunner>;
}

function harness(
  options: {
    readonly config?: TenantConfig | undefined;
    readonly failRun?: Error;
    readonly now?: () => Date;
  } = {},
): Harness {
  const runs: ReconciliationRunInput[] = [];
  const evaluations: AnomalyEvaluationInput[] = [];
  const errors: unknown[] = [];
  const logs: { level: string; message: string }[] = [];
  const telemetry: Telemetry = {
    startSpan: () => ({
      setAttribute: () => undefined,
      recordException: () => undefined,
      end: () => undefined,
    }),
    counter: () => undefined,
    log: (level, message) => {
      logs.push({ level, message });
    },
    captureError: (error) => {
      errors.push(error);
    },
  };
  const config = "config" in options ? options.config : jobConfig();

  const runner = createReconciliationJobRunner({
    db: {} as never,
    loadConfig: () => Promise.resolve(config),
    telemetry,
    ...(options.now === undefined ? {} : { now: options.now }),
    reconciliation: {
      async run(input): Promise<ReconciliationJobRun> {
        runs.push(input);
        if (options.failRun !== undefined) throw options.failRun;
        return { id: "run-1", runSeq: 1, exceptionCount: 0 };
      },
    },
    anomalies: {
      async evaluateForRun(input): Promise<readonly unknown[]> {
        evaluations.push(input);
        return [{ id: "anomaly-1" }];
      },
    },
  });

  return { runs, evaluations, errors, logs, runner };
}

describe("reconciliation job runner", () => {
  it("reconciles the payload day with the tenant's tolerances, then evaluates enabled rules", async () => {
    const h = harness();
    const result = await h.runner({
      tenantId: "tenant-1",
      businessDate: "2026-06-15",
    });

    expect(result).toEqual({
      tenantId: "tenant-1",
      businessDate: "2026-06-15",
      runId: "run-1",
      anomalies: 1,
    });
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({
      tenantId: "tenant-1",
      businessDate: "2026-06-15",
      timeZone: "Etc/UTC",
      actor: { kind: "system" },
      tolerances: {
        toleranceMinor: 5n,
        feeToleranceMinor: 250n,
        depositDeadlineHours: 8,
        suspenseAgeingDays: 5,
      },
    });

    expect(h.evaluations).toHaveLength(1);
    expect(h.evaluations[0]?.depositDeadlineHours).toBe(8);
    // Only the enabled rule reaches the domain; disabled ones stay in config.
    expect(h.evaluations[0]?.rules).toEqual([
      { key: "collector_volume_drop", severity: "warning", windowDays: 14, thresholdPercent: 30 },
    ]);
  });

  it("skips anomaly evaluation when the tenant silenced alerts", async () => {
    const h = harness({ config: jobConfig({ anomalyAlerts: false }) });
    const result = await h.runner({ tenantId: "tenant-1", businessDate: "2026-06-15" });

    expect(result?.anomalies).toBe(0);
    expect(h.runs).toHaveLength(1);
    expect(h.evaluations).toHaveLength(0);
  });

  it("drops a malformed payload without touching the services", async () => {
    const h = harness();
    expect(await h.runner({ tenantId: 42 })).toBeUndefined();
    expect(await h.runner("not-a-job")).toBeUndefined();
    expect(h.runs).toHaveLength(0);
    expect(h.errors).toHaveLength(0);
    expect(h.logs.some((entry) => entry.level === "error")).toBe(true);
  });

  it("drops a job for a tenant with no usable config", async () => {
    const h = harness({ config: undefined });
    expect(await h.runner({ tenantId: "tenant-1", businessDate: "2026-06-15" })).toBeUndefined();
    expect(h.runs).toHaveLength(0);
  });

  it("reports a failed run and rethrows so the queue retries", async () => {
    const failure = new Error("check computation failed");
    const h = harness({ failRun: failure });

    await expect(h.runner({ tenantId: "tenant-1", businessDate: "2026-06-15" })).rejects.toBe(
      failure,
    );
    expect(h.errors).toEqual([failure]);
    expect(h.evaluations).toHaveLength(0);
  });

  it("converts config tolerances to exact minor units", () => {
    const tolerances = reconciliationTolerances(jobConfig());
    expect(tolerances).toEqual({
      toleranceMinor: 5n,
      feeToleranceMinor: 250n,
      depositDeadlineHours: 8,
      suspenseAgeingDays: 5,
    });
  });
});
