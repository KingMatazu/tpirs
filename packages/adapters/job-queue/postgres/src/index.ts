import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { AnyDb } from "@tpirs/db";
import type { EnqueueOptions, JobHandler, JobQueue } from "@tpirs/ports";

export interface PostgresJobQueueOptions {
  readonly db: AnyDb;
  /** How long an idle worker waits before looking for work again. */
  readonly pollIntervalMs?: number;
  /** Identifies this worker in `locked_by`; defaults to a random id. */
  readonly workerId?: string;
  /** Jobs claimed per poll. Bounded so one worker cannot hog the queue. */
  readonly batchSize?: number;
  readonly now?: () => Date;
}

export interface PostgresJobQueue extends JobQueue {
  /** Run one claim-and-execute pass; used by tests and by `start`. */
  tick(): Promise<number>;
}

interface ClaimedJob {
  readonly id: string;
  readonly queue: string;
  readonly payload: unknown;
  readonly attempts: number;
  /**
   * The CamelCasePlugin rewrites result keys, so a snake_case column arrives as
   * camelCase and a snake_case TypeScript field would silently read undefined.
   */
  readonly maxAttempts: number;
}

/** Exponential backoff, capped, so a flaky gateway is retried calmly. */
function backoffMs(attempt: number, baseMs = 1_000): number {
  const capped = Math.min(attempt, 10);
  return Math.min(baseMs * 2 ** (capped - 1), 60 * 60 * 1_000);
}

/**
 * A `JobQueue` backed by Postgres (ADR 0020).
 *
 * Jobs live in one table and are claimed with `FOR UPDATE SKIP LOCKED`, so many
 * workers run at once without a distributed lock service and without
 * serialising on each other. A failing job is rescheduled with exponential
 * backoff; a job that exhausts `maxAttempts` is marked dead rather than deleted,
 * so a receipt nobody could deliver stays visible to operations.
 *
 * The adapter deliberately does not carry payment intake: `webhook_events` is
 * the intake outbox (ADR 0016). This queue is for the work that follows, and a
 * dedupe key makes enqueueing that work twice a no-op.
 */
