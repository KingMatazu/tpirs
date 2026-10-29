import { DomainError } from "./errors.js";
import type { LedgerPosting } from "./ledger.js";
import { money } from "./money.js";
import type { Money } from "./money.js";

/**
 * Reconciliation domain rules (ADR 0037).
 *
 * A run compares what should be true about one tenant business day against
 * what is. This module holds the pure arithmetic both the service and the
 * database-backed checks share, so tolerance and severity have exactly one
 * implementation and every comparison is reproducible from the checklist the
 * run stores.
 *
 * Reconciliation compares; it never invents money. Nothing here mutates
 * state: even the fee split that will be posted is a value, and the posting
 * itself happens in the settlement service.
 */

/** The checks every run evaluates, in evaluation order. */
export type ReconciliationCheckKey =
  | "settlement_rows_matched"
  | "settlement_amounts"
  | "clearing_balance"
  | "ledger_balances"
  | "revenue_recognised"
  | "cash_float"
  | "cash_overdue"
  | "suspense_ageing"
  | "duplicate_references";

export const RECONCILIATION_CHECKS: readonly ReconciliationCheckKey[] = [
  "settlement_rows_matched",
  "settlement_amounts",
  "clearing_balance",
  "ledger_balances",
  "revenue_recognised",
  "cash_float",
  "cash_overdue",
  "suspense_ageing",
  "duplicate_references",
];

export type ReconciliationSeverity = "blocking" | "warning" | "info";

/**
 * Severity of a difference found by each check. Warnings never block sign-off
 * (`cash_overdue`, `suspense_ageing`); every money or evidence mismatch does.
 */
const CHECK_SEVERITY: Readonly<Record<ReconciliationCheckKey, ReconciliationSeverity>> = {
  settlement_rows_matched: "blocking",
  settlement_amounts: "blocking",
  clearing_balance: "blocking",
  ledger_balances: "blocking",
  revenue_recognised: "blocking",
  cash_float: "blocking",
  cash_overdue: "warning",
  suspense_ageing: "warning",
  duplicate_references: "blocking",
};

export function checkSeverity(check: ReconciliationCheckKey): ReconciliationSeverity {
  return CHECK_SEVERITY[check];
}

export type ReconciliationErrorCode =
  | "invalid_tolerance"
  | "invalid_amount"
  | "over_settlement"
  | "fee_beyond_tolerance"
  | "currency_mismatch"
  | "unknown_check";

export class ReconciliationError extends DomainError {
  readonly code: ReconciliationErrorCode;

