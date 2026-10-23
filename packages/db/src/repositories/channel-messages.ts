import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Database } from "../connection.js";
import type { ChannelMessageRow } from "../connection.js";

export type { ChannelMessageRow } from "../connection.js";

export type ChannelMessageChannel = ChannelMessageRow["channel"];
export type ChannelMessageKind = ChannelMessageRow["kind"];

export interface RecordInboundChannelMessageParams {
  readonly channel: ChannelMessageChannel;
  readonly kind?: ChannelMessageKind;
  /** The driver's address: a phone number or MSISDN. */
  readonly recipient: string;
  readonly body: string;
  readonly providerMessageId?: string | null;
  /** Provider event id, provider message id, or a stable hash of the payload. */
  readonly dedupeKey: string;
  readonly replyToId?: string | null;
  readonly receivedAt?: Date;
}

export interface EnqueueOutboundChannelMessageParams {
  readonly channel: ChannelMessageChannel;
  readonly kind: ChannelMessageKind;
  /** The driver's address: a phone number or MSISDN. */
  readonly recipient: string;
  readonly body: string;
  /** Optional idempotency key; a retry with the same key is a no-op. */
  readonly dedupeKey?: string | null;
  /** Links a reply to the inbound message it answers. */
  readonly replyToId?: string | null;
}

export interface CountSentOnDateOptions {
  readonly channel: ChannelMessageChannel;
  /** IANA timezone from tenant config, so the count matches the business day. */
  readonly timeZone: string;
  /** Business date in YYYY-MM-DD form. */
  readonly businessDate: string;
  /** Restrict the count to one phone number, for the per-recipient limit. */
  readonly recipient?: string;
}

/**
 * Channel messages: what was shown or said to a driver, and what they sent.
 *
 * The repository is tenant-scoped like every other one: callers pass the
 * tenant-scoped transaction opened by `withTenant`, and every query filters on
 * `tenant_id` as defence in depth. Inserts that carry a dedupe key use
 * `ON CONFLICT DO NOTHING`, so a replayed callback returns `undefined` instead
 * of producing a second message.
 */
export class ChannelMessageRepository {
  constructor(private readonly db: Transaction<Database>) {}

  /** Records a provider callback. Returns `undefined` when it is a replay. */
  async recordInbound(
    tenantId: string,
    params: RecordInboundChannelMessageParams,
  ): Promise<ChannelMessageRow | undefined> {
    return this.db
      .insertInto("channelMessages")
      .values({
        tenantId,
        channel: params.channel,
        direction: "inbound",
        kind: params.kind ?? "inbound",
        recipient: params.recipient,
        body: params.body,
        status: "received",
        providerMessageId: params.providerMessageId ?? null,
        replyToId: params.replyToId ?? null,
        dedupeKey: params.dedupeKey,
        ...(params.receivedAt === undefined ? {} : { createdAt: params.receivedAt }),
      })
      .onConflict((conflict) => conflict.columns(["tenantId", "dedupeKey"]).doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Adds an outbound message to the channel outbox. Returns `undefined` when a
   * message with the same dedupe key already exists, which makes a retry safe.
   */
  async enqueueOutbound(
    tenantId: string,
    params: EnqueueOutboundChannelMessageParams,
  ): Promise<ChannelMessageRow | undefined> {
    return this.db
      .insertInto("channelMessages")
      .values({
        tenantId,
        channel: params.channel,
        direction: "outbound",
        kind: params.kind,
        recipient: params.recipient,
        body: params.body,
        dedupeKey: params.dedupeKey ?? null,
        replyToId: params.replyToId ?? null,
      })
      .onConflict((conflict) => conflict.columns(["tenantId", "dedupeKey"]).doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  async findById(tenantId: string, id: string): Promise<ChannelMessageRow | undefined> {
    return this.db
      .selectFrom("channelMessages")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirst();
  }

  /**
   * Claims pending outbound messages with `FOR UPDATE SKIP LOCKED`, so
   * concurrent delivery workers never send the same message twice. The lock
   * lasts until the transaction commits, so delivery must happen inside it.
   */
  async claimPending(tenantId: string, limit: number): Promise<ChannelMessageRow[]> {
    return this.db
      .selectFrom("channelMessages")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("direction", "=", "outbound")
      .where("status", "=", "pending")
      .orderBy("createdAt", "asc")
      .orderBy("id", "asc")
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();
  }

  async markSent(
    tenantId: string,
    id: string,
    providerMessageId: string,
    sentAt: Date = new Date(),
  ): Promise<ChannelMessageRow | undefined> {
    return this.db
      .updateTable("channelMessages")
      .set((eb) => ({
        status: "sent",
        providerMessageId,
        sentAt,
        attempts: eb("attempts", "+", 1),
        lastError: null,
      }))
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .where("direction", "=", "outbound")
      .returningAll()
      .executeTakeFirst();
  }

  async markFailed(
    tenantId: string,
    id: string,
    error: string,
  ): Promise<ChannelMessageRow | undefined> {
    return this.db
      .updateTable("channelMessages")
      .set((eb) => ({
        status: "failed",
        attempts: eb("attempts", "+", 1),
        lastError: error,
      }))
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .where("direction", "=", "outbound")
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Counts sent outbound messages for one business day, using the tenant's
   * timezone so a day boundary matches the rest of the platform. The SMS cost
   * guard uses this per recipient and per tenant.
   */
  async countSentOnDate(tenantId: string, options: CountSentOnDateOptions): Promise<number> {
    const recipientFilter =
      options.recipient === undefined ? sql`` : sql`and recipient = ${options.recipient}`;
    const result = await sql<{ count: string }>`
      select count(*)::text as count
      from channel_messages
      where tenant_id = ${tenantId}
        and channel = ${options.channel}
        and direction = 'outbound'
        and status = 'sent'
        and (sent_at at time zone ${options.timeZone})::date = ${options.businessDate}::date
        ${recipientFilter}
    `.execute(this.db);
    return Number(result.rows[0]?.count ?? "0");
  }
}
