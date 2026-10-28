import { DomainError } from "./errors.js";

/**
 * Normalisation rules for one settlement statement column mapping (ADR 0035).
 *
 * A statement is text produced by a bank, not a provider event: the numbers,
 * separators, dates and column order are whatever that bank chose. These
 * helpers are the one place that knowledge is turned into integer minor units
 * and instants, so the mock, the CSV adapter and any future adapter agree on
 * what a row means.
 */

/** Date shapes a statement column may use. All values are read as UTC. */
export type SettlementDatePattern =
  "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD HH:mm:ss" | "DD/MM/YYYY HH:mm:ss";

export const SETTLEMENT_DATE_PATTERNS: readonly SettlementDatePattern[] = [
  "YYYY-MM-DD",
  "DD/MM/YYYY",
  "MM/DD/YYYY",
  "YYYY-MM-DD HH:mm:ss",
  "DD/MM/YYYY HH:mm:ss",
];

export function isSettlementDatePattern(value: string): value is SettlementDatePattern {
  return (SETTLEMENT_DATE_PATTERNS as readonly string[]).includes(value);
}

export interface SettlementAmountRule {
  /** The column already holds minor units (`50000`), not a decimal (`500.00`). */
  readonly amountInMinorUnits: boolean;
  /** Which character separates the fraction. The other is a grouping mark. */
  readonly decimalSeparator: "." | ",";
}

/** Which field of a row failed to parse. Used by the rejection report. */
export type SettlementField = "reference" | "amount" | "fee" | "settled_at" | "currency";

export class InvalidSettlementRowError extends DomainError {
  readonly field: SettlementField;
  readonly reason: string;

  constructor(field: SettlementField, reason: string, message: string) {
    super(message);
    this.field = field;
    this.reason = reason;
  }
}

function invalid(field: SettlementField, reason: string, message: string): never {
  throw new InvalidSettlementRowError(field, reason, message);
}

/**
 * Parses a statement amount into integer minor units.
 *
 * Grouping marks are removed before the fraction is read, so `1,234.56` and
 * `1.234,56` both become `123456`. More than two fraction digits is a rejection
 * rather than a rounding: a statement the platform cannot represent exactly is
 * a question for finance, and rounding it would quietly change the money.
 */
export function parseSettlementAmountMinor(input: string, rule: SettlementAmountRule): bigint {
  const trimmed = input.trim();
  if (trimmed === "") invalid("amount", "empty", "amount is empty");

  const withoutSign = trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  if (withoutSign.startsWith("-")) {
    invalid("amount", "negative", "amount is negative; a settlement row must be a receipt");
  }

  const withoutSpaces = withoutSign.replaceAll(/[\s\u00a0]/g, "");
  // The separator that is *not* the decimal point is a grouping mark.
  const grouping = rule.decimalSeparator === "," ? /[.']/g : /[',]/g;
  let normalised = withoutSpaces.replaceAll(grouping, "");
  if (rule.decimalSeparator === ",") normalised = normalised.replace(",", ".");

  if (rule.amountInMinorUnits) {
    if (!/^\d+$/.test(normalised)) {
      invalid("amount", "not_minor_units", `"${input}" is not an integer amount in minor units`);
    }
    return BigInt(normalised);
  }

  const parts = normalised.split(".");
  if (parts.length > 2) {
    invalid("amount", "too_many_separators", `"${input}" has more than one decimal separator`);
  }
  const whole = parts[0] ?? "";
  const fraction = parts[1] ?? "";
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) {
    invalid("amount", "not_numeric", `"${input}" is not a decimal amount`);
  }
  if (fraction.length > 2) {
    invalid("amount", "too_many_decimals", `"${input}" has more than two decimal places`);
  }
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function calendarDateIsValid(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

/**
 * Parses a statement date column into an instant (UTC). A date without a time
 * is read as midnight UTC; statement dates carry no tenant timezone, so
 * inventing one would shift a row into the wrong business day.
 */
export function parseSettlementDate(input: string, pattern: SettlementDatePattern): Date {
  const text = input.trim();
  const withTime = pattern.includes("HH:mm:ss");

  const datePart = withTime ? (text.split(/\s+/)[0] ?? "") : text;
  const timeMatch = withTime ? /(\d{2}):(\d{2}):(\d{2})/.exec(text) : null;

  let year: number;
  let month: number;
  let day: number;

  if (pattern.startsWith("YYYY-MM-DD")) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
    if (match === null) invalid("settled_at", "bad_date", `"${input}" is not ${pattern}`);
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else if (pattern.startsWith("DD/MM/YYYY")) {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(datePart);
    if (match === null) invalid("settled_at", "bad_date", `"${input}" is not ${pattern}`);
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
  } else {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(datePart);
    if (match === null) invalid("settled_at", "bad_date", `"${input}" is not ${pattern}`);
    month = Number(match[1]);
    day = Number(match[2]);
    year = Number(match[3]);
  }

  if (!calendarDateIsValid(year, month, day)) {
    invalid("settled_at", "impossible_date", `"${input}" is not a real calendar date`);
  }

  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (withTime) {
    if (timeMatch === null) invalid("settled_at", "bad_time", `"${input}" has no time of day`);
    hours = Number(timeMatch[1]);
    minutes = Number(timeMatch[2]);
    seconds = Number(timeMatch[3]);
    if (hours > 23 || minutes > 59 || seconds > 59) {
      invalid("settled_at", "bad_time", `"${input}" has an impossible time of day`);
    }
  }

  return new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
}

/**
 * The canonical string a row hash is taken over.
 *
 * JSON rather than a delimited string, because a bank reference may contain any
 * punctuation and two different rows must never canonicalise to the same text.
 */
export function settlementRowKey(input: {
  readonly providerReference: string;
  readonly amountMinor: bigint;
  readonly feeMinor: bigint;
  readonly currency: string;
  readonly settledAt: Date;
}): string {
  return JSON.stringify([
    input.providerReference,
    input.amountMinor.toString(),
    input.feeMinor.toString(),
    input.currency,
    input.settledAt.toISOString(),
  ]);
}
