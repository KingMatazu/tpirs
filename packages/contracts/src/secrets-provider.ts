import { PortError } from "@tpirs/ports";
import type { SecretsProvider } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { conformanceFixtures, withAdapter } from "./harness.js";

/** Factories must serve conformanceFixtures.secretRef -> conformanceFixtures.secretValue. */
export function createSecretsProviderConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<SecretsProvider>,
): void {
  const { describe, it, expect } = harness;

  describe("SecretsProvider conformance", () => {
    it("resolves a known secret reference", () =>
      withAdapter(factory, async (secrets) => {
        expect(await secrets.getSecret(conformanceFixtures.secretRef)).toBe(
          conformanceFixtures.secretValue,
        );
      }));

    it("throws PortError not_found for unknown references", () =>
      withAdapter(factory, async (secrets) => {
        const error = await secrets.getSecret("definitely/not/a/secret").catch((e: unknown) => e);
        expect(error).toBeInstanceOf(PortError);
        expect((error as PortError).code).toBe("not_found");
      }));
  });
}
