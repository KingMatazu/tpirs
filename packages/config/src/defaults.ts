import { CHANNEL_CATALOGS, CHANNEL_CATALOG_LANGUAGES } from "@tpirs/i18n";
import { TenantConfigError } from "./errors.js";
import type { TenantConfig, TenantMenu, TenantMessages, UnderpaymentPolicy } from "./schema.js";
import { validateTenantConfig } from "./validate.js";

/**
 * A complete, valid tenant configuration from the answers a person can give.
 *
 * Onboarding asks for about a dozen things — who the state is, what money it
 * uses, what a day of levy costs, how drivers reach the system — because those
 * are the only values a levy office knows on day one. `TenantConfig` needs about
 * two hundred, most of them policy defaults an operator should not have to type:
 * anomaly rules, reconciliation schedules, cash float ceilings, dispute reasons,
 * session limits.
 *
 * This factory supplies the defaults and leaves the answers as the only input.
 * Everything it writes is then owned by the tenant and editable through
 * `PUT /v1/tenants/current/config`, so a default here is a starting point rather
 * than a policy decision — except where the value is genuinely platform-wide
 * (message keys, menu graph shape, the `pay_per_use` model the brief specifies).
 *
 * Two things it deliberately does not do:
 *
 * - **It does not invent copy.** Driver-facing text comes from
 *   `@tpirs/i18n`'s shipped catalogues through `PROVISIONABLE_LANGUAGES`. Asking
 *   for a language this build has no catalogue for is an error here rather than a
 *   validator failure forty fields later.
 * - **It does not create zones.** A tenant with no zones is valid; the admin
 *   decides after signing in whether the state is organised into them.
 */
export interface TenantConfigDefaultsInput {
  readonly name: string;
  readonly slug: string;
  readonly legalEntity: string;
  readonly supportEmail: string;
  readonly supportPhone: string;
  readonly timezone: string;
  readonly currency: string;
  readonly numberFormat: string;
  readonly dateFormat: string;
  /** USSD string dialled by drivers, e.g. the shortcode the aggregator issued. */
  readonly ussdCode: string;
  /** SMS sender id approved by the regulator; also the default inbound keyword. */
  readonly smsSenderId: string;
  /** Keyword drivers text to the gateway; defaults to the sender id. */
  readonly smsKeyword?: string;
  /** Daily levy for a motorbike, in minor units. */
  readonly bikeFeeMinor: number;
  /** Daily levy for a tuk-tuk, in minor units. */
  readonly tuktukFeeMinor: number;
  readonly languages?: readonly string[];
  readonly defaultLanguage?: string;
  readonly appName?: string;
  readonly logoUrl?: string;
  readonly colors?: {
    readonly primary: string;
    readonly secondary: string;
    readonly accent: string;
  };
  /** Business date the first fee rule starts; defaults to today (UTC). */
  readonly effectiveFrom?: string;
  readonly dataResidency?: string;
  readonly underpaymentPolicy?: UnderpaymentPolicy;
  readonly cashFloatCeilingMinor?: number;
  readonly depositDeadlineHours?: number;
  /** Gateway fee the reconciliation may absorb before raising an exception. */
  readonly feeToleranceMinor?: number;
  /** Days a suspense balance may age before it is flagged. */
  readonly suspenseAgeingDays?: number;
  readonly receiptFooter?: string;
}

/** Languages a new tenant may enable: those with shipped driver-channel copy. */
export const PROVISIONABLE_LANGUAGES: readonly string[] = CHANNEL_CATALOG_LANGUAGES;

/**
 * Eleven digits: the national identification number the pilot state issues.
 *
 * It is a default rather than a rule in code. A state with a different format
 * sets `collectors.nationalIdPattern` in its config and the account form, the
 * service and the audit trail all follow without a deployment.
 */
export const DEFAULT_NATIONAL_ID_PATTERN = "^\\d{11}$";

/** The national ID rule a tenant's config carries, or the platform default. */
export function nationalIdPattern(config: TenantConfig): string {
  return config.collectors?.nationalIdPattern ?? DEFAULT_NATIONAL_ID_PATTERN;
}

const DEFAULT_COLORS = {
  primary: "#0a5a4a",
  secondary: "#053b33",
  accent: "#f2c200",
} as const;

