import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import type { SmsProvider, Telemetry } from "@tpirs/ports";
import { PortError } from "@tpirs/ports";

/** Why a channel delivery attempt ended the way it did, for logs and tests. */
export type ChannelDeliveryOutcome =
  "sent" | "failed" | "already_delivered" | "missing" | "unsupported" | "no_adapter";

export interface ChannelDeliveryResult {
  readonly outcome: ChannelDeliveryOutcome;
  readonly providerMessageId?: string;
  readonly error?: string;
}

export interface ChannelDeliveryServiceDeps {
  readonly db: AnyDb;
  /**
   * Resolves the tenant's configured SMS adapter. Tenant config decides which
   * adapter sits behind the port; this service only asks for the result, so a
   * tenant can switch aggregator without a core change.
   */
  readonly smsFor: (tenantId: string) => Promise<SmsProvider | undefined>;
  readonly senderIdFor?: (tenantId: string) => Promise<string | undefined>;
  readonly telemetry?: Telemetry;
}

export interface ChannelDeliveryService {
  /** Delivers one outbound channel message. Safe to call twice. */
  deliver(tenantId: string, messageId: string): Promise<ChannelDeliveryResult>;
}

/**
 * Sends one rendered channel-outbox row through the `SmsProvider` port.
 *
 * A reply body is fixed when it is enqueued, so delivery never reads tenant
 * config or recomputes an answer. The external send happens **outside** the
 * database transaction that claimed the row: a slow gateway must never hold a
 * transaction open, and the row's own status records the outcome.
 *
 * Only SMS rows are deliverable today. A USSD row is rendered into the
 * provider's HTTP response synchronously and is never left pending, so finding
 * one is a bug rather than a retryable failure; it is reported, not retried.
 */
export function createChannelDeliveryService(
  deps: ChannelDeliveryServiceDeps,
): ChannelDeliveryService {
  async function deliver(tenantId: string, messageId: string): Promise<ChannelDeliveryResult> {
    const row = await withTenant(deps.db, tenantId, async (tx) =>
      repositories(tx).channelMessages.findById(tenantId, messageId),
    );
    if (row === undefined) return { outcome: "missing" };
    if (row.direction !== "outbound" || row.channel !== "sms") {
      return { outcome: "unsupported", error: `${row.direction}/${row.channel}` };
    }
    if (row.status === "sent") return { outcome: "already_delivered" };

    const provider = await deps.smsFor(tenantId);
    if (provider === undefined) {
      const error = "tenant has no SMS adapter";
      await withTenant(deps.db, tenantId, async (tx) =>
        repositories(tx).channelMessages.markFailed(tenantId, row.id, error),
      );
      deps.telemetry?.counter("channel.delivery", 1, { outcome: "no_adapter", kind: row.kind });
      return { outcome: "no_adapter", error };
    }

    const senderId = await deps.senderIdFor?.(tenantId);
    try {
      const result = await provider.send({
        to: row.recipient,
        text: row.body,
        idempotencyKey: `channel:${row.id}`,
        ...(senderId === undefined ? {} : { senderId }),
      });
      await withTenant(deps.db, tenantId, async (tx) =>
        repositories(tx).channelMessages.markSent(tenantId, row.id, result.providerMessageId),
      );
      deps.telemetry?.counter("channel.delivery", 1, { outcome: "sent", kind: row.kind });
      return { outcome: "sent", providerMessageId: result.providerMessageId };
    } catch (error) {
      const message = describeFailure(error);
      await withTenant(deps.db, tenantId, async (tx) =>
        repositories(tx).channelMessages.markFailed(tenantId, row.id, message),
      );
      deps.telemetry?.counter("channel.delivery", 1, {
        outcome: "failed",
        kind: row.kind,
        reason: message,
      });
      return { outcome: "failed", error: message };
    }
  }

  return { deliver };
}

/** A short, log-safe description of a failed send. */
function describeFailure(error: unknown): string {
  if (error instanceof PortError) return `${error.port}:${error.code}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
