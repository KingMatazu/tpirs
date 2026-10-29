import { money } from "@tpirs/domain";
import type { BusinessDate, ChecklistItem, LedgerPosting } from "@tpirs/domain";
import {
  assembleChecklist,
  buildChecklistItem,
  businessDayRange,
  exceptionDedupeKey,
} from "@tpirs/domain";
import type { Principal } from "@tpirs/domain";
import type {
  AnomalyEventRow,
  ReconciliationExceptionRow,
  ReconciliationRunRow,
  SettlementRowRow,
} from "@tpirs/db";
import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb, Transaction, Database } from "@tpirs/db";
import type { ReconActor } from "./recon-actor.js";
import { reconActorUserId, requireReconPermission } from "./recon-actor.js";

/**
 * The reconciliation run (ADR 0037).
 *
 * A run is one attempt at one tenant business day. It is append-only: a
 * completed run is immutable, sign-off is its only transition, and re-running
 * a day inserts a new `run_seq` (D41) — a late payment produces evidence, not
 * an edit. Open exceptions are carried forward by `dedupe_key` (D43).
 */

export interface ReconciliationTolerances {
  /** Whole-day tolerance for ledger, clearing and float differences. */
  readonly toleranceMinor: bigint;
  /** How much of a payment the gateway may keep (D45, ADR 0036). */
  readonly feeToleranceMinor: bigint;
  /** From tenant cashRules; drives the `cash_overdue` check. */
  readonly depositDeadlineHours: number;
  /** From reconciliation config; drives the `suspense_ageing` check. */
  readonly suspenseAgeingDays: number;
}

export class ReconciliationRunError extends Error {
  readonly code:
    | "run_not_found"
    | "run_not_completed"
    | "run_already_signed_off"
    | "blocking_exceptions"
    | "note_required";

  constructor(code: ReconciliationRunError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "ReconciliationRunError";
  }
}

export interface ReconciliationRunInput {
  readonly tenantId: string;
  readonly businessDate: BusinessDate;
  readonly timeZone: string;
  readonly tolerances: ReconciliationTolerances;
  readonly actor: ReconActor;
}

