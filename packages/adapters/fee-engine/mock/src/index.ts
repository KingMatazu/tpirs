import { businessDate, compareBusinessDates, money } from "@tpirs/domain";
import { PortError } from "@tpirs/ports";
import type { FeeEngine, FeeQuote, FeeQuoteRequest } from "@tpirs/ports";
import { conformanceFixtures } from "@tpirs/contracts";

export interface MockFeeRule {
  readonly tenantId: string;
  readonly assetTypeId: string;
  readonly amount: number;
  readonly currency: string;
  /** YYYY-MM-DD */
  readonly effectiveFrom: string;
  readonly ruleId: string;
}

export interface MockFeeEngine extends FeeEngine {
  addRule(rule: MockFeeRule): void;
}

export const defaultMockFeeRules: readonly MockFeeRule[] = [
  {
    tenantId: "conformance-tenant",
    assetTypeId: conformanceFixtures.assetTypeKey,
    amount: 5000,
    currency: conformanceFixtures.currency,
    effectiveFrom: "2020-01-01",
    ruleId: "mock-fee-bike",
  },
];

export function createMockFeeEngine(
  rules: readonly MockFeeRule[] = defaultMockFeeRules,
): MockFeeEngine {
  const allRules = [...rules];

  return {
    quote(request: FeeQuoteRequest): Promise<FeeQuote> {
      const requestDate = businessDate(request.date);
      const candidates = allRules
        .filter(
          (rule) =>
            rule.tenantId === request.tenantId &&
            rule.assetTypeId === request.assetTypeId &&
            compareBusinessDates(requestDate, businessDate(rule.effectiveFrom)) >= 0,
        )
        .sort((a, b) =>
          compareBusinessDates(businessDate(b.effectiveFrom), businessDate(a.effectiveFrom)),
        );
      const match = candidates[0];
      if (match === undefined) {
        return Promise.reject(
          new PortError(
            "FeeEngine",
            "not_found",
            `No fee rule for tenant "${request.tenantId}" asset type "${request.assetTypeId}" on ${request.date}`,
          ),
        );
      }
      return Promise.resolve({
        amount: money(match.currency, match.amount),
        ruleId: match.ruleId,
      });
    },
    addRule(rule) {
      allRules.push(rule);
    },
  };
}
