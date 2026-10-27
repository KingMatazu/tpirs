import type { TenantConfig } from "@tpirs/config";
import { formatMoneyMinor } from "@tpirs/ui-tokens";

/**
 * Step 4 (config viewer): turns the validated TenantConfig into display groups.
 * Pure data transformation so the tests assert grouping and wording (especially
 * the pay-per-use wording that must never imply debt) without rendering React.
 * Read-only everywhere: there is no create/update surface in this module.
 */

export interface ConfigEntry {
  readonly label: string;
  readonly value: string;
}

export interface ConfigSubGroup {
  readonly title: string;
  readonly entries: readonly ConfigEntry[];
}

export interface ConfigSection {
  readonly id: string;
  readonly title: string;
  readonly entries: readonly ConfigEntry[];
  readonly subGroups: readonly ConfigSubGroup[];
}

function onOff(value: boolean, on = "enabled", off = "disabled"): string {
  return value ? on : off;
}

function money(config: TenantConfig, amountMinor: number): string {
  return formatMoneyMinor(amountMinor, config.locale.currency, config.locale.numberFormat);
}

export function configSections(config: TenantConfig): readonly ConfigSection[] {
  const sections: ConfigSection[] = [
    {
      id: "identity",
      title: "Identity",
      entries: [
        { label: "Name", value: config.identity.name },
        { label: "Slug", value: config.identity.slug },
        { label: "Legal entity", value: config.identity.legalEntity },
        { label: "Support email", value: config.identity.supportContacts.email },
        { label: "Support phone", value: config.identity.supportContacts.phone },
      ],
      subGroups: [],
    },
    {
      id: "locale",
      title: "Locale",
      entries: [
        { label: "Default language", value: config.locale.defaultLanguage },
        { label: "Enabled languages", value: config.locale.enabledLanguages.join(", ") },
        { label: "Timezone", value: config.locale.timezone },
        { label: "Currency", value: config.locale.currency },
        { label: "Number format", value: config.locale.numberFormat },
        { label: "Date format", value: config.locale.dateFormat },
      ],
      subGroups: [],
    },
    {
      id: "branding",
      title: "Branding",
      entries: [
        { label: "App name", value: config.branding.appName },
        { label: "Logo", value: config.branding.logoUrl },
        { label: "Primary colour", value: config.branding.colors.primary },
        { label: "Secondary colour", value: config.branding.colors.secondary },
        { label: "Accent colour", value: config.branding.colors.accent },
        { label: "SMS sender ID", value: config.branding.smsSenderId },
        { label: "Receipt header", value: config.branding.receiptHeader },
        { label: "Receipt footer", value: config.branding.receiptFooter },
      ],
      subGroups: [],
    },
    {
      id: "asset-types",
      title: "Asset types",
      entries: config.assetTypes.map((type) => ({
        label: type.label,
        value: `${type.attributes.length} attribute${type.attributes.length === 1 ? "" : "s"} (${type.key})`,
      })),
      subGroups: config.assetTypes.map((type) => ({
        title: `${type.label} (${type.key})`,
        entries: [
          {
            label: "Attributes",
            value:
              type.attributes.length === 0
                ? "none"
                : type.attributes
                    .map(
                      (attribute) =>
                        `${attribute.label} — ${attribute.type}, ${onOff(attribute.required, "required", "optional")}`,
                    )
                    .join("; "),
          },
          { label: "QR format", value: type.qrFormat },
          { label: "Short-code format", value: type.shortCodeFormat },
          { label: "Sticker spec", value: type.stickerSpec },
        ],
      })),
    },
    {
      id: "obligations",
      title: "Obligations",
      entries: [
        { label: "Model", value: config.obligations.model },
        { label: "Frequency", value: config.obligations.frequency },
        {
          label: "Prepaid",
          value: onOff(config.obligations.prepaidAllowed, "allowed", "not allowed"),
        },
        { label: "Arrears policy", value: config.obligations.arrearsPolicy },
        { label: "Allocation order", value: config.obligations.allocationOrder },
        { label: "Grace days", value: String(config.obligations.graceDays) },
        ...(config.obligations.model === "pay_per_use"
          ? [
              {
                label: "Pay-per-use note",
                value:
                  "Levy is owed only on days the asset is used for work: no payment recorded for a day simply means no levy was taken that day — it is never a debt.",
              },
            ]
          : []),
      ],
      subGroups: [
        {
          title: "Fee rules",
          entries: config.obligations.feeRules.map((rule) => ({
            label: rule.key,
            value: `${money(config, rule.amountMinor)} effective ${rule.effectiveFrom}${
              rule.effectiveTo === undefined ? "" : ` until ${rule.effectiveTo}`
            }${rule.assetTypeKey === undefined ? " (all asset types)" : ` (${rule.assetTypeKey})`}`,
          })),
        },
      ],
    },
    {
      id: "providers",
      title: "Providers",
      entries: config.providers.map((binding) => ({
        label: binding.port,
        value: binding.adapter,
      })),
      // Only references are shown here, never secret values; config stores
      // references and the secret store resolves them (build brief section 4).
      subGroups: config.providers.map((binding) => ({
        title: `${binding.port} — ${binding.adapter}`,
        entries: [
          {
            label: "Secret references",
            value:
              binding.secrets === undefined
                ? "none"
                : Object.entries(binding.secrets)
                    .map(([key, reference]) => `${key} → ${reference}`)
                    .join("; "),
          },
          {
            label: "Options",
            value:
              binding.options === undefined
                ? "none"
                : Object.entries(binding.options)
                    .map(([key, value]) => `${key} = ${String(value)}`)
                    .join("; "),
          },
        ],
      })),
    },
    {
      id: "channels",
      title: "Driver channels",
      entries: [
        { label: "USSD code", value: config.channels.ussdCode },
        { label: "SMS keyword", value: config.channels.smsKeyword },
        { label: "OTP message template", value: config.channels.otpMessageTemplate },
        { label: "SMS receipt template", value: config.channels.smsReceiptTemplate },
        { label: "Menu nodes", value: String(config.channels.menus.length) },
        ...(config.channels.startMenu === undefined
          ? []
          : [{ label: "Start menu", value: config.channels.startMenu }]),
        ...(config.channels.ussd === undefined
          ? []
          : [
              {
                label: "USSD rate limit",
                value: `${config.channels.ussd.rateLimit.perMsisdnPerMinute}/min per phone, ${config.channels.ussd.rateLimit.perIpPerMinute}/min per IP`,
              },
            ]),
        ...(config.channels.sms === undefined
          ? []
          : [
              {
                label: "SMS limits",
                value: `${config.channels.sms.maxSendsPerDay}/day tenant wide, ${config.channels.sms.maxSendsPerRecipientPerDay}/day per recipient`,
              },
            ]),
      ],
      subGroups: [],
    },
    {
      id: "cash-rules",
      title: "Cash rules",
      entries: [
        { label: "Collector cash", value: onOff(config.cashRules.enabled) },
        { label: "Float ceiling", value: money(config, config.cashRules.floatCeilingMinor) },
        {
          label: "Deposit deadline",
          value: `${String(config.cashRules.depositDeadlineHours)} hours`,
        },
        {
          label: "Freeze on shortfall",
          value: onOff(config.cashRules.freezeOnShortfall),
        },
      ],
      subGroups: [],
    },
    {
      id: "payments",
      title: "Payments",
      entries: [
        {
          label: "Underpayment policy",
          value:
            config.payments.underpaymentPolicy === "wallet"
              ? "credit the asset wallet (the day shows no payment until the fee is met)"
              : "route to suspense for finance review",
        },
      ],
      subGroups: [],
    },
    {
      id: "feature-flags",
      title: "Feature flags",
      entries: [
        { label: "Disputes", value: onOff(config.featureFlags.disputes) },
        { label: "Prepay", value: onOff(config.featureFlags.prepay) },
        { label: "Offline mode", value: onOff(config.featureFlags.offlineMode) },
        { label: "Anomaly alerts", value: onOff(config.featureFlags.anomalyAlerts) },
      ],
      subGroups: [],
    },
    {
      id: "reconciliation",
      title: "Reconciliation",
      entries: [
        { label: "Schedule", value: config.reconciliation.schedule },
        { label: "Tolerance", value: money(config, config.reconciliation.toleranceMinor) },
        { label: "Notify role", value: config.reconciliation.notifyRole },
      ],
      subGroups: [],
    },
    {
      id: "compliance",
      title: "Compliance",
      entries: [
        {
          label: "Retention days",
          value: String(config.compliance.retentionDays),
        },
        { label: "Data residency", value: config.compliance.dataResidency },
        { label: "Consent text key", value: config.compliance.consentTextKey },
      ],
      subGroups: [],
    },
  ];
  return sections;
}
