import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";
import { repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { addDays, businessDayRange, todayInTimeZone } from "@tpirs/domain";
import type { JobQueue, Telemetry } from "@tpirs/ports";
import { nextOccurrence } from "./next-occurrence.js";

/**
 * The nightly reconciliation schedule check (D48, ADR 0040).
 *
 * The worker keeps one timer; on every tick this asks, per tenant, whether the
 * schedule for the business day that just closed has come due. If it has and no
 * completed (or running) attempt exists for that day, it enqueues
 * `(tenantId, businessDate)` on the ordinary job queue. The queue's dedupe key
 * is the same pair, so two workers ticking at once enqueue one job, and the run
 * itself is append-only and idempotent on top of that.
 *
 * Nothing here computes reconciliation: the job handler does, on the queue,
 * with its own retries. A tick that finds work already done is silent.
 */

export const RECONCILIATION_RUN_QUEUE = "reconciliation:run";

export interface ReconciliationJobPayload {
  readonly tenantId: string;
  readonly businessDate: string;
}

/** Parses a queue payload, rejecting anything that could not be a job. */
export function parseReconciliationJobPayload(
  payload: unknown,
): ReconciliationJobPayload | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const candidate = payload as { tenantId?: unknown; businessDate?: unknown };
  if (typeof candidate.tenantId !== "string" || candidate.tenantId === "") return undefined;
  if (typeof candidate.businessDate !== "string" || candidate.businessDate === "") return undefined;
  return { tenantId: candidate.tenantId, businessDate: candidate.businessDate };
}

/** A tenant to consider: its id and its stored (still unvalidated) config. */
export interface ScheduledTenant {
  readonly id: string;
  readonly config: unknown;
}

export interface ReconciliationSchedulerDeps {
  readonly db: AnyDb;
  readonly queue: JobQueue;
  /**
   * Tenants to consider, with their stored config. Defaults to every tenant,
   * read in one system transaction, because the worker has no tenant to scan
   * with. Config is validated in process, once per tenant per tick.
   */
  readonly tenants?: () => Promise<readonly ScheduledTenant[]>;
  readonly now?: () => Date;
  readonly telemetry?: Telemetry;
}

export interface ReconciliationScheduler {
  /** Runs one schedule check. Safe to run as often as wanted. */
  tick(): Promise<{ tenants: number; enqueued: number }>;
}

export function createReconciliationScheduler(
  deps: ReconciliationSchedulerDeps,
): ReconciliationScheduler {
  const now = deps.now ?? (() => new Date());
  const listTenants =
    deps.tenants ??
    (async () =>
      withSystem(deps.db, async (tx) =>
        (await repositories(tx).tenants.list()).map((tenant) => ({
          id: tenant.id,
          config: tenant.config,
        })),
      ));

  async function tick(): Promise<{ tenants: number; enqueued: number }> {
    const at = now();
    let examined = 0;
    let enqueued = 0;

    for (const tenant of await listTenants()) {
      // A present-but-broken config is reported and skipped, never guessed at.
      let config: TenantConfig | undefined;
      try {
        config = validateTenantConfig(tenant.config);
      } catch (error) {
        deps.telemetry?.captureError(error, {
          stage: "reconciliation-schedule",
          tenantId: tenant.id,
        });
        continue;
      }
      if (!config.reconciliation.enabled) continue;
      examined += 1;

      const { timezone } = config.locale;
      const today = todayInTimeZone(timezone, at);
      const businessDate = addDays(today, -1);
      const dayStart = businessDayRange(timezone, today).start;
      // The occurrence that reconciles `businessDate` is the first one after
      // the day closed. `dayStart - 1ms` keeps a midnight schedule inside
      // today's window instead of pushing it to tomorrow.
      const dueAt = nextOccurrence(
        config.reconciliation.schedule,
        new Date(dayStart.getTime() - 1),
        timezone,
      );
      if (dueAt === undefined || dueAt.getTime() > at.getTime()) continue;

      const latest = await withTenant(deps.db, tenant.id, async (tx) =>
        repositories(tx).reconciliation.findLatest(tenant.id, businessDate),
      );
      // Completed and signed-off days are done; a running attempt is in flight.
      // Only a missing or failed day is enqueued again, which is what makes a
      // failed run retry on the next tick without duplicating a good one.
      if (
        latest !== undefined &&
        (latest.status === "completed" ||
          latest.status === "signed_off" ||
          latest.status === "running")
      ) {
        continue;
      }

      await deps.queue.enqueue(
        RECONCILIATION_RUN_QUEUE,
        { tenantId: tenant.id, businessDate } satisfies ReconciliationJobPayload,
        { dedupeKey: `${tenant.id}:${businessDate}`, maxAttempts: 5 },
      );
      enqueued += 1;
    }

    if (enqueued > 0) {
      deps.telemetry?.counter("reconciliation.schedule.enqueued", enqueued);
      deps.telemetry?.log("info", "reconciliation scheduled", { tenants: examined, enqueued });
    }
    return { tenants: examined, enqueued };
  }

  return { tick };
}
