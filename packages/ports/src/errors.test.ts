import { describe, expect, it } from "vitest";
import { PortError } from "./errors.js";
import { withLock } from "./lock-service.js";
import type { Lock, LockService } from "./lock-service.js";

describe("PortError", () => {
  it("marks retryable codes by default", () => {
    expect(new PortError("SmsProvider", "unavailable", "down").retryable).toBe(true);
    expect(new PortError("SmsProvider", "timeout", "slow").retryable).toBe(true);
    expect(new PortError("SmsProvider", "rate_limited", "slow down").retryable).toBe(true);
    expect(new PortError("SmsProvider", "invalid_request", "bad").retryable).toBe(false);
    expect(new PortError("SmsProvider", "not_found", "missing").retryable).toBe(false);
  });

  it("carries port, code, provider, and cause", () => {
    const cause = new Error("socket hang up");
    const error = new PortError("PaymentProvider", "provider_error", "gateway error", {
      cause,
      provider: "paystack",
      retryable: false,
    });
    expect(error.port).toBe("PaymentProvider");
    expect(error.code).toBe("provider_error");
    expect(error.provider).toBe("paystack");
    expect(error.retryable).toBe(false);
    expect(error.cause).toBe(cause);
  });
});

describe("withLock", () => {
  function fakeLocks(): LockService & { held: Set<string> } {
    const held = new Set<string>();
    return {
      held,
      async acquire(key: string, _ttlSeconds: number): Promise<Lock | undefined> {
        if (held.has(key)) return undefined;
        held.add(key);
        return { key, token: `tok-${key}` };
      },
      async release(lock: Lock): Promise<boolean> {
        return held.delete(lock.key);
      },
    };
  }

  it("runs the function and releases the lock", async () => {
    const locks = fakeLocks();
    const result = await withLock(locks, "k", 10, async () => 42);
    expect(result).toBe(42);
    expect(locks.held.size).toBe(0);
  });

  it("releases the lock even when the function throws", async () => {
    const locks = fakeLocks();
    await expect(
      withLock(locks, "k", 10, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(locks.held.size).toBe(0);
  });

  it("fails fast when the lock is already held", async () => {
    const locks = fakeLocks();
    locks.held.add("k");
    await expect(withLock(locks, "k", 10, async () => 1)).rejects.toThrow("already held");
  });
});
