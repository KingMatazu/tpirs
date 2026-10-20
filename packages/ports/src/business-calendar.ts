import type { BusinessDate } from "@tpirs/domain";

export interface BusinessCalendar {
  /** Business day for an instant in the given tenant timezone. */
  businessDay(instant: Date, timeZone: string): BusinessDate;
  /** True when the date is a working day (not weekend/holiday) for the tenant. */
  isBusinessDay(date: BusinessDate, timeZone: string): boolean;
}
