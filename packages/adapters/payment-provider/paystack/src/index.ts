import { money } from "@tpirs/domain";
import type { Money } from "@tpirs/domain";
import { assertPaymentIntentRequest, PortError } from "@tpirs/ports";
import type {
  DepositAttribution,
  DepositAttributionRequest,
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

/** Everything the adapter needs to talk to a real integration. */
export interface PaystackOptions {
  /** `sk_test_…` or `sk_live_…`. Without it every API call fails loudly. */
  readonly secretKey?: string;
  /**
   * The secret Paystack signs webhooks with — the integration's secret key.
   * Absent means "cannot verify", so webhooks are refused rather than trusted.
   */
  readonly webhookSecret?: string;
  readonly baseUrl?: string;
  /** Injectable for tests; production uses the runtime's `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Payer email for hosted checkout intents. Paystack requires one; collector
   * top-ups never reach this path because a terminal needs no email.
   */
  readonly defaultEmail?: string;
  readonly timeoutMs?: number;
}

type PaystackMethod = "GET" | "POST" | "PUT";

interface PaystackEnvelope<T> {
  readonly status?: unknown;
  readonly message?: unknown;
  readonly data?: T;
}

interface PaystackWebhookPayload {
  readonly event?: unknown;
  readonly data?: {
    readonly id?: unknown;
    readonly reference?: unknown;
    readonly amount?: unknown;
    readonly currency?: unknown;
    readonly status?: unknown;
    readonly paid_at?: unknown;
    readonly metadata?: {
      readonly virtual_terminal?: { readonly code?: unknown };
    };
    readonly source?: {
      readonly source?: unknown;
      readonly identifier?: unknown;
    };
  };
}

interface InitializeData {
  readonly authorization_url?: unknown;
  readonly reference?: unknown;
  readonly access_code?: unknown;
}

interface VirtualTerminalData {
  readonly code?: unknown;
  readonly name?: unknown;
  readonly currency?: unknown;
  readonly paymentMethods?: readonly {
    readonly type?: unknown;
    readonly account_number?: unknown;
    readonly account_name?: unknown;
    readonly bank?: unknown;
  }[];
}

function errorCodeFor(
  status: number,
): "unauthorized" | "not_found" | "conflict" | "rate_limited" | "unavailable" | "invalid_request" {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "invalid_request";
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Paystack's real adapter (ADR 0069).
 *
 * It was a stub that returned a fake checkout URL and never touched the network;
 * collector funding is the first feature that has to work against the gateway, so
 * the HTTP client lands here. Tests inject `fetch`; production passes the secret
 * key resolved from the `SecretsProvider` at the composition root.
 *
 * Every failure becomes a `PortError` with a stable code, never a vendor shape.
 */
export function createPaystackPaymentProvider(options: PaystackOptions = {}): PaymentProvider {
  const transport = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? "https://api.paystack.co").replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function call<T>(
    path: string,
    init: { readonly method: PaystackMethod; readonly what: string; readonly body?: unknown },
  ): Promise<T> {
    if (options.secretKey === undefined || options.secretKey === "") {
      throw new PortError(
        "PaymentProvider",
        "unavailable",
        `Paystack ${init.what} requires a secret key (set SECRET_PAYMENTS_PAYSTACK_SECRET_KEY)`,
        { retryable: false, provider: "paystack" },
      );
    }
    let response: Response;
    try {
      response = await transport(`${baseUrl}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${options.secretKey}`,
          "content-type": "application/json",
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new PortError(
        "PaymentProvider",
        "unavailable",
        `Paystack ${init.what} could not be reached`,
        { cause: error, provider: "paystack" },
      );
    }

    let parsed: PaystackEnvelope<T>;
    try {
      parsed = (await response.json()) as PaystackEnvelope<T>;
    } catch (error) {
      throw new PortError(
        "PaymentProvider",
        "invalid_request",
        `Paystack ${init.what} answered with a body that is not JSON`,
        { cause: error, provider: "paystack" },
      );
    }
    if (!response.ok || parsed.status !== true) {
      const message =
        typeof parsed.message === "string" ? parsed.message : `HTTP ${String(response.status)}`;
      throw new PortError(
        "PaymentProvider",
        errorCodeFor(response.status),
        `Paystack ${init.what} failed: ${message}`,
        { provider: "paystack", retryable: response.status >= 500 || response.status === 429 },
      );
    }
    // Not every successful endpoint returns `data` (deactivate answers with a
    // message only); callers validate the fields they actually need.
    return parsed.data ?? ({} as T);
  }

  const capabilities: PaymentProviderCapabilities = {
    supportsVirtualAccounts: false,
    supportsPaymentReferences: true,
    supportsSettlementFetch: false,
    // Paystack in Nigeria is commonly used with a generated payment reference per
    // transaction/intent; we declare intent_reference only (no narration fallback).
    attributionKinds: ["intent_reference"],
  };

  return {
    name: "paystack",
    capabilities: () => capabilities,

    async createPaymentIntent(request: PaymentIntentRequest): Promise<PaymentIntent> {
      assertPaymentIntentRequest(request);
      if (options.defaultEmail === undefined || options.defaultEmail === "") {
        throw new PortError(
          "PaymentProvider",
          "unavailable",
          "Paystack checkout needs a payer email (set PAYSTACK_DEFAULT_EMAIL)",
          { retryable: false, provider: "paystack" },
        );
      }
      const data = await call<InitializeData>("/transaction/initialize", {
        method: "POST",
        what: "transaction initialize",
        body: {
          email: options.defaultEmail,
          amount: request.amount.amount,
          currency: request.amount.currency,
          reference: request.reference,
          ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        },
      });
      const authorizationUrl = nonEmpty(data.authorization_url);
      if (authorizationUrl === undefined) {
        throw new PortError(
          "PaymentProvider",
          "provider_error",
          "Paystack initialized a transaction without a checkout URL",
          { provider: "paystack" },
        );
      }
      return {
        providerId: nonEmpty(data.reference) ?? request.reference,
        status: "pending",
        authorizationUrl,
        attribution: {
          kind: "intent_reference",
          instruction: { type: "reference", value: request.reference },
        },
        raw: data,
      };
    },

    verifyWebhook(request): Promise<WebhookVerification> {
      // Refusing to guess: without the signing secret a delivery cannot be
      // trusted, and silently accepting it would make every deposit forgeable.
      if (options.webhookSecret === undefined || options.webhookSecret === "") {
        return Promise.resolve({ ok: false });
      }
      const signature = request.headers["x-paystack-signature"];
      return Promise.resolve({
        ok: verifyPaystackSignature(request.rawBody, signature, options.webhookSecret),
      });
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
      // A Virtual Terminal payment names the terminal in metadata; older
      // deliveries from other channels have no attribution key at all.
      const attributionKey =
        nonEmpty(data.metadata?.virtual_terminal?.code) ??
        (data.source?.source === "virtual_terminal" ? nonEmpty(data.source.identifier) : undefined);
      return {
        providerEventId: `paystack-${String(data.id)}`,
        providerReference: data.reference,
        ...(attributionKey === undefined ? {} : { attributionKey }),
        amount: value,
        status: "success",
        paidAt,
        raw: parsed,
      };
    },

    fetchSettlements() {
      // The pilot reconciles from the statement CSV through the separate
      // `SettlementImport` port; the provider feed is not wired.
      return Promise.resolve([]);
    },

    async createDepositAttribution(
      request: DepositAttributionRequest,
    ): Promise<DepositAttribution> {
      const name = nonEmpty(request.name) ?? `Collector ${request.collectorUserId.slice(0, 8)}`;
      const data = await call<VirtualTerminalData>("/virtual_terminal", {
        method: "POST",
        what: "virtual terminal create",
        body: {
          name,
          ...(request.phone === undefined
            ? {}
            : { destinations: [{ target: request.phone, name }] }),
          ...(request.currency === undefined ? {} : { currency: request.currency }),
          metadata: {
            ...(request.tenantId === undefined ? {} : { tenantId: request.tenantId }),
            collectorUserId: request.collectorUserId,
            ...request.metadata,
          },
        },
      });
      const code = nonEmpty(data.code);
      if (code === undefined) {
        throw new PortError(
          "PaymentProvider",
          "provider_error",
          "Paystack created a virtual terminal without a code",
          { provider: "paystack" },
        );
      }
      // Nigeria issues a dedicated NUBAN as one of the payment methods; other
      // markets do not, so the display fields stay absent and the app shows the
      // terminal page instead.
      const nuban = data.paymentMethods?.find(
        (method) =>
          method.type === "dedicated_nuban" && nonEmpty(method.account_number) !== undefined,
      );
      const accountNumber = nuban === undefined ? undefined : nonEmpty(nuban.account_number);
      const accountName = nuban === undefined ? undefined : nonEmpty(nuban.account_name);
      const bank = nuban === undefined ? undefined : nonEmpty(nuban.bank);
      const currency = nonEmpty(data.currency);
      return {
        kind: "virtual_terminal",
        value: code,
        ...(accountNumber === undefined ? {} : { accountNumber }),
        ...(accountName === undefined ? {} : { accountName }),
        ...(bank === undefined ? {} : { bank }),
        pageUrl: `https://paystack.shop/pay/${code.toLowerCase()}`,
        ...(currency === undefined ? {} : { currency }),
      };
    },

    async deactivateDepositAttribution(reference: string): Promise<void> {
      await call<{ readonly message?: unknown }>(
        `/virtual_terminal/${encodeURIComponent(reference)}/deactivate`,
        { method: "PUT", what: "virtual terminal deactivate" },
      );
    },
  };
}
