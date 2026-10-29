import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Database } from "../connection.js";

/**
 * Aggregate sources for the finance reports (Phase 8, D49).
 *
 * Reports read existing tables only — there is no reporting projector and no
 * second source of truth. Rows are grouped with `(posted_at | created_at |
 * business_date) in the tenant timezone`, because a business day is a tenant
 * concept, not a UTC one. Money leaves every query as text so the exact minor
 * unit survives serialization.
 */

export interface DailyCollectionsRow {
  readonly businessDate: string;
  /** Paid obligation amounts for the day. */
  readonly revenueMinor: bigint;
  readonly paymentsCount: number;
  readonly paymentsTotalMinor: bigint;
  readonly cashIntakeCount: number;
  readonly cashIntakeTotalMinor: bigint;
  /** Revenue given back by reversals posted that day. */
  readonly refundsMinor: bigint;
}

export interface ZoneCollectionsRow {
  readonly zoneId: string;
  readonly zoneName: string;
  readonly revenueMinor: bigint;
  readonly scansCount: number;
  readonly paidScans: number;
  /** No payment recorded for the day — never "unpaid", which implies a debt. */
  readonly notPaidScans: number;
  readonly unknownScans: number;
}

export interface AssetTypeCollectionsRow {
  readonly assetTypeKey: string;
  readonly revenueMinor: bigint;
  /** The three statuses a registry asset can sit in (0003_assets). */
  readonly activeAssets: number;
  readonly suspendedAssets: number;
  readonly retiredAssets: number;
  readonly scansCount: number;
}

export interface CollectorPositionRow {
  readonly collectorUserId: string;
  readonly intakeCount: number;
  readonly intakeTotalMinor: bigint;
  readonly postedDepositTotalMinor: bigint;
  /** The derived COLLECTOR_CASH balance today, not the range's. */
  readonly floatMinor: bigint;
  readonly overdueOpenIntakes: number;
}

export interface ComplianceRow {
  readonly businessDate: string;
  readonly zoneId: string | null;
  readonly zoneName: string | null;
  readonly officerUserId: string | null;
  /** The rate molecular and denominator; unknown scans are excluded (D44). */
  readonly paidScans: number;
  readonly notPaidScans: number;
  readonly unknownScans: number;
}

export interface ExceptionsSummaryRow {
  readonly businessDate: string;
  readonly kind: string;
  readonly severity: string;
  readonly status: string;
  readonly count: number;
}

export class ReportRepository {
  constructor(private readonly db: Transaction<Database>) {}

  /**
   * Collections per business day. Gate revenue comes from paid obligations of
   * the day; gateway and cash movers come from their own tables; refunds are
   * revenue debits posted in the day's hours (D49 keeps the gross/fee/net
   * breakdown open, so v1 shows honest primitives rather than a guess).
   */
  async dailyCollections(
    tenantId: string,
    timeZone: string,
    from: string,
    to: string,
  ): Promise<DailyCollectionsRow[]> {
    const result = await sql<{
      businessDate: string;
      revenue: string;
      paymentsCount: string;
      paymentsTotal: string;
      intakeCount: string;
      intakeTotal: string;
      refunds: string;
    }>`
      with days as (
        select b::date as business_date
        from generate_series(${from}::date, ${to}::date, interval '1 day') b
      ),
      revenue as (
        select business_date, sum(amount_minor) as revenue, count(*) as payments_count
        from obligation_periods
        where tenant_id = ${tenantId} and status = 'paid'
          and business_date between ${from}::date and ${to}::date
        group by business_date
      ),
      payments as (
        select business_date, count(*) as payments_count, sum(amount_minor) as payments_total
        from payments
        where tenant_id = ${tenantId} and status <> 'rejected'
          and business_date between ${from}::date and ${to}::date
        group by business_date
      ),
      intakes as (
        select business_date, count(*) as intake_count, sum(amount_minor) as intake_total
        from cash_intakes
        where tenant_id = ${tenantId} and status <> 'reversed'
          and business_date between ${from}::date and ${to}::date
        group by business_date
      ),
      refunds as (
        select (t.posted_at at time zone ${timeZone})::date as business_date, sum(le.amount_minor) as refunds
        from ledger_entries le
        join accounts a on a.id = le.account_id and a.tenant_id = le.tenant_id
        join transactions t on t.id = le.transaction_id and t.tenant_id = le.tenant_id
        where le.tenant_id = ${tenantId} and a.code = 'REVENUE_LEVY' and le.direction = 'debit'
        group by 1
      )
      select d.business_date::text,
             coalesce(r.revenue, 0)::text as revenue,
             coalesce(p.payments_count, 0)::text as payments_count,
             coalesce(p.payments_total, 0)::text as payments_total,
             coalesce(i.intake_count, 0)::text as intake_count,
             coalesce(i.intake_total, 0)::text as intake_total,
             coalesce(rf.refunds, 0)::text as refunds
      from days d
      left join revenue r on r.business_date = d.business_date
      left join payments p on p.business_date = d.business_date
      left join intakes i on i.business_date = d.business_date
      left join refunds rf on rf.business_date = d.business_date
      order by d.business_date
    `.execute(this.db);
    return result.rows.map((row) => ({
      businessDate: row.businessDate,
      revenueMinor: BigInt(row.revenue),
      paymentsCount: Number(row.paymentsCount),
      paymentsTotalMinor: BigInt(row.paymentsTotal),
      cashIntakeCount: Number(row.intakeCount),
      cashIntakeTotalMinor: BigInt(row.intakeTotal),
      refundsMinor: BigInt(row.refunds),
    }));
  }

