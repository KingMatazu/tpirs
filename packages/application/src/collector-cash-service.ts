import { todayInTimeZone } from "@tpirs/domain";
import { CashError, assertWithinCeiling, canIntake } from "@tpirs/domain";
import type { BusinessDate, Money } from "@tpirs/domain";
import { assetTypeId, tenantId as tenantRef } from "@tpirs/domain";
import { randomOpaqueId } from "@tpirs/crypto";
import type { AnyDb } from "@tpirs/db";
import type { FeeEngine, ResolvedFee } from "@tpirs/ports";
import type { TenantConfig } from "@tpirs/config";
import type { TenantConfigLoader } from "./asset-service.js";
import { ObligationService } from "./obligation-service.js";
import { withLedger } from "./ledger-service.js";
import type { LedgerContext } from "./ledger-service.js";
import { renderCashReceiptSms } from "./receipt-renderer.js";

type AssetRow = NonNullable<Awaited<ReturnType<LedgerContext["repos"]["assets"]["findById"]>>>;

export interface CollectorCashIntakeInput {
  readonly tenantId: string;
  /** The collector handing over the cash; every posting carries this id. */
  readonly collectorUserId: string;
  /** Which asset the cash settles. Exactly the shapes the field app sends. */
  readonly assetId?: string;
  readonly token?: string;
  readonly reference?: string;
  /** The cash the collector says they hold, in the tenant's currency. */
  readonly amount: Money;
  /** Idempotency key from the admin form: the same submit twice is one intake. */
  readonly clientReference: string;
  readonly businessDate?: BusinessDate;
  /** Zone the intake happened in; defaults to the asset's zone for reporting. */
  readonly zoneId?: string | null;
}

export interface CollectorCashIntakeResult {
  readonly tenantId: string;
  readonly collectorUserId: string;
  readonly intakeId: string;
  /** True when the client reference was already recorded and nothing changed. */
  readonly replayed: boolean;
  readonly assetId: string;
  readonly assetRef: string;
  readonly receiptNumber: string;
  readonly businessDate: BusinessDate;
  /** The collector's derived COLLECTOR_CASH balance after this intake. */
  readonly balanceMinor: bigint;
  /** Whether a cash receipt SMS is waiting in the outbox for the owner. */
  readonly smsQueued: boolean;
}

export interface CollectorCashServiceDeps {
  readonly db: AnyDb;
  readonly loadConfig: TenantConfigLoader;
  readonly feeEngine: FeeEngine;
  readonly now?: () => Date;
}

/** The receipt number a driver can quote; opaque and unique per tenant. */
function nextReceiptNumber(): string {
  return `R-${randomOpaqueId().slice(0, 12).toUpperCase()}`;
}

/** What the driver recognises the asset by, taken from its own attributes. */
function assetRefOf(attributes: Readonly<Record<string, unknown>>, shortCode: string): string {
  const candidate = attributes["plate_number"] ?? attributes["plateNumber"];
  return typeof candidate === "string" && candidate.trim() !== "" ? candidate : shortCode;
}

/**
 * Cash intake at the zone (Phase 7).
 *
 * The admin form calls one method, `recordIntake`, and everything that has to
 * agree happens inside one `withLedger` transaction: the asset lock, the fee
 * and already-paid checks, the float-ceiling check, the day settlement, the
 * intake record and the SMS receipt. A partial failure leaves nothing behind,
 * and a double submit changes nothing (replay), because every step is either
 * guarded by a lock or idempotent on the client reference.
 *
 * Errors carry a `code` from the domain's `CashErrorCode`, so the API layer can
 * translate them into stable problem details without parsing messages.
 */
export class CollectorCashService {
  constructor(private readonly deps: CollectorCashServiceDeps) {}

  async requireConfig(tenantId: string): Promise<TenantConfig> {
    const config = await this.deps.loadConfig(tenantId);
    if (config === undefined) {
      throw new Error(`No configuration found for tenant "${tenantId}"`);
    }
    return config;
  }

