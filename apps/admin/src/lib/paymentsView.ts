import { formatBusinessDate, formatMoneyMinor, formatTimestamp } from "@tpirs/ui-tokens";

/**
 * Pure helpers behind the payments and suspense screen (Step 9).
 *
 * The page is an arrangement of queries and forms; the interesting rules live
 * here so they can be unit-tested without rendering: how a payment status
 * reads, which tone it carries, which query string an empty filter must *not*
 * send, and what a resolution request body looks like once trimmed. Nothing
 * here touches React, the client, or the DOM.
 *
 * The wire shapes mirror the generated contract (`Payment`, `OutboxMessage`).
 * Money is a minor-unit string and business days are `YYYY-MM-DD`, exactly as
 * the API sends them. Under `pay_per_use` the wording matters: a day with no
 * payment is "no payment recorded", and the screen never infers a liability
 * from an absence.
 */

export type PaymentStatus = "applied" | "credited" | "suspense" | "rejected";

/**
 * The badge tones the dashboard understands. Kept in step with
 * `components/ui.tsx`; the page never builds a colour class itself.
 */
export type Tone = "neutral" | "brand" | "positive" | "warning" | "danger";

/** One payment as `GET /v1/payments` and `/v1/payments/suspense` return it. */
export interface PaymentView {
  readonly id: string;
  readonly status: PaymentStatus;
  readonly amountMinor: string;
  readonly currency: string;
  readonly provider: string;
  readonly providerReference: string | null;
  readonly assetId: string | null;
  readonly attributionKind: string | null;
  readonly businessDate: string | null;
  readonly receiptNumber: string | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
}

/** One receipt message as `GET /v1/payments/{id}/outbox` returns it. */
export interface OutboxMessageView {
  readonly id: string;
  readonly kind: string;
  readonly recipient: string;
  readonly body: string;
  readonly status: string;
  readonly createdAt: string;
}

/** Status filter entries rendered by the payments list. `""` means "all". */
export const PAYMENT_STATUS_OPTIONS: readonly {
  readonly value: PaymentStatus | "";
  readonly label: string;
}[] = [
  { value: "", label: "All statuses" },
  { value: "applied", label: "Applied" },
  { value: "credited", label: "Credited" },
  { value: "suspense", label: "In suspense" },
  { value: "rejected", label: "Rejected" },
];

/** A payment state as finance reads it. */
export function statusLabel(status: PaymentStatus): string {
  switch (status) {
    case "applied":
      return "Applied";
    case "credited":
      return "Credited";
    case "suspense":
      return "In suspense";
    case "rejected":
      return "Rejected";
  }
}

/**
 * Badge tone for a payment: an applied payment recorded a business day, a
 * credited one landed in the wallet without settling a day, suspense needs a
 * human, and a rejection is red.
 */
export function statusTone(status: PaymentStatus): Tone {
  switch (status) {
    case "applied":
      return "positive";
    case "credited":
      return "brand";
    case "suspense":
      return "warning";
    case "rejected":
      return "danger";
  }
}

export interface PaymentQueryParams {
  readonly status?: string;
  readonly limit?: string;
}

export interface PaymentListFilters {
  readonly status?: string;
  readonly limit?: number;
}

/**
 * Builds the payment-list querystring. An empty status is omitted rather than
 * sent as `status=`, which the server would treat as an unknown enum value.
 */
export function paymentQueryParams(filters: PaymentListFilters = {}): PaymentQueryParams {
  const status = filters.status?.trim() ?? "";
  return {
    ...(status === "" ? {} : { status }),
    ...(filters.limit === undefined ? {} : { limit: String(filters.limit) }),
  };
}

export interface SuspenseQueryParams {
  readonly limit?: string;
}

export interface SuspenseListFilters {
  readonly limit?: number;
}

/** Same rule for the suspense queue: only a real limit is sent. */
export function suspenseQueryParams(filters: SuspenseListFilters = {}): SuspenseQueryParams {
  return filters.limit === undefined ? {} : { limit: String(filters.limit) };
}

