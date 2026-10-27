import type { Transaction } from "kysely";
import { sql } from "kysely";
import { hashToken } from "@tpirs/crypto";
import type { Database } from "../connection.js";
import type {
  PaymentInstructionRow,
  PaymentRow,
  SmsLogRow,
  WebhookEndpointRow,
  WebhookEventRow,
} from "../connection.js";

export type {
  PaymentInstructionRow,
  PaymentRow,
  SmsLogRow,
  WebhookEndpointRow,
  WebhookEventRow,
} from "../connection.js";

/**
 * Payment intake repositories. As with the ledger repositories, every method
 * receives the tenant-scoped transaction opened by `withTenant`, so row-level
 * security is active, and still filters on `tenant_id` as defence in depth.
 *
 * Two outbox tables share a convention: `record`/`enqueue` insert with
 * `ON CONFLICT DO NOTHING` and return `undefined` when the row already existed.
 * A replay is therefore a no-op by construction rather than by a caller check.
 */

export interface CreatePaymentInstructionParams {
  readonly assetId: string;
  readonly provider: string;
  readonly reference: string;
  readonly kind: PaymentInstructionRow["kind"];
  readonly amountMinor?: bigint | null;
  readonly currency?: string | null;
  readonly idempotencyKey?: string | null;
  readonly expiresAt?: Date | null;
}

