import { useState, type FormEvent, type ReactElement } from "react";
import { formatTimestamp } from "@tpirs/ui-tokens";
import { api } from "../api/client.js";
import { unwrap } from "../api/unwrap.js";
import { useCursorFeed } from "../lib/cursor.js";
import { useTenantConfig } from "../lib/tenantConfig.js";
import { Button, Card, EmptyState, TextInput } from "../components/ui.js";
import { useSession } from "../session.js";

const PAGE_SIZE = 50;

export interface AuditFilters {
  readonly actor?: string;
  readonly kind?: string;
  readonly action?: string;
  readonly from?: string;
  readonly to?: string;
}

/** Shape of the GET /v1/audit querystring (all string-typed at the HTTP layer). */
export interface AuditQueryParams {
  readonly limit: string;
  readonly cursor?: string;
  readonly action?: string;
  readonly kind?: string;
  readonly actor?: string;
  readonly from?: string;
  readonly to?: string;
}

function present(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/** Maps filters + cursor to the audit querystring; empty values are omitted. */
export function auditQueryParams(
  filters: AuditFilters,
  cursor: string | undefined,
  limit: number,
): AuditQueryParams {
  return {
    limit: String(limit),
    ...(cursor === undefined ? {} : { cursor }),
    ...(present(filters.actor) ? { actor: filters.actor } : {}),
    ...(present(filters.kind) ? { kind: filters.kind } : {}),
    ...(present(filters.action) ? { action: filters.action } : {}),
    ...(present(filters.from) ? { from: filters.from } : {}),
    ...(present(filters.to) ? { to: filters.to } : {}),
  };
}

interface AuditEntryRow {
  readonly id: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly actorUserId: string | null;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly requestId: string | null;
  readonly ip: string | null;
  readonly createdAt: string;
}

/**
 * Step 6: searchable audit trail. Read-only by construction — the repository
 * and the database both reject update/delete. Rows expand to the before/after
 * snapshots the audited handlers recorded. Timestamps render in the tenant
 * timezone via the same ui-tokens helpers used everywhere else.
 */
export function AuditPage(): ReactElement {
  const canRead = useSession((state) => state.hasPermission("audit:read"));
  const [filters, setFilters] = useState<AuditFilters>({});
  const [applied, setApplied] = useState<AuditFilters>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const { config: tenantPayload } = useTenantConfig();

  const feed = useCursorFeed<AuditEntryRow>({
    queryKey: ["audit", applied],
    fetchPage: async (cursor) => {
      const data = await unwrap(
        api.GET("/v1/audit", { params: { query: auditQueryParams(applied, cursor, PAGE_SIZE) } }),
      );
      return { rows: data.entries, nextCursor: data.nextCursor };
    },
  });

  if (!canRead) {
    return <p className="text-sm text-slate-600">You do not have permission to view the audit trail.</p>;
  }

  const locale = tenantPayload?.config.locale;
  const renderTime = (iso: string): string =>
    locale === undefined
      ? iso
      : formatTimestamp(iso, locale.numberFormat, locale.timezone);

  const apply = (): void => {
    setApplied({ ...filters });
    setExpanded(new Set());
  };

  const toggle = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Audit trail</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Append-only record of every state-changing request. Rows cannot be edited or deleted.
        </p>
      </div>

      <Card title="Filters">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            apply();
          }}
        >
          <TextInput
            name="actor"
            value={filters.actor ?? ""}
            onValueChange={(actor) => { setFilters({ ...filters, actor }); }}
            placeholder="Actor user id"
          />
          <TextInput
            name="kind"
            value={filters.kind ?? ""}
            onValueChange={(kind) => { setFilters({ ...filters, kind }); }}
            placeholder="Kind (e.g. asset, payment)"
          />
          <TextInput
            name="action"
            value={filters.action ?? ""}
            onValueChange={(action) => { setFilters({ ...filters, action }); }}
            placeholder="Action (exact, e.g. asset.register)"
          />
          <TextInput
            name="from"
            value={filters.from ?? ""}
            onValueChange={(from) => { setFilters({ ...filters, from }); }}
            type="date"
          />
          <TextInput
            name="to"
            value={filters.to ?? ""}
            onValueChange={(to) => { setFilters({ ...filters, to }); }}
            type="date"
          />
          <Button type="submit">Apply</Button>
        </form>
      </Card>

      {feed.error !== null ? (
        <p className="text-sm text-red-600">
          Audit listing failed; the error details are in the notification.
        </p>
      ) : null}
      {feed.isLoading ? <p className="text-sm text-slate-500">Loading audit entries…</p> : null}
      {feed.rows.length === 0 && !feed.isLoading ? (
        <EmptyState message="No audit entries match these filters." />
      ) : null}

      {feed.rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2 pr-4 font-medium">When</th>
                <th className="py-2 pr-4 font-medium">Action</th>
                <th className="py-2 pr-4 font-medium">Kind</th>
                <th className="py-2 pr-4 font-medium">Entity</th>
                <th className="py-2 pr-4 font-medium">Actor</th>
                <th className="py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {feed.rows.map((entry) => (
                <AuditRow
                  key={entry.id}
                  entry={entry}
                  displayTime={renderTime(entry.createdAt)}
                  expanded={expanded.has(entry.id)}
                  onToggle={toggle}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {feed.hasMore ? (
        <Button type="button" variant="ghost" onClick={feed.loadMore}>
          Load more
        </Button>
      ) : null}
    </div>
  );
}

function AuditRow(props: {
  readonly entry: AuditEntryRow;
  readonly displayTime: string;
  readonly expanded: boolean;
  readonly onToggle: (id: string) => void;
}): ReactElement {
  const { entry } = props;
  return (
    <>
      <tr className="border-b border-slate-100">
        <td className="py-2 pr-4 text-slate-600">{props.displayTime}</td>
        <td className="py-2 pr-4 font-mono text-xs text-slate-900">{entry.action}</td>
        <td className="py-2 pr-4 text-slate-700">{entry.entityType}</td>
        <td className="py-2 pr-4 font-mono text-xs text-slate-500">{entry.entityId ?? "—"}</td>
        <td className="py-2 pr-4 font-mono text-xs text-slate-500">{entry.actorUserId ?? "system"}</td>
        <td className="py-2">
          <button
            type="button"
            className="cursor-pointer text-xs underline"
            onClick={() => { props.onToggle(entry.id); }}
          >
            {props.expanded ? "Hide" : "Details"}
          </button>
        </td>
      </tr>
      {props.expanded ? (
        <tr className="border-b border-slate-100 bg-slate-50">
          <td colSpan={6} className="px-2 py-3">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
              <dt className="text-slate-500">Request id</dt>
              <dd className="font-mono">{entry.requestId ?? "—"}</dd>
              <dt className="text-slate-500">IP</dt>
              <dd className="font-mono">{entry.ip ?? "—"}</dd>
            </dl>
            <div className="mt-2 grid grid-cols-2 gap-4">
              <SnapshotViewer title="Before" value={entry.before} />
              <SnapshotViewer title="After" value={entry.after} />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function SnapshotViewer(props: {
  readonly title: string;
  readonly value: Record<string, unknown> | null;
}): ReactElement {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-slate-600">{props.title}</p>
      {props.value === null ? (
        <p className="text-xs text-slate-400">none</p>
      ) : (
        <pre className="max-h-56 overflow-auto rounded border border-slate-200 bg-white p-2 text-[11px] leading-tight">
          {JSON.stringify(props.value, null, 2)}
        </pre>
      )}
    </div>
  );
}
