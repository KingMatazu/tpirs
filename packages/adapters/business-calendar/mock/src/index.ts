import { todayInTimeZone } from "@tpirs/domain";
import type { BusinessCalendar } from "@tpirs/ports";

export interface MockBusinessCalendarOptions {
  /** Holiday dates in YYYY-MM-DD format. Weekends are always non-business days. */
  readonly holidays?: readonly string[];
}

export function createMockBusinessCalendar(
  options: MockBusinessCalendarOptions = {},
): BusinessCalendar {
  const holidays = new Set(options.holidays ?? []);

  function isWeekend(date: string): boolean {
    const [year, month, day] = date.split("-").map(Number) as [number, number, number];
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return weekday === 0 || weekday === 6;
  }

  return {
    businessDay(instant, timeZone) {
      return todayInTimeZone(timeZone, instant);
    },
    isBusinessDay(date, _timeZone) {
      return !isWeekend(date) && !holidays.has(date);
    },
  };
}
