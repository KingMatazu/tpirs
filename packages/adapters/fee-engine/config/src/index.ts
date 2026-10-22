import { selectFeeRule } from "@tpirs/domain";
import type { FeeRule } from "@tpirs/domain";
import type { TenantConfig } from "@tpirs/config";
import { PortError } from "@tpirs/ports";
import type { FeeEngine, FeeResolveRequest, ResolvedFee } from "@tpirs/ports";

/**
 * Loads a tenant's validated configuration. Injected so this adapter holds no
 * database or tenant-resolution logic; a request handler passes a loader backed
 * by the tenant config repository.
 */
export type TenantConfigLoader = (tenantId: string) => Promise<TenantConfig | undefined>;

export interface ConfigFeeEngineOptions {
  readonly loadConfig: TenantConfigLoader;
}

/**
 * Maps tenant fee rules onto the domain rule shape. The currency comes from the
 * tenant locale: v1 uses one currency per tenant with no FX (decisions-needed
 * D7), so a rule does not carry its own currency.
 */
function toDomainRules(config: TenantConfig): FeeRule[] {
  return config.obligations.feeRules.map((rule) => ({
    ruleId: rule.key,
    ...(rule.assetTypeKey === undefined ? {} : { assetType: rule.assetTypeKey }),
    amountMinor: rule.amountMinor,
    currency: config.locale.currency,
    effectiveFrom: rule.effectiveFrom,
    ...(rule.effectiveTo === undefined ? {} : { effectiveTo: rule.effectiveTo }),
  }));
}

/**
 * Reads fee rules from the tenant configuration. This is the production adapter
 * for FeeEngine: pricing a new asset type is a config change, not a code change
 * (build brief section 1.3).
 */
export function createConfigFeeEngine(options: ConfigFeeEngineOptions): FeeEngine {
  return {
    async resolveFee(request: FeeResolveRequest): Promise<ResolvedFee> {
      const config = await options.loadConfig(request.tenantId);
      if (config === undefined) {
        throw new PortError(
          "FeeEngine",
          "not_found",
          `No configuration found for tenant "${request.tenantId}"`,
        );
      }

      const selection = selectFeeRule(toDomainRules(config), {
        assetType: request.assetType,
        ...(request.zoneId === undefined ? {} : { zoneId: request.zoneId }),
        businessDate: request.businessDate,
      });
      if (selection === undefined) {
        throw new PortError(
          "FeeEngine",
          "not_found",
          `No fee rule for tenant "${request.tenantId}" asset type "${request.assetType}" on ${request.businessDate}`,
        );
      }

      return {
        amountMinor: selection.rule.amountMinor,
        currency: selection.rule.currency,
        ruleId: selection.rule.ruleId,
      };
    },
  };
}
