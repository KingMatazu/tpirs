import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import type { SmsProvider, Telemetry } from "@tpirs/ports";
import { PortError } from "@tpirs/ports";

/** Why a delivery attempt ended the way it did, for logs and tests. */
export type SmsDeliveryOutcome = "sent" | "failed" | "already_delivered" | "missing";

export interface SmsDeliveryResult {
  readonly outcome: SmsDeliveryOutcome;
  readonly providerMessageId?: string;
  readonly error?: string;
}

export interface SmsDeliveryServiceDeps {
  readonly db: AnyDb;
  readonly sms: SmsProvider;
  /**
   * Sender id for the tenant, resolved by the caller from tenant config. The
   * service never reads config itself: a message body is rendered at enqueue
   * time, so delivery needs nothing but the row (ADR 0016).
   */
  readonly senderIdFor?: (tenantId: string) => Promise<string | undefined>;
  readonly telemetry?: Telemetry;
}

export interface SmsDeliveryService {
  /** Delivers one outbox row. Safe to call twice: a delivered row is a no-op. */
  deliver(tenantId: string, smsId: string): Promise<SmsDeliveryResult>;
}

/**
 * Sends one rendered receipt-outbox row through the `SmsProvider` port.
 *
 * The body and recipient were fixed when the row was enqueued, in the same
 * transaction as the payment that caused it, so delivery never touches tenant
 * config or recomputes an amount. The external send happens **outside** the
 * database transaction that claimed the row (ADR 0016): a slow gateway must
 * never hold a transaction open, and the row's own status is what records the
 * outcome.
 *
 * The idempotency key is the row id, so a retried job that reaches the provider
 * twice is a duplicate the provider can discard rather than a second SMS.
 */
export function createSmsDeliveryService(deps: SmsDeliveryServiceDeps): SmsDeliveryService {
  async function deliver(tenantId: string, smsId: string): Promise<SmsDeliveryResult> {
    // A plain read, tenant-scoped: row-level security means this can only ever
    // see a message belonging to `tenantId`, even if a caller passes a foreign
    // id.
    const row = await withTenant(deps.db, tenantId, async (tx) =>
      repositories(tx).smsLog.findById(tenantId, smsId),
    );
    if (row === undefined) return { outcome: "missing" };
    if (row.status === "sent") {
      // The queue is at-least-once, so a second attempt is expected and must
      // not send a second SMS.
      return { outcome: "already_delivered" };
    }

    const senderId = await deps.senderIdFor?.(tenantId);
    try {
      const result = await deps.sms.send({
        to: row.recipient,
        text: row.body,
        idempotencyKey: `sms:${row.id}`,
        ...(senderId === undefined ? {} : { senderId }),
      });
      await withTenant(deps.db, tenantId, async (tx) =>
        repositories(tx).smsLog.markSent(tenantId, row.id, result.providerMessageId),
      );
      deps.telemetry?.counter("sms.delivered", 1, { kind: row.kind });
      return { outcome: "sent", providerMessageId: result.providerMessageId };
    } catch (error) {
      const message = describeFailure(error);
      // The row is marked failed so operations can see the outcome, but the job
      // queue owns retrying: a `failed` row is terminal for the sweeper, and the
      // live job is what tries again.
      await withTenant(deps.db, tenantId, async (tx) =>
        repositories(tx).smsLog.markFailed(tenantId, row.id, message),
      );
      deps.telemetry?.counter("sms.failed", 1, { kind: row.kind, reason: message });
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
