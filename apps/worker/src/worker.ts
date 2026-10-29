import { createOtelTelemetry } from "@tpirs/adapters-otel-telemetry";
import { createEnvSecretsProvider } from "@tpirs/adapters-env-secrets";
import {
  createChannelDeliveryService,
  createChannelOutboxSweeper,
  CHANNEL_DELIVERY_QUEUE,
  createCashDeadlineSweeper,
  createCashWalletService,
  createReconciliationJobRunner,
  createReconciliationScheduler,
  createSmsDeliveryService,
  createSmsOutboxSweeper,
  RECONCILIATION_RUN_QUEUE,
  SMS_DELIVERY_QUEUE,
} from "@tpirs/application";
import type { ScheduledTenant } from "@tpirs/application";
import { createChannelProviderFactory } from "@tpirs/channel-providers";
import type { ChannelProviderFactory } from "@tpirs/channel-providers";
import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";
import { createDb, repositories, withSystem } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { createPostgresJobQueue } from "@tpirs/job-queue-postgres";
import { createMockSmsProvider } from "@tpirs/sms-provider-mock";
import type { SmsProvider, Telemetry } from "@tpirs/ports";

export interface WorkerDeps {
  readonly db: AnyDb;
  readonly sms: SmsProvider;
  readonly telemetry: Telemetry;
  /**
   * Resolves a tenant's configured channel adapters. When omitted, the single
   * injected `sms` port serves every tenant - useful for tests and for
   * single-aggregator deployments. The process composition root passes the
   * real factory so tenant config decides.
   */
  readonly channelProviders?: ChannelProviderFactory;
  /** How often the outbox is swept. Intake never knows a worker is listening. */
  readonly sweepIntervalMs?: number;
  /**
   * How often collection deadlines are swept (ADR 0033). Separate from the
   * outbox cadence because a sweep scans every cash-enabled tenant, which is
   * cheap per run but not something to do every few seconds.
   */
  readonly cashSweepIntervalMs?: number;
  /**
   * How often the reconciliation schedule is checked (D48). A tick is one
   * query per tenant plus one for the day's latest run, and the queue dedupes
   * the job, so a slow cadence is enough.
   */
  readonly reconciliationIntervalMs?: number;
  /**
   * The tenants the schedule check may consider. Defaults to every tenant; a
   * test (or a single-tenant deployment) can narrow it so a shared database
   * cannot schedule another suite's tenants.
   */
  readonly reconciliationTenants?: () => Promise<readonly ScheduledTenant[]>;
  /** The clock deadlines are measured against; injected by tests. */
  readonly now?: () => Date;
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

  /** Loads and validates one tenant's config; a broken config is reported, not retried. */
  async function configFor(tenantId: string): Promise<TenantConfig | undefined> {
    const row = await withSystem(db, async (tx) => repositories(tx).tenants.findById(tenantId));
    if (row === undefined) return undefined;
    try {
      return validateTenantConfig(row.config);
    } catch (error) {
      telemetry.captureError(error, { stage: "tenant-config", tenantId });
      return undefined;
    }
  }

  /** Resolves a tenant's configured sender id; a missing config means none. */
  async function senderIdFor(tenantId: string): Promise<string | undefined> {
    return (await configFor(tenantId))?.branding.smsSenderId;
  }

  const delivery = createSmsDeliveryService({ db, sms, senderIdFor, telemetry });
  const channelProviders = deps.channelProviders;

  /**
   * Resolves the SMS adapter a tenant's config enables. The fallback to the
   * injected port keeps a single-aggregator deployment - and every test - from
   * having to build a factory.
   */
  async function smsFor(tenantId: string): Promise<SmsProvider | undefined> {
    if (channelProviders === undefined) return sms;
    const config = await configFor(tenantId);
    if (config === undefined) return undefined;
    const adapters = await channelProviders.forTenant(config);
    return adapters.sms?.provider;
  }

  const channelDelivery = createChannelDeliveryService({ db, smsFor, senderIdFor, telemetry });
  const queue = createPostgresJobQueue({
    db,
    workerId: process.env.HOSTNAME ?? "worker",
  });

  // Delivering a receipt is one of two jobs this worker knows how to run. A job
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

