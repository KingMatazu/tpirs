import type { UssdAction } from "@tpirs/domain";
import { SETTLEMENT_DATE_PATTERNS } from "@tpirs/domain";
import { ACTION_MESSAGE_KEYS, OPERATIONAL_MESSAGE_KEYS } from "./channel-contract.js";
import { cronExpressionError } from "./cron.js";
import { TenantConfigError, TenantConfigValidationError } from "./errors.js";
import type {
  AllocationOrder,
  ArrearsPolicy,
  ObligationFrequency,
  ObligationModel,
  TenantAnomalyRule,
  TenantAnomalyRuleKey,
  TenantAnomalySeverity,
  TenantAssetAttribute,
  TenantAssetType,
  TenantBranding,
  TenantCashRules,
  TenantChannels,
  TenantCompliance,
  TenantConfig,
  TenantDisputeReason,
  TenantFeatureFlags,
  TenantFeeRule,
  TenantFieldSettings,
  TenantIdentity,
  TenantLocale,
  TenantMenu,
  TenantMenuOption,
  TenantMessages,
  TenantObligationRules,
  TenantPayments,
  TenantProviderBinding,
  TenantReconciliation,
  TenantSettlementColumns,
  TenantSettlementImport,
  TenantSmsSettings,
  TenantUssdSettings,
  UnderpaymentPolicy,
} from "./schema.js";
import { TENANT_ANOMALY_RULE_KEYS } from "./schema.js";
import { Validator } from "./validator.js";

const OBLIGATION_MODELS: readonly ObligationModel[] = ["pay_per_use", "scheduled"];
const OBLIGATION_FREQUENCIES: readonly ObligationFrequency[] = ["daily", "weekly", "monthly"];
const ARREARS_POLICIES: readonly ArrearsPolicy[] = ["none", "accrue"];
const ALLOCATION_ORDERS: readonly AllocationOrder[] = ["oldest_first", "today_first"];
const DEFAULT_ALLOCATION_ORDER: AllocationOrder = "oldest_first";
const UNDERPAYMENT_POLICIES: readonly UnderpaymentPolicy[] = ["wallet", "suspense"];
const DEFAULT_UNDERPAYMENT_POLICY: UnderpaymentPolicy = "wallet";
const ATTRIBUTE_TYPES = ["string", "number", "date", "enum"] as const;
const MENU_NODE_TYPES = ["menu", "input", "action"] as const;
const USSD_ACTIONS: readonly UssdAction[] = ["status", "pay", "pay_from_balance", "cancel"];

/** Rules that compare a rate against a trailing mean, and so need a percent. */
const PERCENT_ANOMALY_RULES: readonly TenantAnomalyRuleKey[] = [
  "collector_volume_drop",
  "zone_compliance_drop",
  "officer_scan_volume_change",
];
const ANOMALY_SEVERITIES: readonly TenantAnomalySeverity[] = ["warning", "info"];
const DECIMAL_SEPARATORS = [".", ","] as const;

/**
 * Conservative technical defaults. Operations limits are configuration, not
 * code: a tenant can raise or lower them without a deployment.
 */
const DEFAULT_USSD_SETTINGS: TenantUssdSettings = {
  sessionTimeoutSeconds: 180,
  maxInputLength: 32,
  maxSteps: 12,
  rateLimit: { perMsisdnPerMinute: 20, perIpPerMinute: 120 },
};

const DEFAULT_SMS_SETTINGS: TenantSmsSettings = {
  maxSendsPerDay: 5000,
  maxSendsPerRecipientPerDay: 10,
  rateLimit: { perMsisdnPerMinute: 6 },
};

/**
 * Placeholders the receipt renderer fills. A template must use all of them and
 * nothing else: an unknown name would reach a driver as a literal `{typo}`.
 */
const RECEIPT_PLACEHOLDERS = ["amount", "assetRef", "date", "receiptNo"] as const;

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
  const assetTypeKey =
    obj.assetTypeKey === undefined ? undefined : v.string(obj.assetTypeKey, "assetTypeKey");
  const amountMinor = v.integer(obj.amountMinor, "amountMinor", { min: 0 });
  const effectiveFrom = v.string(obj.effectiveFrom, "effectiveFrom");
  if (effectiveFrom !== undefined && !isIsoDate(effectiveFrom)) {
    v.issue("schema_error", "feeRule.effectiveFrom must be YYYY-MM-DD", "effectiveFrom");
    return undefined;
  }
  if (obj.effectiveTo === undefined) {
    if (key === undefined || amountMinor === undefined || effectiveFrom === undefined) {
      return undefined;
    }
    return {
      key,
      ...(assetTypeKey === undefined ? {} : { assetTypeKey }),
      amountMinor,
      effectiveFrom,
    };
  }
  const effectiveTo = v.string(obj.effectiveTo, "effectiveTo");
  if (effectiveTo !== undefined && !isIsoDate(effectiveTo)) {
    v.issue("schema_error", "feeRule.effectiveTo must be YYYY-MM-DD", "effectiveTo");
    return undefined;
  }
  if (key === undefined || amountMinor === undefined || effectiveFrom === undefined) {
    return undefined;
  }
  if (effectiveTo === undefined) {
    return undefined;
  }
  return {
    key,
    ...(assetTypeKey === undefined ? {} : { assetTypeKey }),
    amountMinor,
    effectiveFrom,
    effectiveTo,
  };
}

