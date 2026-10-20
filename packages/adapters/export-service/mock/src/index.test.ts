import { describe, expect, it } from "vitest";
import { createExportServiceConformanceSuite } from "@tpirs/contracts";
import { createMockExportService } from "./index.js";

createExportServiceConformanceSuite({ describe, it, expect }, () => ({
  port: createMockExportService(),
}));

describe("createMockExportService CSV", () => {
  it("escapes commas, quotes, and newlines", async () => {
    const exportService = createMockExportService();
    const result = await exportService.export({
      format: "csv",
      columns: [{ key: "name", header: "Name" }],
      rows: [{ name: 'Ada, "Lovelace"' }],
      filenameBase: "escaped",
    });
    expect(new TextDecoder().decode(result.bytes)).toBe('Name\n"Ada, ""Lovelace"""\n');
  });
});