  async recordIntake(input: CollectorCashIntakeInput): Promise<CollectorCashIntakeResult> {
    const config = await this.requireConfig(input.tenantId);
    if (!config.cashRules.enabled) {
      throw new CashError("cash_disabled", "collector cash intake is not enabled for this tenant");
    }

    const now = this.deps.now?.() ?? new Date();
    const businessDate = input.businessDate ?? todayInTimeZone(config.locale.timezone, now);
    const obligations = new ObligationService(this.deps.db, this.deps.feeEngine);

    return withLedger(this.deps.db, input.tenantId, ({ ledger, repos }) =>
      this.intakeInScope({ ledger, repos, config, obligations }, input, businessDate),
    );
  }

  private async intakeInScope(
    context: LedgerContext & {
      readonly config: TenantConfig;
      readonly obligations: ObligationService;
    },
    input: CollectorCashIntakeInput,
    businessDate: BusinessDate,
  ): Promise<CollectorCashIntakeResult> {
    const { config, obligations } = context;
    const { ledger, repos } = context;
    const tenantId = input.tenantId;

    // 0. A replay is answered before any check that a fresh intake has to
    //    pass: by now the day is paid, and "already paid" would be a hostile
    //    answer to a double click.
    const existing = await repos.collectorCash.findIntakeByClientReference(
      tenantId,
      input.collectorUserId,
      input.clientReference,
    );
    if (existing !== undefined) {
      const asset = await this.requireAsset(repos, existing.assetId);
      return {
        tenantId,
        collectorUserId: input.collectorUserId,
        intakeId: existing.id,
        replayed: true,
        assetId: existing.assetId,
        assetRef: assetRefOf(asset.attributes, asset.shortCode),
        receiptNumber: existing.receiptNumber,
        businessDate: existing.businessDate as BusinessDate,
        balanceMinor: await repos.ledger.collectorCashBalance(tenantId, input.collectorUserId),
        smsQueued: await this.hasQueuedReceipt(repos, tenantId, existing.id),
      };
    }

    // 1. Resolve and lock the pieces the intake touches, in a fixed order
    //    (wallet before asset obligations), so concurrent intakes serialise
    //    and the derived balance the ceiling check reads cannot move under it.
    const asset = await this.resolveAsset(repos, input);
    const wallet = await repos.collectorCash.lockWallet(tenantId, input.collectorUserId);
    if (!canIntake(wallet.status)) {
      throw new CashError(
        "wallet_frozen",
        `collector wallet is frozen: ${wallet.frozenReason ?? "unspecified"}`,
      );
    }

    // 2. The tenant's fee engine decides what the day costs; cash must match
    //    it exactly. Partial cash is not allocated charitably (D9): the
    //    collector either holds the full fee or the intake is simply refused,
    //    because there is no gateway flow to collect the rest from.
    const fee = await this.resolveFee(tenantId, asset.assetTypeKey, businessDate);
    if (fee.currency !== input.amount.currency) {
      throw new CashError(
        "amount_mismatch",
        `fee currency ${fee.currency} does not match cash currency ${input.amount.currency}`,
      );
    }
    const existingDay = await repos.obligations.findByAssetAndPeriod(
      tenantId,
      asset.id,
      businessDate,
    );
    if (
      existingDay !== undefined &&
      (existingDay.status === "paid" || existingDay.status === "waived")
    ) {
      throw new CashError(
        "already_paid",
        `day ${businessDate} is already settled for this asset; no wallet credit may absorb the cash`,
      );
    }
    if (BigInt(input.amount.amount) !== BigInt(fee.amountMinor)) {
      throw new CashError(
        "amount_mismatch",
        `cash intake requires the exact fee ${fee.amountMinor}, got ${input.amount.amount}`,
      );
    }

    // 3. The float ceiling is per collector, with an optional override on the
    //    wallet row. The balance is derived, never stored (ADR 0031).
    const ceilingMinor = wallet.floatCeilingMinor ?? BigInt(config.cashRules.floatCeilingMinor);
    const balanceMinor = await repos.ledger.collectorCashBalance(tenantId, input.collectorUserId);
    assertWithinCeiling({
      balanceMinor: Number(balanceMinor),
      intakeMinor: input.amount.amount,
      ceilingMinor: Number(ceilingMinor),
    });

    // 4. Settle the day through the same engine a gateway payment uses.
    const daySettled = await obligations.settleInScope(
      { ledger, repos },
      {
        tenantId,
        config,
        assetId: asset.id,
        assetTypeKey: asset.assetTypeKey,
        businessDate,
        amount: input.amount,
        fundingAccount: "COLLECTOR_CASH",
        collectorUserId: input.collectorUserId,
        sourceId: input.clientReference,
        idempotencyKey: `cash:${input.clientReference}`,
      },
    );

    // 5. Record the intake, keyed so a retried submit returns the first row.
    const receiptNumber = nextReceiptNumber();
    const { intake } = await repos.collectorCash.insertIntakeIfAbsent(tenantId, {
      collectorUserId: input.collectorUserId,
      clientReference: input.clientReference,
      assetId: asset.id,
      zoneId: input.zoneId ?? asset.zoneId,
      businessDate,
      amountMinor: BigInt(input.amount.amount),
      currency: input.amount.currency,
      receiptNumber,
      obligationPeriodId: daySettled.period?.id ?? null,
      transactionId: daySettled.walletTransaction?.id ?? null,
    });

    // 6. Send the owner the same kind of receipt a gateway payment sends, so
    //    drivers do not have to remember which channel took their money.
    const owner = asset.ownerId === null ? undefined : await repos.owners.findById(asset.ownerId);
    let smsQueued = false;
    const recipient = owner?.phone ?? null;
    if (recipient !== null) {
      const queued = await repos.smsLog.enqueue(tenantId, {
        kind: "cash_receipt",
        recipient,
        cashIntakeId: intake.id,
        body: renderCashReceiptSms({
          ...(config.channels.cashReceiptTemplate === undefined
            ? {}
            : { template: config.channels.cashReceiptTemplate }),
          amountMinor: BigInt(input.amount.amount),
          currency: input.amount.currency,
          locale: config.locale.numberFormat,
          dateFormat: config.locale.dateFormat,
          assetRef: assetRefOf(asset.attributes, asset.shortCode),
          receiptNumber: intake.receiptNumber,
          businessDate,
        }),
      });
      smsQueued = queued !== undefined;
    }

    return {
      tenantId,
      collectorUserId: input.collectorUserId,
      intakeId: intake.id,
      replayed: false,
      assetId: asset.id,
      assetRef: assetRefOf(asset.attributes, asset.shortCode),
      receiptNumber: intake.receiptNumber,
      businessDate,
      balanceMinor: await repos.ledger.collectorCashBalance(tenantId, input.collectorUserId),
      smsQueued,
    };
  }

