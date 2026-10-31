import type { OutboxItem } from "../offline/store.js";

/**
 * Outbox scheduling, as pure functions.
 *
 * The rules that matter here are the ones an officer's shift depends on: a scan
 * taken in a dead zone uploads when the connection returns, a scan the server
 * refuses stops being retried, and a throttle is respected rather than hammered.
 * Keeping the arithmetic out of the flushing loop is what makes it testable
 * without a phone, a network or a clock.
 */

/** How many items one pass may attempt, so a full queue cannot storm the API. */
export const FLUSH_BUDGET = 25;

/** Backoff cap: after this, retrying more often than every half hour adds nothing. */
export const MAX_BACKOFF_MS = 30 * 60 * 1000;

/** The first retry waits this long; each further failure doubles it. */
export const BASE_BACKOFF_MS = 30 * 1000;

export function isFailed(item: OutboxItem): boolean {
  return item.state === "failed";
}

/**
 * Exponential backoff with jitter, capped.
 *
 * Jitter matters with a fleet of phones that all lost signal at the same moment:
 * without it they all retry on the same second, which is the shape of a
 * self-inflicted denial of service.
 */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(attempts, 10));
  const base = Math.min(BASE_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
  // ±20% so two phones that queued at the same time do not retry in lockstep.
  const jitter = 0.8 + random() * 0.4;
  return Math.round(base * jitter);
}

/** True when the item is due to be attempted at `now`. */
export function isDue(item: OutboxItem, now: Date): boolean {
  if (isFailed(item)) return false;
  const due = new Date(item.nextAttemptAt);
  if (Number.isNaN(due.getTime())) return true;
  return due.getTime() <= now.getTime();
}

/**
 * The items this pass should attempt: pending, due, oldest first, capped.
 * A failed item is never planned again — it needs a human to look at it.
 */
export function planFlush(
  items: readonly OutboxItem[],
  now: Date,
  budget: number = FLUSH_BUDGET,
): readonly OutboxItem[] {
  return items
    .filter((item) => isDue(item, now))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(0, budget);
}

/** The item after a failed attempt: one more attempt counted, and when to try again. */
export function afterFailure(
  item: OutboxItem,
  now: Date,
  retryAfterSeconds: number | undefined,
  random: () => number = Math.random,
): OutboxItem {
  const attempts = item.attempts + 1;
  const waitMs =
    retryAfterSeconds === undefined
      ? backoffMs(attempts, random)
      : Math.max(retryAfterSeconds * 1000, BASE_BACKOFF_MS);
  return { ...item, attempts, nextAttemptAt: new Date(now.getTime() + waitMs).toISOString() };
}

/** The item after the server refused it: kept for the officer to see, never retried. */
export function afterRejection(item: OutboxItem, reason: string): OutboxItem {
  return { ...item, state: "failed", lastError: reason };
}
