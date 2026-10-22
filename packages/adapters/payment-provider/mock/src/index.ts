import { money } from "@tpirs/domain";
import type { Money } from "@tpirs/domain";
import { assertPaymentIntentRequest, PortError } from "@tpirs/ports";
import type {
  NormalizedPaymentEvent,
  PaymentIntent,
  PaymentIntentRequest,
  PaymentProvider,
  PaymentProviderCapabilities,
  Settlement,
  WebhookVerification,
} from "@tpirs/ports";
import { mockWebhookSignature } from "./signature.js";

export { mockWebhookSignature, MOCK_WEBHOOK_SECRET } from "./signature.js";
export { mockPaymentProviderFixture } from "./fixture.js";

export interface MockPaymentProvider extends PaymentProvider {
  /** Intents created through the API (test inspection). */
  readonly intents: PaymentIntent[];
  /** Register a settlement returned by fetchSettlements. */
  addSettlement(settlement: Settlement): void;
}

interface RawWebhookPayload {
  readonly providerEventId?: unknown;
  readonly providerReference?: unknown;
  readonly amount?: { readonly amount?: unknown; readonly currency?: unknown };
  readonly status?: unknown;
  readonly paidAt?: unknown;
}

export function createMockPaymentProvider(): MockPaymentProvider {
  const intents: PaymentIntent[] = [];
  const settlements: Settlement[] = [];
  let counter = 0;

  const capabilities: PaymentProviderCapabilities = {
    supportsVirtualAccounts: true,
    supportsPaymentReferences: true,
    supportsSettlementFetch: true,
    // The mock implements every mechanism so tests can exercise each intake
    // path; intent references come first because that is the platform default.
    attributionKinds: ["intent_reference", "virtual_account", "narration"],
  };

  return {
    name: "mock",
    intents,
    capabilities: () => capabilities,
    createPaymentIntent(request: PaymentIntentRequest): Promise<PaymentIntent> {
      try {
        assertPaymentIntentRequest(request);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      counter += 1;
      const intent: PaymentIntent = {
        providerId: `mock-intent-${String(counter)}`,
        status: "pending",
        attribution: {
          kind: "intent_reference",
          instruction: { type: "reference", value: request.reference },
        },
        raw: { request },
      };
      intents.push(intent);
      return Promise.resolve(intent);
    },
    verifyWebhook(request): Promise<WebhookVerification> {
      const header = request.headers["x-signature"];
      const provided = Array.isArray(header) ? header[0] : header;
      return Promise.resolve({ ok: provided === mockWebhookSignature(request.rawBody) });
    },
    normalizeWebhook(rawBody): NormalizedPaymentEvent {
      let parsed: RawWebhookPayload;
      try {
        parsed = JSON.parse(rawBody) as RawWebhookPayload;
      } catch (error) {
        throw new PortError("PaymentProvider", "invalid_request", "Webhook body is not JSON", {
          cause: error,
        });
      }
      const amount = parsed.amount;
      if (
        typeof parsed.providerEventId !== "string" ||
        typeof parsed.providerReference !== "string" ||
        typeof amount?.amount !== "number" ||
        typeof amount.currency !== "string" ||
        (parsed.status !== "success" && parsed.status !== "failed") ||
        typeof parsed.paidAt !== "string"
      ) {
        throw new PortError("PaymentProvider", "invalid_request", "Webhook payload is malformed");
      }
      const paidAt = new Date(parsed.paidAt);
      if (Number.isNaN(paidAt.getTime())) {
        throw new PortError(
          "PaymentProvider",
          "invalid_request",
          "Webhook paid-at timestamp is not a date",
        );
      }
      let value: Money;
      try {
        value = money(amount.currency, amount.amount);
      } catch (error) {
        throw new PortError(
          "PaymentProvider",
          "invalid_request",
          "Webhook amount is not a valid Money value",
          { cause: error },
        );
      }
      return {
        providerEventId: parsed.providerEventId,
        providerReference: parsed.providerReference,
        amount: value,
        status: parsed.status,
        paidAt,
        raw: parsed,
      };
    },
    fetchSettlements(range) {
      return Promise.resolve(
        settlements.filter((s) => s.settledAt >= range.from && s.settledAt <= range.to),
      );
    },
    addSettlement(settlement) {
      settlements.push(settlement);
    },
  };
}
