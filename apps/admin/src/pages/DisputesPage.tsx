import { Fragment, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatBusinessDate, formatTimestamp } from "@tpirs/ui-tokens";
import { api } from "../api/client.js";
import { unwrap } from "../api/unwrap.js";
import { Badge, Card, EmptyState, Field, ReadOnlyNote } from "../components/ui.js";
import {
  DISPUTE_PAGE_SIZE,
  DISPUTE_STATUS_OPTIONS,
  disputeDetailRows,
  disputeQueryParams,
  disputeStatusLabel,
  disputeStatusTone,
  toDisputeView,
  type DisputeQueryParams,
  type DisputeView,
} from "../lib/disputesView.js";
import { useTenantConfig } from "../lib/tenantConfig.js";
import { useSession } from "../session.js";

/**
 * Step 4: the disputes inbox.
 *
 * Read-only on purpose. A dispute is opened by an officer in the field, with a
 * reason, a description and any evidence the phone could capture; the dashboard
 * is where finance reads it. Resolution stays out of scope until the policy for
 * who may resolve a dispute, and which evidence it requires, is recorded, so
 * the screen says that instead of offering a button that would 404.
 *
 * The rows are dynamic objects on the wire, so they are narrowed once through
 * `toDisputeView`; a field added later cannot break the table. Only
 * `dispute:read` is needed — an auditor sees exactly what finance sees.
 */
