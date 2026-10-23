import { createOtelTelemetry } from "@tpirs/adapters-otel-telemetry";
import { createEnvSecretsProvider } from "@tpirs/adapters-env-secrets";
import {
  createChannelDeliveryService,
  createChannelOutboxSweeper,
  CHANNEL_DELIVERY_QUEUE,
  createSmsDeliveryService,
  createSmsOutboxSweeper,
  SMS_DELIVERY_QUEUE,
} from "@tpirs/application";
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
  const sweepIntervalMs = deps.sweepIntervalMs ?? 5_000;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;

  async function sweepAll(): Promise<void> {
    await sweeper.sweep();
    await channelSweeper.sweep();
  }

  async function start(): Promise<void> {
    await queue.start();
    sweepTimer = setInterval(() => {
      void sweepAll().catch((error: unknown) => {
        telemetry.captureError(error, { stage: "outbox-sweep" });
      });
    }, sweepIntervalMs);
    await sweepAll();
    telemetry.log("info", "worker started", {
      queues: `${SMS_DELIVERY_QUEUE},${CHANNEL_DELIVERY_QUEUE}`,
    });
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
  const channelProviders = createChannelProviderFactory({ secrets: createEnvSecretsProvider() });
  return { worker: createWorker({ db, sms, telemetry, channelProviders }), db };
}
