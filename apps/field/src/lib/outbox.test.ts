import { describe, expect, it } from "vitest";
import {
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  afterFailure,
  afterRejection,
  backoffMs,
  isDue,
  isFailed,
  planFlush,
} from "./outbox.js";
import type { OutboxItem } from "../offline/store.js";

const NOW = new Date("2026-06-15T09:00:00.000Z");

function item(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: "scan-1",
    kind: "scan",
    payload: {},
    createdAt: "2026-06-15T08:00:00.000Z",
    attempts: 0,
    nextAttemptAt: "2026-06-15T08:00:00.000Z",
    ...overrides,
  };
}

describe("backoffMs", () => {
  it("doubles with each failure", () => {
    const noJitter = (): number => 0.5;
    const first = backoffMs(0, noJitter);
    const second = backoffMs(1, noJitter);
    const third = backoffMs(2, noJitter);
    expect(second).toBe(first * 2);
    expect(third).toBe(first * 4);
  });

  it("starts at the base delay", () => {
    expect(backoffMs(0, () => 0.5)).toBe(BASE_BACKOFF_MS);
  });

  it("never exceeds the cap", () => {
    expect(backoffMs(30, () => 1)).toBeLessThanOrEqual(MAX_BACKOFF_MS * 1.2);
    expect(backoffMs(30, () => 0.5)).toBe(MAX_BACKOFF_MS);
  });

  it("jitters so a fleet does not retry on the same second", () => {
    expect(backoffMs(3, () => 0)).toBeLessThan(backoffMs(3, () => 1));
  });
});

describe("isDue", () => {
  it("is due when the next attempt time has passed", () => {
    expect(isDue(item({ nextAttemptAt: "2026-06-15T08:59:00.000Z" }), NOW)).toBe(true);
  });

  it("is not due while it is still backing off", () => {
    expect(isDue(item({ nextAttemptAt: "2026-06-15T09:05:00.000Z" }), NOW)).toBe(false);
  });

  it("is never due once the server refused it", () => {
    expect(isDue(item({ state: "failed" }), NOW)).toBe(false);
  });

  it("treats an unreadable time as due rather than stuck forever", () => {
    expect(isDue(item({ nextAttemptAt: "not-a-date" }), NOW)).toBe(true);
  });
});

describe("planFlush", () => {
  it("takes the oldest due items first", () => {
    const planned = planFlush(
      [
        item({ id: "b", createdAt: "2026-06-15T08:10:00.000Z" }),
        item({ id: "a", createdAt: "2026-06-15T08:00:00.000Z" }),
        item({ id: "c", createdAt: "2026-06-15T08:20:00.000Z" }),
      ],
      NOW,
    );
    expect(planned.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("respects the budget so one pass cannot storm the API", () => {
    const items = Array.from({ length: 40 }, (_unused, index) =>
      item({
        id: `scan-${String(index)}`,
        createdAt: `2026-06-15T08:00:${String(index).padStart(2, "0")}.000Z`,
      }),
    );
    expect(planFlush(items, NOW, 10)).toHaveLength(10);
  });

  it("skips items that are backing off or already failed", () => {
    const planned = planFlush(
      [
        item({ id: "due" }),
        item({ id: "waiting", nextAttemptAt: "2026-06-15T10:00:00.000Z" }),
        item({ id: "failed", state: "failed" }),
      ],
      NOW,
    );
    expect(planned.map((entry) => entry.id)).toEqual(["due"]);
  });
});

describe("afterFailure", () => {
  it("counts the attempt and schedules the next one", () => {
    const next = afterFailure(item({ attempts: 1 }), NOW, undefined, () => 0.5);
    expect(next.attempts).toBe(2);
    expect(new Date(next.nextAttemptAt).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("honours Retry-After when the server asks for more time", () => {
    const next = afterFailure(item(), NOW, 120, () => 0.5);
    expect(new Date(next.nextAttemptAt).getTime()).toBe(NOW.getTime() + 120_000);
  });

  it("keeps a floor under Retry-After so a zero cannot become a tight loop", () => {
    const next = afterFailure(item(), NOW, 0, () => 0.5);
    expect(new Date(next.nextAttemptAt).getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe("afterRejection", () => {
  it("marks the item failed with the reason and stops it being retried", () => {
    const next = afterRejection(item(), "http_404");
    expect(isFailed(next)).toBe(true);
    expect(next.lastError).toBe("http_404");
    expect(isDue(next, NOW)).toBe(false);
  });
});
