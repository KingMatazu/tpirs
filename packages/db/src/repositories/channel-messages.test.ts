import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AnyDb } from "../connection.js";
import { createDb, migrateUp, repositories, withSystem, withTenant } from "../index.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../migrations");
const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

describeIntegration("channel message repository (integration)", () => {
  let db: AnyDb;
  let tenantId: string;
  let otherTenantId: string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);

    await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const tenant = await repos.tenants.create({
        slug: `channel-${stamp}`,
        name: "Channel State",
        legalEntity: "Channel Revenue",
        config: {},
      });
      const other = await repos.tenants.create({
        slug: `channel-other-${stamp}`,
        name: "Other State",
        legalEntity: "Other Revenue",
        config: {},
      });
      tenantId = tenant.id;
      otherTenantId = other.id;
    });
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await db.destroy();
  });

  it("records an inbound callback once and treats a replay as a no-op", async () => {
    const params = {
      channel: "sms" as const,
      recipient: "+2348000000001",
      body: "LEVY KJA-123",
      providerMessageId: `sms-${stamp}-1`,
      dedupeKey: `sms:${stamp}:1`,
    };

    const first = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).channelMessages.recordInbound(tenantId, params),
    );
    expect(first?.direction).toBe("inbound");
    expect(first?.status).toBe("received");

    const replay = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).channelMessages.recordInbound(tenantId, params),
    );
    expect(replay).toBeUndefined();

    const found = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).channelMessages.findById(tenantId, first?.id ?? ""),
    );
    expect(found?.id).toBe(first?.id);
  });

  it("enqueues an outbound message once per dedupe key", async () => {
    const params = {
      channel: "sms" as const,
      kind: "status" as const,
      recipient: "+2348000000001",
      body: "No payment recorded today for KJA-123.",
      dedupeKey: `reply:${stamp}:1`,
    };

    const first = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).channelMessages.enqueueOutbound(tenantId, params),
    );
    expect(first?.direction).toBe("outbound");
    expect(first?.status).toBe("pending");

    const second = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).channelMessages.enqueueOutbound(tenantId, params),
    );
    expect(second).toBeUndefined();
  });

  it("never exposes one tenant's messages to another tenant", async () => {
    const created = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).channelMessages.recordInbound(tenantId, {
        channel: "ussd",
        recipient: "+2348000000002",
        body: "1",
        dedupeKey: `ussd:${stamp}:isolation`,
      }),
    );
    expect(created?.id).toBeDefined();

    const crossTenant = await withTenant(db, otherTenantId, async (tx) =>
      repositories(tx).channelMessages.findById(otherTenantId, created?.id ?? ""),
    );
    expect(crossTenant).toBeUndefined();

    const otherPending = await withTenant(db, otherTenantId, async (tx) =>
      repositories(tx).channelMessages.claimPending(otherTenantId, 10),
    );
    expect(otherPending).toEqual([]);
  });

  it("claims pending outbound messages and moves them through delivery states", async () => {
    const created = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).channelMessages.enqueueOutbound(tenantId, {
        channel: "sms",
        kind: "payment",
        recipient: "+2348000000003",
        body: "Payment request created.",
        dedupeKey: `delivery:${stamp}:1`,
      }),
    );
    expect(created).toBeDefined();

    const claimed = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).channelMessages.claimPending(tenantId, 50),
    );
    expect(claimed.some((row) => row.id === created?.id)).toBe(true);

    const sentAt = new Date("2026-06-15T23:30:00Z");
    const sent = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).channelMessages.markSent(tenantId, created?.id ?? "", "provider-1", sentAt),
    );
    expect(sent?.status).toBe("sent");
    expect(sent?.sentAt?.toISOString()).toBe(sentAt.toISOString());
    expect(sent?.attempts).toBe(1);

    const failed = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).channelMessages.markFailed(tenantId, created?.id ?? "", "gateway down"),
    );
    expect(failed?.status).toBe("failed");
    expect(failed?.lastError).toBe("gateway down");
  });

  it("counts sent messages per tenant timezone business day", async () => {
    const created = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).channelMessages.enqueueOutbound(tenantId, {
        channel: "sms",
        kind: "receipt",
        recipient: "+2348000000004",
        body: "Receipt",
        dedupeKey: `count:${stamp}:1`,
      }),
    );
    await withTenant(db, tenantId, async (tx) =>
      repositories(tx).channelMessages.markSent(
        tenantId,
        created?.id ?? "",
        "provider-count",
        new Date("2026-06-15T23:30:00Z"),
      ),
    );

    // Lagos is UTC+1, so the message lands on 16 June even though its UTC
    // timestamp is still 15 June. The count must follow the tenant's day.
    const lagos = { channel: "sms" as const, timeZone: "Africa/Lagos" };
    const onTheSixteenth = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).channelMessages.countSentOnDate(tenantId, {
        ...lagos,
        businessDate: "2026-06-16",
      }),
    );
    const onTheFifteenth = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).channelMessages.countSentOnDate(tenantId, {
        ...lagos,
        businessDate: "2026-06-15",
      }),
    );
    const otherTenantCount = await withTenant(db, otherTenantId, async (tx) =>
      repositories(tx).channelMessages.countSentOnDate(otherTenantId, {
        ...lagos,
        businessDate: "2026-06-16",
      }),
    );

    expect(onTheSixteenth).toBe(1);
    expect(onTheFifteenth).toBe(0);
    expect(otherTenantCount).toBe(0);
  });

  it("rejects rewriting a recorded message's content", async () => {
    const created = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).channelMessages.enqueueOutbound(tenantId, {
        channel: "sms",
        kind: "notice",
        recipient: "+2348000000005",
        body: "Original",
        dedupeKey: `immutable:${stamp}:1`,
      }),
    );

    await expect(
      withTenant(db, tenantId, async (tx) =>
        tx
          .updateTable("channelMessages")
          .set({ body: "Tampered" })
          .where("tenantId", "=", tenantId)
          .where("id", "=", created?.id ?? "")
          .execute(),
      ),
    ).rejects.toThrow();
  });

  it("ships a reversible migration", async () => {
    const source = await readFile(path.join(migrationsDir, "0008_channel_messages.ts"), "utf8");
    expect(source).toContain("export async function down");
    expect(source).toContain("drop table if exists channel_messages");
  });
});