export class ReconciliationService {
  constructor(private readonly deps: { readonly db: AnyDb; readonly now?: () => Date }) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async run(input: ReconciliationRunInput): Promise<ReconciliationRunRow> {
    requireReconPermission(input.actor, input.tenantId, "reconciliation:run");
    // The run row is created and committed first: a failed computation must
    // leave evidence (a `failed` attempt), and a rolled-back transaction could
    // never record it (ADR 0037).
    const run = await withTenant(this.deps.db, input.tenantId, async (tx) =>
      repositories(tx).reconciliation.createRun({
        tenantId: input.tenantId,
        businessDate: input.businessDate,
        toleranceMinor: input.tolerances.toleranceMinor,
        feeToleranceMinor: input.tolerances.feeToleranceMinor,
      }),
    );
    try {
      return await withTenant(this.deps.db, input.tenantId, async (tx) => {
        const repos = repositories(tx);
        const { items, exceptions } = await computeChecks(tx, {
          tenantId: input.tenantId,
          timeZone: input.timeZone,
          businessDate: input.businessDate,
          tolerances: input.tolerances,
          now: this.now(),
        });
        const recorded = await repos.exceptions.upsertForRun({
          tenantId: input.tenantId,
          runId: run.id,
          businessDate: input.businessDate,
          exceptions,
        });
        await repos.reconciliation.completeRun(input.tenantId, run.id, {
          checklist: serializeChecklist(assembleChecklist(items)),
          exceptionCount: recorded.length,
          completedAt: this.now(),
        });
        await repos.audit.record({
          tenantId: input.tenantId,
          actorUserId: reconActorUserId(input.actor),
          action: "reconciliation.run.completed",
          entityType: "reconciliation_run",
          entityId: run.id,
          after: { runSeq: run.runSeq, exceptions: recorded.length },
        });
        const completed = await repos.reconciliation.findById(input.tenantId, run.id);
        if (completed === undefined) {
          throw new ReconciliationRunError("run_not_found", "run disappeared after completion");
        }
        return completed;
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        await withTenant(this.deps.db, input.tenantId, async (tx) => {
          const repos = repositories(tx);
          await repos.reconciliation.failRun(input.tenantId, run.id, {
            reason,
            completedAt: this.now(),
          });
          await repos.audit.record({
            tenantId: input.tenantId,
            actorUserId: reconActorUserId(input.actor),
            action: "reconciliation.run.failed",
            entityType: "reconciliation_run",
            entityId: run.id,
            after: { reason },
          });
        });
      } catch {
        // Recording the failure is best-effort; never mask the cause.
      }
      throw error;
    }
  }

  /**
   * Signs off a completed run. Finance needs a note, and no open blocking
   * exception for the day may remain (D41).
   */
  async signOff(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly actor: Principal;
    readonly note: string;
  }): Promise<ReconciliationRunRow> {
    requireReconPermission(input.actor, input.tenantId, "reconciliation:run");
    const note = input.note.trim();
    if (note === "")
      throw new ReconciliationRunError("note_required", "a sign-off note is required");
    return withTenant(this.deps.db, input.tenantId, async (tx) => {
      const repos = repositories(tx);
      const run = await repos.reconciliation.findById(input.tenantId, input.runId);
      if (run === undefined) throw new ReconciliationRunError("run_not_found", "run not found");
      if (run.status === "signed_off") {
        throw new ReconciliationRunError("run_already_signed_off", "run is already signed off");
      }
      if (run.status !== "completed") {
        throw new ReconciliationRunError("run_not_completed", "run is not completed");
      }
      const open = await repos.exceptions.list(input.tenantId, { status: "open", limit: 200 });
      if (
        open.some(
          (item) =>
            item.businessDate === run.businessDate &&
            item.severity === "blocking" &&
            item.status === "open",
        )
      ) {
        throw new ReconciliationRunError(
          "blocking_exceptions",
          "open blocking exceptions must be resolved before sign-off",
        );
      }
      const signedOff = await repos.reconciliation.signOff(input.tenantId, input.runId, {
        signedOffByUserId: input.actor.userId,
        note,
        signedOffAt: this.now(),
      });
      if (signedOff === undefined) {
        throw new ReconciliationRunError("run_not_completed", "sign-off did not apply");
      }
      await repos.audit.record({
        tenantId: input.tenantId,
        actorUserId: input.actor.userId,
        action: "reconciliation.run.signed_off",
        entityType: "reconciliation_run",
        entityId: input.runId,
        after: { note },
      });
      return signedOff;
    });
  }

  async list(
    tenantId: string,
    filter: { readonly from?: string; readonly to?: string } = {},
  ): Promise<ReconciliationRunRow[]> {
    return withTenant(this.deps.db, tenantId, async (tx) =>
      repositories(tx).reconciliation.list(tenantId, {
        ...(filter.from !== undefined ? { from: filter.from } : {}),
        ...(filter.to !== undefined ? { to: filter.to } : {}),
      }),
    );
  }

  async exceptions(
    tenantId: string,
    filter: { readonly status?: "open" | "resolved" | "waived" } = {},
  ): Promise<ReconciliationExceptionRow[]> {
    return withTenant(this.deps.db, tenantId, async (tx) =>
      repositories(tx).exceptions.list(tenantId, {
        ...(filter.status !== undefined ? { status: filter.status } : {}),
        limit: 500,
      }),
    );
  }

  async anomalyEvents(
    tenantId: string,
    filter: { readonly status?: "open" | "acknowledged" } = {},
  ): Promise<AnomalyEventRow[]> {
    return withTenant(this.deps.db, tenantId, async (tx) =>
      repositories(tx).anomalies.list(tenantId, {
        ...(filter.status !== undefined ? { status: filter.status } : {}),
        limit: 500,
      }),
    );
  }

  /** Acknowledges an anomaly; requires `reconciliation:run`, audited (D46). */
  async acknowledgeAnomaly(input: {
    readonly tenantId: string;
    readonly actor: Principal;
    readonly anomalyId: string;
  }): Promise<AnomalyEventRow> {
    requireReconPermission(input.actor, input.tenantId, "reconciliation:run");
    return withTenant(this.deps.db, input.tenantId, async (tx) => {
      const repos = repositories(tx);
      const acknowledged = await repos.anomalies.acknowledge(input.tenantId, input.anomalyId, {
        acknowledgedByUserId: input.actor.userId,
        acknowledgedAt: this.now(),
      });
      if (acknowledged === undefined) {
        throw new ReconciliationRunError(
          "run_not_found",
          "anomaly not found or already acknowledged",
        );
      }
      await repos.audit.record({
        tenantId: input.tenantId,
        actorUserId: input.actor.userId,
        action: "anomaly.acknowledged",
        entityType: "anomaly_event",
        entityId: input.anomalyId,
      });
      return acknowledged;
    });
  }
}

