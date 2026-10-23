import type { Database, ObligationPeriodRow, ReversalRequestRow, TransactionRow } from "@tpirs/db";
import { assetTypeId, planAllocation, planPeriodDates, tenantId } from "@tpirs/domain";
import type { BusinessDate, Money } from "@tpirs/domain";
import type { FeeEngine, ResolvedFee } from "@tpirs/ports";
import type { TenantConfig } from "@tpirs/config";
import type { Kysely } from "kysely";
import { withLedger } from "./ledger-service.js";
import type { LedgerRepos } from "./ledger-service.js";

export class ObligationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObligationError";
  }
}

export interface EnsurePaidInput {
  readonly tenantId: string;
  readonly config: TenantConfig;
  readonly assetId: string;
  readonly assetTypeKey: string;
  readonly businessDate: BusinessDate;
  readonly amount: Money;
  readonly paymentId?: string | null;
  readonly sourceId?: string | null;
  /** Key that makes the whole payment idempotent. */
  readonly idempotencyKey?: string | null;
}

export interface EnsurePaidResult {
  readonly period: ObligationPeriodRow | null;
  readonly walletTransaction: TransactionRow | null;
  readonly allocationTransactions: readonly TransactionRow[];
  /** Total allocated to obligation periods, in minor units. */
  readonly allocatedMinor: bigint;
  /** Wallet credit left after allocation, in minor units. */
  readonly surplusMinor: bigint;
}

export interface AllocateFromWalletInput {
  readonly tenantId: string;
  readonly config: TenantConfig;
  readonly assetId: string;
  readonly assetTypeKey: string;
  readonly businessDate: BusinessDate;
  readonly amount: Money;
  readonly sourceId?: string | null;
  readonly idempotencyKey?: string | null;
}

export interface AllocateFromWalletResult {
  readonly allocations: readonly {
    readonly periodId: string;
    readonly amountMinor: bigint;
    readonly fullyPaid: boolean;
  }[];
  readonly allocatedMinor: bigint;
  readonly remainingMinor: bigint;
}

export interface GeneratePeriodsResult {
  readonly created: number;
  readonly skipped: number;
}

/** Where an asset stands for one business day, for verification and intake. */
export interface PeriodStatus {
  /** `null` when no period exists for that day - never a debt under `pay_per_use`. */
  readonly periodId: string | null;
  readonly status: "unpaid" | "paid" | "waived" | "none";
  readonly businessDate: BusinessDate;
  readonly amountMinor: bigint;
  readonly amountPaidMinor: bigint;
  readonly currency: string;
}

export interface RequiredPaymentResult {
  /** The day's fee, as priced for the asset type. */
  readonly feeMinor: bigint;
  readonly currency: string;
  /** What the driver already holds in the wallet. */
  readonly walletBalanceMinor: bigint;
  /** `fee - wallet balance`, floored at zero: what the driver is asked to send. */
  readonly requiredMinor: bigint;
  /** The day is already settled, so nothing is required at all. */
  readonly alreadySettled: boolean;
}

export interface SettleDeclaredDayInput {
  readonly tenantId: string;
  readonly config: TenantConfig;
  readonly assetId: string;
  readonly assetTypeKey: string;
  readonly businessDate: BusinessDate;
  readonly sourceId?: string | null;
  readonly idempotencyKey?: string | null;
}

export interface SettleDeclaredDayResult {
  readonly settled: boolean;
  readonly periodId: string | null;
  readonly allocatedMinor: bigint;
  readonly shortfallMinor: bigint;
  readonly walletTransactionId: string | null;
  readonly transactionId: string | null;
}

/** Opens a reversal request; delegated so callers never touch the ledger directly. */
export interface RequestReversalInput {
  readonly tenantId: string;
  readonly originalTransactionId: string;
  readonly reason: string;
  readonly requestedByUserId: string;
  readonly isSystemAdmin?: boolean;
}

export interface ApproveReversalInput {
  readonly tenantId: string;
  readonly reversalRequestId: string;
  readonly approverUserId: string;
  readonly isSystemAdmin?: boolean;
  readonly hasFinanceApproval?: boolean;
}

