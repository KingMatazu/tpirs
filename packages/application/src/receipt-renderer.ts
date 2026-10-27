/**
 * Renders the SMS text a driver receives, from tenant config only.
 *
 * The template is data: `channels.smsReceiptTemplate` is validated at config
 * load time to contain exactly `{amount}`, `{assetRef}`, `{date}` and
 * `{receiptNo}`, so rendering here cannot fail on a typo - it only has to fill
 * placeholders that are known to exist. Amounts and dates are formatted with
 * the tenant's own locale, never with a hardcoded pattern, because the same
 * codebase serves states with different currencies and date conventions.
 */

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Substitutes `{name}` placeholders with the supplied values.
 *
 * Every expected name must be present: a missing value is a programming error
 * (the config guarantees the placeholder), not something to paper over with an
 * empty string that would reach a driver.
 */
export function renderPlaceholders(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  let rendered = template;
  for (const [name, value] of Object.entries(values)) {
    // A function replacer rather than a string: a value containing `$&` or `$1`
    // must reach the driver literally, not be reinterpreted as a pattern.
    rendered = rendered.replaceAll(new RegExp(`\\{${escapeRegExp(name)}\\}`, "g"), () => value);
  }
  return rendered;
}

/**
 * Formats minor units for display using the tenant's locale.
 *
 * Minor-unit exponents are read from `Intl`, which knows that NGN has two
 * decimal places and that JPY has none, so no exponent is assumed here.
 */
export function formatMinor(amountMinor: bigint, currency: string, locale: string): string {
  const exponent = minorUnitExponent(currency);
  const divisor = 10 ** exponent;
  const major = Number(amountMinor) / divisor;
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(major);
  } catch {
    // An unknown currency code must not cost the driver a receipt: fall back to
    // a plain number with the code, still using the tenant's number format.
    return `${new Intl.NumberFormat(locale).format(major)} ${currency}`;
  }
}

/** Decimal places for an ISO currency, defaulting to 2 when unknown to `Intl`. */
export function minorUnitExponent(currency: string): number {
  try {
    const resolved = new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions();
    return resolved.maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * Formats a business date for display using the tenant's date order.
 *
 * `dateFormat` is a DD/MM/YYYY-style token string (see the config schema) and
 * says which of day and month comes first; the tenant's locale supplies the
 * separator and any month-name style. An unparseable date or pattern falls back
 * to the ISO value rather than throwing on the receipt path.
 */
export function formatBusinessDate(
  businessDate: string,
  locale: string,
  dateFormat: string,
): string {
  const [year, month, day] = businessDate.split("-").map(Number) as [number, number, number];
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return businessDate;
  }
  const normalised = dateFormat.toUpperCase();
  const dayBeforeMonth = normalised.indexOf("D") < normalised.indexOf("M");
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    ...(dayBeforeMonth
      ? { day: "2-digit", month: "2-digit" }
      : { month: "2-digit", day: "2-digit" }),
    timeZone: "UTC",
  };
  try {
    return new Intl.DateTimeFormat(locale, options).format(
      new Date(Date.UTC(year, month - 1, day)),
    );
  } catch {
    return businessDate;
  }
}

export interface ReceiptTemplateInput {
  readonly template: string;
  /** Amount in minor units, as stored. */
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly locale: string;
  readonly dateFormat: string;
  /** What the driver recognises the asset by: plate or short code. */
  readonly assetRef: string;
  readonly receiptNumber: string;
  readonly businessDate: string;
}

/** Renders the receipt SMS for an applied payment. */
export function renderReceiptSms(input: ReceiptTemplateInput): string {
  return renderPlaceholders(input.template, {
    amount: formatMinor(input.amountMinor, input.currency, input.locale),
    assetRef: input.assetRef,
    date: formatBusinessDate(input.businessDate, input.locale, input.dateFormat),
    receiptNo: input.receiptNumber,
  });
}

/**
 * The template a tenant gets when it does not configure
 * `channels.cashReceiptTemplate` (D38). The payment receipt template is not
 * reused: a cash intake is not a gateway payment, and a tenant that wants
 * different copy can set its own.
 */
export const DEFAULT_CASH_RECEIPT_TEMPLATE =
  "Cash received for {assetRef}: {amount}. Receipt {receiptNo}, {date}.";

export interface CashReceiptTemplateInput extends Omit<ReceiptTemplateInput, "template"> {
  /** Tenant-configured template; omitted means the built-in default. */
  readonly template?: string;
}

/** Renders the receipt SMS for a collector cash intake. */
export function renderCashReceiptSms(input: CashReceiptTemplateInput): string {
  return renderReceiptSms({ template: input.template ?? DEFAULT_CASH_RECEIPT_TEMPLATE, ...input });
}

export interface UnderpaymentNoticeInput {
  /** What is still owed for the day, in minor units. */
  readonly shortfallMinor: bigint;
  readonly currency: string;
  readonly locale: string;
  /** What the driver recognises the asset by: plate or short code. */
  readonly assetRef: string;
  /** Tenant branding, used verbatim so no state-specific copy lives in code. */
  readonly receiptHeader: string;
}

/**
 * Renders the shortfall notice.
 *
 * The exact shortfall is always stated: a driver who paid part of the fee must
 * learn what remains, or the next payment will be short again.
 */
export function renderUnderpaymentNoticeSms(input: UnderpaymentNoticeInput): string {
  const amount = formatMinor(input.shortfallMinor, input.currency, input.locale);
  const body = `Short payment received for ${input.assetRef}. Still due: ${amount}.`;
  const header = input.receiptHeader.trim();
  return header === "" ? body : `${header} ${body}`;
}

/** The placeholders `channels.smsReceiptTemplate` is validated to contain. */
export const RECEIPT_TEMPLATE_PLACEHOLDERS = ["amount", "assetRef", "date", "receiptNo"] as const;