  private async hasQueuedReceipt(
    repos: LedgerContext["repos"],
    tenantId: string,
    intakeId: string,
  ): Promise<boolean> {
    return (await repos.smsLog.findCashIntakeReceipt(tenantId, intakeId)) !== undefined;
  }

  /** The asset type the repositories hand back. */
  private async resolveAsset(
    repos: LedgerContext["repos"],
    input: CollectorCashIntakeInput,
  ): Promise<AssetRow> {
    if (input.assetId !== undefined && input.assetId.length > 0) {
      const found = await repos.assets.findById(input.assetId);
      if (found !== undefined) return found;
    }
    if (input.token !== undefined && input.token.length > 0) {
      const payload = input.token.includes(".")
        ? input.token.split(".").slice(0, -1).join(".")
        : input.token;
      const found = await repos.assets.findByQrPayload(payload);
      if (found !== undefined) return found;
    }
    if (input.reference !== undefined && input.reference.length > 0) {
      const found = await repos.assets.findByReference(input.reference);
      if (found !== undefined) return found;
    }
    throw new CashError("asset_unknown", "no asset matches the reference given for cash intake");
  }

  private async requireAsset(repos: LedgerContext["repos"], assetId: string): Promise<AssetRow> {
    const asset = await repos.assets.findById(assetId);
    if (asset === undefined) {
      throw new CashError("asset_unknown", `asset ${assetId} no longer exists`);
    }
    return asset;
  }

  private resolveFee(
    tenant: string,
    assetTypeKey: string,
    date: BusinessDate,
  ): Promise<ResolvedFee> {
    return this.deps.feeEngine.resolveFee({
      tenantId: tenantRef(tenant),
      assetType: assetTypeId(assetTypeKey),
      businessDate: date,
    });
  }
}

export function createCollectorCashService(deps: CollectorCashServiceDeps): CollectorCashService {
  return new CollectorCashService(deps);
}
