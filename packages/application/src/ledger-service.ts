import { repositories } from "@tpirs/db";
import { validateBalancedTransaction, type LedgerPosting } from "@tpirs/domain";
import { money } from "@tpirs/domain";
import type { Database } from "@tpirs/db";
import type { Kysely } from "kysely";
import type { Transaction } from "kysely";

export class LedgerOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerOperationError";
  }
}

interface PostingSpec {
  accountCode: string;
  direction: "debit" | "credit";
  amount: ReturnType<typeof money>;
  assetId?: string | null;
  paymentId?: string | null;
  obligationPeriodId?: string | null;
  memo?: string | null;
}

interface PostTransactionParams {
  postings: PostingSpec[];
  sourceType: string;
  sourceId?: string | null;
  description?: string | null;
  idempotencyKey?: string | null;
  createdByUserId?: string | null;
}

export class LedgerService {
  constructor(private readonly db: Kysely<Database>) {}

  async postTransaction(tenantId: string, params: PostTransactionParams) {
    validateBalanced(this.toDomainPostings(params.postings));

    if (params.idempotencyKey) {
      const existing = await this.db.transaction().execute(async (trx: Transaction<Database>) => {
        const repos = repositories(trx);
        return repos.ledger.findTransactionByIdempotencyKey(tenantId, params.idempotencyKey!);
      });
      if (existing) {
        return this.db.transaction().execute(async (trx: Transaction<Database>) => {
          const repos = repositories(trx);
          return repos.ledger.findTransactionWithEntries(tenantId, existing.id);
        });
      }
    }

    return this.db.transaction().execute(async (trx: Transaction<Database>) => {
      const repos = repositories(trx);
      return this.postInternal(repos, tenantId, params);
    });
  }

  requestReversal(
    tenantId: string,
    params: {
      originalTransactionId: string;
      reason: string;
      requestedByUserId: string;
      isSystemAdmin?: boolean;
    },
  ) {
    if (params.isSystemAdmin) {
      throw new LedgerOperationError("system admin cannot touch ledger data");
    }
    return this.db.transaction().execute(async (trx: Transaction<Database>) => {
      const repos = repositories(trx);
      return repos.reversals.create(tenantId, {
        originalTransactionId: params.originalTransactionId,
        reason: params.reason,
        requestedByUserId: params.requestedByUserId,
      });
    });
  }

  approveReversal(
    tenantId: string,
    params: {
      reversalRequestId: string;
      approverUserId: string;
      isSystemAdmin?: boolean;
      hasFinanceApproval?: boolean;
    },
  ) {
    if (params.isSystemAdmin) {
      throw new LedgerOperationError("system admin cannot touch ledger data");
    }
    if (!params.hasFinanceApproval) {
      throw new LedgerOperationError("finance approval required");
    }
    return this.db.transaction().execute(async (trx: Transaction<Database>) => {
      const repos = repositories(trx);
      const request = await repos.reversals.findById(tenantId, params.reversalRequestId);
      if (!request) throw new LedgerOperationError("reversal request not found");
      if (request.status !== "pending") {
        throw new LedgerOperationError("reversal request is not pending");
      }
      if (request.requestedByUserId === params.approverUserId) {
        throw new LedgerOperationError("cannot approve own reversal request");
      }
      const original = await repos.ledger.findTransactionWithEntries(
        tenantId,
        request.originalTransactionId,
      );
      if (!original || original.entries.length === 0) {
        throw new LedgerOperationError("original transaction not found");
      }

      const allAccounts = await repos.accounts.getAll(tenantId);
      const accountById = new Map(allAccounts.map((a) => [a.id, a.code]));
      const postings: PostingSpec[] = original.entries.map((entry) => {
        const accountCode = accountById.get(entry.accountId);
        if (!accountCode) {
          throw new LedgerOperationError("unknown account for reversal");
        }
        return {
          accountCode,
          direction: entry.direction === "debit" ? "credit" : "debit",
          amount: money(entry.currency, Number(entry.amountMinor)),
          assetId: entry.assetId,
          paymentId: entry.paymentId,
          obligationPeriodId: entry.obligationPeriodId,
          memo: `Reversal of ${request.originalTransactionId}`,
        };
      });

      const reversal = await this.postInternal(repos, tenantId, {
        postings,
        sourceType: "reversal",
        sourceId: request.originalTransactionId,
        description: `Reversal: ${request.reason}`,
        createdByUserId: params.approverUserId,
      });

      await repos.reversals.approve(
        tenantId,
        params.reversalRequestId,
        params.approverUserId,
        reversal.transaction.id,
      );
      return reversal;
    });
  }

  private async postInternal(
    repos: ReturnType<typeof repositories>,
    tenantId: string,
    params: PostTransactionParams,
  ) {
    validateBalanced(this.toDomainPostings(params.postings));
    const firstPosting = params.postings[0];
    if (!firstPosting) {
      throw new LedgerOperationError("no postings");
    }
    const accounts = await repos.accounts.ensureStandardAccounts(tenantId, firstPosting.amount.currency);
    const accountMap = new Map(Object.entries(accounts));
    const postingInputs = params.postings.map((p) => {
      const account = accountMap.get(p.accountCode);
      if (!account) throw new LedgerOperationError(`unknown account code: ${p.accountCode}`);
      return {
        accountId: account.id,
        direction: p.direction,
        amountMinor: BigInt(p.amount.amount),
        currency: p.amount.currency,
        assetId: p.assetId ?? null,
        paymentId: p.paymentId ?? null,
        obligationPeriodId: p.obligationPeriodId ?? null,
        memo: p.memo ?? null,
      };
    });
    return repos.ledger.createTransactionWithEntries(tenantId, {
      idempotencyKey: params.idempotencyKey ?? null,
      sourceType: params.sourceType,
      sourceId: params.sourceId ?? null,
      description: params.description ?? null,
      createdByUserId: params.createdByUserId ?? null,
      metadata: {},
      postings: postingInputs,
    });
  }

  private toDomainPostings(postings: PostingSpec[]): LedgerPosting[] {
    return postings.map((p) => ({
      accountCode: p.accountCode,
      direction: p.direction,
      amount: p.amount,
      ...(p.assetId ? { assetId: p.assetId } : {}),
      ...(p.paymentId ? { paymentId: p.paymentId } : {}),
      ...(p.obligationPeriodId ? { obligationPeriodId: p.obligationPeriodId } : {}),
      ...(p.memo ? { memo: p.memo } : {}),
    }));
  }
}

function validateBalanced(postings: LedgerPosting[]): void {
  validateBalancedTransaction(postings);
}
