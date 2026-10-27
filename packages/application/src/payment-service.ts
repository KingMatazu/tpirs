import { money, todayInTimeZone } from "@tpirs/domain";
import type { BusinessDate, TenantId } from "@tpirs/domain";
import { randomOpaqueId } from "@tpirs/crypto";
import { repositories, resolveWebhookEndpoint, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb, PaymentRow, SmsLogRow, Transaction } from "@tpirs/db";
import type { FeeEngine, PaymentProvider } from "@tpirs/ports";
import { PortError } from "@tpirs/ports";
import type { TenantConfig } from "@tpirs/config";
import type { TenantConfigLoader } from "./asset-service.js";
import { LedgerService } from "./ledger-service.js";
import { ObligationService } from "./obligation-service.js";
import { CollectorCashService } from "./collector-cash-service.js";
import { renderReceiptSms, renderUnderpaymentNoticeSms } from "./receipt-renderer.js";

export class PaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentError";
  }
}

/** Counters a webhook that could not be attributed to a tenant. */
export interface WebhookTelemetry {
  record(label: string, fields?: Readonly<Record<string, string | number>>): void;
}

export interface PaymentServiceDeps {
  readonly db: AnyDb;
  readonly loadConfig: TenantConfigLoader;
  readonly feeEngine: FeeEngine;
  /** Resolves a provider name to its adapter. */
  readonly providerFor: (provider: string) => PaymentProvider | undefined;
  readonly telemetry?: WebhookTelemetry;
  readonly now?: () => Date;
}

export interface CreateIntentInput {
  readonly tenantId: string;
  readonly provider: string;
  readonly assetId: string;
  readonly businessDate?: BusinessDate;
  readonly idempotencyKey?: string | null;
  readonly customer?: { readonly name?: string; readonly phone?: string };
}

export interface PaymentIntentView {
  readonly instructionId: string | null;
  readonly provider: string;
  readonly reference: string;
  readonly kind: PaymentRow["attributionKind"];
  readonly amountMinor: bigint;
  readonly currency: string;
  /** The day already has a payment, so no intent was issued. */
  readonly alreadySettled: boolean;
  /** The wallet already covers the day, so no intent was issued. */
  readonly nothingRequired: boolean;
  readonly authorizationUrl?: string;
}

export interface IngestWebhookInput {
  readonly provider: string;
  readonly endpointToken: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly rawBody: string;
}

export type IngestOutcome =
  | "duplicate"
  | "rejected"
  | "suspense"
  | "credited"
  | "applied"
  | "ignored"
  | "deposit_matched"
  | "deposit_suspense";

export interface IngestWebhookResult {
  readonly outcome: IngestOutcome;
  readonly tenantId?: string;
  readonly paymentId?: string;
  readonly receiptNumber?: string;
  /** Set when the delivery was a matched collector deposit (ADR 0032). */
  readonly depositId?: string;
  /**
   * Whether the gateway should treat the delivery as handled. A replay is
   * always accepted, so a gateway never resends and never marks a healthy
   * endpoint as failing; a bad signature is not.
   */
  readonly accepted: boolean;
}

export interface ResolveSuspenseInput {
  readonly tenantId: string;
  readonly paymentId: string;
  readonly assetId: string;
  /** The finance user applying the money; recorded in the audit trail. */
  readonly approvedByUserId: string;
}

export interface PaymentView {
  readonly id: string;
  readonly status: PaymentRow["status"];
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly provider: string;
  readonly providerReference: string | null;
  readonly assetId: string | null;
  readonly attributionKind: PaymentRow["attributionKind"];
  readonly businessDate: string | null;
  readonly receiptNumber: string | null;
  readonly failureReason: string | null;
  readonly createdAt: Date;
}

