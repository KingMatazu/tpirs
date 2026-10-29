import { enabledAnomalyRules } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";
import { businessDate } from "@tpirs/domain";
import type { AnomalyRule } from "@tpirs/domain";
import type { AnyDb } from "@tpirs/db";
import type { Telemetry } from "@tpirs/ports";
import { AnomalyService } from "./anomaly-service.js";
import { ReconciliationService } from "./reconciliation-service.js";
import type { ReconciliationRunInput, ReconciliationTolerances } from "./reconciliation-service.js";
import {
  parseReconciliationJobPayload,
  RECONCILIATION_RUN_QUEUE,
} from "./reconciliation-scheduler.js";

/**
 * The `reconciliation:run` job (D41/D46, ADR 0037/0039).
 *
 * One job is one tenant-day: run the reconciliation, then evaluate the tenant's
 * enabled anomaly rules against the same day. Both are already idempotent —
 * a re-run opens `run_seq + 1` and an anomaly is deduped per window — so a
 * retried job cannot corrupt history; it can only add an attempt.
 *
 * Failures are the queue's business: the service records a `failed` run and
 * this runner reports the error and rethrows, so the queue retries and the
 * scheduler re-enqueues on its next tick while the day still has no completed
 * run. A malformed payload or a missing config is dropped instead, because no
 * amount of retrying can fix it.
 */

/** The part of a completed run the job reports; the real row is richer. */
export interface ReconciliationJobRun {
  readonly id: string;
  readonly runSeq: number;
  readonly exceptionCount: number;
}

/** The anomaly evaluation input, structurally (see `AnomalyService`). */
export interface AnomalyEvaluationInput {
  readonly tenantId: string;
  readonly businessDate: string;
  readonly rules: readonly AnomalyRule[];
  readonly depositDeadlineHours: number;
}

export interface ReconciliationJobDeps {
  readonly db: AnyDb;
  readonly loadConfig: (tenantId: string) => Promise<TenantConfig | undefined>;
  readonly telemetry?: Telemetry;
  readonly now?: () => Date;
  /** Injectable for tests; defaults to the real services bound to `db`. */
  readonly reconciliation?: {
    run(input: ReconciliationRunInput): Promise<ReconciliationJobRun>;
  };
  readonly anomalies?: {
    evaluateForRun(input: AnomalyEvaluationInput): Promise<readonly unknown[]>;
  };
}

export interface ReconciliationJobResult {
  readonly tenantId: string;
  readonly businessDate: string;
  readonly runId: string;
  readonly anomalies: number;
}

/** Tolerances come from config, converted to exact minor units. */
export function reconciliationTolerances(config: TenantConfig): ReconciliationTolerances {
  return {
    toleranceMinor: BigInt(config.reconciliation.toleranceMinor),
    feeToleranceMinor: BigInt(config.reconciliation.feeToleranceMinor),
    depositDeadlineHours: config.cashRules.depositDeadlineHours,
    suspenseAgeingDays: config.reconciliation.suspenseAgeingDays,
  };
}

export function createReconciliationJobRunner(
  deps: ReconciliationJobDeps,
): (payload: unknown) => Promise<ReconciliationJobResult | undefined> {
  const reconciliation =
    deps.reconciliation ??
    new ReconciliationService({
      db: deps.db,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
  const anomalies =
    deps.anomalies ??
    new AnomalyService({
      db: deps.db,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.telemetry === undefined ? {} : { telemetry: deps.telemetry }),
    });

  return async function runReconciliationJob(
    payload: unknown,
  ): Promise<ReconciliationJobResult | undefined> {
    const job = parseReconciliationJobPayload(payload);
    if (job === undefined) {
      // A malformed job can never succeed; retrying it would only burn attempts.
      deps.telemetry?.log("error", `${RECONCILIATION_RUN_QUEUE} job is malformed`, {
        payload: JSON.stringify(payload),
      });
      return undefined;
    }

    const config = await deps.loadConfig(job.tenantId);
    if (config === undefined) {
      deps.telemetry?.log("error", "reconciliation job has no usable tenant config", {
        tenantId: job.tenantId,
      });
      return undefined;
    }
    if (!config.reconciliation.enabled) {
      deps.telemetry?.log("info", "reconciliation job skipped: tenant disabled it", {
        tenantId: job.tenantId,
      });
      return undefined;
    }

    const date = businessDate(job.businessDate);
    try {
      const run = await reconciliation.run({
        tenantId: job.tenantId,
        businessDate: date,
        timeZone: config.locale.timezone,
        tolerances: reconciliationTolerances(config),
        actor: { kind: "system" },
      });

      // Anomalies are advisories evaluated after the day is recorded. The
      // feature flag can silence them without deleting the rule config.
      let raised = 0;
      if (config.featureFlags.anomalyAlerts) {
        const events = await anomalies.evaluateForRun({
          tenantId: job.tenantId,
          businessDate: date,
          rules: enabledAnomalyRules(config),
          depositDeadlineHours: config.cashRules.depositDeadlineHours,
        });
        raised = events.length;
      }

      deps.telemetry?.log("info", "reconciliation run completed", {
        tenantId: job.tenantId,
        businessDate: date,
        runId: run.id,
        runSeq: run.runSeq,
        exceptions: run.exceptionCount,
        anomalies: raised,
      });
      return {
        tenantId: job.tenantId,
        businessDate: date,
        runId: run.id,
        anomalies: raised,
      };
    } catch (error) {
      // The service already recorded a `failed` attempt; rethrow so the queue
      // owns the retry and the scheduler can see the day is still open.
      deps.telemetry?.captureError(error, {
        stage: "reconciliation-run",
        tenantId: job.tenantId,
        businessDate: job.businessDate,
      });
      throw error;
    }
  };
}
