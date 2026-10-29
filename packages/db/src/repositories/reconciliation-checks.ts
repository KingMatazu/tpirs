import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Database } from "../connection.js";
import type { SettlementRowRow } from "../connection.js";

/**
 * Aggregate queries the reconciliation run needs (ADR 0037).
 *
 * These are read-only companions to `ReconciliationRunRepository`: one method
 * per input a check consumes, each taking explicit bounds so the run controls
 * business-day conversion (the caller computes the UTC instant range from the
 * tenant timezone, the repository never parses dates itself).
 *
 * Counting queries return JSON-friendly rows; money queries cast to text so
 * `bigint` stays exact on the way out.
 */
export class ReconciliationCheckRepository {
  constructor(private readonly db: Transaction<Database>) {}

  /** Statement rows settled inside the day that have not posted yet. */
  async unsettledSettlementRows(
    tenantId: string,
    settledFrom: Date,
    settledTo: Date,
  ): Promise<SettlementRowRow[]> {
    return this.db
      .selectFrom("settlementRows")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("settledAt", ">=", settledFrom)
      .where("settledAt", "<", settledTo)
      .where("status", "in", ["unmatched", "matched"])
      .orderBy("settledAt", "asc")
      .execute();
  }

  /** Distinct settlement rows matched but never posted, for the evidence check. */
  async matchedNotPostedRows(
    tenantId: string,
    settledFrom: Date,
    settledTo: Date,
  ): Promise<SettlementRowRow[]> {
    return this.db
      .selectFrom("settlementRows")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("settledAt", ">=", settledFrom)
      .where("settledAt", "<", settledTo)
      .where("status", "=", "matched")
      .execute();
  }

  /**
   * Ledger postings made for posted settlement rows, keyed by row id. The
   * `settlement_amounts` check compares the posting the row actually produced
   * against the statement evidence SQL can recompute.
   */
  async settlementPostings(
    tenantId: string,
    rowIds: readonly string[],
  ): Promise<Map<string, { bankMinor: bigint; feeMinor: bigint; carriedMinor: bigint }>> {
    const postings = new Map<
      string,
      { bankMinor: bigint; feeMinor: bigint; carriedMinor: bigint }
    >();
    if (rowIds.length === 0) return postings;
    const result = await sql<{
      settlementRowId: string;
      bank: string;
      fee: string;
      clearing: string;
    }>`
      select t.source_id as "settlementRowId",
             coalesce(sum(case when a.code = 'SETTLEMENT_BANK' then le.amount_minor else 0 end), 0)::text as bank,
             coalesce(sum(case when a.code = 'GATEWAY_FEES' then le.amount_minor else 0 end), 0)::text as fee,
             coalesce(sum(case when a.code = 'GATEWAY_CLEARING' then le.amount_minor else 0 end), 0)::text as clearing
      from ledger_entries le
      join accounts a on a.id = le.account_id and a.tenant_id = le.tenant_id
      join transactions t on t.id = le.transaction_id and t.tenant_id = le.tenant_id
      where le.tenant_id = ${tenantId}
        and t.source_type = 'settlement'
        and t.source_id = any(${rowIds}::text[])
      group by t.source_id
    `.execute(this.db);
    for (const row of result.rows) {
      postings.set(row.settlementRowId, {
        bankMinor: BigInt(row.bank),
        feeMinor: BigInt(row.fee),
        carriedMinor: BigInt(row.clearing),
      });
    }
    return postings;
  }