/** The menu graph every provisioned tenant starts with; labels are message keys. */
const DEFAULT_MENUS: readonly TenantMenu[] = [
  {
    type: "menu",
    key: "main",
    promptKey: "ussd.main.prompt",
    invalidKey: "ussd.main.invalid",
    options: [
      { key: "1", labelKey: "ussd.main.pay", next: "pay.enter" },
      { key: "2", labelKey: "ussd.main.status", next: "status.enter" },
      { key: "0", labelKey: "ussd.common.cancel", action: "cancel" },
    ],
  },
  {
    type: "input",
    key: "pay.enter",
    promptKey: "ussd.pay.enter",
    input: { key: "assetRef", pattern: "^[A-Z0-9]{5,8}$", errorKey: "ussd.pay.invalid" },
    next: "pay.confirm",
  },
  {
    type: "menu",
    key: "pay.confirm",
    promptKey: "ussd.pay.confirm",
    options: [
      { key: "1", labelKey: "ussd.common.confirm", action: "pay" },
      { key: "2", labelKey: "ussd.common.cancel", action: "cancel" },
    ],
  },
  {
    type: "input",
    key: "status.enter",
    promptKey: "ussd.status.enter",
    input: { key: "assetRef", pattern: "^[A-Z0-9]{5,8}$", errorKey: "ussd.status.invalid" },
    next: "status.run",
  },
  { type: "action", key: "status.run", action: "status" },
];

function businessDateToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Fails loudly for a language with no catalogue instead of a half-translated tenant. */
function cataloguesFor(languages: readonly string[]): TenantMessages {
  const messages: Record<string, Record<string, string>> = {};
  for (const language of languages) {
    const catalogue = CHANNEL_CATALOGS[language];
    if (catalogue === undefined) {
      throw new TenantConfigError(
        "invalid_reference",
        `no message catalogue ships for language '${language}'; supported: ${PROVISIONABLE_LANGUAGES.join(", ")}`,
        "languages",
      );
    }
    messages[language] = { ...catalogue };
  }
  return messages;
}

