import { PortError } from "@tpirs/ports";
import type { InboundSms, SmsCallbackInput, SmsProvider } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { conformanceFixtures, withAdapter } from "./harness.js";

/**
 * A provider-shaped inbound callback and, optionally, the message it must
 * produce. Adapters pass their own fixture because field names differ.
 */
export interface SmsProviderConformanceFixtures {
  readonly inboundCallback?: SmsCallbackInput;
  readonly expectedInbound?: Pick<InboundSms, "providerMessageId" | "from" | "text">;
}

export function createSmsProviderConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<SmsProvider>,
  fixtures?: SmsProviderConformanceFixtures,
): void {
  const { describe, it, expect } = harness;

  describe("SmsProvider conformance", () => {
    it("declares capabilities", () =>
      withAdapter(factory, (provider) => {
        const capabilities = provider.capabilities();
        expect(typeof capabilities.supportsDeliveryReceipts).toBe("boolean");
        expect(typeof capabilities.supportsInbound).toBe("boolean");
        expect(capabilities.maxSegments).toBeGreaterThan(0);
      }));

    it("accepts a send and returns a provider message id", () =>
      withAdapter(factory, async (provider) => {
        const result = await provider.send({
          to: conformanceFixtures.smsRecipient,
          text: "Conformance test message",
          idempotencyKey: "conf-sms-1",
        });
        expect(result.providerMessageId.length > 0).toBe(true);
        expect(["accepted", "queued"]).toContain(result.status);
      }));

    it("rejects sends to empty recipients with PortError invalid_request", () =>
      withAdapter(factory, async (provider) => {
        await expect(
          provider.send({ to: "", text: "hello", idempotencyKey: "conf-sms-2" }),
        ).rejects.toThrow(PortError);
      }));

    it("fetches delivery receipts and inbound messages as lists", () =>
      withAdapter(factory, async (provider) => {
        const since = new Date("2026-01-01T00:00:00Z");
        expect(Array.isArray(await provider.fetchDeliveryReceipts(since))).toBe(true);
        expect(Array.isArray(await provider.fetchInbound(since))).toBe(true);
      }));

    it("exposes an inbound callback parser when inbound is supported", () =>
      withAdapter(factory, (provider) => {
        if (!provider.capabilities().supportsInbound) return;
        expect(typeof provider.parseInboundCallback).toBe("function");
      }));

    if (fixtures?.inboundCallback !== undefined) {
      const callback = fixtures.inboundCallback;
      const expected = fixtures.expectedInbound;
      it("parses an inbound callback into a normalized message", () =>
        withAdapter(factory, (provider) => {
          expect(typeof provider.parseInboundCallback).toBe("function");
          if (provider.parseInboundCallback === undefined) return;

          const message = provider.parseInboundCallback(callback);
          expect(message.providerMessageId.length > 0).toBe(true);
          expect(message.from.length > 0).toBe(true);
          expect(typeof message.text).toBe("string");
          expect(message.receivedAt instanceof Date).toBe(true);
          if (expected !== undefined) {
            expect(message.providerMessageId).toBe(expected.providerMessageId);
            expect(message.from).toBe(expected.from);
            expect(message.text).toBe(expected.text);
          }
        }));
    }

    it("rejects a malformed inbound callback with PortError invalid_request", () =>
      withAdapter(factory, (provider) => {
        if (!provider.capabilities().supportsInbound) return;
        expect(typeof provider.parseInboundCallback).toBe("function");
        expect(() => provider.parseInboundCallback?.({ body: {} })).toThrow(PortError);
      }));
  });
}
