import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";
import { createDb, migrateUp, repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import type { JobQueue, Telemetry } from "@tpirs/ports";
import { cashConfig } from "./test-support/cash-day.js";
import {
  createReconciliationScheduler,
  RECONCILIATION_RUN_QUEUE,
} from "./reconciliation-scheduler.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../db/migrations");
const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

interface RecordingQueue extends JobQueue {
  readonly jobs: {
    readonly queue: string;
    readonly payload: unknown;
    readonly dedupeKey: string | undefined;
  }[];
  /** Frees live dedupe keys, as a completed/dead job would. */
  clearDedupe(): void;
}

/** A queue that records enqueues and dedupes while a key is live. */
function recordingQueue(): RecordingQueue {
  const jobs: { queue: string; payload: unknown; dedupeKey: string | undefined }[] = [];
  const live = new Set<string>();
  return {
    jobs,
    async enqueue(queue, payload, options = {}) {
      const key = options.dedupeKey;
      if (key !== undefined) {
        if (live.has(key)) return `existing-${key}`;
        live.add(key);
      }
      jobs.push({ queue, payload, dedupeKey: key });
      return `job-${String(jobs.length)}`;
    },
    registerHandler() {
      // The scheduler only enqueues; the worker owns handlers.
    },
    async start() {
      // No polling loop in the fake.
    },
    async stop() {
      // No polling loop in the fake.
    },
    clearDedupe() {
      live.clear();
    },
  };
}

const telemetry: Telemetry & { readonly errors: unknown[] } = (() => {
  const errors: unknown[] = [];
  return {
    errors,
    startSpan: () => ({
      setAttribute: () => undefined,
      recordException: () => undefined,
      end: () => undefined,
    }),
    counter: () => undefined,
    log: () => undefined,
    captureError: (error) => {
      errors.push(error);
    },
  };
})();

let tenantCounter = 0;

/** A tenant whose stored config is valid, so the scheduler can read it. */
async function makeScheduledTenant(
  db: AnyDb,
  options: {
    readonly schedule?: string;
    readonly enabled?: boolean;
    readonly timezone?: string;
  } = {},
): Promise<{ tenantId: string; config: TenantConfig }> {
  tenantCounter += 1;
  const stamp = `${Date.now().toString(36)}${tenantCounter.toString(36)}`;
  const slug = `sched${stamp}`.slice(0, 30);
  const base = cashConfig(slug);
  const config = validateTenantConfig({
    ...base,
    locale: { ...base.locale, timezone: options.timezone ?? "Etc/UTC" },
    reconciliation: {
      ...base.reconciliation,
      enabled: options.enabled ?? true,
      schedule: options.schedule ?? "0 2 * * *",
    },
  });
  const tenant = await withSystem(db, async (tx) =>
    repositories(tx).tenants.create({
      slug,
      name: "Scheduled",
      legalEntity: "Scheduled Revenue",
      config,
    }),
  );
  return { tenantId: tenant.id, config };
}

