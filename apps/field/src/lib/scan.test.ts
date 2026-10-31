import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { resolveScanOffline } from "./scan.js";
import { getDb, saveSyncState } from "../offline/store.js";

// A QR payload is 16-64 URL-safe characters; the checksum suffix is opaque here.
const PAYLOAD = "abcdef0123456789";
const TOKEN = `${PAYLOAD}.SIG16`;

async function seed(options: {
  readonly paid: readonly { payload: string; shortCode: string; plate: string }[];
  readonly businessDate?: string;
}): Promise<void> {
  const db = await getDb();
  for (const asset of options.paid) {
    await db.put("paidSet", {
      qrPayload: asset.payload,
      assetId: `asset-${asset.shortCode}`,
      shortCode: asset.shortCode,
      assetTypeKey: "bike",
      attributes: { plate_number: asset.plate },
      paid: true,
      businessDate: options.businessDate ?? "2026-06-15",
      changedAt: "2026-06-15T09:00:00.000Z",
    });
  }
  await saveSyncState({
    businessDate: options.businessDate ?? "2026-06-15",
    cursor: "cursor-1",
    lastSyncedAt: "2026-06-15T09:00:00.000Z",
  });
}

describe("resolveScanOffline", () => {
  beforeEach(async () => {
    const db = await getDb();
    await db.clear("paidSet");
    await db.clear("syncState");
  });

  it("confirms a paid vehicle from the cached set", async () => {
    await seed({ paid: [{ payload: PAYLOAD, shortCode: "A000001", plate: "MTZ56AA" }] });
    const outcome = await resolveScanOffline({ token: TOKEN });
    expect(outcome.kind).toBe("paid");
    expect(outcome.shortCode).toBe("A000001");
    expect(outcome.businessDate).toBe("2026-06-15");
  });

  it("answers absence with not_in_offline_list, never with a denial", async () => {
    await seed({ paid: [] });
    const outcome = await resolveScanOffline({ token: TOKEN });
    expect(outcome.kind).toBe("not_in_offline_list");
    expect(JSON.stringify(outcome)).not.toContain("unpaid");
  });

  it("calls an unreadable sticker unreadable, not unpaid", async () => {
    await seed({ paid: [] });
    const outcome = await resolveScanOffline({ token: "not-a-token" });
    expect(outcome.kind).toBe("unreadable");
  });

  it("finds a vehicle by typed short code, however it is spaced", async () => {
    await seed({ paid: [{ payload: PAYLOAD, shortCode: "A000001", plate: "MTZ56AA" }] });
    expect((await resolveScanOffline({ reference: "a 000001" })).kind).toBe("paid");
    expect((await resolveScanOffline({ reference: "A-000001" })).kind).toBe("paid");
  });

  it("finds a vehicle by plate number", async () => {
    await seed({ paid: [{ payload: PAYLOAD, shortCode: "A000001", plate: "MTZ56AA" }] });
    const outcome = await resolveScanOffline({ reference: "mtz 56 aa" });
    expect(outcome.kind).toBe("paid");
    expect(outcome.shortCode).toBe("A000001");
  });

  it("does not guess when the typed reference is unknown", async () => {
    await seed({ paid: [{ payload: PAYLOAD, shortCode: "A000001", plate: "MTZ56AA" }] });
    const outcome = await resolveScanOffline({ reference: "ZZZ999" });
    expect(outcome.kind).toBe("not_in_offline_list");
    expect(outcome.via).toBe("reference");
  });

  it("works with no cache at all, and still refuses to accuse", async () => {
    const outcome = await resolveScanOffline({ token: TOKEN });
    expect(outcome.kind).toBe("not_in_offline_list");
    expect(outcome.businessDate).toBeUndefined();
  });
});
