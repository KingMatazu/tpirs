import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { appendScanLog, getDb, listScanLog, pruneScanLog, updateScanLog } from "./store.js";

async function reset(): Promise<void> {
  const db = await getDb();
  await db.clear("scanLog");
}

function entry(overrides: Partial<Parameters<typeof appendScanLog>[0]> = {}) {
  return {
    id: "scan-1",
    scannedAt: "2026-06-15T09:00:00.000Z",
    verdict: "paid",
    recorded: "server" as const,
    updatedAt: "2026-06-15T09:00:00.000Z",
    businessDate: "2026-06-15",
    ...overrides,
  };
}

describe("scan log", () => {
  beforeEach(async () => {
    await reset();
  });

  it("lists today's scans newest first", async () => {
    await appendScanLog(entry({ id: "a", scannedAt: "2026-06-15T08:00:00.000Z" }));
    await appendScanLog(entry({ id: "b", scannedAt: "2026-06-15T10:00:00.000Z" }));
    await appendScanLog(entry({ id: "c", scannedAt: "2026-06-15T09:00:00.000Z" }));

    expect((await listScanLog()).map((row) => row.id)).toEqual(["b", "c", "a"]);
  });

  it("updates an entry in place when the ledger answers", async () => {
    await appendScanLog(entry({ recorded: "queued", verdict: "not_in_offline_list" }));
    await updateScanLog("scan-1", { recorded: "server", verdict: "paid" });

    const [row] = await listScanLog();
    expect(row?.recorded).toBe("server");
    expect(row?.verdict).toBe("paid");
    // The id and time are what make the entry findable again.
    expect(row?.id).toBe("scan-1");
  });

  it("ignores an update for an entry it does not have", async () => {
    await updateScanLog("missing", { recorded: "failed" });
    expect(await listScanLog()).toHaveLength(0);
  });

  it("drops yesterday's scans on rollover but keeps today's", async () => {
    await appendScanLog(entry({ id: "old", businessDate: "2026-06-14" }));
    await appendScanLog(entry({ id: "today", businessDate: "2026-06-15" }));
    await pruneScanLog("2026-06-15");
    expect((await listScanLog()).map((row) => row.id)).toEqual(["today"]);
  });

  it("limits what one screen has to render", async () => {
    for (let index = 0; index < 5; index += 1) {
      await appendScanLog(
        entry({
          id: `scan-${String(index)}`,
          scannedAt: `2026-06-15T09:0${String(index)}:00.000Z`,
        }),
      );
    }
    expect(await listScanLog(2)).toHaveLength(2);
  });
});
