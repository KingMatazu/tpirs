/**
 * Design tokens generated from a validated TenantConfig (ADR 0027).
 *
 * Components never read tenant branding or locale directly; they read the
 * tokens emitted here. Applying the token CSS block to `:root` re-themes the
 * whole dashboard per tenant with no component edits, and the Intl helpers
 * format money and dates exactly as the tenant's configuration prescribes.
 */

import type { TenantConfig } from "@tpirs/config";

/** CSS custom property name to value; names carry the `--tpirs-` prefix. */
export type TokenVariables = Readonly<Record<string, string>>;

export interface DesignTokens {
  readonly variables: TokenVariables;
  /** Convenience accessors kept typed so consumers avoid string lookups. */
  readonly branding: TenantConfig["branding"];
  readonly locale: TenantConfig["locale"];
}

const PREFIX = "--tpirs-";

/**
 * Builds the design-token map. Only configured values are emitted — the token
 * layer never invents colors; fallbacks live in the app's own CSS defaults.
 */
export function buildDesignTokens(config: {
  readonly branding: TenantConfig["branding"];
  readonly locale: TenantConfig["locale"];
}): DesignTokens {
  const { branding, locale } = config;
  return {
    variables: {
      [`${PREFIX}color-primary`]: branding.colors.primary,
      [`${PREFIX}color-secondary`]: branding.colors.secondary,
      [`${PREFIX}color-accent`]: branding.colors.accent,
      [`${PREFIX}sms-sender-id`]: branding.smsSenderId,
      [`${PREFIX}locale-currency`]: locale.currency,
      [`${PREFIX}locale-language`]: locale.defaultLanguage,
      [`${PREFIX}locale-timezone`]: locale.timezone,
    },
    branding,
    locale,
  };
}

/** Renders the tokens as a `:root { ... }` CSS block ready for injection. */
export function tokensToCssRoot(tokens: DesignTokens): string {
  const lines = Object.entries(tokens.variables)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
  return `:root {\n${lines}\n}`;
}

/** Number of fraction digits the currency renders with (kobo → 2, naira-only → 0). */
function currencyDigits(currency: string, locale: string): number {
  const options = new Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions();
  return options.maximumFractionDigits ?? 2;
}

/**
 * Formats an integer minor-unit amount as the tenant's currency, e.g.
 * `formatMoneyMinor(20000n, "NGN", "en-NG")` → "₦200.00". Amounts cross the API
 * as decimal strings, so strings and numbers are both accepted.
 */
export function formatMoneyMinor(
  amountMinor: bigint | number | string,
  currency: string,
  locale: string,
): string {
  const value = typeof amountMinor === "bigint" ? Number(amountMinor) : Number(amountMinor);
  const digits = currencyDigits(currency, locale);
  const divisor = 10 ** digits;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value / divisor);
}

/**
 * Formats a timestamp using the tenant's date token pattern (for example
 * `dd/MM/yyyy`). Recognised tokens: `yyyy`, `MM`, `dd` — any other characters
 * are preserved as literals. Zero padding is always applied for tokens.
 */
export function formatBusinessDate(
  value: Date | string | number,
  _locale: string,
  pattern: string,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError("invalid date");
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const replacements: Readonly<Record<string, string>> = { yyyy: year, MM: month, dd: day };
  return pattern.replace(/yyyy|MM|dd/g, (token) => replacements[token] ?? token);
}

/** Formats an instant for display (not a business day) using Intl, tenant-aware. */
export function formatTimestamp(
  value: Date | string | number,
  locale: string,
  timezone: string,
): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(date);
}
