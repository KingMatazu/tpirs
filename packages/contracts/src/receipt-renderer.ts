import { tenantId } from "@tpirs/domain";
import { PortError } from "@tpirs/ports";
import type { ReceiptRenderer } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { conformanceFixtures, withAdapter } from "./harness.js";

/** Factories must render conformanceFixtures.receiptTemplateKey (en language). */
export function createReceiptRendererConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<ReceiptRenderer>,
): void {
  const { describe, it, expect } = harness;

  describe("ReceiptRenderer conformance", () => {
    it("renders SMS receipt text", () =>
      withAdapter(factory, async (renderer) => {
        const text = await renderer.renderSmsText({
          tenantId: tenantId("conformance-tenant"),
          templateKey: conformanceFixtures.receiptTemplateKey,
          language: "en",
          variables: { amount: "50.00", reference: "conf-ref-1" },
        });
        expect(text.length).toBeGreaterThan(0);
      }));

    it("renders a PDF receipt as bytes", () =>
      withAdapter(factory, async (renderer) => {
        const pdf = await renderer.renderPdf({
          tenantId: tenantId("conformance-tenant"),
          templateKey: conformanceFixtures.receiptTemplateKey,
          language: "en",
          variables: { amount: "50.00", reference: "conf-ref-1" },
        });
        expect(pdf).toBeInstanceOf(Uint8Array);
        expect(pdf.length).toBeGreaterThan(0);
      }));

    it("throws PortError not_found for unknown templates", () =>
      withAdapter(factory, async (renderer) => {
        await expect(
          renderer.renderSmsText({
            tenantId: tenantId("conformance-tenant"),
            templateKey: "no-such-template",
            language: "en",
            variables: {},
          }),
        ).rejects.toThrow(PortError);
      }));
  });
}
