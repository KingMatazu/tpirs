import { describe, expect, it } from "vitest";
import { createReceiptRendererConformanceSuite, conformanceFixtures } from "@tpirs/contracts";
import { tenantId } from "@tpirs/domain";
import { createMockReceiptRenderer } from "./index.js";

createReceiptRendererConformanceSuite({ describe, it, expect }, () => ({
  port: createMockReceiptRenderer(),
}));

describe("createMockReceiptRenderer", () => {
  it("supports registering custom templates", async () => {
    const renderer = createMockReceiptRenderer();
    renderer.registerTemplate("custom", (variables) => `Hello ${String(variables["name"])}`);
    const text = await renderer.renderSmsText({
      tenantId: tenantId("t1"),
      templateKey: "custom",
      language: "en",
      variables: { name: "Ada" },
    });
    expect(text).toBe("Hello Ada");
  });

  it("returns PDF bytes with a PDF header", async () => {
    const renderer = createMockReceiptRenderer();
    const pdf = await renderer.renderPdf({
      tenantId: tenantId("t1"),
      templateKey: conformanceFixtures.receiptTemplateKey,
      language: "en",
      variables: { amount: "50.00", reference: "r1" },
    });
    expect(new TextDecoder().decode(pdf.slice(0, 8))).toBe("%PDF-1.4");
  });
});
