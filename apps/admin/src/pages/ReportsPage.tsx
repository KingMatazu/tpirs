import { useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatTimestamp } from "@tpirs/ui-tokens";
import { api } from "../api/client.js";
import { unwrap } from "../api/unwrap.js";
import { Button, Card, EmptyState, Field, TextInput } from "../components/ui.js";
import {
  EXPORT_FORMATS,
  REPORT_OPTIONS,
  defaultReportRange,
  downloadReport,
  formatReportCell,
  reportQueryParams,
  type ExportFormat,
  type ReportKey,
  type ReportView,
} from "../lib/reportsView.js";
import { useTenantConfig } from "../lib/tenantConfig.js";
import { describeError, pushToast } from "../toast.js";
import { useSession } from "../session.js";

/**
 * Step 8: the reports screen.
 *
 * The report catalogue is the server's: `GET /v1/reports/{key}` returns the
 * columns (key, header, kind) and the rows, so this page renders whatever the
 * report service declares instead of duplicating six table layouts. Money is a
 * minor-unit string and is formatted with the tenant's currency; counts stay
 * bare digits.
 *
 * Exports bypass the generated client on purpose — it parses JSON and an export
 * is a file. `downloadReport` calls `fetch` with the in-memory bearer and saves
 * the bytes under the filename the server put in `content-disposition`.
 */
export function ReportsPage(): ReactElement {
  const canRead = useSession((state) => state.hasPermission("report:read"));
  const { config } = useTenantConfig();
  const [reportKey, setReportKey] = useState<ReportKey>("daily_collections");
  const [range, setRange] = useState(() => defaultReportRange(new Date()));
  const [busyFormat, setBusyFormat] = useState<ExportFormat | undefined>(undefined);

  const report = useQuery({
    queryKey: ["report", reportKey, range],
    queryFn: async () => await fetchReport(reportKey, reportQueryParams(range.from, range.to)),
    enabled: canRead && range.from !== "" && range.to !== "",
  });

  if (!canRead) {
    return <p className="text-sm text-slate-600">You do not have permission to view reports.</p>;
  }

  const locale = config?.config.locale;
  const currency = locale?.currency ?? "";
  const numberFormat = locale?.numberFormat ?? "en";
  const timezone = locale?.timezone ?? "UTC";
  const selected = REPORT_OPTIONS.find((option) => option.key === reportKey);
  const data = report.data;
  const totalKeys = data === undefined ? [] : Object.keys(data.totals);

  const download = async (format: ExportFormat): Promise<void> => {
    setBusyFormat(format);
    try {
      const filename = await downloadReport({
        reportKey,
        from: range.from,
        to: range.to,
        format,
        token: useSession.getState().accessToken,
      });
      pushToast({ kind: "success", message: `Downloaded ${filename}.` });
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusyFormat(undefined);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Reports</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Reports aggregate the existing payments, ledger, cash and scan tables over a business-day
          range. Compliance is paid scans divided by decided scans; unknown scans are shown but
          never allowed to depress the rate.
        </p>
      </div>

      <Card
        title="Report"
        {...(selected === undefined ? {} : { description: selected.description })}
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Report">
            <select
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              value={reportKey}
              onChange={(event) => {
                setReportKey(event.currentTarget.value as ReportKey);
              }}
            >
              {REPORT_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="From">
            <TextInput
              type="date"
              name="from"
              value={range.from}
              onValueChange={(from) => {
                setRange((current) => ({ ...current, from }));
              }}
            />
          </Field>
          <Field label="To">
            <TextInput
              type="date"
              name="to"
              value={range.to}
              onValueChange={(to) => {
                setRange((current) => ({ ...current, to }));
              }}
            />
          </Field>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {EXPORT_FORMATS.map((format) => (
            <Button
              key={format}
              variant="ghost"
              disabled={busyFormat !== undefined}
              onClick={() => {
                void download(format);
              }}
            >
              {busyFormat === format ? "Preparing…" : `Download ${format.toUpperCase()}`}
            </Button>
          ))}
        </div>
      </Card>

      {report.error !== null ? (
        <p className="text-sm text-red-600">The report could not be generated.</p>
      ) : null}
      {report.isLoading ? <p className="text-sm text-slate-500">Loading report…</p> : null}

      {data === undefined ? null : (
        <Card
          title={selected?.label ?? reportKey}
          description={`${data.from} to ${data.to} · generated ${formatTimestamp(
            data.generatedAt,
            numberFormat,
            timezone,
          )}`}
        >
          {data.rows.length === 0 ? (
            <EmptyState message="No rows in this range." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    {data.columns.map((column) => (
                      <th key={column.key} className="py-2 pr-4 font-medium">
                        {column.header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, index) => (
                    <tr key={`${reportKey}-${index}`} className="border-b border-slate-100">
                      {data.columns.map((column) => (
                        <td key={column.key} className="py-2 pr-4 text-slate-700">
                          {formatReportCell(column, row[column.key], currency, numberFormat)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {totalKeys.length > 0 ? (
                  <tfoot>
                    <tr className="border-t border-slate-300 font-medium">
                      {data.columns.map((column, index) => (
                        <td key={column.key} className="py-2 pr-4 text-slate-900">
                          {totalKeys.includes(column.key)
                            ? formatReportCell(
                                column,
                                data.totals[column.key],
                                currency,
                                numberFormat,
                              )
                            : index === 0
                              ? "Total"
                              : ""}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

async function fetchReport(
  key: ReportKey,
  query: { readonly from: string; readonly to: string },
): Promise<ReportView> {
  const data = await unwrap(api.GET("/v1/reports/{key}", { params: { path: { key }, query } }));
  return data.report;
}