export interface ReconciliationRunException {
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

interface ComputeInput {
  readonly tenantId: string;
  readonly timeZone: string;
  readonly businessDate: BusinessDate;
  readonly tolerances: ReconciliationTolerances;
  readonly now: Date;
}

/**
 * Evaluates every check of the run and returns the checklist items plus the
 * exceptions each failing subject raises.
 *
 * Full-day instant bounds come from the tenant timezone (`businessDayRange`),
 * so settlement rows, ledger postings and other timestamped evidence land in
 * the right day. Checks execute in the run's transaction and only read.
 */
export async function computeChecks(
  tx: Transaction<Database>,
  input: ComputeInput,
): Promise<{ items: ChecklistItem[]; exceptions: ReconciliationRunException[] }> {
  const { tenantId, businessDate, tolerances, timeZone, now } = input;
  const day = businessDayRange(timeZone, businessDate);
  const repos = repositories(tx);
  const checks = repos.checks;

  const items: ChecklistItem[] = [];
  const exceptions: ReconciliationRunException[] = [];

  const addException = (exception: ReconciliationRunException): void => {
    exceptions.push(exception);
  };

  // 1. Every statement row of the day is settled ----------------------------------------
  const unsettled = await checks.unsettledSettlementRows(tenantId, day.start, day.endExclusive);
  for (const row of unsettled) {
    items.push(
      buildChecklistItem("settlement_rows_matched", "settlement_row", row.id, {
        expectedCount: 1,
        actualCount: 0,
        toleranceMinor: 0n,
      }),
    );
    addException({
      dedupeKey: exceptionDedupeKey("settlement_rows_matched", "settlement_row", row.id),
      kind: "settlement_rows_matched",
      severity: row.amountMinor > 0n ? "blocking" : "info",
      subjectType: "settlement_row",
      subjectId: row.id,
      expectedMinor: 0n,
      actualMinor: row.amountMinor,
      differenceMinor: row.amountMinor,
      currency: row.currency,
      detail: {
        providerReference: row.providerReference,
        rowStatus: row.status,
        settledAt: row.settledAt.toISOString(),
      },
    });
  }

  // 2. Posted rows carried exactly what the statement and payment said ------------------
  const postedRows = (
    await repos.settlements.list(tenantId, { status: "posted", limit: 1000 })
  ).filter((row) => row.settledAt >= day.start && row.settledAt < day.endExclusive);
  const postings = await checks.settlementPostings(
    tenantId,
    postedRows.map((row) => row.id),
  );
  for (const row of postedRows) {
    const bankPosting = postings.get(row.id);
    if (bankPosting === undefined || row.paymentId === null) continue;
    const payment = await repos.payments.findById(tenantId, row.paymentId);
    if (payment === undefined) continue;
    const expectedBankMinor = payment.amountMinor - row.feeMinor;
    const item = buildChecklistItem("settlement_amounts", "settlement_row", row.id, {
      expectedMinor: expectedBankMinor,
      actualMinor: bankPosting.bankMinor,
      toleranceMinor: tolerances.feeToleranceMinor,
    });
    items.push(item);
    if (item.withinTolerance === false) {
      addException({
        dedupeKey: exceptionDedupeKey("settlement_amounts", "settlement_row", row.id),
        kind: "settlement_amounts",
        severity: "blocking",
        subjectType: "settlement_row",
        subjectId: row.id,
        expectedMinor: expectedBankMinor,
        actualMinor: bankPosting.bankMinor,
        differenceMinor: item.differenceMinor,
        currency: row.currency,
        detail: {
          providerReference: row.providerReference,
          statementBankMinor: (row.amountMinor - row.feeMinor).toString(),
          paymentAmountMinor: payment.amountMinor.toString(),
        },
      });
    }
  }

  // 3. Clearing drained to zero (within tolerance) --------------------------------------
  const clearingBalance = await repos.ledger.accountBalance(tenantId, "GATEWAY_CLEARING");
  const clearingItem = buildChecklistItem("clearing_balance", null, null, {
    expectedMinor: 0n,
    actualMinor: clearingBalance,
    toleranceMinor: tolerances.toleranceMinor,
  });
  items.push(clearingItem);
  if (clearingItem.withinTolerance === false) {
    addException({
      dedupeKey: exceptionDedupeKey("clearing_balance", "tenant", businessDate),
      kind: "clearing_balance",
      severity: "blocking",
      subjectType: "tenant",
      subjectId: businessDate,
      expectedMinor: 0n,
      actualMinor: clearingBalance,
      differenceMinor: clearingBalance,
    });
  }

  // 4. The day's ledger balances ----------------------------------------------------------
  const dayTotals = await checks.dayLedgerTotals(tenantId, day.start, day.endExclusive);
  const ledgerItem = buildChecklistItem("ledger_balances", null, null, {
    expectedMinor: dayTotals.debitMinor,
    actualMinor: dayTotals.creditMinor,
    toleranceMinor: tolerances.toleranceMinor,
  });
  items.push(ledgerItem);
  if (ledgerItem.withinTolerance === false) {
    addException({
      dedupeKey: exceptionDedupeKey("ledger_balances", "tenant", businessDate),
      kind: "ledger_balances",
      severity: "blocking",
      subjectType: "tenant",
      subjectId: businessDate,
      expectedMinor: dayTotals.debitMinor,
      actualMinor: dayTotals.creditMinor,
      differenceMinor: dayTotals.creditMinor - dayTotals.debitMinor,
    });
  }

  // 5. Revenue recognised equals the day's paid obligations ------------------------------
  const paidObligations = await checks.paidObligationTotalsForDate(tenantId, businessDate);
  const revenue = await checks.dayRevenueTotals(tenantId, businessDate);
  const revenueItem = buildChecklistItem("revenue_recognised", null, null, {
    expectedMinor: paidObligations.amountMinor,
    actualMinor: revenue.creditMinor,
    toleranceMinor: tolerances.toleranceMinor,
  });
  items.push(revenueItem);
  if (revenueItem.withinTolerance === false) {
    addException({
      dedupeKey: exceptionDedupeKey("revenue_recognised", "tenant", businessDate),
      kind: "revenue_recognised",
      severity: "blocking",
      subjectType: "tenant",
      subjectId: businessDate,
      expectedMinor: paidObligations.amountMinor,
      actualMinor: revenue.creditMinor,
      differenceMinor: revenue.creditMinor - paidObligations.amountMinor,
      detail: {
        paidPeriods: paidObligations.count,
        revenueDebitsMinor: revenue.debitMinor.toString(),
      },
    });
  }

  // 6. Each collector's float closes (intakes − deposits = derived balance) --------------
  const [intakeTotals, depositTotals, cashBalances] = await Promise.all([
    checks.collectorIntakeTotals(tenantId),
    checks.collectorPostedDepositTotals(tenantId),
    checks.collectorCashBalances(tenantId),
  ]);
  const collectors = new Set<string>([
    ...intakeTotals.keys(),
    ...depositTotals.keys(),
    ...cashBalances.keys(),
  ]);
  for (const collectorId of collectors) {
    const expected = (intakeTotals.get(collectorId) ?? 0n) - (depositTotals.get(collectorId) ?? 0n);
    const actual = cashBalances.get(collectorId) ?? 0n;
    const item = buildChecklistItem("cash_float", "collector", collectorId, {
      expectedMinor: expected,
      actualMinor: actual,
      toleranceMinor: tolerances.toleranceMinor,
    });
    items.push(item);
    if (item.withinTolerance === false) {
      addException({
        dedupeKey: exceptionDedupeKey("cash_float", "collector", collectorId),
        kind: "cash_float",
        severity: "blocking",
        subjectType: "collector",
        subjectId: collectorId,
        expectedMinor: expected,
        actualMinor: actual,
        differenceMinor: item.differenceMinor,
      });
    }
  }

  // 7. Cash overdue (warning): reconciliation records, the sweeper acts ------------------
  const deadlineCutoff = new Date(now.getTime() - tolerances.depositDeadlineHours * 3_600_000);
  const overdue = await checks.collectorsWithOverdueIntakes(tenantId, deadlineCutoff);
  for (const [collectorId, count] of overdue) {
    items.push(
      buildChecklistItem("cash_overdue", "collector", collectorId, {
        expectedCount: 0,
        actualCount: count,
      }),
    );
    addException({
      dedupeKey: exceptionDedupeKey("cash_overdue", "collector", collectorId),
      kind: "cash_overdue",
      severity: "warning",
      subjectType: "collector",
      subjectId: collectorId,
      detail: { openOverdueIntakes: count, deadlineHours: tolerances.depositDeadlineHours },
    });
  }

  // 8. Suspense ageing (warning) -----------------------------------------------------------
  const suspenseCutoff = new Date(now.getTime() - tolerances.suspenseAgeingDays * 86_400_000);
  const agedPayments = await checks.agedSuspensePayments(tenantId, suspenseCutoff);
  for (const aged of agedPayments) {
    items.push(
      buildChecklistItem("suspense_ageing", "payment", aged.id, {
        expectedMinor: 0n,
        actualMinor: aged.amountMinor,
      }),
    );
    addException({
      dedupeKey: exceptionDedupeKey("suspense_ageing", "payment", aged.id),
      kind: "suspense_ageing",
      severity: "warning",
      subjectType: "payment",
      subjectId: aged.id,
      actualMinor: aged.amountMinor,
      differenceMinor: aged.amountMinor,
      detail: { semantics: "aged payment in suspense" },
    });
  }
  const agedDeposits = await checks.agedSuspenseDeposits(tenantId, suspenseCutoff);
  for (const aged of agedDeposits) {
    items.push(
      buildChecklistItem("suspense_ageing", "cash_deposit", aged.id, {
        expectedMinor: 0n,
        actualMinor: aged.amountMinor,
      }),
    );
    addException({
      dedupeKey: exceptionDedupeKey("suspense_ageing", "cash_deposit", aged.id),
      kind: "suspense_ageing",
      severity: "warning",
      subjectType: "cash_deposit",
      subjectId: aged.id,
      actualMinor: aged.amountMinor,
      differenceMinor: aged.amountMinor,
      detail: { semantics: "aged deposit in suspense" },
    });
  }

  // 9. One payment per provider reference -----------------------------------------------------
  const duplicates = await checks.duplicateProviderReferences(tenantId, businessDate, businessDate);
  for (const duplicate of duplicates) {
    items.push(
      buildChecklistItem(
        "duplicate_references",
        "provider_reference",
        duplicate.providerReference,
        { expectedCount: 1, actualCount: duplicate.count, toleranceMinor: 0n },
      ),
    );
    addException({
      dedupeKey: exceptionDedupeKey(
        "duplicate_references",
        "provider_reference",
        duplicate.providerReference,
      ),
      kind: "duplicate_references",
      severity: "blocking",
      subjectType: "provider_reference",
      subjectId: duplicate.providerReference,
      detail: { count: duplicate.count },
    });
  }

  return { items, exceptions };
}

/**
 * The checklist as it is persisted: `jsonb` cannot hold `bigint`, and money is
 * stored as exact minor-unit strings so nothing is rounded by JSON.
 */
function serializeChecklist(
  items: readonly ChecklistItem[],
): readonly Record<string, string | number | boolean | null>[] {
  return items.map((item) => ({
    check: item.check,
    severity: item.severity,
    subjectType: item.subjectType,
    subjectId: item.subjectId,
    expectedMinor: item.expectedMinor?.toString() ?? null,
    actualMinor: item.actualMinor?.toString() ?? null,
    expectedCount: item.expectedCount,
    actualCount: item.actualCount,
    differenceMinor: item.differenceMinor?.toString() ?? null,
    differenceCount: item.differenceCount,
    withinTolerance: item.withinTolerance,
  }));
}

/** Wraps domain postings in the shape the ledger service accepts. */
export function toPostingSpecs(postings: readonly LedgerPosting[]): {
  accountCode: string;
  direction: "debit" | "credit";
  amount: ReturnType<typeof money>;
  memo?: string | null;
}[] {
  return postings.map((posting) => ({
    accountCode: posting.accountCode,
    direction: posting.direction,
    amount: posting.amount,
    memo: posting.memo ?? null,
  }));
}

export type { SettlementRowRow };
