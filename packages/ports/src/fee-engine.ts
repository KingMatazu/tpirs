import type { AssetTypeId, BusinessDate, TenantId, ZoneId } from "@tpirs/domain";

export interface FeeResolveRequest {
  readonly tenantId: TenantId;
  readonly assetType: AssetTypeId;
  readonly zoneId?: ZoneId;
  readonly businessDate: BusinessDate;
}

export interface ResolvedFee {
  /** Amount in integer minor units of `currency`. */
  readonly amountMinor: number;
  readonly currency: string;
  /** Identifier of the rule that priced the fee, for the obligation snapshot. */
  readonly ruleId: string;
}

export interface FeeEngine {
  /** Throws PortError("not_found") when no effective-dated rule matches. */
  resolveFee(request: FeeResolveRequest): Promise<ResolvedFee>;
}
