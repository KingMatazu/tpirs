export interface JobContext {
  readonly jobId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
}

export type JobHandler = (payload: unknown, context: JobContext) => Promise<void>;

export interface EnqueueOptions {
  readonly maxAttempts?: number;
  readonly runAt?: Date;
  readonly dedupeKey?: string;
}

export interface JobQueue {
  /** Returns the job id. A dedupeKey that is already queued returns the existing job id. */
  enqueue(queue: string, payload: unknown, options?: EnqueueOptions): Promise<string>;
  registerHandler(queue: string, handler: JobHandler): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
