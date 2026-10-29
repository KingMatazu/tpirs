/**
 * Tenant configuration shape. Every value that can vary between deployments
 * lives here; no core code may hardcode a state, currency, gateway, or message.
 * All fields are data-only and validated at startup (see validateTenantConfig).
 */

import type { SettlementDatePattern, UssdMenuNode, UssdMenuOption } from "@tpirs/domain";

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

export type TenantMenuOption = UssdMenuOption;

export type TenantMenu = UssdMenuNode;

/** Language code to message key to translated text. */
export type TenantMessages = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface TenantUssdSettings {
  readonly sessionTimeoutSeconds: number;
  readonly maxInputLength: number;
  readonly maxSteps: number;
  readonly rateLimit: {
    readonly perMsisdnPerMinute: number;
    readonly perIpPerMinute: number;
  };
}

export interface TenantSmsSettings {
  readonly maxSendsPerDay: number;
  readonly maxSendsPerRecipientPerDay: number;
  readonly rateLimit: {
    readonly perMsisdnPerMinute: number;
  };
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
  /**
   * SMS receipt sent to the owner when a collector takes cash intake (Phase 7).
   * Optional because cash intake is a tenant-config feature: when omitted the
   * code falls back to its built-in default (D38). Same placeholder contract
   * as `smsReceiptTemplate` — {amount}, {assetRef}, {date}, {receiptNo}.
   */
  readonly cashReceiptTemplate?: string;
  /** Typed menu graph used by the pure USSD session engine. */
  readonly menus: readonly TenantMenu[];
  /** Entry node; omitted when `menus` is empty, otherwise defaults to the first menu. */
  readonly startMenu?: string;
  /** Driver-facing copy keyed by language, then message key. */
  readonly messages?: TenantMessages;
  /** Session and abuse limits for USSD. */
  readonly ussd?: TenantUssdSettings;
  /** Cost and abuse limits for SMS. */
  readonly sms?: TenantSmsSettings;
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

/**
 * The anomaly rules a tenant may enable (D46, ADR 0039).
 *
 * The vocabulary deliberately has no `asset` member: under `pay_per_use` a
 * vehicle that does not work owes nothing, so a quiet asset is never an event.
 * Every rule ships disabled in the template until pilot baselines exist.
 */
export type TenantAnomalyRuleKey =
  | "collector_volume_drop"
  | "collector_deposit_lag"
  | "zone_compliance_drop"
  | "officer_scan_volume_change"
  | "suspense_growth";

export const TENANT_ANOMALY_RULE_KEYS: readonly TenantAnomalyRuleKey[] = [
  "collector_volume_drop",
  "collector_deposit_lag",
  "zone_compliance_drop",
  "officer_scan_volume_change",
  "suspense_growth",
];

/** Anomalies are advisories, never blocking: blocking belongs to reconciliation. */
export type TenantAnomalySeverity = "warning" | "info";

export interface TenantAnomalyRule {
  readonly key: TenantAnomalyRuleKey;
  readonly enabled: boolean;
  /** Length of the trailing baseline window, in business days. */
  readonly windowDays: number;
  /** Deviation required to fire, as a percentage of the trailing mean. */
  readonly thresholdPercent?: number;
  /**
   * Rule-specific whole-number knob, minor units. For `suspense_growth` it is
   * the suspense ceiling; for `collector_deposit_lag` it is the multiple of the
   * deposit deadline an intake may pass before it counts (default 1).
   */
  readonly thresholdMinor?: number;
  readonly severity: TenantAnomalySeverity;
}

/**
 * Where a bank/gateway statement comes from and how its columns map.
 *
 * The port owns no column names (D21/ADR 0035), so a tenant declares its own.
 * Omit the section until a statement export exists; reconciliation still runs
 * against gateway events, it just cannot settle fees from a bank file.
 */
export interface TenantSettlementColumns {
  /** Column holding the gateway's reference for the payment. */
  readonly reference: string;
  /** Column holding the gross amount charged to the driver. */
  readonly amount: string;
  /** Column holding the gateway fee, when the statement breaks it out. */
  readonly fee?: string;
  /** Column holding the ISO currency; omitted means `defaultCurrency`. */
  readonly currency?: string;
  /** Column holding the settlement date (and optionally the time). */
  readonly settledAt: string;
  /** Column retained verbatim as evidence, e.g. the narration. */
  readonly description?: string;
}

export interface TenantSettlementImport {
  /** Provider key the rows are matched against, e.g. the gateway adapter name. */
  readonly provider: string;
  readonly columns: TenantSettlementColumns;
  /** Pattern the settled-at column uses; values are read as UTC. */
  readonly dateFormat: SettlementDatePattern;
  /** The amount column holds minor units (`50000`) rather than `500.00`. */
  readonly amountInMinorUnits: boolean;
  /** Character separating the fraction in an amount column. Defaults to ".". */
  readonly decimalSeparator?: "." | ",";
  /** Currency used when the mapping declares no currency column. */
  readonly defaultCurrency?: string;
}

export interface TenantReconciliation {
  /**
   * Whether the worker runs the nightly reconciliation at all. A tenant can
   * pause it during onboarding or a data migration without deleting the cron.
   * Defaults to true.
   */
  readonly enabled: boolean;
  /** Cron in the tenant timezone; validated structurally at load (D48). */
  readonly schedule: string;
  /** Whole-day tolerance for ledger, clearing and float differences. */
  readonly toleranceMinor: number;
  /** How much of a payment the gateway may keep before it is an exception. */
  readonly feeToleranceMinor: number;
  /** Suspense older than this many days is a warning. */
  readonly suspenseAgeingDays: number;
  readonly notifyRole: string;
  /** Rules the nightly evaluation may run; disabled ones are ignored. */
  readonly anomalyRules: readonly TenantAnomalyRule[];
  readonly settlementImport?: TenantSettlementImport;
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
