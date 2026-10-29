import {
  FeeSplitError,
  feeSplit,
  money,
  ReconciliationError,
  settlementFeePostings,
} from "@tpirs/domain";
import type { Principal } from "@tpirs/domain";
import type { SettlementRowRow } from "@tpirs/db";
import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import type { SettlementImport, SettlementColumnMapping, Telemetry } from "@tpirs/ports";
import { LedgerService } from "./ledger-service.js";
import { toPostingSpecs } from "./reconciliation-service.js";
import { requireReconPermission } from "./recon-actor.js";

/**
 * Statement intake and settlement posting (D21, D45; ADR 0035/0036).
 *
 * A statement row is evidence until it matches exactly one payment. Matching
 * is not posting: a row posts only when one payment (already carrying money in
 * `GATEWAY_CLEARING`) matches the reference, the currency agrees, and the
 * difference between the payment and the bank amount is a non-negative fee
 * inside tolerance. Then — and only then — is the fee leg posted:
 *
 *   Dr SETTLEMENT_BANK   bank amount
 *   Dr GATEWAY_FEES      payment − bank (may be zero, leg omitted)
 *   Cr GATEWAY_CLEARING  payment amount
 *
 * Idempotency: the file hash makes a re-upload a no-op — same bytes go nowhere
 * — and the posting carries the key `settlement:<row id>`, so even a racing
 * caller cannot spend the same row twice. Anything that cannot post honestly
 * stays `unmatched`, where the reconciliation run raises the exception.
 */

export interface SettlementImportSummary {
  readonly outcome: "imported" | "duplicate";
  readonly importId: string;
  readonly fileHash: string;
  readonly rowCount: number;
  readonly rejectedCount: number;
  /** Rows this call matched and posted. Zero on a duplicate upload. */
  readonly postedCount: number;
  /** Rows this call refused to post (never matched, currency gap, bad split). */
  readonly unmatchedCount: number;
  readonly skipped: {
    readonly rowNumber: number;
    readonly providerReference: string;
    readonly reason:
      | "no_unique_payment"
      | "currency_mismatch"
      | "over_settlement"
      | "fee_beyond_tolerance"
      | "not_in_clearing";
  }[];
}

export interface ImportStatementInput {
  readonly tenantId: string;
  readonly provider: string;
  readonly filename: string;
  readonly content: string;
  readonly mapping: SettlementColumnMapping;
  readonly defaultCurrency: string;
  readonly feeToleranceMinor: bigint;
  readonly actor: Principal;
}

