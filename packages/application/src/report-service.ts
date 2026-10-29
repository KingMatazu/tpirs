import { assertPermission, businessDate, businessDayRange } from "@tpirs/domain";
import type { Permission, Principal } from "@tpirs/domain";
import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import type { ExportColumn, ExportFormat, ExportService } from "@tpirs/ports";

/**
 * Finance reports and their exports (D49, phase 8).
 *
 * Reports read the operational tables through `ReportRepository` — there is no
 * reporting projector and no second source of truth. Under `pay_per_use` the
 * compliance rate comes from scans (paid over decided scans), never from paid
 * days over registered assets, because an idle vehicle legitimately owes
 * nothing. Money leaves every row as a string of exact minor units, so no
 * amount is ever rounded on the way to a screen or a CSV.
 */

export type ReportKey =
  | "daily_collections"
  | "collections_by_zone"
  | "collections_by_asset_type"
  | "collector_positions"
  | "compliance"
  | "exceptions_summary";

export const REPORT_KEYS: readonly ReportKey[] = [
  "daily_collections",
  "collections_by_zone",
  "collections_by_asset_type",
  "collector_positions",
  "compliance",
  "exceptions_summary",
];

/** The longest range one report call may cover. */
export const MAX_REPORT_DAYS = 31;

/** Exported rows above this are refused rather than silently truncated. */
export const MAX_REPORT_ROWS = 100_000;

export type ReportErrorCode =
  | "unknown_report"
  | "invalid_range"
  | "range_too_large"
  | "result_too_large"
  | "format_unavailable";

export class ReportError extends Error {
  readonly code: ReportErrorCode;

  constructor(code: ReportErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ReportError";
  }
}

export interface ReportColumn extends ExportColumn {
  /** Money columns are summed into `totals` (as minor-unit strings). */
  readonly kind: "money" | "count" | "text";
}

export interface ReportOutput {
  readonly reportKey: ReportKey;
  readonly from: string;
  readonly to: string;
  readonly generatedAt: Date;
  readonly columns: readonly ReportColumn[];
  /** Money values are strings of minor units; counts and dates are plain. */
  readonly rows: readonly Record<string, string | number | null>[];
  readonly totals: Readonly<Record<string, string>>;
}

export interface ReportInput {
  readonly tenantId: string;
  readonly actor: Principal;
  readonly from: string;
  readonly to: string;
  /** Needed only by `daily_collections`, to bucket ledger postings by day. */
  readonly timeZone?: string;
}

export interface ReportExportInput extends ReportInput {
  readonly reportKey: ReportKey;
  readonly format: ExportFormat;
  readonly filenameBase: string;
}

type Repositories = ReturnType<typeof repositories>;
type InjectedRepos = Repositories;

interface Range {
  readonly tenantId: string;
  readonly from: string;
  readonly to: string;
  /** UTC instants of the range, for timestamped evidence (deposits, cutoffs). */
  readonly start: Date;
  readonly endExclusive: Date;
  readonly now: Date;
  readonly timeZone: string;
}

interface ReportDefinition {
  readonly columns: readonly ReportColumn[];
  run(
    repos: InjectedRepos,
    range: Range,
  ): Promise<readonly Record<string, string | number | null>[]>;
  /** Money columns summed over all rows; omitted when nothing sensible adds up. */
  readonly totalColumns?: readonly string[];
}

const MONEY = (key: string): ReportColumn => ({ key, header: key, kind: "money" });
const COUNT = (key: string): ReportColumn => ({ key, header: key, kind: "count" });
const TEXT = (key: string): ReportColumn => ({ key, header: key, kind: "text" });

