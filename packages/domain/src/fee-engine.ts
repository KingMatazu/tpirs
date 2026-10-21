import { compareBusinessDates } from "./business-date.js";
import type { BusinessDate } from "./business-date.js";
import type { Money } from "./money.js";
import { money } from "./money.js";

export interface FeeRule {
  readonly key: string;
  readonly assetTypeKey: string;
  readonly amountMinor: number;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
}

export interface FeeComputationInput {
  readonly rules: readonly FeeRule[];
  readonly assetTypeKey: string;
  readonly businessDate: BusinessDate | string;
  readonly currency: string;
}

export interface FeeComputationResult {
  readonly amount: Money;
  readonly ruleKey: string;
  readonly feeAmountSnapshotMinor: number;
}

export class FeeRuleNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeeRuleNotFoundError";
  }
}

function toComparableDate(d: BusinessDate | string): BusinessDate {
  // Assume already validated/normalized format YYYY-MM-DD
  return d as BusinessDate;
}

export function resolveFeeRule(
  rules: readonly FeeRule[],
  assetTypeKey: string,
  businessDate: BusinessDate | string,
): FeeRule | undefined {
  const date = toComparableDate(businessDate);
  const candidates = rules
    .filter((r) => r.assetTypeKey === assetTypeKey)
    .filter((r) => {
      const fromOk = r.effectiveFrom <= date;
      if (!fromOk) return false;
      if (r.effectiveTo) {
        return date <= r.effectiveTo;
      }
      return true;
    })
    .sort((a, b) => {
      if (a.effectiveFrom < b.effectiveFrom) return 1; // latest first
      if (a.effectiveFrom > b.effectiveFrom) return -1;
      return 0;
    });
  return candidates[0];
}

export function computeFee(input: FeeComputationInput): FeeComputationResult {
  const rule = resolveFeeRule(input.rules, input.assetTypeKey, input.businessDate);
  if (!rule) {
    throw new FeeRuleNotFoundError(
      `No fee rule found for asset type ${input.assetTypeKey} on ${input.businessDate}`,
    );
  }
  const amount = money(input.currency, rule.amountMinor);
  return {
    amount,
    ruleKey: rule.key,
    feeAmountSnapshotMinor: rule.amountMinor,
  };
}
