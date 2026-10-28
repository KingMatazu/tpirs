import { describe, expect, it } from "vitest";
import { createExportServiceConformanceSuite } from "@tpirs/contracts";
import { PortError } from "@tpirs/ports";
import { createCsvExportService } from "./index.js";

createExportServiceConformanceSuite(
  { describe, it, expect },
  () => ({ port: createCsvExportService() }),
  { formats: ["csv"] },
);

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("createCsvExportService", () => {
  it("quotes fields that contain separators, quotes or newlines", async () => {
    const result = await createCsvExportService().export({
      format: "csv",
      columns: [
        { key: "name", header: "Name" },
        { key: "note", header: "Note" },
      ],
      rows: [
        { name: 'Ada, "Lovelace"', note: "line\nbreak" },
        { name: "Chidi", note: "" },
      ],
      filenameBase: "escaped",
    });
    expect(decode(result.bytes)).toBe(
      'Name,Note\r\n"Ada, ""Lovelace""","line\nbreak"\r\nChidi,\r\n',
    );
    expect(result.filename).toBe("escaped.csv");
  });

  it("writes bigint money and dates without inventing precision", async () => {
    const result = await createCsvExportService().export({
      format: "csv",
      columns: [
        { key: "amountMinor", header: "Amount (minor)" },
        { key: "settledAt", header: "Settled at" },
        { key: "missing", header: "Missing" },
      ],
      rows: [
        {
          amountMinor: 123_456n,
          settledAt: new Date("2026-03-04T00:00:00.000Z"),
        },
      ],
      filenameBase: "money",
    });
    expect(decode(result.bytes)).toContain("123456,2026-03-04T00:00:00.000Z,\r\n");
  });

  it("refuses a format it does not implement", async () => {
    const error: unknown = await createCsvExportService()
      .export({
        format: "pdf",
        columns: [],
        rows: [],
        filenameBase: "nope",
      })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PortError);
    expect((error as PortError).code).toBe("invalid_request");
  });
});
