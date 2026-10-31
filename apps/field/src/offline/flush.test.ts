import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { flushOutbox } from "./flush.js";
import type { PostResult } from "./flush.js";
import {
  appendScanLog,
  enqueueOutbox,
  getDb,
  listFailedOutbox,
  listOutbox,
  listScanLog,
} from "./store.js";

const NOW = new Date("2026-06-15T09:00:00.000Z");

async function reset(): Promise<void> {
  const db = await getDb();
  await db.clear("outbox");
}

async function queue(id: string, createdAt: string): Promise<void> {
  await enqueueOutbox(
    {
      id,
      kind: "scan",
      payload: { clientScanId: id, source: "offline_queue", scannedAt: createdAt },
      createdAt,
    },
    undefined,
  );
}

describe("flushOutbox", () => {
  beforeEach(async () => {
    await reset();
  });

  it("uploads queued scans oldest first and empties the queue", async () => {
    await queue("scan-2", "2026-06-15T08:10:00.000Z");
    await queue("scan-1", "2026-06-15T08:00:00.000Z");

    const sent: string[] = [];
    const outcome = await flushOutbox({
      now: () => NOW,
      post: (item) => {
        sent.push(item.id);
        return Promise.resolve({ status: "ok" });
      },
    });

    expect(sent).toEqual(["scan-1", "scan-2"]);
    expect(outcome.sent).toBe(2);
    expect(outcome.remaining).toBe(0);
    expect(await listOutbox()).toHaveLength(0);
  });

  it("stops on a throttle, keeps the rest queued and respects Retry-After", async () => {
    await queue("scan-1", "2026-06-15T08:00:00.000Z");
    await queue("scan-2", "2026-06-15T08:05:00.000Z");

    const outcome = await flushOutbox({
      now: () => NOW,
      post: (): Promise<PostResult> => Promise.resolve({ status: "retry", retryAfterSeconds: 60 }),
    });

    expect(outcome.stopReason).toBe("rate_limited");
    expect(outcome.deferred).toBe(1);
    expect(outcome.remaining).toBe(2);

    const items = await listOutbox();
    const first = items.find((item) => item.id === "scan-1");
    expect(new Date(first?.nextAttemptAt ?? "").getTime()).toBe(NOW.getTime() + 60_000);
    // The second item was never attempted.
    expect(items.find((item) => item.id === "scan-2")?.attempts).toBe(0);
  });

  it("ends the pass on a dead zone instead of retrying every item", async () => {
    await queue("scan-1", "2026-06-15T08:00:00.000Z");
    await queue("scan-2", "2026-06-15T08:05:00.000Z");
    const post = vi.fn((): Promise<PostResult> =>
      Promise.resolve({ status: "retry", offline: true }),
    );

    const outcome = await flushOutbox({ now: () => NOW, post });

    expect(outcome.stopReason).toBe("offline");
    expect(post).toHaveBeenCalledTimes(1);
    expect(outcome.remaining).toBe(2);
  });

  it("keeps a scan the server refused, marks it failed, and stops retrying it", async () => {
    await queue("scan-1", "2026-06-15T08:00:00.000Z");

    const outcome = await flushOutbox({
      now: () => NOW,
      post: () => Promise.resolve({ status: "rejected", reason: "http_404" }),
    });

    expect(outcome.rejected).toBe(1);
    expect(outcome.remaining).toBe(1);
    const failed = await listFailedOutbox();
    expect(failed).toHaveLength(1);
    expect(failed[0]?.lastError).toBe("http_404");

    // A later pass leaves it alone: only a person can fix a refused scan.
    const post = vi.fn((): Promise<PostResult> => Promise.resolve({ status: "ok" }));
    await flushOutbox({ now: () => new Date("2026-06-15T10:00:00.000Z"), post });
    expect(post).not.toHaveBeenCalled();
  });

  it("renews an expired session once and carries on", async () => {
    await queue("scan-1", "2026-06-15T08:00:00.000Z");
    let calls = 0;
    const outcome = await flushOutbox({
      now: () => NOW,
      post: () => {
        calls += 1;
        return Promise.resolve<PostResult>(calls === 1 ? { status: "auth" } : { status: "ok" });
      },
      refresh: () => Promise.resolve(true),
    });

    expect(outcome.sent).toBe(1);
    expect(outcome.stopReason).toBeUndefined();
  });

  it("pauses when the session cannot be renewed", async () => {
    await queue("scan-1", "2026-06-15T08:00:00.000Z");
    const outcome = await flushOutbox({
      now: () => NOW,
      post: () => Promise.resolve({ status: "auth" }),
      refresh: () => Promise.resolve(false),
    });

    expect(outcome.stopReason).toBe("auth");
    // The scan is still on the phone; a sign-in is all that is missing.
    expect(outcome.remaining).toBe(1);
  });

  it("does not attempt more than the budget in one pass", async () => {
    for (const index of [1, 2, 3, 4, 5]) {
      await queue(`scan-${String(index)}`, `2026-06-15T08:0${String(index)}:00.000Z`);
    }
    const post = vi.fn((): Promise<PostResult> => Promise.resolve({ status: "ok" }));

    const outcome = await flushOutbox({ now: () => NOW, post, budget: 2 });

    expect(post).toHaveBeenCalledTimes(2);
    expect(outcome.sent).toBe(2);
    expect(outcome.remaining).toBe(3);
  });

  it("does nothing when the queue is empty", async () => {
    const post = vi.fn((): Promise<PostResult> => Promise.resolve({ status: "ok" }));
    const outcome = await flushOutbox({ now: () => NOW, post });
    expect(post).not.toHaveBeenCalled();
    expect(outcome.remaining).toBe(0);
  });
});

