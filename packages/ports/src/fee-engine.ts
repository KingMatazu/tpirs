import type { AssetTypeId, BusinessDate, Money, TenantId, ZoneId } from "@tpirs/domain";

export interface FeeQuoteRequest {
  readonly tenantId: TenantId;
  readonly assetTypeId: AssetTypeId;
  readonly date: BusinessDate;
  readonly zoneId?: ZoneId;
}

export interface FeeQuote {
  readonly amount: Money;
  readonly ruleId: string;
}

export interface FeeEngine {
  /** Throws PortError("not_found") when no effective-dated rule matches. */
  quote(request: FeeQuoteRequest): Promise<FeeQuote>;
}
