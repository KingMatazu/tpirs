import type { Database } from "@tpirs/db";
import { repositories } from "@tpirs/db";
import { businessDate, compareObligationsForAllocation } from "@tpirs/domain";
import { money } from "@tpirs/domain";
import { computeFee } from "@tpirs/domain";
import { LedgerService } from "./ledger-service.js";
import type { TenantConfig } from "@tpirs/config";

export class ObligationService {
  constructor(private readonly db: Database, private readonly ledgerService: LedgerService) {}

  async ensurePaidForBusinessDay(
    tenantId: string,
    config: TenantConfig,
    params: {
      assetId: string;
      businessDateStr: string;
      amount: ReturnType<typeof money>;
      paymentId?: string | null;
      sourceId?: string | null;
      assetTypeKey?: string | null;
    },
  ) {
    const bd = businessDate(params.businessDateStr);
    const periodKey = bd;
    const currency = params.amount.currency;
    const model = config.obligations.model;

    return this.db.transaction().execute(async (trx) => {
      const repos = repositories(trx);
      await repos.obligations.lockAssetObligations(tenantId, params.assetId);

      if (model === "pay_per_use") {
        let period = await repos.obligations.findByAssetAndPeriod(tenantId, params.assetId, periodKey);
        if (!period) {
          // Under pay_per_use, create obligation period only when payment occurs
          let feeAmount = params.amount;
          if (params.assetTypeKey) {
            try {
              const fee = computeFee({
                rules: config.obligations.feeRules as any,
                assetTypeKey: params.assetTypeKey,
                businessDate: bd,
                currency,
              });
              feeAmount = fee.amount;
            } catch {
              feeAmount = params.amount;
            }
          }
          period = await repos.obligations.create(tenantId, {
            assetId: params.assetId,
            periodKey,
            businessDate: bd,
            amountMinor: BigInt(feeAmount.amount),
            currency,
            feeAmountSnapshotMinor: BigInt(feeAmount.amount),
            priority: 0,
            status: "unpaid",
          });
        }
        if (period.status === "paid") {
          return { period, transaction: null };
        }
        if (BigInt(params.amount.amount) < period.amount_minor) {
          await this.ledgerService.postTransaction(tenantId, {
            postings: [
              { accountCode: "GATEWAY_CLEARING", direction: "debit", amount: params.amount },
              { accountCode: "ASSET_WALLET", direction: "credit", amount: params.amount, assetId: params.assetId },
            ],
            sourceType: "payment",
            sourceId: params.sourceId ?? params.paymentId ?? null,
            description: "Payment received (wallet credit)",
          });
          return { period, transaction: null, walletCredit: true };
        }
        const tx = await this.ledgerService.postTransaction(tenantId, {
          postings: [
            { accountCode: "ASSET_WALLET", direction: "debit", amount: params.amount, assetId: params.assetId },
            { accountCode: "REVENUE_LEVY", direction: "credit", amount: params.amount, assetId: params.assetId },
          ],
          sourceType: "allocation",
          sourceId: params.sourceId ?? params.paymentId ?? null,
          description: "Obligation allocation",
        });
        await repos.obligations.markPaid(tenantId, period.id, tx.transaction.id, BigInt(params.amount.amount));
        return { period, transaction: tx };
      } else {
        // scheduled model
        let period = await repos.obligations.findByAssetAndPeriod(tenantId, params.assetId, periodKey);
        if (!period && params.assetTypeKey) {
          let feeAmount = params.amount;
          try {
            const fee = computeFee({
              rules: config.obligations.feeRules as any,
              assetTypeKey: params.assetTypeKey,
              businessDate: bd,
              currency,
            });
            feeAmount = fee.amount;
          } catch {
            feeAmount = params.amount;
          }
          period = await repos.obligations.create(tenantId, {
            assetId: params.assetId,
            periodKey,
            businessDate: bd,
            amountMinor: BigInt(feeAmount.amount),
            currency,
            feeAmountSnapshotMinor: BigInt(feeAmount.amount),
            priority: 0,
            status: "unpaid",
          });
        }
        if (!period) {
          // If no period exists and we can't create one, still credit wallet if partial? Or treat as unpaid
          await this.ledgerService.postTransaction(tenantId, {
            postings: [
              { accountCode: "GATEWAY_CLEARING", direction: "debit", amount: params.amount },
              { accountCode: "ASSET_WALLET", direction: "credit", amount: params.amount, assetId: params.assetId },
            ],
            sourceType: "payment",
            sourceId: params.sourceId ?? params.paymentId ?? null,
            description: "Payment received (wallet credit)",
          });
          return { period: null, transaction: null, walletCredit: true };
        }
        if (period.status === "paid") {
          return { period, transaction: null };
        }
        // Allocate: pay oldest-first logic is enforced by findUnpaidForAsset ordering; for current period apply
        const debitAmount = BigInt(params.amount.amount) >= period.amount_minor ? period.amount_minor : BigInt(params.amount.amount);
        if (debitAmount === 0n) {
          await this.ledgerService.postTransaction(tenantId, {
            postings: [
              { accountCode: "GATEWAY_CLEARING", direction: "debit", amount: params.amount },
              { accountCode: "ASSET_WALLET", direction: "credit", amount: params.amount, assetId: params.assetId },
            ],
            sourceType: "payment",
            sourceId: params.sourceId ?? params.paymentId ?? null,
            description: "Payment received (wallet credit)",
          });
          return { period, transaction: null, walletCredit: true };
        }
        const allocationMoney = money(currency, Number(debitAmount));
        const tx = await this.ledgerService.postTransaction(tenantId, {
          postings: [
            { accountCode: "ASSET_WALLET", direction: "debit", amount: allocationMoney, assetId: params.assetId },
            { accountCode: "REVENUE_LEVY", direction: "credit", amount: allocationMoney, assetId: params.assetId },
          ],
          sourceType: "allocation",
          sourceId: params.sourceId ?? params.paymentId ?? null,
          description: "Obligation allocation",
        });
        if (BigInt(params.amount.amount) >= period.amount_minor) {
          await repos.obligations.markPaid(tenantId, period.id, tx.transaction.id, period.amount_minor);
        } else {
          await repos.obligations.updatePaidAmount(tenantId, period.id, debitAmount);
        }
        // Any remainder stays in wallet (already credited conceptually via gateway clearing->wallet if we model differently; but simplified)
        if (BigInt(params.amount.amount) > period.amount_minor) {
          const remainder = BigInt(params.amount.amount) - period.amount_minor;
          await this.ledgerService.postTransaction(tenantId, {
            postings: [
              { accountCode: "GATEWAY_CLEARING", direction: "debit", amount: money(currency, Number(remainder)) },
              { accountCode: "ASSET_WALLET", direction: "credit", amount: money(currency, Number(remainder)), assetId: params.assetId },
            ],
            sourceType: "payment",
            sourceId: params.sourceId ?? params.paymentId ?? null,
            description: "Payment received (wallet credit remainder)",
          });
        }
        return { period, transaction: tx };
      }
    });
  }

