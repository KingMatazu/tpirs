import { PortError } from "@tpirs/ports";
import type { ReceiptRenderer, ReceiptRequest } from "@tpirs/ports";
import { conformanceFixtures } from "@tpirs/contracts";

export type MockReceiptTemplate = (variables: Readonly<Record<string, string | number>>) => string;

const defaultTemplates: Readonly<Record<string, MockReceiptTemplate>> = {
  [conformanceFixtures.receiptTemplateKey]: (variables) =>
    `Payment received: ${String(variables["amount"] ?? "")} ref ${String(variables["reference"] ?? "")}`,
};

export interface MockReceiptRenderer extends ReceiptRenderer {
  registerTemplate(key: string, render: MockReceiptTemplate): void;
}

export function createMockReceiptRenderer(
  templates: Readonly<Record<string, MockReceiptTemplate>> = defaultTemplates,
): MockReceiptRenderer {
  const allTemplates = new Map(Object.entries(templates));

  function render(request: ReceiptRequest): string {
    const template = allTemplates.get(request.templateKey);
    if (template === undefined) {
      throw new PortError(
        "ReceiptRenderer",
        "not_found",
        `Template "${request.templateKey}" was not found`,
      );
    }
    return template(request.variables);
  }

  return {
    renderSmsText(request) {
      try {
        return Promise.resolve(render(request));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    renderPdf(request) {
      try {
        const text = render(request);
        const header = new TextEncoder().encode("%PDF-1.4\n% mock receipt\n");
        const body = new TextEncoder().encode(text);
        const merged = new Uint8Array(header.length + body.length);
        merged.set(header);
        merged.set(body, header.length);
        return Promise.resolve(merged);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    registerTemplate(key, renderFn) {
      allTemplates.set(key, renderFn);
    },
  };
}
