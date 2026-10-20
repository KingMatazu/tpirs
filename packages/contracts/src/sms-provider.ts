import { PortError } from "@tpirs/ports";
import type { SmsProvider } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { conformanceFixtures, withAdapter } from "./harness.js";

export function createSmsProviderConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<SmsProvider>,
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
  });
}
