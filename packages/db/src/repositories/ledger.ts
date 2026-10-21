import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Database } from "../connection.js";
import { withTenant } from "../tenant-scope.js";

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

export class AccountRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async ensureStandardAccounts(
    tenantId: string,
    currency: string,
  ): Promise<Record<string, AccountRow>> {
    const results: Record<string, AccountRow> = {};
    await withTenant(this.db, tenantId, async (scoped) => {
      const standard = [
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
      ];

      for (const acct of standard) {
        const existing = await scoped
          .selectFrom("accounts")
          .selectAll()
          .where("code", "=", acct.code)
          .executeTakeFirst();
        if (existing) {
          results[acct.code] = existing;
          continue;
        }
        const created = await scoped
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
    });
    return results;
  }

  async findByCode(tenantId: string, code: string): Promise<AccountRow | undefined> {
    let result: AccountRow | undefined;
    await withTenant(this.db, tenantId, async (scoped) => {
      const row = await scoped
        .selectFrom("accounts")
        .selectAll()
        .where("code", "=", code)
        .executeTakeFirst();
      result = row;
    });
    return result;
  }

  async getAll(tenantId: string): Promise<AccountRow[]> {
    let results: AccountRow[] = [];
    await withTenant(this.db, tenantId, async (scoped) => {
      const rows = await scoped.selectFrom("accounts").selectAll().execute();
      results = rows;
    });
    return results;
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
  memo?: string | null;
}

export class LedgerRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async findTransactionByIdempotencyKey(
    tenantId: string,
    key: string,
  ): Promise<TransactionRow | undefined> {
    let result: TransactionRow | undefined;
    await withTenant(this.db, tenantId, async (scoped) => {
      const row = await scoped
        .selectFrom("transactions")
        .selectAll()
        .where("idempotencyKey", "=", key)
        .executeTakeFirst();
      result = row;
    });
    return result;
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
    let result: { transaction: TransactionRow; entries: LedgerEntryRow[] } | undefined;
    await withTenant(this.db, tenantId, async (scoped) => {
      const tx = await scoped
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
        const entry = await scoped
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
            memo: posting.memo ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        entries.push(entry);
      }
      result = { transaction: tx, entries };
    });
    if (!result) {
      throw new Error("failed to create transaction");
    }
    return result;
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
    let result:
      | {
          transaction: TransactionRow;
          entries: LedgerEntryRow[];
        }
      | undefined;
    await withTenant(this.db, tenantId, async (scoped) => {
      const tx = await scoped
        .selectFrom("transactions")
        .selectAll()
        .where("id", "=", transactionId)
        .executeTakeFirst();
      if (!tx) {
        result = undefined;
        return;
      }
      const entries = await scoped
        .selectFrom("ledgerEntries")
        .selectAll()
        .where("transactionId", "=", transactionId)
        .execute();
      result = { transaction: tx, entries: entries };
    });
    return result;
  }
}

export class ObligationRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async findByAssetAndPeriod(
    tenantId: string,
    assetId: string,
    periodKey: string,
  ): Promise<ObligationPeriodRow | undefined> {
    let result: ObligationPeriodRow | undefined;
    await withTenant(this.db, tenantId, async (scoped) => {
      const row = await scoped
        .selectFrom("obligationPeriods")
        .selectAll()
        .where("assetId", "=", assetId)
        .where("periodKey", "=", periodKey)
        .executeTakeFirst();
      result = row;
    });
    return result;
  }

  async lockAssetObligations(tenantId: string, assetId: string): Promise<void> {
    await withTenant(this.db, tenantId, async (scoped) => {
      await sql`select 1 from obligation_periods where tenant_id = ${tenantId} and asset_id = ${assetId} for update`.execute(
        scoped,
      );
      await sql`select 1 from assets where id = ${assetId} for update`.execute(scoped);
    });
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
    let result: ObligationPeriodRow | undefined;
    await withTenant(this.db, tenantId, async (scoped) => {
      const row = await scoped
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
      result = row;
    });
    if (!result) {
      throw new Error("failed to create obligation period");
    }
    return result;
  }

  async findUnpaidForAsset(tenantId: string, assetId: string): Promise<ObligationPeriodRow[]> {
    let results: ObligationPeriodRow[] = [];
    await withTenant(this.db, tenantId, async (scoped) => {
      const rows = await scoped
        .selectFrom("obligationPeriods")
        .selectAll()
        .where("assetId", "=", assetId)
        .where("status", "=", "unpaid")
        .orderBy("businessDate", "asc")
        .orderBy("priority", "asc")
        .orderBy("createdAt", "asc")
        .orderBy("id", "asc")
        .execute();
      results = rows;
    });
    return results;
  }

  async markPaid(
    tenantId: string,
    id: string,
    paidTransactionId: string,
    amountPaidMinor: bigint,
  ): Promise<ObligationPeriodRow> {
    let result: ObligationPeriodRow | undefined;
    await withTenant(this.db, tenantId, async (scoped) => {
      const row = await scoped
        .updateTable("obligationPeriods")
        .set({
          status: "paid",
          amountPaidMinor,
          paidTransactionId,
          updatedAt: new Date(),
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      result = row;
    });
    if (!result) {
      throw new Error("failed to mark obligation as paid");
    }
    return result;
  }

  async updatePaidAmount(
    tenantId: string,
    id: string,
    amountPaidMinor: bigint,
  ): Promise<ObligationPeriodRow> {
    let result: ObligationPeriodRow | undefined;
    await withTenant(this.db, tenantId, async (scoped) => {
      const row = await scoped
        .updateTable("obligationPeriods")
        .set({ amountPaidMinor, updatedAt: new Date() })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      result = row;
    });
    if (!result) {
      throw new Error("failed to update obligation paid amount");
    }
    return result;
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
    let result: ReversalRequestRow | undefined;
    await withTenant(this.db, tenantId, async (scoped) => {
      const row = await scoped
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
      result = row;
    });
    if (!result) {
      throw new Error("failed to create reversal request");
    }
    return result;
  }

  async findById(tenantId: string, id: string): Promise<ReversalRequestRow | undefined> {
    let result: ReversalRequestRow | undefined;
    await withTenant(this.db, tenantId, async (scoped) => {
      const row = await scoped
        .selectFrom("reversalRequests")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      result = row ?? undefined;
    });
    return result;
  }

  async approve(
    tenantId: string,
    id: string,
    approvedByUserId: string,
    reversingTransactionId: string,
  ): Promise<ReversalRequestRow> {
    let result: ReversalRequestRow | undefined;
    await withTenant(this.db, tenantId, async (scoped) => {
      const row = await scoped
        .updateTable("reversalRequests")
        .set({
          status: "approved",
          approvedByUserId,
          reversingTransactionId,
          approvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      result = row;
    });
    if (!result) {
      throw new Error("failed to approve reversal request");
    }
    return result;
  }

  async reject(
    tenantId: string,
    id: string,
    rejectedByUserId: string,
  ): Promise<ReversalRequestRow> {
    let result: ReversalRequestRow | undefined;
    await withTenant(this.db, tenantId, async (scoped) => {
      const row = await scoped
        .updateTable("reversalRequests")
        .set({
          status: "rejected",
          rejectedByUserId,
          rejectedAt: new Date(),
          updatedAt: new Date(),
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      result = row;
    });
    if (!result) {
      throw new Error("failed to reject reversal request");
    }
    return result;
  }
}
