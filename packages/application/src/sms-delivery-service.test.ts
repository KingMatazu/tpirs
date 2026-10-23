import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createDb, migrateUp, repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { createMockSmsProvider } from "@tpirs/sms-provider-mock";
import { createSmsDeliveryService } from "./sms-delivery-service.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../db/migrations");
const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

interface Fixture {
  readonly tenantId: string;
  readonly smsId: string;
}

describeIntegration("SmsDeliveryService (integration)", () => {
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

  /** A tenant with one pending receipt in its outbox. */
  async function tenantWithPendingReceipt(recipient = "+2348012345678"): Promise<Fixture> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tenantId = await withSystem(db, async (tx) => {
      const created = await repositories(tx).tenants.create({
        slug: `deliver-${stamp}`,
        name: "Deliver",
        legalEntity: "Deliver Revenue",
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
        qrPayload: `deliver-${stamp}`,
        qrToken: `deliver-${stamp}-token`,
        shortCode: "D1",
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
        recipient,
        obligationPeriodId: period.id,
        body: "Your levy payment is recorded",
      });
      if (row === undefined) throw new Error("outbox row was not created");
      return row.id;
    });
    return { tenantId, smsId };
  }

  async function statusOf(fixture: Fixture): Promise<string | undefined> {
    return withTenant(db, fixture.tenantId, async (tx) => {
      const row = await repositories(tx).smsLog.findById(fixture.tenantId, fixture.smsId);
      return row?.status;
    });
  }

  it("sends a pending message and records it as sent", async () => {
    const fixture = await tenantWithPendingReceipt();
    const sms = createMockSmsProvider();
    const service = createSmsDeliveryService({ db, sms });

    const result = await service.deliver(fixture.tenantId, fixture.smsId);
    expect(result.outcome).toBe("sent");
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]?.to).toBe("+2348012345678");
    expect(sms.sent[0]?.text).toBe("Your levy payment is recorded");
    expect(await statusOf(fixture)).toBe("sent");
  });

  it("keys the send by the outbox row so a retry cannot duplicate the SMS", async () => {
    const fixture = await tenantWithPendingReceipt();
    const sms = createMockSmsProvider();
    const service = createSmsDeliveryService({ db, sms });

    await service.deliver(fixture.tenantId, fixture.smsId);
    expect(sms.sent[0]?.idempotencyKey).toBe(`sms:${fixture.smsId}`);
  });

  it("is a no-op when the same message is delivered twice", async () => {
    const fixture = await tenantWithPendingReceipt();
    const sms = createMockSmsProvider();
    const service = createSmsDeliveryService({ db, sms });

    await service.deliver(fixture.tenantId, fixture.smsId);
    const second = await service.deliver(fixture.tenantId, fixture.smsId);
    expect(second.outcome).toBe("already_delivered");
    expect(sms.sent).toHaveLength(1);
  });

  it("records a gateway failure without losing the message", async () => {
    const fixture = await tenantWithPendingReceipt();
    const sms = createMockSmsProvider();
    sms.failNextSend("unavailable");
    const service = createSmsDeliveryService({ db, sms });

    const result = await service.deliver(fixture.tenantId, fixture.smsId);
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("unavailable");
    // The row stays visible to operations; the queue owns the retry.
    expect(await statusOf(fixture)).toBe("failed");
  });

  it("cannot deliver a message belonging to another tenant", async () => {
    const mine = await tenantWithPendingReceipt();
    const other = await tenantWithPendingReceipt();
    const sms = createMockSmsProvider();
    const service = createSmsDeliveryService({ db, sms });

    // Row-level security means a foreign id resolves to nothing at all.
    const result = await service.deliver(other.tenantId, mine.smsId);
    expect(result.outcome).toBe("missing");
    expect(sms.sent).toHaveLength(0);
    expect(await statusOf(mine)).toBe("pending");
  });

  it("passes the tenant's sender id to the gateway when one is configured", async () => {
    const fixture = await tenantWithPendingReceipt();
    const sms = createMockSmsProvider();
    const service = createSmsDeliveryService({
      db,
      sms,
      senderIdFor: () => Promise.resolve("TPIRS"),
    });

    await service.deliver(fixture.tenantId, fixture.smsId);
    expect(sms.sent[0]?.senderId).toBe("TPIRS");
  });
});
