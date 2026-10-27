import { todayInTimeZone } from "@tpirs/domain";
import { CashError, assertWithinCeiling, canIntake, money } from "@tpirs/domain";
import type { BusinessDate, Money } from "@tpirs/domain";
import { assetTypeId, tenantId as tenantRef } from "@tpirs/domain";
import { randomOpaqueId } from "@tpirs/crypto";
import type { CashDepositRow, CollectorDepositInstructionRow } from "@tpirs/db";
import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { PortError } from "@tpirs/ports";
import type { FeeEngine, PaymentProvider, ResolvedFee } from "@tpirs/ports";
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

/**
 * The outcome of one deposit event or manual match.
 *
 * `allocatedMinor` is what the deposit has posted to the ledger so far; a
 * `suspense` deposit has posted nothing, and the row's full amount waits for
 * coverage (D35).
 */
export interface CashDepositResult {
  readonly outcome: "matched" | "partial" | "suspense";
  readonly depositId: string;
  readonly collectorUserId: string | null;
  readonly allocatedMinor: bigint;
  readonly currency: string;
  /** True when the provider reference was already recorded and nothing changed. */
  readonly replayed: boolean;
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
  /** Resolves a provider name to its adapter, for deposit instruction provisioning. */
  readonly providerFor?: (provider: string) => PaymentProvider | undefined;
  readonly now?: () => Date;
}

/** The receipt number a driver can quote; opaque and unique per tenant. */
function nextReceiptNumber(): string {
  return `R-${randomOpaqueId().slice(0, 12).toUpperCase()}`;
}

