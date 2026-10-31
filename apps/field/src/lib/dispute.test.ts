import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { recordDispute } from "./dispute.js";
import type { DisputeAttempt } from "./dispute.js";
import { getDb, listOutbox } from "../offline/store.js";

const ATTEMPT: DisputeAttempt = {
  clientDisputeId: "dispute-1",
  occurredAt: "2026-06-15T09:00:00.000Z",
  reason: "already_paid",
  description: "Driver showed a receipt from this morning.",
  reference: "A000001",
};

async function reset(): Promise<void> {
  const db = await getDb();
  await db.clear("outbox");
}

describe("recordDispute", () => {
  beforeEach(async () => {
    await reset();
  });

  it("records online and returns the dispute id", async () => {
    const outcome = await recordDispute(ATTEMPT, {
      online: () => true,
      post: () => Promise.resolve({ status: "recorded", disputeId: "d-1" }),
    });
    expect(outcome).toEqual({ status: "recorded", disputeId: "d-1" });
    expect(await listOutbox()).toHaveLength(0);
  });

  it("queues offline with the id and reason preserved", async () => {
    const outcome = await recordDispute(ATTEMPT, { online: () => false });
    expect(outcome.status).toBe("queued");

    const items = await listOutbox();
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("dispute");
    expect(items[0]?.id).toBe("dispute-1");
    const payload = items[0]?.payload as Record<string, unknown>;
    expect(payload.clientDisputeId).toBe("dispute-1");
    expect(payload.reason).toBe("already_paid");
    expect(payload.reference).toBe("A000001");
    expect(payload.occurredAt).toBe("2026-06-15T09:00:00.000Z");
  });

  it("queues the same dispute once when it is retried", async () => {
    await recordDispute(ATTEMPT, { online: () => false });
    await recordDispute(ATTEMPT, { online: () => false });
    expect(await listOutbox()).toHaveLength(1);
  });

  it("does not queue a dispute the office refused", async () => {
    const outcome = await recordDispute(ATTEMPT, {
      online: () => true,
      post: () => Promise.resolve({ status: "rejected" }),
    });
    expect(outcome.status).toBe("rejected");
    expect(await listOutbox()).toHaveLength(0);
  });

  it("queues when the server is unwell", async () => {
    const outcome = await recordDispute(ATTEMPT, {
      online: () => true,
      post: () => Promise.resolve({ status: "queued" }),
    });
    expect(outcome.status).toBe("queued");
    expect(await listOutbox()).toHaveLength(1);
  });

  it("reports a full queue rather than dropping the dispute", async () => {
    await recordDispute({ ...ATTEMPT, maxQueueItems: 1 }, { online: () => false });
    const outcome = await recordDispute(
      { ...ATTEMPT, clientDisputeId: "dispute-2", maxQueueItems: 1 },
      { online: () => false },
    );
    expect(outcome.status).toBe("queue_full");
    expect(await listOutbox()).toHaveLength(1);
  });

  it("carries evidence into the queued payload", async () => {
    await recordDispute(
      { ...ATTEMPT, evidence: { contentType: "image/jpeg", contentBase64: "abc" } },
      { online: () => false },
    );
    const payload = (await listOutbox())[0]?.payload as Record<string, unknown>;
    expect(payload.evidence).toEqual({ contentType: "image/jpeg", contentBase64: "abc" });
  });
});
