import type { PaymentProviderFixture } from "@tpirs/contracts";
import { money } from "@tpirs/domain";
import { paystackWebhookSignature } from "./signature.js";

const validBody = JSON.stringify({
  event: "charge.success",
  data: {
    id: 123456789,
    reference: "PSK-REF-0001",
    amount: 500000,
    currency: "NGN",
    status: "success",
    paid_at: "2026-10-20T09:00:00.000Z",
    customer: {
      email: "driver@example.com",
    },
  },
});

export const paystackPaymentProviderFixture: PaymentProviderFixture = {
  adapter: "paystack",
  description: "Paystack charge.success attributed by intent reference",
  valid: {
    headers: { "x-paystack-signature": paystackWebhookSignature(validBody) },
    rawBody: validBody,
  },
  expected: {
    providerEventId: "paystack-123456789",
    providerReference: "PSK-REF-0001",
    amount: money("NGN", 5000),
    status: "success",
    paidAt: new Date("2026-10-20T09:00:00.000Z"),
  },
  forged: {
    headers: { "x-paystack-signature": paystackWebhookSignature(validBody, "not-the-secret") },
    rawBody: validBody,
  },
};
