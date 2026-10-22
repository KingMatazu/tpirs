/**
 * Tenant configuration shape. Every value that can vary between deployments
 * lives here; no core code may hardcode a state, currency, gateway, or message.
 * All fields are data-only and validated at startup (see validateTenantConfig).
 */

export interface TenantIdentity {
  readonly name: string;
  readonly slug: string;
  readonly legalEntity: string;
  readonly supportContacts: {
    readonly email: string;
    readonly phone: string;
  };
}

export interface TenantLocale {
  readonly defaultLanguage: string;
  readonly enabledLanguages: readonly string[];
  readonly timezone: string;
  readonly currency: string;
  readonly numberFormat: string;
  readonly dateFormat: string;
}

export interface TenantBranding {
  readonly appName: string;
  readonly logoUrl: string;
  readonly colors: {
    readonly primary: string;
    readonly secondary: string;
    readonly accent: string;
  };
  readonly smsSenderId: string;
  readonly receiptHeader: string;
  readonly receiptFooter: string;
}

export interface TenantAssetType {
  readonly key: string;
  readonly label: string;
  readonly attributes: readonly TenantAssetAttribute[];
  readonly qrFormat: string;
  readonly shortCodeFormat: string;
  readonly stickerSpec: string;
}

export interface TenantAssetAttribute {
  readonly key: string;
  readonly label: string;
  readonly type: "string" | "number" | "date" | "enum";
  readonly required: boolean;
  readonly options?: readonly string[];
  readonly pattern?: string;
}

export type ObligationModel = "pay_per_use" | "scheduled";
export type ObligationFrequency = "daily" | "weekly" | "monthly";
export type ArrearsPolicy = "none" | "accrue";
export type AllocationOrder = "oldest_first" | "today_first";

/**
 * What happens to a payment that is short of the fee (ADR 0019).
 * `wallet` credits the asset wallet and leaves the day unpaid; `suspense` sends
 * the payment to finance review. Currency mismatches and unattributable
 * payments always go to suspense regardless of this setting.
 */
export type UnderpaymentPolicy = "wallet" | "suspense";

export interface TenantFeeRule {
  readonly key: string;
  /**
   * Asset type this rule prices. Omitted means a default rule that prices every
   * asset type. Rules for the same asset type must not overlap in time.
   */
  readonly assetTypeKey?: string;
  readonly amountMinor: number;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
}

export interface TenantObligationRules {
  readonly model: ObligationModel;
  readonly frequency: ObligationFrequency;
  readonly prepaidAllowed: boolean;
  readonly arrearsPolicy: ArrearsPolicy;
  /**
   * Which period a payment settles first under the `scheduled` model.
   * `oldest_first` drains the earliest outstanding period; `today_first`
   * settles the current business day before earlier ones.
   */
  readonly allocationOrder: AllocationOrder;
  readonly graceDays: number;
  readonly feeRules: readonly TenantFeeRule[];
}

export interface TenantProviderBinding {
  readonly port: string;
  readonly adapter: string;
  /** Reference to a secret; never the secret itself. */
  readonly secrets?: Readonly<Record<string, string>>;
  readonly options?: Readonly<Record<string, string | number | boolean>>;
}

export interface TenantMenuOption {
  readonly key: string;
  readonly labelKey: string;
  readonly next?: string;
}

export interface TenantMenu {
  readonly key: string;
  readonly promptKey: string;
  readonly options: readonly TenantMenuOption[];
}

export interface TenantChannels {
  readonly ussdCode: string;
  readonly smsKeyword: string;
  /** SMS template for owner phone verification; must contain the {code} placeholder. */
  readonly otpMessageTemplate: string;
  /**
   * SMS receipt sent once per applied payment. Must contain exactly the
   * placeholders the receipt renderer fills: {amount}, {assetRef}, {date} and
   * {receiptNo}. Unknown placeholders are rejected at load time so a typo is a
   * startup failure rather than a literal brace in a driver's SMS.
   */
  readonly smsReceiptTemplate: string;
  readonly menus: readonly TenantMenu[];
}

export interface TenantCashRules {
  readonly enabled: boolean;
  readonly floatCeilingMinor: number;
  readonly depositDeadlineHours: number;
  readonly freezeOnShortfall: boolean;
}

/** Payment intake behaviour that is not a provider binding. */
export interface TenantPayments {
  /** Defaults to `wallet` when the section is omitted. */
  readonly underpaymentPolicy: UnderpaymentPolicy;
}

export interface TenantFeatureFlags {
  readonly disputes: boolean;
  readonly prepay: boolean;
  readonly offlineMode: boolean;
  readonly anomalyAlerts: boolean;
}

export interface TenantReconciliation {
  readonly schedule: string;
  readonly toleranceMinor: number;
  readonly notifyRole: string;
}

export interface TenantCompliance {
  readonly retentionDays: number;
  readonly dataResidency: string;
  readonly consentTextKey: string;
}

export interface TenantConfig {
  readonly identity: TenantIdentity;
  readonly locale: TenantLocale;
  readonly branding: TenantBranding;
  readonly assetTypes: readonly TenantAssetType[];
  readonly obligations: TenantObligationRules;
  readonly providers: readonly TenantProviderBinding[];
  readonly channels: TenantChannels;
  readonly cashRules: TenantCashRules;
  readonly payments: TenantPayments;
  readonly featureFlags: TenantFeatureFlags;
  readonly reconciliation: TenantReconciliation;
  readonly compliance: TenantCompliance;
}
