import { money } from "@tpirs/domain";
import { PortError } from "@tpirs/ports";
import type { PaymentProvider } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { conformanceFixtures, withAdapter } from "./harness.js";

const validWebhookBody = JSON.stringify({ event: "conformance" });

export function createPaymentProviderConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<PaymentProvider>,
): void {
  const { describe, it, expect } = harness;

  describe("PaymentProvider conformance", () => {
    it("declares capabilities and a non-empty name", () =>
      withAdapter(factory, (provider) => {
        const capabilities = provider.capabilities();
        expect(typeof capabilities.supportsVirtualAccounts).toBe("boolean");
        expect(typeof capabilities.supportsPaymentReferences).toBe("boolean");
        expect(typeof capabilities.supportsSettlementFetch).toBe("boolean");
        expect(provider.name.length > 0).toBe(true);
      }));

    it("creates a pending payment intent with a provider id", () =>
      withAdapter(factory, async (provider) => {
        const intent = await provider.createPaymentIntent({
          idempotencyKey: "conf-intent-1",
          amount: money(conformanceFixtures.currency, 5000),
          reference: "conf-ref-1",
        });
        expect(intent.providerId.length > 0).toBe(true);
        expect(intent.status).toBe("pending");
      }));

    it("rejects invalid payment intents with PortError invalid_request", () =>
      withAdapter(factory, async (provider) => {
        await expect(
          provider.createPaymentIntent({
            idempotencyKey: "conf-intent-2",
            amount: money(conformanceFixtures.currency, -1),
            reference: "conf-ref-2",
          }),
        ).rejects.toThrow(PortError);
      }));

    it("rejects webhooks with forged signatures", () =>
      withAdapter(factory, async (provider) => {
        const result = await provider.verifyWebhook({
          headers: { "x-signature": "forged" },
          rawBody: validWebhookBody,
        });
        expect(result.ok).toBe(false);
      }));

    it("rejects malformed webhook payloads during normalization", () =>
      withAdapter(factory, (provider) => {
        expect(() => provider.normalizeWebhook("not json")).toThrow(PortError);
      }));

    it("fetches settlements as a list", () =>
      withAdapter(factory, async (provider) => {
        const settlements = await provider.fetchSettlements({
          from: new Date("2026-01-01T00:00:00Z"),
          to: new Date("2026-01-02T00:00:00Z"),
        });
        expect(Array.isArray(settlements)).toBe(true);
      }));
  });
}
