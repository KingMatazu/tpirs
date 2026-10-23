import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createDb, migrateUp, repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { createMockSmsProvider } from "@tpirs/sms-provider-mock";
import type { MockSmsProvider } from "@tpirs/sms-provider-mock";
import type { Telemetry } from "@tpirs/ports";
import { createWorker } from "./worker.js";
import type { Worker } from "./worker.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../../packages/db/migrations");
const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

/** A minimal telemetry sink, so the test records rather than reports. */
const telemetry: Telemetry = {
  startSpan: () => ({
    setAttribute: () => undefined,
    recordException: () => undefined,
    end: () => undefined,
  }),
  counter: () => undefined,
  log: () => undefined,
  captureError: () => undefined,
};

/** A tenant whose outbox already holds one rendered receipt. */
async function tenantWithPendingReceipt(db: AnyDb): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tenantId = await withSystem(db, async (tx) => {
    const created = await repositories(tx).tenants.create({
      slug: `worker-${stamp}`,
      name: "Worker",
      legalEntity: "Worker Revenue",
      config: {},
    });
    return created.id;
  });
  await withTenant(db, tenantId, async (tx) => {
    const repos = repositories(tx);
    const asset = await repos.assets.create({
      tenantId,
      zoneId: null,
      ownerId: null,
      assetTypeKey: "bike",
      attributes: {},
      qrPayload: `worker-${stamp}`,
      qrToken: `worker-${stamp}-token`,
      shortCode: "W1",
      createdByUserId: null,
    });
    const period = await repos.obligations.create(tenantId, {
      assetId: asset.id,
      periodKey: "2026-06-15",
      businessDate: "2026-06-15",
      amountMinor: 20_000n,
      currency: "NGN",
    });
    await repos.smsLog.enqueue(tenantId, {
      kind: "receipt",
      recipient: "+2348099999999",
      obligationPeriodId: period.id,
      body: "Your levy payment is recorded",
    });
  });
  return tenantId;
}

describeIntegration("worker (integration)", () => {
  let db: AnyDb;
  let sms: MockSmsProvider;
  let worker: Worker;

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await worker.stop();
    await db.destroy();
  });

  it("sweeps a pending receipt and delivers it through the gateway", async () => {
    const tenantId = await tenantWithPendingReceipt(db);
    sms = createMockSmsProvider();
    worker = createWorker({ db, sms, telemetry, sweepIntervalMs: 60_000 });

    // `start` runs one sweep immediately, then a slow timer keeps the test quiet.
    await worker.start();
    const delivered = await waitFor(() => sms.sent.some((m) => m.to === "+2348099999999"), 5_000);
    expect(delivered).toBe(true);
    const mine = sms.sent.find((m) => m.to === "+2348099999999");
    expect(mine?.text).toBe("Your levy payment is recorded");

    await worker.stop();

    const status = await withTenant(db, tenantId, async (tx) => {
      const rows = await repositories(tx).smsLog.claimPending(tenantId, 10);
      return rows.length;
    });
    // Delivered, so it is no longer claimable as pending work.
    expect(status).toBe(0);
  });
});

/** Waits for a condition, so the test never races the polling loop. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}