describe("flushOutbox and the scan log", () => {
  beforeEach(async () => {
    await reset();
    const db = await getDb();
    await db.clear("scanLog");
  });

  it("marks a scan synced and takes the ledger's verdict", async () => {
    await queue("scan-1", "2026-06-15T08:00:00.000Z");
    await appendScanLog({
      id: "scan-1",
      scannedAt: "2026-06-15T08:00:00.000Z",
      verdict: "not_in_offline_list",
      recorded: "queued",
      updatedAt: "2026-06-15T08:00:00.000Z",
    });

    await flushOutbox({
      now: () => NOW,
      post: () =>
        Promise.resolve({
          status: "ok",
          body: { authoritativeStatus: "paid", shortCode: "A000001", businessDate: "2026-06-15" },
        }),
    });

    const [row] = await listScanLog();
    expect(row?.recorded).toBe("server");
    expect(row?.verdict).toBe("paid");
    expect(row?.shortCode).toBe("A000001");
  });

  it("marks a refused scan as not sent so the officer can find it", async () => {
    await queue("scan-1", "2026-06-15T08:00:00.000Z");
    await appendScanLog({
      id: "scan-1",
      scannedAt: "2026-06-15T08:00:00.000Z",
      verdict: "paid",
      recorded: "queued",
      updatedAt: "2026-06-15T08:00:00.000Z",
    });

    await flushOutbox({
      now: () => NOW,
      post: () => Promise.resolve({ status: "rejected", reason: "http_404" }),
    });

    const [row] = await listScanLog();
    expect(row?.recorded).toBe("failed");
  });

  it("leaves a scan marked as waiting while it is still retrying", async () => {
    await queue("scan-1", "2026-06-15T08:00:00.000Z");
    await appendScanLog({
      id: "scan-1",
      scannedAt: "2026-06-15T08:00:00.000Z",
      verdict: "paid",
      recorded: "queued",
      updatedAt: "2026-06-15T08:00:00.000Z",
    });

    await flushOutbox({
      now: () => NOW,
      post: () => Promise.resolve({ status: "retry", offline: true }),
    });

    const [row] = await listScanLog();
    expect(row?.recorded).toBe("queued");
  });
});
