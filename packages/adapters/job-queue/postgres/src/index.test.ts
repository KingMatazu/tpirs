import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { sql } from "kysely";
import { createDb, migrateUp } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { createJobQueueConformanceSuite } from "@tpirs/contracts";
import { createPostgresJobQueue } from "./index.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../../../db/migrations");
const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

interface JobRow {
  readonly id: string;
  readonly status: string;
  readonly attempts: number;
  /** The CamelCasePlugin rewrites result keys, so raw SQL returns `lastError`. */
  readonly lastError: string | null;
  readonly runAt: Date;
}

describeIntegration("job-queue-postgres (integration)", () => {
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

  async function queueName(): Promise<string> {
    return `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function row(id: string): Promise<JobRow | undefined> {
    const result = await sql<JobRow>`
      select id, status, attempts, last_error, run_at from jobs where id = ${id}
    `.execute(db);
    return result.rows[0];
  }

  createJobQueueConformanceSuite({ describe, it, expect }, () => ({
    port: createPostgresJobQueue({ db, pollIntervalMs: 5 }),
  }));

  it("runs a claimed job to completion exactly once", async () => {
    const queue = createPostgresJobQueue({ db, batchSize: 5 });
    const queueKey = await queueName();
    const seen: unknown[] = [];
    queue.registerHandler(queueKey, async (payload) => {
      seen.push(payload);
    });

    const id = await queue.enqueue(queueKey, { n: 1 });
    expect(await queue.tick()).toBe(1);
    expect(seen).toEqual([{ n: 1 }]);

    expect((await row(id))?.status).toBe("done");
    // A completed job is never claimed again.
    expect(await queue.tick()).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it("returns the live job for a repeated dedupe key", async () => {
    const queue = createPostgresJobQueue({ db });
    const queueKey = await queueName();
    const first = await queue.enqueue(queueKey, { n: 1 }, { dedupeKey: "receipt-1" });
    const second = await queue.enqueue(queueKey, { n: 2 }, { dedupeKey: "receipt-1" });
    expect(second).toBe(first);

    const count = await sql<{ n: bigint }>`
      select count(*) as n from jobs where queue = ${queueKey}
    `.execute(db);
    expect(count.rows[0]?.n).toBe(1n);
  });

  it("honours runAt by leaving a future job unclaimed", async () => {
    const queue = createPostgresJobQueue({ db });
    const queueKey = await queueName();
    queue.registerHandler(queueKey, async () => undefined);
    const id = await queue.enqueue(queueKey, {}, { runAt: new Date(Date.now() + 60_000) });
    expect(await queue.tick()).toBe(0);
    expect((await row(id))?.status).toBe("pending");
  });

  it("retries with backoff and then dead-letters an always failing job", async () => {
    const queue = createPostgresJobQueue({ db });
    const queueKey = await queueName();
    let calls = 0;
    queue.registerHandler(queueKey, async () => {
      calls += 1;
      throw new Error("gateway refused");
    });

    const id = await queue.enqueue(queueKey, {}, { maxAttempts: 2 });

    expect(await queue.tick()).toBe(1);
    const afterFirst = await row(id);
    expect(calls).toBe(1);
    expect(afterFirst?.status).toBe("pending");
    expect(afterFirst?.attempts).toBe(1);
    expect(afterFirst?.lastError).toBe("gateway refused");
    // Backoff pushed it into the future, so it is not due on the next tick.
    expect(await queue.tick()).toBe(0);

    // Make it due again and let it exhaust its attempts.
    await sql`update jobs set run_at = now() where id = ${id}`.execute(db);
    expect(await queue.tick()).toBe(1);
    const dead = await row(id);
    expect(calls).toBe(2);
    expect(dead?.status).toBe("dead");
    expect(dead?.attempts).toBe(2);
  });

  it("frees a dedupe key once the job is finished", async () => {
    const queue = createPostgresJobQueue({ db });
    const queueKey = await queueName();
    queue.registerHandler(queueKey, async () => undefined);

    const first = await queue.enqueue(queueKey, {}, { dedupeKey: "once" });
    await queue.tick();
    const second = await queue.enqueue(queueKey, {}, { dedupeKey: "once" });
    expect(second).not.toBe(first);
  });

  it("stops a polling worker cleanly", async () => {
    const queue = createPostgresJobQueue({ db, pollIntervalMs: 5 });
    const queueKey = await queueName();
    const seen: unknown[] = [];
    queue.registerHandler(queueKey, async (payload) => {
      seen.push(payload);
    });
    await queue.start();
    await queue.enqueue(queueKey, { hello: "worker" });
    // Give the loop a moment to pick the job up.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await queue.stop();
    expect(seen).toEqual([{ hello: "worker" }]);
  });

  it("refuses to rewrite a job's payload", async () => {
    const queue = createPostgresJobQueue({ db });
    const id = await queue.enqueue(await queueName(), { n: 1 });
    await expect(
      sql`update jobs set payload = ${JSON.stringify({ n: 2 })}::jsonb where id = ${id}`.execute(
        db,
      ),
    ).rejects.toThrow(/job identity is immutable/);
  });
});
