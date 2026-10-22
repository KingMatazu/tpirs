import { describe, expect, it } from "vitest";
import { money } from "@tpirs/domain";
import { PortError } from "./errors.js";
import type {
  NormalizedPaymentEvent,
  PaymentIntent,
  PaymentProviderCapabilities,
} from "./payment-provider.js";
import {
  assertNormalizedPaymentEvent,
  assertPaymentIntent,
  assertPaymentIntentRequest,
  assertPaymentProviderCapabilities,
} from "./payment-provider-rules.js";

const capabilities = (
  overrides: Partial<PaymentProviderCapabilities> = {},
): PaymentProviderCapabilities => ({
  supportsVirtualAccounts: true,
  supportsPaymentReferences: true,
  supportsSettlementFetch: true,
  attributionKinds: ["intent_reference", "virtual_account", "narration"],
  ...overrides,
});

const intent = (overrides: Partial<PaymentIntent> = {}): PaymentIntent => ({
  providerId: "intent-1",
  status: "pending",
  attribution: { kind: "intent_reference", instruction: { type: "reference", value: "ref-1" } },
  raw: {},
  ...overrides,
});

const event = (overrides: Partial<NormalizedPaymentEvent> = {}): NormalizedPaymentEvent => ({
  providerEventId: "evt-1",
  providerReference: "ref-1",
  amount: money("NGN", 5000),
  status: "success",
  paidAt: new Date("2026-10-20T09:00:00Z"),
  raw: {},
  ...overrides,
});

/** Returns the PortError code thrown by `fn`, or undefined when it did not throw. */
function codeOf(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof PortError ? error.code : "not-a-port-error";
  }
}

describe("assertPaymentProviderCapabilities", () => {
  it("accepts a well-formed provider", () => {
    expect(
      codeOf(() => {
        assertPaymentProviderCapabilities(capabilities(), "mock");
      }),
    ).toBeUndefined();
  });

  it("rejects an empty provider name", () => {
    expect(
      codeOf(() => {
        assertPaymentProviderCapabilities(capabilities(), "  ");
      }),
    ).toBe("provider_error");
  });

  it("rejects a provider that declares no attribution kinds", () => {
    expect(
      codeOf(() => {
        assertPaymentProviderCapabilities(
          capabilities({
            attributionKinds: [] as unknown as PaymentProviderCapabilities["attributionKinds"],
          }),
          "broken",
        );
      }),
    ).toBe("provider_error");
  });

  it("rejects an unknown attribution kind", () => {
    expect(
      codeOf(() => {
        assertPaymentProviderCapabilities(
          capabilities({
            attributionKinds: [
              "bank_transfer",
            ] as unknown as PaymentProviderCapabilities["attributionKinds"],
          }),
          "broken",
        );
      }),
    ).toBe("provider_error");
  });

  it("rejects a duplicated attribution kind", () => {
    expect(
      codeOf(() => {
        assertPaymentProviderCapabilities(
          capabilities({ attributionKinds: ["narration", "narration"] }),
          "broken",
        );
      }),
    ).toBe("provider_error");
  });

  it("rejects a virtual account claim without the attribution kind", () => {
    expect(
      codeOf(() => {
        assertPaymentProviderCapabilities(
          capabilities({ attributionKinds: ["intent_reference"], supportsVirtualAccounts: true }),
          "broken",
        );
      }),
    ).toBe("provider_error");
  });

  it("rejects a reference claim without a reference-based kind", () => {
    expect(
      codeOf(() => {
        assertPaymentProviderCapabilities(
          capabilities({
            attributionKinds: ["virtual_account"],
            supportsVirtualAccounts: true,
            supportsPaymentReferences: true,
          }),
          "broken",
        );
      }),
    ).toBe("provider_error");
  });
});

