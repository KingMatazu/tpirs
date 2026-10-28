import type { ExportFormat, ExportService } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { withAdapter } from "./harness.js";

/** What a file of each format must look like from the outside. */
const FORMAT_EXPECTATIONS: Record<
  ExportFormat,
  { readonly contentType: string; readonly extension: string; readonly magic?: string }
> = {
  csv: { contentType: "text/csv", extension: ".csv" },
  pdf: { contentType: "application/pdf", extension: ".pdf", magic: "%PDF-" },
  xlsx: {
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: ".xlsx",
    // Every OOXML package is a ZIP archive.
    magic: "PK\u0003\u0004",
  },
};

export interface ExportServiceConformanceOptions {
  /**
   * Formats this adapter declares. The suite only asks for formats an adapter
   * claims, so an adapter that produces CSV alone is conformant — but an
   * adapter that claims a format must produce a file the format checker
   * accepts, with real bytes (ADR 0034).
   */
  readonly formats?: readonly ExportFormat[];
}

export function createExportServiceConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<ExportService>,
  options: ExportServiceConformanceOptions = {},
): void {
  const { describe, it, expect } = harness;
  const formats = options.formats ?? ["csv"];

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

  for (const format of formats) {
    const expected = FORMAT_EXPECTATIONS[format];

    describe(`ExportService conformance (${format})`, () => {
      it("returns a usable file with a content type and filename", () =>
        withAdapter(factory, async (exportService) => {
          const result = await exportService.export({ ...request, format });
          expect(result.format).toBe(format);
          expect(result.contentType).toBe(expected.contentType);
          expect(result.filename.endsWith(expected.extension)).toBe(true);
          expect(result.bytes.length).toBeGreaterThan(0);
        }));

      it(`produces a readable ${format} document`, () =>
        withAdapter(factory, async (exportService) => {
          const result = await exportService.export({ ...request, format });
          if (expected.magic !== undefined) {
            const prefix = new TextDecoder().decode(result.bytes.slice(0, 8));
            expect(prefix.startsWith(expected.magic)).toBe(true);
          }
          if (format === "csv") {
            const text = new TextDecoder().decode(result.bytes);
            expect(text).toContain("ID,Name");
            expect(text).toContain("Ada");
          }
        }));

      it("exports headers even with zero rows", () =>
        withAdapter(factory, async (exportService) => {
          const result = await exportService.export({ ...request, format, rows: [] });
          expect(result.bytes.length).toBeGreaterThan(0);
        }));
    });
  }
}
