import { selectFeeRule } from "@tpirs/domain";
import type { FeeRule } from "@tpirs/domain";
import { PortError } from "@tpirs/ports";
import type { FeeEngine, FeeResolveRequest, ResolvedFee } from "@tpirs/ports";
import { conformanceFixtures } from "@tpirs/contracts";

export interface MockFeeRule {
  readonly tenantId: string;
  readonly assetTypeId: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** YYYY-MM-DD */
  readonly effectiveFrom: string;
  readonly ruleId: string;
}

export interface MockFeeEngine extends FeeEngine {
  addRule(rule: MockFeeRule): void;
}

/**
 * Fixed fee table used by the mock. The values are stable so tests can assert
 * on them without reading tenant configuration.
 */
export const defaultMockFeeRules: readonly MockFeeRule[] = [
  {
    tenantId: "conformance-tenant",
    assetTypeId: conformanceFixtures.assetTypeKey,
    amountMinor: 5000,
    currency: conformanceFixtures.currency,
    effectiveFrom: "2020-01-01",
    ruleId: "mock-fee-bike",
  },
];

export function createMockFeeEngine(
  rules: readonly MockFeeRule[] = defaultMockFeeRules,
): MockFeeEngine {
  const allRules = [...rules];

  function toDomainRule(rule: MockFeeRule): FeeRule {
    return {
      ruleId: rule.ruleId,
      assetType: rule.assetTypeId,
      amountMinor: rule.amountMinor,
      currency: rule.currency,
      effectiveFrom: rule.effectiveFrom,
    };
  }

  return {
    resolveFee(request: FeeResolveRequest): Promise<ResolvedFee> {
      const tenantRules = allRules.filter((rule) => rule.tenantId === request.tenantId);
      if (tenantRules.length === 0) {
        return Promise.reject(
          new PortError("FeeEngine", "not_found", `No fee rules for tenant "${request.tenantId}"`),
        );
      }

      const selection = selectFeeRule(tenantRules.map(toDomainRule), {
        assetType: request.assetType,
        ...(request.zoneId === undefined ? {} : { zoneId: request.zoneId }),
        businessDate: request.businessDate,
      });
      if (selection === undefined) {
        return Promise.reject(
          new PortError(
            "FeeEngine",
            "not_found",
            `No fee rule for tenant "${request.tenantId}" asset type "${request.assetType}" on ${request.businessDate}`,
          ),
        );
      }

      return Promise.resolve({
        amountMinor: selection.rule.amountMinor,
        currency: selection.rule.currency,
        ruleId: selection.rule.ruleId,
      });
    },

    addRule(rule: MockFeeRule): void {
      allRules.push(rule);
    },
  };
}
