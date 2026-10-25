/**
 * Dispute lifecycle. Phase 6 only opens disputes; the later states are defined
 * now so the database constraint and wire schema do not need a second change
 * when finance starts resolving them (Phase 8).
 */
export type DisputeStatus = "open" | "under_review" | "resolved" | "rejected";

export const DISPUTE_STATUSES: readonly DisputeStatus[] = [
  "open",
  "under_review",
  "resolved",
  "rejected",
];

export function isDisputeStatus(value: string): value is DisputeStatus {
  return (DISPUTE_STATUSES as readonly string[]).includes(value);
}

/** Upper bound on the free-text note so one request cannot store a novel. */
export const DISPUTE_DESCRIPTION_MAX_LENGTH = 1000;

/**
 * Evidence is optional and capped in v1: one downscaled photo, which the
 * client posts as base64 JSON (ADR 0030).
 */
export const DISPUTE_EVIDENCE_MAX_BYTES = 1_500_000;
