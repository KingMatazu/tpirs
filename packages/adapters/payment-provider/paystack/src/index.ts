import { money } from "@tpirs/domain";
import type { Money } from "@tpirs/domain";
import { assertPaymentIntentRequest, PortError } from "@tpirs/ports";
import type {
  NormalizedPaymentEvent,
  PaymentIntent,
  PaymentIntentRequest,
  PaymentProvider,
  PaymentProviderCapabilities,
  WebhookVerification,
} from "@tpirs/ports";
import { verifyPaystackSignature } from "./signature.js";

export {
  paystackWebhookSignature,
  PAYSTACK_WEBHOOK_SECRET,
  verifyPaystackSignature,
} from "./signature.js";
export { paystackPaymentProviderFixture } from "./fixture.js";

interface PaystackWebhookPayload {
  readonly event?: unknown;
  readonly data?: {
    readonly id?: unknown;
    readonly reference?: unknown;
    readonly amount?: unknown;
    readonly currency?: unknown;
    readonly status?: unknown;
    readonly paid_at?: unknown;
  };
}

export function createPaystackPaymentProvider(): PaymentProvider {
  let counter = 0;

  const capabilities: PaymentProviderCapabilities = {
    supportsVirtualAccounts: false,
    supportsPaymentReferences: true,
    supportsSettlementFetch: true,
    // Paystack in Nigeria is commonly used with a generated payment reference per
    // transaction/intent; we declare intent_reference only (no narration fallback).
    attributionKinds: ["intent_reference"],
  };

  return {
    name: "paystack",
    capabilities: () => capabilities,
    createPaymentIntent(request: PaymentIntentRequest): Promise<PaymentIntent> {
      try {
        assertPaymentIntentRequest(request);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      counter += 1;
      const intent: PaymentIntent = {
        providerId: `paystack-intent-${String(counter)}`,
        status: "pending",
        authorizationUrl: `https://checkout.paystack.com/${request.reference}`,
        attribution: {
          kind: "intent_reference",
          instruction: { type: "reference", value: request.reference },
        },
        raw: { request },
      };
      return Promise.resolve(intent);
    },
    verifyWebhook(request): Promise<WebhookVerification> {
      const signature = request.headers["x-paystack-signature"];
      return Promise.resolve({ ok: verifyPaystackSignature(request.rawBody, signature) });
    },
    normalizeWebhook(rawBody): NormalizedPaymentEvent {
      let parsed: PaystackWebhookPayload;
      try {
        parsed = JSON.parse(rawBody) as PaystackWebhookPayload;
      } catch (error) {
        throw new PortError("PaymentProvider", "invalid_request", "Webhook body is not JSON", {
          cause: error,
        });
      }
      const data = parsed.data;
      if (
        parsed.event !== "charge.success" ||
        typeof data?.id !== "number" ||
        typeof data.reference !== "string" ||
        typeof data.amount !== "number" ||
        typeof data.currency !== "string" ||
        data.status !== "success" ||
        typeof data.paid_at !== "string"
      ) {
        throw new PortError("PaymentProvider", "invalid_request", "Webhook payload is malformed");
      }
      // Paystack amounts are in the smallest currency unit (kobo for NGN).
      const paidAt = new Date(data.paid_at);
      if (Number.isNaN(paidAt.getTime())) {
        throw new PortError(
          "PaymentProvider",
          "invalid_request",
          "Webhook paid-at timestamp is not a date",
        );
      }
      let value: Money;
      try {
        value = money(data.currency, data.amount / 100);
      } catch (error) {
        throw new PortError(
          "PaymentProvider",
          "invalid_request",
          "Webhook amount is not a valid Money value",
          { cause: error },
        );
      }
      return {
        providerEventId: `paystack-${String(data.id)}`,
        providerReference: data.reference,
        amount: value,
        status: "success",
        paidAt,
        raw: parsed,
      };
    },
    fetchSettlements() {
      return Promise.resolve([]);
    },
  };
}
