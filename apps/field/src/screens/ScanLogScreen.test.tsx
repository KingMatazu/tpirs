import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "fake-indexeddb/auto";
import { ScanLogScreen } from "./ScanLogScreen.js";
import { appendScanLog, getDb } from "../offline/store.js";

const noop = (): void => undefined;

async function seed(): Promise<void> {
  const db = await getDb();
  await db.clear("scanLog");
  await appendScanLog({
    id: "scan-1",
    scannedAt: "2026-06-15T09:00:00.000Z",
    verdict: "paid",
    recorded: "server",
    updatedAt: "2026-06-15T09:00:00.000Z",
    shortCode: "A000001",
  });
  await appendScanLog({
    id: "scan-2",
    scannedAt: "2026-06-15T09:05:00.000Z",
    verdict: "not_in_offline_list",
    observed: "not_in_offline_list",
    recorded: "queued",
    updatedAt: "2026-06-15T09:05:00.000Z",
    reference: "A000002",
  });
  await appendScanLog({
    id: "scan-3",
    scannedAt: "2026-06-15T09:10:00.000Z",
    verdict: "no_payment_recorded",
    observed: "paid",
    recorded: "server",
    updatedAt: "2026-06-15T09:10:00.000Z",
    shortCode: "A000003",
  });
}

describe("ScanLogScreen", () => {
  beforeEach(async () => {
    const db = await getDb();
    await db.clear("scanLog");
  });

  it("says so when the officer has scanned nothing yet", async () => {
    render(<ScanLogScreen onBack={noop} />);
    expect(await screen.findByText(/no scans yet today/i)).toBeTruthy();
  });

  it("shows each scan with its reference and what the ledger said", async () => {
    await seed();
    render(<ScanLogScreen onBack={noop} />);
    expect(await screen.findByText("A000001")).toBeTruthy();
    expect(screen.getByText("A000003")).toBeTruthy();
    expect(screen.getAllByText(/no payment recorded today/i).length).toBeGreaterThan(0);
  });

  it("marks which scans have uploaded, which are waiting and which were not sent", async () => {
    await seed();
    render(<ScanLogScreen onBack={noop} />);
    await screen.findByText("A000001");
    expect(screen.getAllByText(/^sent$/i)).toHaveLength(2);
    expect(screen.getAllByText(/^waiting$/i).length).toBeGreaterThan(0);
  });

  it("keeps a correction visible instead of overwriting it", async () => {
    await seed();
    render(<ScanLogScreen onBack={noop} />);
    // scan-3: the cache said paid, the ledger says otherwise.
    expect(await screen.findByText(/the phone first said: paid today/i)).toBeTruthy();
  });

  it("counts the day's scans, the waiting ones and the ones that could not be sent", async () => {
    await seed();
    render(<ScanLogScreen onBack={noop} />);
    await waitFor(() => {
      expect(screen.getByText("3")).toBeTruthy();
    });
  });
});
