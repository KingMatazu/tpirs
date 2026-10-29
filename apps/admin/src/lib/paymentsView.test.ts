import { describe, expect, it } from "vitest";
import { formatMoneyMinor } from "@tpirs/ui-tokens";
import {
  PAYMENT_STATUS_OPTIONS,
  describePayment,
  formatPaymentAmount,
  formatPaymentBusinessDay,
  formatPaymentDate,
  outboxKindLabel,
  outboxStatusLabel,
  outboxStatusTone,
  outboxSummary,
  paymentQueryParams,
  paymentReference,
  resolveBody,
  statusLabel,
  statusTone,
  suspenseQueryParams,
  type OutboxMessageView,
  type PaymentView,
} from "./paymentsView.js";

/**
 * The pure rules behind the payments screen. The query-string builder and the
 * resolve body are pinned here because a wrong shape reaches the API: an empty
 * filter must be omitted, and a blank asset id must never be sent as a resolve
 * request. Wording is pinned too — under pay-per-use the screen says "no
 * payment recorded", not "unpaid".
 */

const payment: PaymentView = {
  id: "pay-1",
  status: "credited",
  amountMinor: "20000",
  currency: "NGN",
  provider: "mock",
  providerReference: "MOCK-PAY-1",
  assetId: "as_1",
  attributionKind: "asset",
  businessDate: "2026-10-28",
  receiptNumber: "RCPT-1",
  failureReason: null,
  createdAt: "2026-10-28T09:00:00.000Z",
};

const sentMessage: OutboxMessageView = {
  id: "m1",
  kind: "receipt",
  recipient: "+2348000000000",
  body: "Receipt RCPT-1",
  status: "sent",
  createdAt: "2026-10-28T09:01:00.000Z",
};

describe("status labels and tones", () => {
  it("names every payment state", () => {
    expect(statusLabel("applied")).toBe("Applied");
    expect(statusLabel("credited")).toBe("Credited");
    expect(statusLabel("suspense")).toBe("In suspense");
    expect(statusLabel("rejected")).toBe("Rejected");
  });

  it("gives suspense a warning tone and rejection a danger tone", () => {
    expect(statusTone("applied")).toBe("positive");
    expect(statusTone("credited")).toBe("brand");
    expect(statusTone("suspense")).toBe("warning");
    expect(statusTone("rejected")).toBe("danger");
  });

  it("offers all four states plus the all-statuses entry in the filter", () => {
    expect(PAYMENT_STATUS_OPTIONS.map((option) => option.value)).toEqual([
      "",
      "applied",
      "credited",
      "suspense",
      "rejected",
    ]);
  });
});

describe("paymentQueryParams", () => {
  it("omits an empty status and only sends a real limit", () => {
    expect(paymentQueryParams()).toEqual({});
    expect(paymentQueryParams({ status: "", limit: 50 })).toEqual({ limit: "50" });
    expect(paymentQueryParams({ status: "  ", limit: 50 })).toEqual({ limit: "50" });
  });

  it("trims the status and stringifies the limit", () => {
    expect(paymentQueryParams({ status: " suspense ", limit: 50 })).toEqual({
      status: "suspense",
      limit: "50",
    });
  });
});

describe("suspenseQueryParams", () => {
  it("sends nothing unless a limit is set", () => {
    expect(suspenseQueryParams()).toEqual({});
    expect(suspenseQueryParams({ limit: 50 })).toEqual({ limit: "50" });
  });
});

describe("resolveBody", () => {
  it("trims the asset id the operator typed", () => {
    expect(resolveBody("  as_9 ")).toEqual({ assetId: "as_9" });
  });

  it("treats an empty or whitespace-only id as invalid", () => {
    expect(resolveBody("")).toBeUndefined();
    expect(resolveBody("   ")).toBeUndefined();
  });
});

describe("paymentReference", () => {
  it("uses the provider reference and falls back to the payment id", () => {
    expect(paymentReference(payment)).toBe("MOCK-PAY-1");
    expect(paymentReference({ ...payment, providerReference: null })).toBe("pay-1");
    expect(paymentReference({ ...payment, providerReference: "  " })).toBe("pay-1");
  });
});

describe("formatting", () => {
  it("formats the payment amount with its own currency", () => {
    expect(formatPaymentAmount(payment, "USD", "en-NG")).toBe(
      formatMoneyMinor("20000", "NGN", "en-NG"),
    );
  });

  it("falls back to the tenant currency when the payment omitted one", () => {
    expect(formatPaymentAmount({ ...payment, currency: "" }, "NGN", "en-NG")).toBe(
      formatMoneyMinor("20000", "NGN", "en-NG"),
    );
  });

  it("describes a payment with amount, provider and reference", () => {
    const described = describePayment(payment, "NGN", "en-NG");
    expect(described).toContain(formatMoneyMinor("20000", "NGN", "en-NG"));
    expect(described).toContain("mock");
    expect(described).toContain("MOCK-PAY-1");
  });

  it("renders a business day in the tenant's pattern", () => {
    expect(formatPaymentBusinessDay("2026-10-28", "en-NG", "dd/MM/yyyy")).toBe("28/10/2026");
  });

  it("renders an instant with the tenant's locale and timezone", () => {
    const rendered = formatPaymentDate(payment.createdAt, "en-NG", "Africa/Lagos");
    expect(rendered).toContain("2026");
    expect(rendered).not.toBe(payment.createdAt);
  });
});

describe("outbox", () => {
  it("summarises an empty outbox without accusing anyone", () => {
    expect(outboxSummary([])).toBe("No receipt messages recorded for this payment.");
  });

  it("counts sent, pending and failed messages", () => {
    const messages: OutboxMessageView[] = [
      sentMessage,
      { ...sentMessage, id: "m2", status: "pending" },
      { ...sentMessage, id: "m3", status: "failed" },
    ];
    expect(outboxSummary(messages)).toBe("3 messages: 1 sent, 1 pending, 1 failed.");
    expect(outboxSummary([sentMessage])).toBe("1 message: 1 sent.");
  });

  it("counts a state it does not recognise instead of dropping it", () => {
    expect(outboxSummary([{ ...sentMessage, status: "queued_by_relay" }])).toBe(
      "1 message: 1 queued.",
    );
  });

  it("labels message kinds and delivery states", () => {
    expect(outboxKindLabel("receipt")).toBe("Receipt");
    expect(outboxKindLabel("underpayment_notice")).toBe("Underpayment notice");
    expect(outboxKindLabel("cash_receipt")).toBe("Cash receipt");
    expect(outboxKindLabel("custom_kind")).toBe("Custom kind");
    expect(outboxStatusLabel("sent")).toBe("Sent");
    expect(outboxStatusLabel("pending")).toBe("Pending");
    expect(outboxStatusLabel("failed")).toBe("Failed");
    expect(outboxStatusTone("sent")).toBe("positive");
    expect(outboxStatusTone("pending")).toBe("warning");
    expect(outboxStatusTone("failed")).toBe("danger");
    expect(outboxStatusTone("other")).toBe("neutral");
  });
});
