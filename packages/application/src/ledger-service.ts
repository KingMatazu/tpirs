import { repositories, withTenant } from "@tpirs/db";
import type { Database, LedgerEntryRow, ReversalRequestRow, TransactionRow } from "@tpirs/db";
import { validateBalancedTransaction, mirrorPostings } from "@tpirs/domain";
import { money } from "@tpirs/domain";
import type { LedgerPosting } from "@tpirs/domain";
import type { Kysely, Transaction } from "kysely";

export class LedgerOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerOperationError";
  }
}

export interface PostingSpec {
  accountCode: string;
  direction: "debit" | "credit";
  amount: ReturnType<typeof money>;
  assetId?: string | null;
  paymentId?: string | null;
  obligationPeriodId?: string | null;
  /** Collector attribution for cash postings (ADR 0031). */
  collectorUserId?: string | null;
  memo?: string | null;
}

export interface PostTransactionParams {
  postings: PostingSpec[];
  sourceType: string;
  sourceId?: string | null;
  description?: string | null;
  idempotencyKey?: string | null;
  createdByUserId?: string | null;
}

export interface LedgerPostResult {
  readonly transaction: TransactionRow;
  readonly entries: LedgerEntryRow[];
  /**
   * True when an existing transaction was returned because the idempotency key
   * had already been posted. A replay must change nothing.
   */
  readonly replayed: boolean;
}

export type LedgerRepos = ReturnType<typeof repositories>;

/**
 * Posts to the ledger.
 *
 * The service is bound to a transaction the caller owns: a ledger posting and
 * the state change it causes must commit or roll back together, so the service
 * never opens a transaction of its own. Use `withLedger` to obtain one.
 */
export class LedgerService {
  readonly repos: LedgerRepos;

  constructor(trx: Transaction<Database>, repos?: LedgerRepos) {
    this.repos = repos ?? repositories(trx);
  }

  /**
   * Posts a balanced double-entry transaction.
   *
   * When an idempotency key is supplied the lookup and the insert happen in
   * the same transaction, so a replay returns the original transaction instead
   * of posting twice. The unique index on (tenant_id, idempotency_key) is the
   * backstop for concurrent replays.
   */
  async postTransaction(
    tenantId: string,
    params: PostTransactionParams,
  ): Promise<LedgerPostResult> {
    validateBalancedTransaction(this.toDomainPostings(params.postings));

    const idempotencyKey = params.idempotencyKey;
    if (idempotencyKey !== undefined && idempotencyKey !== null) {
      const existing = await this.repos.ledger.findTransactionByIdempotencyKey(
        tenantId,
        idempotencyKey,
      );
      if (existing) {
        const found = await this.repos.ledger.findTransactionWithEntries(tenantId, existing.id);
        if (found) {
          return { ...found, replayed: true };
        }
      }
    }

    const posted = await this.postInternal(tenantId, params);
    return { ...posted, replayed: false };
  }

  /**
   * Opens a reversal request. The reversal is not posted yet: a second
   * approver is required before any ledger entry moves.
   */
  async requestReversal(
    tenantId: string,
    params: {
      originalTransactionId: string;
      reason: string;
      requestedByUserId: string;
      isSystemAdmin?: boolean;
    },
  ): Promise<ReversalRequestRow> {
    if (params.isSystemAdmin) {
      throw new LedgerOperationError("system admin cannot touch ledger data");
    }
    return this.repos.reversals.create(tenantId, {
      originalTransactionId: params.originalTransactionId,
      reason: params.reason,
      requestedByUserId: params.requestedByUserId,
    });
  }