  /** Collections and scan outcomes by the zone of the asset. */
  async collectionsByZone(
    tenantId: string,
    from: string,
    to: string,
  ): Promise<ZoneCollectionsRow[]> {
    const result = await sql<{
      zoneId: string;
      zoneName: string;
      revenue: string;
      scansCount: string;
      paidScans: string;
      unpaidScans: string;
      unknownScans: string;
    }>`
      with zone_revenue as (
        select a.zone_id, sum(op.amount_minor) as revenue
        from obligation_periods op
        join assets a on a.id = op.asset_id and a.tenant_id = op.tenant_id
        where op.tenant_id = ${tenantId} and op.status = 'paid'
          and op.business_date between ${from}::date and ${to}::date
        group by a.zone_id
      ),
      zone_scans as (
        select zone_id,
               count(*) as scans_count,
               count(*) filter (where authoritative_status = 'paid') as paid_scans,
               count(*) filter (where authoritative_status = 'no_payment_recorded') as unpaid_scans,
               count(*) filter (where authoritative_status = 'unknown') as unknown_scans
        from scans
        where tenant_id = ${tenantId} and zone_id is not null
          and business_date between ${from}::date and ${to}::date
        group by zone_id
      )
      select z.id as zone_id,
             z.name as zone_name,
             coalesce(r.revenue, 0)::text as revenue,
             coalesce(s.scans_count, 0)::text as scans_count,
             coalesce(s.paid_scans, 0)::text as paid_scans,
             coalesce(s.unpaid_scans, 0)::text as unpaid_scans,
             coalesce(s.unknown_scans, 0)::text as unknown_scans
      from zones z
      left join zone_revenue r on r.zone_id = z.id
      left join zone_scans s on s.zone_id = z.id
      where z.tenant_id = ${tenantId}
        and (r.zone_id is not null or s.zone_id is not null)
      order by z.name, z.id
    `.execute(this.db);
    return result.rows.map((row) => ({
      zoneId: row.zoneId,
      zoneName: row.zoneName,
      revenueMinor: BigInt(row.revenue),
      scansCount: Number(row.scansCount),
      paidScans: Number(row.paidScans),
      notPaidScans: Number(row.unpaidScans),
      unknownScans: Number(row.unknownScans),
    }));
  }

  /** Collections and scan counts by the asset type of the asset. */
  async collectionsByAssetType(
    tenantId: string,
    from: string,
    to: string,
  ): Promise<AssetTypeCollectionsRow[]> {
    const result = await sql<{
      assetTypeKey: string;
      revenue: string;
      active: string;
      suspended: string;
      retired: string;
      scansCount: string;
    }>`
      with type_revenue as (
        select a.asset_type_key, sum(op.amount_minor) as revenue
        from obligation_periods op
        join assets a on a.id = op.asset_id and a.tenant_id = op.tenant_id
        where op.tenant_id = ${tenantId} and op.status = 'paid'
          and op.business_date between ${from}::date and ${to}::date
        group by a.asset_type_key
      ),
      type_assets as (
        select asset_type_key,
               count(*) filter (where status = 'active') as active,
               count(*) filter (where status = 'suspended') as suspended,
               count(*) filter (where status = 'retired') as retired
        from assets
        where tenant_id = ${tenantId}
        group by asset_type_key
      ),
      type_scans as (
        select a.asset_type_key, count(*) as scans_count
        from scans s
        join assets a on a.id = s.asset_id and a.tenant_id = s.tenant_id
        where s.tenant_id = ${tenantId}
          and s.business_date between ${from}::date and ${to}::date
        group by a.asset_type_key
      )
      select t.asset_type_key,
             coalesce(r.revenue, 0)::text as revenue,
             coalesce(ta.active, 0)::text as active,
             coalesce(ta.suspended, 0)::text as suspended,
             coalesce(ta.retired, 0)::text as retired,
             coalesce(ts.scans_count, 0)::text as scans_count
      from (select distinct asset_type_key from assets where tenant_id = ${tenantId}) t
      left join type_revenue r on r.asset_type_key = t.asset_type_key
      left join type_assets ta on ta.asset_type_key = t.asset_type_key
      left join type_scans ts on ts.asset_type_key = t.asset_type_key
      order by t.asset_type_key
    `.execute(this.db);
    return result.rows.map((row) => ({
      assetTypeKey: row.assetTypeKey,
      revenueMinor: BigInt(row.revenue),
      activeAssets: Number(row.active),
      suspendedAssets: Number(row.suspended),
      retiredAssets: Number(row.retired),
      scansCount: Number(row.scansCount),
    }));
  }

