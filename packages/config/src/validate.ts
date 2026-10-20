import { TenantConfigError, TenantConfigValidationError } from "./errors.js";
import type {
  ArrearsPolicy,
  ObligationFrequency,
  ObligationModel,
  TenantAssetAttribute,
  TenantAssetType,
  TenantBranding,
  TenantCashRules,
  TenantChannels,
  TenantCompliance,
  TenantConfig,
  TenantFeatureFlags,
  TenantFeeRule,
  TenantIdentity,
  TenantLocale,
  TenantMenu,
  TenantMenuOption,
  TenantObligationRules,
  TenantProviderBinding,
  TenantReconciliation,
} from "./schema.js";
import { Validator } from "./validator.js";

const OBLIGATION_MODELS: readonly ObligationModel[] = ["pay_per_use", "scheduled"];
const OBLIGATION_FREQUENCIES: readonly ObligationFrequency[] = ["daily", "weekly", "monthly"];
const ARREARS_POLICIES: readonly ArrearsPolicy[] = ["none", "accrue"];
const ATTRIBUTE_TYPES = ["string", "number", "date", "enum"] as const;

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function validateSupportContacts(
  v: Validator,
  value: unknown,
): TenantIdentity["supportContacts"] | undefined {
  const obj = v.object(value, "supportContacts");
  if (obj === undefined) return undefined;
  const email = v.string(obj.email, "email");
  const phone = v.string(obj.phone, "phone");
  if (email === undefined || phone === undefined) return undefined;
  return { email, phone };
}

function validateIdentity(v: Validator, value: unknown): TenantIdentity | undefined {
  const obj = v.object(value, "identity");
  if (obj === undefined) return undefined;
  const name = v.string(obj.name, "name");
  const slug = v.string(obj.slug, "slug");
  const legalEntity = v.string(obj.legalEntity, "legalEntity");
  const supportContacts = validateSupportContacts(v, obj.supportContacts);
  if (slug !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    v.issue("schema_error", "identity.slug must be lowercase alphanumeric with hyphens", "slug");
    return undefined;
  }
  if (
    name === undefined ||
    slug === undefined ||
    legalEntity === undefined ||
    supportContacts === undefined
  ) {
    return undefined;
  }
  return { name, slug, legalEntity, supportContacts };
}

function validateLocale(v: Validator, value: unknown): TenantLocale | undefined {
  const obj = v.object(value, "locale");
  if (obj === undefined) return undefined;
  const defaultLanguage = v.string(obj.defaultLanguage, "defaultLanguage");
  const timezone = v.string(obj.timezone, "timezone");
  const currency = v.string(obj.currency, "currency");
  const numberFormat = v.string(obj.numberFormat, "numberFormat");
  const dateFormat = v.string(obj.dateFormat, "dateFormat");
  const languages = v.array(obj.enabledLanguages, "enabledLanguages");
  const enabledLanguages: string[] = [];
  if (languages !== undefined) {
    languages.forEach((lang, index) => {
      const parsed = v.string(lang, `enabledLanguages.${index}`);
      if (parsed !== undefined) enabledLanguages.push(parsed);
    });
    if (enabledLanguages.length === 0) {
      v.issue("schema_error", "locale.enabledLanguages must not be empty", "enabledLanguages");
    }
  }
  if (currency !== undefined && !/^[A-Z]{3}$/.test(currency)) {
    v.issue("schema_error", "locale.currency must be an ISO 4217 code", "currency");
  }
  if (timezone !== undefined && !timezone.includes("/")) {
    v.issue("schema_error", "locale.timezone must be an IANA zone", "timezone");
  }
  if (
    defaultLanguage === undefined ||
    timezone === undefined ||
    currency === undefined ||
    numberFormat === undefined ||
    dateFormat === undefined ||
    languages === undefined ||
    enabledLanguages.length === 0
  ) {
    return undefined;
  }
  if (!enabledLanguages.includes(defaultLanguage)) {
    v.issue(
      "schema_error",
      "locale.defaultLanguage must be in enabledLanguages",
      "defaultLanguage",
    );
    return undefined;
  }
  return { defaultLanguage, enabledLanguages, timezone, currency, numberFormat, dateFormat };
}

