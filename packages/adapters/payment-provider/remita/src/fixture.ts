import type { PaymentProviderFixture } from "@tpirs/contracts";
import { money } from "@tpirs/domain";
import { remitaWebhookSignature } from "./signature.js";

const validBody = JSON.stringify({
  eventType: "PAYMENT_COMPLETED",
  RRR: "RRR-REM-0001",
  amount: "5000.00",
  currency: "NGN",
  paymentDate: "2026-10-20T09:00:00.000Z",
  transactionId: "REM-TRX-0001",
});

export const remitaPaymentProviderFixture: PaymentProviderFixture = {
  adapter: "remita",
  description: "Remita PAYMENT_COMPLETED attributed by intent reference",
  valid: {
    headers: { "x-remita-signature": remitaWebhookSignature(validBody) },
    rawBody: validBody,
  },
  expected: {
    providerEventId: "remita-REM-TRX-0001",
    providerReference: "RRR-REM-0001",
    amount: money("NGN", 5000),
    status: "success",
    paidAt: new Date("2026-10-20T09:00:00.000Z"),
  },
  forged: {
    headers: { "x-remita-signature": remitaWebhookSignature(validBody, "not-the-secret") },
    rawBody: validBody,
  },
};
