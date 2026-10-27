import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Database } from "../connection.js";

export type {
  AccountRow,
  TransactionRow,
  LedgerEntryRow,
  ObligationPeriodRow,
  ReversalRequestRow,
} from "../connection.js";
import type {
  AccountRow,
  TransactionRow,
  LedgerEntryRow,
  ObligationPeriodRow,
  ReversalRequestRow,
} from "../connection.js";

/**
 * Repositories operate on an already tenant-scoped transaction.
 *
 * The caller opens the transaction with `withTenant` (which sets the app role
 * and `app.tenant_id`, so row-level security applies) and passes that
 * transaction in. A repository must therefore query `this.db` directly: calling
 * `withTenant` again would try to open a nested transaction, which Kysely
 * refuses ("calling the transaction method for a Transaction is not supported").
 * Every query still filters on `tenant_id` explicitly as defence in depth.
 */

const STANDARD_ACCOUNTS = [
  {
    code: "ASSET_WALLET",
    name: "Asset wallet",
    account_type: "asset_wallet",
    account_class: "liability",
  },
  {
    code: "REVENUE_LEVY",
    name: "Levy revenue",
    account_type: "revenue_levy",
    account_class: "revenue",
  },
  {
    code: "GATEWAY_CLEARING",
    name: "Gateway clearing",
    account_type: "gateway_clearing",
    account_class: "asset",
  },
  {
    code: "SETTLEMENT_BANK",
    name: "Settlement bank",
    account_type: "settlement_bank",
    account_class: "asset",
  },
  {
    code: "SUSPENSE",
    name: "Suspense",
    account_type: "suspense",
    account_class: "liability",
  },
  {
    code: "COLLECTOR_CASH",
    name: "Collector cash",
    account_type: "collector_cash",
    account_class: "asset",
  },
] as const;

export class AccountRepository {
  constructor(private readonly db: Transaction<Database>) {}

