import type { PaymentProviderFixture } from "@tpirs/contracts";
import { money } from "@tpirs/domain";
import { mockWebhookSignature } from "./signature.js";

const validBody = JSON.stringify({
  providerEventId: "mock-evt-0001",
  providerReference: "mock-ref-0001",
  amount: { amount: 5000, currency: "NGN" },
  status: "success",
  paidAt: "2026-10-20T09:00:00.000Z",
});

/**
 * A recorded delivery for the mock adapter. It exists so the fixture suite has a
 * known-good case before a real gateway is added, and so later phases have a
 * second adapter to run the intake test against (ADR 0018).
 */
export const mockPaymentProviderFixture: PaymentProviderFixture = {
  adapter: "mock",
  description: "a successful transfer attributed by intent reference",
  valid: {
    headers: { "x-signature": mockWebhookSignature(validBody) },
    rawBody: validBody,
  },
  expected: {
    providerEventId: "mock-evt-0001",
    providerReference: "mock-ref-0001",
    amount: money("NGN", 5000),
    status: "success",
    paidAt: new Date("2026-10-20T09:00:00.000Z"),
  },
  forged: {
    headers: { "x-signature": mockWebhookSignature(validBody, "not-the-secret") },
    rawBody: validBody,
  },
};
