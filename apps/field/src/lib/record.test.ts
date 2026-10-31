import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { recordScan } from "./record.js";
import type { ScanAttempt } from "./record.js";
import { setRuntimeFetch } from "@tpirs/api-client";
import { getDb, listOutbox } from "../offline/store.js";

const ATTEMPT: ScanAttempt = {
  clientScanId: "scan-1",
  scannedAt: "2026-06-15T09:00:00.000Z",
  source: "qr",
  token: "abcdef0123456789.SIG16",
  observed: "not_in_offline_list",
};

async function reset(): Promise<void> {
  const db = await getDb();
  await db.clear("outbox");
}

describe("recordScan", () => {
  beforeEach(async () => {
    await reset();
  });

  it("records online and returns the ledger's answer", async () => {
    const outcome = await recordScan(ATTEMPT, {
      online: () => true,
      post: () =>
        Promise.resolve({
          status: "recorded",
          result: {
            scanId: "s1",
            assetId: "a1",
            businessDate: "2026-06-15",
            observedStatus: "not_in_offline_list",
            authoritativeStatus: "paid",
            paymentStatus: "paid",
            shortCode: "A000001",
          },
        }),
    });

    expect(outcome.status).toBe("recorded");
    expect(await listOutbox()).toHaveLength(0);
  });

  it("queues the scan in a dead zone and keeps its id", async () => {
    const outcome = await recordScan(ATTEMPT, { online: () => false });
    expect(outcome.status).toBe("queued");

    const items = await listOutbox();
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("scan-1");
    const payload = items[0]?.payload as Record<string, unknown>;
    // The queue is what the server sees on upload, so the source says so.
    expect(payload.source).toBe("offline_queue");
    expect(payload.clientScanId).toBe("scan-1");
    expect(payload.token).toBe(ATTEMPT.token);
    expect(payload.observedStatus).toBe("not_in_offline_list");
  });

  it("does not queue a sticker the server does not recognise", async () => {
    const outcome = await recordScan(ATTEMPT, {
      online: () => true,
      post: () => Promise.resolve({ status: "rejected" }),
    });
    expect(outcome.status).toBe("rejected");
    // Retrying forever would only delay the truth.
    expect(await listOutbox()).toHaveLength(0);
  });

  it("queues when the server is unwell rather than dropping the scan", async () => {
    const outcome = await recordScan(ATTEMPT, {
      online: () => true,
      post: () => Promise.resolve({ status: "queued" }),
    });
    expect(outcome.status).toBe("queued");
    expect(await listOutbox()).toHaveLength(1);
  });

  it("queues the same scan once, even when it is retried", async () => {
    await recordScan(ATTEMPT, { online: () => false });
    await recordScan(ATTEMPT, { online: () => false });
    expect(await listOutbox()).toHaveLength(1);
  });

  it("refuses to queue past the tenant's cap instead of silently losing it", async () => {
    // The cap comes from the tenant config, per attempt.
    await recordScan({ ...ATTEMPT, maxQueueItems: 1 }, { online: () => false });
    const outcome = await recordScan(
      { ...ATTEMPT, clientScanId: "scan-2", maxQueueItems: 1 },
      { online: () => false },
    );
    expect(outcome.status).toBe("queue_full");
    expect(await listOutbox()).toHaveLength(1);
  });

  it("generates distinct ids for distinct scans", async () => {
    await recordScan(ATTEMPT, { online: () => false });
    await recordScan({ ...ATTEMPT, clientScanId: "scan-2" }, { online: () => false });
    expect(await listOutbox()).toHaveLength(2);
  });
});

describe("recordScan with the real transport", () => {
  beforeEach(async () => {
    await reset();
  });

  it("queues when the request throws, because that is what a dead zone looks like", async () => {
    // openapi-fetch snapshots its fetch when the client is built, so the runtime
    // fetch has to be swapped through the client's own seam.
    setRuntimeFetch(vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    try {
      const outcome = await recordScan(ATTEMPT, { online: () => true });
      expect(outcome.status).toBe("queued");
      expect(await listOutbox()).toHaveLength(1);
    } finally {
      setRuntimeFetch(globalThis.fetch);
    }
  });
});
