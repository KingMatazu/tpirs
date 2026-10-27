import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Database } from "../connection.js";

export type {
  CollectorWalletRow,
  CollectorDepositInstructionRow,
  CashIntakeRow,
  CashDepositRow,
  CashDepositAllocationRow,
} from "../connection.js";
import type {
  CollectorWalletRow,
  CollectorDepositInstructionRow,
  CashIntakeRow,
  CashDepositRow,
  CashDepositAllocationRow,
} from "../connection.js";

/**
 * Repositories operate on an already tenant-scoped transaction.
 *
 * The caller opens the transaction with `withTenant`, so row-level security
 * applies; every query still filters on `tenant_id` explicitly as defence in
 * depth (the same rule the other repositories document).
 *
 * The wallet balance is never read or written here (ADR 0031): it is derived
 * from `COLLECTOR_CASH` ledger entries by `LedgerRepository.accountBalance`
 * with the `collectorUserId` argument. This repository owns wallet state and
 * the cash intake/deposit records.
 */

export class WalletStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletStateConflictError";
  }
}

export interface ListIntakesFilter {
  readonly collectorUserId?: string;
  readonly zoneId?: string;
  readonly businessDate?: string;
  readonly status?: "open" | "matched" | "reversed";
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListDepositsFilter {
  readonly collectorUserId?: string;
  readonly status?: "matched" | "partial" | "suspense";
  readonly cursor?: string;
  readonly limit?: number;
}

export class CollectorCashRepository {
  constructor(private readonly db: Transaction<Database>) {}

  // ----------------------------------------------------------------- wallets

  /** Ensures a wallet exists for the collector and returns it. */
  async ensureWallet(tenantId: string, collectorUserId: string): Promise<CollectorWalletRow> {
    await this.db
      .insertInto("collectorWallets")
      .values({ tenantId, collectorUserId })
      .onConflict((oc) => oc.columns(["tenantId", "collectorUserId"]).doNothing())
      .execute();
    const wallet = await this.findWallet(tenantId, collectorUserId);
    if (wallet === undefined) {
      throw new WalletStateConflictError(`wallet for collector ${collectorUserId} not found`);
    }
    return wallet;
  }

  async findWallet(
    tenantId: string,
    collectorUserId: string,
  ): Promise<CollectorWalletRow | undefined> {
    return this.db
      .selectFrom("collectorWallets")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("collectorUserId", "=", collectorUserId)
      .executeTakeFirst();
  }

  /**
   * Locks the wallet row for the rest of the transaction. Intakes serialise
   * per collector on this lock, which is what makes the derived-balance
   * ceiling check sound (ADR 0031).
   */
  async lockWallet(tenantId: string, collectorUserId: string): Promise<CollectorWalletRow> {
    await this.ensureWallet(tenantId, collectorUserId);
    return this.db
      .selectFrom("collectorWallets")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("collectorUserId", "=", collectorUserId)
      .forUpdate()
      .executeTakeFirstOrThrow();
  }