export function createSettlementImportService(deps: {
  readonly db: AnyDb;
  readonly settlementImport: SettlementImport;
  readonly telemetry?: Telemetry;
}): {
  importStatement(input: ImportStatementInput): Promise<SettlementImportSummary>;
} {
  const { db, settlementImport } = deps;

  return {
    async importStatement(input: ImportStatementInput): Promise<SettlementImportSummary> {
      requireReconPermission(input.actor, input.tenantId, "reconciliation:run");
      const parsed = await settlementImport.parse({
        provider: input.provider,
        filename: input.filename,
        content: input.content,
        mapping: input.mapping,
        defaultCurrency: input.defaultCurrency,
      });

      return withTenant(db, input.tenantId, async (tx) => {
        const repos = repositories(tx);
        const rows = [...parsed.rows];
        const settledDays = rows.map((row) => row.settledAt.toISOString().slice(0, 10));
        const periodStart = settledDays.length === 0 ? null : [...settledDays].sort()[0];
        const periodEnd =
          settledDays.length === 0 ? null : ([...settledDays].sort().at(-1) ?? null);

        const recorded = await repos.settlementImports.record({
          tenantId: input.tenantId,
          provider: input.provider,
          filename: input.filename,
          fileHash: parsed.fileHash,
          rowCount: parsed.rows.length,
          rejectedCount: parsed.rejected.length,
          importedByUserId: input.actor.userId,
          ...(periodStart !== null ? { periodStart } : {}),
          ...(periodEnd !== null ? { periodEnd } : {}),
        });

        // Same bytes, same import: nothing is inserted, matched or posted.
        if (!recorded.created) {
          await repos.audit.record({
            tenantId: input.tenantId,
            actorUserId: input.actor.userId,
            action: "settlement.import.deduplicated",
            entityType: "settlement_import",
            entityId: recorded.import.id,
            after: { fileHash: parsed.fileHash, filename: input.filename },
          });
          return {
            outcome: "duplicate",
            importId: recorded.import.id,
            fileHash: parsed.fileHash,
            rowCount: recorded.import.rowCount,
            rejectedCount: recorded.import.rejectedCount,
            postedCount: 0,
            unmatchedCount: 0,
            skipped: [],
          };
        }

        const inserted = await repos.settlements.insertRows(
          rows.map((row) => ({
            tenantId: input.tenantId,
            importId: recorded.import.id,
            rowNumber: row.rowNumber,
            rowHash: row.rowHash,
            providerReference: row.providerReference,
            amountMinor: BigInt(row.amount.amount),
            feeMinor: BigInt(row.fee.amount),
            currency: row.amount.currency,
            settledAt: row.settledAt,
            description: row.description,
            raw: { ...row.raw },
          })),
        );

        const ledger = new LedgerService(tx, repos);
        const skipped: SettlementImportSummary["skipped"] = [];
        let postedCount = 0;

        for (const row of inserted) {
          const skip = (reason: SettlementImportSummary["skipped"][number]["reason"]): void => {
            skipped.push({
              rowNumber: row.rowNumber,
              providerReference: row.providerReference,
              reason,
            });
          };

          // Suspense payments carry no money yet: the clearing debit lands only
          // at allocation, so only `applied`/`credited` payments can settle.
          const candidates = (
            await repos.payments.listByProviderReference(
              input.tenantId,
              input.provider,
              row.providerReference,
            )
          ).filter((payment) => payment.status === "applied" || payment.status === "credited");
          if (candidates.length !== 1) {
            skip("no_unique_payment");
            continue;
          }
          const payment = candidates[0];
          if (payment === undefined) {
            skip("no_unique_payment");
            continue;
          }
          if (payment.currency !== row.currency) {
            skip("currency_mismatch");
            continue;
          }
          const bankMinor = row.amountMinor - row.feeMinor;
          try {
            const split = feeSplit({
              paymentMinor: payment.amountMinor,
              bankMinor,
              feeToleranceMinor: input.feeToleranceMinor,
            });
            const postings = settlementFeePostings({
              paymentAmount: money(row.currency, Number(split.paymentAmountMinor)),
              bankAmount: money(row.currency, Number(split.bankAmountMinor)),
            });
            const posted = await ledger.postTransaction(input.tenantId, {
              postings: toPostingSpecs(postings),
              sourceType: "settlement",
              sourceId: row.id,
              description: `Settlement of ${row.providerReference}`,
              idempotencyKey: `settlement:${row.id}`,
              createdByUserId: input.actor.userId,
            });
            // A replay means another caller raced and won; do not re-stamp.
            if (!posted.replayed) {
              await repos.settlements.markPosted(input.tenantId, row.id, {
                paymentId: payment.id,
                transactionId: posted.transaction.id,
              });
              postedCount += 1;
            }
          } catch (error) {
            if (error instanceof FeeSplitError) {
              skip(error.code === "over_settlement" ? "over_settlement" : "fee_beyond_tolerance");
            } else if (error instanceof ReconciliationError) {
              skip(error.code === "over_settlement" ? "over_settlement" : "fee_beyond_tolerance");
            } else {
              throw error;
            }
          }
        }

        const stillUnmatched = await repos.settlements.list(input.tenantId, {
          status: "unmatched",
          limit: 1000,
        });
        const unmatchedForImport = stillUnmatched.filter(
          (row: SettlementRowRow) => row.importId === recorded.import.id,
        ).length;

        await repos.audit.record({
          tenantId: input.tenantId,
          actorUserId: input.actor.userId,
          action: "settlement.imported",
          entityType: "settlement_import",
          entityId: recorded.import.id,
          after: {
            fileHash: parsed.fileHash,
            rows: parsed.rows.length,
            rejected: parsed.rejected.length,
            posted: postedCount,
            skipped: skipped.length,
          },
        });
        deps.telemetry?.counter("settlement.import.posted", postedCount, {
          tenantId: input.tenantId,
          provider: input.provider,
        });
        deps.telemetry?.counter("settlement.import.unmatched", unmatchedForImport, {
          tenantId: input.tenantId,
          provider: input.provider,
        });

        return {
          outcome: "imported",
          importId: recorded.import.id,
          fileHash: parsed.fileHash,
          rowCount: parsed.rows.length,
          rejectedCount: parsed.rejected.length,
          postedCount,
          unmatchedCount: unmatchedForImport,
          skipped,
        };
      });
    },
  };
}

export type { SettlementRowRow };