  /** Each collector's position: activity in range plus the float held today. */
  async collectorPositions(
    tenantId: string,
    from: string,
    to: string,
    depositsFrom: Date,
    depositsTo: Date,
    overdueCutoff: Date,
  ): Promise<CollectorPositionRow[]> {
    const result = await sql<{
      collectorUserId: string;
      intakeCount: string;
      intakeTotal: string;
      depositTotal: string;
      float: string;
      overdue: string;
    }>`
      select u.id as collector_user_id,
             coalesce((
               select count(*)::text from cash_intakes ci
               where ci.tenant_id = u.tenant_id and ci.collector_user_id = u.id
                 and ci.status <> 'reversed'
                 and ci.business_date between ${from}::date and ${to}::date
             ), '0') as intake_count,
             coalesce((
               select sum(ci.amount_minor)::text from cash_intakes ci
               where ci.tenant_id = u.tenant_id and ci.collector_user_id = u.id
                 and ci.status <> 'reversed'
                 and ci.business_date between ${from}::date and ${to}::date
             ), '0') as intake_total,
             coalesce((
               select sum(cd.amount_minor)::text from cash_deposits cd
               where cd.tenant_id = u.tenant_id and cd.collector_user_id = u.id
                 and cd.status <> 'suspense'
                 and cd.created_at >= ${depositsFrom}
                 and cd.created_at < ${depositsTo}
             ), '0') as deposit_total,
             coalesce((
               select sum(case when le.direction = 'debit' then le.amount_minor else -le.amount_minor end)::text
               from ledger_entries le
               join accounts a on a.id = le.account_id and a.tenant_id = le.tenant_id
               where le.tenant_id = u.tenant_id and a.code = 'COLLECTOR_CASH'
                 and le.collector_user_id = u.id
             ), '0') as float,
             coalesce((
               select count(*)::text from cash_intakes ci
               where ci.tenant_id = u.tenant_id and ci.collector_user_id = u.id
                 and ci.status = 'open' and ci.recorded_at < ${overdueCutoff}
             ), '0') as overdue
      from users u
      where u.tenant_id = ${tenantId}
        and exists (select 1 from collector_wallets w where w.tenant_id = u.tenant_id and w.collector_user_id = u.id)
      order by u.username
    `.execute(this.db);
    return result.rows.map((row) => ({
      collectorUserId: row.collectorUserId,
      intakeCount: Number(row.intakeCount),
      intakeTotalMinor: BigInt(row.intakeTotal),
      postedDepositTotalMinor: BigInt(row.depositTotal),
      floatMinor: BigInt(row.float),
      overdueOpenIntakes: Number(row.overdue),
    }));
  }

  /** Scan outcomes grouped by day, zone and officer; the compliance source (D44). */
  async compliance(tenantId: string, from: string, to: string): Promise<ComplianceRow[]> {
    const result = await sql<{
      businessDate: string;
      zoneId: string | null;
      zoneName: string | null;
      officerUserId: string | null;
      paid: string;
      unpaid: string;
      unknown: string;
    }>`
      with per_group as (
        select business_date, zone_id, officer_user_id,
               count(*) filter (where authoritative_status = 'paid') as paid,
               count(*) filter (where authoritative_status = 'no_payment_recorded') as unpaid,
               count(*) filter (where authoritative_status = 'unknown') as unknown
        from scans
        where tenant_id = ${tenantId}
          and business_date between ${from}::date and ${to}::date
        group by business_date, zone_id, officer_user_id
      )
      select g.business_date::text, g.zone_id, z.name as zone_name, g.officer_user_id,
             g.paid::text, g.unpaid::text, g.unknown::text
      from per_group g
      left join zones z on z.id = g.zone_id and z.tenant_id = ${tenantId}
      order by g.business_date, g.zone_id nulls first, g.officer_user_id
    `.execute(this.db);
    return result.rows.map((row) => ({
      businessDate: row.businessDate,
      zoneId: row.zoneId,
      zoneName: row.zoneName,
      officerUserId: row.officerUserId,
      paidScans: Number(row.paid),
      notPaidScans: Number(row.unpaid),
      unknownScans: Number(row.unknown),
    }));
  }

  /** Exception counts for each day in the range, by kind, severity and state. */
  async exceptionsSummary(
    tenantId: string,
    from: string,
    to: string,
  ): Promise<ExceptionsSummaryRow[]> {
    const result = await sql<{
      businessDate: string;
      kind: string;
      severity: string;
      status: string;
      count: string;
    }>`
      select business_date::text, kind, severity, status, count(*)::text as count
      from reconciliation_exceptions
      where tenant_id = ${tenantId}
        and business_date between ${from}::date and ${to}::date
      group by business_date, kind, severity, status
      order by business_date desc, kind, severity, status
    `.execute(this.db);
    return result.rows.map((row) => ({
      businessDate: row.businessDate,
      kind: row.kind,
      severity: row.severity,
      status: row.status,
      count: Number(row.count),
    }));
  }
}
