import { api } from "../api/client.js";
import { FLUSH_BUDGET, afterFailure, afterRejection, planFlush } from "../lib/outbox.js";
import type { OutboxItem } from "./store.js";
import { listOutbox, removeOutbox, updateOutboxItem } from "./store.js";

/** Why a flush stopped before the queue was empty. */
export type FlushStopReason = "offline" | "rate_limited" | "auth" | "error";

export type PostResult =
  | { readonly status: "ok" }
  /** The server refused it for good (404, 422): retrying cannot help. */
  | { readonly status: "rejected"; readonly reason: string }
  /** Worth another attempt: a dead zone, a 5xx, a throttle. */
  | {
      readonly status: "retry";
      readonly retryAfterSeconds?: number;
      /** The request never reached the server. */
      readonly offline?: boolean;
    }
  | { readonly status: "auth" };

export interface FlushOutcome {
  readonly sent: number;
  readonly rejected: number;
  readonly deferred: number;
  readonly remaining: number;
  readonly stopReason: FlushStopReason | undefined;
}

export interface FlushDeps {
  readonly post?: (item: OutboxItem) => Promise<PostResult>;
  /** Renews the session once after a 401. Returns false when it cannot. */
  readonly refresh?: () => Promise<boolean>;
  readonly now?: () => Date;
  readonly budget?: number;
}

/**
 * Uploads what the phone is holding, oldest first.
 *
 * The invariants:
 *
 * - **Nothing is lost.** An item leaves the outbox only when the server accepted
 *   it, or when the server refused it for a reason that will not change — and in
 *   that case it is kept, marked failed, and shown to the officer.
 * - **Nothing is duplicated.** The `clientScanId` was generated when the scan
 *   happened, so a retry after a timeout is the same scan to the server.
 * - **The server is not hammered.** At most `budget` items per pass, a 429 stops
 *   the pass and its `Retry-After` is respected, and each further failure backs
 *   off exponentially with jitter.
 * - **A dead zone ends the pass.** Every further attempt would just be another
 *   radio wake-up.
 */
export async function flushOutbox(deps: FlushDeps = {}): Promise<FlushOutcome> {
  const now = deps.now ?? (() => new Date());
  const post = deps.post ?? postOutboxItem;
  const budget = deps.budget ?? FLUSH_BUDGET;

  const planned = planFlush(await listOutbox(), now(), budget);
  let sent = 0;
  let rejected = 0;
  let deferred = 0;
  let stopReason: FlushStopReason | undefined;
  let refreshed = false;

  for (const item of planned) {
    let result = await post(item);

    if (result.status === "auth" && !refreshed && deps.refresh !== undefined) {
      // One renewal attempt per pass: a token that expired mid-shift is normal,
      // a token the server keeps refusing is a sign-in problem.
      refreshed = true;
      const renewed = await deps.refresh();
      if (renewed) result = await post(item);
    }

    switch (result.status) {
      case "ok":
        await removeOutbox(item.id);
        sent += 1;
        continue;
      case "rejected":
        await updateOutboxItem(afterRejection(item, result.reason));
        rejected += 1;
        continue;
      case "auth":
        stopReason = "auth";
        break;
      case "retry": {
        await updateOutboxItem(afterFailure(item, now(), result.retryAfterSeconds));
        deferred += 1;
        stopReason =
          result.offline === true
            ? "offline"
            : result.retryAfterSeconds === undefined
              ? "error"
              : "rate_limited";
        break;
      }
    }
    // A stop reason means this pass is over; the rest stay queued and keep their
    // position.
    break;
  }

  return {
    sent,
    rejected,
    deferred,
    remaining: (await listOutbox()).length,
    stopReason,
  };
}

/**
 * The real transport. The endpoint depends on what is being uploaded, and the
 * status codes are read as *policy* rather than as errors: a 404 is final, a 429
 * is a delay, a 401 is a session that needs renewing.
 */
async function postOutboxItem(item: OutboxItem): Promise<PostResult> {
  try {
    const response =
      item.kind === "scan"
        ? await api.POST("/v1/scans", { body: scanBody(item.payload) })
        : await api.POST("/v1/disputes", { body: disputeBody(item.payload) });

    const status = response.response.status;
    if (status === 401) return { status: "auth" };
    if (status === 429) {
      const retryAfter = Number(response.response.headers.get("retry-after") ?? "");
      return {
        status: "retry",
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
      };
    }
    // The server will answer the same way however many times we ask.
    if (status === 400 || status === 403 || status === 404 || status === 422) {
      return { status: "rejected", reason: `http_${String(status)}` };
    }
    if (!response.response.ok) return { status: "retry" };
    return { status: "ok" };
  } catch {
    // A rejected fetch is a dead zone: every further attempt is another radio
    // wake-up for nothing.
    return { status: "retry", offline: true };
  }
}

/**
 * The queued payload is already the request body the app built when the scan
 * happened; these types restate the contract so a field the API stops accepting
 * is a compile error here rather than a 400 in a dead zone.
 */
interface QueuedScanBody {
  clientScanId: string;
  source: "qr" | "manual" | "offline_queue";
  scannedAt: string;
  token?: string;
  reference?: string;
  observedStatus?: string;
  latitude?: number;
  longitude?: number;
}

interface QueuedDisputeBody {
  clientDisputeId: string;
  assetId?: string;
  reference?: string;
  reason: string;
  description: string;
  occurredAt: string;
  latitude?: number;
  longitude?: number;
  evidence?: { contentType: string; contentBase64: string };
}

function scanBody(payload: unknown): QueuedScanBody {
  return payload as QueuedScanBody;
}

function disputeBody(payload: unknown): QueuedDisputeBody {
  return payload as QueuedDisputeBody;
}