/** Scope key for rules that price every asset type. */
const DEFAULT_FEE_SCOPE = "*";

/** Treats a rule without an end date as running to the end of time. */
const OPEN_ENDED_DATE = "9999-12-31";

function feeRuleWindowEnd(rule: TenantFeeRule): string {
  return rule.effectiveTo ?? OPEN_ENDED_DATE;
}

function feeRulesOverlap(a: TenantFeeRule, b: TenantFeeRule): boolean {
  return a.effectiveFrom <= feeRuleWindowEnd(b) && b.effectiveFrom <= feeRuleWindowEnd(a);
}

/**
 * Fee rules for the same scope must not overlap: the engine resolves a single
 * rule per asset type and date, so an overlap is an ambiguous price. It is
 * rejected at load time rather than silently resolved at payment time.
 */
function validateFeeRuleWindows(v: Validator, feeRules: readonly TenantFeeRule[]): void {
  const byScope = new Map<string, TenantFeeRule[]>();
  for (const rule of feeRules) {
    if (rule.effectiveTo !== undefined && rule.effectiveTo < rule.effectiveFrom) {
      v.issue(
        "schema_error",
        `obligations.feeRules: rule '${rule.key}' ends before it starts`,
        "feeRules",
      );
      continue;
    }
    const scope = rule.assetTypeKey ?? DEFAULT_FEE_SCOPE;
    const bucket = byScope.get(scope);
    if (bucket === undefined) {
      byScope.set(scope, [rule]);
    } else {
      bucket.push(rule);
    }
  }

  for (const [scope, bucket] of byScope) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i];
        const b = bucket[j];
        if (a === undefined || b === undefined) continue;
        if (feeRulesOverlap(a, b)) {
          v.issue(
            "schema_error",
            `obligations.feeRules: rules '${a.key}' and '${b.key}' overlap for scope '${scope}'`,
            "feeRules",
          );
        }
      }
    }
  }
}

function validateObligations(v: Validator, value: unknown): TenantObligationRules | undefined {
  const obj = v.object(value, "obligations");
  if (obj === undefined) return undefined;
  const model = v.enum(obj.model, "model", OBLIGATION_MODELS);
  const frequency = v.enum(obj.frequency, "frequency", OBLIGATION_FREQUENCIES);
  const prepaidAllowed = v.boolean(obj.prepaidAllowed, "prepaidAllowed");
  const arrearsPolicy = v.enum(obj.arrearsPolicy, "arrearsPolicy", ARREARS_POLICIES);
  const allocationOrder =
    obj.allocationOrder === undefined
      ? DEFAULT_ALLOCATION_ORDER
      : v.enum(obj.allocationOrder, "allocationOrder", ALLOCATION_ORDERS);
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
    allocationOrder === undefined ||
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
  validateFeeRuleWindows(v, feeRules);
  return {
    model,
    frequency,
    prepaidAllowed,
    arrearsPolicy,
    allocationOrder,
    graceDays,
    feeRules,
  };
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

function validateMessagePlaceholders(v: Validator, text: string, key: string): void {
  for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
    const name = match[1] ?? "";
    if (name.trim() === "") {
      v.issue("schema_error", `channels.${key} must not contain an empty placeholder`, key);
      return;
    }
  }
}

function validateMessages(
  v: Validator,
  value: unknown,
  enabledLanguages: readonly string[],
): TenantMessages | undefined {
  const obj = v.object(value, "messages");
  if (obj === undefined) return undefined;
  const messages: Record<string, Record<string, string>> = {};
  for (const [language, rawCatalog] of Object.entries(obj)) {
    if (!enabledLanguages.includes(language)) {
      v.issue(
        "invalid_reference",
        `channels.messages.${language} is not in locale.enabledLanguages`,
        `messages.${language}`,
      );
      continue;
    }
    const catalogObj = v.object(rawCatalog, `messages.${language}`);
    if (catalogObj === undefined) continue;
    const catalog: Record<string, string> = {};
    for (const [key, rawText] of Object.entries(catalogObj)) {
      if (typeof rawText !== "string" || rawText.trim() === "") {
        v.issue(
          "schema_error",
          `channels.messages.${language}.${key} must be a non-empty string`,
          `messages.${language}.${key}`,
        );
        continue;
      }
      validateMessagePlaceholders(v, rawText, `messages.${language}.${key}`);
      catalog[key] = rawText;
    }
    messages[language] = catalog;
  }
  return messages;
}