  /**
   * Returns the standard chart of accounts for the tenant, creating any that
   * are missing. Called inside the posting transaction so a first-ever post
   * cannot race on the same account code.
   */
  async ensureStandardAccounts(
    tenantId: string,
    currency: string,
  ): Promise<Record<string, AccountRow>> {
    const results: Record<string, AccountRow> = {};

    for (const acct of STANDARD_ACCOUNTS) {
      const existing = await this.db
        .selectFrom("accounts")
        .selectAll()
        .where("tenantId", "=", tenantId)
        .where("code", "=", acct.code)
        .executeTakeFirst();
      if (existing) {
        results[acct.code] = existing;
        continue;
      }
      const created = await this.db
        .insertInto("accounts")
        .values({
          tenantId,
          code: acct.code,
          name: acct.name,
          accountType: acct.account_type,
          accountClass: acct.account_class,
          currency,
          metadata: {},
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      results[acct.code] = created;
    }

    return results;
  }

  async findByCode(tenantId: string, code: string): Promise<AccountRow | undefined> {
    return this.db
      .selectFrom("accounts")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("code", "=", code)
      .executeTakeFirst();
  }

  async getAll(tenantId: string): Promise<AccountRow[]> {
    return this.db.selectFrom("accounts").selectAll().where("tenantId", "=", tenantId).execute();
  }
}

export interface PostingInput {
  accountId: string;
  direction: "debit" | "credit";
  amountMinor: bigint;
  currency: string;
  assetId?: string | null;
  paymentId?: string | null;
  obligationPeriodId?: string | null;
  /** Collector attribution for cash postings (ADR 0031); null for gateway money. */
  collectorUserId?: string | null;
  memo?: string | null;
}

export class LedgerRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async findTransactionByIdempotencyKey(
    tenantId: string,
    key: string,
  ): Promise<TransactionRow | undefined> {
    return this.db
      .selectFrom("transactions")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("idempotencyKey", "=", key)
      .executeTakeFirst();
  }

  async createTransactionWithEntries(
    tenantId: string,
    params: {
      idempotencyKey?: string | null;
      sourceType: string;
      sourceId?: string | null;
      description?: string | null;
      createdByUserId?: string | null;
      metadata?: unknown;
      postings: PostingInput[];
    },
  ): Promise<{ transaction: TransactionRow; entries: LedgerEntryRow[] }> {
    const tx = await this.db
      .insertInto("transactions")
      .values({
        tenantId,
        idempotencyKey: params.idempotencyKey ?? null,
        sourceType: params.sourceType,
        sourceId: params.sourceId ?? null,
        description: params.description ?? null,
        createdByUserId: params.createdByUserId ?? null,
        metadata: params.metadata ?? {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const entries: LedgerEntryRow[] = [];
    for (const posting of params.postings) {
      const entry = await this.db
        .insertInto("ledgerEntries")
        .values({
          tenantId,
          transactionId: tx.id,
          accountId: posting.accountId,
          direction: posting.direction,
          amountMinor: posting.amountMinor,
          currency: posting.currency,
          assetId: posting.assetId ?? null,
          paymentId: posting.paymentId ?? null,
          obligationPeriodId: posting.obligationPeriodId ?? null,
          collectorUserId: posting.collectorUserId ?? null,
          memo: posting.memo ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      entries.push(entry);
    }

    return { transaction: tx, entries };
  }

  async findTransactionWithEntries(
    tenantId: string,
    transactionId: string,
  ): Promise<
    | {
        transaction: TransactionRow;
        entries: LedgerEntryRow[];
      }
    | undefined
  > {
    const tx = await this.db
      .selectFrom("transactions")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("id", "=", transactionId)
      .executeTakeFirst();
    if (!tx) {
      return undefined;
    }
    const entries = await this.db
      .selectFrom("ledgerEntries")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("transactionId", "=", transactionId)
      .execute();
    return { transaction: tx, entries };
  }

  /**
   * Sum of the ledger entries for one account, signed so a credit adds and a
   * debit subtracts. Wallet balances are derived, never stored: the ledger is
   * the only source of truth.
   *
   * `collectorUserId` scopes the sum to one collector's cash entries (ADR
   * 0031); `assetId` scopes it to one asset's wallet activity. A gateway
   * balance uses neither.
   */
  async accountBalance(
    tenantId: string,
    accountCode: string,
    assetId?: string,
    collectorUserId?: string,
  ): Promise<bigint> {
    const result = await sql<{ balance: string | null }>`
      select coalesce(
        sum(case when le.direction = 'credit' then le.amount_minor else -le.amount_minor end),
        0
      ) as balance
      from ledger_entries le
      join accounts a on a.id = le.account_id
      where le.tenant_id = ${tenantId}
        and a.tenant_id = ${tenantId}
        and a.code = ${accountCode}
        ${assetId === undefined ? sql`` : sql`and le.asset_id = ${assetId}`}
        ${collectorUserId === undefined ? sql`` : sql`and le.collector_user_id = ${collectorUserId}`}
    `.execute(this.db);
    const balance = result.rows[0]?.balance;
    return balance === undefined || balance === null ? 0n : BigInt(balance);
  }

  /**
   * A collector's outstanding float: debits minus credits over `COLLECTOR_CASH`
   * entries attributed to them (ADR 0031).
   *
   * `accountBalance` is credit-positive because asset wallets are liabilities;
   * collector cash is the opposite direction — a debit means money still in the
   * collector's hands — so this method inverts the sign. Derived, never stored.
   */
  async collectorCashBalance(tenantId: string, collectorUserId?: string): Promise<bigint> {
    const result = await sql<{ balance: string | null }>`
      select coalesce(
        sum(case when le.direction = 'debit' then le.amount_minor else -le.amount_minor end),
        0
      ) as balance
      from ledger_entries le
      join accounts a on a.id = le.account_id
      where le.tenant_id = ${tenantId}
        and a.tenant_id = ${tenantId}
        and a.code = 'COLLECTOR_CASH'
        ${collectorUserId === undefined ? sql`` : sql`and le.collector_user_id = ${collectorUserId}`}
    `.execute(this.db);
    const balance = result.rows[0]?.balance;
    return balance === undefined || balance === null ? 0n : BigInt(balance);
  }
}

export class ObligationRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async findByAssetAndPeriod(
    tenantId: string,
    assetId: string,
    periodKey: string,
  ): Promise<ObligationPeriodRow | undefined> {
    return this.db
      .selectFrom("obligationPeriods")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("assetId", "=", assetId)
      .where("periodKey", "=", periodKey)
      .executeTakeFirst();
  }

  /**
   * Locks the asset's obligation rows for the rest of the transaction so two
   * concurrent payments for the same asset cannot both allocate the same
   * period. The lock is taken on the asset row because a period may not exist
   * yet.
   */
  async lockAssetObligations(tenantId: string, assetId: string): Promise<void> {
    await sql`select 1 from assets where tenant_id = ${tenantId} and id = ${assetId} for update`.execute(
      this.db,
    );
    await sql`select 1 from obligation_periods where tenant_id = ${tenantId} and asset_id = ${assetId} for update`.execute(
      this.db,
    );
  }

  async create(
    tenantId: string,
    params: {
      assetId: string;
      periodKey: string;
      businessDate: string;
      amountMinor: bigint;
      currency: string;
      feeRuleKey?: string | null;
      feeAmountSnapshotMinor?: bigint | null;
      priority?: number;
      status?: "unpaid" | "paid" | "waived";
    },
  ): Promise<ObligationPeriodRow> {
    return this.db
      .insertInto("obligationPeriods")
      .values({
        tenantId,
        assetId: params.assetId,
        periodKey: params.periodKey,
        businessDate: params.businessDate,
        status: params.status ?? "unpaid",
        amountMinor: params.amountMinor,
        amountPaidMinor: 0n,
        currency: params.currency,
        feeRuleKey: params.feeRuleKey ?? null,
        feeAmountSnapshotMinor: params.feeAmountSnapshotMinor ?? null,
        priority: params.priority ?? 0,
        metadata: {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findUnpaidForAsset(tenantId: string, assetId: string): Promise<ObligationPeriodRow[]> {
    return this.db
      .selectFrom("obligationPeriods")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("assetId", "=", assetId)
      .where("status", "=", "unpaid")
      .orderBy("businessDate", "asc")
      .orderBy("priority", "asc")
      .orderBy("createdAt", "asc")
      .orderBy("id", "asc")
      .execute();
  }

  /** Returns the obligation period for one asset and business day, if any. */
  async findByAssetAndDate(
    tenantId: string,
    assetId: string,
    businessDate: string,
  ): Promise<ObligationPeriodRow | undefined> {
    return this.db
      .selectFrom("obligationPeriods")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("assetId", "=", assetId)
      .where("businessDate", "=", businessDate)
      .executeTakeFirst();
  }

  /**
   * Page of obligation periods for a business date ordered by (updated_at, id)
   * so a delta cursor can be advanced across updates/reversals (ADR 0028).
   */
  async listForBusinessDateSince(
    tenantId: string,
    businessDate: string,
    cursor?: { readonly updatedAt: Date; readonly id: string },
    limit = 500,
  ): Promise<ObligationPeriodRow[]> {
    let query = this.db
      .selectFrom("obligationPeriods")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("businessDate", "=", businessDate);
    if (cursor !== undefined) {
      query = query.where((eb) =>
        eb.or([
          eb("updatedAt", ">", cursor.updatedAt),
          eb.and([eb("updatedAt", "=", cursor.updatedAt), eb("id", ">", cursor.id)]),
        ]),
      );
    }
    return query.orderBy("updatedAt", "asc").orderBy("id", "asc").limit(limit).execute();
  }

  async markPaid(
    tenantId: string,
    id: string,
    paidTransactionId: string,
    amountPaidMinor: bigint,
    snapshot?: {
      readonly feeRuleKey?: string | null;
      readonly feeAmountSnapshotMinor?: bigint | null;
    },
  ): Promise<ObligationPeriodRow> {
    return this.db
      .updateTable("obligationPeriods")
      .set({
        status: "paid",
        amountPaidMinor,
        paidTransactionId,
        ...(snapshot?.feeRuleKey === undefined ? {} : { feeRuleKey: snapshot.feeRuleKey }),
        ...(snapshot?.feeAmountSnapshotMinor === undefined
          ? {}
          : { feeAmountSnapshotMinor: snapshot.feeAmountSnapshotMinor }),
        updatedAt: new Date(),
      })
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async updatePaidAmount(
    tenantId: string,
    id: string,
    amountPaidMinor: bigint,
  ): Promise<ObligationPeriodRow> {
    return this.db
      .updateTable("obligationPeriods")
      .set({ amountPaidMinor, updatedAt: new Date() })
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}

export class ReversalRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async create(
    tenantId: string,
    params: {
      originalTransactionId: string;
      reason: string;
      requestedByUserId: string;
      expiresAt?: Date | null;
    },
  ): Promise<ReversalRequestRow> {
    return this.db
      .insertInto("reversalRequests")
      .values({
        tenantId,
        originalTransactionId: params.originalTransactionId,
        reason: params.reason,
        status: "pending",
        requestedByUserId: params.requestedByUserId,
        expiresAt: params.expiresAt ?? null,
        metadata: {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(tenantId: string, id: string): Promise<ReversalRequestRow | undefined> {
    return this.db
      .selectFrom("reversalRequests")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirst();
  }

  async approve(
    tenantId: string,
    id: string,
    approvedByUserId: string,
    reversingTransactionId: string,
  ): Promise<ReversalRequestRow> {
    return this.db
      .updateTable("reversalRequests")
      .set({
        status: "approved",
        approvedByUserId,
        reversingTransactionId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async reject(
    tenantId: string,
    id: string,
    rejectedByUserId: string,
  ): Promise<ReversalRequestRow> {
    return this.db
      .updateTable("reversalRequests")
      .set({
        status: "rejected",
        rejectedByUserId,
        rejectedAt: new Date(),
        updatedAt: new Date(),
      })
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