  /** Debit and credit totals for every entry posted inside the day window. */
  async dayLedgerTotals(
    tenantId: string,
    postedFrom: Date,
    postedTo: Date,
  ): Promise<{ debitMinor: bigint; creditMinor: bigint }> {
    const result = await sql<{ direction: string; total: string | null }>`
      select le.direction, sum(le.amount_minor)::text as total
      from ledger_entries le
      join transactions t on t.id = le.transaction_id and t.tenant_id = le.tenant_id
      where le.tenant_id = ${tenantId}
        and t.posted_at >= ${postedFrom}
        and t.posted_at < ${postedTo}
      group by le.direction
    `.execute(this.db);
    const debit = result.rows.find((row) => row.direction === "debit")?.total;
    const credit = result.rows.find((row) => row.direction === "credit")?.total;
    return {
      debitMinor: debit === undefined || debit === null ? 0n : BigInt(debit),
      creditMinor: credit === undefined || credit === null ? 0n : BigInt(credit),
    };
  }

  /**
   * REVENUE_LEVY credits and debits recognised for one business day.
   *
   * Revenue is scoped by the obligation period it settled, not by the posting
   * instant: a payment that arrives after midnight still recognises revenue for
   * the day it paid for, which is the day the tenant reconciles.
   */
  async dayRevenueTotals(
    tenantId: string,
    businessDate: string,
  ): Promise<{ creditMinor: bigint; debitMinor: bigint }> {
    const result = await sql<{ credit: string | null; debit: string | null }>`
      select coalesce(sum(case when le.direction = 'credit' then le.amount_minor else 0 end), 0)::text as credit,
             coalesce(sum(case when le.direction = 'debit' then le.amount_minor else 0 end), 0)::text as debit
      from ledger_entries le
      join accounts a on a.id = le.account_id and a.tenant_id = le.tenant_id
      where le.tenant_id = ${tenantId}
        and a.code = 'REVENUE_LEVY'
        and le.obligation_period_id is not null
        and exists (
          select 1 from obligation_periods op
          where op.id = le.obligation_period_id
            and op.tenant_id = le.tenant_id
            and op.business_date = ${businessDate}
        )
    `.execute(this.db);
    const row = result.rows[0];
    return {
      creditMinor: row?.credit === undefined || row.credit === null ? 0n : BigInt(row.credit),
      debitMinor: row?.debit === undefined || row.debit === null ? 0n : BigInt(row.debit),
    };
  }