function validateBranding(v: Validator, value: unknown): TenantBranding | undefined {
  const obj = v.object(value, "branding");
  if (obj === undefined) return undefined;
  const appName = v.string(obj.appName, "appName");
  const logoUrl = v.string(obj.logoUrl, "logoUrl");
  const smsSenderId = v.string(obj.smsSenderId, "smsSenderId");
  const receiptHeader = v.string(obj.receiptHeader, "receiptHeader");
  const receiptFooter = v.string(obj.receiptFooter, "receiptFooter");
  const colorsObj = v.object(obj.colors, "colors");
  let colors: TenantBranding["colors"] | undefined;
  if (colorsObj !== undefined) {
    const primary = v.string(colorsObj.primary, "primary");
    const secondary = v.string(colorsObj.secondary, "secondary");
    const accent = v.string(colorsObj.accent, "accent");
    if (primary !== undefined && secondary !== undefined && accent !== undefined) {
      colors = { primary, secondary, accent };
    }
  }
  if (
    appName === undefined ||
    logoUrl === undefined ||
    smsSenderId === undefined ||
    receiptHeader === undefined ||
    receiptFooter === undefined ||
    colors === undefined
  ) {
    return undefined;
  }
  return { appName, logoUrl, colors, smsSenderId, receiptHeader, receiptFooter };
}

function validateAttribute(v: Validator, value: unknown): TenantAssetAttribute | undefined {
  const obj = v.object(value, "attribute");
  if (obj === undefined) return undefined;
  const key = v.string(obj.key, "key");
  const label = v.string(obj.label, "label");
  const type = v.enum(obj.type, "type", ATTRIBUTE_TYPES);
  const required = v.boolean(obj.required, "required");
  if (key === undefined || label === undefined || type === undefined || required === undefined) {
    return undefined;
  }

  let options: string[] | undefined;
  if (obj.options !== undefined) {
    const list = v.array(obj.options, "options");
    if (list === undefined) return undefined;
    options = [];
    list.forEach((option, index) => {
      const parsed = v.string(option, `options.${index}`);
      if (parsed !== undefined) options?.push(parsed);
    });
    if (options.length === 0) {
      v.issue("schema_error", "attribute.options must not be empty", "options");
      return undefined;
    }
  }
  if (type === "enum" && options === undefined) {
    v.issue("schema_error", "enum attributes must declare options", "options");
    return undefined;
  }

  let pattern: string | undefined;
  if (obj.pattern !== undefined) {
    pattern = v.string(obj.pattern, "pattern");
    if (pattern === undefined) return undefined;
  }

  return {
    key,
    label,
    type,
    required,
    ...(options === undefined ? {} : { options }),
    ...(pattern === undefined ? {} : { pattern }),
  };
}

function validateAssetType(v: Validator, value: unknown): TenantAssetType | undefined {
  const obj = v.object(value, "assetType");
  if (obj === undefined) return undefined;
  const key = v.string(obj.key, "key");
  const label = v.string(obj.label, "label");
  const qrFormat = v.string(obj.qrFormat, "qrFormat");
  const shortCodeFormat = v.string(obj.shortCodeFormat, "shortCodeFormat");
  const stickerSpec = v.string(obj.stickerSpec, "stickerSpec");
  const attributes: TenantAssetAttribute[] = [];
  v.each(obj.attributes, "attributes", (item) => {
    const attr = validateAttribute(v, item);
    if (attr !== undefined) attributes.push(attr);
  });
  if (
    key === undefined ||
    label === undefined ||
    qrFormat === undefined ||
    shortCodeFormat === undefined ||
    stickerSpec === undefined ||
    !Array.isArray(obj.attributes)
  ) {
    return undefined;
  }
  return { key, label, attributes, qrFormat, shortCodeFormat, stickerSpec };
}

