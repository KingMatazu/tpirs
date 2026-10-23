import { createOtelTelemetry } from "@tpirs/adapters-otel-telemetry";
import {
  createSmsDeliveryService,
  createSmsOutboxSweeper,
  SMS_DELIVERY_QUEUE,
} from "@tpirs/application";
import { validateTenantConfig } from "@tpirs/config";
import { createDb, repositories, withSystem } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { createPostgresJobQueue } from "@tpirs/job-queue-postgres";
import { createMockSmsProvider } from "@tpirs/sms-provider-mock";
import type { SmsProvider, Telemetry } from "@tpirs/ports";

export interface WorkerDeps {
  readonly db: AnyDb;
  readonly sms: SmsProvider;
  readonly telemetry: Telemetry;
  /** How often the outbox is swept. Intake never knows a worker is listening. */
  readonly sweepIntervalMs?: number;
}

export interface Worker {
  /** Runs one sweep and starts the queue and its timer. */
  start(): Promise<void>;
  /** Ends the sweep timer and the polling loop. */
  stop(): Promise<void>;
}

/**
 * Wires the background worker: a Postgres job queue, the receipt-outbox sweeper
 * that puts rendered messages onto it, and the delivery handler that sends them
 * (ADR 0020).
 *
 * Deliberately importable and side-effect free so it can be started by
 * `src/main.ts` and exercised by a test without touching the network or the
 * process lifecycle.
 */
export function createWorker(deps: WorkerDeps): Worker {
  const { db, sms, telemetry } = deps;

  /** Resolves a tenant's configured sender id; a missing config means none. */
  async function senderIdFor(tenantId: string): Promise<string | undefined> {
    const row = await withSystem(db, async (tx) => repositories(tx).tenants.findById(tenantId));
    if (row === undefined) return undefined;
    try {
      return validateTenantConfig(row.config).branding.smsSenderId;
    } catch (error) {
      telemetry.captureError(error, { stage: "tenant-config", tenantId });
      return undefined;
    }
  }

  const delivery = createSmsDeliveryService({ db, sms, senderIdFor, telemetry });
  const queue = createPostgresJobQueue({
    db,
    workerId: process.env.HOSTNAME ?? "worker",
  });

  // Delivering a receipt is the only job this worker knows how to run yet. A job
  // on a queue nobody can run is never claimed, so registering a handler is what
  // makes a queue live.
  queue.registerHandler(SMS_DELIVERY_QUEUE, async (payload) => {
    const job = payload as { tenantId?: unknown; smsId?: unknown };
    if (typeof job.tenantId !== "string" || typeof job.smsId !== "string") {
      // A malformed job can never succeed, so retrying it would only burn
      // attempts; it is reported and dropped.
      telemetry.log("error", "sms.deliver job is malformed", {
        payload: JSON.stringify(payload),
      });
      return;
    }
    const result = await delivery.deliver(job.tenantId, job.smsId);
    if (result.outcome === "failed") {
      // Throwing hands the message back to the queue, which owns the retry and
      // its backoff; the outbox row already records why this attempt failed.
      throw new Error(`SMS delivery failed: ${result.error ?? "unknown error"}`);
    }
  });

  const sweeper = createSmsOutboxSweeper({ db, queue, telemetry });
  const sweepIntervalMs = deps.sweepIntervalMs ?? 5_000;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;

  async function start(): Promise<void> {
    await queue.start();
    sweepTimer = setInterval(() => {
      void sweeper.sweep().catch((error: unknown) => {
        telemetry.captureError(error, { stage: "sms-sweep" });
      });
    }, sweepIntervalMs);
    await sweeper.sweep();
    telemetry.log("info", "worker started", { queue: SMS_DELIVERY_QUEUE });
  }

  async function stop(): Promise<void> {
    if (sweepTimer !== undefined) {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
    }
    await queue.stop();
  }

  return { start, stop };
}

/** Composition root used by the process entry point. */
export function createDefaultWorker(): { worker: Worker; db: AnyDb } {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("Missing required environment variable: DATABASE_URL");
  }
  const db = createDb({ connectionString: databaseUrl });
  const telemetry = createOtelTelemetry({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "tpirs-worker",
  });
  // Only a mock gateway exists today; the real aggregator adapter arrives with
  // its own phase, and swapping it is a change here and nowhere else.
  const sms: SmsProvider = createMockSmsProvider();
  return { worker: createWorker({ db, sms, telemetry }), db };
}
