import { describe, expect, it } from "vitest";
import {
  DISPUTE_PAGE_SIZE,
  disputeDetailRows,
  disputeQueryParams,
  disputeStatusLabel,
  disputeStatusTone,
  toDisputeView,
  type DisputeFormatters,
  type DisputeView,
} from "./disputesView.js";

/**
 * The pure rules behind the disputes inbox. Two matter for correctness: the
 * query builder must never send an empty status the server would read as an
 * unknown enum value, and the normaliser must survive the dynamic row the route
 * returns (a missing field is absent, not a crash).
 */

const raw = {
  id: "d-1",
  assetId: "as_1",
  openedByUserId: "officer-1",
  zoneId: "zone-1",
  status: "under_review",
  reason: "wrong_vehicle",
  description: "The sticker belongs to another bike.",
  occurredAt: "2026-10-28T09:15:00.000Z",
  businessDate: "2026-10-28",
  recordedAt: "2026-10-28T09:16:00.000Z",
  latitude: "6.524400",
  longitude: 3.3792,
  resolutionNote: null,
  resolvedByUserId: null,
  resolvedAt: null,
  linkedPaymentId: null,
} as const;

const format: DisputeFormatters = {
  timestamp: (iso) => `ts:${iso}`,
  businessDate: (date) => `day:${date}`,
};

describe("dispute status", () => {
  it("labels every lifecycle state", () => {
    expect(disputeStatusLabel("open")).toBe("Open");
    expect(disputeStatusLabel("under_review")).toBe("Under review");
    expect(disputeStatusLabel("resolved")).toBe("Resolved");
    expect(disputeStatusLabel("rejected")).toBe("Rejected");
  });

  it("falls back to readable words for a status added later", () => {
    expect(disputeStatusLabel("awaiting_evidence")).toBe("Awaiting evidence");
    expect(disputeStatusLabel("")).toBe("—");
  });

  it("tones open work amber, a review in flight as the accent, a resolution positive", () => {
    expect(disputeStatusTone("open")).toBe("warning");
    expect(disputeStatusTone("under_review")).toBe("brand");
    expect(disputeStatusTone("resolved")).toBe("positive");
    expect(disputeStatusTone("rejected")).toBe("neutral");
    expect(disputeStatusTone("awaiting_evidence")).toBe("neutral");
  });
});

describe("query builder", () => {
  it("omits an empty status instead of sending an unknown enum value", () => {
    const params = disputeQueryParams({ status: "" });
    expect(params).toEqual({ limit: String(DISPUTE_PAGE_SIZE) });
    expect("status" in params).toBe(false);
  });

  it("keeps a real status and a cursor, trimmed", () => {
    expect(disputeQueryParams({ status: " open ", cursor: " abc ", limit: 10 })).toEqual({
      limit: "10",
      status: "open",
      cursor: "abc",
    });
  });
});

describe("toDisputeView", () => {
  it("narrows a dynamic row without losing the fields the page renders", () => {
    const dispute = toDisputeView(raw);
    expect(dispute).toMatchObject({
      id: "d-1",
      assetId: "as_1",
      zoneId: "zone-1",
      status: "under_review",
      reason: "wrong_vehicle",
      description: "The sticker belongs to another bike.",
      businessDate: "2026-10-28",
      occurredAt: "2026-10-28T09:15:00.000Z",
      createdAt: "2026-10-28T09:16:00.000Z",
      openedByUserId: "officer-1",
      latitude: "6.524400",
      longitude: "3.3792",
      linkedPaymentId: null,
      resolutionNote: null,
      evidence: [],
    });
  });

  it("treats absent fields as absent instead of throwing", () => {
    const dispute = toDisputeView({ id: "d-2" });
    expect(dispute.assetId).toBe("");
    expect(dispute.zoneId).toBeNull();
    expect(dispute.evidence).toEqual([]);
  });

  it("reads evidence references when the payload carries them", () => {
    const dispute = toDisputeView({
      ...raw,
      evidence: [
        {
          objectKey: "evidence/d-1.jpg",
          contentType: "image/jpeg",
          createdAt: "2026-10-28T09:17:00.000Z",
        },
        { objectKey: "" },
        "not-an-object",
      ],
    });
    expect(dispute.evidence).toEqual([
      {
        objectKey: "evidence/d-1.jpg",
        contentType: "image/jpeg",
        createdAt: "2026-10-28T09:17:00.000Z",
      },
    ]);
  });
});

describe("disputeDetailRows", () => {
  const dispute: DisputeView = toDisputeView(raw);

  it("renders the description, the business day and the instants", () => {
    const rows = disputeDetailRows(dispute, format);
    expect(rows).toEqual(
      expect.arrayContaining([
        { label: "Description", value: "The sticker belongs to another bike." },
        { label: "Business date", value: "day:2026-10-28" },
        { label: "Occurred at", value: "ts:2026-10-28T09:15:00.000Z" },
        { label: "Recorded at", value: "ts:2026-10-28T09:16:00.000Z" },
        { label: "Location", value: "6.524400, 3.3792" },
      ]),
    );
  });

  it("omits resolution lines until the row has a resolution", () => {
    const labels = disputeDetailRows(dispute, format).map((row) => row.label);
    expect(labels).not.toContain("Resolution note");
    expect(labels).not.toContain("Resolved by");

    const resolved = toDisputeView({
      ...raw,
      status: "resolved",
      resolutionNote: "Payment confirmed by the gateway",
      resolvedByUserId: "finance-1",
      resolvedAt: "2026-10-29T10:00:00.000Z",
    });
    expect(disputeDetailRows(resolved, format)).toEqual(
      expect.arrayContaining([
        { label: "Resolved by", value: "finance-1" },
        { label: "Resolved at", value: "ts:2026-10-29T10:00:00.000Z" },
        { label: "Resolution note", value: "Payment confirmed by the gateway" },
      ]),
    );
  });
});
