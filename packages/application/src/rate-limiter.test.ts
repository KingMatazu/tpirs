import { describe, expect, it } from "vitest";
import { createMockCache } from "@tpirs/cache-mock";
import { createMockClock } from "@tpirs/clock-mock";
import { createRateLimiter } from "./rate-limiter.js";

describe("createRateLimiter", () => {
  it("allows requests up to the limit and counts remaining", async () => {
    const clock = createMockClock({ now: new Date("2026-01-01T00:00:00.000Z") });
    const limiter = createRateLimiter({ cache: createMockCache(), clock });
    const first = await limiter.consume("ip:1", { limit: 2, windowSeconds: 60 });
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(1);
    const second = await limiter.consume("ip:1", { limit: 2, windowSeconds: 60 });
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(0);
    const third = await limiter.consume("ip:1", { limit: 2, windowSeconds: 60 });
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("starts a new window for a different key", async () => {
    const clock = createMockClock({ now: new Date("2026-01-01T00:00:00.000Z") });
    const limiter = createRateLimiter({ cache: createMockCache(), clock });
    await limiter.consume("a", { limit: 1, windowSeconds: 60 });
    const denied = await limiter.consume("a", { limit: 1, windowSeconds: 60 });
    expect(denied.allowed).toBe(false);
    const allowed = await limiter.consume("b", { limit: 1, windowSeconds: 60 });
    expect(allowed.allowed).toBe(true);
  });
});
