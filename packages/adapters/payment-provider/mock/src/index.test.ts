import { describe, expect, it } from "vitest";
import { createPaymentProviderConformanceSuite } from "@tpirs/contracts";
import { money } from "@tpirs/domain";
import { createMockPaymentProvider, mockWebhookSignature } from "./index.js";

createPaymentProviderConformanceSuite({ describe, it, expect }, () => ({
  port: createMockPaymentProvider(),
}));

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
});