  /**
   * Approves a pending reversal and posts the mirrored entries in the same
   * transaction, so an approved reversal can never be recorded without its
   * reversing transaction.
   *
   * The mirrored entries flip the direction of every original entry, so the
   * reversal nets to zero against the original.
   */
  async approveReversal(
    tenantId: string,
    params: {
      reversalRequestId: string;
      approverUserId: string;
      isSystemAdmin?: boolean;
      hasFinanceApproval?: boolean;
    },
  ): Promise<LedgerPostResult> {
    if (params.isSystemAdmin) {
      throw new LedgerOperationError("system admin cannot touch ledger data");
    }
    if (!params.hasFinanceApproval) {
      throw new LedgerOperationError("finance approval required");
    }

    const request = await this.repos.reversals.findById(tenantId, params.reversalRequestId);
    if (!request) throw new LedgerOperationError("reversal request not found");
    if (request.status !== "pending") {
      throw new LedgerOperationError("reversal request is not pending");
    }
    if (request.requestedByUserId === params.approverUserId) {
      throw new LedgerOperationError("cannot approve own reversal request");
    }

    const original = await this.repos.ledger.findTransactionWithEntries(
      tenantId,
      request.originalTransactionId,
    );
    if (!original || original.entries.length === 0) {
      throw new LedgerOperationError("original transaction not found");
    }

    const allAccounts = await this.repos.accounts.getAll(tenantId);
    const accountById = new Map(allAccounts.map((account) => [account.id, account.code]));
    const originalPostings: LedgerPosting[] = original.entries.map((entry) => {
      const accountCode = accountById.get(entry.accountId);
      if (!accountCode) {
        throw new LedgerOperationError("unknown account for reversal");
      }
      return {
        accountCode,
        direction: entry.direction === "debit" ? "debit" : "credit",
        amount: money(entry.currency, Number(entry.amountMinor)),
        ...(entry.assetId ? { assetId: entry.assetId } : {}),
        ...(entry.paymentId ? { paymentId: entry.paymentId } : {}),
        ...(entry.obligationPeriodId ? { obligationPeriodId: entry.obligationPeriodId } : {}),
        ...(entry.collectorUserId ? { collectorUserId: entry.collectorUserId } : {}),
      };
    });

    const postings: PostingSpec[] = mirrorPostings(originalPostings).map((posting) => ({
      accountCode: posting.accountCode,
      direction: posting.direction,
      amount: posting.amount,
      assetId: posting.assetId ?? null,
      paymentId: posting.paymentId ?? null,
      obligationPeriodId: posting.obligationPeriodId ?? null,
      collectorUserId: posting.collectorUserId ?? null,
      memo: `Reversal of ${request.originalTransactionId}`,
    }));

    const reversal = await this.postInternal(tenantId, {
      postings,
      sourceType: "reversal",
      sourceId: request.originalTransactionId,
      description: `Reversal: ${request.reason}`,
      createdByUserId: params.approverUserId,
      idempotencyKey: `reversal:${request.id}`,
    });

    await this.repos.reversals.approve(
      tenantId,
      params.reversalRequestId,
      params.approverUserId,
      reversal.transaction.id,
    );
    return { ...reversal, replayed: false };
  }

  private async postInternal(
    tenantId: string,
    params: PostTransactionParams,
  ): Promise<{ transaction: TransactionRow; entries: LedgerEntryRow[] }> {
    const firstPosting = params.postings[0];
    if (!firstPosting) {
      throw new LedgerOperationError("no postings");
    }
    const accounts = await this.repos.accounts.ensureStandardAccounts(
      tenantId,
      firstPosting.amount.currency,
    );
    const accountMap = new Map(Object.entries(accounts));
    const postingInputs = params.postings.map((posting) => {
      const account = accountMap.get(posting.accountCode);
      if (!account) {
        throw new LedgerOperationError(`unknown account code: ${posting.accountCode}`);
      }
      return {
        accountId: account.id,
        direction: posting.direction,
        amountMinor: BigInt(posting.amount.amount),
        currency: posting.amount.currency,
        assetId: posting.assetId ?? null,
        paymentId: posting.paymentId ?? null,
        obligationPeriodId: posting.obligationPeriodId ?? null,
        collectorUserId: posting.collectorUserId ?? null,
        memo: posting.memo ?? null,
      };
    });
    return this.repos.ledger.createTransactionWithEntries(tenantId, {
      idempotencyKey: params.idempotencyKey ?? null,
      sourceType: params.sourceType,
      sourceId: params.sourceId ?? null,
      description: params.description ?? null,
      createdByUserId: params.createdByUserId ?? null,
      metadata: {},
      postings: postingInputs,
    });
  }

  private toDomainPostings(postings: readonly PostingSpec[]): LedgerPosting[] {
    return postings.map((posting) => ({
      accountCode: posting.accountCode,
      direction: posting.direction,
      amount: posting.amount,
      ...(posting.assetId ? { assetId: posting.assetId } : {}),
      ...(posting.paymentId ? { paymentId: posting.paymentId } : {}),
      ...(posting.obligationPeriodId ? { obligationPeriodId: posting.obligationPeriodId } : {}),
      ...(posting.collectorUserId ? { collectorUserId: posting.collectorUserId } : {}),
      ...(posting.memo ? { memo: posting.memo } : {}),
    }));
  }
}

export interface LedgerContext {
  readonly ledger: LedgerService;
  readonly repos: LedgerRepos;
}

/**
 * Runs `fn` inside one tenant-scoped transaction with a ledger bound to it.
 *
 * The transaction sets the application role and `app.tenant_id`, so row-level
 * security confines every statement to the tenant, and the ledger posting and
 * the state change it causes commit together.
 */
export async function withLedger<T>(
  db: Kysely<Database>,
  tenantId: string,
  fn: (ctx: LedgerContext) => Promise<T>,
): Promise<T> {
  return withTenant(db, tenantId, async (tx) => {
    const repos = repositories(tx);
    const ledger = new LedgerService(tx, repos);
    return fn({ ledger, repos });
  });
}
