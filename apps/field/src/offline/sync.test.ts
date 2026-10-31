import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { syncPaidSet } from "./sync.js";
import type { PageResult } from "./sync.js";
import type { PaidSetDelta, PaidSetEntry } from "../lib/paid-set.js";
import { allPaidPayloads, countPaid, getDb, readSyncState, saveSyncState } from "./store.js";

function entry(overrides: Partial<PaidSetEntry> = {}): PaidSetEntry {
  return {
    assetId: "asset-1",
    qrPayload: "payload-1",
    shortCode: "A000001",
    assetTypeKey: "bike",
    attributes: { plate_number: "MTZ56AA" },
    paid: true,
    changedAt: "2026-06-15T09:00:00.000Z",
    ...overrides,
  };
}

function page(overrides: Partial<PaidSetDelta> = {}): PaidSetDelta {
  return {
    mode: "snapshot",
    businessDate: "2026-06-15",
    entries: [entry()],
    nextCursor: "cursor-1",
    hasMore: false,
    serverTime: "2026-06-15T09:00:00.000Z",
    ...overrides,
  };
}

/** A fetcher that serves the given pages in order and records what it was asked. */
function fetcher(pages: readonly PageResult[]): {
  readonly fetchPage: (since: string | undefined) => Promise<PageResult>;
  readonly calls: (string | undefined)[];
} {
  const calls: (string | undefined)[] = [];
  let index = 0;
  return {
    calls,
    fetchPage: (since) => {
      calls.push(since);
      const next = pages[index] ?? { ok: false, reason: "error" };
      index += 1;
      return Promise.resolve(next);
    },
  };
}

async function reset(): Promise<void> {
  const db = await getDb();
  await db.clear("paidSet");
  await db.clear("syncState");
}

