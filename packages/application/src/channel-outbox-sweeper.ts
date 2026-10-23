import { listPendingChannelMessages } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import type { JobQueue, Telemetry } from "@tpirs/ports";

/** The queue name channel delivery jobs are enqueued on. */
export const CHANNEL_DELIVERY_QUEUE = "channel.deliver";

/** Payload of one channel-delivery job. */
export interface ChannelDeliveryJob {
  readonly tenantId: string;
  readonly messageId: string;
}

export interface ChannelOutboxSweeperDeps {
  readonly db: AnyDb;
  readonly queue: JobQueue;
  /** Messages enqueued per sweep. Bounded so one sweep cannot hog the queue. */
  readonly batchSize?: number;
  readonly telemetry?: Telemetry;
}

export interface ChannelOutboxSweeper {
  /**
   * Enqueues one delivery job per pending channel-outbox row and returns how
   * many were enqueued. Safe to run as often as wanted: the job's dedupe key is
   * the message id, so a row already queued is not queued twice.
   */
  sweep(): Promise<number>;
}

/**
 * Moves queued SMS replies from the channel outbox onto the job queue (ADR 0021).
 *
 * A channel reply is rendered and committed while the provider is waiting, so
 * the row exists as soon as a command is handled. This sweeper is the only
 * thing that turns that row into work, and it does so at most once per row.
 * Delivery is a separate handler, so a slow gateway can never hold the callback
 * response or the transaction that recorded the inbound message.
 */
export function createChannelOutboxSweeper(deps: ChannelOutboxSweeperDeps): ChannelOutboxSweeper {
  const batchSize = deps.batchSize ?? 50;

  async function sweep(): Promise<number> {
    const pending = await listPendingChannelMessages(deps.db, batchSize);
    let enqueued = 0;
    for (const ref of pending) {
      if (ref.channel !== "sms") continue;
      const payload: ChannelDeliveryJob = {
        tenantId: ref.tenantId,
        messageId: ref.messageId,
      };
      await deps.queue.enqueue(CHANNEL_DELIVERY_QUEUE, payload, {
        dedupeKey: `channel:${ref.messageId}`,
      });
      enqueued += 1;
    }
    if (enqueued > 0) {
      deps.telemetry?.counter("channel.outbox.swept", enqueued);
    }
    return enqueued;
  }

  return { sweep };
}
