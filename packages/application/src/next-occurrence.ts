import { CronExpressionParser } from "cron-parser";

/**
 * The next instant `schedule` fires strictly after `after`, in `timeZone`.
 *
 * This is the only file that knows `cron-parser` exists (D48/ADR 0040), so
 * replacing the library — or moving to a managed scheduler — is a one-file
 * change. The expression itself is validated structurally when the tenant
 * config loads, so a malformed schedule never reaches this function in
 * production; a missing occurrence (a date that never arrives, an exhausted
 * span) returns undefined rather than throwing at 02:00.
 */
export function nextOccurrence(schedule: string, after: Date, timeZone: string): Date | undefined {
  try {
    const expression = CronExpressionParser.parse(schedule, {
      currentDate: after,
      tz: timeZone,
    });
    return expression.next().toDate();
  } catch {
    return undefined;
  }
}
