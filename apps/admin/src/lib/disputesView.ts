/**
 * Pure helpers behind the disputes inbox (Step 4).
 *
 * The dispute rows are dynamic objects on the wire (`GET /v1/disputes` returns
 * `additionalProperties: true`), because the field app ingests them and the
 * dashboard only reads what the table happened to record. `toDisputeView`
 * narrows that payload once, so the page never indexes `unknown` and a field
 * added later does not crash the screen; the rest of this module names the
 * statuses, builds the query string, and arranges the detail rows.
 *
 * Nothing here touches React, the client, or the DOM. The resolution note is
 * deliberately absent: no resolution endpoint exists yet, so the inbox says so
 * instead of offering a button that would 404.
 */

/** The badge tones the dashboard understands, in step with `components/ui.tsx`. */
export type Tone = "neutral" | "brand" | "positive" | "warning" | "danger";

/** How many rows the inbox asks for at a time. */
export const DISPUTE_PAGE_SIZE = 50;

/** One evidence reference attached to a dispute, when the payload carries it. */
export interface DisputeEvidenceView {
  readonly objectKey: string;
  readonly contentType: string;
  readonly createdAt: string;
}

/**
 * One dispute as the inbox renders it.
 *
 * `status` stays a plain string: the column is a database enum the server owns,
 * and a value added later must read as words rather than break the page.
 */
export interface DisputeView {
  readonly id: string;
  readonly assetId: string;
  readonly zoneId: string | null;
  readonly reason: string;
  readonly description: string;
  readonly status: string;
  /** `YYYY-MM-DD`, the tenant business day the dispute was recorded against. */
  readonly businessDate: string;
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly openedByUserId: string;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly linkedPaymentId: string | null;
  readonly resolutionNote: string | null;
  readonly resolvedByUserId: string | null;
  readonly resolvedAt: string | null;
  readonly evidence: readonly DisputeEvidenceView[];
}

/** One labelled line in the dispute detail view. */
export interface DisputeDetailRow {
  readonly label: string;
  readonly value: string;
}

