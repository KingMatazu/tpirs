import type { EnqueueOptions, JobHandler, JobQueue } from "@tpirs/ports";

interface PendingJob {
  readonly id: string;
  readonly queue: string;
  readonly payload: unknown;
  readonly maxAttempts: number;
}

export interface MockJobQueue extends JobQueue {
  /** Jobs accepted but not yet processed (test inspection). */
  readonly pending: PendingJob[];
  /** Process every pending job with its registered handler. */
  drain(): Promise<void>;
}

export function createMockJobQueue(): MockJobQueue {
  const handlers = new Map<string, JobHandler>();
  const dedupe = new Map<string, string>();
  const pending: PendingJob[] = [];
  let counter = 0;

  return {
    pending,
    enqueue(queue, payload, options: EnqueueOptions = {}) {
      if (options.dedupeKey !== undefined) {
        const existing = dedupe.get(options.dedupeKey);
        if (existing !== undefined) return Promise.resolve(existing);
      }
      counter += 1;
      const id = `mock-job-${String(counter)}`;
      pending.push({
        id,
        queue,
        payload,
        maxAttempts: options.maxAttempts ?? 3,
      });
      if (options.dedupeKey !== undefined) {
        dedupe.set(options.dedupeKey, id);
      }
      return Promise.resolve(id);
    },
    registerHandler(queue, handler) {
      handlers.set(queue, handler);
    },
    start() {
      // no-op: processing happens via drain() in tests
      return Promise.resolve();
    },
    stop() {
      // no-op: processing happens via drain() in tests
      return Promise.resolve();
    },
    async drain() {
      while (pending.length > 0) {
        const job = pending.shift();
        if (job === undefined) break;
        const handler = handlers.get(job.queue);
        if (handler === undefined) {
          throw new Error(`No handler registered for queue "${job.queue}"`);
        }
        await handler(job.payload, {
          jobId: job.id,
          attempt: 1,
          maxAttempts: job.maxAttempts,
        });
      }
    },
  };
}

export type { PendingJob };