export function defaultTenantConfig(input: TenantConfigDefaultsInput): TenantConfig {
  const appName = input.appName ?? `${input.name} Levy`;
  const languages = input.languages ?? ["en"];
  const defaultLanguage = input.defaultLanguage ?? languages[0] ?? "en";
  if (!languages.includes(defaultLanguage)) {
    throw new TenantConfigError(
      "invalid_reference",
      `defaultLanguage '${defaultLanguage}' is not one of the enabled languages`,
      "languages",
    );
  }
  const effectiveFrom = input.effectiveFrom ?? businessDateToday();

  const config: TenantConfig = {
    identity: {
      name: input.name,
      slug: input.slug,
      legalEntity: input.legalEntity,
      supportContacts: { email: input.supportEmail, phone: input.supportPhone },
    },
    locale: {
      defaultLanguage,
      enabledLanguages: languages,
      timezone: input.timezone,
      currency: input.currency,
      numberFormat: input.numberFormat,
      dateFormat: input.dateFormat,
    },
    branding: {
      appName,
      // No logo until the state uploads one: the screens fall back to the
      // tenant's initials and the sticker prints its text header.
      logoUrl: input.logoUrl ?? "",
      colors: input.colors ?? DEFAULT_COLORS,
      smsSenderId: input.smsSenderId,
      receiptHeader: input.name,
      receiptFooter: input.receiptFooter ?? "Thank you",
    },
    assetTypes: [
      {
        key: "bike",
        label: "Motorbike",
        attributes: [
          {
            key: "plate_number",
            label: "Plate number",
            type: "string",
            required: true,
            pattern: "^[A-Z0-9]{5,8}$",
          },
        ],
        qrFormat: "QR-{id}",
        shortCodeFormat: "B{id}",
        stickerSpec: "60x60mm vinyl",
      },
      {
        key: "tuktuk",
        label: "Tuk-tuk",
        attributes: [
          {
            key: "plate_number",
            label: "Plate number",
            type: "string",
            required: true,
            pattern: "^[A-Z0-9]{5,8}$",
          },
        ],
        qrFormat: "QR-K{id}",
        shortCodeFormat: "K{id}",
        stickerSpec: "60x60mm vinyl",
      },
    ],
    obligations: {
      // The levy is per use: an idle vehicle owes nothing, so no period rows exist
      // for a day it did not work and nothing can accrue into a debt.
      model: "pay_per_use",
      frequency: "daily",
      prepaidAllowed: false,
      arrearsPolicy: "none",
      allocationOrder: "oldest_first",
      graceDays: 0,
      feeRules: [
        {
          key: "bike-daily",
          assetTypeKey: "bike",
          amountMinor: input.bikeFeeMinor,
          effectiveFrom,
        },
        {
          key: "tuktuk-daily",
          assetTypeKey: "tuktuk",
          amountMinor: input.tuktukFeeMinor,
          effectiveFrom,
        },
      ],
    },
    // Mocks until the operator binds a gateway and a sender with real credentials.
    // A new deployment that took live payments before anyone chose a provider
    // would be worse than one that plainly has none yet.
    providers: [
      { port: "PaymentProvider", adapter: "mock" },
      { port: "SmsProvider", adapter: "mock" },
      { port: "UssdProvider", adapter: "mock" },
    ],
    channels: {
      ussdCode: input.ussdCode,
      smsKeyword: input.smsKeyword ?? input.smsSenderId,
      otpMessageTemplate: `${appName}: your verification code is {code}.`,
      smsReceiptTemplate: `${appName} receipt {receiptNo}: {amount} paid for {assetRef} on {date}.`,
      startMenu: "main",
      messages: cataloguesFor(languages),
      menus: DEFAULT_MENUS,
    },
    cashRules: {
      enabled: true,
      floatCeilingMinor: input.cashFloatCeilingMinor ?? 5_000_000,
      depositDeadlineHours: input.depositDeadlineHours ?? 24,
      freezeOnShortfall: true,
      // ADR 0069. A new tenant starts postpaid, which is the model every
      // existing configuration already behaved under.
      model: "postpaid",
      maxBalanceMinor: 5_000_000,
      intakeGuard: "hard",
      graceMinor: 0,
      funding: "virtual_terminal",
    },
    collectors: { nationalIdPattern: DEFAULT_NATIONAL_ID_PATTERN },
    payments: { underpaymentPolicy: input.underpaymentPolicy ?? "wallet" },
    featureFlags: { disputes: true, prepay: false, offlineMode: true, anomalyAlerts: true },
    field: {
      offlineGraceHours: 8,
      maxQueueItems: 1000,
      disputeReasons: [
        { code: "wrong_location", label: "Wrong location" },
        { code: "already_paid", label: "Already paid" },
        { code: "technical_issue", label: "Technical issue" },
        { code: "other", label: "Other" },
      ],
    },
    reconciliation: {
      enabled: true,
      schedule: "0 2 * * *",
      toleranceMinor: 100,
      feeToleranceMinor: input.feeToleranceMinor ?? 0,
      suspenseAgeingDays: input.suspenseAgeingDays ?? 7,
      notifyRole: "finance_admin",
      // Every rule ships disabled until the tenant has baselines to compare
      // against (D46); enabling one without a threshold fails the next load.
      anomalyRules: [
        {
          key: "collector_volume_drop",
          enabled: false,
          windowDays: 14,
          thresholdPercent: 30,
          severity: "warning",
        },
        {
          key: "collector_deposit_lag",
          enabled: false,
          windowDays: 7,
          thresholdMinor: 1,
          severity: "warning",
        },
        {
          key: "zone_compliance_drop",
          enabled: false,
          windowDays: 14,
          thresholdPercent: 20,
          severity: "warning",
        },
        {
          key: "officer_scan_volume_change",
          enabled: false,
          windowDays: 14,
          thresholdPercent: 50,
          severity: "info",
        },
        {
          key: "suspense_growth",
          enabled: false,
          windowDays: 7,
          thresholdMinor: input.bikeFeeMinor * 25,
          severity: "warning",
        },
      ],
    },
    compliance: {
      retentionDays: 2555,
      dataResidency: input.dataResidency ?? input.slug,
      consentTextKey: "consent.default",
    },
  };

  // The factory is not trusted just because it is ours: an incomplete catalogue
  // or an unpriced asset type must fail here, at provisioning, rather than on a
  // tenant's first payment.
  return validateTenantConfig(config);
}
