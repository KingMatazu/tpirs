import { createHash } from "node:crypto";
import { money } from "@tpirs/domain";
import { PortError } from "@tpirs/ports";
import type {
  NormalizedPaymentEvent,
  PaymentIntent,
  PaymentIntentRequest,
  PaymentProvider,
  PaymentProviderCapabilities,
  Settlement,
  WebhookVerification,
} from "@tpirs/ports";

export const MOCK_WEBHOOK_SECRET = "mock-webhook-secret";

export function mockWebhookSignature(rawBody: string, secret = MOCK_WEBHOOK_SECRET): string {
  return createHash("sha256").update(`${secret}:${rawBody}`).digest("hex");
}

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
  };

  return {
    name: "mock",
    intents,
    capabilities: () => capabilities,
    createPaymentIntent(request: PaymentIntentRequest): Promise<PaymentIntent> {
      if (request.amount.amount <= 0) {
        return Promise.reject(
          new PortError("PaymentProvider", "invalid_request", "Amount must be a positive integer"),
        );
      }
      if (request.reference.trim().length === 0) {
        return Promise.reject(
          new PortError("PaymentProvider", "invalid_request", "Reference must not be empty"),
        );
      }
      counter += 1;
      const intent: PaymentIntent = {
        providerId: `mock-intent-${String(counter)}`,
        status: "pending",
        instruction: { type: "reference", value: request.reference },
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
      return {
        providerEventId: parsed.providerEventId,
        providerReference: parsed.providerReference,
        amount: money(amount.currency, amount.amount),
        status: parsed.status,
        paidAt: new Date(parsed.paidAt),
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