/** The date formatting the page already resolved from the tenant config. */
export interface DisputeFormatters {
  readonly timestamp: (iso: string) => string;
  readonly businessDate: (date: string) => string;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** A text or numeric column as a string; anything else (null, object) is absent. */
function scalar(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (typeof value === "number") return `${value}`;
  return null;
}

function evidenceOf(value: unknown): readonly DisputeEvidenceView[] {
  if (!Array.isArray(value)) return [];
  const rows: DisputeEvidenceView[] = [];
  for (const item of value as readonly unknown[]) {
    const record = asRecord(item);
    if (record === undefined) continue;
    const objectKey = scalar(record["objectKey"]);
    if (objectKey === null) continue;
    rows.push({
      objectKey,
      contentType: scalar(record["contentType"]) ?? "",
      createdAt: scalar(record["createdAt"]) ?? "",
    });
  }
  return rows;
}

/**
 * Narrows one dynamic dispute row into the view the page renders.
 *
 * Missing required fields degrade to empty strings rather than throwing: a
 * half-serialised row is still worth showing to an operator, and the row's id
 * is what the detail request uses.
 */
export function toDisputeView(raw: Readonly<Record<string, unknown>>): DisputeView {
  return {
    id: scalar(raw["id"]) ?? "",
    assetId: scalar(raw["assetId"]) ?? "",
    zoneId: scalar(raw["zoneId"]),
    reason: scalar(raw["reason"]) ?? "",
    description: scalar(raw["description"]) ?? "",
    status: scalar(raw["status"]) ?? "",
    businessDate: scalar(raw["businessDate"]) ?? "",
    occurredAt: scalar(raw["occurredAt"]) ?? "",
    createdAt: scalar(raw["recordedAt"]) ?? scalar(raw["createdAt"]) ?? "",
    openedByUserId: scalar(raw["openedByUserId"]) ?? "",
    latitude: scalar(raw["latitude"]),
    longitude: scalar(raw["longitude"]),
    linkedPaymentId: scalar(raw["linkedPaymentId"]),
    resolutionNote: scalar(raw["resolutionNote"]),
    resolvedByUserId: scalar(raw["resolvedByUserId"]),
    resolvedAt: scalar(raw["resolvedAt"]),
    evidence: evidenceOf(raw["evidence"]),
  };
}

/** Filter choices rendered by the inbox. `""` means "all". */
export const DISPUTE_STATUS_OPTIONS: readonly {
  readonly value: string;
  readonly label: string;
}[] = [
  { value: "", label: "All statuses" },
  { value: "open", label: "Open" },
  { value: "under_review", label: "Under review" },
  { value: "resolved", label: "Resolved" },
  { value: "rejected", label: "Rejected" },
];

/** Turns an unknown enum value into readable words rather than a raw key. */
function humanize(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  if (words === "") return "—";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A dispute's lifecycle state, as the inbox reads it. */
export function disputeStatusLabel(status: string): string {
  switch (status) {
    case "open":
      return "Open";
    case "under_review":
      return "Under review";
    case "resolved":
      return "Resolved";
    case "rejected":
      return "Rejected";
    default:
      return humanize(status);
  }
}

/**
 * Badge tone for a dispute: open work is amber, a review in flight carries the
 * tenant accent, a resolution is positive, and a rejection is neutral (the
 * dispute was declined, not an error in the ledger).
 */
export function disputeStatusTone(status: string): Tone {
  switch (status) {
    case "open":
      return "warning";
    case "under_review":
      return "brand";
    case "resolved":
      return "positive";
    default:
      return "neutral";
  }
}

export interface DisputeFilters {
  readonly status?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface DisputeQueryParams {
  readonly limit: string;
  readonly status?: string;
  readonly cursor?: string;
}

/**
 * Builds the inbox querystring. An empty status is omitted rather than sent as
 * `status=`, which the server would treat as an unknown enum value.
 */
export function disputeQueryParams(filters: DisputeFilters): DisputeQueryParams {
  const status = filters.status?.trim() ?? "";
  const cursor = filters.cursor?.trim() ?? "";
  return {
    limit: String(filters.limit ?? DISPUTE_PAGE_SIZE),
    ...(status === "" ? {} : { status }),
    ...(cursor === "" ? {} : { cursor }),
  };
}

/**
 * The detail lines for one dispute.
 *
 * Only fields the row actually carries are emitted, so an older row without a
 * resolution note does not render an empty "Resolution note" line. Timestamps
 * and business days are formatted by the caller through the tenant locale.
 */
export function disputeDetailRows(
  dispute: DisputeView,
  format: DisputeFormatters,
): readonly DisputeDetailRow[] {
  const rows: DisputeDetailRow[] = [
    { label: "Asset", value: dispute.assetId },
    { label: "Zone", value: dispute.zoneId ?? "—" },
    { label: "Reason", value: dispute.reason },
    { label: "Description", value: dispute.description },
    { label: "Opened by", value: dispute.openedByUserId },
  ];
  if (dispute.businessDate !== "") {
    rows.push({ label: "Business date", value: format.businessDate(dispute.businessDate) });
  }
  if (dispute.occurredAt !== "") {
    rows.push({ label: "Occurred at", value: format.timestamp(dispute.occurredAt) });
  }
  if (dispute.createdAt !== "") {
    rows.push({ label: "Recorded at", value: format.timestamp(dispute.createdAt) });
  }
  if (dispute.latitude !== null && dispute.longitude !== null) {
    rows.push({ label: "Location", value: `${dispute.latitude}, ${dispute.longitude}` });
  }
  if (dispute.linkedPaymentId !== null) {
    rows.push({ label: "Linked payment", value: dispute.linkedPaymentId });
  }
  if (dispute.resolvedByUserId !== null) {
    rows.push({ label: "Resolved by", value: dispute.resolvedByUserId });
  }
  if (dispute.resolvedAt !== null) {
    rows.push({ label: "Resolved at", value: format.timestamp(dispute.resolvedAt) });
  }
  if (dispute.resolutionNote !== null) {
    rows.push({ label: "Resolution note", value: dispute.resolutionNote });
  }
  return rows;
}