  /**
   * Amount allocated to one business day's obligation periods.
   *
   * This is what revenue should have recognised for the day. It is the paid
   * amount, not the amount owed: under `pay_per_use` a short payment is a
   * wallet credit that partially funds the period, and the revenue recognised
   * is the cash received, not the fee. Counting only `status = 'paid'` periods
   * would flag every underpayment as a revenue mismatch.
   */
  async obligationAllocationTotalsForDate(
    tenantId: string,
    businessDate: string,
  ): Promise<{ count: number; amountMinor: bigint }> {
    const result = await sql<{ count: string; total: string | null }>`
      select count(*)::text as count,
             coalesce(sum(amount_paid_minor), 0)::text as total
      from obligation_periods
      where tenant_id = ${tenantId}
        and business_date = ${businessDate}
    `.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) return { count: 0, amountMinor: 0n };
    return {
      count: Number(row.count),
      amountMinor: row.total === null ? 0n : BigInt(row.total),
    };
  }

  /** Whole-history intake totals for every collector that ever took cash. */
  async collectorIntakeTotals(tenantId: string): Promise<Map<string, bigint>> {
    const result = await sql<{ collectorUserId: string; total: string }>`
      select collector_user_id, coalesce(sum(amount_minor), 0)::text as total
      from cash_intakes
      where tenant_id = ${tenantId} and status <> 'reversed'
      group by collector_user_id
    `.execute(this.db);
    return mapRows(result.rows);
  }

  /** Whole-history totals of deposits that posted money (not suspense). */
  async collectorPostedDepositTotals(tenantId: string): Promise<Map<string, bigint>> {
    const result = await sql<{ collectorUserId: string; total: string }>`
      select collector_user_id, coalesce(sum(amount_minor), 0)::text as total
      from cash_deposits
      where tenant_id = ${tenantId} and status <> 'suspense' and collector_user_id is not null
      group by collector_user_id
    `.execute(this.db);
    return mapRows(result.rows);
  }

  /**
   * Derived `COLLECTOR_CASH` balance per collector (debits minus credits, ADR
   * 0031) — the same identity the wallet view computes, in one grouped query.
   */
  async collectorCashBalances(tenantId: string): Promise<Map<string, bigint>> {
    const result = await sql<{ collectorUserId: string; total: string }>`
      select le.collector_user_id,
             coalesce(sum(case when le.direction = 'debit' then le.amount_minor else -le.amount_minor end), 0)::text as total
      from ledger_entries le
      join accounts a on a.id = le.account_id and a.tenant_id = le.tenant_id
      where le.tenant_id = ${tenantId} and a.code = 'COLLECTOR_CASH'
        and le.collector_user_id is not null
      group by le.collector_user_id
    `.execute(this.db);
    return mapRows(result.rows);
  }

  /** Open intakes for one collector recorded before `cutoff`. */
  async countOpenOverdueIntakes(
    tenantId: string,
    collectorUserId: string,
    cutoff: Date,
  ): Promise<number> {
    const result = await sql<{ count: string }>`
      select count(*)::text as count
      from cash_intakes
      where tenant_id = ${tenantId}
        and collector_user_id = ${collectorUserId}
        and status = 'open'
        and recorded_at < ${cutoff}
    `.execute(this.db);
    return Number(result.rows[0]?.count ?? "0");
  }

  /** Suspense payments older than the cutoff. */
  async agedSuspensePayments(
    tenantId: string,
    olderThan: Date,
  ): Promise<{ id: string; amountMinor: bigint }[]> {
    const rows = await this.db
      .selectFrom("payments")
      .select(["id", "amountMinor"])
      .where("tenantId", "=", tenantId)
      .where("status", "=", "suspense")
      .where("createdAt", "<=", olderThan)
      .orderBy("createdAt", "asc")
      .execute();
    return rows.map((row) => ({ id: row.id, amountMinor: row.amountMinor }));
  }

  /** Suspense cash deposits older than the cutoff. */
  async agedSuspenseDeposits(
    tenantId: string,
    olderThan: Date,
  ): Promise<{ id: string; amountMinor: bigint }[]> {
    const rows = await this.db
      .selectFrom("cashDeposits")
      .select(["id", "amountMinor"])
      .where("tenantId", "=", tenantId)
      .where("status", "=", "suspense")
      .where("createdAt", "<=", olderThan)
      .execute();
    return rows.map((row) => ({ id: row.id, amountMinor: row.amountMinor }));
  }

  /** Payments for the business day whose reference appears on more than one row. */
  async duplicateProviderReferences(
    tenantId: string,
    businessDateFrom: string,
    businessDateTo: string,
  ): Promise<{ providerReference: string; count: number }[]> {
    const result = await sql<{ providerReference: string; count: string }>`
      select provider_reference, count(*)::text as count
      from payments
      where tenant_id = ${tenantId}
        and provider_reference is not null
        and business_date >= ${businessDateFrom}
        and business_date <= ${businessDateTo}
      group by provider_reference
      having count(*) > 1
      order by provider_reference
    `.execute(this.db);
    return result.rows.map((row) => ({
      providerReference: row.providerReference,
      count: Number(row.count),
    }));
  }

  // ---------------------------------------------------------------------
  // Anomaly series
  // ---------------------------------------------------------------------

  /** Cash intakes per collector per business day inside a window. */
  async collectorIntakeCounts(
    tenantId: string,
    businessDateFrom: string,
    businessDateTo: string,
  ): Promise<{ collectorUserId: string; businessDate: string; count: number }[]> {
    const result = await sql<{ collectorUserId: string; businessDate: string; count: string }>`
      select collector_user_id, business_date::text, count(*)::text as count
      from cash_intakes
      where tenant_id = ${tenantId}
        and status <> 'reversed'
        and business_date >= ${businessDateFrom}
        and business_date <= ${businessDateTo}
      group by collector_user_id, business_date
    `.execute(this.db);
    return result.rows.map((row) => ({
      collectorUserId: row.collectorUserId,
      businessDate: row.businessDate,
      count: Number(row.count),
    }));
  }

  /** Scan outcome counts per zone per business day inside a window. */
  async zoneComplianceCounts(
    tenantId: string,
    businessDateFrom: string,
    businessDateTo: string,
  ): Promise<
    { zoneId: string; businessDate: string; paid: number; notPaid: number; unknown: number }[]
  > {
    const result = await sql<{
      zoneId: string;
      businessDate: string;
      paid: string;
      notPaid: string;
      unknown: string;
    }>`
      select zone_id,
             business_date::text,
             count(*) filter (where authoritative_status = 'paid')::text as paid,
             count(*) filter (where authoritative_status = 'no_payment_recorded')::text as not_paid,
             count(*) filter (where authoritative_status = 'unknown')::text as unknown
      from scans
      where tenant_id = ${tenantId}
        and zone_id is not null
        and business_date >= ${businessDateFrom}
        and business_date <= ${businessDateTo}
      group by zone_id, business_date
    `.execute(this.db);
    return result.rows.map((row) => ({
      zoneId: row.zoneId,
      businessDate: row.businessDate,
      paid: Number(row.paid),
      notPaid: Number(row.notPaid),
      unknown: Number(row.unknown),
    }));
  }

  /** Scan counts per officer per business day inside a window. */
  async officerScanCounts(
    tenantId: string,
    businessDateFrom: string,
    businessDateTo: string,
  ): Promise<{ officerUserId: string; businessDate: string; count: number }[]> {
    const result = await sql<{ officerUserId: string; businessDate: string; count: string }>`
      select officer_user_id, business_date::text, count(*)::text as count
      from scans
      where tenant_id = ${tenantId}
        and business_date >= ${businessDateFrom}
        and business_date <= ${businessDateTo}
      group by officer_user_id, business_date
    `.execute(this.db);
    return result.rows.map((row) => ({
      officerUserId: row.officerUserId,
      businessDate: row.businessDate,
      count: Number(row.count),
    }));
  }

  /** Suspense amounts standing right now, across payments and cash deposits. */
  async suspenseTotals(
    tenantId: string,
  ): Promise<{ paymentsMinor: bigint; depositsMinor: bigint }> {
    const result = await sql<{ payments: string; deposits: string }>`
      select
        coalesce((select sum(amount_minor)::text from payments
                  where tenant_id = ${tenantId} and status = 'suspense'), '0') as payments,
        coalesce((select sum(amount_minor)::text from cash_deposits
                  where tenant_id = ${tenantId} and status = 'suspense'), '0') as deposits
    `.execute(this.db);
    const row = result.rows[0];
    return {
      paymentsMinor: BigInt(row?.payments ?? "0"),
      depositsMinor: BigInt(row?.deposits ?? "0"),
    };
  }

  /** Collectors with an open intake recorded before `cutoff`. */
  async collectorsWithOverdueIntakes(tenantId: string, cutoff: Date): Promise<Map<string, number>> {
    const result = await sql<{ collectorUserId: string; count: string }>`
      select collector_user_id, count(*)::text as count
      from cash_intakes
      where tenant_id = ${tenantId}
        and status = 'open'
        and recorded_at < ${cutoff}
      group by collector_user_id
    `.execute(this.db);
    const map = new Map<string, number>();
    for (const row of result.rows) map.set(row.collectorUserId, Number(row.count));
    return map;
  }
}

function mapRows(rows: readonly { collectorUserId: string; total: string }[]): Map<string, bigint> {
  const map = new Map<string, bigint>();
  for (const row of rows) map.set(row.collectorUserId, BigInt(row.total));
  return map;
}
