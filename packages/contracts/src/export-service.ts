import type { ExportService } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { withAdapter } from "./harness.js";

export function createExportServiceConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<ExportService>,
): void {
  const { describe, it, expect } = harness;

  const request = {
    format: "csv" as const,
    columns: [
      { key: "id", header: "ID" },
      { key: "name", header: "Name" },
    ],
    rows: [
      { id: "1", name: "Ada" },
      { id: "2", name: "Chidi" },
    ],
    filenameBase: "conformance-export",
  };

  describe("ExportService conformance", () => {
    it("exports CSV with a content type and filename", () =>
      withAdapter(factory, async (exportService) => {
        const result = await exportService.export(request);
        expect(result.format).toBe("csv");
        expect(result.contentType).toBe("text/csv");
        expect(result.filename.endsWith(".csv")).toBe(true);
        expect(result.bytes.length).toBeGreaterThan(0);
      }));

    it("exports headers even with zero rows", () =>
      withAdapter(factory, async (exportService) => {
        const result = await exportService.export({ ...request, rows: [] });
        expect(result.bytes.length).toBeGreaterThan(0);
      }));
  });
}
