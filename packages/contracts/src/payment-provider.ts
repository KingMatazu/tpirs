import { money } from "@tpirs/domain";
import {
  assertNormalizedPaymentEvent,
  assertPaymentIntent,
  assertPaymentProviderCapabilities,
  PAYMENT_ATTRIBUTION_KINDS,
  PortError,
} from "@tpirs/ports";
import type { NormalizedPaymentEvent, PaymentProvider } from "@tpirs/ports";
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
        assertPaymentProviderCapabilities(capabilities, provider.name);
        expect(typeof capabilities.supportsVirtualAccounts).toBe("boolean");
        expect(typeof capabilities.supportsPaymentReferences).toBe("boolean");
        expect(typeof capabilities.supportsSettlementFetch).toBe("boolean");
        expect(provider.name.length > 0).toBe(true);
      }));

    it("declares attribution kinds that agree with its capability flags", () =>
      withAdapter(factory, (provider) => {
        const { attributionKinds, supportsVirtualAccounts, supportsPaymentReferences } =
          provider.capabilities();
        expect(Array.isArray(attributionKinds)).toBe(true);
        expect(attributionKinds.length).toBeGreaterThan(0);
        expect(new Set(attributionKinds).size).toBe(attributionKinds.length);
        for (const kind of attributionKinds) {
          expect(PAYMENT_ATTRIBUTION_KINDS).toContain(kind);
        }
        expect(supportsVirtualAccounts).toBe(attributionKinds.includes("virtual_account"));
        expect(supportsPaymentReferences).toBe(
          attributionKinds.includes("intent_reference") || attributionKinds.includes("narration"),
        );
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

    it("reports which attribution an intent used, from the kinds it declared", () =>
      withAdapter(factory, async (provider) => {
        const declared = provider.capabilities().attributionKinds;
        const intent = await provider.createPaymentIntent({
          idempotencyKey: "conf-intent-2",
          amount: money(conformanceFixtures.currency, 5000),
          reference: "conf-ref-2",
        });
        assertPaymentIntent(intent, provider.capabilities(), provider.name);
        expect(declared).toContain(intent.attribution.kind);
        const instruction = intent.attribution.instruction;
        if (instruction !== undefined) {
          expect(instruction.value.length).toBeGreaterThan(0);
          expect(Number.isNaN(instruction.expiresAt?.getTime() ?? 0)).toBe(false);
          expect(instruction.type).toBe(
            intent.attribution.kind === "virtual_account" ? "virtual_account" : "reference",
          );
        }
      }));

    it("rejects invalid payment intents with PortError invalid_request", () =>
      withAdapter(factory, async (provider) => {
        await expect(
          provider.createPaymentIntent({
            idempotencyKey: "conf-intent-3",
            amount: money(conformanceFixtures.currency, -1),
            reference: "conf-ref-3",
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

/** A recorded delivery, exactly as the gateway sent it. */
export interface PaymentProviderWebhookFixture {
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string;
}

/**
 * A recorded delivery for one adapter, plus the event it must normalise to.
 *
 * The point of a fixture is that the same intake test can run against every
 * adapter without changing: swapping the gateway swaps the fixture, not the
 * test. `expected.raw` is omitted because it is the adapter's own payload.
 */
export interface PaymentProviderFixture {
  /** Adapter name this fixture was recorded against, matching `PaymentProvider.name`. */
  readonly adapter: string;
  readonly description: string;
  readonly valid: PaymentProviderWebhookFixture;
  readonly expected: Omit<NormalizedPaymentEvent, "raw">;
  /** The same delivery with a signature that must not verify. */
  readonly forged: PaymentProviderWebhookFixture;
}

/**
 * Proves that an adapter verifies, normalizes, and rejects its own recorded
 * delivery. Every adapter must ship at least one fixture; the intake end-to-end
 * test drives the pipeline from the same values.
 */
export function createPaymentProviderFixtureSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<PaymentProvider>,
  fixture: PaymentProviderFixture,
): void {
  const { describe, it, expect } = harness;

  describe(`PaymentProvider fixture (${fixture.adapter})`, () => {
    it("verifies the recorded delivery", () =>
      withAdapter(factory, async (provider) => {
        expect(provider.name).toBe(fixture.adapter);
        expect(await provider.verifyWebhook(fixture.valid)).toEqual({ ok: true });
      }));

    it("normalizes the recorded delivery to the documented event", () =>
      withAdapter(factory, (provider) => {
        const event = provider.normalizeWebhook(fixture.valid.rawBody);
        assertNormalizedPaymentEvent(event, provider.name);
        expect(event.providerEventId).toBe(fixture.expected.providerEventId);
        expect(event.providerReference).toBe(fixture.expected.providerReference);
        expect(event.amount).toEqual(fixture.expected.amount);
        expect(event.status).toBe(fixture.expected.status);
        expect(event.paidAt.toISOString()).toBe(fixture.expected.paidAt.toISOString());
        expect(Number.isInteger(event.amount.amount)).toBe(true);
      }));

    it("normalizes the same delivery identically on replay", () =>
      withAdapter(factory, (provider) => {
        const first = provider.normalizeWebhook(fixture.valid.rawBody);
        const second = provider.normalizeWebhook(fixture.valid.rawBody);
        expect(second.providerEventId).toBe(first.providerEventId);
        expect(second.amount).toEqual(first.amount);
      }));

    it("rejects the forged delivery", () =>
      withAdapter(factory, async (provider) => {
        expect(await provider.verifyWebhook(fixture.forged)).toEqual({ ok: false });
      }));
  });
}
