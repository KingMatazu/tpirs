import { api } from "../api/client.js";
import { enqueueOutbox } from "../offline/store.js";

/**
 * A dispute raised from the result card.
 *
 * Same shape as recording a scan, and for the same reasons: the id is generated
 * when the officer taps send and travels with the item, so a retry cannot raise
 * the same dispute twice; a dead zone queues it; a refusal does not.
 */
export interface DisputeDraft {
  readonly reason: string;
  readonly description: string;
  readonly reference?: string;
  readonly assetId?: string;
  readonly evidence?: { readonly contentType: string; readonly contentBase64: string };
  readonly latitude?: number;
  readonly longitude?: number;
}

export interface DisputeAttempt extends DisputeDraft {
  readonly clientDisputeId: string;
  readonly occurredAt: string;
  /** From `field.maxQueueItems`; omitted means unlimited. */
  readonly maxQueueItems?: number;
}

export type DisputeOutcome =
  | { readonly status: "recorded"; readonly disputeId: string }
  | { readonly status: "queued" }
  | { readonly status: "queue_full" }
  | { readonly status: "rejected" };

export interface DisputeDeps {
  readonly post?: (attempt: DisputeAttempt) => Promise<DisputeOutcome>;
  readonly online?: () => boolean;
  readonly queue?: (attempt: DisputeAttempt) => Promise<"queued" | "full">;
}

export async function recordDispute(
  attempt: DisputeAttempt,
  deps: DisputeDeps = {},
): Promise<DisputeOutcome> {
  const online = deps.online ?? (() => globalThis.navigator.onLine);
  const queue = deps.queue ?? defaultQueue;

  if (!online()) {
    return (await queue(attempt)) === "queued" ? { status: "queued" } : { status: "queue_full" };
  }

  const post = deps.post ?? postDispute;
  const outcome = await post(attempt);
  if (outcome.status === "recorded" || outcome.status === "rejected") return outcome;

  return (await queue(attempt)) === "queued" ? { status: "queued" } : { status: "queue_full" };
}

async function defaultQueue(attempt: DisputeAttempt): Promise<"queued" | "full"> {
  return enqueueOutbox(
    {
      id: attempt.clientDisputeId,
      kind: "dispute",
      payload: body(attempt),
      createdAt: attempt.occurredAt,
    },
    attempt.maxQueueItems,
  );
}

function body(attempt: DisputeAttempt): {
  clientDisputeId: string;
  reason: string;
  description: string;
  occurredAt: string;
  reference?: string;
  assetId?: string;
  latitude?: number;
  longitude?: number;
  evidence?: { contentType: string; contentBase64: string };
} {
  return {
    clientDisputeId: attempt.clientDisputeId,
    reason: attempt.reason,
    description: attempt.description,
    occurredAt: attempt.occurredAt,
    ...(attempt.reference === undefined ? {} : { reference: attempt.reference }),
    ...(attempt.assetId === undefined ? {} : { assetId: attempt.assetId }),
    ...(attempt.latitude === undefined ? {} : { latitude: attempt.latitude }),
    ...(attempt.longitude === undefined ? {} : { longitude: attempt.longitude }),
    ...(attempt.evidence === undefined ? {} : { evidence: attempt.evidence }),
  };
}

async function postDispute(attempt: DisputeAttempt): Promise<DisputeOutcome> {
  try {
    const result = await api.POST("/v1/disputes", { body: body(attempt) });
    const status = result.response.status;
    // The server will answer the same way however often we ask.
    if (status === 400 || status === 403 || status === 404 || status === 422) {
      return { status: "rejected" };
    }
    if (!result.response.ok) return { status: "queued" };
    const disputeId = result.data?.disputeId;
    return { status: "recorded", disputeId: disputeId ?? "" };
  } catch {
    // A rejected fetch is a dead zone.
    return { status: "queued" };
  }
}