describe("assertPaymentIntentRequest", () => {
  const base = {
    idempotencyKey: "key-1",
    amount: money("NGN", 5000),
    reference: "ref-1",
  };

  it("accepts a well-formed request", () => {
    expect(
      codeOf(() => {
        assertPaymentIntentRequest(base);
      }),
    ).toBeUndefined();
  });

  it("rejects a zero, negative, or fractional amount", () => {
    for (const amount of [0, -1, 1.5]) {
      expect(
        codeOf(() => {
          assertPaymentIntentRequest({ ...base, amount: { currency: "NGN", amount } });
        }),
      ).toBe("invalid_request");
    }
  });

  it("rejects a currency that is not ISO 4217", () => {
    expect(
      codeOf(() => {
        assertPaymentIntentRequest({ ...base, amount: { currency: "ngn", amount: 5000 } });
      }),
    ).toBe("invalid_request");
  });

  it("rejects an empty reference or idempotency key", () => {
    expect(
      codeOf(() => {
        assertPaymentIntentRequest({ ...base, reference: " " });
      }),
    ).toBe("invalid_request");
    expect(
      codeOf(() => {
        assertPaymentIntentRequest({ ...base, idempotencyKey: "" });
      }),
    ).toBe("invalid_request");
  });
});

describe("assertPaymentIntent", () => {
  it("accepts a well-formed intent", () => {
    expect(
      codeOf(() => {
        assertPaymentIntent(intent(), capabilities(), "mock");
      }),
    ).toBeUndefined();
  });

  it("rejects an intent without a provider id", () => {
    expect(
      codeOf(() => {
        assertPaymentIntent(intent({ providerId: " " }), capabilities(), "mock");
      }),
    ).toBe("provider_error");
  });

  it("rejects an unknown status", () => {
    expect(
      codeOf(() => {
        assertPaymentIntent(
          intent({ status: "settled" as PaymentIntent["status"] }),
          capabilities(),
          "mock",
        );
      }),
    ).toBe("provider_error");
  });

  it("rejects an attribution kind the adapter did not declare", () => {
    expect(
      codeOf(() => {
        assertPaymentIntent(
          intent({ attribution: { kind: "virtual_account" } }),
          capabilities({ attributionKinds: ["intent_reference"] }),
          "mock",
        );
      }),
    ).toBe("provider_error");
  });

  it("rejects an instruction whose type contradicts the attribution kind", () => {
    expect(
      codeOf(() => {
        assertPaymentIntent(
          intent({
            attribution: {
              kind: "intent_reference",
              instruction: { type: "virtual_account", value: "0123456789" },
            },
          }),
          capabilities(),
          "mock",
        );
      }),
    ).toBe("provider_error");
  });

  it("rejects an empty instruction value or an invalid expiry", () => {
    expect(
      codeOf(() => {
        assertPaymentIntent(
          intent({
            attribution: { kind: "narration", instruction: { type: "reference", value: "" } },
          }),
          capabilities(),
          "mock",
        );
      }),
    ).toBe("provider_error");
    expect(
      codeOf(() => {
        assertPaymentIntent(
          intent({
            attribution: {
              kind: "intent_reference",
              instruction: { type: "reference", value: "ref", expiresAt: new Date("not a date") },
            },
          }),
          capabilities(),
          "mock",
        );
      }),
    ).toBe("provider_error");
  });
});

describe("assertNormalizedPaymentEvent", () => {
  it("accepts a well-formed event", () => {
    expect(
      codeOf(() => {
        assertNormalizedPaymentEvent(event(), "mock");
      }),
    ).toBeUndefined();
  });

  it("rejects a missing event id or reference", () => {
    expect(
      codeOf(() => {
        assertNormalizedPaymentEvent(event({ providerEventId: "" }), "mock");
      }),
    ).toBe("provider_error");
    expect(
      codeOf(() => {
        assertNormalizedPaymentEvent(event({ providerReference: " " }), "mock");
      }),
    ).toBe("provider_error");
  });

  it("rejects an unknown status", () => {
    expect(
      codeOf(() => {
        assertNormalizedPaymentEvent(
          event({ status: "refunded" as NormalizedPaymentEvent["status"] }),
          "mock",
        );
      }),
    ).toBe("provider_error");
  });

  it("rejects a non-integer amount or bad currency", () => {
    expect(
      codeOf(() => {
        assertNormalizedPaymentEvent(event({ amount: { amount: 10.5, currency: "NGN" } }), "mock");
      }),
    ).toBe("provider_error");
    expect(
      codeOf(() => {
        assertNormalizedPaymentEvent(event({ amount: { amount: 100, currency: "naira" } }), "mock");
      }),
    ).toBe("provider_error");
  });

  it("rejects an invalid paid-at timestamp", () => {
    expect(
      codeOf(() => {
        assertNormalizedPaymentEvent(event({ paidAt: new Date("not a date") }), "mock");
      }),
    ).toBe("provider_error");
  });
});
