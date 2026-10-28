import { PDFArray, PDFDocument, PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { createExportServiceConformanceSuite } from "@tpirs/contracts";
import { PortError } from "@tpirs/ports";
import { createPdfExportService } from "./index.js";

createExportServiceConformanceSuite(
  { describe, it, expect },
  () => ({ port: createPdfExportService() }),
  { formats: ["pdf"] },
);

/**
 * Bytes drawn on one page. `pdf-lib` keeps each page's drawing operators in a
 * content stream, so its length is a usable proxy for "how much was drawn here".
 */
function pageStreamSize(document: PDFDocument, index: number): number {
  const contents = document.getPage(index).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
  return streams.reduce((total, reference) => {
    const stream = document.context.lookup(reference);
    return total + (stream instanceof PDFRawStream ? stream.contents.length : 0);
  }, 0);
}

describe("createPdfExportService", () => {
  it("writes a document that opens and names the file", async () => {
    const result = await createPdfExportService().export({
      format: "pdf",
      columns: [
        { key: "zone", header: "Zone" },
        { key: "revenue", header: "Revenue" },
      ],
      rows: [
        { zone: "Central", revenue: "120000" },
        { zone: "Riverside", revenue: "80000" },
      ],
      filenameBase: "collections-by-zone",
    });

    expect(result.filename).toBe("collections-by-zone.pdf");
    const document = await PDFDocument.load(result.bytes);
    expect(document.getPageCount()).toBe(1);
  });

  it("paginates a long report instead of overflowing one page", async () => {
    const columns = [
      { key: "zone", header: "Zone" },
      { key: "revenue", header: "Revenue" },
    ];
    const rows = Array.from({ length: 120 }, (_, index) => ({
      zone: `Zone ${index}`,
      revenue: String(index * 1_000),
    }));
    const result = await createPdfExportService().export({
      format: "pdf",
      columns,
      rows,
      filenameBase: "long-report",
    });

    const document = await PDFDocument.load(result.bytes);
    expect(document.getPageCount()).toBeGreaterThan(1);

    // Every page after the first must actually carry rows. Drawing them all on
    // page 1 would still produce the extra pages (with headers only), so page
    // count alone does not prove the rows were paginated.
    const first = pageStreamSize(document, 0);
    for (let index = 1; index < document.getPageCount(); index += 1) {
      expect(pageStreamSize(document, index)).toBeGreaterThan(first / 2);
    }
  });

  it("renders characters the font cannot encode instead of failing", async () => {
    const result = await createPdfExportService().export({
      format: "pdf",
      columns: [{ key: "label", header: "Label" }],
      rows: [{ label: "₦ 500 — paid" }],
      filenameBase: "unicode",
    });
    const document = await PDFDocument.load(result.bytes);
    expect(document.getPageCount()).toBe(1);
  });

  it("refuses a format it does not implement", async () => {
    const error: unknown = await createPdfExportService()
      .export({ format: "xlsx", columns: [], rows: [], filenameBase: "nope" })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PortError);
  });
});