  async allocateFromWallet(
    tenantId: string,
    config: TenantConfig,
    params: {
      assetId: string;
      amount: ReturnType<typeof money>;
      sourceId?: string | null;
    },
  ) {
    const model = config.obligations.model;
    return this.db.transaction().execute(async (trx) => {
      const repos = repositories(trx);
      await repos.obligations.lockAssetObligations(tenantId, params.assetId);
      if (model === "scheduled") {
        const unpaid = await repos.obligations.findUnpaidForAsset(tenantId, params.assetId);
        // sort by allocation order
        const sorted = [...unpaid].sort((a, b) =>
          compareObligationsForAllocation(
            {
              periodStartDate: a.business_date,
              priority: a.priority,
              createdAt: a.created_at.toISOString(),
              id: a.id,
            },
            {
              periodStartDate: b.business_date,
              priority: b.priority,
              createdAt: b.created_at.toISOString(),
              id: b.id,
            },
          ),
        );
        let remaining = BigInt(params.amount.amount);
        const results = [];
        for (const p of sorted) {
          if (remaining <= 0n) break;
          const due = p.amount_minor - p.amount_paid_minor;
          const pay = remaining >= due ? due : remaining;
          const payMoney = money(p.currency, Number(pay));
          const tx = await this.ledgerService.postTransaction(tenantId, {
            postings: [
              { accountCode: "ASSET_WALLET", direction: "debit", amount: payMoney, assetId: params.assetId },
              { accountCode: "REVENUE_LEVY", direction: "credit", amount: payMoney, assetId: params.assetId },
            ],
            sourceType: "allocation",
            sourceId: params.sourceId ?? null,
            description: "Obligation allocation (wallet)",
          });
          if (pay >= due) {
            await repos.obligations.markPaid(tenantId, p.id, tx.transaction.id, p.amount_minor);
          } else {
            await repos.obligations.updatePaidAmount(tenantId, p.id, p.amount_paid_minor + pay);
          }
          remaining -= pay;
          results.push({ period: p, paid: pay >= due });
        }
        return { results, remaining: Number(remaining) };
      }
      // pay_per_use: no arrears/periods to allocate to by default
      return { results: [], remaining: Number(params.amount.amount) };
    });
  }
}
