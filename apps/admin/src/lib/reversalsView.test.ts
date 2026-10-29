import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVERSAL_STATUS,
  REVERSAL_PAGE_SIZE,
  approveBody,
  canApprove,
  describeReversal,
  rejectBody,
  reversalQueryParams,
  reversalStatusLabel,
  reversalStatusTone,
  type ReversalView,
} from "./reversalsView.js";

/**
 * The pure rules behind the reversal queue. The dual-approval guard is the one
 * that carries money meaning: the server refuses a requester approving their own
 * request with `409 self_approval`, and the page must not send that POST at all.
 * The body builders are pinned to the exact contract shapes as well.
 */

const pending: ReversalView = {
  id: "rv-1",
  originalTransactionId: "tx-1",
  reason: "Driver paid twice",
  status: "pending",
  requestedByUserId: "requester-1",
  approvedByUserId: null,
  rejectedByUserId: null,
  approvedAt: null,
  rejectedAt: null,
  reversingTransactionId: null,
  createdAt: "2026-10-28T08:00:00.000Z",
};

describe("reversal status", () => {
  it("labels every state", () => {
    expect(reversalStatusLabel("pending")).toBe("Pending");
    expect(reversalStatusLabel("approved")).toBe("Approved");
    expect(reversalStatusLabel("rejected")).toBe("Rejected");
  });

  it("tones pending amber, approval positive and rejection neutral", () => {
    expect(reversalStatusTone("pending")).toBe("warning");
    expect(reversalStatusTone("approved")).toBe("positive");
    expect(reversalStatusTone("rejected")).toBe("neutral");
  });

  it("opens on pending work", () => {
    expect(DEFAULT_REVERSAL_STATUS).toBe("pending");
  });
});

describe("query builder", () => {
  it("sends the default limit and omits an empty status", () => {
    const params = reversalQueryParams({ status: "" });
    expect(params).toEqual({ limit: String(REVERSAL_PAGE_SIZE) });
    expect("status" in params).toBe(false);
  });

  it("keeps a real status, trimmed", () => {
    expect(reversalQueryParams({ status: " approved ", limit: 5 })).toEqual({
      limit: "5",
      status: "approved",
    });
  });
});

describe("mutation bodies", () => {
  it("sends the note field trimmed when there is a note", () => {
    expect(approveBody("  checked the statement  ")).toEqual({ note: "checked the statement" });
  });

  it("omits an optional approval note instead of sending an empty string", () => {
    expect(approveBody("   ")).toEqual({});
    expect(approveBody("")).toEqual({});
  });

  it("trims a rejection reason and refuses an empty one", () => {
    expect(rejectBody("  no evidence of a double payment ")).toEqual({
      reason: "no evidence of a double payment",
    });
    expect(rejectBody("")).toBeUndefined();
    expect(rejectBody("   ")).toBeUndefined();
  });
});

describe("canApprove", () => {
  it("lets a different finance user approve a pending request", () => {
    expect(canApprove(pending, "finance-1")).toBe(true);
  });

  it("never lets the requester approve their own request", () => {
    expect(canApprove(pending, "requester-1")).toBe(false);
  });

  it("refuses a decided request and a missing session user", () => {
    expect(canApprove({ ...pending, status: "approved" }, "finance-1")).toBe(false);
    expect(canApprove({ ...pending, status: "rejected" }, "finance-1")).toBe(false);
    expect(canApprove(pending, undefined)).toBe(false);
    expect(canApprove(pending, "")).toBe(false);
  });
});

describe("describeReversal", () => {
  it("names the request and its requester while pending", () => {
    expect(describeReversal(pending)).toBe(
      "Reversal of transaction tx-1, requested by requester-1.",
    );
  });

  it("names the approver and the reversing entry once approved", () => {
    expect(
      describeReversal({
        ...pending,
        status: "approved",
        approvedByUserId: "finance-1",
        approvedAt: "2026-10-29T09:00:00.000Z",
        reversingTransactionId: "tx-2",
      }),
    ).toBe(
      "Reversal of transaction tx-1, requested by requester-1 and approved by finance-1. Reversing transaction tx-2 was posted.",
    );
  });

  it("names the rejecter once rejected", () => {
    expect(
      describeReversal({
        ...pending,
        status: "rejected",
        rejectedByUserId: "finance-2",
        rejectedAt: "2026-10-29T09:00:00.000Z",
      }),
    ).toBe("Reversal of transaction tx-1, requested by requester-1 and rejected by finance-2.");
  });
});