/**
 * The resolve body: the asset id the operator typed, trimmed. An empty value is
 * invalid, so the caller gets `undefined` and shows a message instead of
 * sending a request the API would reject.
 */
export function resolveBody(assetId: string): { readonly assetId: string } | undefined {
  const trimmed = assetId.trim();
  return trimmed === "" ? undefined : { assetId: trimmed };
}

/**
 * The provider's reference, falling back to the payment id when the gateway
 * sent none. Opaque identifiers are shown verbatim so they can be searched.
 */
export function paymentReference(payment: Pick<PaymentView, "id" | "providerReference">): string {
  const reference = payment.providerReference?.trim() ?? "";
  return reference === "" ? payment.id : reference;
}

/**
 * Formats the payment amount with the tenant's currency and number format. The
 * payment's own currency wins when present; the tenant currency is the fallback
 * for an older row that omitted it.
 */
export function formatPaymentAmount(
  payment: Pick<PaymentView, "amountMinor" | "currency">,
  fallbackCurrency: string,
  numberFormat: string,
): string {
  return formatMoneyMinor(
    payment.amountMinor,
    payment.currency === "" ? fallbackCurrency : payment.currency,
    numberFormat,
  );
}

/** A one-line description of a payment: amount, provider and reference. */
export function describePayment(
  payment: PaymentView,
  fallbackCurrency: string,
  numberFormat: string,
): string {
  return `${formatPaymentAmount(payment, fallbackCurrency, numberFormat)} from ${
    payment.provider
  } (${paymentReference(payment)})`;
}

/** An instant (payment or message creation) in the tenant's locale/timezone. */
export function formatPaymentDate(iso: string, numberFormat: string, timezone: string): string {
  return formatTimestamp(iso, numberFormat, timezone);
}

/** A `YYYY-MM-DD` business day in the tenant's configured date format. */
export function formatPaymentBusinessDay(
  businessDate: string,
  numberFormat: string,
  pattern: string,
): string {
  return formatBusinessDate(`${businessDate}T00:00:00.000Z`, numberFormat, pattern);
}

/**
 * One sentence describing the receipt outbox. Finance asks "did the driver get
 * a message?", so the summary counts states rather than listing rows.
 */
export function outboxSummary(messages: readonly OutboxMessageView[]): string {
  if (messages.length === 0) return "No receipt messages recorded for this payment.";
  const sent = messages.filter((message) => message.status === "sent").length;
  const pending = messages.filter((message) => message.status === "pending").length;
  const failed = messages.filter((message) => message.status === "failed").length;
  const other = messages.length - sent - pending - failed;
  const parts: string[] = [];
  if (sent > 0) parts.push(`${String(sent)} sent`);
  if (pending > 0) parts.push(`${String(pending)} pending`);
  if (failed > 0) parts.push(`${String(failed)} failed`);
  if (other > 0) parts.push(`${String(other)} queued`);
  return `${String(messages.length)} message${messages.length === 1 ? "" : "s"}: ${parts.join(", ")}.`;
}

/**
 * Turns a snake_case enum value into a readable phrase. The fallback matters:
 * a message kind or state added by a later service must still render as words
 * rather than as a raw key or an empty cell.
 */
function humanizeKey(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  if (words === "") return "—";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The kind of receipt message, spelled out. */
export function outboxKindLabel(kind: string): string {
  switch (kind) {
    case "receipt":
      return "Receipt";
    case "underpayment_notice":
      return "Underpayment notice";
    case "cash_receipt":
      return "Cash receipt";
    default:
      return humanizeKey(kind);
  }
}

/** The delivery state of a receipt message, spelled out. */
export function outboxStatusLabel(status: string): string {
  switch (status) {
    case "sent":
      return "Sent";
    case "pending":
      return "Pending";
    case "failed":
      return "Failed";
    default:
      return humanizeKey(status);
  }
}

/** A sent message is positive, a pending one is amber, a failed one is red. */
export function outboxStatusTone(status: string): Tone {
  switch (status) {
    case "sent":
      return "positive";
    case "pending":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}