function validateFeeRule(v: Validator, value: unknown): TenantFeeRule | undefined {
  const obj = v.object(value, "feeRule");
  if (obj === undefined) return undefined;
  const key = v.string(obj.key, "key");
  const assetTypeKey = v.string(obj.assetTypeKey, "assetTypeKey");
  const amountMinor = v.integer(obj.amountMinor, "amountMinor", { min: 0 });
  const effectiveFrom = v.string(obj.effectiveFrom, "effectiveFrom");
  if (effectiveFrom !== undefined && !isIsoDate(effectiveFrom)) {
    v.issue("schema_error", "feeRule.effectiveFrom must be YYYY-MM-DD", "effectiveFrom");
    return undefined;
  }
  if (obj.effectiveTo === undefined) {
    if (
      key === undefined ||
      assetTypeKey === undefined ||
      amountMinor === undefined ||
      effectiveFrom === undefined
    ) {
      return undefined;
    }
    return { key, assetTypeKey, amountMinor, effectiveFrom };
  }
  const effectiveTo = v.string(obj.effectiveTo, "effectiveTo");
  if (effectiveTo !== undefined && !isIsoDate(effectiveTo)) {
    v.issue("schema_error", "feeRule.effectiveTo must be YYYY-MM-DD", "effectiveTo");
    return undefined;
  }
  if (
    key === undefined ||
    assetTypeKey === undefined ||
    amountMinor === undefined ||
    effectiveFrom === undefined ||
    effectiveTo === undefined
  ) {
    return undefined;
  }
  return { key, assetTypeKey, amountMinor, effectiveFrom, effectiveTo };
}

function validateObligations(v: Validator, value: unknown): TenantObligationRules | undefined {
  const obj = v.object(value, "obligations");
  if (obj === undefined) return undefined;
  const model = v.enum(obj.model, "model", OBLIGATION_MODELS);
  const frequency = v.enum(obj.frequency, "frequency", OBLIGATION_FREQUENCIES);
  const prepaidAllowed = v.boolean(obj.prepaidAllowed, "prepaidAllowed");
  const arrearsPolicy = v.enum(obj.arrearsPolicy, "arrearsPolicy", ARREARS_POLICIES);
  const graceDays = v.integer(obj.graceDays, "graceDays", { min: 0 });
  const feeRules: TenantFeeRule[] = [];
  v.each(obj.feeRules, "feeRules", (item) => {
    const rule = validateFeeRule(v, item);
    if (rule !== undefined) feeRules.push(rule);
  });
  if (
    model === undefined ||
    frequency === undefined ||
    prepaidAllowed === undefined ||
    arrearsPolicy === undefined ||
    graceDays === undefined ||
    !Array.isArray(obj.feeRules)
  ) {
    return undefined;
  }
  if (model === "pay_per_use" && arrearsPolicy === "accrue") {
    v.issue(
      "schema_error",
      "obligations: pay_per_use cannot accrue arrears (idle days are never a debt)",
      "arrearsPolicy",
    );
    return undefined;
  }
  return { model, frequency, prepaidAllowed, arrearsPolicy, graceDays, feeRules };
}

function validateProvider(v: Validator, value: unknown): TenantProviderBinding | undefined {
  const obj = v.object(value, "provider");
  if (obj === undefined) return undefined;
  const port = v.string(obj.port, "port");
  const adapter = v.string(obj.adapter, "adapter");
  if (port === undefined || adapter === undefined) return undefined;
  const binding: {
    port: string;
    adapter: string;
    secrets?: Record<string, string>;
    options?: Record<string, string | number | boolean>;
  } = { port, adapter };
  if (obj.secrets !== undefined) {
    const secretsObj = v.object(obj.secrets, "secrets");
    if (secretsObj === undefined) return undefined;
    const secrets: Record<string, string> = {};
    for (const [k, val] of Object.entries(secretsObj)) {
      const parsed = v.string(val, `secrets.${k}`);
      if (parsed === undefined) return undefined;
      secrets[k] = parsed;
    }
    binding.secrets = secrets;
  }
  if (obj.options !== undefined) {
    const optionsObj = v.object(obj.options, "options");
    if (optionsObj === undefined) return undefined;
    const options: Record<string, string | number | boolean> = {};
    for (const [k, val] of Object.entries(optionsObj)) {
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
        options[k] = val;
      } else {
        v.issue(
          "schema_error",
          `provider.options.${k} must be string, number, or boolean`,
          `options.${k}`,
        );
        return undefined;
      }
    }
    binding.options = options;
  }
  return binding;
}

