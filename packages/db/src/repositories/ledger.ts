import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Database } from "../connection.js";
import { withTenant } from "../tenant-scope.js";

export interface AccountRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  account_type: string;
  account_class: string;
  currency: string;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface TransactionRow {
  id: string;
  tenant_id: string;
  idempotency_key: string | null;
  source_type: string;
  source_id: string | null;
  description: string | null;
  posted_at: Date;
  created_by_user_id: string | null;
  metadata: unknown;
}

export interface LedgerEntryRow {
  id: string;
  tenant_id: string;
  transaction_id: string;
  account_id: string;
  direction: "debit" | "credit";
  amount_minor: bigint;
  currency: string;
  asset_id: string | null;
  payment_id: string | null;
  obligation_period_id: string | null;
  memo: string | null;
  posted_at: Date;
  created_at: Date;
}

export interface ObligationPeriodRow {
  id: string;
  tenant_id: string;
  asset_id: string;
  period_key: string;
  business_date: string;
  status: "unpaid" | "paid" | "waived";
  amount_minor: bigint;
  amount_paid_minor: bigint;
  currency: string;
  fee_rule_key: string | null;
  fee_amount_snapshot_minor: bigint | null;
  paid_transaction_id: string | null;
  priority: number;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface ReversalRequestRow {
  id: string;
  tenant_id: string;
  original_transaction_id: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  requested_by_user_id: string;
  approved_by_user_id: string | null;
  rejected_by_user_id: string | null;
  approved_at: Date | null;
  rejected_at: Date | null;
  expires_at: Date | null;
  reversing_transaction_id: string | null;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface AccountRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  account_type: string;
  account_class: string;
  currency: string;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface TransactionRow {
  id: string;
  tenant_id: string;
  idempotency_key: string | null;
  source_type: string;
  source_id: string | null;
  description: string | null;
  posted_at: Date;
  created_by_user_id: string | null;
  metadata: unknown;
}

export interface LedgerEntryRow {
  id: string;
  tenant_id: string;
  transaction_id: string;
  account_id: string;
  direction: "debit" | "credit";
  amount_minor: bigint;
  currency: string;
  asset_id: string | null;
  payment_id: string | null;
  obligation_period_id: string | null;
  memo: string | null;
  posted_at: Date;
  created_at: Date;
}

export interface ObligationPeriodRow {
  id: string;
  tenant_id: string;
  asset_id: string;
  period_key: string;
  business_date: string;
  status: "unpaid" | "paid" | "waived";
  amount_minor: bigint;
  amount_paid_minor: bigint;
  currency: string;
  fee_rule_key: string | null;
  fee_amount_snapshot_minor: bigint | null;
  paid_transaction_id: string | null;
  priority: number;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface ReversalRequestRow {
  id: string;
  tenant_id: string;
  original_transaction_id: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  requested_by_user_id: string;
  approved_by_user_id: string | null;
  rejected_by_user_id: string | null;
  approved_at: Date | null;
  rejected_at: Date | null;
  expires_at: Date | null;
  reversing_transaction_id: string | null;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

export class AccountRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async ensureStandardAccounts(tenantId: string, currency: string): Promise<Record<string, AccountRow>> {
    const results: Record<string, AccountRow> = {};
    await withTenant(this.db, tenantId, async (scoped) => {
      const standard = [
        { code: "ASSET_WALLET", name: "Asset wallet", account_type: "asset_wallet", account_class: "liability" },
        { code: "REVENUE_LEVY", name: "Levy revenue", account_type: "revenue_levy", account_class: "revenue" },
        { code: "GATEWAY_CLEARING", name: "Gateway clearing", account_type: "gateway_clearing", account_class: "asset" },
        { code: "SETTLEMENT_BANK", name: "Settlement bank", account_type: "settlement_bank", account_class: "asset" },
        { code: "SUSPENSE", name: "Suspense", account_type: "suspense", account_class: "liability" },
        { code: "COLLECTOR_CASH", name: "Collector cash", account_type: "collector_cash", account_class: "asset" },
      ];

      for (const acct of standard) {
        const existing = await (scoped as any)
          .selectFrom("accounts")
          .selectAll()
          .where("code", "=", acct.code)
          .executeTakeFirst();
        if (existing) {
          results[acct.code] = existing as AccountRow;
          continue;
        }
        const created = await (scoped as any)
          .insertInto("accounts")
          .values({
            tenant_id: tenantId,
            code: acct.code,
            name: acct.name,
            account_type: acct.account_type,
            account_class: acct.account_class,
            currency,
            metadata: JSON.stringify({}),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        results[acct.code] = created as AccountRow;
      }
    });
    return results;
  }

  async findByCode(tenantId: string, code: string): Promise<AccountRow | undefined> {
    let result: AccountRow | undefined;
    await withTenant(this.db, tenantId, async (scoped) => {
      const row = await (scoped as any).selectFrom("accounts").selectAll().where("code", "=", code).executeTakeFirst();
      result = row as AccountRow | undefined;
    });
    return result;
  }

  async getAll(tenantId: string): Promise<AccountRow[]> {
    let results: AccountRow[] = [];
    await withTenant(this.db, tenantId, async (scoped) => {
      const rows = await (scoped as any).selectFrom("accounts").selectAll().execute();
      results = rows as AccountRow[];
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

  async findTransactionByIdempotencyKey(tenantId: string, key: string): Promise<TransactionRow | undefined> {
    let result: TransactionRow | undefined;
    await withTenant(this.db, tenantId, async (scoped) => {
      const row = await (scoped as any)
        .selectFrom("transactions")
        .selectAll()
        .where("idempotency_key", "=", key)
        .executeTakeFirst();
      result = row as TransactionRow | undefined;
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
      const tx = await (scoped as any)
        .insertInto("transactions")
        .values({
          tenant_id: tenantId,
          idempotency_key: params.idempotencyKey ?? null,
          source_type: params.sourceType,
          source_id: params.sourceId ?? null,
          description: params.description ?? null,
          created_by_user_id: params.createdByUserId ?? null,
          metadata: JSON.stringify(params.metadata ?? {}),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const entries: LedgerEntryRow[] = [];
      for (const posting of params.postings) {
        const entry = await (scoped as any)
          .insertInto("ledger_entries")
          .values({
            tenant_id: tenantId,
            transaction_id: (tx as any).id,
            account_id: posting.accountId,
            direction: posting.direction,
            amount_minor: posting.amountMinor,
            currency: posting.currency,
            asset_id: posting.assetId ?? null,
            payment_id: posting.paymentId ?? null,
            obligation_period_id: posting.obligationPeriodId ?? null,
            memo: posting.memo ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        entries.push(entry as LedgerEntryRow);
      }
      result = { transaction: tx as TransactionRow, entries };
    });
    return result!;
  }

  async findTransactionWithEntries(tenantId: string, transactionId: string): Promise<{
    transaction: TransactionRow;
    entries: LedgerEntryRow[];
  } | undefined> {
    let result:
      | {
          transaction: TransactionRow;
          entries: LedgerEntryRow[];
        }
      | undefined;
    await withTenant(this.db, tenantId, async (scoped) => {
      const tx = await (scoped as any)
        .selectFrom("transactions")
        .selectAll()
        .where("id", "=", transactionId)
        .executeTakeFirst();
      if (!tx) {
        result = undefined;
        return;
      }
      const entries = await (scoped as any)
        .selectFrom("ledger_entries")
        .selectAll()
        .where("transaction_id", "=", transactionId)
        .execute();
      result = { transaction: tx as TransactionRow, entries: entries as LedgerEntryRow[] };
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
      const row = await (scoped as any)
        .selectFrom("obligation_periods")
        .selectAll()
        .where("asset_id", "=", assetId)
        .where("period_key", "=", periodKey)
        .executeTakeFirst();
      result = row as ObligationPeriodRow | undefined;
    });
    return result;
  }

  async lockAssetObligations(tenantId: string, assetId: string): Promise<void> {
    await withTenant(this.db, tenantId, async (scoped) => {
      await sql`select 1 from obligation_periods where tenant_id = ${tenantId} and asset_id = ${assetId} for update`.execute(scoped as any);
      await sql`select 1 from assets where id = ${assetId} for update`.execute(scoped as any);
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
      const row = await (scoped as any)
        .insertInto("obligation_periods")
        .values({
          tenant_id: tenantId,
          asset_id: params.assetId,
          period_key: params.periodKey,
          business_date: params.businessDate,
          status: params.status ?? "unpaid",
          amount_minor: params.amountMinor,
          amount_paid_minor: 0n,
          currency: params.currency,
          fee_rule_key: params.feeRuleKey ?? null,
          fee_amount_snapshot_minor: params.feeAmountSnapshotMinor ?? null,
          priority: params.priority ?? 0,
          metadata: JSON.stringify({}),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      result = row as ObligationPeriodRow;
    });
    return result!;
  }

  async findUnpaidForAsset(tenantId: string, assetId: string): Promise<ObligationPeriodRow[]> {
    let results: ObligationPeriodRow[] = [];
    await withTenant(this.db, tenantId, async (scoped) => {
      const rows = await (scoped as any)
        .selectFrom("obligation_periods")
        .selectAll()
        .where("asset_id", "=", assetId)
        .where("status", "=", "unpaid")
        .orderBy("business_date", "asc")
        .orderBy("priority", "asc")
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .execute();
      results = rows as ObligationPeriodRow[];
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
      const row = await (scoped as any)
        .updateTable("obligation_periods")
        .set({
          status: "paid",
          amount_paid_minor: amountPaidMinor,
          paid_transaction_id: paidTransactionId,
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      result = row as ObligationPeriodRow;
    });
    return result!;
  }

  async updatePaidAmount(tenantId: string, id: string, amountPaidMinor: bigint): Promise<ObligationPeriodRow> {
    let result: ObligationPeriodRow | undefined;
    await withTenant(this.db, tenantId, async (scoped) => {
      const row = await (scoped as any)
        .updateTable("obligation_periods")
        .set({ amount_paid_minor: amountPaidMinor, updated_at: new Date() })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      result = row as ObligationPeriodRow;
    });
    return result!;
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
      const row = await (scoped as any)
        .insertInto("reversal_requests")
        .values({
          tenant_id: tenantId,
          original_transaction_id: params.originalTransactionId,
          reason: params.reason,
          status: "pending",
          requested_by_user_id: params.requestedByUserId,
          expires_at: params.expiresAt ?? null,
          metadata: JSON.stringify({}),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      result = row as ReversalRequestRow;
    });
    return result!;
  }

  async findById(tenantId: string, id: string): Promise<ReversalRequestRow | undefined> {
    let result: ReversalRequestRow | undefined;
    await withTenant(this.db, tenantId, async (scoped) => {
      const row = await (scoped as any)
        .selectFrom("reversal_requests")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      result = row as ReversalRequestRow | undefined;
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
      const row = await (scoped as any)
        .updateTable("reversal_requests")
        .set({
          status: "approved",
          approved_by_user_id: approvedByUserId,
          reversing_transaction_id: reversingTransactionId,
          approved_at: new Date(),
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      result = row as ReversalRequestRow;
    });
    return result!;
  }

  async reject(tenantId: string, id: string, rejectedByUserId: string): Promise<ReversalRequestRow> {
    let result: ReversalRequestRow | undefined;
    await withTenant(this.db, tenantId, async (scoped) => {
      const row = await (scoped as any)
        .updateTable("reversal_requests")
        .set({
          status: "rejected",
          rejected_by_user_id: rejectedByUserId,
          rejected_at: new Date(),
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      result = row as ReversalRequestRow;
    });
    return result!;
  }
}