/** The coverage one deposit has posted, summed from its allocation rows. */
function depositsCovered(rows: readonly { readonly amountMinor: bigint }[]): bigint {
  return rows.reduce((total, row) => total + row.amountMinor, 0n);
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

  // ---------------------------------------------------------------- deposits

  /**
   * Provisions (rotates) a collector's dedicated deposit instruction (ADR 0032).
   *
   * The kind and the reference come from the adapter — one that does not offer
   * per-collector deposit mechanics makes this throw instead of letting the
   * platform invent a format the provider cannot recognise in its webhook.
   * Rotating revokes the previous active instruction, so exactly one live
   * destination exists for `(collector, provider)` at any time.
   */
  async provisionDepositInstruction(input: {
    readonly tenantId: string;
    readonly collectorUserId: string;
    readonly provider: string;
  }): Promise<CollectorDepositInstructionRow> {
    if (this.deps.providerFor === undefined) {
      throw new PortError("PaymentProvider", "not_found", "no payment providers are configured");
    }
    const adapter = this.deps.providerFor(input.provider);
    if (adapter === undefined) {
      throw new PortError(
        "PaymentProvider",
        "not_found",
        `Unknown payment provider "${input.provider}"`,
      );
    }
    if (adapter.createDepositAttribution === undefined) {
      throw new PortError(
        "PaymentProvider",
        "invalid_request",
        `Provider "${input.provider}" does not offer collector deposit attribution`,
      );
    }
    const attribution = await adapter.createDepositAttribution({
      collectorUserId: input.collectorUserId,
      idempotencyKey: `cash:${input.tenantId}:${input.collectorUserId}:${randomOpaqueId()}`,
    });

    return withTenant(this.deps.db, input.tenantId, async (tx) => {
      const repos = repositories(tx);
      const previous = await repos.collectorCash.findActiveInstructionForCollector(
        input.tenantId,
        input.collectorUserId,
        input.provider,
      );
      if (previous !== undefined) {
        await repos.collectorCash.revokeInstruction(input.tenantId, previous.id);
      }
      return repos.collectorCash.createInstruction(input.tenantId, {
        collectorUserId: input.collectorUserId,
        provider: input.provider,
        reference: attribution.value,
        kind: attribution.kind,
      });
    });
  }

  /**
   * One arriving deposit webhook, resolved against the collector's deposit
   * instructions before any payment attribution happens (ADR 0032).
   *
   * Returns `undefined` when the reference is not a deposit instruction, so
   * the payment flow continues. A recognised deposit always inserts the
   * `cash_deposits` row; the ledger only moves when the deposit actually
   * covers open intakes. An over-deposit or an unmatched one stays in
   * suspense with no posting (D35), exactly like gateway suspense.
   */
  async ingestDeposit(input: {
    readonly tenantId: string;
    readonly config: TenantConfig;
    readonly provider: string;
    readonly event: {
      readonly providerEventId: string;
      readonly providerReference: string;
      readonly amount: Money;
      readonly status: "success" | "failed";
    };
  }): Promise<CashDepositResult | undefined> {
    return withLedger(this.deps.db, input.tenantId, async ({ ledger, repos }) => {
      const tenantId = input.tenantId;
      const instruction = await repos.collectorCash.findActiveInstruction(
        tenantId,
        input.provider,
        input.event.providerReference,
      );
      if (instruction === undefined) {
        return undefined;
      }

      const { deposit, existed } = await repos.collectorCash.insertDepositIfAbsent(tenantId, {
        provider: input.provider,
        providerReference: input.event.providerReference,
        amountMinor: BigInt(input.event.amount.amount),
        currency: input.event.amount.currency,
        collectorUserId: instruction.collectorUserId,
      });

      // A replay answers with the record and changes nothing.
      if (existed) {
        return this.depositResult(repos, deposit, true);
      }

      // Failed notifications record nothing beyond the deposit row, because
      // no money arrived; the caller decides whether it can happen.
      if (input.event.status === "failed") {
        return this.depositResult(repos, deposit, false, "suspense");
      }

      const collector = deposit.collectorUserId;
      if (collector === null || input.event.amount.currency !== input.config.locale.currency) {
        return this.depositResult(repos, deposit, false, "suspense");
      }

      // Oldest open intake first, with partial coverage allowed. A deposit
      // larger than the open intakes posts nothing at all: the surplus waits
      // in suspense until an intake can cover it (D35), so the day-close
      // arithmetic stays "intake minus posted deposits equals balance".
      const totalRemaining = await this.remainingOpenTotal(repos, tenantId, collector);
      const depositMinor = BigInt(input.event.amount.amount);
      if (depositMinor > totalRemaining || totalRemaining === 0n) {
        return this.depositResult(repos, deposit, false, "suspense");
      }

      await ledger.postTransaction(tenantId, {
        idempotencyKey: `deposit:${deposit.id}`,
        postings: [
          {
            accountCode: "SETTLEMENT_BANK",
            direction: "debit",
            amount: money(input.event.amount.currency, Number(depositMinor)),
            collectorUserId: collector,
          },
          {
            accountCode: "COLLECTOR_CASH",
            direction: "credit",
            amount: money(input.event.amount.currency, Number(depositMinor)),
            collectorUserId: collector,
          },
        ],
        sourceType: "cash_deposit",
        sourceId: deposit.id,
        description: `Deposit received via ${input.provider}`,
      });

      let budget = depositMinor;
      const allocations: { readonly intakeId: string; readonly amountMinor: bigint }[] = [];
      for (const intake of await repos.collectorCash.openIntakesForCollector(tenantId, collector)) {
        if (budget === 0n) break;
        const already = await repos.collectorCash.sumIntakeAllocation(tenantId, intake.id);
        const remaining = intake.amountMinor - already;
        if (remaining <= 0n) continue;
        const take = remaining <= budget ? remaining : budget;
        await repos.collectorCash.addDepositAllocation(tenantId, {
          depositId: deposit.id,
          intakeId: intake.id,
          amountMinor: take,
        });
        if (already + take >= intake.amountMinor) {
          await repos.collectorCash.markIntakeMatched(tenantId, intake.id);
        }
        allocations.push({ intakeId: intake.id, amountMinor: take });
        budget -= take;
      }

      const status: CashDepositResult["outcome"] =
        budget === 0n && depositMinor === depositsCovered(allocations) ? "matched" : "partial";
      await repos.collectorCash.setDepositOutcome(tenantId, deposit.id, { status });
      return this.depositResult(repos, deposit, false, status);
    });
  }

  /**
   * Finance manual matching of a suspense deposit to one intake (ADR 0032).
   *
   * Posts `Dr SETTLEMENT_BANK / Cr COLLECTOR_CASH` for exactly what the target
   * absorbs, appends one allocation row and leaves any remainder of a larger
   * deposit still unposted, which keeps it matchable later. Repeating the
   * same request (same deposit, intake and amount) is a no-op, not a second
   * posting.
   */
  async matchDeposit(input: {
    readonly tenantId: string;
    readonly depositId: string;
    readonly intakeId: string;
    /** Defaults to the deposit's remaining amount. */
    readonly amountMinor?: bigint;
    /** The finance user doing the matching; recorded on the ledger transaction. */
    readonly approvedByUserId: string;
  }): Promise<CashDepositResult> {
    return withLedger(this.deps.db, input.tenantId, async ({ ledger, repos }) => {
      const tenantId = input.tenantId;
      const deposit = await repos.collectorCash.findDepositById(tenantId, input.depositId);
      if (deposit === undefined) {
        throw new CashError("deposit_unknown", `deposit ${input.depositId} was not found`);
      }
      const intake = await repos.collectorCash.findIntakeById(tenantId, input.intakeId);
      if (intake === undefined) {
        throw new CashError("deposit_unknown", `intake ${input.intakeId} was not found`);
      }
      if (deposit.collectorUserId === null) {
        throw new CashError("deposit_state", "the deposit has no attributed collector");
      }
      if (intake.collectorUserId !== deposit.collectorUserId) {
        throw new CashError("deposit_state", "the deposit belongs to another collector");
      }

      const already = await repos.collectorCash.sumIntakeAllocation(tenantId, intake.id);
      const allocations = await repos.collectorCash.listDepositAllocations(tenantId, deposit.id);
      const previousPair = allocations.find((row) => row.intakeId === intake.id);
      const previouslyAllocated = depositsCovered(allocations);
      const remainingPayable = deposit.amountMinor - previouslyAllocated;
      const remainingIntake = intake.amountMinor - already;

      // A deposit may post to a given intake once (unique per pair). Repeating
      // the identical request is a no-op; anything else for a covered pair is
      // refused instead of posting twice.
      if (previousPair !== undefined) {
        const pairConsumed = remainingPayable <= 0n || remainingIntake <= 0n;
        const sameRequest =
          (input.amountMinor !== undefined && input.amountMinor === previousPair.amountMinor) ||
          (input.amountMinor === undefined && pairConsumed);
        if (sameRequest) {
          return this.depositResult(repos, deposit, true);
        }
        throw new CashError(
          "deposit_state",
          `the deposit already posted ${previousPair.amountMinor} to this intake`,
        );
      }
      if (intake.status !== "open") {
        throw new CashError("deposit_state", "the target intake is not open");
      }
      if (remainingPayable <= 0n) {
        throw new CashError("deposit_state", "the deposit has no unposted remainder");
      }

      // The default is what the pair can actually absorb, clamped both ways.
      const requested =
        input.amountMinor ??
        (remainingPayable <= remainingIntake ? remainingPayable : remainingIntake);
      if (requested <= 0n || requested > remainingIntake) {
        throw new CashError(
          "invalid_amount",
          `requested match ${requested} exceeds the intake's remaining ${remainingIntake}`,
        );
      }
      if (requested > remainingPayable) {
        throw new CashError(
          "invalid_amount",
          `requested match ${requested} exceeds the deposit's remaining ${remainingPayable}`,
        );
      }

      await ledger.postTransaction(tenantId, {
        idempotencyKey: `deposit-match:${deposit.id}:${intake.id}:${requested}`,
        postings: [
          {
            accountCode: "SETTLEMENT_BANK",
            direction: "debit",
            amount: money(deposit.currency, Number(requested)),
            collectorUserId: deposit.collectorUserId,
          },
          {
            accountCode: "COLLECTOR_CASH",
            direction: "credit",
            amount: money(deposit.currency, Number(requested)),
            collectorUserId: deposit.collectorUserId,
          },
        ],
        sourceType: "cash_deposit",
        sourceId: deposit.id,
        description: "Deposit manually matched to intake",
        createdByUserId: input.approvedByUserId,
      });

      await repos.collectorCash.addDepositAllocation(tenantId, {
        depositId: deposit.id,
        intakeId: intake.id,
        amountMinor: requested,
      });
      if (already + requested >= intake.amountMinor) {
        await repos.collectorCash.markIntakeMatched(tenantId, intake.id);
      }
      const status: CashDepositResult["outcome"] =
        previouslyAllocated + requested === deposit.amountMinor ? "matched" : "partial";
      await repos.collectorCash.setDepositOutcome(tenantId, deposit.id, { status });
      const updated = await repos.collectorCash.findDepositById(tenantId, deposit.id);
      return this.depositResult(repos, updated ?? deposit, false, status);
    });
  }

  /** The intake coverage one deposit has posted, summed from its allocation rows. */
  private async depositAllocated(
    repos: LedgerContext["repos"],
    tenantId: string,
    depositId: string,
  ): Promise<bigint> {
    const rows = await repos.collectorCash.listDepositAllocations(tenantId, depositId);
    return depositsCovered(rows);
  }

  private async depositResult(
    repos: LedgerContext["repos"],
    deposit: CashDepositRow,
    replayed: boolean,
    status?: CashDepositResult["outcome"],
  ): Promise<CashDepositResult> {
    return {
      outcome: status ?? deposit.status,
      depositId: deposit.id,
      collectorUserId: deposit.collectorUserId,
      allocatedMinor: await this.depositAllocated(repos, deposit.tenantId, deposit.id),
      currency: deposit.currency,
      replayed,
    };
  }

  /** The amount of the collector's open intakes deposits have not covered yet. */
  private async remainingOpenTotal(
    repos: LedgerContext["repos"],
    tenantId: string,
    collectorUserId: string,
  ): Promise<bigint> {
    let total = 0n;
    for (const intake of await repos.collectorCash.openIntakesForCollector(
      tenantId,
      collectorUserId,
    )) {
      const remaining =
        intake.amountMinor - (await repos.collectorCash.sumIntakeAllocation(tenantId, intake.id));
      if (remaining > 0n) total += remaining;
    }
    return total;
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
