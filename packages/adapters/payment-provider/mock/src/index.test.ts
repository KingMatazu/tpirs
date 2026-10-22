import { describe, expect, it } from "vitest";
import {
  createPaymentProviderConformanceSuite,
  createPaymentProviderFixtureSuite,
} from "@tpirs/contracts";
import { money } from "@tpirs/domain";
import { PortError } from "@tpirs/ports";
import {
  createMockPaymentProvider,
  mockPaymentProviderFixture,
  mockWebhookSignature,
} from "./index.js";

createPaymentProviderConformanceSuite({ describe, it, expect }, () => ({
  port: createMockPaymentProvider(),
}));

createPaymentProviderFixtureSuite(
  { describe, it, expect },
  () => ({ port: createMockPaymentProvider() }),
  mockPaymentProviderFixture,
);

describe("createMockPaymentProvider intents", () => {
  it("attributes an intent by reference and records it for inspection", async () => {
    const provider = createMockPaymentProvider();
    const intent = await provider.createPaymentIntent({
      idempotencyKey: "intent-1",
      amount: money("NGN", 5000),
      reference: "ref-abc",
    });

    expect(intent.attribution.kind).toBe("intent_reference");
    expect(intent.attribution.instruction).toEqual({ type: "reference", value: "ref-abc" });
    expect(provider.intents).toHaveLength(1);
  });

  it("rejects a non-positive amount", async () => {
    const provider = createMockPaymentProvider();
    await expect(
      provider.createPaymentIntent({
        idempotencyKey: "intent-2",
        amount: money("NGN", 0),
        reference: "ref-zero",
      }),
    ).rejects.toThrow(PortError);
  });

  it("rejects an empty reference", async () => {
    const provider = createMockPaymentProvider();
    await expect(
      provider.createPaymentIntent({
        idempotencyKey: "intent-3",
        amount: money("NGN", 100),
        reference: "   ",
      }),
    ).rejects.toThrow(PortError);
  });
});

describe("createMockPaymentProvider webhook normalization", () => {
  it("verifies valid signatures and normalizes valid payloads", async () => {
    const provider = createMockPaymentProvider();
    const body = JSON.stringify({
      providerEventId: "evt-1",
      providerReference: "ref-1",
      amount: { amount: 5000, currency: "NGN" },
      status: "success",
      paidAt: "2026-10-20T09:00:00Z",
    });

    await expect(provider.verifyWebhook({ headers: {}, rawBody: body })).resolves.toEqual({
      ok: false,
    });
    await expect(
      provider.verifyWebhook({
        headers: { "x-signature": mockWebhookSignature(body) },
        rawBody: body,
      }),
    ).resolves.toEqual({ ok: true });

    const event = provider.normalizeWebhook(body);
    expect(event.providerEventId).toBe("evt-1");
    expect(event.amount).toEqual(money("NGN", 5000));
    expect(event.status).toBe("success");
  });

  it("dedupes via a stable providerEventId on replay", () => {
    const provider = createMockPaymentProvider();
    const body = JSON.stringify({
      providerEventId: "evt-2",
      providerReference: "ref-2",
      amount: { amount: 100, currency: "NGN" },
      status: "success",
      paidAt: "2026-10-20T09:00:00Z",
    });
    expect(provider.normalizeWebhook(body).providerEventId).toBe(
      provider.normalizeWebhook(body).providerEventId,
    );
  });

  it("rejects a paid-at timestamp that is not a date", () => {
    const provider = createMockPaymentProvider();
    const body = JSON.stringify({
      providerEventId: "evt-3",
      providerReference: "ref-3",
      amount: { amount: 100, currency: "NGN" },
      status: "success",
      paidAt: "yesterday",
    });
    expect(() => provider.normalizeWebhook(body)).toThrow(PortError);
  });

  it("surfaces an invalid amount as a PortError rather than a domain error", () => {
    const provider = createMockPaymentProvider();
    const fractional = JSON.stringify({
      providerEventId: "evt-4",
      providerReference: "ref-4",
      amount: { amount: 10.5, currency: "NGN" },
      status: "success",
      paidAt: "2026-10-20T09:00:00Z",
    });
    const badCurrency = JSON.stringify({
      providerEventId: "evt-5",
      providerReference: "ref-5",
      amount: { amount: 100, currency: "naira" },
      status: "success",
      paidAt: "2026-10-20T09:00:00Z",
    });

    expect(() => provider.normalizeWebhook(fractional)).toThrow(PortError);
    expect(() => provider.normalizeWebhook(badCurrency)).toThrow(PortError);
  });

  it("rejects a payload without a success or failure status", () => {
    const provider = createMockPaymentProvider();
    const body = JSON.stringify({
      providerEventId: "evt-6",
      providerReference: "ref-6",
      amount: { amount: 100, currency: "NGN" },
      status: "pending",
      paidAt: "2026-10-20T09:00:00Z",
    });
    expect(() => provider.normalizeWebhook(body)).toThrow(PortError);
  });
});
