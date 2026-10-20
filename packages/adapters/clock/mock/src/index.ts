import type { Clock } from "@tpirs/ports";

export interface MockClockOptions {
  readonly now?: Date;
}

/** System-backed clock by default; pass `now` for a fixed test time. */
export function createMockClock(options: MockClockOptions = {}): Clock {
  const fixed = options.now;
  return {
    now(): Date {
      return fixed === undefined ? new Date() : new Date(fixed.getTime());
    },
  };
}
