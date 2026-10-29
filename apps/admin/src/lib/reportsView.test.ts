import { describe, expect, it, vi } from "vitest";
import { formatMoneyMinor } from "@tpirs/ui-tokens";
import {
  REPORT_KEYS,
  REPORT_OPTIONS,
  defaultReportRange,
  downloadReport,
  exportFilename,
  exportQueryParams,
  formatReportCell,
  reportLabel,
  reportQueryParams,
  type ReportColumnView,
} from "./reportsView.js";

/**
 * The pure rules behind the reports screen. Two are load-bearing: the cell
 * formatter (money is a minor-unit string and a count must never gain a
 * currency symbol) and the filename, which decides what the user finds in their
 * downloads folder when the proxy strips `content-disposition`.
 */

const money = formatMoneyMinor("20000", "NGN", "en-NG");

const moneyColumn: ReportColumnView = { key: "revenueMinor", header: "Revenue", kind: "money" };
const countColumn: ReportColumnView = { key: "paymentsCount", header: "Payments", kind: "count" };
const textColumn: ReportColumnView = { key: "zoneName", header: "Zone", kind: "text" };

describe("report catalogue", () => {
  it("names all six report keys with human labels", () => {
    expect(REPORT_KEYS).toHaveLength(6);
    expect(REPORT_OPTIONS.map((option) => option.key)).toEqual([...REPORT_KEYS]);
    expect(REPORT_OPTIONS.every((option) => option.label.trim() !== "")).toBe(true);
    expect(reportLabel("daily_collections")).toBe("Daily collections");
    expect(reportLabel("collections_by_zone")).toBe("Collections by zone");
    expect(reportLabel("collections_by_asset_type")).toBe("Collections by asset type");
    expect(reportLabel("collector_positions")).toBe("Collector positions");
    expect(reportLabel("compliance")).toBe("Compliance rate");
    expect(reportLabel("exceptions_summary")).toBe("Exceptions summary");
  });
});

describe("range and query params", () => {
  it("opens on the last seven business days", () => {
    expect(defaultReportRange(new Date("2026-10-29T10:00:00.000Z"))).toEqual({
      from: "2026-10-21",
      to: "2026-10-29",
    });
  });

  it("trims the bounds and keeps the export format", () => {
    expect(reportQueryParams(" 2026-10-21 ", "2026-10-29 ")).toEqual({
      from: "2026-10-21",
      to: "2026-10-29",
    });
    expect(exportQueryParams("2026-10-21", "2026-10-29", "xlsx")).toEqual({
      from: "2026-10-21",
      to: "2026-10-29",
      format: "xlsx",
    });
  });
});

describe("exportFilename", () => {
  it("prefers the name the server put in content-disposition", () => {
    expect(
      exportFilename(
        "daily_collections",
        "2026-06-15",
        "2026-06-15",
        "csv",
        'attachment; filename="daily_collections-2026-06-15-2026-06-15.csv"',
      ),
    ).toBe("daily_collections-2026-06-15-2026-06-15.csv");
  });

  it("accepts an unquoted or RFC 5987 filename", () => {
    expect(
      exportFilename(
        "compliance",
        "2026-06-15",
        "2026-06-15",
        "pdf",
        "attachment; filename=compliance.pdf",
      ),
    ).toBe("compliance.pdf");
    expect(
      exportFilename(
        "daily_collections",
        "2026-06-15",
        "2026-06-15",
        "csv",
        "attachment; filename*=UTF-8''daily%20collections.csv",
      ),
    ).toBe("daily collections.csv");
  });

  it("falls back to a deterministic name when the header is missing or blank", () => {
    const fallback = "daily_collections-2026-06-15-2026-06-15.xlsx";
    expect(exportFilename("daily_collections", "2026-06-15", "2026-06-15", "xlsx")).toBe(fallback);
    expect(exportFilename("daily_collections", "2026-06-15", "2026-06-15", "xlsx", null)).toBe(
      fallback,
    );
    expect(
      exportFilename("daily_collections", "2026-06-15", "2026-06-15", "xlsx", "attachment"),
    ).toBe(fallback);
  });
});

describe("formatReportCell", () => {
  it("formats money from its minor-unit string", () => {
    expect(formatReportCell(moneyColumn, "20000", "NGN", "en-NG")).toBe(money);
    expect(formatReportCell(moneyColumn, 20000, "NGN", "en-NG")).toBe(money);
  });

  it("leaves counts as plain digits", () => {
    expect(formatReportCell(countColumn, 7, "NGN", "en-NG")).toBe("7");
    expect(formatReportCell(countColumn, "7", "NGN", "en-NG")).toBe("7");
    expect(formatReportCell(countColumn, 1000, "NGN", "en-NG")).toBe("1000");
  });

  it("shows text verbatim and a gap as an em dash", () => {
    expect(formatReportCell(textColumn, "Central", "NGN", "en-NG")).toBe("Central");
    expect(formatReportCell(textColumn, null, "NGN", "en-NG")).toBe("—");
    expect(formatReportCell(moneyColumn, undefined, "NGN", "en-NG")).toBe("—");
  });
});

describe("downloadReport", () => {
  it("requests the export path with the format and bearer, then saves the named file", async () => {
    const calls: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
    const saved: { readonly filename: string; readonly size: number }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: urlOf(input), init });
      return new Response("a,b\n1,2\n", {
        status: 200,
        headers: { "content-disposition": 'attachment; filename="named-by-server.csv"' },
      });
    };

    const filename = await downloadReport(
      {
        reportKey: "daily_collections",
        from: "2026-06-15",
        to: "2026-06-16",
        format: "csv",
        token: "tok",
      },
      {
        fetchImpl,
        saveBlob: (blob, name) => {
          saved.push({ filename: name, size: blob.size });
        },
      },
    );

    expect(filename).toBe("named-by-server.csv");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(
      "/v1/reports/daily_collections/export?from=2026-06-15&to=2026-06-16&format=csv",
    );
    expect(call?.init?.headers).toEqual({ authorization: "Bearer tok" });
    expect(saved).toEqual([{ filename: "named-by-server.csv", size: 8 }]);
  });

  it("uses the fallback filename and refuses a failed export", async () => {
    const saveBlob = vi.fn();
    const okFetch = async (): Promise<Response> =>
      new Response("bytes", { status: 200, headers: {} });

    const filename = await downloadReport(
      {
        reportKey: "compliance",
        from: "2026-06-15",
        to: "2026-06-15",
        format: "pdf",
        token: undefined,
      },
      { fetchImpl: okFetch, saveBlob },
    );
    expect(filename).toBe("compliance-2026-06-15-2026-06-15.pdf");
    expect(saveBlob).toHaveBeenCalledTimes(1);

    const failing = async (): Promise<Response> => new Response("nope", { status: 400 });
    await expect(
      downloadReport(
        {
          reportKey: "compliance",
          from: "2026-06-15",
          to: "2026-06-15",
          format: "pdf",
          token: "tok",
        },
        { fetchImpl: failing, saveBlob },
      ),
    ).rejects.toThrow("Export failed with status 400");
    expect(saveBlob).toHaveBeenCalledTimes(1);
  });
});

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}
