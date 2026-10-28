import { sql } from "kysely";
import type { Transaction } from "kysely";
import { jsonb } from "../connection.js";
import type { Database } from "../connection.js";

export type {
  SettlementImportRow,
  SettlementRowRow,
  ReconciliationRunRow,
  ReconciliationExceptionRow,
  AnomalyEventRow,
} from "../connection.js";
import type {
  SettlementImportRow,
  SettlementRowRow,
  ReconciliationRunRow,
  ReconciliationExceptionRow,
  AnomalyEventRow,
} from "../connection.js";

/**
 * Repositories for Phase 8: settlement evidence, reconciliation runs,
 * exceptions and anomaly events (ADR 0035–0039).
 *
 * As everywhere else, the caller opens the tenant-scoped transaction with
 * `withTenant` (which sets `app.tenant_id` so row-level security applies), and
 * every query still filters on `tenant_id` as defence in depth.
 *
 * Nothing here posts to the ledger. A settlement row is evidence; the posting
 * that moves `GATEWAY_CLEARING` is application work in one transaction with the
 * row's state change, so the two cannot disagree.
 */

export class SettlementImportConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementImportConflictError";
  }
}

export interface RecordSettlementImportInput {
  readonly tenantId: string;
  readonly provider: string;
  readonly filename: string;
  readonly fileHash: string;
  readonly source?: "statement" | "api";
  readonly periodStart?: string | null;
  readonly periodEnd?: string | null;
  readonly rowCount: number;
  readonly rejectedCount: number;
  readonly importedByUserId?: string | null;
}

export interface NewSettlementRow {
  readonly tenantId: string;
  readonly importId: string;
  readonly rowNumber: number;
  readonly rowHash: string;
  readonly providerReference: string;
  readonly amountMinor: bigint;
  readonly feeMinor: bigint;
  readonly currency: string;
  readonly settledAt: Date;
  readonly description: string | null;
  readonly raw: Record<string, string>;
}

export class SettlementImportRepository {
  constructor(private readonly db: Transaction<Database>) {}

  /**
   * Records one statement file. A re-upload of the same bytes returns the
   * original import instead of creating a second one (ADR 0035).
   */
  async record(
    input: RecordSettlementImportInput,
  ): Promise<{ readonly import: SettlementImportRow; readonly created: boolean }> {
    const inserted = await this.db
      .insertInto("settlementImports")
      .values({
        tenantId: input.tenantId,
        provider: input.provider,
        source: input.source ?? "statement",
        filename: input.filename,
        fileHash: input.fileHash,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        rowCount: input.rowCount,
        rejectedCount: input.rejectedCount,
        importedByUserId: input.importedByUserId ?? null,
      })
      .onConflict((oc) => oc.columns(["tenantId", "provider", "fileHash"]).doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted !== undefined) return { import: inserted, created: true };

    const existing = await this.findByHash(input.tenantId, input.provider, input.fileHash);
    if (existing === undefined) {
      throw new SettlementImportConflictError(
        `settlement import ${input.fileHash} conflicted but could not be read back`,
      );
    }
    return { import: existing, created: false };
  }

  async findByHash(
    tenantId: string,
    provider: string,
    fileHash: string,
  ): Promise<SettlementImportRow | undefined> {
    return this.db
      .selectFrom("settlementImports")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("provider", "=", provider)
      .where("fileHash", "=", fileHash)
      .executeTakeFirst();
  }

  async findById(tenantId: string, id: string): Promise<SettlementImportRow | undefined> {
    return this.db
      .selectFrom("settlementImports")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirst();
  }

  async markFailed(tenantId: string, id: string): Promise<void> {
    await this.db
      .updateTable("settlementImports")
      .set({ status: "failed" })
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .execute();
  }
}

export interface SettlementRowFilter {
  readonly status?: "unmatched" | "matched" | "posted" | "excluded";
  readonly providerReference?: string;
  readonly settledFrom?: Date;
  readonly settledTo?: Date;
  readonly limit?: number;
}

export class SettlementRepository {
  constructor(private readonly db: Transaction<Database>) {}

  /**
   * Inserts the accepted rows of one import. The unique key on
   * `(tenant_id, import_id, row_hash)` makes an overlapping re-import a no-op:
   * the rows that already exist are simply not returned as inserted.
   */
  async insertRows(rows: readonly NewSettlementRow[]): Promise<SettlementRowRow[]> {
    if (rows.length === 0) return [];
    return this.db
      .insertInto("settlementRows")
      .values(
        rows.map((row) => ({
          tenantId: row.tenantId,
          importId: row.importId,
          rowNumber: row.rowNumber,
          rowHash: row.rowHash,
          providerReference: row.providerReference,
          amountMinor: row.amountMinor,
          feeMinor: row.feeMinor,
          currency: row.currency,
          settledAt: row.settledAt,
          description: row.description,
          raw: jsonb(row.raw),
        })),
      )
      .onConflict((oc) => oc.columns(["tenantId", "importId", "rowHash"]).doNothing())
      .returningAll()
      .execute();
  }