function validateMenuOption(v: Validator, value: unknown): TenantMenuOption | undefined {
  const obj = v.object(value, "menuOption");
  if (obj === undefined) return undefined;
  const key = v.string(obj.key, "key");
  const labelKey = v.string(obj.labelKey, "labelKey");
  if (key === undefined || labelKey === undefined) return undefined;
  if (obj.next === undefined) return { key, labelKey };
  const next = v.string(obj.next, "next");
  if (next === undefined) return undefined;
  return { key, labelKey, next };
}

function validateMenu(v: Validator, value: unknown): TenantMenu | undefined {
  const obj = v.object(value, "menu");
  if (obj === undefined) return undefined;
  const key = v.string(obj.key, "key");
  const promptKey = v.string(obj.promptKey, "promptKey");
  const options: TenantMenuOption[] = [];
  v.each(obj.options, "options", (item) => {
    const option = validateMenuOption(v, item);
    if (option !== undefined) options.push(option);
  });
  if (key === undefined || promptKey === undefined || !Array.isArray(obj.options)) {
    return undefined;
  }
  return { key, promptKey, options };
}

function validateChannels(v: Validator, value: unknown): TenantChannels | undefined {
  const obj = v.object(value, "channels");
  if (obj === undefined) return undefined;
  const ussdCode = v.string(obj.ussdCode, "ussdCode");
  const smsKeyword = v.string(obj.smsKeyword, "smsKeyword");
  const otpMessageTemplate = v.string(obj.otpMessageTemplate, "otpMessageTemplate");
  if (otpMessageTemplate !== undefined && !otpMessageTemplate.includes("{code}")) {
    v.issue(
      "schema_error",
      "channels.otpMessageTemplate must contain the {code} placeholder",
      "otpMessageTemplate",
    );
    return undefined;
  }
  const menus: TenantMenu[] = [];
  v.each(obj.menus, "menus", (item) => {
    const menu = validateMenu(v, item);
    if (menu !== undefined) menus.push(menu);
  });
  if (
    ussdCode === undefined ||
    smsKeyword === undefined ||
    otpMessageTemplate === undefined ||
    !Array.isArray(obj.menus)
  ) {
    return undefined;
  }
  return { ussdCode, smsKeyword, otpMessageTemplate, menus };
}

function validateCashRules(v: Validator, value: unknown): TenantCashRules | undefined {
  const obj = v.object(value, "cashRules");
  if (obj === undefined) return undefined;
  const enabled = v.boolean(obj.enabled, "enabled");
  const floatCeilingMinor = v.integer(obj.floatCeilingMinor, "floatCeilingMinor", { min: 0 });
  const depositDeadlineHours = v.integer(obj.depositDeadlineHours, "depositDeadlineHours", {
    min: 0,
  });
  const freezeOnShortfall = v.boolean(obj.freezeOnShortfall, "freezeOnShortfall");
  if (
    enabled === undefined ||
    floatCeilingMinor === undefined ||
    depositDeadlineHours === undefined ||
    freezeOnShortfall === undefined
  ) {
    return undefined;
  }
  return { enabled, floatCeilingMinor, depositDeadlineHours, freezeOnShortfall };
}

function validateFeatureFlags(v: Validator, value: unknown): TenantFeatureFlags | undefined {
  const obj = v.object(value, "featureFlags");
  if (obj === undefined) return undefined;
  const disputes = v.boolean(obj.disputes, "disputes");
  const prepay = v.boolean(obj.prepay, "prepay");
  const offlineMode = v.boolean(obj.offlineMode, "offlineMode");
  const anomalyAlerts = v.boolean(obj.anomalyAlerts, "anomalyAlerts");
  if (
    disputes === undefined ||
    prepay === undefined ||
    offlineMode === undefined ||
    anomalyAlerts === undefined
  ) {
    return undefined;
  }
  return { disputes, prepay, offlineMode, anomalyAlerts };
}