function validateMenuOption(v: Validator, value: unknown): TenantMenuOption | undefined {
  const obj = v.object(value, "menuOption");
  if (obj === undefined) return undefined;
  const key = v.string(obj.key, "key");
  const labelKey = v.string(obj.labelKey, "labelKey");
  if (key === undefined || labelKey === undefined) return undefined;
  const hasNext = obj.next !== undefined;
  const hasAction = obj.action !== undefined;
  if (hasNext === hasAction) {
    v.issue("schema_error", "menu options must have exactly one of next or action", "option");
    return undefined;
  }
  if (hasNext) {
    const next = v.string(obj.next, "next");
    if (next === undefined) return undefined;
    return { key, labelKey, next };
  }
  const action = v.enum(obj.action, "action", USSD_ACTIONS);
  if (action === undefined) return undefined;
  return { key, labelKey, action };
}

function validateUssdInput(
  v: Validator,
  value: unknown,
): { readonly key: string; readonly pattern?: string; readonly errorKey: string } | undefined {
  const obj = v.object(value, "input");
  if (obj === undefined) return undefined;
  const key = v.string(obj.key, "input.key");
  const errorKey = v.string(obj.errorKey, "input.errorKey");
  let pattern: string | undefined;
  if (obj.pattern !== undefined) {
    const parsed = v.string(obj.pattern, "input.pattern");
    if (parsed === undefined) return undefined;
    try {
      new RegExp(parsed);
    } catch {
      v.issue(
        "schema_error",
        "channels.input.pattern must be a valid regular expression",
        "input.pattern",
      );
      return undefined;
    }
    pattern = parsed;
  }
  if (key === undefined || errorKey === undefined) return undefined;
  return pattern === undefined ? { key, errorKey } : { key, errorKey, pattern };
}

function validateMenuNode(v: Validator, value: unknown): TenantMenu | undefined {
  const obj = v.object(value, "menu");
  if (obj === undefined) return undefined;
  const key = v.string(obj.key, "key");
  if (key === undefined) return undefined;

  const explicitType =
    obj.type === undefined ? undefined : v.enum(obj.type, "type", MENU_NODE_TYPES);
  const inferredType =
    explicitType ??
    (obj.input !== undefined ? "input" : obj.action !== undefined ? "action" : "menu");

  if (inferredType === "action") {
    const action = v.enum(obj.action, "action", USSD_ACTIONS);
    if (action === undefined) return undefined;
    return { type: "action", key, action };
  }

  if (inferredType === "input") {
    const promptKey = v.string(obj.promptKey, "promptKey");
    const next = v.string(obj.next, "next");
    const input = validateUssdInput(v, obj.input);
    if (promptKey === undefined || next === undefined || input === undefined) return undefined;
    return { type: "input", key, promptKey, input, next };
  }

  const promptKey = v.string(obj.promptKey, "promptKey");
  const invalidKey =
    obj.invalidKey === undefined ? undefined : v.string(obj.invalidKey, "invalidKey");
  const options: TenantMenuOption[] = [];
  if (!Array.isArray(obj.options)) {
    v.issue("schema_error", "menu options must be an array", "options");
    return undefined;
  }
  v.each(obj.options, "options", (item) => {
    const option = validateMenuOption(v, item);
    if (option !== undefined) options.push(option);
  });
  if (promptKey === undefined) return undefined;
  if (options.length === 0) {
    v.issue("schema_error", "menu must define at least one option", "options");
    return undefined;
  }
  return invalidKey === undefined
    ? { type: "menu", key, promptKey, options }
    : { type: "menu", key, promptKey, invalidKey, options };
}

function requireMessage(
  v: Validator,
  messages: TenantMessages | undefined,
  key: string,
  enabledLanguages: readonly string[],
): void {
  if (messages === undefined) return;
  for (const language of enabledLanguages) {
    if (messages[language]?.[key] === undefined) {
      v.issue(
        "invalid_reference",
        `message '${key}' is missing for language '${language}'`,
        `messages.${language}.${key}`,
      );
    }
  }
}