  async list(tenantId: string, filter: SettlementRowFilter = {}): Promise<SettlementRowRow[]> {
    let query = this.db.selectFrom("settlementRows").selectAll().where("tenantId", "=", tenantId);

    if (filter.status !== undefined) query = query.where("status", "=", filter.status);
    if (filter.providerReference !== undefined) {
      query = query.where("providerReference", "=", filter.providerReference);
    }
    if (filter.settledFrom !== undefined) {
      query = query.where("settledAt", ">=", filter.settledFrom);
    }
    if (filter.settledTo !== undefined) {
      query = query.where("settledAt", "<=", filter.settledTo);
    }
    return query
      .orderBy("settledAt", "asc")
      .limit(filter.limit ?? 500)
      .execute();
  }

  async findById(tenantId: string, id: string): Promise<SettlementRowRow | undefined> {
    return this.db
      .selectFrom("settlementRows")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirst();
  }

  async markMatched(
    tenantId: string,
    id: string,
    paymentId: string,
  ): Promise<SettlementRowRow | undefined> {
    return this.db
      .updateTable("settlementRows")
      .set({ paymentId, status: "matched", updatedAt: new Date() })
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .where("status", "in", ["unmatched", "matched"])
      .returningAll()
      .executeTakeFirst();
  }

  async markPosted(
    tenantId: string,
    id: string,
    input: { readonly paymentId: string; readonly transactionId: string },
  ): Promise<SettlementRowRow | undefined> {
    return this.db
      .updateTable("settlementRows")
      .set({
        paymentId: input.paymentId,
        transactionId: input.transactionId,
        status: "posted",
        updatedAt: new Date(),
      })
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .where("status", "in", ["unmatched", "matched"])
      .returningAll()
      .executeTakeFirst();
  }

  async markExcluded(tenantId: string, id: string): Promise<SettlementRowRow | undefined> {
    return this.db
      .updateTable("settlementRows")
      .set({ status: "excluded", updatedAt: new Date() })
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .where("status", "in", ["unmatched", "matched"])
      .returningAll()
      .executeTakeFirst();
  }
}

export class ReconciliationRunConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationRunConflictError";
  }
}

export class ReconciliationRepository {
  constructor(private readonly db: Transaction<Database>) {}