export function createPostgresJobQueue(options: PostgresJobQueueOptions): PostgresJobQueue {
  const db = options.db;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const batchSize = options.batchSize ?? 10;
  const workerId = options.workerId ?? `worker-${randomUUID()}`;
  const now = options.now ?? (() => new Date());

  const handlers = new Map<string, JobHandler>();
  let running = false;
  let loopDone: Promise<void> | undefined;
  let stopSignal: (() => void) | undefined;

  async function enqueue(
    queue: string,
    payload: unknown,
    enqueueOptions: EnqueueOptions = {},
  ): Promise<string> {
    const maxAttempts = enqueueOptions.maxAttempts ?? 3;
    const runAt = enqueueOptions.runAt ?? now();
    const dedupeKey = enqueueOptions.dedupeKey ?? null;

    // A live dedupe key resolves to the job it already made. `ON CONFLICT` on
    // the partial unique index turns a raced double-enqueue into the same row
    // rather than an error, so the caller never has to catch one.
    if (dedupeKey !== null) {
      const existing = await sql<{ id: string }>`
        select id from jobs
        where queue = ${queue} and dedupe_key = ${dedupeKey} and status in ('pending', 'running')
      `.execute(db);
      const found = existing.rows[0];
      if (found !== undefined) return found.id;
    }

    const inserted = await sql<{ id: string }>`
      insert into jobs (queue, payload, dedupe_key, max_attempts, run_at)
      values (${queue}, ${JSON.stringify(payload)}::jsonb, ${dedupeKey}, ${maxAttempts}, ${runAt})
      on conflict do nothing
      returning id
    `.execute(db);
    const created = inserted.rows[0];
    if (created !== undefined) return created.id;

    // Lost a race on the dedupe index: the winner's job is the one to return.
    if (dedupeKey !== null) {
      const raced = await sql<{ id: string }>`
        select id from jobs
        where queue = ${queue} and dedupe_key = ${dedupeKey} and status in ('pending', 'running')
      `.execute(db);
      const winner = raced.rows[0];
      if (winner !== undefined) return winner.id;
    }
    throw new Error(`Could not enqueue a job on queue "${queue}"`);
  }

  function registerHandler(queue: string, handler: JobHandler): void {
    handlers.set(queue, handler);
  }

  /** Claims and runs one batch. Returns the number of jobs attempted. */
  async function tick(): Promise<number> {
    // Only queues this worker has a handler for are claimed: a job nobody can
    // run would be locked, fail as "no handler", and burn an attempt.
    const queues = [...handlers.keys()];
    if (queues.length === 0) return 0;

    const claimed = await sql<ClaimedJob>`
      with claimed as (
        select id from jobs
        where status = 'pending' and run_at <= now() and queue = any(${queues}::text[])
        order by run_at
        limit ${batchSize}
        for update skip locked
      )
      update jobs
      set status = 'running',
          locked_at = now(),
          locked_by = ${workerId},
          attempts = jobs.attempts + 1,
          updated_at = now()
      from claimed
      where jobs.id = claimed.id
      returning jobs.id, jobs.queue, jobs.payload, jobs.attempts, jobs.max_attempts as "maxAttempts"
    `.execute(db);

    for (const job of claimed.rows) {
      if (typeof job.maxAttempts !== "number") {
        // A silent undefined here would make every job retry forever instead of
        // dead-lettering, so the shape is checked rather than trusted.
        throw new Error(`Claimed job ${job.id} is missing maxAttempts`);
      }
    }

    await Promise.all(claimed.rows.map((job) => runJob(job)));
    return claimed.rows.length;
  }

  async function runJob(job: ClaimedJob): Promise<void> {
    const handler = handlers.get(job.queue);
    try {
      // `tick` claims only queues with a handler, so this cannot happen unless
      // a handler is unregistered between the claim and the run.
      if (handler === undefined) {
        throw new Error(`No handler registered for queue "${job.queue}"`);
      }
      await handler(job.payload, {
        jobId: job.id,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
      });
      await sql`
        update jobs
        set status = 'done', completed_at = now(), updated_at = now(),
            locked_at = null, locked_by = null
        where id = ${job.id}
      `.execute(db);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (job.attempts >= job.maxAttempts) {
        // Dead, not deleted: an undeliverable receipt must stay inspectable.
        await sql`
          update jobs
          set status = 'dead', last_error = ${message}, updated_at = now(),
              locked_at = null, locked_by = null
          where id = ${job.id}
        `.execute(db);
        return;
      }
      const runAt = new Date(now().getTime() + backoffMs(job.attempts));
      await sql`
        update jobs
        set status = 'pending', run_at = ${runAt}, last_error = ${message}, updated_at = now(),
            locked_at = null, locked_by = null
        where id = ${job.id}
      `.execute(db);
    }
  }

  async function start(): Promise<void> {
    if (running) return;
    running = true;
    let signalStop: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      signalStop = resolve;
    });
    loopDone = (async () => {
      // A worker that is stopped mid-claim leaves its job `running`; the next
      // start does not need to reclaim it because a finished job is only ever
      // marked done by the worker that holds it.
      for (;;) {
        let processed = 0;
        try {
          processed = await tick();
        } catch {
          // A database blip must not kill the loop; the next tick retries.
          processed = 0;
        }
        if (processed > 0) continue;
        // Sleep, but wake immediately when `stop` is called.
        const idle = await Promise.race([
          sleep(pollIntervalMs).then(() => "tick" as const),
          stopped.then(() => "stop" as const),
        ]);
        if (idle === "stop") return;
      }
    })();
    stopSignal = signalStop;
    await Promise.resolve();
  }

  async function stop(): Promise<void> {
    running = false;
    stopSignal?.();
    await loopDone;
    loopDone = undefined;
    stopSignal = undefined;
  }

  return { enqueue, registerHandler, start, stop, tick };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
