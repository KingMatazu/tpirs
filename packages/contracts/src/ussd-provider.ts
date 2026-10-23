import { PortError } from "@tpirs/ports";
import type { UssdCallbackInput, UssdProvider, UssdSessionRequest } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { withAdapter } from "./harness.js";

/**
 * A provider-shaped callback and the request it must produce. Adapters pass
 * their own fixture, because every aggregator names its fields differently.
 */
export interface UssdProviderConformanceFixtures {
  readonly callback: UssdCallbackInput;
  readonly expected: UssdSessionRequest;
}

export function createUssdProviderConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<UssdProvider>,
  fixtures?: UssdProviderConformanceFixtures,
): void {
  const { describe, it, expect } = harness;

  describe("UssdProvider conformance", () => {
    it("declares capabilities", () =>
      withAdapter(factory, (provider) => {
        const capabilities = provider.capabilities();
        expect(provider.name.length > 0).toBe(true);
        expect(capabilities.maxResponseLength).toBeGreaterThan(0);
        expect(typeof capabilities.supportsServiceCode).toBe("boolean");
      }));

    if (fixtures !== undefined) {
      it("parses a provider callback into a session request", () =>
        withAdapter(factory, (provider) => {
          const request = provider.parseCallback(fixtures.callback);
          expect(request.sessionId).toBe(fixtures.expected.sessionId);
          expect(request.from).toBe(fixtures.expected.from);
          expect(request.text).toBe(fixtures.expected.text);
          expect(request.shortcode).toBe(fixtures.expected.shortcode);
          if (fixtures.expected.serviceCode !== undefined) {
            expect(request.serviceCode).toBe(fixtures.expected.serviceCode);
          }
        }));
    }

    it("rejects a malformed callback with PortError invalid_request", () =>
      withAdapter(factory, (provider) => {
        expect(() => provider.parseCallback({ body: {} })).toThrow(PortError);
      }));

    it("renders a continue response in the provider's format", () =>
      withAdapter(factory, (provider) => {
        const rendered = provider.renderResponse({
          type: "continue",
          message: "Choose an option",
        });
        expect(rendered.statusCode).toBe(200);
        expect(rendered.contentType.length > 0).toBe(true);
        expect(rendered.body).toContain("Choose an option");
      }));

    it("renders an end response in the provider's format", () =>
      withAdapter(factory, (provider) => {
        const rendered = provider.renderResponse({
          type: "end",
          message: "Thank you",
        });
        expect(rendered.statusCode).toBe(200);
        expect(rendered.body).toContain("Thank you");
      }));
  });
}