const DEFINITIONS: Readonly<Record<ReportKey, ReportDefinition>> = {
  daily_collections: {
    columns: [
      TEXT("businessDate"),
      MONEY("revenueMinor"),
      COUNT("paymentsCount"),
      MONEY("paymentsTotalMinor"),
      COUNT("cashIntakeCount"),
      MONEY("cashIntakeTotalMinor"),
      MONEY("refundsMinor"),
    ],
    totalColumns: ["revenueMinor", "paymentsTotalMinor", "cashIntakeTotalMinor", "refundsMinor"],
    run: (repos, range) =>
      repos.reports
        .dailyCollections(range.tenantId, range.timeZone, range.from, range.to)
        .then((rows) =>
          rows.map((row) => ({
            businessDate: row.businessDate,
            revenueMinor: row.revenueMinor.toString(),
            paymentsCount: row.paymentsCount,
            paymentsTotalMinor: row.paymentsTotalMinor.toString(),
            cashIntakeCount: row.cashIntakeCount,
            cashIntakeTotalMinor: row.cashIntakeTotalMinor.toString(),
            refundsMinor: row.refundsMinor.toString(),
          })),
        ),
  },
  collections_by_zone: {
    columns: [
      TEXT("zoneId"),
      TEXT("zoneName"),
      MONEY("revenueMinor"),
      COUNT("scansCount"),
      COUNT("paidScans"),
      COUNT("notPaidScans"),
      COUNT("unknownScans"),
    ],
    totalColumns: ["revenueMinor"],
    run: (repos, range) =>
      repos.reports.collectionsByZone(range.tenantId, range.from, range.to).then((rows) =>
        rows.map((row) => ({
          zoneId: row.zoneId,
          zoneName: row.zoneName,
          revenueMinor: row.revenueMinor.toString(),
          scansCount: row.scansCount,
          paidScans: row.paidScans,
          notPaidScans: row.notPaidScans,
          unknownScans: row.unknownScans,
        })),
      ),
  },
  collections_by_asset_type: {
    columns: [
      TEXT("assetTypeKey"),
      MONEY("revenueMinor"),
      COUNT("activeAssets"),
      COUNT("suspendedAssets"),
      COUNT("retiredAssets"),
      COUNT("scansCount"),
    ],
    totalColumns: ["revenueMinor"],
    run: (repos, range) =>
      repos.reports.collectionsByAssetType(range.tenantId, range.from, range.to).then((rows) =>
        rows.map((row) => ({
          assetTypeKey: row.assetTypeKey,
          revenueMinor: row.revenueMinor.toString(),
          activeAssets: row.activeAssets,
          suspendedAssets: row.suspendedAssets,
          retiredAssets: row.retiredAssets,
          scansCount: row.scansCount,
        })),
      ),
  },
  collector_positions: {
    columns: [
      TEXT("collectorUserId"),
      COUNT("intakeCount"),
      MONEY("intakeTotalMinor"),
      MONEY("postedDepositTotalMinor"),
      MONEY("floatMinor"),
      COUNT("overdueOpenIntakes"),
    ],
    totalColumns: ["intakeTotalMinor", "postedDepositTotalMinor", "floatMinor"],
    run: async (repos, range) => {
      const rows = await repos.reports.collectorPositions(
        range.tenantId,
        range.from,
        range.to,
        range.start,
        range.endExclusive,
        range.now,
      );
      return rows.map((row) => ({
        collectorUserId: row.collectorUserId,
        intakeCount: row.intakeCount,
        intakeTotalMinor: row.intakeTotalMinor.toString(),
        postedDepositTotalMinor: row.postedDepositTotalMinor.toString(),
        floatMinor: row.floatMinor.toString(),
        overdueOpenIntakes: row.overdueOpenIntakes,
      }));
    },
  },
  compliance: {
    columns: [
      TEXT("businessDate"),
      TEXT("zoneId"),
      TEXT("zoneName"),
      TEXT("officerUserId"),
      COUNT("paidScans"),
      COUNT("notPaidScans"),
      COUNT("unknownScans"),
      COUNT("compliancePercent"),
    ],
    run: (repos, range) =>
      repos.reports.compliance(range.tenantId, range.from, range.to).then((rows) =>
        rows.map((row) => {
          // The rate is paid over *decided* scans: an `unknown` scan (an
          // offline check, an aged cache) carries no verdict and must not
          // dilute the rate.
          const decided = row.paidScans + row.notPaidScans;
          const rate = decided === 0 ? null : Math.round((row.paidScans / decided) * 100);
          return {
            businessDate: row.businessDate,
            zoneId: row.zoneId,
            zoneName: row.zoneName,
            officerUserId: row.officerUserId,
            paidScans: row.paidScans,
            notPaidScans: row.notPaidScans,
            unknownScans: row.unknownScans,
            compliancePercent: rate,
          };
        }),
      ),
  },
  exceptions_summary: {
    columns: [TEXT("businessDate"), TEXT("kind"), TEXT("severity"), TEXT("status"), COUNT("count")],
    run: (repos, range) =>
      repos.reports.exceptionsSummary(range.tenantId, range.from, range.to).then((rows) =>
        rows.map((row) => ({
          businessDate: row.businessDate,
          kind: row.kind,
          severity: row.severity,
          status: row.status,
          count: row.count,
        })),
      ),
  },
};

