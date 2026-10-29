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

/**
 * Adds whole months, clamping the day to the last day of the target month so
 * 2026-01-31 plus one month is 2026-02-28 rather than an invalid date.
 */
export function addMonths(date: BusinessDate, months: number): BusinessDate {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const targetMonthIndex = month - 1 + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const shifted = new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay)));
  return businessDate(shifted.toISOString().slice(0, 10));
}

export function compareBusinessDates(a: BusinessDate, b: BusinessDate): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export interface BusinessDayRange {
  /** The first instant of the business day in the tenant's timezone. */
  readonly start: Date;
  /**
   * The first instant *after* the business day. A day is the half-open range
   * `[start, endExclusive)`, so every instant converts to exactly one day.
   */
  readonly endExclusive: Date;
}

/**
 * Offset of `timeZone` at one instant, in milliseconds east of UTC.
 *
 * `hourCycle: "h23"` keeps midnight a 0 rather than a 24, which some locale
 * formatters would otherwise emit and break the UTC arithmetic.
 */
function zonedOffsetMs(timeZone: string, instant: Date, date: BusinessDate): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const pick = (type: string): number | undefined =>
    Number(parts.find((part) => part.type === type)?.value);
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  const hour = pick("hour");
  const minute = pick("minute");
  const second = pick("second");
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    throw new InvalidBusinessDateError(date, `Cannot format instants in timezone "${timeZone}"`);
  }
  return Date.UTC(year, month - 1, day, hour, minute, second) - instant.getTime();
}

/**
 * Converts a business date in a timezone to the UTC instants that bound it.
 *
 * Reconciliation needs this to fetch settlement rows, ledger transactions and
 * other timestamped records that belong to one tenant business day. The naive
 * timestamp `date T 00:00:00Z` is guessed, then corrected twice through the
 * zone's actual offset at each candidate instant, which converges across
 * half-hour zones, whole-day offsets and DST moves.
 */
export function businessDayRange(timeZone: string, date: BusinessDate): BusinessDayRange {
  const zonedStart = (day: BusinessDate): Date => {
    const naive = Date.parse(`${day}T00:00:00Z`);
    let candidate = naive;
    for (let step = 0; step < 5; step += 1) {
      const offset = zonedOffsetMs(timeZone, new Date(candidate), day);
      const next = naive - offset;
      if (next === candidate) break;
      candidate = next;
    }
    if (todayInTimeZone(timeZone, new Date(candidate)) !== day) {
      throw new InvalidBusinessDateError(
        date,
        `Cannot locate 00:00 of ${day} in timezone "${timeZone}"`,
      );
    }
    return new Date(candidate);
  };
  return { start: zonedStart(date), endExclusive: zonedStart(addDays(date, 1)) };
}