function validateUssdSettings(v: Validator, value: unknown): TenantUssdSettings | undefined {
  if (value === undefined) return DEFAULT_USSD_SETTINGS;
  const obj = v.object(value, "ussd");
  if (obj === undefined) return undefined;

  const sessionTimeoutSeconds =
    obj.sessionTimeoutSeconds === undefined
      ? DEFAULT_USSD_SETTINGS.sessionTimeoutSeconds
      : v.integer(obj.sessionTimeoutSeconds, "sessionTimeoutSeconds", { min: 30 });
  const maxInputLength =
    obj.maxInputLength === undefined
      ? DEFAULT_USSD_SETTINGS.maxInputLength
      : v.integer(obj.maxInputLength, "maxInputLength", { min: 1 });
  const maxSteps =
    obj.maxSteps === undefined
      ? DEFAULT_USSD_SETTINGS.maxSteps
      : v.integer(obj.maxSteps, "maxSteps", { min: 1 });

  let perMsisdnPerMinute = DEFAULT_USSD_SETTINGS.rateLimit.perMsisdnPerMinute;
  let perIpPerMinute = DEFAULT_USSD_SETTINGS.rateLimit.perIpPerMinute;
  if (obj.rateLimit !== undefined) {
    const rateLimit = v.object(obj.rateLimit, "rateLimit");
    if (rateLimit === undefined) return undefined;
    if (rateLimit.perMsisdnPerMinute !== undefined) {
      const parsed = v.integer(rateLimit.perMsisdnPerMinute, "rateLimit.perMsisdnPerMinute", {
        min: 1,
      });
      if (parsed === undefined) return undefined;
      perMsisdnPerMinute = parsed;
    }
    if (rateLimit.perIpPerMinute !== undefined) {
      const parsed = v.integer(rateLimit.perIpPerMinute, "rateLimit.perIpPerMinute", { min: 1 });
      if (parsed === undefined) return undefined;
      perIpPerMinute = parsed;
    }
  }

  if (
    sessionTimeoutSeconds === undefined ||
    maxInputLength === undefined ||
    maxSteps === undefined
  ) {
    return undefined;
  }
  return {
    sessionTimeoutSeconds,
    maxInputLength,
    maxSteps,
    rateLimit: { perMsisdnPerMinute, perIpPerMinute },
  };
}

function validateSmsSettings(v: Validator, value: unknown): TenantSmsSettings | undefined {
  if (value === undefined) return DEFAULT_SMS_SETTINGS;
  const obj = v.object(value, "sms");
  if (obj === undefined) return undefined;

  const maxSendsPerDay =
    obj.maxSendsPerDay === undefined
      ? DEFAULT_SMS_SETTINGS.maxSendsPerDay
      : v.integer(obj.maxSendsPerDay, "maxSendsPerDay", { min: 1 });
  const maxSendsPerRecipientPerDay =
    obj.maxSendsPerRecipientPerDay === undefined
      ? DEFAULT_SMS_SETTINGS.maxSendsPerRecipientPerDay
      : v.integer(obj.maxSendsPerRecipientPerDay, "maxSendsPerRecipientPerDay", { min: 1 });

  let perMsisdnPerMinute = DEFAULT_SMS_SETTINGS.rateLimit.perMsisdnPerMinute;
  if (obj.rateLimit !== undefined) {
    const rateLimit = v.object(obj.rateLimit, "rateLimit");
    if (rateLimit === undefined) return undefined;
    if (rateLimit.perMsisdnPerMinute !== undefined) {
      const parsed = v.integer(rateLimit.perMsisdnPerMinute, "rateLimit.perMsisdnPerMinute", {
        min: 1,
      });
      if (parsed === undefined) return undefined;
      perMsisdnPerMinute = parsed;
    }
  }

  if (maxSendsPerDay === undefined || maxSendsPerRecipientPerDay === undefined) {
    return undefined;
  }
  return {
    maxSendsPerDay,
    maxSendsPerRecipientPerDay,
    rateLimit: { perMsisdnPerMinute },
  };
}