export class ReportService {
  constructor(
    private readonly deps: {
      readonly db: AnyDb;
      /** One exporter per supported format; a missing key refuses that format. */
      readonly exporters: Partial<Record<ExportFormat, ExportService>>;
      readonly now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private resolveRange(input: ReportInput, timeZone: string): Range {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from) || !/^\d{4}-\d{2}-\d{2}$/.test(input.to)) {
      throw new ReportError("invalid_range", "from and to must be YYYY-MM-DD business dates");
    }
    const from = businessDate(input.from);
    const to = businessDate(input.to);
    if (from > to) {
      throw new ReportError("invalid_range", `from ${from} is after to ${to}`);
    }
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
    if (days > MAX_REPORT_DAYS) {
      throw new ReportError(
        "range_too_large",
        `A report covers at most ${MAX_REPORT_DAYS} days, not ${days}`,
      );
    }
    return {
      tenantId: input.tenantId,
      from,
      to,
      start: businessDayRange(timeZone, from).start,
      endExclusive: businessDayRange(timeZone, to).endExclusive,
      now: this.now(),
      timeZone,
    };
  }

  /** Reads one report inside a tenant transaction. */
  async run(input: ReportInput, reportKey: ReportKey): Promise<ReportOutput> {
    assertPermission(input.actor, "report:read" satisfies Permission);
    if (!REPORT_KEYS.includes(reportKey)) {
      throw new ReportError("unknown_report", `Unknown report "${reportKey}"`);
    }
    const definition = DEFINITIONS[reportKey];
    const timeZone = input.timeZone ?? "UTC";
    const range = this.resolveRange(input, timeZone);

    const rows = await withTenant(this.deps.db, input.tenantId, async (tx) =>
      definition.run(repositories(tx), range),
    );
    if (rows.length > MAX_REPORT_ROWS) {
      throw new ReportError("result_too_large", `Report produced ${rows.length} rows`);
    }

    const totals: Record<string, string> = {};
    for (const column of definition.totalColumns ?? []) {
      totals[column] = rows
        .reduce((sum, row) => sum + BigInt(typeof row[column] === "string" ? row[column] : 0), 0n)
        .toString();
    }

    return {
      reportKey,
      from: range.from,
      to: range.to,
      generatedAt: this.now(),
      columns: definition.columns,
      rows,
      totals,
    };
  }

  /**
   * Renders one report through the configured exporter for the format.
   *
   * Exporters are injected per format, so a deployment without, say, a PDF
   * engine refuses `pdf` explicitly instead of failing inside an adapter.
   */
  async exportReport(input: ReportExportInput): Promise<{
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly filename: string;
    readonly rowCount: number;
  }> {
    const exporter = this.deps.exporters[input.format];
    if (exporter === undefined) {
      throw new ReportError("format_unavailable", `No exporter configured for "${input.format}"`);
    }
    const output = await this.run(input, input.reportKey);
    const result = await exporter.export({
      format: input.format,
      columns: output.columns.map((column) => ({ key: column.key, header: column.header })),
      rows: output.rows,
      filenameBase: input.filenameBase,
    });
    return {
      bytes: result.bytes,
      contentType: result.contentType,
      filename: result.filename,
      rowCount: output.rows.length,
    };
  }
}

// --------------------------------------------------------------------------
// Type-level helpers used by the definitions above.
// --------------------------------------------------------------------------

/** The repositories type an injected definition receives. */
export type { Repositories as ReportRepositories };
