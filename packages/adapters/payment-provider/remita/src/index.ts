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
import { verifyRemitaSignature } from "./signature.js";

export {
  remitaWebhookSignature,
  REMITA_WEBHOOK_SECRET,
  verifyRemitaSignature,
} from "./signature.js";
export { remitaPaymentProviderFixture } from "./fixture.js";

interface RemitaWebhookPayload {
  readonly eventType?: unknown;
  readonly RRR?: unknown;
  readonly amount?: unknown;
  readonly currency?: unknown;
  readonly paymentDate?: unknown;
  readonly transactionId?: unknown;
}

export function createRemitaPaymentProvider(): PaymentProvider {
  let counter = 0;

  const capabilities: PaymentProviderCapabilities = {
    supportsVirtualAccounts: false,
    supportsPaymentReferences: true,
    supportsSettlementFetch: true,
    attributionKinds: ["intent_reference"],
  };

  return {
    name: "remita",
    capabilities: () => capabilities,
    createPaymentIntent(request: PaymentIntentRequest): Promise<PaymentIntent> {
      try {
        assertPaymentIntentRequest(request);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      counter += 1;
      const intent: PaymentIntent = {
        providerId: `remita-intent-${String(counter)}`,
        status: "pending",
        attribution: {
          kind: "intent_reference",
          instruction: { type: "reference", value: request.reference },
        },
        raw: { request },
      };
      return Promise.resolve(intent);
    },
    verifyWebhook(request): Promise<WebhookVerification> {
      const signature = request.headers["x-remita-signature"];
      return Promise.resolve({ ok: verifyRemitaSignature(request.rawBody, signature) });
    },
    normalizeWebhook(rawBody): NormalizedPaymentEvent {
      let parsed: RemitaWebhookPayload;
      try {
        parsed = JSON.parse(rawBody) as RemitaWebhookPayload;
      } catch (error) {
        throw new PortError("PaymentProvider", "invalid_request", "Webhook body is not JSON", {
          cause: error,
        });
      }
      if (
        parsed.eventType !== "PAYMENT_COMPLETED" ||
        typeof parsed.RRR !== "string" ||
        typeof parsed.transactionId !== "string" ||
        typeof parsed.amount !== "string" ||
        typeof parsed.currency !== "string" ||
        typeof parsed.paymentDate !== "string"
      ) {
        throw new PortError("PaymentProvider", "invalid_request", "Webhook payload is malformed");
      }
      const paidAt = new Date(parsed.paymentDate);
      if (Number.isNaN(paidAt.getTime())) {
        throw new PortError(
          "PaymentProvider",
          "invalid_request",
          "Webhook paid-at timestamp is not a date",
        );
      }
      const amountNumber = Number(parsed.amount);
      if (!Number.isFinite(amountNumber) || !Number.isInteger(amountNumber)) {
        throw new PortError(
          "PaymentProvider",
          "invalid_request",
          "Webhook amount is not a valid Money value",
        );
      }
      let value: Money;
      try {
        value = money(parsed.currency, amountNumber);
      } catch (error) {
        throw new PortError(
          "PaymentProvider",
          "invalid_request",
          "Webhook amount is not a valid Money value",
          { cause: error },
        );
      }
      return {
        providerEventId: `remita-${parsed.transactionId}`,
        providerReference: parsed.RRR,
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
