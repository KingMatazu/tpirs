/**
 * Pure helpers behind the reversal queue (Step 5).
 *
 * A reversal is append-only: a finance user requests it with a reason and a
 * *different* finance user approves it, which posts mirrored ledger entries
 * (ADR 0013). This module owns the rules the page must get right without
 * rendering: the status labels and tones, the querystring, the exact request
 * bodies (a blank rejection reason is invalid, a blank approval note is simply
 * absent), and the dual-approval guard.
 *
 * `canApprove` mirrors the server's refusal: the ledger service rejects a
 * requester approving their own request with `409 self_approval`, so the page
 * must not even send that POST. The server stays the authority; this only
 * avoids an error the UI already knows about.
 *
 * Nothing here touches React, the client, or the DOM.
 */

/** The badge tones the dashboard understands, in step with `components/ui.tsx`. */
export type Tone = "neutral" | "brand" | "positive" | "warning" | "danger";

export type ReversalStatus = "pending" | "approved" | "rejected";

/** How many requests the queue asks for at a time. */
export const REVERSAL_PAGE_SIZE = 50;

/** The queue opens on work, not on history. */
export const DEFAULT_REVERSAL_STATUS: ReversalStatus = "pending";

/** One reversal request as `GET /v1/reversals` returns it. */
export interface ReversalView {
  readonly id: string;
  readonly originalTransactionId: string;
  readonly reason: string;
  readonly status: ReversalStatus;
  readonly requestedByUserId: string;
  readonly approvedByUserId: string | null;
  readonly rejectedByUserId: string | null;
  readonly approvedAt: string | null;
  readonly rejectedAt: string | null;
  readonly reversingTransactionId: string | null;
  readonly createdAt: string;
}

/** Filter choices rendered by the queue. `""` means "all". */
export const REVERSAL_STATUS_OPTIONS: readonly {
  readonly value: ReversalStatus | "";
  readonly label: string;
}[] = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "", label: "All statuses" },
];

/** A request's lifecycle state, as finance reads it. */
export function reversalStatusLabel(status: ReversalStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
  }
}

/** Pending work is amber; an approval is positive; a rejection is neutral. */
export function reversalStatusTone(status: ReversalStatus): Tone {
  switch (status) {
    case "pending":
      return "warning";
    case "approved":
      return "positive";
    case "rejected":
      return "neutral";
  }
}

export interface ReversalFilters {
  readonly status?: string;
  readonly limit?: number;
}

export interface ReversalQueryParams {
  readonly limit: string;
  readonly status?: string;
}

/**
 * Builds the queue querystring. An empty status is omitted rather than sent as
 * `status=`, which the server would treat as an unknown enum value.
 */
export function reversalQueryParams(filters: ReversalFilters): ReversalQueryParams {
  const status = filters.status?.trim() ?? "";
  return {
    limit: String(filters.limit ?? REVERSAL_PAGE_SIZE),
    ...(status === "" ? {} : { status }),
  };
}

/**
 * The approve body: `{ note? }`.
 *
 * A note is optional on this contract, so a blank one is omitted entirely
 * instead of being sent as `""` (which the server would record as a note).
 */
export function approveBody(note: string): { readonly note?: string } {
  const trimmed = note.trim();
  return trimmed === "" ? {} : { note: trimmed };
}

/**
 * The reject body: `{ reason }`, trimmed.
 *
 * A rejection without a reason is refused before it leaves the browser, so the
 * caller gets `undefined` rather than a body the server would 400 on.
 */
export function rejectBody(reason: string): { readonly reason: string } | undefined {
  const trimmed = reason.trim();
  return trimmed === "" ? undefined : { reason: trimmed };
}

/**
 * Whether the signed-in user may approve or reject this request.
 *
 * Only a pending request can be decided, and never by the user who requested
 * it: dual approval is the point. A missing session user cannot approve.
 */
export function canApprove(
  reversal: Pick<ReversalView, "status" | "requestedByUserId">,
  userId: string | undefined,
): boolean {
  if (reversal.status !== "pending") return false;
  if (userId === undefined || userId === "") return false;
  return userId !== reversal.requestedByUserId;
}

/**
 * One sentence naming the request and who has touched it, so a row can be read
 * without cross-referencing user ids by hand. Timestamps are formatted by the
 * page (they need the tenant locale); this only names the actors.
 */
export function describeReversal(reversal: ReversalView): string {
  const subject = `Reversal of transaction ${reversal.originalTransactionId}`;
  switch (reversal.status) {
    case "pending":
      return `${subject}, requested by ${reversal.requestedByUserId}.`;
    case "approved": {
      const approver = reversal.approvedByUserId ?? "another finance user";
      const posted =
        reversal.reversingTransactionId === null
          ? ""
          : ` Reversing transaction ${reversal.reversingTransactionId} was posted.`;
      return `${subject}, requested by ${reversal.requestedByUserId} and approved by ${approver}.${posted}`;
    }
    case "rejected": {
      const rejecter = reversal.rejectedByUserId ?? "another finance user";
      return `${subject}, requested by ${reversal.requestedByUserId} and rejected by ${rejecter}.`;
    }
  }
}