  constructor(code: ReconciliationErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Whether a difference is tolerable. The boundary is inclusive: a difference
 * of exactly `toleranceMinor` passes, one more unit does not. Negative
 * differences are measured by magnitude; "less than expected" and "more than
 * expected" both consume the same tolerance.
 */
export function isWithinTolerance(differenceMinor: bigint, toleranceMinor: bigint): boolean {
  if (toleranceMinor < 0n) {
    throw new ReconciliationError("invalid_tolerance", `Tolerance ${toleranceMinor} is negative`);
  }
  const magnitude = differenceMinor < 0n ? -differenceMinor : differenceMinor;
  return magnitude <= toleranceMinor;
}

/** How an actual amount relates to the expected one. */
export type DifferenceClassification = "matched" | "over" | "short";

/**
 * Classifies an actual amount against expectation. The sign convention below
 * is "actual minus expected": a short payment is `short`, an over-credit is
 * `over`, and both surface as exceptions; only `matched` (within tolerance)
 * is silence.
 */
export function classifyDifference(
  expectedMinor: bigint,
  actualMinor: bigint,
): DifferenceClassification {
  if (actualMinor === expectedMinor) return "matched";
  return actualMinor > expectedMinor ? "over" : "short";
}

/**
 * A split the statement evidence cannot support. It is a reconciliation error
 * with a narrower meaning, so a caller can catch it separately instead of
 * matching on the message.
 */
export class FeeSplitError extends ReconciliationError {}

/** The arithmetic the fee-leg posting performs (ADR 0036). */
export interface FeeSplit {
  /** What the bank actually received, minor units. */
  readonly bankAmountMinor: bigint;
  /** `payment − bank`, minor units; never negative, never above the tolerance. */
  readonly feeAmountMinor: bigint;
  /** What the driver was charged, minor units — the clearing credit. */
  readonly paymentAmountMinor: bigint;
}

/**
 * Splits a settled payment into its bank and fee legs.
 *
 * Gateways settle net of fees, so the bank amount is what reached the bank and
 * the difference is the gateway's cut. The bank never receives more than was
 * charged: a larger bank amount (`payment − bank` below zero) is not a fee —
 * it is an over-settlement, which stays an exception instead of posting. The
 * split also refuses a difference above `feeToleranceMinor`, because silently
 * absorbing a big gap as "fees" would launder a mismatch into a cost.
 */
export function feeSplit(input: {
  readonly paymentMinor: bigint;
  readonly bankMinor: bigint;
  readonly feeToleranceMinor: bigint;
}): FeeSplit {
  const { paymentMinor, bankMinor, feeToleranceMinor } = input;
  if (paymentMinor < 0n || bankMinor < 0n) {
    throw new FeeSplitError("invalid_amount", "Payment and bank amounts must be non-negative");
  }
  if (feeToleranceMinor < 0n) {
    throw new FeeSplitError("invalid_tolerance", "Fee tolerance must be non-negative");
  }
  if (bankMinor > paymentMinor) {
    throw new FeeSplitError(
      "over_settlement",
      `Bank received ${bankMinor}, more than the ${paymentMinor} charged`,
    );
  }
  const fee = paymentMinor - bankMinor;
  if (!isWithinTolerance(fee, feeToleranceMinor)) {
    throw new FeeSplitError(
      "fee_beyond_tolerance",
      `Fee ${fee} exceeds tolerance ${feeToleranceMinor}`,
    );
  }
  return { bankAmountMinor: bankMinor, feeAmountMinor: fee, paymentAmountMinor: paymentMinor };
}

export const SETTLEMENT_BANK_ACCOUNT = "SETTLEMENT_BANK";
export const GATEWAY_FEES_ACCOUNT = "GATEWAY_FEES";
export const GATEWAY_CLEARING_ACCOUNT = "GATEWAY_CLEARING";

/**
 * Builds the posting that moves one settled payment out of clearing.
 *
 * Balanced by construction when `bank + fee = payment`; zero-amount legs are
 * omitted (a posting amount must be positive), so an all-fee settlement is
 * `Dr GATEWAY_FEES / Cr GATEWAY_CLEARING` and a fee-free one is
 * `Dr SETTLEMENT_BANK / Cr GATEWAY_CLEARING`. The caller posts this under an
 * idempotency key derived from the settlement row, so a replay can never post
 * the split twice.
 */
export function settlementFeePostings(input: {
  readonly paymentAmount: Money;
  readonly bankAmount: Money;
}): readonly LedgerPosting[] {
  const { paymentAmount, bankAmount } = input;
  if (paymentAmount.currency !== bankAmount.currency) {
    throw new ReconciliationError(
      "currency_mismatch",
      `Settlement currency ${bankAmount.currency} does not match payment ${paymentAmount.currency}`,
    );
  }
  if (bankAmount.amount > paymentAmount.amount) {
    throw new ReconciliationError(
      "over_settlement",
      `Bank received ${bankAmount.amount}, more than the ${paymentAmount.amount} charged`,
    );
  }
  const fee = money(bankAmount.currency, paymentAmount.amount - bankAmount.amount);
  const postings: LedgerPosting[] = [];
  if (bankAmount.amount > 0) {
    postings.push({ accountCode: SETTLEMENT_BANK_ACCOUNT, direction: "debit", amount: bankAmount });
  }
  if (fee.amount > 0) {
    postings.push({ accountCode: GATEWAY_FEES_ACCOUNT, direction: "debit", amount: fee });
  }
  postings.push({
    accountCode: GATEWAY_CLEARING_ACCOUNT,
    direction: "credit",
    amount: paymentAmount,
  });
  return postings;
}

/** One checklist line a run persists in `reconciliation_runs.checklist`. */
export interface ChecklistItem {
  readonly check: ReconciliationCheckKey;
  readonly severity: ReconciliationSeverity;
  /** What was measured (collector, payment, provider…); null for whole-day checks. */
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  /** Minor units, unless the check counts things — counts use null money fields. */
  readonly expectedMinor: bigint | null;
  readonly actualMinor: bigint | null;
  readonly expectedCount: number | null;
  readonly actualCount: number | null;
  /** `actual − expected`, whichever scale the check used. */
  readonly differenceMinor: bigint | null;
  readonly differenceCount: number | null;
  readonly withinTolerance: boolean | null;
}

export interface ChecklistMeasure {
  readonly expectedMinor?: bigint | null;
  readonly actualMinor?: bigint | null;
  readonly expectedCount?: number | null;
  readonly actualCount?: number | null;
  readonly toleranceMinor?: bigint | null;
}

/**
 * Builds one checklist line from a measurement.
 *
 * The difference is always `actual − expected`, and a measurement without a
 * tolerance (a warning count, a subject with no amount) records the difference
 * for evidence but leaves `withinTolerance` null instead of guessing.
 */
export function buildChecklistItem(
  check: ReconciliationCheckKey,
  subjectType: string | null,
  subjectId: string | null,
  measure: ChecklistMeasure,
): ChecklistItem {
  const expectedMinor = measure.expectedMinor ?? null;
  const actualMinor = measure.actualMinor ?? null;
  const expectedCount = measure.expectedCount ?? null;
  const actualCount = measure.actualCount ?? null;
  const tolerance = measure.toleranceMinor ?? null;

  const differenceMinor =
    expectedMinor !== null && actualMinor !== null ? actualMinor - expectedMinor : null;
  const differenceCount =
    expectedCount !== null && actualCount !== null ? actualCount - expectedCount : null;
  const difference = differenceMinor ?? (differenceCount === null ? 0n : BigInt(differenceCount));

  return {
    check,
    severity: checkSeverity(check),
    subjectType,
    subjectId,
    expectedMinor,
    actualMinor,
    expectedCount,
    actualCount,
    differenceMinor,
    differenceCount,
    withinTolerance: tolerance === null ? null : isWithinTolerance(difference, tolerance),
  };
}

/**
 * The stable identity an exception is carried forward on (D43): the check plus
 * its subject. Two runs finding the same condition upsert one open row rather
 * than duplicating it per day.
 */
export function exceptionDedupeKey(
  check: ReconciliationCheckKey,
  subjectType: string,
  subjectId: string,
): string {
  return `${check}:${subjectType}:${subjectId}`;
}

/** Checklist lines ordered the way the run evaluates checks. */
export function assembleChecklist(items: readonly ChecklistItem[]): readonly ChecklistItem[] {
  const order = new Map(RECONCILIATION_CHECKS.map((check, index) => [check, index]));
  return [...items].sort((a, b) => {
    const byCheck = (order.get(a.check) ?? 0) - (order.get(b.check) ?? 0);
    if (byCheck !== 0) return byCheck;
    if (a.subjectId === null || b.subjectId === null) return 0;
    return a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0;
  });
}

/**
 * Checklist lines that would block sign-off: a blocking check measured outside
 * its tolerance. The authoritative sign-off gate is the open exception queue;
 * this exists so the persisted checklist and the queue cannot disagree.
 */
export function blockingChecklistFailures(
  items: readonly ChecklistItem[],
): readonly ChecklistItem[] {
  return items.filter((item) => item.severity === "blocking" && item.withinTolerance === false);
}