/**
 * Settles obligations for payments.
 *
 * The flow follows build brief section 6: a payment always credits the asset
 * wallet first, then the allocation engine applies that credit to the
 * obligation periods. Money that no period claims stays in the wallet, so a
 * surplus is never lost and never silently becomes revenue.
 */
export class ObligationService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly feeEngine: FeeEngine,
  ) {}

  /**
   * Records a payment and settles the obligation periods it covers.
   *
   * Under `pay_per_use` only the current business day can be settled: a day
   * with no payment is never a debt, so no row is created for it and no other
   * day is touched. Under `scheduled` the outstanding periods are drained in
   * the tenant's allocation order.
   *
   * The whole operation is idempotent per payment: replaying it returns the
   * original transactions instead of posting again.
   */
  async ensurePaidForBusinessDay(input: EnsurePaidInput): Promise<EnsurePaidResult> {
    const { tenantId, config, assetId, amount } = input;
    const model = config.obligations.model;
    const sourceId = input.sourceId ?? input.paymentId ?? null;
    const paymentKey =
      input.idempotencyKey ??
      (input.paymentId === undefined || input.paymentId === null
        ? null
        : `payment:${input.paymentId}`);

    return withLedger(this.db, tenantId, async ({ ledger, repos }) => {
      await repos.obligations.lockAssetObligations(tenantId, assetId);

      const fee = await this.resolveFee(tenantId, input.assetTypeKey, input.businessDate);
      if (fee.currency !== amount.currency) {
        throw new ObligationError(
          `fee currency ${fee.currency} does not match payment currency ${amount.currency}`,
        );
      }

      // 1. Credit the wallet. This happens for every payment, even one that
      //    settles nothing: the money arrived and must be on the books.
      //    Both legs carry the asset, so the gateway clearing balance can be
      //    attributed per asset during reconciliation.
      let walletTransaction: TransactionRow | null = null;
      if (amount.amount > 0) {
        const walletPost = await ledger.postTransaction(tenantId, {
          idempotencyKey: paymentKey === null ? null : `${paymentKey}:wallet`,
          postings: [
            { accountCode: "GATEWAY_CLEARING", direction: "debit", amount, assetId },
            { accountCode: "ASSET_WALLET", direction: "credit", amount, assetId },
          ],
          sourceType: "payment",
          sourceId,
          description: "Payment received (wallet credit)",
        });
        walletTransaction = walletPost.transaction;
      }

      // 2. Work out which periods exist and what each one costs.
      const periods = await this.materializePeriods(repos, input, fee);

      // 3. Plan the allocation.
      const availableMinor =
        model === "pay_per_use"
          ? BigInt(amount.amount)
          : await repos.ledger.accountBalance(tenantId, "ASSET_WALLET", assetId);

      const plan = planAllocation({
        model,
        order: config.obligations.allocationOrder,
        prepaidAllowed: config.obligations.prepaidAllowed,
        walletBalanceMinor: availableMinor,
        businessDate: input.businessDate,
        periods: periods.map((period) => ({
          id: period.row.id,
          periodStartDate: period.row.businessDate,
          priority: period.row.priority,
          createdAt: period.row.createdAt.toISOString(),
          amountMinor: period.row.amountMinor,
          amountPaidMinor: period.row.amountPaidMinor,
        })),
      });

      // 4. Apply the plan.
      const allocationTransactions: TransactionRow[] = [];
      const periodById = new Map(periods.map((period) => [period.row.id, period]));
      for (const allocation of plan.allocations) {
        const period = periodById.get(allocation.periodId);
        if (period === undefined) continue;
        const allocationMoney = {
          amount: Number(allocation.amountMinor),
          currency: fee.currency,
        };
        const post = await ledger.postTransaction(tenantId, {
          idempotencyKey:
            paymentKey === null ? null : `${paymentKey}:allocation:${allocation.periodId}`,
          postings: [
            {
              accountCode: "ASSET_WALLET",
              direction: "debit",
              amount: allocationMoney,
              assetId,
              obligationPeriodId: period.row.id,
            },
            {
              accountCode: "REVENUE_LEVY",
              direction: "credit",
              amount: allocationMoney,
              assetId,
              obligationPeriodId: period.row.id,
            },
          ],
          sourceType: "allocation",
          sourceId,
          description: "Obligation allocation",
        });
        if (post.replayed) {
          allocationTransactions.push(post.transaction);
          continue;
        }
        allocationTransactions.push(post.transaction);

        const snapshot = {
          feeRuleKey: period.ruleId,
          feeAmountSnapshotMinor: allocation.amountMinor,
        };
        if (allocation.fullyPaid) {
          await repos.obligations.markPaid(
            tenantId,
            period.row.id,
            post.transaction.id,
            period.row.amountMinor,
            snapshot,
          );
        } else {
          await repos.obligations.updatePaidAmount(
            tenantId,
            period.row.id,
            period.row.amountPaidMinor + allocation.amountMinor,
          );
        }
      }

      const primary =
        periods.find((period) => period.row.businessDate === input.businessDate)?.row ?? null;

      return {
        period: primary,
        walletTransaction,
        allocationTransactions,
        allocatedMinor: plan.appliedMinor,
        surplusMinor: plan.remainingMinor,
      };
    });
  }

  /**
   * Applies existing wallet credit to outstanding periods.
   *
   * Used when a payment could not settle a period (a shortfall under
   * `pay_per_use`) and when a scheduled tenant accumulates a credit. Under
   * `pay_per_use` it settles nothing: an idle day is never a debt.
   */
  async allocateFromWallet(input: AllocateFromWalletInput): Promise<AllocateFromWalletResult> {
    const { tenantId, config, assetId } = input;
    const model = config.obligations.model;

    return withLedger(this.db, tenantId, async ({ ledger, repos }) => {
      await repos.obligations.lockAssetObligations(tenantId, assetId);

      if (model === "pay_per_use") {
        return { allocations: [], allocatedMinor: 0n, remainingMinor: 0n };
      }

      const balance = await repos.ledger.accountBalance(tenantId, "ASSET_WALLET", assetId);
      if (balance <= 0n) {
        return { allocations: [], allocatedMinor: 0n, remainingMinor: balance };
      }

      const unpaid = await repos.obligations.findUnpaidForAsset(tenantId, assetId);
      const plan = planAllocation({
        model,
        order: config.obligations.allocationOrder,
        prepaidAllowed: config.obligations.prepaidAllowed,
        walletBalanceMinor: balance,
        businessDate: input.businessDate,
        periods: unpaid.map((period) => ({
          id: period.id,
          periodStartDate: period.businessDate,
          priority: period.priority,
          createdAt: period.createdAt.toISOString(),
          amountMinor: period.amountMinor,
          amountPaidMinor: period.amountPaidMinor,
        })),
      });

      const allocations: {
        periodId: string;
        amountMinor: bigint;
        fullyPaid: boolean;
      }[] = [];
      const periodById = new Map(unpaid.map((period) => [period.id, period]));

      for (const allocation of plan.allocations) {
        const period = periodById.get(allocation.periodId);
        if (period === undefined) continue;
        const currency = period.currency;
        const allocationMoney = { amount: Number(allocation.amountMinor), currency };
        const post = await ledger.postTransaction(tenantId, {
          idempotencyKey: `wallet-allocation:${assetId}:${allocation.periodId}:${allocation.amountMinor}`,
          postings: [
            {
              accountCode: "ASSET_WALLET",
              direction: "debit",
              amount: allocationMoney,
              assetId,
              obligationPeriodId: period.id,
            },
            {
              accountCode: "REVENUE_LEVY",
              direction: "credit",
              amount: allocationMoney,
              assetId,
              obligationPeriodId: period.id,
            },
          ],
          sourceType: "allocation",
          sourceId: input.sourceId ?? null,
          description: "Obligation allocation (wallet)",
        });
        if (post.replayed) continue;

        if (allocation.fullyPaid) {
          await repos.obligations.markPaid(
            tenantId,
            period.id,
            post.transaction.id,
            period.amountMinor,
          );
        } else {
          await repos.obligations.updatePaidAmount(
            tenantId,
            period.id,
            period.amountPaidMinor + allocation.amountMinor,
          );
        }
        allocations.push({
          periodId: period.id,
          amountMinor: allocation.amountMinor,
          fullyPaid: allocation.fullyPaid,
        });
      }

      return {
        allocations,
        allocatedMinor: plan.appliedMinor,
        remainingMinor: plan.remainingMinor,
      };
    });
  }

  /**
   * Where an asset stands for one business day.
   *
   * A missing period reports `status: "none"`, not unpaid: under `pay_per_use`
   * an absent row means the driver never declared that day, and reading it as a
   * debt would accuse a driver who did not work.
   */
  async getPeriodStatus(
    tenantId: string,
    assetId: string,
    businessDate: BusinessDate,
  ): Promise<PeriodStatus> {
    const existing = await this.findPeriodByAssetAndDate(tenantId, assetId, businessDate);
    if (existing === undefined) {
      return {
        periodId: null,
        status: "none",
        businessDate,
        amountMinor: 0n,
        amountPaidMinor: 0n,
        currency: "",
      };
    }
    return {
      periodId: existing.id,
      status: existing.status,
      businessDate: existing.businessDate as BusinessDate,
      amountMinor: existing.amountMinor,
      amountPaidMinor: existing.amountPaidMinor,
      currency: existing.currency,
    };
  }

  /** The period row for one asset and day, if any. */
  async findPeriodByAssetAndDate(
    tenantId: string,
    assetId: string,
    businessDate: BusinessDate,
  ): Promise<ObligationPeriodRow | undefined> {
    return withLedger(this.db, tenantId, async ({ repos }) =>
      repos.obligations.findByAssetAndPeriod(tenantId, assetId, businessDate),
    );
  }

  /** The asset wallet balance: money received but not yet spent on a declared day. */
  async getWalletBalance(tenantId: string, assetId: string): Promise<bigint> {
    return withLedger(this.db, tenantId, async ({ repos }) =>
      repos.ledger.accountBalance(tenantId, "ASSET_WALLET", assetId),
    );
  }

  /**
   * What the driver still has to send for a day: the fee less any wallet credit
   * already held, floored at zero. This is the amount an intent asks for, and
   * the amount that decides whether an arriving payment settles the day.
   */
  async getRequiredPayment(
    input: Omit<SettleDeclaredDayInput, "sourceId" | "idempotencyKey">,
  ): Promise<RequiredPaymentResult> {
    const { tenantId, assetId } = input;
    return withLedger(this.db, tenantId, async ({ repos }) => {
      const fee = await this.resolveFee(tenantId, input.assetTypeKey, input.businessDate);
      const walletBalanceMinor = await repos.ledger.accountBalance(
        tenantId,
        "ASSET_WALLET",
        assetId,
      );
      const existing = await repos.obligations.findByAssetAndPeriod(
        tenantId,
        assetId,
        input.businessDate,
      );
      const alreadySettled =
        existing !== undefined && (existing.status === "paid" || existing.status === "waived");
      const owed = BigInt(fee.amountMinor) - walletBalanceMinor;
      return {
        feeMinor: BigInt(fee.amountMinor),
        currency: fee.currency,
        walletBalanceMinor,
        requiredMinor: alreadySettled || owed < 0n ? 0n : owed,
        alreadySettled,
      };
    });
  }

  /**
   * Settles a day the driver declared, spending the wallet balance they already
   * hold.
   *
   * This is the "pay today from balance" path: the declaration is the driver's,
   * not the passage of time, so credit is never consumed by an unrelated
   * payment. When the balance does not cover the fee, nothing is settled and the
   * shortfall is returned so the caller can tell the driver the exact amount.
   *
   * Idempotent through the ledger's idempotency key: replaying settles once.
   */
  async settleDeclaredDay(input: SettleDeclaredDayInput): Promise<SettleDeclaredDayResult> {
    const { tenantId, assetId } = input;

    return withLedger(this.db, tenantId, async ({ ledger, repos }) => {
      await repos.obligations.lockAssetObligations(tenantId, assetId);

      const fee = await this.resolveFee(tenantId, input.assetTypeKey, input.businessDate);
      const balance = await repos.ledger.accountBalance(tenantId, "ASSET_WALLET", assetId);

      if (balance < BigInt(fee.amountMinor)) {
        return {
          settled: false,
          periodId: null,
          allocatedMinor: 0n,
          shortfallMinor: BigInt(fee.amountMinor) - balance,
          walletTransactionId: null,
          transactionId: null,
        };
      }

      const existing = await repos.obligations.findByAssetAndPeriod(
        tenantId,
        assetId,
        input.businessDate,
      );
      if (existing !== undefined && (existing.status === "paid" || existing.status === "waived")) {
        return {
          settled: true,
          periodId: existing.id,
          allocatedMinor: 0n,
          shortfallMinor: 0n,
          walletTransactionId: null,
          transactionId: existing.paidTransactionId,
        };
      }

      const period =
        existing ??
        (await repos.obligations.create(tenantId, {
          assetId,
          periodKey: input.businessDate,
          businessDate: input.businessDate,
          amountMinor: BigInt(fee.amountMinor),
          currency: fee.currency,
          feeRuleKey: fee.ruleId,
          feeAmountSnapshotMinor: BigInt(fee.amountMinor),
          priority: 0,
          status: "unpaid",
        }));

      const amount = { amount: fee.amountMinor, currency: fee.currency };
      const sourceId = input.sourceId ?? null;
      // The declaration is one action, so one idempotency key covers it: a
      // replay returns the original transaction and allocates nothing again.
      const key = input.idempotencyKey ?? null;

      const allocationPost = await ledger.postTransaction(tenantId, {
        idempotencyKey: key === null ? null : `${key}:allocation`,
        postings: [
          {
            accountCode: "ASSET_WALLET",
            direction: "debit",
            amount,
            assetId,
            obligationPeriodId: period.id,
          },
          {
            accountCode: "REVENUE_LEVY",
            direction: "credit",
            amount,
            assetId,
            obligationPeriodId: period.id,
          },
        ],
        sourceType: "allocation",
        sourceId,
        description: "Obligation allocation (declared day)",
      });

      if (!allocationPost.replayed) {
        await repos.obligations.markPaid(
          tenantId,
          period.id,
          allocationPost.transaction.id,
          BigInt(fee.amountMinor),
          { feeRuleKey: fee.ruleId, feeAmountSnapshotMinor: BigInt(fee.amountMinor) },
        );
      }

      return {
        settled: true,
        periodId: period.id,
        allocatedMinor: BigInt(fee.amountMinor),
        shortfallMinor: 0n,
        walletTransactionId: null,
        transactionId: allocationPost.transaction.id,
      };
    });
  }

  /**
   * Opens a reversal request for an existing transaction. Requires a second
   * approver, so this only records the intent; `approveReversal` moves money.
   */
  async requestReversal(input: RequestReversalInput): Promise<ReversalRequestRow> {
    return withLedger(this.db, input.tenantId, async ({ ledger }) =>
      ledger.requestReversal(input.tenantId, {
        originalTransactionId: input.originalTransactionId,
        reason: input.reason,
        requestedByUserId: input.requestedByUserId,
        ...(input.isSystemAdmin === undefined ? {} : { isSystemAdmin: input.isSystemAdmin }),
      }),
    );
  }

  /** Approves a pending reversal under dual control and posts the mirror entries. */
  async approveReversal(input: ApproveReversalInput): Promise<TransactionRow> {
    const result = await withLedger(this.db, input.tenantId, async ({ ledger }) =>
      ledger.approveReversal(input.tenantId, {
        reversalRequestId: input.reversalRequestId,
        approverUserId: input.approverUserId,
        ...(input.isSystemAdmin === undefined ? {} : { isSystemAdmin: input.isSystemAdmin }),
        ...(input.hasFinanceApproval === undefined
          ? {}
          : { hasFinanceApproval: input.hasFinanceApproval }),
      }),
    );
    return result.transaction;
  }

  /**
   * Materialises the scheduled periods for the tenant's assets.
   *
   * Under `pay_per_use` nothing is generated: a day that is never paid must not
   * have a row, or it could later be read as a debt.
   */
  async generateScheduledPeriods(
    tenantId: string,
    config: TenantConfig,
    params: {
      readonly businessDate: BusinessDate;
      readonly arrearsWindowPeriods?: number;
      readonly prepayWindowPeriods?: number;
    },
  ): Promise<GeneratePeriodsResult> {
    const model = config.obligations.model;
    if (model === "pay_per_use") {
      return { created: 0, skipped: 0 };
    }

    return withLedger(this.db, tenantId, async ({ repos }) => {
      const assets = await repos.assets.listAll(tenantId);
      let created = 0;
      let skipped = 0;

      for (const asset of assets) {
        const dates = planPeriodDates({
          model,
          frequency: config.obligations.frequency,
          businessDate: params.businessDate,
          arrearsWindowPeriods: params.arrearsWindowPeriods ?? 0,
          prepayWindowPeriods: params.prepayWindowPeriods ?? 0,
        });
        const fees = new Map<string, { amountMinor: number; ruleId: string }>();
        for (const date of dates) {
          const fee = await this.resolveFee(tenantId, asset.assetTypeKey, date);
          fees.set(date, { amountMinor: fee.amountMinor, ruleId: fee.ruleId });
        }

        for (const date of dates) {
          const fee = fees.get(date);
          if (fee === undefined) continue;
          const existing = await repos.obligations.findByAssetAndPeriod(tenantId, asset.id, date);
          if (existing !== undefined) {
            skipped += 1;
            continue;
          }
          await repos.obligations.create(tenantId, {
            assetId: asset.id,
            periodKey: date,
            businessDate: date,
            amountMinor: BigInt(fee.amountMinor),
            currency: config.locale.currency,
            feeRuleKey: fee.ruleId,
            feeAmountSnapshotMinor: BigInt(fee.amountMinor),
            priority: 0,
            status: "unpaid",
          });
          created += 1;
        }
      }

      return { created, skipped };
    });
  }

  /**
   * Ensures the periods that can receive an allocation exist, and returns the
   * fee that prices each one.
   *
   * Under `pay_per_use` only the current business day exists, and it is
   * created when the payment arrives. Under `scheduled` the current period is
   * materialised and every outstanding period is a candidate.
   */
  private async materializePeriods(
    repos: LedgerRepos,
    input: EnsurePaidInput,
    fee: ResolvedFee,
  ): Promise<
    {
      readonly row: ObligationPeriodRow;
      readonly ruleId: string;
    }[]
  > {
    const { tenantId, config, assetId } = input;

    if (config.obligations.model === "pay_per_use") {
      const existing = await repos.obligations.findByAssetAndPeriod(
        tenantId,
        assetId,
        input.businessDate,
      );
      if (existing !== undefined) {
        const ruleId = await this.ruleIdFor(input, existing.businessDate);
        return [{ row: existing, ruleId }];
      }
      const created = await repos.obligations.create(tenantId, {
        assetId,
        periodKey: input.businessDate,
        businessDate: input.businessDate,
        amountMinor: BigInt(fee.amountMinor),
        currency: fee.currency,
        feeRuleKey: fee.ruleId,
        feeAmountSnapshotMinor: BigInt(fee.amountMinor),
        priority: 0,
        status: "unpaid",
      });
      return [{ row: created, ruleId: fee.ruleId }];
    }

    const current = await repos.obligations.findByAssetAndPeriod(
      tenantId,
      assetId,
      input.businessDate,
    );
    if (current === undefined) {
      await repos.obligations.create(tenantId, {
        assetId,
        periodKey: input.businessDate,
        businessDate: input.businessDate,
        amountMinor: BigInt(fee.amountMinor),
        currency: fee.currency,
        feeRuleKey: fee.ruleId,
        feeAmountSnapshotMinor: BigInt(fee.amountMinor),
        priority: 0,
        status: "unpaid",
      });
    }

    const unpaid = await repos.obligations.findUnpaidForAsset(tenantId, assetId);
    const periods: { row: ObligationPeriodRow; ruleId: string }[] = [];
    for (const row of unpaid) {
      const ruleId = await this.ruleIdFor(input, row.businessDate);
      periods.push({ row, ruleId });
    }
    return periods;
  }

  /** The rule that prices a period on its own business date. */
  private async ruleIdFor(input: EnsurePaidInput, date: string): Promise<string> {
    const resolved = await this.resolveFee(
      input.tenantId,
      input.assetTypeKey,
      date as BusinessDate,
    );
    return resolved.ruleId;
  }

  private async resolveFee(
    tenant: string,
    assetTypeKey: string,
    date: BusinessDate,
  ): Promise<ResolvedFee> {
    return this.feeEngine.resolveFee({
      tenantId: tenantId(tenant),
      assetType: assetTypeId(assetTypeKey),
      businessDate: date,
    });
  }
}
