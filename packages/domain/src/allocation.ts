import type { BusinessDate } from "./business-date.js";
import { compareObligationsForAllocation, stepPeriod, stepPeriodBackwards } from "./obligation.js";
import type { AllocationOrder, ObligationFrequency, ObligationModel } from "./obligation.js";

/** A period the allocation engine may pay. */
export interface AllocatablePeriod {
  readonly id: string;
  readonly periodStartDate: string;
  readonly priority: number;
  readonly createdAt: string;
  readonly amountMinor: bigint;
  readonly amountPaidMinor: bigint;
}

export interface Allocation {
  readonly periodId: string;
  readonly amountMinor: bigint;
  /** True when this allocation settles the period in full. */
  readonly fullyPaid: boolean;
}

export interface AllocationPlan {
  readonly allocations: readonly Allocation[];
  /** Wallet credit left once the plan is applied. */
  readonly remainingMinor: bigint;
  /** Total allocated by this plan. */
  readonly appliedMinor: bigint;
}

export interface AllocationInput {
  readonly model: ObligationModel;
  readonly order: AllocationOrder;
  readonly prepaidAllowed: boolean;
  /** Wallet credit available to allocate, in minor units. */
  readonly walletBalanceMinor: bigint;
  /** The business date the payment is for. */
  readonly businessDate: BusinessDate;
  readonly periods: readonly AllocatablePeriod[];
}

function periodDue(period: AllocatablePeriod): bigint {
  return period.amountMinor - period.amountPaidMinor;
}

/**
 * Orders candidate periods for allocation.
 *
 * `oldest_first` drains the earliest period first. `today_first` settles the
 * current business day before moving to earlier periods. The order is total,
 * so the same inputs always produce the same plan.
 */
export function orderPeriods(
  periods: readonly AllocatablePeriod[],
  order: AllocationOrder,
  businessDate: BusinessDate,
): AllocatablePeriod[] {
  const byAge = [...periods].sort((a, b) =>
    compareObligationsForAllocation(
      {
        periodStartDate: a.periodStartDate,
        priority: a.priority,
        createdAt: a.createdAt,
        id: a.id,
      },
      {
        periodStartDate: b.periodStartDate,
        priority: b.priority,
        createdAt: b.createdAt,
        id: b.id,
      },
    ),
  );
  if (order === "oldest_first") return byAge;

  const today = byAge.filter((period) => period.periodStartDate === businessDate);
  const rest = byAge.filter((period) => period.periodStartDate !== businessDate);
  return [...today, ...rest];
}

/**
 * Plans how wallet credit is applied to obligation periods.
 *
 * The engine never creates periods and never touches the database: it decides
 * which periods a payment settles and how much each one receives. Under
 * `pay_per_use` only the current business day can be settled - an idle day is
 * never a debt and a payment never settles a different day. Under `scheduled`
 * every outstanding period is a candidate, oldest first (or today first).
 *
 * A period is never overpaid: an allocation is at most the amount still due.
 */
export function planAllocation(input: AllocationInput): AllocationPlan {
  const allocations: Allocation[] = [];
  let remaining = input.walletBalanceMinor;
  if (remaining <= 0n) {
    return { allocations, remainingMinor: remaining < 0n ? 0n : remaining, appliedMinor: 0n };
  }

  const candidates = input.periods.filter((period) => {
    if (periodDue(period) <= 0n) return false;
    if (input.model === "pay_per_use") {
      // Only the day being paid. No arrears, and prepay off by default.
      return period.periodStartDate === input.businessDate;
    }
    if (period.periodStartDate > input.businessDate && !input.prepaidAllowed) {
      // Future periods are only settled when the tenant allows prepay.
      return false;
    }
    return true;
  });

  const ordered = orderPeriods(candidates, input.order, input.businessDate);
  let applied = 0n;

  // `pay_per_use` settles a period only in full (decisions-needed D9): a
  // shortfall stays as wallet credit and the day stays unpaid, so it must not
  // be recognised as revenue for a period that is still outstanding.
  const partialAllowed = input.model === "scheduled";

  for (const period of ordered) {
    if (remaining <= 0n) break;
    const due = periodDue(period);
    if (due <= 0n) continue;
    if (!partialAllowed && remaining < due) continue;
    const pay = remaining >= due ? due : remaining;
    if (pay <= 0n) continue;
    allocations.push({ periodId: period.id, amountMinor: pay, fullyPaid: pay >= due });
    remaining -= pay;
    applied += pay;
  }

  return { allocations, remainingMinor: remaining, appliedMinor: applied };
}

export interface PlannedPeriod {
  readonly periodKey: string;
  readonly businessDate: BusinessDate;
  readonly amountMinor: number;
  readonly ruleId: string;
}

export interface PeriodPlanInput {
  readonly model: ObligationModel;
  readonly frequency: ObligationFrequency;
  readonly businessDate: BusinessDate;
  /** How many earlier periods to materialise (the arrears window). */
  readonly arrearsWindowPeriods: number;
  /** How many later periods to materialise (the prepay window). */
  readonly prepayWindowPeriods: number;
  /** Prices a period. Throws when no rule covers the date. */
  readonly feeFor: (date: BusinessDate) => {
    readonly amountMinor: number;
    readonly ruleId: string;
  };
}

/**
 * The business dates a scheduled tenant materialises periods for: the current
 * period plus the configured arrears and prepay windows.
 */
export function planPeriodDates(input: {
  readonly model: ObligationModel;
  readonly frequency: ObligationFrequency;
  readonly businessDate: BusinessDate;
  readonly arrearsWindowPeriods: number;
  readonly prepayWindowPeriods: number;
}): BusinessDate[] {
  if (input.model === "pay_per_use") return [];

  const dates: BusinessDate[] = [input.businessDate];
  let backwards = input.businessDate;
  for (let i = 0; i < input.arrearsWindowPeriods; i += 1) {
    backwards = stepPeriodBackwards(backwards, input.frequency);
    dates.unshift(backwards);
  }
  let forwards = input.businessDate;
  for (let i = 0; i < input.prepayWindowPeriods; i += 1) {
    forwards = stepPeriod(forwards, input.frequency);
    dates.push(forwards);
  }
  return dates;
}

/**
 * Plans which obligation periods should exist for an asset.
 *
 * Under `pay_per_use` nothing is pre-generated: a day that is never paid has
 * no row, so there is no record that could later read as a debt. Under
 * `scheduled` the period is part of the schedule, so rows are materialised for
 * the current period and for the configured arrears and prepay windows.
 */
export function planPeriods(input: PeriodPlanInput): PlannedPeriod[] {
  return planPeriodDates(input).map((date) => {
    const fee = input.feeFor(date);
    return {
      periodKey: date,
      businessDate: date,
      amountMinor: fee.amountMinor,
      ruleId: fee.ruleId,
    };
  });
}