export interface PaymentService {
  createIntent(input: CreateIntentInput): Promise<PaymentIntentView>;
  ingestWebhookEvent(input: IngestWebhookInput): Promise<IngestWebhookResult>;
  provisionEndpoint(input: { tenantId: string; provider: string }): Promise<string>;
  listPayments(input: {
    tenantId: string;
    status?: PaymentRow["status"];
    limit?: number;
  }): Promise<readonly PaymentView[]>;
  listSuspense(input: { tenantId: string; limit?: number }): Promise<readonly PaymentView[]>;
  resolveSuspense(input: ResolveSuspenseInput): Promise<PaymentView>;
  listOutbox(input: { tenantId: string; paymentId: string }): Promise<readonly SmsLogRow[]>;
}

function toPaymentView(row: PaymentRow): PaymentView {
  return {
    id: row.id,
    status: row.status,
    amountMinor: row.amountMinor,
    currency: row.currency,
    provider: row.provider,
    providerReference: row.providerReference,
    assetId: row.assetId,
    attributionKind: row.attributionKind,
    businessDate: row.businessDate,
    receiptNumber: row.receiptNumber,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
  };
}

/** The receipt number a driver can quote; opaque and unique per tenant. */
function nextReceiptNumber(): string {
  return `R-${randomOpaqueId().slice(0, 12).toUpperCase()}`;
}

/** What the driver recognises the asset by, taken from its own attributes. */
function assetRefFor(attributes: Readonly<Record<string, unknown>>, shortCode: string): string {
  const candidate = attributes["plate_number"] ?? attributes["plateNumber"];
  return typeof candidate === "string" && candidate.trim() !== "" ? candidate : shortCode;
}

/**
 * Payment intake and finance views.
 *
 * The service owns the awkward parts of taking money: issuing an intent that
 * says exactly what to pay, deciding what an arriving payment may do, and
 * keeping the driver informed. Every money movement goes through
 * `ObligationService` and the ledger, so no ledger entry is written here
 * directly and no caller has to know the ledger's shape.
 */
