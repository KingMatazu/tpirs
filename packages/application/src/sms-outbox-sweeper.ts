import { listPendingSms } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import type { JobQueue, Telemetry } from "@tpirs/ports";

/** The queue name receipt delivery jobs are enqueued on. */
export const SMS_DELIVERY_QUEUE = "sms.deliver";

/** Payload of one receipt-delivery job. */
export interface SmsDeliveryJob {
  readonly tenantId: string;
  readonly smsId: string;
}

export interface SmsOutboxSweeperDeps {
  readonly db: AnyDb;
  readonly queue: JobQueue;
  /** Messages enqueued per sweep. Bounded so one sweep cannot hog the queue. */
  readonly batchSize?: number;
  readonly telemetry?: Telemetry;
}

export interface SmsOutboxSweeper {
  /**
   * Enqueues one delivery job per pending outbox row and returns how many were
   * enqueued. Safe to run as often as wanted: the job's dedupe key is the
   * message id, so a row already queued is not queued twice.
   */
  sweep(): Promise<number>;
}

/**
 * Moves rendered receipts from the `sms_log` outbox onto the job queue (ADR 0020).
 *
 * Intake already committed the message body in the same transaction as the
 * payment, so a receipt exists as soon as a payment settles. This sweeper is the
 * only thing that turns that row into work, and it does so at most once per row.
 * Delivery itself is a separate handler, so a slow SMS gateway can never hold the
 * payment transaction or the webhook response (ADR 0016).
 */
export function createSmsOutboxSweeper(deps: SmsOutboxSweeperDeps): SmsOutboxSweeper {
  const batchSize = deps.batchSize ?? 50;

  async function sweep(): Promise<number> {
    const pending = await listPendingSms(deps.db, batchSize);
    let enqueued = 0;
    for (const ref of pending) {
      const payload: SmsDeliveryJob = { tenantId: ref.tenantId, smsId: ref.smsId };
      await deps.queue.enqueue(SMS_DELIVERY_QUEUE, payload, {
        // One delivery job per message, forever: a second sweep, or a second
        // worker, resolves to the same job id instead of sending twice.
        dedupeKey: `sms:${ref.smsId}`,
      });
      enqueued += 1;
    }
    if (enqueued > 0) {
      deps.telemetry?.counter("sms.outbox.swept", enqueued);
    }
    return enqueued;
  }

  return { sweep };
}
