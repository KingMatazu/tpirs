import { InvalidBusinessDateError } from "./errors.js";

const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

declare const businessDateBrand: unique symbol;

export type BusinessDate = string & { readonly [businessDateBrand]: true };

export function businessDate(value: string): BusinessDate {
  if (!BUSINESS_DATE_PATTERN.test(value)) {
    throw new InvalidBusinessDateError(value, `Business date "${value}" must match YYYY-MM-DD`);
  }
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const isRealDate =
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
  if (!isRealDate) {
    throw new InvalidBusinessDateError(
      value,
      `Business date "${value}" is not a real calendar date`,
    );
  }
  return value as BusinessDate;
}

export function todayInTimeZone(timeZone: string, now: Date): BusinessDate {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return businessDate(formatter.format(now));
}

export function addDays(date: BusinessDate, days: number): BusinessDate {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return businessDate(shifted.toISOString().slice(0, 10));
}

export function compareBusinessDates(a: BusinessDate, b: BusinessDate): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