  // Channel replies (USSD follow-ups and inbound-SMS answers) use their own
  // outbox and queue, so a retry storm on receipts cannot delay a driver's
  // status reply (ADR 0021).
  queue.registerHandler(CHANNEL_DELIVERY_QUEUE, async (payload) => {
    const job = payload as { tenantId?: unknown; messageId?: unknown };
    if (typeof job.tenantId !== "string" || typeof job.messageId !== "string") {
      telemetry.log("error", "channel.deliver job is malformed", {
        payload: JSON.stringify(payload),
      });
      return;
    }
    const result = await channelDelivery.deliver(job.tenantId, job.messageId);
    if (result.outcome === "failed") {
      throw new Error(`Channel delivery failed: ${result.error ?? "unknown error"}`);
    }
  });

  const sweeper = createSmsOutboxSweeper({ db, queue, telemetry });
  const channelSweeper = createChannelOutboxSweeper({ db, queue, telemetry });

  // One job is one tenant-day: reconcile, then evaluate the tenant's enabled
  // anomaly rules. The service records a failed attempt before the error is
  // rethrown, so the queue retries and the schedule check sees an open day.
  const runReconciliationJob = createReconciliationJobRunner({
    db,
    loadConfig: configFor,
    telemetry,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  queue.registerHandler(RECONCILIATION_RUN_QUEUE, async (payload) => {
    await runReconciliationJob(payload);
  });

  const reconciliationScheduler = createReconciliationScheduler({
    db,
    queue,
    telemetry,
    ...(deps.reconciliationTenants === undefined ? {} : { tenants: deps.reconciliationTenants }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });

  // The deadline sweeper needs wallet transitions only, not the fee engine that
  // intake pricing needs, so it takes the wallet service directly. It runs on
  // its own timer: a sweep is one query per cash-enabled tenant, and running it
  // twice changes nothing, which is why it needs no queue and no retries.
  const cashSweeper = createCashDeadlineSweeper({
    db,
    cash: createCashWalletService({ db, ...(deps.now === undefined ? {} : { now: deps.now }) }),
    telemetry,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });

  const sweepIntervalMs = deps.sweepIntervalMs ?? 5_000;
  const cashSweepIntervalMs = deps.cashSweepIntervalMs ?? 60_000;
  const reconciliationIntervalMs = deps.reconciliationIntervalMs ?? 60_000;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let cashTimer: ReturnType<typeof setInterval> | undefined;
  let reconciliationTimer: ReturnType<typeof setInterval> | undefined;

  async function sweepAll(): Promise<void> {
    await sweeper.sweep();
    await channelSweeper.sweep();
  }

  async function sweepCash(): Promise<void> {
    const summary = await cashSweeper.sweep();
    if (summary.flagged > 0 || summary.frozen > 0) {
      telemetry.log("info", "cash deadline sweep", { ...summary });
    }
  }

  async function checkReconciliationSchedule(): Promise<void> {
    const summary = await reconciliationScheduler.tick();
    if (summary.enqueued > 0) {
      telemetry.log("info", "reconciliation schedule", { ...summary });
    }
  }

  async function start(): Promise<void> {
    await queue.start();
    sweepTimer = setInterval(() => {
      void sweepAll().catch((error: unknown) => {
        telemetry.captureError(error, { stage: "outbox-sweep" });
      });
    }, sweepIntervalMs);
    cashTimer = setInterval(() => {
      void sweepCash().catch((error: unknown) => {
        telemetry.captureError(error, { stage: "cash-deadline-sweep" });
      });
    }, cashSweepIntervalMs);
    reconciliationTimer = setInterval(() => {
      void checkReconciliationSchedule().catch((error: unknown) => {
        telemetry.captureError(error, { stage: "reconciliation-schedule" });
      });
    }, reconciliationIntervalMs);
    await sweepAll();
    await sweepCash();
    await checkReconciliationSchedule();
    telemetry.log("info", "worker started", {
      queues: `${SMS_DELIVERY_QUEUE},${CHANNEL_DELIVERY_QUEUE},${RECONCILIATION_RUN_QUEUE}`,
    });
  }

  async function stop(): Promise<void> {
    if (sweepTimer !== undefined) {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
    }
    if (cashTimer !== undefined) {
      clearInterval(cashTimer);
      cashTimer = undefined;
    }
    if (reconciliationTimer !== undefined) {
      clearInterval(reconciliationTimer);
      reconciliationTimer = undefined;
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
  const channelProviders = createChannelProviderFactory({ secrets: createEnvSecretsProvider() });
  return { worker: createWorker({ db, sms, telemetry, channelProviders }), db };
}