function validateReconciliation(v: Validator, value: unknown): TenantReconciliation | undefined {
  const obj = v.object(value, "reconciliation");
  if (obj === undefined) return undefined;
  const schedule = v.string(obj.schedule, "schedule");
  const toleranceMinor = v.integer(obj.toleranceMinor, "toleranceMinor", { min: 0 });
  const notifyRole = v.string(obj.notifyRole, "notifyRole");
  if (schedule === undefined || toleranceMinor === undefined || notifyRole === undefined) {
    return undefined;
  }
  return { schedule, toleranceMinor, notifyRole };
}

function validateCompliance(v: Validator, value: unknown): TenantCompliance | undefined {
  const obj = v.object(value, "compliance");
  if (obj === undefined) return undefined;
  const retentionDays = v.integer(obj.retentionDays, "retentionDays", { min: 0 });
  const dataResidency = v.string(obj.dataResidency, "dataResidency");
  const consentTextKey = v.string(obj.consentTextKey, "consentTextKey");
  if (retentionDays === undefined || dataResidency === undefined || consentTextKey === undefined) {
    return undefined;
  }
  return { retentionDays, dataResidency, consentTextKey };
}

/**
 * Validates a parsed config object. Collects every issue and throws a single
 * TenantConfigValidationError so operators can fix all problems in one pass.
 */
export function validateTenantConfig(input: unknown): TenantConfig {
  const root = new Validator();
  const rootObj = root.object(input, "tenant");
  if (rootObj === undefined) {
    throw new TenantConfigValidationError(root.issues);
  }

  const identity = validateIdentity(root.child("identity"), rootObj.identity);
  const locale = validateLocale(root.child("locale"), rootObj.locale);
  const branding = validateBranding(root.child("branding"), rootObj.branding);
  const assetTypes: TenantAssetType[] = [];
  root.each(rootObj.assetTypes, "assetTypes", (item) => {
    const assetType = validateAssetType(root.child("assetTypes"), item);
    if (assetType !== undefined) assetTypes.push(assetType);
  });
  const obligations = validateObligations(root.child("obligations"), rootObj.obligations);
  const providers: TenantProviderBinding[] = [];
  root.each(rootObj.providers, "providers", (item) => {
    const provider = validateProvider(root.child("providers"), item);
    if (provider !== undefined) providers.push(provider);
  });
  const channels = validateChannels(root.child("channels"), rootObj.channels);
  const cashRules = validateCashRules(root.child("cashRules"), rootObj.cashRules);
  const featureFlags = validateFeatureFlags(root.child("featureFlags"), rootObj.featureFlags);
  const reconciliation = validateReconciliation(
    root.child("reconciliation"),
    rootObj.reconciliation,
  );
  const compliance = validateCompliance(root.child("compliance"), rootObj.compliance);

  const assetTypeKeys = new Set(assetTypes.map((a) => a.key));
  if (assetTypes.length === 0 && Array.isArray(rootObj.assetTypes)) {
    root.issue("schema_error", "assetTypes must define at least one asset type", "assetTypes");
  }
  if (obligations !== undefined) {
    for (const rule of obligations.feeRules) {
      if (!assetTypeKeys.has(rule.assetTypeKey)) {
        root.issue(
          "invalid_reference",
          `obligations.feeRules references unknown assetTypeKey '${rule.assetTypeKey}'`,
          "feeRules",
        );
      }
    }
  }

  if (root.issues.length > 0) {
    throw new TenantConfigValidationError(root.issues);
  }
  if (
    identity === undefined ||
    locale === undefined ||
    branding === undefined ||
    obligations === undefined ||
    channels === undefined ||
    cashRules === undefined ||
    featureFlags === undefined ||
    reconciliation === undefined ||
    compliance === undefined
  ) {
    // Unreachable: any undefined above already contributed an issue.
    throw new TenantConfigError("schema_error", "Unexpected empty configuration", "");
  }

  return {
    identity,
    locale,
    branding,
    assetTypes,
    obligations,
    providers,
    channels,
    cashRules,
    featureFlags,
    reconciliation,
    compliance,
  };
}
