import { businessDate } from "@tpirs/domain";
import type { AssetTypeId, TenantId } from "@tpirs/domain";
import type { TenantConfig } from "@tpirs/config";
import { createConfigFeeEngine } from "@tpirs/fee-engine-config";

/**
 * The fee for one asset today, resolved with the same engine the API uses.
 *
 * The dashboard must not hold a second opinion about a price. The collector app
 * already asks the engine; the cash screen used to re-derive the amount from the
 * raw fee-rule list, which ignored zone rules and `effectiveTo`. Asking the
 * engine costs a pure function call and cannot drift from the server.
 *
 * `undefined` means the tenant has no rule for this asset type today, which the
 * screen shows as "no fee" rather than guessing zero.
 */
export async function resolveTenantFeeMinor(
  config: TenantConfig,
  assetTypeKey: string,
  businessDateValue: string,
): Promise<bigint | undefined> {
  const engine = createConfigFeeEngine({ loadConfig: () => Promise.resolve(config) });
  try {
    const resolved = await engine.resolveFee({
      // The ids are opaque at the type level; the values come from validated
      // config and a computed date, so the boundary cast is the honest place.
      tenantId: config.identity.slug as TenantId,
      assetType: assetTypeKey as AssetTypeId,
      businessDate: businessDate(businessDateValue),
    });
    return BigInt(resolved.amountMinor);
  } catch {
    return undefined;
  }
}
