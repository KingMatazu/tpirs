import type { AnyDb } from "@tpirs/db";
import { repositories, withTenant } from "@tpirs/db";
import type { PaymentStatus } from "@tpirs/domain";
import { paymentStatusFromPeriod, todayInTimeZone } from "@tpirs/domain";
import type { TenantConfig } from "@tpirs/config";

export interface VerificationServiceDeps {
  readonly db: AnyDb;
  readonly loadConfig: (tenantId: string) => Promise<TenantConfig | undefined>;
  readonly now?: () => Date;
}

export interface VerifyAssetResult {
  readonly tenantId: string;
  readonly assetId: string;
  readonly businessDate: string;
  readonly paymentStatus: PaymentStatus;
}

export class VerificationService {
  constructor(private readonly deps: VerificationServiceDeps) {}

  async statusForAsset(tenantId: string, assetId: string): Promise<VerifyAssetResult> {
    const config = await this.deps.loadConfig(tenantId);
    const now = this.deps.now?.() ?? new Date();
    const businessDate = todayInTimeZone(config?.locale.timezone ?? "UTC", now);
    if (config === undefined) {
      return { tenantId, assetId, businessDate, paymentStatus: "unknown" };
    }
    const period = await withTenant(this.deps.db, tenantId, async (tx) =>
      repositories(tx).obligations.findByAssetAndDate(tenantId, assetId, businessDate),
    );
    return {
      tenantId,
      assetId,
      businessDate,
      paymentStatus: paymentStatusFromPeriod(period?.status ?? "none"),
    };
  }
}

export function createVerificationService(deps: VerificationServiceDeps): VerificationService {
  return new VerificationService(deps);
}