describe("syncPaidSet", () => {
  beforeEach(async () => {
    await reset();
  });

  it("stores the paid entries of a snapshot and remembers the cursor", async () => {
    const fake = fetcher([{ ok: true, delta: page() }]);
    const outcome = await syncPaidSet({ fetchPage: fake.fetchPage });

    expect(outcome.complete).toBe(true);
    expect(outcome.added).toBe(1);
    expect(outcome.paidCount).toBe(1);
    expect([...(await allPaidPayloads())]).toEqual(["payload-1"]);

    const state = await readSyncState();
    expect(state?.businessDate).toBe("2026-06-15");
    expect(state?.cursor).toBe("cursor-1");
    expect(state?.lastSyncedAt).toBe("2026-06-15T09:00:00.000Z");
  });

  it("asks for a delta with the stored cursor on the next sync", async () => {
    await syncPaidSet({ fetchPage: fetcher([{ ok: true, delta: page() }]).fetchPage });

    const fake = fetcher([
      { ok: true, delta: page({ mode: "delta", entries: [], nextCursor: "cursor-2" }) },
    ]);
    const outcome = await syncPaidSet({ fetchPage: fake.fetchPage });

    expect(fake.calls).toEqual(["cursor-1"]);
    expect(outcome.complete).toBe(true);
    // Nothing changed, and the paid set is untouched.
    expect(outcome.paidCount).toBe(1);
    expect((await readSyncState())?.cursor).toBe("cursor-2");
  });

  it("removes an asset that the feed now reports as not paid", async () => {
    await syncPaidSet({ fetchPage: fetcher([{ ok: true, delta: page() }]).fetchPage });

    const outcome = await syncPaidSet({
      fetchPage: fetcher([
        {
          ok: true,
          delta: page({ mode: "delta", entries: [entry({ paid: false })], nextCursor: "c2" }),
        },
      ]).fetchPage,
    });

    expect(outcome.removed).toBe(1);
    expect(outcome.paidCount).toBe(0);
  });

  it("clears the cache when the business date changes", async () => {
    await syncPaidSet({ fetchPage: fetcher([{ ok: true, delta: page() }]).fetchPage });

    const outcome = await syncPaidSet({
      fetchPage: fetcher([
        {
          ok: true,
          delta: page({
            mode: "delta",
            businessDate: "2026-06-16",
            entries: [],
            nextCursor: "c2",
          }),
        },
      ]).fetchPage,
    });

    // Yesterday's payments must not survive into today.
    expect(outcome.paidCount).toBe(0);
    expect((await readSyncState())?.businessDate).toBe("2026-06-16");
  });

  it("follows the cursor until the feed is exhausted", async () => {
    const fake = fetcher([
      {
        ok: true,
        delta: page({ entries: [entry()], nextCursor: "c1", hasMore: true }),
      },
      {
        ok: true,
        delta: page({
          mode: "delta",
          entries: [entry({ assetId: "asset-2", qrPayload: "payload-2", shortCode: "A000002" })],
          nextCursor: "c2",
          hasMore: false,
        }),
      },
    ]);
    const outcome = await syncPaidSet({ fetchPage: fake.fetchPage });

    expect(fake.calls).toEqual([undefined, "c1"]);
    expect(outcome.pages).toBe(2);
    expect(outcome.paidCount).toBe(2);
  });

  it("keeps what it has when the network dies mid-way", async () => {
    const fake = fetcher([
      { ok: true, delta: page({ entries: [entry()], nextCursor: "c1", hasMore: true }) },
      { ok: false, reason: "offline" },
    ]);
    const outcome = await syncPaidSet({ fetchPage: fake.fetchPage });

    expect(outcome.complete).toBe(false);
    expect(outcome.stopReason).toBe("offline");
    expect(outcome.paidCount).toBe(1);
    // The cursor of the last good page is kept, so the next attempt resumes.
    expect((await readSyncState())?.cursor).toBe("c1");
  });

  it("stops on a throttle instead of hammering the server", async () => {
    const fake = fetcher([{ ok: false, reason: "rate_limited" }]);
    const outcome = await syncPaidSet({ fetchPage: fake.fetchPage });
    expect(outcome.stopReason).toBe("rate_limited");
    expect(outcome.complete).toBe(false);
    expect(fake.calls).toHaveLength(1);
  });

  it("reports a tenant that turned offline checking off", async () => {
    const outcome = await syncPaidSet({
      fetchPage: fetcher([{ ok: false, reason: "offline_disabled" }]).fetchPage,
    });
    expect(outcome.stopReason).toBe("offline_disabled");
  });

  it("does not spin when the server says hasMore without a cursor", async () => {
    const fake = fetcher([
      { ok: true, delta: page({ entries: [entry()], nextCursor: null, hasMore: true }) },
    ]);
    const outcome = await syncPaidSet({ fetchPage: fake.fetchPage });
    expect(outcome.complete).toBe(false);
    expect(fake.calls).toHaveLength(1);
  });

  it("counts the cache rather than the last page", async () => {
    await saveSyncState({
      businessDate: "2026-06-15",
      cursor: "seed",
      lastSyncedAt: "2026-06-15T08:00:00.000Z",
    });
    const db = await getDb();
    await db.put("paidSet", {
      qrPayload: "already-there",
      assetId: "asset-9",
      shortCode: "A000009",
      assetTypeKey: "bike",
      attributes: {},
      paid: true,
      businessDate: "2026-06-15",
      changedAt: "2026-06-15T08:00:00.000Z",
    });

    const outcome = await syncPaidSet({
      fetchPage: fetcher([
        { ok: true, delta: page({ mode: "delta", entries: [entry()], nextCursor: "c2" }) },
      ]).fetchPage,
    });

    expect(outcome.added).toBe(1);
    expect(await countPaid()).toBe(2);
  });

  it("survives a fetch that throws instead of returning", async () => {
    const outcome = await syncPaidSet({
      fetchPage: vi.fn(() => Promise.reject(new Error("boom"))),
    });
    expect(outcome.complete).toBe(false);
    expect(outcome.paidCount).toBe(0);
  });
});
