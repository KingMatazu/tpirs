import { PortError } from "./errors.js";
import type { PortErrorOptions } from "./errors.js";
import { isPaymentAttributionKind } from "./payment-provider.js";
import type {
  NormalizedPaymentEvent,
  PaymentIntent,
  PaymentIntentRequest,
  PaymentProviderCapabilities,
} from "./payment-provider.js";

/**
 * Runtime rules for the `PaymentProvider` port.
 *
 * A conformance suite proves an adapter is well behaved in CI, but production
 * calls the adapter directly. These assertions are the same rules, applied at
 * the boundary: a misconfigured or broken adapter must fail loudly with a
 * `PortError` instead of silently attributing money to the wrong asset.
 */

const PORT = "PaymentProvider";

/** The adapter is misconfigured or lying about what it returned. Not retryable. */
function brokenAdapter(message: string, providerName: string): never {
  const options: PortErrorOptions =
    providerName.trim().length > 0 ? { provider: providerName } : {};
  throw new PortError(PORT, "provider_error", message, options);
}

/** The caller handed the adapter something it cannot act on. */
function rejectedRequest(message: string, providerName?: string): never {
  const options: PortErrorOptions =
    providerName === undefined || providerName.trim().length === 0
      ? {}
      : { provider: providerName };
  throw new PortError(PORT, "invalid_request", message, options);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoCurrency(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function assertPaymentProviderCapabilities(
  capabilities: PaymentProviderCapabilities,
  providerName: string,
): void {
  if (!isNonEmptyString(providerName)) {
    brokenAdapter("Payment provider name must not be empty", providerName);
  }

  // Adapters may be JavaScript or hand-written config, so treat this as
  // untrusted input rather than relying on the type annotation.
  const rawKinds: unknown = capabilities.attributionKinds;
  if (!Array.isArray(rawKinds) || rawKinds.length === 0) {
    brokenAdapter(`Payment provider "${providerName}" declares no attribution kinds`, providerName);
  }

  const kinds: readonly unknown[] = rawKinds;
  const seen = new Set<string>();
  for (const kind of kinds) {
    if (!isNonEmptyString(kind) || !isPaymentAttributionKind(kind)) {
      brokenAdapter(
        `Payment provider "${providerName}" declares unknown attribution kind "${String(kind)}"`,
        providerName,
      );
    }
    if (seen.has(kind)) {
      brokenAdapter(
        `Payment provider "${providerName}" declares attribution kind "${kind}" more than once`,
        providerName,
      );
    }
    seen.add(kind);
  }

  if (capabilities.supportsVirtualAccounts !== seen.has("virtual_account")) {
    brokenAdapter(
      `Payment provider "${providerName}" claims virtual accounts but does not declare the attribution kind`,
      providerName,
    );
  }
  if (
    capabilities.supportsPaymentReferences !==
    (seen.has("intent_reference") || seen.has("narration"))
  ) {
    brokenAdapter(
      `Payment provider "${providerName}" claims payment references but declares no reference-based attribution kind`,
      providerName,
    );
  }
}

export function assertPaymentIntentRequest(request: PaymentIntentRequest): void {
  const amountMinor: unknown = request.amount.amount;
  if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    rejectedRequest("Payment intent amount must be a positive integer in minor units");
  }
  const currency: unknown = request.amount.currency;
  if (!isIsoCurrency(currency)) {
    rejectedRequest("Payment intent amount must use an ISO 4217 currency code");
  }
  if (!isNonEmptyString(request.reference)) {
    rejectedRequest("Payment intent reference must not be empty");
  }
  if (!isNonEmptyString(request.idempotencyKey)) {
    rejectedRequest("Payment intent idempotency key must not be empty");
  }
}

export function assertPaymentIntent(
  intent: PaymentIntent,
  capabilities: PaymentProviderCapabilities,
  providerName: string,
): void {
  if (!isNonEmptyString(intent.providerId)) {
    brokenAdapter(
      `Payment provider "${providerName}" returned an intent without an id`,
      providerName,
    );
  }

  const status: unknown = intent.status;
  if (
    status !== "pending" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "abandoned"
  ) {
    brokenAdapter(
      `Payment provider "${providerName}" returned an unknown intent status "${String(status)}"`,
      providerName,
    );
  }

  const attribution = intent.attribution as { kind?: unknown; instruction?: unknown } | undefined;
  const kind: unknown = attribution?.kind;
  const declaredKinds: readonly string[] = capabilities.attributionKinds;
  if (!isNonEmptyString(kind) || !declaredKinds.includes(kind)) {
    brokenAdapter(
      `Payment provider "${providerName}" returned an intent attributed by "${String(kind)}", which it did not declare`,
      providerName,
    );
  }

  const instruction = attribution?.instruction;
  if (instruction !== undefined) {
    const value: unknown = (instruction as { value?: unknown }).value;
    const type: unknown = (instruction as { type?: unknown }).type;
    const expiresAt: unknown = (instruction as { expiresAt?: unknown }).expiresAt;
    if (!isNonEmptyString(value)) {
      brokenAdapter(
        `Payment provider "${providerName}" returned an empty payment instruction`,
        providerName,
      );
    }
    const expectedType = kind === "virtual_account" ? "virtual_account" : "reference";
    if (type !== expectedType) {
      brokenAdapter(
        `Payment provider "${providerName}" returned instruction type "${String(type)}" for attribution "${kind}"`,
        providerName,
      );
    }
    if (expiresAt !== undefined && !isValidDate(expiresAt)) {
      brokenAdapter(
        `Payment provider "${providerName}" returned an instruction expiry that is not a date`,
        providerName,
      );
    }
  }
}

export function assertNormalizedPaymentEvent(
  event: NormalizedPaymentEvent,
  providerName: string,
): void {
  if (!isNonEmptyString(event.providerEventId)) {
    brokenAdapter(
      `Payment provider "${providerName}" normalized an event without an event id`,
      providerName,
    );
  }
  if (!isNonEmptyString(event.providerReference)) {
    brokenAdapter(
      `Payment provider "${providerName}" normalized an event without a reference`,
      providerName,
    );
  }
  const status: unknown = event.status;
  if (status !== "success" && status !== "failed") {
    brokenAdapter(
      `Payment provider "${providerName}" normalized an unknown event status "${String(status)}"`,
      providerName,
    );
  }
  const amountMinor: unknown = event.amount.amount;
  if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor)) {
    brokenAdapter(
      `Payment provider "${providerName}" normalized an amount that is not an integer in minor units`,
      providerName,
    );
  }
  const currency: unknown = event.amount.currency;
  if (!isIsoCurrency(currency)) {
    brokenAdapter(
      `Payment provider "${providerName}" normalized an amount without an ISO 4217 currency`,
      providerName,
    );
  }
  if (!isValidDate(event.paidAt)) {
    brokenAdapter(
      `Payment provider "${providerName}" normalized an invalid paid-at timestamp`,
      providerName,
    );
  }
}
