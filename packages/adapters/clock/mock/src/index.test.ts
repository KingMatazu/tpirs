import { describe, expect, it } from "vitest";
import { createClockConformanceSuite } from "@tpirs/contracts";
import { createMockClock } from "./index.js";

createClockConformanceSuite({ describe, it, expect }, () => ({ port: createMockClock() }));

describe("createMockClock options", () => {
  it("returns the fixed time when provided", () => {
    const fixed = new Date("2026-01-01T00:00:00Z");
    const clock = createMockClock({ now: fixed });
    expect(clock.now().toISOString()).toBe(fixed.toISOString());
    expect(clock.now()).not.toBe(fixed);
  });
});
