import type { BusinessDate } from "./business-date.js";

export type ObligationModel = "pay_per_use" | "scheduled";
export type ArrearsPolicy = "none" | "accrue";

export interface ObligationAllocationKey {
  readonly periodStartDate: string;
  readonly priority: number;
  readonly createdAt: string;
  readonly id: string;
}

export interface ObligationAllocationContext {
  readonly model: ObligationModel;
  readonly arrearsPolicy: ArrearsPolicy;
  readonly prepaidAllowed: boolean;
}

export function obligationPeriodKey(businessDate: BusinessDate): string {
  return businessDate;
}

export function compareObligationsForAllocation(
  a: ObligationAllocationKey,
  b: ObligationAllocationKey,
): number {
  if (a.periodStartDate < b.periodStartDate) return -1;
  if (a.periodStartDate > b.periodStartDate) return 1;
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export function isPayPerUseEligible(model: ObligationModel): boolean {
  return model === "pay_per_use";
}

export function canAccrueArrears(policy: ArrearsPolicy): boolean {
  return policy === "accrue";
}

export function shouldCreateObligationForPayPerUse(hasPayment: boolean): boolean {
  // Under pay_per_use, obligation rows are created only when payment occurs (or as needed)
  return hasPayment;
}

export function allowsPrepay(prepaidAllowed: boolean, prepayFlagEnabled: boolean): boolean {
  return prepaidAllowed && prepayFlagEnabled;
}
