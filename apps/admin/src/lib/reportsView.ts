import { formatMoneyMinor } from "@tpirs/ui-tokens";
import { lastBusinessDays, type BusinessDateRange } from "./reconciliationView.js";

/**
 * Pure helpers behind the reports screen (Step 8).
 *
 * The report catalogue is server-owned: the route returns the columns (key,
 * header, kind) and the rows, so the page renders whatever the report service
 * declares. This module only names the six keys, builds the range and query
 * string, formats a cell by its declared kind, and derives a download filename
 * from `content-disposition` with a deterministic fallback.
 */

export const REPORT_KEYS = [
  "daily_collections",
  "collections_by_zone",
  "collections_by_asset_type",
  "collector_positions",
  "compliance",
  "exceptions_summary",
] as const;

export type ReportKey = (typeof REPORT_KEYS)[number];

export type ExportFormat = "csv" | "pdf" | "xlsx";

export const EXPORT_FORMATS: readonly ExportFormat[] = ["csv", "pdf", "xlsx"];

/** Report picker entries: the contract key plus the label finance reads. */
export const REPORT_OPTIONS: readonly {
  readonly key: ReportKey;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    key: "daily_collections",
    label: "Daily collections",
    description: "Levy revenue, payments, cash intake and refunds per business day.",
  },
  {
    key: "collections_by_zone",
    label: "Collections by zone",
    description: "Revenue, scans and compliance per zone.",
  },
  {
    key: "collections_by_asset_type",
    label: "Collections by asset type",
    description: "Revenue, asset counts and scans per asset type.",
  },
  {
    key: "collector_positions",
    label: "Collector positions",
    description: "Intakes, posted deposits, derived float and overdue intakes.",
  },
  {
    key: "compliance",
    label: "Compliance rate",
    description: "Paid and no-payment scans per day, zone and officer; unknown is excluded.",
  },
  {
    key: "exceptions_summary",
    label: "Exceptions summary",
    description: "Open, resolved and waived exceptions by day, kind and severity.",
  },
];

export function reportLabel(key: ReportKey): string {
  return REPORT_OPTIONS.find((option) => option.key === key)?.label ?? key;
}

/** One column as the report route declares it. */
export interface ReportColumnView {
  readonly key: string;
  readonly header: string;
  readonly kind: "money" | "count" | "text";
}

/** A rendered report (`GET /v1/reports/{key}`). */
export interface ReportView {
  readonly reportKey: string;
  readonly from: string;
  readonly to: string;
  readonly generatedAt: string;
  readonly columns: readonly ReportColumnView[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly totals: Readonly<Record<string, string>>;
}

export interface ReportQueryParams {
  readonly from: string;
  readonly to: string;
}

/**
 * The range the reports screen opens on: the last seven business days, the same
 * default as the reconciliation list. A range is always explicit because the
 * route requires both bounds.
 */
export function defaultReportRange(today: Date): BusinessDateRange {
  return lastBusinessDays(today, 7);
}

export function reportQueryParams(from: string, to: string): ReportQueryParams {
  return { from: from.trim(), to: to.trim() };
}

export interface ExportQueryParams {
  readonly from: string;
  readonly to: string;
  readonly format: ExportFormat;
}

export function exportQueryParams(
  from: string,
  to: string,
  format: ExportFormat,
): ExportQueryParams {
  return { from: from.trim(), to: to.trim(), format };
}

/**
 * The filename to save an export under.
 *
 * The server names the attachment and the route sets `content-disposition`, so
 * that name wins whenever it is parseable; the fallback keeps the same shape so
 * a proxy that strips the header still produces a recognisable file.
 */
export function exportFilename(
  reportKey: string,
  from: string,
  to: string,
  format: ExportFormat,
  contentDisposition?: string | null,
): string {
  const fallback = `${reportKey}-${from}-${to}.${format}`;
  if (contentDisposition === undefined || contentDisposition === null) return fallback;
  const header = contentDisposition.trim();
  if (header === "") return fallback;

  // RFC 5987 form: filename*=UTF-8''name.csv
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (encoded !== null) {
    const raw = (encoded[1] ?? "").trim().replace(/^"|"$/g, "");
    if (raw !== "") {
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }

  // Plain form: filename="name.csv" (quotes optional).
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  const name = (plain?.[1] ?? "").trim();
  return name === "" ? fallback : name;
}

function cellText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}`;
  }
  return "—";
}

/**
 * Formats one cell by the column's declared kind: money through the tenant's
 * currency formatting, counts as plain digits (a count is not money and must
 * not gain a currency symbol), text verbatim, and a null/absent value as an
 * em dash so a gap is visible instead of reading as zero.
 */
export function formatReportCell(
  column: ReportColumnView,
  value: unknown,
  currency: string,
  numberFormat: string,
): string {
  if (value === null || value === undefined) return "—";
  switch (column.kind) {
    case "money":
      return typeof value === "string" || typeof value === "number"
        ? formatMoneyMinor(value, currency, numberFormat)
        : cellText(value);
    case "count":
      return typeof value === "number" ? `${value}` : cellText(value);
    case "text":
      return cellText(value);
  }
}

export interface ReportDownloadRequest {
  /** The contract key; typed as a string so a new server key needs no client release. */
  readonly reportKey: string;
  readonly from: string;
  readonly to: string;
  readonly format: ExportFormat;
  readonly token: string | undefined;
}

export interface DownloadDependencies {
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to an anchor click with an object URL. */
  readonly saveBlob?: (blob: Blob, filename: string) => void;
}

/**
 * Requests an export and saves it.
 *
 * The generated client parses JSON, and an export is a file, so this uses
 * `fetch` directly with the in-memory bearer token. The filename comes from
 * `content-disposition` (falling back to the deterministic helper), which is
 * what the user sees in their downloads folder.
 *
 * @returns the filename the file was saved as.
 */
export async function downloadReport(
  request: ReportDownloadRequest,
  dependencies: DownloadDependencies = {},
): Promise<string> {
  const query = new URLSearchParams([
    ["from", request.from.trim()],
    ["to", request.to.trim()],
    ["format", request.format],
  ]).toString();
  const path = `/v1/reports/${encodeURIComponent(request.reportKey)}/export?${query}`;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const response = await fetchImpl(path, {
    method: "GET",
    headers:
      request.token === undefined || request.token === ""
        ? {}
        : { authorization: `Bearer ${request.token}` },
  });
  if (!response.ok) {
    throw new Error(`Export failed with status ${response.status}`);
  }
  const filename = exportFilename(
    request.reportKey,
    request.from,
    request.to,
    request.format,
    response.headers.get("content-disposition"),
  );
  const blob = await response.blob();
  (dependencies.saveBlob ?? saveBlobInBrowser)(blob, filename);
  return filename;
}

/**
 * Saves a blob through a temporary anchor.
 *
 * jsdom has no `URL.createObjectURL`, so the object URL is best-effort: when it
 * cannot be created the anchor still carries the download filename, which is
 * what the page test asserts.
 */
function saveBlobInBrowser(blob: Blob, filename: string): void {
  let objectUrl = "";
  try {
    objectUrl = URL.createObjectURL(blob);
  } catch {
    objectUrl = "";
  }
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  if (objectUrl !== "") {
    try {
      URL.revokeObjectURL(objectUrl);
    } catch {
      // The URL is already unusable; nothing to revoke.
    }
  }
}