export function createPaymentService(deps: PaymentServiceDeps): PaymentService {
  const obligations = new ObligationService(deps.db, deps.feeEngine);
  const collectorCash = new CollectorCashService({
    db: deps.db,
    loadConfig: deps.loadConfig,
    feeEngine: deps.feeEngine,
    providerFor: deps.providerFor,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  const now = deps.now ?? (() => new Date());
  const telemetry: WebhookTelemetry = deps.telemetry ?? { record: () => undefined };

  async function requireConfig(tenantId: string): Promise<TenantConfig> {
    const config = await deps.loadConfig(tenantId);
    if (config === undefined) {
      throw new PaymentError(`No configuration found for tenant "${tenantId}"`);
    }
    return config;
  }

  function requireProvider(provider: string): PaymentProvider {
    const adapter = deps.providerFor(provider);
    if (adapter === undefined) {
      throw new PortError("PaymentProvider", "not_found", `Unknown payment provider "${provider}"`);
    }
    return adapter;
  }

  /**
   * Issues an intent: a reference the payer holds, plus the exact amount still
   * required for the day. The amount is the fee less any wallet credit the
   * asset already holds, so a driver who underpaid once is never asked for the
   * whole fee twice.
   */
  async function createIntent(input: CreateIntentInput): Promise<PaymentIntentView> {
    const config = await requireConfig(input.tenantId);
    const adapter = requireProvider(input.provider);
    const businessDate = input.businessDate ?? todayInTimeZone(config.locale.timezone, now());

    const asset = await withTenant(deps.db, input.tenantId, async (tx) =>
      repositories(tx).assets.findById(input.assetId),
    );
    if (asset === undefined) {
      throw new PaymentError(`Asset "${input.assetId}" was not found`);
    }

    const idempotencyKey = input.idempotencyKey ?? null;
    if (idempotencyKey !== null) {
      const existing = await withTenant(deps.db, input.tenantId, async (tx) =>
        repositories(tx).paymentInstructions.findByIdempotencyKey(
          input.tenantId,
          input.provider,
          idempotencyKey,
        ),
      );
      if (existing !== undefined) {
        return {
          instructionId: existing.id,
          provider: existing.provider,
          reference: existing.reference,
          kind: existing.kind,
          amountMinor: existing.amountMinor ?? 0n,
          currency: existing.currency ?? config.locale.currency,
          alreadySettled: false,
          nothingRequired: false,
        };
      }
    }

    const required = await obligations.getRequiredPayment({
      tenantId: input.tenantId,
      config,
      assetId: asset.id,
      assetTypeKey: asset.assetTypeKey,
      businessDate,
    });

    // There is nothing to ask the driver for: the day is settled already, or the
    // wallet they hold already covers it. No intent is issued, because a payment
    // provider cannot charge a zero amount and a second charge would strand the
    // payer's money in the wallet.
    if (required.alreadySettled || required.requiredMinor === 0n) {
      return {
        instructionId: null,
        provider: adapter.name,
        reference: "",
        kind: null,
        amountMinor: 0n,
        currency: required.currency,
        alreadySettled: required.alreadySettled,
        nothingRequired: true,
      };
    }

    const kind = adapter.capabilities().attributionKinds[0];
    if (kind === undefined) {
      throw new PortError(
        "PaymentProvider",
        "invalid_request",
        `Provider "${input.provider}" declares no attribution mechanism`,
      );
    }

    const reference = `ref-${randomOpaqueId()}`;
    const intent = await adapter.createPaymentIntent({
      idempotencyKey: idempotencyKey ?? reference,
      amount: money(required.currency, Number(required.requiredMinor)),
      reference,
      ...(input.customer === undefined ? {} : { customer: input.customer }),
      metadata: { assetId: asset.id, businessDate },
    });

    const created = await withTenant(deps.db, input.tenantId, async (tx) =>
      repositories(tx).paymentInstructions.create(input.tenantId, {
        assetId: asset.id,
        provider: adapter.name,
        reference: intent.attribution.instruction?.value ?? reference,
        kind: intent.attribution.kind,
        amountMinor: required.requiredMinor,
        currency: required.currency,
        idempotencyKey,
      }),
    );

    return {
      instructionId: created.id,
      provider: created.provider,
      reference: created.reference,
      kind: created.kind,
      amountMinor: created.amountMinor ?? required.requiredMinor,
      currency: created.currency ?? required.currency,
      alreadySettled: required.alreadySettled,
      nothingRequired: false,
      ...(intent.authorizationUrl === undefined
        ? {}
        : { authorizationUrl: intent.authorizationUrl }),
    };
  }

  /**
   * Takes one webhook delivery from the gateway to a settled day.
   *
   * The order protects the tenant boundary: the endpoint token resolves the
   * tenant, the signature is verified against that tenant's provider, and only
   * then does a tenant-scoped transaction run. Nothing that depends on tenant
   * data happens before verification.
   */
  async function ingestWebhookEvent(input: IngestWebhookInput): Promise<IngestWebhookResult> {
    const tenantId = await resolveWebhookEndpoint(deps.db, input.provider, input.endpointToken);
    if (tenantId === undefined) {
      telemetry.record("payment.webhook.unknown_endpoint", { provider: input.provider });
      return { outcome: "ignored", accepted: true };
    }

    const config = await requireConfig(tenantId);
    const adapter = requireProvider(input.provider);

    const verified = await adapter
      .verifyWebhook({ headers: input.headers, rawBody: input.rawBody })
      .catch(() => ({ ok: false }));
    if (!verified.ok) {
      telemetry.record("payment.webhook.bad_signature", { provider: input.provider, tenantId });
      return { outcome: "ignored", accepted: false, tenantId };
    }

    let event: ReturnType<PaymentProvider["normalizeWebhook"]>;
    try {
      event = adapter.normalizeWebhook(input.rawBody);
    } catch (error) {
      telemetry.record("payment.webhook.malformed", {
        provider: input.provider,
        tenantId,
        message: error instanceof Error ? error.message : String(error),
      });
      return { outcome: "ignored", accepted: true, tenantId };
    }

    return withTenant(deps.db, tenantId, async (tx) => {
      const repos = repositories(tx);

      const recorded = await repos.webhookEvents.record(tenantId, {
        provider: input.provider,
        providerEventId: event.providerEventId,
        rawBody: input.rawBody,
      });
      if (recorded === undefined) {
        // The same delivery arrived twice. Answer 2xx so the gateway stops
        // retrying; nothing else may happen.
        return { outcome: "duplicate", accepted: true, tenantId };
      }

      return processEvent({
        tx,
        tenantId,
        config,
        provider: input.provider,
        event,
        eventRow: recorded,
      });
    });
  }

  interface ProcessContext {
    readonly tx: Transaction<import("@tpirs/db").Database>;
    readonly tenantId: string;
    readonly config: TenantConfig;
    readonly provider: string;
    readonly event: ReturnType<PaymentProvider["normalizeWebhook"]>;
    readonly eventRow: { readonly id: string };
  }

  async function processEvent(context: ProcessContext): Promise<IngestWebhookResult> {
    const { tx, tenantId, config, provider, event, eventRow } = context;
    const repos = repositories(tx);
    const businessDate = todayInTimeZone(config.locale.timezone, event.paidAt);
    const amountMinor = BigInt(event.amount.amount);

    // A duplicate provider event id, independent of the raw-body dedupe: the
    // same payment reported under a new event id must not post twice.
    const duplicate = await repos.payments.findByProviderEvent(
      tenantId,
      provider,
      event.providerEventId,
    );
    if (duplicate !== undefined) {
      await repos.webhookEvents.markProcessed(tenantId, eventRow.id, duplicate.id);
      return { outcome: "duplicate", accepted: true, tenantId, paymentId: duplicate.id };
    }

    // Collector deposit instructions are resolved BEFORE payment instructions
    // (ADR 0032): a reference that belongs to a collector's deposit account
    // must never be inspected as a payment reference, so the two namespaces
    // cannot cross-credit.
    const depositInstruction = await repos.collectorCash.findActiveInstruction(
      tenantId,
      provider,
      event.providerReference,
    );
    if (depositInstruction !== undefined) {
      const deposit = await collectorCash.ingestDeposit({ tenantId, config, provider, event });
      // A recognised deposit reference never reaches the payment path, but the
      // delivery still ties the event to the outcome it produced.
      await repos.webhookEvents.markProcessed(tenantId, eventRow.id, null);
      if (deposit === undefined) {
        return { outcome: "ignored", accepted: true, tenantId };
      }
      return {
        outcome: deposit.outcome === "suspense" ? "deposit_suspense" : "deposit_matched",
        accepted: true,
        tenantId,
        depositId: deposit.depositId,
      };
    }

    const instruction = await repos.paymentInstructions.findByReference(
      tenantId,
      provider,
      event.providerReference,
    );

    async function store(
      status: PaymentRow["status"],
      failureReason: string,
      extra: { readonly assetId?: string | null } = {},
    ): Promise<PaymentRow> {
      return repos.payments.create(tenantId, {
        provider,
        providerEventId: event.providerEventId,
        providerReference: event.providerReference,
        status,
        amountMinor,
        currency: event.amount.currency,
        assetId: extra.assetId ?? instruction?.assetId ?? null,
        instructionId: instruction?.id ?? null,
        attributionKind: instruction?.kind ?? null,
        failureReason,
        metadata: { raw: event.raw },
      });
    }

    // A provider-reported failure never settles a day; it is recorded so
    // finance sees it and so a later success is not mistaken for a replay.
    if (event.status === "failed") {
      const payment = await store("rejected", "provider_reported_failure");
      await repos.webhookEvents.markProcessed(tenantId, eventRow.id, payment.id);
      return { outcome: "rejected", accepted: true, tenantId, paymentId: payment.id };
    }

    if (instruction === undefined) {
      const payment = await store("suspense", "unattributable");
      await repos.webhookEvents.markProcessed(tenantId, eventRow.id, payment.id);
      return { outcome: "suspense", accepted: true, tenantId, paymentId: payment.id };
    }

    const asset = await repos.assets.findById(instruction.assetId);
    if (asset === undefined) {
      const payment = await store("suspense", "asset_missing");
      await repos.webhookEvents.markProcessed(tenantId, eventRow.id, payment.id);
      return { outcome: "suspense", accepted: true, tenantId, paymentId: payment.id };
    }

    const assetRef = assetRefFor(asset.attributes, asset.shortCode);
    const owner = asset.ownerId === null ? undefined : await repos.owners.findById(asset.ownerId);
    const recipient = owner?.phone ?? null;

    // An intent carries the amount the payer was quoted, which is the fee less
    // whatever wallet credit existed when it was issued. A long-lived
    // instruction (virtual account) carries no amount, so the fee is priced now.
    const required =
      instruction.amountMinor !== null && instruction.currency !== null
        ? { requiredMinor: instruction.amountMinor, currency: instruction.currency }
        : await obligations.getRequiredPayment({
            tenantId,
            config,
            assetId: asset.id,
            assetTypeKey: asset.assetTypeKey,
            businessDate,
          });

    if (event.amount.currency !== required.currency) {
      const payment = await store("suspense", "currency_mismatch", { assetId: asset.id });
      await repos.webhookEvents.markProcessed(tenantId, eventRow.id, payment.id);
      return { outcome: "suspense", accepted: true, tenantId, paymentId: payment.id };
    }

    const settledStatus = await obligations.getPeriodStatus(tenantId, asset.id, businessDate);
    const alreadySettled = settledStatus.status === "paid" || settledStatus.status === "waived";

    // Nothing is left to ask for, or the day is already settled: the money is
    // real and must land in the wallet, but no day is declared by it.
    if (alreadySettled || required.requiredMinor === 0n) {
      const payment = await creditToWallet({
        tx,
        tenantId,
        config,
        repos,
        event,
        assetId: asset.id,
        instructionId: instruction.id,
        attributionKind: instruction.kind,
        reason: alreadySettled ? "already_settled" : "nothing_required",
      });
      await repos.webhookEvents.markProcessed(tenantId, eventRow.id, payment.id);
      return { outcome: "credited", accepted: true, tenantId, paymentId: payment.id };
    }

    if (amountMinor < required.requiredMinor && config.payments.underpaymentPolicy === "suspense") {
      const payment = await store("suspense", "underpayment", { assetId: asset.id });
      await repos.webhookEvents.markProcessed(tenantId, eventRow.id, payment.id);
      return { outcome: "suspense", accepted: true, tenantId, paymentId: payment.id };
    }

    if (amountMinor < required.requiredMinor) {
      const payment = await creditToWallet({
        tx,
        tenantId,
        config,
        repos,
        event,
        assetId: asset.id,
        instructionId: instruction.id,
        attributionKind: instruction.kind,
        reason: "underpayment",
        shortfallMinor: required.requiredMinor - amountMinor,
        assetRef,
        recipient,
      });
      await repos.webhookEvents.markProcessed(tenantId, eventRow.id, payment.id);
      return { outcome: "credited", accepted: true, tenantId, paymentId: payment.id };
    }

    const number = nextReceiptNumber();
    const beforeBalance = await obligations.getWalletBalance(tenantId, asset.id);
    const daySettled = await obligations.ensurePaidForBusinessDay({
      tenantId,
      config,
      assetId: asset.id,
      assetTypeKey: asset.assetTypeKey,
      businessDate,
      amount: money(required.currency, Number(amountMinor)),
      sourceId: event.providerEventId,
      idempotencyKey: `webhook:${eventRow.id}`,
    });
    if (daySettled.period === null) {
      throw new PaymentError("payment could not be settled: no period was recorded");
    }
    const afterBalance = await obligations.getWalletBalance(tenantId, asset.id);

    const payment = await repos.payments.create(tenantId, {
      provider,
      providerEventId: event.providerEventId,
      providerReference: event.providerReference,
      status: "applied",
      amountMinor,
      currency: required.currency,
      assetId: asset.id,
      instructionId: instruction.id,
      attributionKind: instruction.kind,
      businessDate,
      obligationPeriodId: daySettled.period.id,
      transactionId:
        daySettled.period.paidTransactionId ?? daySettled.allocationTransactions[0]?.id ?? null,
      receiptNumber: number,
      metadata: { raw: event.raw, surplusMinor: String(afterBalance - beforeBalance) },
    });

    if (recipient !== null) {
      await repos.smsLog.enqueue(tenantId, {
        kind: "receipt",
        recipient,
        paymentId: payment.id,
        body: renderReceiptSms({
          template: config.channels.smsReceiptTemplate,
          amountMinor,
          currency: required.currency,
          locale: config.locale.numberFormat,
          dateFormat: config.locale.dateFormat,
          assetRef,
          receiptNumber: number,
          businessDate,
        }),
      });
    }

    await repos.webhookEvents.markProcessed(tenantId, eventRow.id, payment.id);
    return {
      outcome: "applied",
      accepted: true,
      tenantId,
      paymentId: payment.id,
      receiptNumber: number,
    };
  }

  interface CreditInput {
    readonly tx: Transaction<import("@tpirs/db").Database>;
    readonly tenantId: string;
    readonly config: TenantConfig;
    readonly repos: ReturnType<typeof repositories>;
    readonly event: ReturnType<PaymentProvider["normalizeWebhook"]>;
    readonly assetId: string;
    readonly instructionId: string;
    readonly attributionKind: PaymentRow["attributionKind"];
    readonly reason: string;
    readonly shortfallMinor?: bigint;
    readonly assetRef?: string;
    readonly recipient?: string | null;
  }

  /** Records a payment that settles no day: the money lands in the asset wallet. */
  async function creditToWallet(input: CreditInput): Promise<PaymentRow> {
    const { tenantId, config, repos, event, assetId } = input;
    const amountMinor = BigInt(event.amount.amount);
    const amount = { amount: Number(amountMinor), currency: event.amount.currency };

    const ledger = new LedgerService(input.tx, repos);
    const posted = await ledger.postTransaction(tenantId, {
      idempotencyKey: `credit:${event.providerEventId}`,
      postings: [
        { accountCode: "GATEWAY_CLEARING", direction: "debit", amount, assetId },
        { accountCode: "ASSET_WALLET", direction: "credit", amount, assetId },
      ],
      sourceType: "payment",
      sourceId: event.providerEventId,
      description: "Payment credited to wallet (no day settled)",
    });

    const payment = await repos.payments.create(tenantId, {
      provider: input.event.providerEventId === "" ? "" : event.providerEventId,
      providerEventId: event.providerEventId,
      providerReference: event.providerReference,
      status: "credited",
      amountMinor,
      currency: event.amount.currency,
      assetId,
      instructionId: input.instructionId,
      attributionKind: input.attributionKind,
      transactionId: posted.transaction.id,
      failureReason: input.reason,
      metadata: { raw: event.raw },
    });

    if (
      input.shortfallMinor !== undefined &&
      input.recipient != null &&
      input.assetRef !== undefined
    ) {
      await repos.smsLog.enqueue(tenantId, {
        kind: "underpayment_notice",
        recipient: input.recipient,
        paymentId: payment.id,
        body: renderUnderpaymentNoticeSms({
          shortfallMinor: input.shortfallMinor,
          currency: event.amount.currency,
          locale: config.locale.numberFormat,
          assetRef: input.assetRef,
          receiptHeader: config.branding.receiptHeader,
        }),
      });
    }

    return payment;
  }

  /**
   * Provisions a webhook endpoint token; returned once, stored only as a hash.
   *
   * This is an administrative action, not a request handler, and the
   * `webhook_endpoints` table deliberately grants the application role nothing,
   * so it runs under the system scope.
   */
  async function provisionEndpoint(input: { tenantId: string; provider: string }): Promise<string> {
    const token = randomOpaqueId();
    await withSystem(deps.db, async (tx) =>
      repositories(tx).webhookEndpoints.create(input.tenantId, {
        provider: input.provider,
        token,
      }),
    );
    return token;
  }

  async function listPayments(input: {
    tenantId: string;
    status?: PaymentRow["status"];
    limit?: number;
  }): Promise<readonly PaymentView[]> {
    const rows = await withTenant(deps.db, input.tenantId, async (tx) =>
      repositories(tx).payments.listRecent(input.tenantId, {
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
    );
    return rows.map(toPaymentView);
  }

  async function listSuspense(input: {
    tenantId: string;
    limit?: number;
  }): Promise<readonly PaymentView[]> {
    return listPayments({ ...input, status: "suspense" });
  }

  /**
   * Finance resolves a suspense item by applying it to the day the operator is
   * resolving. Only a payment still in suspense can be applied, so two
   * operators clicking at once cannot double-post.
   */
  async function resolveSuspense(input: ResolveSuspenseInput): Promise<PaymentView> {
    const config = await requireConfig(input.tenantId);

    const resolved = await withTenant(deps.db, input.tenantId, async (tx) => {
      const repos = repositories(tx);
      const payment = await repos.payments.findById(input.tenantId, input.paymentId);
      if (payment === undefined) throw new PaymentError("Payment not found");
      if (payment.status !== "suspense") {
        throw new PaymentError("Only a suspense payment can be applied by finance");
      }

      const asset = await repos.assets.findById(input.assetId);
      if (asset === undefined) throw new PaymentError("Asset not found");

      const businessDate = todayInTimeZone(config.locale.timezone, now());
      const number = nextReceiptNumber();
      const daySettled = await obligations.ensurePaidForBusinessDay({
        tenantId: input.tenantId,
        config,
        assetId: asset.id,
        assetTypeKey: asset.assetTypeKey,
        businessDate,
        amount: money(payment.currency, Number(payment.amountMinor)),
        idempotencyKey: `suspense:${payment.id}`,
      });
      if (daySettled.period === null) {
        throw new PaymentError("payment could not be settled: no period was recorded");
      }

      const updated = await repos.payments.applyFromSuspense(input.tenantId, payment.id, {
        businessDate,
        obligationPeriodId: daySettled.period.id,
        transactionId:
          daySettled.period.paidTransactionId ?? daySettled.allocationTransactions[0]?.id ?? "",
        receiptNumber: number,
        assetId: asset.id,
        // A payment that intake already attributed (a currency mismatch, say)
        // knows its asset and keeps that attribution. One intake could not
        // attribute at all is attributed here, by a human.
        ...(payment.attributionKind === null ? { attributionKind: "narration" as const } : {}),
      });
      if (updated === undefined) throw new PaymentError("Payment was already resolved");

      const owner = asset.ownerId === null ? undefined : await repos.owners.findById(asset.ownerId);
      if (owner?.phone != null) {
        await repos.smsLog.enqueue(input.tenantId, {
          kind: "receipt",
          recipient: owner.phone,
          paymentId: updated.id,
          body: renderReceiptSms({
            template: config.channels.smsReceiptTemplate,
            amountMinor: updated.amountMinor,
            currency: updated.currency,
            locale: config.locale.numberFormat,
            dateFormat: config.locale.dateFormat,
            assetRef: assetRefFor(asset.attributes, asset.shortCode),
            receiptNumber: number,
            businessDate,
          }),
        });
      }

      // Applying money that arrived without a reference is a state change a
      // human asked for, so it is attributed to that human in the audit trail.
      await repos.audit.record({
        tenantId: input.tenantId,
        actorUserId: input.approvedByUserId,
        action: "payment.suspense_resolved",
        entityType: "payment",
        entityId: updated.id,
        before: { status: payment.status, failureReason: payment.failureReason },
        after: {
          status: updated.status,
          assetId: updated.assetId,
          businessDate: updated.businessDate,
          receiptNumber: updated.receiptNumber,
        },
      });

      return updated;
    });

    return toPaymentView(resolved);
  }

  async function listOutbox(input: {
    tenantId: string;
    paymentId: string;
  }): Promise<readonly SmsLogRow[]> {
    return withTenant(deps.db, input.tenantId, async (tx) =>
      repositories(tx).smsLog.findByPayment(input.tenantId, input.paymentId),
    );
  }

  return {
    createIntent,
    ingestWebhookEvent,
    provisionEndpoint,
    listPayments,
    listSuspense,
    resolveSuspense,
    listOutbox,
  };
}

export type PaymentServiceType = ReturnType<typeof createPaymentService>;

/** Re-exported so callers can name the tenant id type without importing domain. */
export type { TenantId };
