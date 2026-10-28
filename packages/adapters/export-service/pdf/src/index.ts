import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { PDFFont, PDFPage } from "pdf-lib";
import type { ExportRequest, ExportResult, ExportService } from "@tpirs/ports";
import { PortError } from "@tpirs/ports";

/**
 * PDF export (ADR 0034).
 *
 * Deliberately a table renderer, not a layout engine: a title, a header row,
 * the rows, and a page number. `pdf-lib` is pure JavaScript with no native
 * build, which is what the no-postinstall rule requires.
 */

const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const MARGIN = 36;
const ROW_HEIGHT = 14;
const TITLE_SIZE = 13;
const HEADER_SIZE = 8;
const BODY_SIZE = 8;

const GREY = rgb(0.45, 0.45, 0.45);
const BLACK = rgb(0, 0, 0);

/** pdf-lib's standard fonts use WinAnsi, so text outside that range becomes "?". */
function encodable(text: string): string {
  return text.replaceAll(/[^\u0020-\u007e\u00a0-\u00ff]/g, "?");
}

function plain(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return encodable(value);
  if (typeof value === "object") return encodable(JSON.stringify(value));
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return encodable(`${value}`);
  }
  if (typeof value === "symbol" || typeof value === "function") return encodable(value.toString());
  return "";
}

function fit(text: string, font: PDFFont, size: number, width: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let truncated = text;
  while (truncated.length > 0 && font.widthOfTextAtSize(`${truncated}...`, size) > width) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}...`;
}

export async function renderPdf(request: ExportRequest): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const body = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);

  const usableWidth = PAGE_WIDTH - MARGIN * 2;
  const columnCount = Math.max(request.columns.length, 1);
  const columnWidth = usableWidth / columnCount;
  const rowsPerPage = Math.floor(
    (PAGE_HEIGHT - MARGIN * 2 - TITLE_SIZE - ROW_HEIGHT * 2) / ROW_HEIGHT,
  );

  let pageNumber = 1;
  let rowOnPage = 0;

  const drawHeader = (target: PDFPage): void => {
    let x = MARGIN;
    for (const column of request.columns) {
      target.drawText(fit(plain(column.header), bold, HEADER_SIZE, columnWidth - 6), {
        x,
        y: PAGE_HEIGHT - MARGIN - TITLE_SIZE - ROW_HEIGHT,
        size: HEADER_SIZE,
        font: bold,
        color: BLACK,
      });
      x += columnWidth;
    }
    target.drawLine({
      start: { x: MARGIN, y: PAGE_HEIGHT - MARGIN - TITLE_SIZE - ROW_HEIGHT - 4 },
      end: { x: PAGE_WIDTH - MARGIN, y: PAGE_HEIGHT - MARGIN - TITLE_SIZE - ROW_HEIGHT - 4 },
      thickness: 0.5,
      color: GREY,
    });
  };

  const startPage = (): PDFPage => {
    const fresh = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    fresh.drawText(fit(plain(request.filenameBase), bold, TITLE_SIZE, usableWidth), {
      x: MARGIN,
      y: PAGE_HEIGHT - MARGIN - TITLE_SIZE,
      size: TITLE_SIZE,
      font: bold,
      color: BLACK,
    });
    drawHeader(fresh);
    rowOnPage = 0;
    return fresh;
  };

  let page = startPage();

  for (const row of request.rows) {
    if (rowOnPage >= rowsPerPage) {
      page.drawText(`Page ${pageNumber}`, {
        x: PAGE_WIDTH / 2 - 12,
        y: MARGIN / 2,
        size: 7,
        font: body,
        color: GREY,
      });
      pageNumber += 1;
      page = startPage();
    }
    const y = PAGE_HEIGHT - MARGIN - TITLE_SIZE - ROW_HEIGHT * 2 - rowOnPage * ROW_HEIGHT;
    let x = MARGIN;
    for (const column of request.columns) {
      page.drawText(fit(plain(row[column.key]), body, BODY_SIZE, columnWidth - 6), {
        x,
        y,
        size: BODY_SIZE,
        font: body,
        color: BLACK,
      });
      x += columnWidth;
    }
    rowOnPage += 1;
  }

  page.drawText(`Page ${pageNumber}`, {
    x: PAGE_WIDTH / 2 - 12,
    y: MARGIN / 2,
    size: 7,
    font: body,
    color: GREY,
  });

  return document.save();
}

export function createPdfExportService(): ExportService {
  return {
    export(request: ExportRequest): Promise<ExportResult> {
      if (request.format !== "pdf") {
        return Promise.reject(
          new PortError(
            "ExportService",
            "invalid_request",
            `PDF adapter cannot export ${request.format}`,
          ),
        );
      }
      return renderPdf(request).then((bytes) => ({
        format: "pdf",
        contentType: "application/pdf",
        filename: `${request.filenameBase}.pdf`,
        bytes,
      }));
    },
  };
}