export class PaymentInstructionRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async create(
    tenantId: string,
    params: CreatePaymentInstructionParams,
  ): Promise<PaymentInstructionRow> {
    return this.db
      .insertInto("paymentInstructions")
      .values({
        tenantId,
        assetId: params.assetId,
        provider: params.provider,
        reference: params.reference,
        kind: params.kind,
        amountMinor: params.amountMinor ?? null,
        currency: params.currency ?? null,
        idempotencyKey: params.idempotencyKey ?? null,
        expiresAt: params.expiresAt ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(tenantId: string, id: string): Promise<PaymentInstructionRow | undefined> {
    return this.db
      .selectFrom("paymentInstructions")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirst();
  }

  async findByReference(
    tenantId: string,
    provider: string,
    reference: string,
  ): Promise<PaymentInstructionRow | undefined> {
    return this.db
      .selectFrom("paymentInstructions")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("provider", "=", provider)
      .where("reference", "=", reference)
      .executeTakeFirst();
  }

  /** Resolves a retried intent creation to the instruction it already made. */
  async findByIdempotencyKey(
    tenantId: string,
    provider: string,
    idempotencyKey: string,
  ): Promise<PaymentInstructionRow | undefined> {
    return this.db
      .selectFrom("paymentInstructions")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("provider", "=", provider)
      .where("idempotencyKey", "=", idempotencyKey)
      .executeTakeFirst();
  }

  /** An asset's long-lived instruction (virtual account or narration code). */
  async findActiveForAsset(
    tenantId: string,
    provider: string,
    assetId: string,
    kind: PaymentInstructionRow["kind"],
  ): Promise<PaymentInstructionRow | undefined> {
    return this.db
      .selectFrom("paymentInstructions")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("provider", "=", provider)
      .where("assetId", "=", assetId)
      .where("kind", "=", kind)
      .where("status", "=", "active")
      .executeTakeFirst();
  }

  async markStatus(
    tenantId: string,
    id: string,
    status: PaymentInstructionRow["status"],
  ): Promise<PaymentInstructionRow | undefined> {
    return this.db
      .updateTable("paymentInstructions")
      .set({ status, updatedAt: new Date() })
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }
}

export interface CreatePaymentParams {
  readonly provider: string;
  /** Normalized provider event id; the dedupe key for the payment itself. */
  readonly providerEventId: string;
  readonly status: PaymentRow["status"];
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly assetId?: string | null;
  readonly instructionId?: string | null;
  readonly providerReference?: string | null;
  readonly attributionKind?: PaymentRow["attributionKind"];
  readonly businessDate?: string | null;
  readonly obligationPeriodId?: string | null;
  readonly transactionId?: string | null;
  readonly receiptNumber?: string | null;
  readonly failureReason?: string | null;
  readonly metadata?: unknown;
}

export class PaymentRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async create(tenantId: string, params: CreatePaymentParams): Promise<PaymentRow> {
    return this.db
      .insertInto("payments")
      .values({
        tenantId,
        assetId: params.assetId ?? null,
        instructionId: params.instructionId ?? null,
        provider: params.provider,
        providerEventId: params.providerEventId,
        providerReference: params.providerReference ?? null,
        attributionKind: params.attributionKind ?? null,
        status: params.status,
        amountMinor: params.amountMinor,
        currency: params.currency,
        businessDate: params.businessDate ?? null,
        obligationPeriodId: params.obligationPeriodId ?? null,
        transactionId: params.transactionId ?? null,
        receiptNumber: params.receiptNumber ?? null,
        failureReason: params.failureReason ?? null,
        metadata: params.metadata ?? {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(tenantId: string, id: string): Promise<PaymentRow | undefined> {
    return this.db
      .selectFrom("payments")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirst();
  }

  async findByProviderEvent(
    tenantId: string,
    provider: string,
    providerEventId: string,
  ): Promise<PaymentRow | undefined> {
    return this.db
      .selectFrom("payments")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("provider", "=", provider)
      .where("providerEventId", "=", providerEventId)
      .executeTakeFirst();
  }

  async findByProviderReference(
    tenantId: string,
    provider: string,
    providerReference: string,
  ): Promise<PaymentRow | undefined> {
    return this.db
      .selectFrom("payments")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("provider", "=", provider)
      .where("providerReference", "=", providerReference)
      .orderBy("createdAt", "desc")
      .executeTakeFirst();
  }

  /** Finance views: newest first, optionally narrowed to one state. */
  async listRecent(
    tenantId: string,
    options: { status?: PaymentRow["status"]; limit?: number } = {},
  ): Promise<PaymentRow[]> {
    let query = this.db
      .selectFrom("payments")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .orderBy("createdAt", "desc")
      .limit(options.limit ?? 50);
    if (options.status !== undefined) {
      query = query.where("status", "=", options.status);
    }
    return query.execute();
  }

  /**
   * Resolves a suspense item by applying it to a day. Only a suspense payment
   * may be applied this way: intake inserts already-applied payments, so this
   * path exists for finance, not for the webhook. Returns `undefined` when the
   * payment was not in suspense (already resolved, or never in suspense), which
   * makes a double-click by two finance users a no-op rather than a double
   * posting.
   */
  async applyFromSuspense(
    tenantId: string,
    id: string,
    params: {
      businessDate: string;
      obligationPeriodId: string;
      transactionId: string;
      receiptNumber: string;
      /**
       * Finance attributes a previously unattributable payment to an asset, so
       * the asset and attribution must be filled in here: an applied payment is
       * complete by constraint, and intake may have left both null. A payment
       * that intake already attributed keeps what it recorded.
       */
      assetId?: string;
      attributionKind?: NonNullable<PaymentRow["attributionKind"]>;
    },
  ): Promise<PaymentRow | undefined> {
    return this.db
      .updateTable("payments")
      .set({
        status: "applied",
        ...(params.assetId === undefined ? {} : { assetId: params.assetId }),
        ...(params.attributionKind === undefined
          ? {}
          : { attributionKind: params.attributionKind }),
        businessDate: params.businessDate,
        obligationPeriodId: params.obligationPeriodId,
        transactionId: params.transactionId,
        receiptNumber: params.receiptNumber,
        updatedAt: new Date(),
      })
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .where("status", "=", "suspense")
      .returningAll()
      .executeTakeFirst();
  }

  async markSuspense(
    tenantId: string,
    id: string,
    reason: string,
  ): Promise<PaymentRow | undefined> {
    return this.db
      .updateTable("payments")
      .set({ status: "suspense", failureReason: reason, updatedAt: new Date() })
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .where("status", "=", "credited")
      .returningAll()
      .executeTakeFirst();
  }
}

export interface RecordWebhookEventParams {
  readonly provider: string;
  readonly providerEventId: string;
  readonly rawBody: string;
}

export class WebhookEventRepository {
  constructor(private readonly db: Transaction<Database>) {}

  /**
   * Stores the raw, already-verified delivery. Returns `undefined` when the same
   * provider event was stored before: the caller must treat that as a replay and
   * do nothing else.
   */
  async record(
    tenantId: string,
    params: RecordWebhookEventParams,
  ): Promise<WebhookEventRow | undefined> {
    return this.db
      .insertInto("webhookEvents")
      .values({
        tenantId,
        provider: params.provider,
        providerEventId: params.providerEventId,
        rawBody: params.rawBody,
        signatureVerified: true,
      })
      .onConflict((conflict) =>
        conflict.columns(["tenantId", "provider", "providerEventId"]).doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Claims up to `limit` unprocessed deliveries for this transaction with
   * `FOR UPDATE SKIP LOCKED`, so concurrent workers never handle the same event.
   * The lock lasts until the transaction commits, so processing must happen
   * inside the same transaction.
   */
  async claimPending(tenantId: string, limit: number): Promise<WebhookEventRow[]> {
    return this.db
      .selectFrom("webhookEvents")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("processedAt", "is", null)
      .orderBy("receivedAt", "asc")
      .orderBy("id", "asc")
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();
  }

  async markProcessed(
    tenantId: string,
    id: string,
    paymentId: string,
  ): Promise<WebhookEventRow | undefined> {
    return this.db
      .updateTable("webhookEvents")
      .set({ processedAt: new Date(), paymentId, lastError: null })
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }

  /** Records a failed attempt; the event stays pending for the next sweep. */
  async markFailed(
    tenantId: string,
    id: string,
    error: string,
  ): Promise<WebhookEventRow | undefined> {
    return this.db
      .updateTable("webhookEvents")
      .set((eb) => ({
        attempts: eb("attempts", "+", 1),
        lastError: error,
      }))
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }

  async countPending(tenantId: string): Promise<number> {
    const result = await this.db
      .selectFrom("webhookEvents")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("tenantId", "=", tenantId)
      .where("processedAt", "is", null)
      .executeTakeFirst();
    return Number(result?.count ?? 0);
  }
}

export interface EnqueueSmsParams {
  readonly kind: SmsLogRow["kind"];
  readonly recipient: string;
  readonly body: string;
  readonly paymentId?: string | null;
  readonly obligationPeriodId?: string | null;
  /** Subject for cash receipts (ADR 0031); one of the three subjects is required. */
  readonly cashIntakeId?: string | null;
}

export interface CountSentSmsOnDateOptions {
  /** IANA timezone from tenant config, so the count matches the business day. */
  readonly timeZone: string;
  /** Business date in YYYY-MM-DD form. */
  readonly businessDate: string;
  /** Restrict the count to one phone number, for the per-recipient limit. */
  readonly recipient?: string;
}

export class SmsLogRepository {
  constructor(private readonly db: Transaction<Database>) {}

  /**
   * Adds a rendered message to the outbox. Returns `undefined` when a row for the
   * same payment/period and kind already exists, which is exactly what makes a
   * replayed webhook or a retried job unable to send twice.
   */
  async enqueue(tenantId: string, params: EnqueueSmsParams): Promise<SmsLogRow | undefined> {
    return this.db
      .insertInto("smsLog")
      .values({
        tenantId,
        paymentId: params.paymentId ?? null,
        obligationPeriodId: params.obligationPeriodId ?? null,
        cashIntakeId: params.cashIntakeId ?? null,
        kind: params.kind,
        recipient: params.recipient,
        body: params.body,
      })
      .onConflict((conflict) => conflict.doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /** Reads one message. Tenant-scoped, so a delivery worker that is handed an id
   * from another tenant simply finds nothing.
   */
  async findById(tenantId: string, id: string): Promise<SmsLogRow | undefined> {
    return this.db
      .selectFrom("smsLog")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirst();
  }

  /**
   * Reads the cash receipt queued for one intake, if any. The reply to a
   * replayed intake reports whether the receipt already went out, so the
   * caller does not enqueue a second one.
   */
  async findCashIntakeReceipt(
    tenantId: string,
    cashIntakeId: string,
  ): Promise<SmsLogRow | undefined> {
    return this.db
      .selectFrom("smsLog")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("cashIntakeId", "=", cashIntakeId)
      .where("kind", "=", "cash_receipt")
      .executeTakeFirst();
  }

  /** Claims pending messages for delivery, skipping rows another worker holds. */
  async claimPending(tenantId: string, limit: number): Promise<SmsLogRow[]> {
    return this.db
      .selectFrom("smsLog")
      .selectAll()
      .where("tenantId", "=", tenantId)
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
  ): Promise<SmsLogRow | undefined> {
    return this.db
      .updateTable("smsLog")
      .set((eb) => ({
        status: "sent",
        providerMessageId,
        sentAt: new Date(),
        attempts: eb("attempts", "+", 1),
        lastError: null,
      }))
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }

  async markFailed(tenantId: string, id: string, error: string): Promise<SmsLogRow | undefined> {
    return this.db
      .updateTable("smsLog")
      .set((eb) => ({
        status: "failed",
        attempts: eb("attempts", "+", 1),
        lastError: error,
      }))
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }

  async findByPayment(tenantId: string, paymentId: string): Promise<SmsLogRow[]> {
    return this.db
      .selectFrom("smsLog")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("paymentId", "=", paymentId)
      .orderBy("createdAt", "asc")
      .execute();
  }

  /**
   * Counts delivered messages for one business day, in the tenant's timezone.
   *
   * Receipts are transactional - a driver who paid is entitled to one - so the
   * cost guard never suppresses them. They do count toward the budget: a day's
   * spend is channel replies plus receipts, so the guard must see both tables.
   */
  async countSentOnDate(tenantId: string, options: CountSentSmsOnDateOptions): Promise<number> {
    const recipientFilter =
      options.recipient === undefined ? sql`` : sql`and recipient = ${options.recipient}`;
    const result = await sql<{ count: string }>`
      select count(*)::text as count
      from sms_log
      where tenant_id = ${tenantId}
        and status = 'sent'
        and (sent_at at time zone ${options.timeZone})::date = ${options.businessDate}::date
        ${recipientFilter}
    `.execute(this.db);
    return Number(result.rows[0]?.count ?? "0");
  }
}

/**
 * Provisions endpoint tokens. Used by tenant onboarding and tests, never by a
 * request handler; the raw token is returned once so it can be configured in the
 * provider dashboard, and only its hash is stored.
 */
export class WebhookEndpointRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async create(
    tenantId: string,
    params: { provider: string; token: string },
  ): Promise<WebhookEndpointRow> {
    return this.db
      .insertInto("webhookEndpoints")
      .values({ tenantId, provider: params.provider, tokenHash: hashToken(params.token) })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async revoke(tenantId: string, id: string): Promise<WebhookEndpointRow | undefined> {
    return this.db
      .updateTable("webhookEndpoints")
      .set({ revokedAt: new Date() })
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }

  async list(tenantId: string): Promise<WebhookEndpointRow[]> {
    return this.db
      .selectFrom("webhookEndpoints")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .orderBy("createdAt", "desc")
      .execute();
  }
}