describeIntegration("reconciliation scheduler (integration)", () => {
  let db: AnyDb;

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await db.destroy();
  });

  it("waits for the schedule, then enqueues the business day that closed", async () => {
    const tenant = await makeScheduledTenant(db);
    const queue = recordingQueue();
    let at = new Date("2026-06-16T01:00:00Z");
    const scheduler = createReconciliationScheduler({
      db,
      queue,
      tenants: async () => [{ id: tenant.tenantId, config: tenant.config }],
      now: () => at,
      telemetry,
    });

    // Before 02:00 the day has not been scheduled yet.
    expect(await scheduler.tick()).toEqual({ tenants: 1, enqueued: 0 });

    at = new Date("2026-06-16T02:00:01Z");
    expect(await scheduler.tick()).toEqual({ tenants: 1, enqueued: 1 });
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.queue).toBe(RECONCILIATION_RUN_QUEUE);
    expect(queue.jobs[0]?.payload).toEqual({
      tenantId: tenant.tenantId,
      businessDate: "2026-06-15",
    });
    // The pair is the dedupe key, so a second worker cannot double-run it.
    expect(queue.jobs[0]?.dedupeKey).toBe(`${tenant.tenantId}:2026-06-15`);

    // A second tick while the job is live adds nothing.
    expect(await scheduler.tick()).toEqual({ tenants: 1, enqueued: 1 });
    expect(queue.jobs).toHaveLength(1);
  });

  it("does nothing when the tenant disabled reconciliation", async () => {
    const tenant = await makeScheduledTenant(db, { enabled: false });
    const queue = recordingQueue();
    const scheduler = createReconciliationScheduler({
      db,
      queue,
      tenants: async () => [{ id: tenant.tenantId, config: tenant.config }],
      now: () => new Date("2026-06-16T03:00:00Z"),
    });

    expect(await scheduler.tick()).toEqual({ tenants: 0, enqueued: 0 });
    expect(queue.jobs).toHaveLength(0);
  });

  it("does not enqueue a day that already completed or is running", async () => {
    const completed = await makeScheduledTenant(db);
    await withTenant(db, completed.tenantId, async (tx) => {
      const repos = repositories(tx);
      const run = await repos.reconciliation.createRun({
        tenantId: completed.tenantId,
        businessDate: "2026-06-15",
        toleranceMinor: 0n,
        feeToleranceMinor: 0n,
      });
      await repos.reconciliation.completeRun(completed.tenantId, run.id, {
        checklist: [],
        exceptionCount: 0,
        completedAt: new Date("2026-06-16T02:00:30Z"),
      });
    });

    const running = await makeScheduledTenant(db);
    await withTenant(db, running.tenantId, async (tx) => {
      await repositories(tx).reconciliation.createRun({
        tenantId: running.tenantId,
        businessDate: "2026-06-15",
        toleranceMinor: 0n,
        feeToleranceMinor: 0n,
      });
    });

    const queue = recordingQueue();
    const scheduler = createReconciliationScheduler({
      db,
      queue,
      tenants: async () => [
        { id: completed.tenantId, config: completed.config },
        { id: running.tenantId, config: running.config },
      ],
      now: () => new Date("2026-06-16T10:00:00Z"),
    });

    expect(await scheduler.tick()).toEqual({ tenants: 2, enqueued: 0 });
    expect(queue.jobs).toHaveLength(0);
  });

  it("enqueues the day again after a failed attempt", async () => {
    const tenant = await makeScheduledTenant(db);
    await withTenant(db, tenant.tenantId, async (tx) => {
      const repos = repositories(tx);
      const run = await repos.reconciliation.createRun({
        tenantId: tenant.tenantId,
        businessDate: "2026-06-15",
        toleranceMinor: 0n,
        feeToleranceMinor: 0n,
      });
      await repos.reconciliation.failRun(tenant.tenantId, run.id, {
        reason: "check computation failed",
        completedAt: new Date("2026-06-16T02:00:30Z"),
      });
    });

    const queue = recordingQueue();
    const scheduler = createReconciliationScheduler({
      db,
      queue,
      tenants: async () => [{ id: tenant.tenantId, config: tenant.config }],
      now: () => new Date("2026-06-16T02:05:00Z"),
    });

    expect(await scheduler.tick()).toEqual({ tenants: 1, enqueued: 1 });
    expect(queue.jobs[0]?.payload).toEqual({
      tenantId: tenant.tenantId,
      businessDate: "2026-06-15",
    });
  });

  it("reads the schedule in the tenant's timezone", async () => {
    const tenant = await makeScheduledTenant(db, { timezone: "Africa/Lagos" });
    const queue = recordingQueue();
    let at = new Date("2026-06-16T00:30:00Z"); // 01:30 in Lagos
    const scheduler = createReconciliationScheduler({
      db,
      queue,
      tenants: async () => [{ id: tenant.tenantId, config: tenant.config }],
      now: () => at,
    });

    expect(await scheduler.tick()).toEqual({ tenants: 1, enqueued: 0 });

    at = new Date("2026-06-16T01:00:05Z"); // 02:00:05 in Lagos
    expect(await scheduler.tick()).toEqual({ tenants: 1, enqueued: 1 });
    expect(queue.jobs[0]?.payload).toEqual({
      tenantId: tenant.tenantId,
      businessDate: "2026-06-15",
    });
  });

  it("reports a broken config and skips the tenant", async () => {
    const queue = recordingQueue();
    const scheduler = createReconciliationScheduler({
      db,
      queue,
      tenants: async () => [{ id: "00000000-0000-0000-0000-000000000000", config: {} }],
      now: () => new Date("2026-06-16T03:00:00Z"),
      telemetry,
    });
    const before = telemetry.errors.length;

    expect(await scheduler.tick()).toEqual({ tenants: 0, enqueued: 0 });
    expect(queue.jobs).toHaveLength(0);
    expect(telemetry.errors.length).toBe(before + 1);
  });
});