function validateChannels(
  v: Validator,
  value: unknown,
  enabledLanguages: readonly string[],
  defaultLanguage: string,
): TenantChannels | undefined {
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
  const smsReceiptTemplate = v.string(obj.smsReceiptTemplate, "smsReceiptTemplate");
  if (smsReceiptTemplate !== undefined && !validateReceiptTemplate(v, smsReceiptTemplate)) {
    return undefined;
  }
  const cashReceiptTemplate =
    obj.cashReceiptTemplate === undefined
      ? undefined
      : v.string(obj.cashReceiptTemplate, "cashReceiptTemplate");
  if (
    obj.cashReceiptTemplate !== undefined &&
    cashReceiptTemplate !== undefined &&
    !validateReceiptTemplate(v, cashReceiptTemplate, "cashReceiptTemplate")
  ) {
    return undefined;
  }

  const messages =
    obj.messages === undefined ? {} : validateMessages(v, obj.messages, enabledLanguages);
  if (
    messages !== undefined &&
    Object.keys(messages).length > 0 &&
    messages[defaultLanguage] === undefined
  ) {
    v.issue(
      "invalid_reference",
      `channels.messages must include the default language '${defaultLanguage}'`,
      `messages.${defaultLanguage}`,
    );
  }

  const menus: TenantMenu[] = [];
  const menuKeys = new Set<string>();
  v.each(obj.menus, "menus", (item) => {
    const menu = validateMenuNode(v, item);
    if (menu === undefined) return;
    if (menuKeys.has(menu.key)) {
      v.issue("schema_error", `duplicate menu key '${menu.key}'`, `menus.${menu.key}`);
      return;
    }
    menuKeys.add(menu.key);
    menus.push(menu);
  });

  let startMenu: string | undefined;
  if (Array.isArray(obj.menus)) {
    if (menus.length === 0) {
      if (obj.startMenu !== undefined) {
        v.issue("invalid_reference", "channels.startMenu requires at least one menu", "startMenu");
      }
    } else if (obj.startMenu === undefined) {
      startMenu = menus[0]?.key;
    } else {
      const parsed = v.string(obj.startMenu, "startMenu");
      if (parsed !== undefined) {
        if (!menuKeys.has(parsed)) {
          v.issue(
            "invalid_reference",
            `channels.startMenu references unknown menu '${parsed}'`,
            "startMenu",
          );
        } else {
          startMenu = parsed;
        }
      }
    }
  }

  for (const menu of menus) {
    if (menu.type === "menu") {
      requireMessage(v, messages, menu.promptKey, enabledLanguages);
      if (menu.invalidKey !== undefined) {
        requireMessage(v, messages, menu.invalidKey, enabledLanguages);
      }
      const optionKeys = new Set<string>();
      for (const option of menu.options) {
        if (optionKeys.has(option.key)) {
          v.issue(
            "schema_error",
            `duplicate option key '${option.key}' in menu '${menu.key}'`,
            `menus.${menu.key}.options`,
          );
        }
        optionKeys.add(option.key);
        requireMessage(v, messages, option.labelKey, enabledLanguages);
        if (option.next !== undefined && !menuKeys.has(option.next)) {
          v.issue(
            "invalid_reference",
            `menu '${menu.key}' option '${option.key}' references unknown menu '${option.next}'`,
            `menus.${menu.key}.options.${option.key}`,
          );
        }
      }
    } else if (menu.type === "input") {
      requireMessage(v, messages, menu.promptKey, enabledLanguages);
      requireMessage(v, messages, menu.input.errorKey, enabledLanguages);
      if (!menuKeys.has(menu.next)) {
        v.issue(
          "invalid_reference",
          `input '${menu.key}' references unknown menu '${menu.next}'`,
          `menus.${menu.key}.next`,
        );
      }
    }
  }

  // A tenant that supplies a catalogue must be able to answer every path the
  // runtime can take, not only the prompts its own menu graph happens to use.
  // Operational keys cover rate limits, cancels, and malformed sessions; action
  // keys cover each action the graph can actually reach. A missing key is a
  // startup failure instead of a broken reply on a driver's phone.
  const hasCatalogue = messages !== undefined && Object.keys(messages).length > 0;
  if (hasCatalogue) {
    for (const key of OPERATIONAL_MESSAGE_KEYS) {
      requireMessage(v, messages, key, enabledLanguages);
    }
    const reachable = new Set<UssdAction>();
    for (const menu of menus) {
      if (menu.type === "action") {
        reachable.add(menu.action);
      } else if (menu.type === "menu") {
        for (const option of menu.options) {
          if (option.action !== undefined) reachable.add(option.action);
        }
      }
    }
    for (const action of reachable) {
      if (action === "cancel") continue;
      for (const key of ACTION_MESSAGE_KEYS[action]) {
        requireMessage(v, messages, key, enabledLanguages);
      }
    }
  }

  const ussd = validateUssdSettings(v, obj.ussd);
  const sms = validateSmsSettings(v, obj.sms);

  if (
    ussdCode === undefined ||
    smsKeyword === undefined ||
    otpMessageTemplate === undefined ||
    smsReceiptTemplate === undefined ||
    !Array.isArray(obj.menus) ||
    messages === undefined ||
    ussd === undefined ||
    sms === undefined
  ) {
    return undefined;
  }

  const channels: TenantChannels = {
    ussdCode,
    smsKeyword,
    otpMessageTemplate,
    smsReceiptTemplate,
    ...(cashReceiptTemplate === undefined ? {} : { cashReceiptTemplate }),
    menus,
    messages,
    ussd,
    sms,
  };
  return startMenu === undefined ? channels : { ...channels, startMenu };
}

