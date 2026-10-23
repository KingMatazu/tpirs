import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createDb, migrateUp, repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { createMockJobQueue } from "@tpirs/job-queue-mock";
import type { MockJobQueue } from "@tpirs/job-queue-mock";
import { createSmsOutboxSweeper, SMS_DELIVERY_QUEUE } from "./sms-outbox-sweeper.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../db/migrations");
const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

interface Fixture {
  readonly tenantId: string;
  readonly smsId: string;
}

describeIntegration("SmsOutboxSweeper (integration)", () => {
  let db: AnyDb;

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await db.destroy();
  });

  /** A tenant with one pending receipt already in its outbox. */
  async function tenantWithPendingReceipt(): Promise<Fixture> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tenantId = await withSystem(db, async (tx) => {
      const created = await repositories(tx).tenants.create({
        slug: `sweep-${stamp}`,
        name: "Sweep",
        legalEntity: "Sweep Revenue",
        config: {},
      });
      return created.id;
    });
    const smsId = await withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      const asset = await repos.assets.create({
        tenantId,
        zoneId: null,
        ownerId: null,
        assetTypeKey: "bike",
        attributes: {},
        qrPayload: `sweep-${stamp}`,
        qrToken: `sweep-${stamp}-token`,
        shortCode: "S1",
        createdByUserId: null,
      });
      const period = await repos.obligations.create(tenantId, {
        assetId: asset.id,
        periodKey: "2026-06-15",
        businessDate: "2026-06-15",
        amountMinor: 20_000n,
        currency: "NGN",
      });
      const row = await repos.smsLog.enqueue(tenantId, {
        kind: "receipt",
        recipient: "+2348012345678",
        obligationPeriodId: period.id,
        body: "Receipt for your levy payment",
      });
      if (row === undefined) throw new Error("outbox row was not created");
      return row.id;
    });
    return { tenantId, smsId };
  }

  /** Delivery jobs the sweeper queued for one specific message. */
  function jobsFor(queue: MockJobQueue, smsId: string): unknown[] {
    return queue.pending
      .filter((job) => job.queue === SMS_DELIVERY_QUEUE)
      .map((job) => job.payload)
      .filter((payload) => (payload as { smsId?: string }).smsId === smsId);
  }

  /**
   * The sweeper is deliberately cross-tenant, so a test that wants to observe
   * one specific message must look past every other pending row in the database.
   */
  function sweeperOver(queue: MockJobQueue): ReturnType<typeof createSmsOutboxSweeper> {
    return createSmsOutboxSweeper({ db, queue, batchSize: 10_000 });
  }

  it("enqueues a delivery job carrying the tenant and the message id", async () => {
    const fixture = await tenantWithPendingReceipt();
    const queue = createMockJobQueue();

    await sweeperOver(queue).sweep();
    expect(jobsFor(queue, fixture.smsId)).toEqual([
      { tenantId: fixture.tenantId, smsId: fixture.smsId },
    ]);
  });

  it("does not enqueue the same message twice", async () => {
    const fixture = await tenantWithPendingReceipt();
    const queue = createMockJobQueue();
    const sweeper = sweeperOver(queue);

    await sweeper.sweep();
    await sweeper.sweep();
    // The dedupe key is the message id, so the second sweep resolves to the
    // job the first one made rather than queueing a second SMS.
    expect(jobsFor(queue, fixture.smsId)).toHaveLength(1);
  });

  it("returns the number of messages it queued", async () => {
    await tenantWithPendingReceipt();
    const queue = createMockJobQueue();
    const sweeper = sweeperOver(queue);
    const first = await sweeper.sweep();
    expect(first).toBeGreaterThan(0);
    // A second sweep finds the same rows still pending, but each resolves to the
    // job the first sweep already made, so no second delivery is ever queued.
    const before = queue.pending.length;
    await sweeper.sweep();
    expect(queue.pending.length).toBe(before);
  });

  it("keeps the outbox body inside its own tenant", async () => {
    const mine = await tenantWithPendingReceipt();
    const other = await tenantWithPendingReceipt();

    // The sweeper learns ids only; the body stays behind row-level security, so
    // a tenant-scoped read cannot see a row belonging to another tenant.
    const seen = await withTenant(db, other.tenantId, async (tx) =>
      repositories(tx).smsLog.claimPending(other.tenantId, 100),
    );
    const ids = seen.map((row) => row.id);
    expect(ids).toContain(other.smsId);
    expect(ids).not.toContain(mine.smsId);
  });
});