  /**
   * Opens a new attempt for a business day. The sequence number is computed in
   * the insert itself, so two workers racing produce one row and one unique
   * violation rather than two rows with the same number (ADR 0037).
   */
  async createRun(input: {
    readonly tenantId: string;
    readonly businessDate: string;
    readonly toleranceMinor: bigint;
    readonly feeToleranceMinor: bigint;
  }): Promise<ReconciliationRunRow> {
    return this.db
      .insertInto("reconciliationRuns")
      .values({
        tenantId: input.tenantId,
        businessDate: input.businessDate,
        runSeq: sql<number>`(
          select coalesce(max(run_seq), 0) + 1
          from reconciliation_runs
          where tenant_id = ${input.tenantId} and business_date = ${input.businessDate}
        )`,
        toleranceSnapshot: input.toleranceMinor,
        feeToleranceSnapshot: input.feeToleranceMinor,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async completeRun(
    tenantId: string,
    runId: string,
    input: {
      readonly checklist: readonly unknown[];
      readonly exceptionCount: number;
      readonly completedAt: Date;
    },
  ): Promise<ReconciliationRunRow | undefined> {
    return this.db
      .updateTable("reconciliationRuns")
      .set({
        status: "completed",
        checklist: jsonb(input.checklist),
        exceptionCount: input.exceptionCount,
        completedAt: input.completedAt,
      })
      .where("tenantId", "=", tenantId)
      .where("id", "=", runId)
      .where("status", "=", "running")
      .returningAll()
      .executeTakeFirst();
  }

  async failRun(
    tenantId: string,
    runId: string,
    input: { readonly reason: string; readonly completedAt: Date },
  ): Promise<ReconciliationRunRow | undefined> {
    return this.db
      .updateTable("reconciliationRuns")
      .set({
        status: "failed",
        failureReason: input.reason,
        completedAt: input.completedAt,
      })
      .where("tenantId", "=", tenantId)
      .where("id", "=", runId)
      .where("status", "=", "running")
      .returningAll()
      .executeTakeFirst();
  }

  async signOff(
    tenantId: string,
    runId: string,
    input: {
      readonly signedOffByUserId: string;
      readonly note: string;
      readonly signedOffAt: Date;
    },
  ): Promise<ReconciliationRunRow | undefined> {
    return this.db
      .updateTable("reconciliationRuns")
      .set({
        status: "signed_off",
        signedOffByUserId: input.signedOffByUserId,
        signedOffAt: input.signedOffAt,
        signOffNote: input.note,
      })
      .where("tenantId", "=", tenantId)
      .where("id", "=", runId)
      .where("status", "=", "completed")
      .returningAll()
      .executeTakeFirst();
  }

  async findById(tenantId: string, runId: string): Promise<ReconciliationRunRow | undefined> {
    return this.db
      .selectFrom("reconciliationRuns")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("id", "=", runId)
      .executeTakeFirst();
  }

  /** The newest attempt for a day, whatever its status. */
  async findLatest(
    tenantId: string,
    businessDate: string,
  ): Promise<ReconciliationRunRow | undefined> {
    return this.db
      .selectFrom("reconciliationRuns")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("businessDate", "=", businessDate)
      .orderBy("runSeq", "desc")
      .limit(1)
      .executeTakeFirst();
  }

  async findSignedOff(
    tenantId: string,
    businessDate: string,
  ): Promise<ReconciliationRunRow | undefined> {
    return this.db
      .selectFrom("reconciliationRuns")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("businessDate", "=", businessDate)
      .where("status", "=", "signed_off")
      .orderBy("runSeq", "desc")
      .limit(1)
      .executeTakeFirst();
  }

  async list(
    tenantId: string,
    filter: {
      readonly from?: string;
      readonly to?: string;
      readonly status?: "running" | "completed" | "failed" | "signed_off";
      readonly limit?: number;
    } = {},
  ): Promise<ReconciliationRunRow[]> {
    let query = this.db
      .selectFrom("reconciliationRuns")
      .selectAll()
      .where("tenantId", "=", tenantId);
    if (filter.from !== undefined) query = query.where("businessDate", ">=", filter.from);
    if (filter.to !== undefined) query = query.where("businessDate", "<=", filter.to);
    if (filter.status !== undefined) query = query.where("status", "=", filter.status);
    return query
      .orderBy("businessDate", "desc")
      .orderBy("runSeq", "desc")
      .limit(filter.limit ?? 100)
      .execute();
  }
}

export interface NewReconciliationException {
  readonly dedupeKey: string;
  readonly kind: string;
  readonly severity: "blocking" | "warning" | "info";
  readonly subjectType: string;
  readonly subjectId: string;
  readonly expectedMinor?: bigint | null;
  readonly actualMinor?: bigint | null;
  readonly differenceMinor?: bigint | null;
  readonly currency?: string | null;
  readonly detail?: Record<string, unknown>;
}

export class ReconciliationExceptionRepository {
  constructor(private readonly db: Transaction<Database>) {}

  /**
   * Records the exceptions a run found. An unresolved condition is *carried
   * forward*: the existing open row gains a new `last_seen_run_id` instead of
   * the day producing a duplicate (D43).
   */
  async upsertForRun(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly businessDate: string;
    readonly exceptions: readonly NewReconciliationException[];
  }): Promise<ReconciliationExceptionRow[]> {
    const rows: ReconciliationExceptionRow[] = [];
    for (const exception of input.exceptions) {
      const row = await this.db
        .insertInto("reconciliationExceptions")
        .values({
          tenantId: input.tenantId,
          runId: input.runId,
          dedupeKey: exception.dedupeKey,
          kind: exception.kind,
          severity: exception.severity,
          subjectType: exception.subjectType,
          subjectId: exception.subjectId,
          expectedMinor: exception.expectedMinor ?? null,
          actualMinor: exception.actualMinor ?? null,
          differenceMinor: exception.differenceMinor ?? null,
          currency: exception.currency ?? null,
          businessDate: input.businessDate,
          detail: jsonb(exception.detail ?? {}),
          firstSeenRunId: input.runId,
          lastSeenRunId: input.runId,
        })
        .onConflict((oc) =>
          oc
            .columns(["tenantId", "dedupeKey"])
            .where("status", "=", "open")
            .doUpdateSet((eb) => ({
              runId: input.runId,
              lastSeenRunId: input.runId,
              severity: exception.severity,
              expectedMinor: exception.expectedMinor ?? null,
              actualMinor: exception.actualMinor ?? null,
              differenceMinor: exception.differenceMinor ?? null,
              detail: jsonb(exception.detail ?? {}),
              updatedAt: new Date(),
              kind: eb.ref("excluded.kind"),
            })),
        )
        .returningAll()
        .executeTakeFirst();
      if (row !== undefined) rows.push(row);
    }
    return rows;
  }

  async list(
    tenantId: string,
    filter: {
      readonly status?: "open" | "resolved" | "waived";
      readonly severity?: "blocking" | "warning" | "info";
      readonly runId?: string;
      readonly limit?: number;
    } = {},
  ): Promise<ReconciliationExceptionRow[]> {
    let query = this.db
      .selectFrom("reconciliationExceptions")
      .selectAll()
      .where("tenantId", "=", tenantId);
    if (filter.status !== undefined) query = query.where("status", "=", filter.status);
    if (filter.severity !== undefined) query = query.where("severity", "=", filter.severity);
    if (filter.runId !== undefined) query = query.where("runId", "=", filter.runId);
    return query
      .orderBy("businessDate", "desc")
      .orderBy("createdAt", "desc")
      .limit(filter.limit ?? 200)
      .execute();
  }

  async findById(tenantId: string, id: string): Promise<ReconciliationExceptionRow | undefined> {
    return this.db
      .selectFrom("reconciliationExceptions")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirst();
  }

  async resolve(
    tenantId: string,
    id: string,
    input: {
      readonly status: "resolved" | "waived";
      readonly note: string;
      readonly resolvedByUserId: string;
      readonly resolvedAt: Date;
    },
  ): Promise<ReconciliationExceptionRow | undefined> {
    return this.db
      .updateTable("reconciliationExceptions")
      .set({
        status: input.status,
        resolutionNote: input.note,
        resolvedByUserId: input.resolvedByUserId,
        resolvedAt: input.resolvedAt,
        updatedAt: input.resolvedAt,
      })
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .where("status", "=", "open")
      .returningAll()
      .executeTakeFirst();
  }
}

export interface NewAnomalyEvent {
  readonly ruleKey: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly observed: string;
  readonly baseline: string;
  readonly threshold: string;
  readonly severity: "warning" | "info";
  readonly detail?: Record<string, unknown>;
}

export class AnomalyEventRepository {
  constructor(private readonly db: Transaction<Database>) {}

  /**
   * Records an anomaly, deduplicated on `(rule, subject, window)`. Returns
   * `created: false` when the window was already evaluated, so a re-run is not
   * a new alert (ADR 0039).
   */
  async record(
    tenantId: string,
    event: NewAnomalyEvent,
  ): Promise<{ readonly event: AnomalyEventRow; readonly created: boolean }> {
    const inserted = await this.db
      .insertInto("anomalyEvents")
      .values({
        tenantId,
        ruleKey: event.ruleKey,
        subjectType: event.subjectType,
        subjectId: event.subjectId,
        windowStart: event.windowStart,
        windowEnd: event.windowEnd,
        observed: event.observed,
        baseline: event.baseline,
        threshold: event.threshold,
        severity: event.severity,
        detail: jsonb(event.detail ?? {}),
      })
      .onConflict((oc) =>
        oc.columns(["tenantId", "ruleKey", "subjectType", "subjectId", "windowEnd"]).doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
    if (inserted !== undefined) return { event: inserted, created: true };

    const existing = await this.db
      .selectFrom("anomalyEvents")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("ruleKey", "=", event.ruleKey)
      .where("subjectType", "=", event.subjectType)
      .where("subjectId", "=", event.subjectId)
      .where("windowEnd", "=", event.windowEnd)
      .executeTakeFirstOrThrow();
    return { event: existing, created: false };
  }

  async list(
    tenantId: string,
    filter: {
      readonly status?: "open" | "acknowledged";
      readonly ruleKey?: string;
      readonly limit?: number;
    } = {},
  ): Promise<AnomalyEventRow[]> {
    let query = this.db.selectFrom("anomalyEvents").selectAll().where("tenantId", "=", tenantId);
    if (filter.status !== undefined) query = query.where("status", "=", filter.status);
    if (filter.ruleKey !== undefined) query = query.where("ruleKey", "=", filter.ruleKey);
    return query
      .orderBy("createdAt", "desc")
      .limit(filter.limit ?? 100)
      .execute();
  }

  async acknowledge(
    tenantId: string,
    id: string,
    input: { readonly acknowledgedByUserId: string; readonly acknowledgedAt: Date },
  ): Promise<AnomalyEventRow | undefined> {
    return this.db
      .updateTable("anomalyEvents")
      .set({
        status: "acknowledged",
        acknowledgedByUserId: input.acknowledgedByUserId,
        acknowledgedAt: input.acknowledgedAt,
      })
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .where("status", "=", "open")
      .returningAll()
      .executeTakeFirst();
  }
}