/**
 * A receipt template must fill every placeholder the renderer knows about and
 * may not invent others. Catches `{amout}` at startup, not in a driver's inbox.
 */
function validateReceiptTemplate(
  v: Validator,
  template: string,
  key = "smsReceiptTemplate",
): boolean {
  const found = new Set<string>();
  for (const match of template.matchAll(/\{([^{}]*)\}/g)) {
    const name = match[1] ?? "";
    if (!(RECEIPT_PLACEHOLDERS as readonly string[]).includes(name)) {
      const allowed = RECEIPT_PLACEHOLDERS.map((p) => `{${p}}`).join(", ");
      v.issue(
        "schema_error",
        `channels.${key} has unknown placeholder '{${name}}'; allowed placeholders: ${allowed}`,
        key,
      );
      return false;
    }
    found.add(name);
  }
  const missing = RECEIPT_PLACEHOLDERS.filter((p) => !found.has(p));
  if (missing.length > 0) {
    const list = missing.map((p) => `{${p}}`).join(", ");
    v.issue(
      "schema_error",
      `channels.${key} must contain the ${list} placeholder${missing.length > 1 ? "s" : ""}`,
      key,
    );
    return false;
  }
  return true;
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

function validatePayments(v: Validator, value: unknown): TenantPayments | undefined {
  const obj = v.object(value, "payments");
  if (obj === undefined) return undefined;
  const underpaymentPolicy = v.enum(
    obj.underpaymentPolicy,
    "underpaymentPolicy",
    UNDERPAYMENT_POLICIES,
  );
  if (underpaymentPolicy === undefined) return undefined;
  return { underpaymentPolicy };
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

/** Stored as `disputes.reason`, so the shape is fixed rather than free text. */
const DISPUTE_REASON_CODE = /^[a-z][a-z0-9_]{1,31}$/;

function validateDisputeReason(v: Validator, value: unknown): TenantDisputeReason | undefined {
  const obj = v.object(value, "reason");
  if (obj === undefined) return undefined;
  const code = v.string(obj.code, "code");
  const label = v.string(obj.label, "label");
  if (code !== undefined && !DISPUTE_REASON_CODE.test(code)) {
    v.issue("schema_error", `field.disputeReasons code "${code}" must be lower snake case`, "code");
    return undefined;
  }
  if (code === undefined || label === undefined) return undefined;
  return { code, label };
}

/**
 * Officer field-app settings. The `other` reason is required because the app
 * must never force an officer to pick a wrong reason to record what they saw.
 */
function validateField(v: Validator, value: unknown): TenantFieldSettings | undefined {
  const obj = v.object(value, "field");
  if (obj === undefined) return undefined;
  // Scoped after the object check so an issue reads `field.offlineGraceHours`
  // rather than `field.field.offlineGraceHours`.
  const f = v.child("field");
  const offlineGraceHours = f.integer(obj.offlineGraceHours, "offlineGraceHours", {
    min: 1,
    max: 168,
  });
  const maxQueueItems = f.integer(obj.maxQueueItems, "maxQueueItems", { min: 1, max: 100_000 });

  const disputeReasons: TenantDisputeReason[] = [];
  const seen = new Set<string>();
  const items = f.array(obj.disputeReasons, "disputeReasons");
  items?.forEach((item, index) => {
    const reason = validateDisputeReason(f.child("disputeReasons"), item);
    if (reason === undefined) return;
    if (seen.has(reason.code)) {
      f.issue(
        "duplicate_key",
        `field.disputeReasons repeats "${reason.code}"; a reason may appear once`,
        `disputeReasons.${index}.code`,
      );
      return;
    }
    seen.add(reason.code);
    disputeReasons.push(reason);
  });
  if (items !== undefined) {
    if (items.length === 0) {
      f.issue(
        "schema_error",
        "field.disputeReasons must offer at least one reason",
        "disputeReasons",
      );
    } else if (!seen.has("other")) {
      f.issue(
        "schema_error",
        'field.disputeReasons must include an "other" reason as a fallback',
        "disputeReasons",
      );
    }
  }

  if (offlineGraceHours === undefined || maxQueueItems === undefined || items === undefined) {
    return undefined;
  }
  return { offlineGraceHours, maxQueueItems, disputeReasons };
}

/**
 * One anomaly rule. The threshold a rule needs depends on what it measures, so
 * the error names the rule rather than a generic "invalid threshold".
 */
function validateAnomalyRule(v: Validator, value: unknown): TenantAnomalyRule | undefined {
  const obj = v.object(value, "rule");
  if (obj === undefined) return undefined;

  const key = v.enum(obj.key, "key", TENANT_ANOMALY_RULE_KEYS);
  const enabled = v.boolean(obj.enabled, "enabled");
  const windowDays = v.integer(obj.windowDays, "windowDays", { min: 1, max: 365 });
  const severity = v.enum(obj.severity, "severity", ANOMALY_SEVERITIES);
  const thresholdPercent =
    obj.thresholdPercent === undefined
      ? undefined
      : v.number(obj.thresholdPercent, "thresholdPercent", { min: 0 });
  const thresholdMinor =
    obj.thresholdMinor === undefined
      ? undefined
      : v.integer(obj.thresholdMinor, "thresholdMinor", { min: 0 });

  if (
    key === undefined ||
    enabled === undefined ||
    windowDays === undefined ||
    severity === undefined
  ) {
    return undefined;
  }

  if (thresholdPercent !== undefined && thresholdPercent <= 0) {
    v.issue("schema_error", "thresholdPercent must be greater than zero", "thresholdPercent");
    return undefined;
  }
  // Thresholds are required only for an enabled rule: a disabled rule may be
  // parked in config while a tenant waits for pilot baselines, and enabling it
  // without a usable threshold still fails at the next load.
  if (enabled && PERCENT_ANOMALY_RULES.includes(key) && thresholdPercent === undefined) {
    v.issue(
      "schema_error",
      `anomaly rule "${key}" needs thresholdPercent because it compares a rate to its baseline`,
      "thresholdPercent",
    );
    return undefined;
  }
  if (enabled && key === "suspense_growth" && thresholdMinor === undefined) {
    v.issue(
      "schema_error",
      'anomaly rule "suspense_growth" needs thresholdMinor as its suspense ceiling',
      "thresholdMinor",
    );
    return undefined;
  }

  return {
    key,
    enabled,
    windowDays,
    severity,
    ...(thresholdPercent === undefined ? {} : { thresholdPercent }),
    ...(thresholdMinor === undefined ? {} : { thresholdMinor }),
  };
}

function validateSettlementColumns(
  v: Validator,
  value: unknown,
): TenantSettlementColumns | undefined {
  const obj = v.object(value, "columns");
  if (obj === undefined) return undefined;
  const reference = v.string(obj.reference, "reference");
  const amount = v.string(obj.amount, "amount");
  const settledAt = v.string(obj.settledAt, "settledAt");
  const fee = obj.fee === undefined ? undefined : v.string(obj.fee, "fee");
  const currency = obj.currency === undefined ? undefined : v.string(obj.currency, "currency");
  const description =
    obj.description === undefined ? undefined : v.string(obj.description, "description");
  if (reference === undefined || amount === undefined || settledAt === undefined) {
    return undefined;
  }
  return {
    reference,
    amount,
    settledAt,
    ...(fee === undefined ? {} : { fee }),
    ...(currency === undefined ? {} : { currency }),
    ...(description === undefined ? {} : { description }),
  };
}

function validateSettlementImport(
  v: Validator,
  value: unknown,
): TenantSettlementImport | undefined {
  const obj = v.object(value, "settlementImport");
  if (obj === undefined) return undefined;

  const provider = v.string(obj.provider, "provider");
  const columns = validateSettlementColumns(v.child("columns"), obj.columns);
  const dateFormat = v.enum(obj.dateFormat, "dateFormat", SETTLEMENT_DATE_PATTERNS);
  const amountInMinorUnits = v.boolean(obj.amountInMinorUnits, "amountInMinorUnits");
  const decimalSeparator =
    obj.decimalSeparator === undefined
      ? undefined
      : v.enum(obj.decimalSeparator, "decimalSeparator", DECIMAL_SEPARATORS);
  const defaultCurrency =
    obj.defaultCurrency === undefined
      ? undefined
      : v.string(obj.defaultCurrency, "defaultCurrency");

  if (defaultCurrency !== undefined && !/^[A-Z]{3}$/.test(defaultCurrency)) {
    v.issue(
      "schema_error",
      "settlementImport.defaultCurrency must be an ISO 4217 code",
      "defaultCurrency",
    );
    return undefined;
  }

  if (
    provider === undefined ||
    columns === undefined ||
    dateFormat === undefined ||
    amountInMinorUnits === undefined
  ) {
    return undefined;
  }

  return {
    provider,
    columns,
    dateFormat,
    amountInMinorUnits,
    ...(decimalSeparator === undefined ? {} : { decimalSeparator }),
    ...(defaultCurrency === undefined ? {} : { defaultCurrency }),
  };
}

function validateReconciliation(v: Validator, value: unknown): TenantReconciliation | undefined {
  const obj = v.object(value, "reconciliation");
  if (obj === undefined) return undefined;

  const enabled = obj.enabled === undefined ? true : v.boolean(obj.enabled, "enabled");
  const schedule = v.string(obj.schedule, "schedule");
  if (schedule !== undefined) {
    const cronError = cronExpressionError(schedule);
    if (cronError !== undefined) {
      v.issue(
        "schema_error",
        `reconciliation.schedule is not a valid cron: ${cronError}`,
        "schedule",
      );
      return undefined;
    }
  }

  const toleranceMinor = v.integer(obj.toleranceMinor, "toleranceMinor", { min: 0 });
  // Defaults: no fee slack, a week of suspense ageing, and every rule off.
  const feeToleranceMinor =
    obj.feeToleranceMinor === undefined
      ? 0
      : v.integer(obj.feeToleranceMinor, "feeToleranceMinor", { min: 0 });
  const suspenseAgeingDays =
    obj.suspenseAgeingDays === undefined
      ? 7
      : v.integer(obj.suspenseAgeingDays, "suspenseAgeingDays", { min: 0 });
  const notifyRole = v.string(obj.notifyRole, "notifyRole");

  const anomalyRules: TenantAnomalyRule[] = [];
  if (obj.anomalyRules !== undefined) {
    const items = v.array(obj.anomalyRules, "anomalyRules");
    const seen = new Set<string>();
    items?.forEach((item, index) => {
      const path = `anomalyRules.${index}`;
      const rule = validateAnomalyRule(v.child("anomalyRules"), item);
      if (rule === undefined) return;
      if (seen.has(rule.key)) {
        v.issue(
          "duplicate_key",
          `reconciliation.${path}.key repeats "${rule.key}"; a rule may appear once`,
          `${path}.key`,
        );
        return;
      }
      seen.add(rule.key);
      anomalyRules.push(rule);
    });
  }

  const settlementImport =
    obj.settlementImport === undefined
      ? undefined
      : validateSettlementImport(v.child("settlementImport"), obj.settlementImport);

  if (
    enabled === undefined ||
    schedule === undefined ||
    toleranceMinor === undefined ||
    feeToleranceMinor === undefined ||
    suspenseAgeingDays === undefined ||
    notifyRole === undefined
  ) {
    return undefined;
  }

  return {
    enabled,
    schedule,
    toleranceMinor,
    feeToleranceMinor,
    suspenseAgeingDays,
    notifyRole,
    anomalyRules,
    ...(settlementImport === undefined ? {} : { settlementImport }),
  };
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
  const channels = validateChannels(
    root.child("channels"),
    rootObj.channels,
    locale?.enabledLanguages ?? [],
    locale?.defaultLanguage ?? "",
  );
  const cashRules = validateCashRules(root.child("cashRules"), rootObj.cashRules);
  // Omitting the section means the default policy; a present but malformed
  // section is an error, never silently defaulted.
  const payments =
    rootObj.payments === undefined
      ? { underpaymentPolicy: DEFAULT_UNDERPAYMENT_POLICY }
      : validatePayments(root.child("payments"), rootObj.payments);
  const featureFlags = validateFeatureFlags(root.child("featureFlags"), rootObj.featureFlags);
  const field = validateField(root, rootObj.field);
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
    const hasDefaultRule = obligations.feeRules.some((rule) => rule.assetTypeKey === undefined);
    for (const rule of obligations.feeRules) {
      if (rule.assetTypeKey !== undefined && !assetTypeKeys.has(rule.assetTypeKey)) {
        root.issue(
          "invalid_reference",
          `obligations.feeRules references unknown assetTypeKey '${rule.assetTypeKey}'`,
          "feeRules",
        );
      }
    }
    if (obligations.feeRules.length === 0) {
      root.issue("schema_error", "obligations.feeRules must define at least one rule", "feeRules");
    }
    // Every declared asset type must be priceable: either by its own rule or by
    // a default rule that applies to all types.
    for (const key of assetTypeKeys) {
      const hasTypeRule = obligations.feeRules.some((rule) => rule.assetTypeKey === key);
      if (!hasTypeRule && !hasDefaultRule) {
        root.issue(
          "schema_error",
          `obligations.feeRules has no rule for asset type '${key}'`,
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
    payments === undefined ||
    featureFlags === undefined ||
    field === undefined ||
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
    payments,
    featureFlags,
    field,
    reconciliation,
    compliance,
  };
}