  /**
   * Applies a status transition. Idempotent by design: freezing a frozen
   * wallet or unfreezing an active one returns the row unchanged, so the API
   * can answer 200 instead of inventing a conflict. Pass `frozenReason` when
   * freezing; the audit entry carries the actor and reason.
   */
  async setWalletStatus(
    tenantId: string,
    collectorUserId: string,
    params: { status: "active" | "frozen"; frozenReason?: string | null },
  ): Promise<CollectorWalletRow> {
    const current = await this.lockWallet(tenantId, collectorUserId);
    if (current.status === params.status) {
      return current;
    }
    return this.db
      .updateTable("collectorWallets")
      .set({
        status: params.status,
        frozenAt: params.status === "frozen" ? new Date() : null,
        frozenReason: params.status === "frozen" ? (params.frozenReason ?? "unspecified") : null,
        updatedAt: new Date(),
      })
      .where("tenantId", "=", tenantId)
      .where("collectorUserId", "=", collectorUserId)
      .where("status", "=", params.status === "frozen" ? "active" : "frozen")
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Records that a shortfall has been flagged without freezing the wallet. */
  async markOverdue(tenantId: string, collectorUserId: string, overdueSince: Date): Promise<void> {
    await this.db
      .updateTable("collectorWallets")
      .set({ overdueSince, updatedAt: new Date() })
      .where("tenantId", "=", tenantId)
      .where("collectorUserId", "=", collectorUserId)
      .where("status", "=", "active")
      .execute();
  }

  async clearOverdue(tenantId: string, collectorUserId: string): Promise<void> {
    await this.db
      .updateTable("collectorWallets")
      .set({ overdueSince: null, updatedAt: new Date() })
      .where("tenantId", "=", tenantId)
      .where("collectorUserId", "=", collectorUserId)
      .execute();
  }

  async setCeilingOverride(
    tenantId: string,
    collectorUserId: string,
    floatCeilingMinor: bigint | null,
  ): Promise<CollectorWalletRow> {
    return this.db
      .updateTable("collectorWallets")
      .set({ floatCeilingMinor, updatedAt: new Date() })
      .where("tenantId", "=", tenantId)
      .where("collectorUserId", "=", collectorUserId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async listWallets(tenantId: string): Promise<CollectorWalletRow[]> {
    return this.db
      .selectFrom("collectorWallets")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .orderBy("collectorUserId", "asc")
      .execute();
  }

  /**
   * Active wallets that hold at least one open intake older than `cutoff`.
   * The deadline sweeper works from these; the frozen ones have already been
   * flagged and need no second notice.
   */
  async overdueWallets(tenantId: string, cutoff: Date): Promise<CollectorWalletRow[]> {
    const result = await sql<{
      id: string;
      collector_user_id: string;
      status: string;
      frozen_at: Date | null;
      frozen_reason: string | null;
      overdue_since: Date | null;
      float_ceiling_minor: bigint | null;
      deposit_instruction_id: string | null;
      created_at: Date;
      updated_at: Date;
    }>`
      select w.id, w.collector_user_id, w.status, w.frozen_at, w.frozen_reason,
             w.overdue_since, w.float_ceiling_minor, w.deposit_instruction_id,
             w.created_at, w.updated_at
      from collector_wallets w
      where w.tenant_id = ${tenantId}
        and w.status = 'active'
        and exists (
          select 1 from cash_intakes i
          where i.tenant_id = w.tenant_id
            and i.collector_user_id = w.collector_user_id
            and i.status = 'open'
            and i.recorded_at < ${cutoff}
        )
    `.execute(this.db);
    return result.rows.map((row) => ({
      id: row.id,
      tenantId,
      collectorUserId: row.collector_user_id,
      status: row.status === "frozen" ? ("frozen" as const) : ("active" as const),
      frozenAt: row.frozen_at,
      frozenReason: row.frozen_reason,
      overdueSince: row.overdue_since,
      floatCeilingMinor: row.float_ceiling_minor,
      depositInstructionId: row.deposit_instruction_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  // ----------------------------------------------------------- instructions

  async findActiveInstruction(
    tenantId: string,
    provider: string,
    reference: string,
  ): Promise<CollectorDepositInstructionRow | undefined> {
    return this.db
      .selectFrom("collectorDepositInstructions")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("provider", "=", provider)
      .where("reference", "=", reference)
      .where("status", "=", "active")
      .executeTakeFirst();
  }

  async findActiveInstructionForCollector(
    tenantId: string,
    collectorUserId: string,
    provider?: string,
  ): Promise<CollectorDepositInstructionRow | undefined> {
    let query = this.db
      .selectFrom("collectorDepositInstructions")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("collectorUserId", "=", collectorUserId)
      .where("status", "=", "active");
    if (provider !== undefined) {
      query = query.where("provider", "=", provider);
    }
    return query.executeTakeFirst();
  }

  /**
   * Provisions a deposit instruction for a collector. The active-per-provider
   * unique index means a second live instruction would fail loudly rather than
   * silently leave two destinations for the same cash.
   */
  async createInstruction(
    tenantId: string,
    params: {
      collectorUserId: string;
      provider: string;
      reference: string;
      kind: "virtual_account" | "narration";
    },
  ): Promise<CollectorDepositInstructionRow> {
    return this.db
      .insertInto("collectorDepositInstructions")
      .values({ tenantId, ...params })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async revokeInstruction(
    tenantId: string,
    instructionId: string,
  ): Promise<CollectorDepositInstructionRow | undefined> {
    return this.db
      .updateTable("collectorDepositInstructions")
      .set({ status: "revoked", revokedAt: new Date() })
      .where("tenantId", "=", tenantId)
      .where("id", "=", instructionId)
      .where("status", "=", "active")
      .returningAll()
      .executeTakeFirst();
  }

  // ---------------------------------------------------------------- intakes

  /**
   * Inserts an intake unless the client reference was already used. A replay
   * returns the original row with `existed: true` and changes nothing, which is
   * what makes the admin form's "try again" button safe.
   */
  async insertIntakeIfAbsent(
    tenantId: string,
    params: {
      collectorUserId: string;
      clientReference: string;
      assetId: string;
      zoneId: string | null;
      businessDate: string;
      amountMinor: bigint;
      currency: string;
      receiptNumber: string;
      obligationPeriodId?: string | null;
      transactionId?: string | null;
    },
  ): Promise<{ intake: CashIntakeRow; existed: boolean }> {
    const existing = await this.db
      .selectFrom("cashIntakes")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("collectorUserId", "=", params.collectorUserId)
      .where("clientReference", "=", params.clientReference)
      .executeTakeFirst();
    if (existing !== undefined) {
      return { intake: existing, existed: true };
    }
    const intake = await this.db
      .insertInto("cashIntakes")
      .values({
        tenantId,
        collectorUserId: params.collectorUserId,
        clientReference: params.clientReference,
        assetId: params.assetId,
        zoneId: params.zoneId,
        businessDate: params.businessDate,
        amountMinor: params.amountMinor,
        currency: params.currency,
        receiptNumber: params.receiptNumber,
        obligationPeriodId: params.obligationPeriodId ?? null,
        transactionId: params.transactionId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { intake, existed: false };
  }

  async findIntakeById(tenantId: string, intakeId: string): Promise<CashIntakeRow | undefined> {
    return this.db
      .selectFrom("cashIntakes")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("id", "=", intakeId)
      .executeTakeFirst();
  }

  /**
   * Finds the intake a retry would replay, before any check runs.
   *
   * The replay must succeed without touching the checks that a fresh intake
   * has to pass - the day is already paid by now, so an `already_paid` error
   * would answer a harmless double submit with a failure.
   */
  async findIntakeByClientReference(
    tenantId: string,
    collectorUserId: string,
    clientReference: string,
  ): Promise<CashIntakeRow | undefined> {
    return this.db
      .selectFrom("cashIntakes")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("collectorUserId", "=", collectorUserId)
      .where("clientReference", "=", clientReference)
      .executeTakeFirst();
  }

  /** Intakes still waiting for deposit coverage, oldest cash first. */
  async openIntakesForCollector(
    tenantId: string,
    collectorUserId: string,
  ): Promise<CashIntakeRow[]> {
    return this.db
      .selectFrom("cashIntakes")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("collectorUserId", "=", collectorUserId)
      .where("status", "=", "open")
      .orderBy("recordedAt", "asc")
      .execute();
  }

  async sumOpenIntakes(tenantId: string, collectorUserId: string): Promise<bigint> {
    const result = await sql<{ total: string | null }>`
      select coalesce(sum(amount_minor), 0) as total
      from cash_intakes
      where tenant_id = ${tenantId}
        and collector_user_id = ${collectorUserId}
        and status = 'open'
    `.execute(this.db);
    const total = result.rows[0]?.total;
    return total === undefined || total === null ? 0n : BigInt(total);
  }

  async listIntakes(
    tenantId: string,
    filter: ListIntakesFilter,
  ): Promise<{ rows: CashIntakeRow[]; nextCursor: string | null; hasMore: boolean }> {
    const limit = filter.limit ?? 50;
    let query = this.db.selectFrom("cashIntakes").selectAll().where("tenantId", "=", tenantId);
    if (filter.collectorUserId !== undefined)
      query = query.where("collectorUserId", "=", filter.collectorUserId);
    if (filter.zoneId !== undefined) query = query.where("zoneId", "=", filter.zoneId);
    if (filter.businessDate !== undefined)
      query = query.where("businessDate", "=", filter.businessDate);
    if (filter.status !== undefined) query = query.where("status", "=", filter.status);
    if (filter.cursor !== undefined) {
      const decoded = decodeCursor(filter.cursor);
      if (decoded) {
        const ts = new Date(decoded.recordedAt);
        if (!Number.isNaN(ts.getTime())) {
          query = query.where((eb) =>
            eb.or([
              eb("recordedAt", "<", ts),
              eb.and([eb("recordedAt", "=", ts), eb("id", "<", decoded.id)]),
            ]),
          );
        }
      }
    }
    const rows = await query
      .orderBy("recordedAt", "desc")
      .orderBy("id", "desc")
      .limit(limit + 1)
      .execute();
    const hasMore = rows.length > limit;
    const page = hasMore ? (rows.slice(0, limit) as CashIntakeRow[]) : (rows as CashIntakeRow[]);
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last !== undefined
        ? Buffer.from(
            JSON.stringify({ recordedAt: last.recordedAt.toISOString(), id: last.id }),
          ).toString("base64url")
        : null;
    return { rows: page, nextCursor, hasMore };
  }

  // --------------------------------------------------------------- deposits

  /**
   * Inserts a deposit unless the provider already reported it. Replay-safe per
   * `(tenant_id, provider, provider_reference)`, exactly like a payment webhook.
   */
  async insertDepositIfAbsent(
    tenantId: string,
    params: {
      provider: string;
      providerReference: string;
      amountMinor: bigint;
      currency: string;
      collectorUserId?: string | null;
      webhookEventId?: string | null;
    },
  ): Promise<{ deposit: CashDepositRow; existed: boolean }> {
    const existing = await this.db
      .selectFrom("cashDeposits")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("provider", "=", params.provider)
      .where("providerReference", "=", params.providerReference)
      .executeTakeFirst();
    if (existing !== undefined) {
      return { deposit: existing, existed: true };
    }
    const inserted = await this.db
      .insertInto("cashDeposits")
      .values({
        tenantId,
        provider: params.provider,
        providerReference: params.providerReference,
        amountMinor: params.amountMinor,
        currency: params.currency,
        collectorUserId: params.collectorUserId ?? null,
        webhookEventId: params.webhookEventId ?? null,
      })
      .onConflict((oc) => oc.columns(["tenantId", "provider", "providerReference"]).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted !== undefined) {
      return { deposit: inserted, existed: false };
    }
    const afterConflict = await this.db
      .selectFrom("cashDeposits")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("provider", "=", params.provider)
      .where("providerReference", "=", params.providerReference)
      .executeTakeFirstOrThrow();
    return { deposit: afterConflict, existed: true };
  }

  async findDepositById(tenantId: string, depositId: string): Promise<CashDepositRow | undefined> {
    return this.db
      .selectFrom("cashDeposits")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("id", "=", depositId)
      .executeTakeFirst();
  }

  /** Marks a deposit matched (or partially matched) and attributes the collector. */
  async setDepositOutcome(
    tenantId: string,
    depositId: string,
    params: { status: "matched" | "partial" | "suspense"; collectorUserId?: string | null },
  ): Promise<CashDepositRow> {
    const updates: {
      status: "matched" | "partial" | "suspense";
      matchedAt: Date | null;
      collectorUserId?: string | null;
    } = { status: params.status, matchedAt: params.status === "suspense" ? null : new Date() };
    if (params.collectorUserId !== undefined) {
      updates.collectorUserId = params.collectorUserId;
    }
    return this.db
      .updateTable("cashDeposits")
      .set(updates)
      .where("tenantId", "=", tenantId)
      .where("id", "=", depositId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Appends one allocation row; re-allocating the same intake twice is rejected. */
  async addDepositAllocation(
    tenantId: string,
    params: { depositId: string; intakeId: string; amountMinor: bigint },
  ): Promise<CashDepositAllocationRow> {
    return this.db
      .insertInto("cashDepositAllocations")
      .values({ tenantId, ...params })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async markIntakeMatched(tenantId: string, intakeId: string): Promise<void> {
    await this.db
      .updateTable("cashIntakes")
      .set({ status: "matched" })
      .where("tenantId", "=", tenantId)
      .where("id", "=", intakeId)
      .where("status", "=", "open")
      .execute();
  }

  async listDepositAllocations(
    tenantId: string,
    depositId: string,
  ): Promise<CashDepositAllocationRow[]> {
    return this.db
      .selectFrom("cashDepositAllocations")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("depositId", "=", depositId)
      .orderBy("createdAt", "asc")
      .execute();
  }

  /** How much of one intake the deposits have already covered, minor units. */
  async sumIntakeAllocation(tenantId: string, intakeId: string): Promise<bigint> {
    const result = await sql<{ total: string | null }>`
      select coalesce(sum(amount_minor), 0) as total
      from cash_deposit_allocations
      where tenant_id = ${tenantId}
        and intake_id = ${intakeId}
    `.execute(this.db);
    const total = result.rows[0]?.total;
    return total === undefined || total === null ? 0n : BigInt(total);
  }

  async listDeposits(
    tenantId: string,
    filter: ListDepositsFilter,
  ): Promise<{ rows: CashDepositRow[]; nextCursor: string | null; hasMore: boolean }> {
    const limit = filter.limit ?? 50;
    let query = this.db.selectFrom("cashDeposits").selectAll().where("tenantId", "=", tenantId);
    if (filter.collectorUserId !== undefined)
      query = query.where("collectorUserId", "=", filter.collectorUserId);
    if (filter.status !== undefined) query = query.where("status", "=", filter.status);
    if (filter.cursor !== undefined) {
      const decoded = decodeCursor(filter.cursor);
      if (decoded) {
        const ts = new Date(decoded.recordedAt);
        if (!Number.isNaN(ts.getTime())) {
          query = query.where((eb) =>
            eb.or([
              eb("createdAt", "<", ts),
              eb.and([eb("createdAt", "=", ts), eb("id", "<", decoded.id)]),
            ]),
          );
        }
      }
    }
    const rows = await query
      .orderBy("createdAt", "desc")
      .orderBy("id", "desc")
      .limit(limit + 1)
      .execute();
    const hasMore = rows.length > limit;
    const page = hasMore ? (rows.slice(0, limit) as CashDepositRow[]) : (rows as CashDepositRow[]);
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last !== undefined
        ? Buffer.from(
            JSON.stringify({ recordedAt: last.createdAt.toISOString(), id: last.id }),
          ).toString("base64url")
        : null;
    return { rows: page, nextCursor, hasMore };
  }
}

function decodeCursor(cursor: string): { recordedAt: string; id: string } | undefined {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      recordedAt?: unknown;
      id?: unknown;
    };
    if (typeof decoded.recordedAt === "string" && typeof decoded.id === "string") {
      return { recordedAt: decoded.recordedAt, id: decoded.id };
    }
    return undefined;
  } catch {
    return undefined;
  }
}
