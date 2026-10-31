import { api } from "../api/client.js";
import { enqueueOutbox } from "../offline/store.js";
import type { ServerScanResult } from "./scan-result.js";

export type ScanSource = "qr" | "manual";

export interface ScanAttempt {
  readonly clientScanId: string;
  readonly scannedAt: string;
  readonly source: ScanSource;
  readonly token?: string;
  readonly reference?: string;
  /** What the cache said before the upload, so the server can be compared to it. */
  readonly observed?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  /** From `field.maxQueueItems`; omitted means unlimited. */
  readonly maxQueueItems?: number;
}

export type RecordOutcome =
  | { readonly status: "recorded"; readonly result: ServerScanResult }
  | { readonly status: "queued" }
  | { readonly status: "queue_full" }
  | { readonly status: "rejected" };

export interface RecordDeps {
  readonly post?: (attempt: ScanAttempt) => Promise<RecordOutcome>;
  readonly online?: () => boolean;
  readonly queue?: (attempt: ScanAttempt) => Promise<"queued" | "full">;
}

/**
 * Records a scan, or queues it.
 *
 * The rule is that a scan is never lost and never duplicated:
 *
 * - The `clientScanId` is generated once, when the scan happens, and travels with
 *   it through the queue. The server deduplicates on `(tenant, clientScanId)`, so
 *   a retry after a timeout cannot count the same scan twice.
 * - A dead zone, a throttle or a server error queues the scan and shows the
 *   offline answer; the officer is told it will sync.
 * - A 404 does *not* queue: the sticker is not ours, so retrying forever would
 *   only delay the truth. The card says the code is not recognised.
 */
export async function recordScan(
  attempt: ScanAttempt,
  deps: RecordDeps = {},
): Promise<RecordOutcome> {
  const online = deps.online ?? (() => globalThis.navigator.onLine);
  const queue = deps.queue ?? defaultQueue;

  if (!online()) {
    return (await queue(attempt)) === "queued" ? { status: "queued" } : { status: "queue_full" };
  }

  const post = deps.post ?? postScan;
  const outcome = await post(attempt);
  if (outcome.status === "recorded" || outcome.status === "rejected") return outcome;

  // Retryable failure: keep it rather than dropping it on the ground.
  return (await queue(attempt)) === "queued" ? { status: "queued" } : { status: "queue_full" };
}

async function defaultQueue(attempt: ScanAttempt): Promise<"queued" | "full"> {
  return enqueueOutbox(
    {
      id: attempt.clientScanId,
      kind: "scan",
      payload: {
        clientScanId: attempt.clientScanId,
        // The queue is what the server sees when this finally uploads.
        source: "offline_queue",
        scannedAt: attempt.scannedAt,
        ...(attempt.token === undefined ? {} : { token: attempt.token }),
        ...(attempt.reference === undefined ? {} : { reference: attempt.reference }),
        ...(attempt.observed === undefined ? {} : { observedStatus: attempt.observed }),
        ...(attempt.latitude === undefined ? {} : { latitude: attempt.latitude }),
        ...(attempt.longitude === undefined ? {} : { longitude: attempt.longitude }),
      },
      createdAt: attempt.scannedAt,
    },
    attempt.maxQueueItems,
  );
}

async function postScan(attempt: ScanAttempt): Promise<RecordOutcome> {
  try {
    const result = await api.POST("/v1/scans", {
      body: {
        clientScanId: attempt.clientScanId,
        source: attempt.source,
        scannedAt: attempt.scannedAt,
        ...(attempt.token === undefined ? {} : { token: attempt.token }),
        ...(attempt.reference === undefined ? {} : { reference: attempt.reference }),
        ...(attempt.observed === undefined ? {} : { observedStatus: attempt.observed }),
        ...(attempt.latitude === undefined ? {} : { latitude: attempt.latitude }),
        ...(attempt.longitude === undefined ? {} : { longitude: attempt.longitude }),
      },
    });

    if (result.response.status === 404) return { status: "rejected" };
    if (!result.response.ok) return { status: "queued" };
    const body = result.data;
    if (body === undefined) return { status: "queued" };
    return { status: "recorded", result: body };
  } catch {
    // A rejected fetch is a dead zone, not an error to show an officer.
    return { status: "queued" };
  }
}
