import type { Cache, Clock } from "@tpirs/ports";

/**
 * A fixed-window rate limit. Both values come from tenant config, so a tenant
 * can tighten or loosen its own abuse controls without a deploy.
 */
export interface RateLimitRule {
  /** Requests allowed per window. Must be at least 1. */
  readonly limit: number;
  /** Window length in seconds. Must be at least 1. */
  readonly windowSeconds: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  /** Requests left in this window after the current one. */
  readonly remaining: number;
  /** Seconds until the window resets; always at least 1. */
  readonly retryAfterSeconds: number;
}

/**
 * Counts requests per caller for a coarse abuse control.
 *
 * The limiter is intentionally best-effort: `Cache` has no atomic increment, so
 * two processes can both read the same count and both allow the request. That
 * is an accepted trade-off (ADR 0024) because the limits protect a driver-
 * facing channel from accidental floods, not a financial invariant. The
 * database's dedupe keys and the ledger remain the source of truth.
 */
export interface RateLimiter {
  consume(key: string, rule: RateLimitRule): Promise<RateLimitDecision>;
}

export class RateLimitedError extends Error {
  /** Seconds the caller should wait before retrying. */
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(`Rate limit exceeded; retry after ${retryAfterSeconds} second(s)`);
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface RateLimiterDeps {
  readonly cache: Cache;
  readonly clock: Clock;
}

export function createRateLimiter(deps: RateLimiterDeps): RateLimiter {
  async function consume(key: string, rule: RateLimitRule): Promise<RateLimitDecision> {
    if (!Number.isInteger(rule.limit) || rule.limit < 1) {
      throw new Error("Rate limit must allow at least one request per window");
    }
    if (!Number.isInteger(rule.windowSeconds) || rule.windowSeconds < 1) {
      throw new Error("Rate limit window must be at least one second");
    }

    const now = deps.clock.now().getTime();
    const windowMs = rule.windowSeconds * 1000;
    const windowIndex = Math.floor(now / windowMs);
    const windowEnd = (windowIndex + 1) * windowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((windowEnd - now) / 1000));
    const cacheKey = `rate-limit:${key}:${windowIndex}`;

    // Leave one second of slack so a clock that drifts a little never serves a
    // stale window; the key includes the window index, so a later window always
    // starts from zero regardless of the previous TTL.
    const ttlSeconds = retryAfterSeconds + 1;
    const stored = await deps.cache.get(cacheKey);
    const used = typeof stored === "number" && Number.isFinite(stored) ? stored : 0;

    if (used >= rule.limit) {
      return { allowed: false, limit: rule.limit, remaining: 0, retryAfterSeconds };
    }

    const next = used + 1;
    await deps.cache.set(cacheKey, next, ttlSeconds);
    return {
      allowed: true,
      limit: rule.limit,
      remaining: Math.max(0, rule.limit - next),
      retryAfterSeconds,
    };
  }

  return { consume };
}
