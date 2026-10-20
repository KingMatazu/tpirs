import { PortError } from "@tpirs/ports";
import type { UssdProvider } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { withAdapter } from "./harness.js";

export function createUssdProviderConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<UssdProvider>,
): void {
  const { describe, it, expect } = harness;

  describe("UssdProvider conformance", () => {
    it("handles a session and returns a menu response", () =>
      withAdapter(factory, async (provider) => {
        const response = await provider.handleSession({
          sessionId: "conf-ussd-1",
          from: "+2348000000001",
          text: "",
          shortcode: "*123#",
        });
        expect(["continue", "end"]).toContain(response.type);
        expect(response.message.length > 0).toBe(true);
      }));

    it("rejects sessions without a session id", () =>
      withAdapter(factory, async (provider) => {
        await expect(
          provider.handleSession({
            sessionId: "",
            from: "+2348000000001",
            text: "",
            shortcode: "*123#",
          }),
        ).rejects.toThrow(PortError);
      }));
  });
}