export function DisputesPage(): ReactElement {
  const canRead = useSession((state) => state.hasPermission("dispute:read"));
  const { config } = useTenantConfig();

  const [status, setStatus] = useState("");
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  const disputes = useQuery({
    queryKey: ["disputes", status],
    queryFn: async () =>
      await fetchDisputes(disputeQueryParams({ status, limit: DISPUTE_PAGE_SIZE })),
    enabled: canRead,
  });
  const detail = useQuery({
    queryKey: ["dispute", selectedId],
    queryFn: async () => {
      if (selectedId === undefined) throw new Error("no dispute selected");
      return await fetchDispute(selectedId);
    },
    enabled: canRead && selectedId !== undefined,
  });

  if (!canRead) {
    return <p className="text-sm text-slate-600">You do not have permission to view disputes.</p>;
  }

  const locale = config?.config.locale;
  const numberFormat = locale?.numberFormat ?? "en";
  const dateFormat = locale?.dateFormat ?? "yyyy-MM-dd";
  const timezone = locale?.timezone ?? "UTC";
  const rows = disputes.data?.rows ?? [];
  const hasMore = disputes.data?.hasMore ?? false;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Disputes</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Disputes raised from the field: what the officer saw, when, and where. The record is
          append-only and never changes the ledger on its own.
        </p>
      </div>

      <ReadOnlyNote>
        Read-only inbox: a dispute can be read but not resolved from the dashboard yet. The policy
        for who may resolve one, and which evidence it needs, is still being recorded.
      </ReadOnlyNote>

      <Card
        title="Dispute inbox"
        description="Newest first. Select a dispute to read its description and evidence references."
      >
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="Status">
            <select
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              value={status}
              onChange={(event) => {
                setStatus(event.currentTarget.value);
              }}
            >
              {DISPUTE_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {disputes.error !== null ? (
          <p className="text-sm text-red-600">The dispute inbox could not be loaded.</p>
        ) : null}
        {disputes.isLoading ? <p className="text-sm text-slate-500">Loading disputes…</p> : null}
        {!disputes.isLoading && rows.length === 0 ? (
          <EmptyState message="No disputes match these filters." />
        ) : null}

        {rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 pr-4 font-medium">Business day</th>
                  <th className="py-2 pr-4 font-medium">Asset</th>
                  <th className="py-2 pr-4 font-medium">Reason</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Zone</th>
                  <th className="py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((dispute) => (
                  <tr key={dispute.id} className="border-b border-slate-100">
                    <td className="py-2 pr-4 text-slate-700">
                      {businessDay(dispute.businessDate, numberFormat, dateFormat)}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-slate-700">
                      {dispute.assetId}
                    </td>
                    <td className="py-2 pr-4 text-slate-700">{dispute.reason}</td>
                    <td className="py-2 pr-4">
                      <Badge tone={disputeStatusTone(dispute.status)}>
                        {disputeStatusLabel(dispute.status)}
                      </Badge>
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-slate-500">
                      {dispute.zoneId ?? "—"}
                    </td>
                    <td className="py-2">
                      {/* "View", not "Open": "Open" is also a dispute status, and
                          two identical labels on one row would be ambiguous. */}
                      <button
                        type="button"
                        className="cursor-pointer text-xs underline"
                        onClick={() => {
                          setSelectedId(dispute.id);
                        }}
                      >
                        {selectedId === dispute.id ? "Selected" : "View"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {hasMore ? (
          <p className="mt-3 text-xs text-slate-500">
            Showing the first {DISPUTE_PAGE_SIZE} disputes. Narrow the status filter to see more.
          </p>
        ) : null}
      </Card>

      {selectedId === undefined ? null : detail.isLoading ? (
        <p className="text-sm text-slate-500">Loading dispute…</p>
      ) : detail.error !== null || detail.data === undefined ? (
        <p className="text-sm text-red-600">This dispute could not be loaded.</p>
      ) : (
        <DisputeDetail
          dispute={detail.data}
          numberFormat={numberFormat}
          dateFormat={dateFormat}
          timezone={timezone}
        />
      )}
    </div>
  );
}

async function fetchDisputes(
  query: DisputeQueryParams,
): Promise<{ readonly rows: readonly DisputeView[]; readonly hasMore: boolean }> {
  const data = await unwrap(api.GET("/v1/disputes", { params: { query } }));
  return { rows: data.disputes.map(toDisputeView), hasMore: data.hasMore };
}

async function fetchDispute(id: string): Promise<DisputeView> {
  const data = await unwrap(api.GET("/v1/disputes/{id}", { params: { path: { id } } }));
  return toDisputeView(data.dispute);
}

/** A `YYYY-MM-DD` business day in the tenant's configured date format. */
function businessDay(businessDate: string, numberFormat: string, pattern: string): string {
  return businessDate === ""
    ? "—"
    : formatBusinessDate(`${businessDate}T00:00:00.000Z`, numberFormat, pattern);
}

function DisputeDetail(props: {
  readonly dispute: DisputeView;
  readonly numberFormat: string;
  readonly dateFormat: string;
  readonly timezone: string;
}): ReactElement {
  const { dispute } = props;
  const rows = disputeDetailRows(dispute, {
    timestamp: (iso) => formatTimestamp(iso, props.numberFormat, props.timezone),
    businessDate: (date) => businessDay(date, props.numberFormat, props.dateFormat),
  });

  return (
    <Card
      title="Dispute"
      description={`${disputeStatusLabel(dispute.status)} · opened by ${dispute.openedByUserId}`}
    >
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        {rows.map((row) => (
          <Fragment key={row.label}>
            <dt className="text-slate-500">{row.label}</dt>
            <dd className="text-slate-900">{row.value}</dd>
          </Fragment>
        ))}
      </dl>

      {dispute.evidence.length === 0 ? null : (
        <div className="mt-3">
          <p className="text-xs font-semibold text-slate-600">Evidence</p>
          <ul className="mt-1 space-y-1 font-mono text-xs text-slate-600">
            {dispute.evidence.map((item) => (
              <li key={item.objectKey}>
                {item.objectKey}
                {item.contentType === "" ? "" : ` · ${item.contentType}`}
                {item.createdAt === ""
                  ? ""
                  : ` · ${formatTimestamp(item.createdAt, props.numberFormat, props.timezone)}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-3 text-xs text-slate-500">
        Resolution is not available from the dashboard yet; the decision and its reason will be
        recorded once the policy is set.
      </p>
    </Card>
  );
}
