import { useState, type FormEvent, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatBusinessDate, formatMoneyMinor, formatTimestamp } from "@tpirs/ui-tokens";
import { api } from "../api/client.js";
import { unwrap } from "../api/unwrap.js";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  ReadOnlyNote,
  TextInput,
} from "../components/ui.js";
import {
  EXCEPTION_SEVERITY_OPTIONS,
  EXCEPTION_STATUS_OPTIONS,
  checklistItemLabel,
  checklistSummary,
  defaultReconciliationRange,
  describeExceptionSubject,
  exceptionQueryParams,
  exceptionStatusLabel,
  exceptionStatusTone,
  reconciliationQueryParams,
  resolutionBody,
  runStatusLabel,
  runStatusTone,
  severityLabel,
  severityTone,
  signOffBody,
  toleranceLabel,
  type ChecklistItemView,
  type ReconciliationExceptionView,
  type ReconciliationRunView,
} from "../lib/reconciliationView.js";
import { useTenantConfig } from "../lib/tenantConfig.js";
import { describeError, pushToast } from "../toast.js";
import { useSession } from "../session.js";

const RUN_STATUS_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "signed_off", label: "Signed off" },
];

/**
 * Step 8: the reconciliation screen.
 *
 * Two jobs, because they are one workflow: read the day's run (checklist and
 * tolerances) and clear the exception queue before signing it off. Sign-off and
 * resolution both require `reconciliation:run` and a note; an auditor holds
 * only `reconciliation:read` and therefore sees the same data with no mutation
 * controls at all — the server enforces the same rule, this only hides what
 * would 403.
 *
 * A run is append-only: signing off closes the day, and a late payment produces
 * a new `run_seq`, never an edit. The screen says so instead of offering a
 * "re-run" button that does not exist.
 */
export function ReconciliationPage(): ReactElement {
  const canRead = useSession((state) => state.hasPermission("reconciliation:read"));
  const canRun = useSession((state) => state.hasPermission("reconciliation:run"));
  const { config } = useTenantConfig();
  const queryClient = useQueryClient();

  const [range, setRange] = useState(() => defaultReconciliationRange(new Date()));
  const [status, setStatus] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined);
  const [exceptionStatus, setExceptionStatus] = useState("open");
  const [severity, setSeverity] = useState("");

  const runs = useQuery({
    queryKey: ["reconciliation-runs", range, status],
    queryFn: async () =>
      await fetchRuns(reconciliationQueryParams({ from: range.from, to: range.to, status })),
    enabled: canRead && range.from !== "" && range.to !== "",
  });
  const runDetail = useQuery({
    queryKey: ["reconciliation-run", selectedRunId],
    queryFn: async () => {
      if (selectedRunId === undefined) throw new Error("no run selected");
      return await fetchRun(selectedRunId);
    },
    enabled: canRead && selectedRunId !== undefined,
  });
  const exceptions = useQuery({
    queryKey: ["reconciliation-exceptions", exceptionStatus, severity],
    queryFn: async () =>
      await fetchExceptions(exceptionQueryParams({ status: exceptionStatus, severity })),
    enabled: canRead,
  });

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["reconciliation-runs"] }),
      queryClient.invalidateQueries({ queryKey: ["reconciliation-run"] }),
      queryClient.invalidateQueries({ queryKey: ["reconciliation-exceptions"] }),
    ]);
  };

  if (!canRead) {
    return (
      <p className="text-sm text-slate-600">You do not have permission to view reconciliation.</p>
    );
  }

  const locale = config?.config.locale;
  const currency = locale?.currency ?? "";
  const numberFormat = locale?.numberFormat ?? "en";
  const dateFormat = locale?.dateFormat ?? "yyyy-MM-dd";
  const timezone = locale?.timezone ?? "UTC";
  const runRows = runs.data ?? [];
  const exceptionRows = exceptions.data ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Reconciliation</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Nightly runs compare settlement, clearing and collector cash against the ledger. A
          completed run is immutable; a later re-run is a new version, so evidence is never edited.
        </p>
      </div>

      <Card
        title="Runs"
        description="One run per business day and version. Select a run to read its checklist."
      >
        <div className="mb-3 flex flex-wrap items-end gap-3">
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
          <Field label="Run status">
            <select
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              value={status}
              onChange={(event) => {
                setStatus(event.currentTarget.value);
              }}
            >
              {RUN_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {runs.error !== null ? (
          <p className="text-sm text-red-600">Reconciliation runs could not be loaded.</p>
        ) : null}
        {runs.isLoading ? <p className="text-sm text-slate-500">Loading runs…</p> : null}
        {!runs.isLoading && runRows.length === 0 ? (
          <EmptyState message="No reconciliation runs in this range." />
        ) : null}

        {runRows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 pr-4 font-medium">Business day</th>
                  <th className="py-2 pr-4 font-medium">Version</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Exceptions</th>
                  <th className="py-2 pr-4 font-medium">Completed</th>
                  <th className="py-2 pr-4 font-medium">Signed off by</th>
                  <th className="py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {runRows.map((run) => (
                  <tr key={run.id} className="border-b border-slate-100">
                    <td className="py-2 pr-4 text-slate-700">
                      {businessDay(run.businessDate, numberFormat, dateFormat)}
                    </td>
                    <td className="py-2 pr-4 text-slate-600">v{run.runSeq}</td>
                    <td className="py-2 pr-4">
                      <Badge tone={runStatusTone(run.status)}>{runStatusLabel(run.status)}</Badge>
                    </td>
                    <td className="py-2 pr-4 text-slate-700">{run.exceptionCount}</td>
                    <td className="py-2 pr-4 text-slate-600">
                      {run.completedAt === null
                        ? "—"
                        : formatTimestamp(run.completedAt, numberFormat, timezone)}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-slate-500">
                      {run.signedOffByUserId ?? "—"}
                    </td>
                    <td className="py-2">
                      <button
                        type="button"
                        className="cursor-pointer text-xs underline"
                        onClick={() => {
                          setSelectedRunId(run.id);
                        }}
                      >
                        {selectedRunId === run.id ? "Selected" : "Open"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      {selectedRunId === undefined ? null : runDetail.isLoading ? (
        <p className="text-sm text-slate-500">Loading run…</p>
      ) : runDetail.error !== null || runDetail.data === undefined ? (
        <p className="text-sm text-red-600">This run could not be loaded.</p>
      ) : (
        <RunDetail
          run={runDetail.data}
          canRun={canRun}
          currency={currency}
          numberFormat={numberFormat}
          dateFormat={dateFormat}
          timezone={timezone}
          onDone={refresh}
        />
      )}

      <Card
        title="Exception queue"
        description="Open items carry forward into the next run by their dedupe key. Resolving or waiving one needs a note."
      >
        {canRun ? null : (
          <ReadOnlyNote>
            Read-only view: signing off and clearing exceptions need the reconciliation:run
            permission.
          </ReadOnlyNote>
        )}
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field label="Exception status">
            <select
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              value={exceptionStatus}
              onChange={(event) => {
                setExceptionStatus(event.currentTarget.value);
              }}
            >
              {EXCEPTION_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Severity">
            <select
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              value={severity}
              onChange={(event) => {
                setSeverity(event.currentTarget.value);
              }}
            >
              {EXCEPTION_SEVERITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {exceptions.error !== null ? (
          <p className="mt-3 text-sm text-red-600">The exception queue could not be loaded.</p>
        ) : null}
        {exceptions.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading exceptions…</p>
        ) : null}
        {!exceptions.isLoading && exceptionRows.length === 0 ? (
          <EmptyState message="No exceptions match these filters." />
        ) : null}

        {exceptionRows.length > 0 ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 pr-4 font-medium">Business day</th>
                  <th className="py-2 pr-4 font-medium">Kind</th>
                  <th className="py-2 pr-4 font-medium">Severity</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Subject</th>
                  <th className="py-2 pr-4 font-medium">Difference</th>
                  <th className="py-2 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {exceptionRows.map((exception) => (
                  <ExceptionRow
                    key={exception.id}
                    exception={exception}
                    canRun={canRun}
                    currency={currency}
                    numberFormat={numberFormat}
                    onDone={refresh}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

async function fetchRuns(query: {
  readonly from: string;
  readonly to: string;
  readonly status?: string;
}): Promise<readonly ReconciliationRunView[]> {
  const data = await unwrap(api.GET("/v1/reconciliation/runs", { params: { query } }));
  return (data as { runs: readonly ReconciliationRunView[] }).runs;
}

async function fetchRun(id: string): Promise<ReconciliationRunView> {
  const data = await unwrap(api.GET("/v1/reconciliation/runs/{id}", { params: { path: { id } } }));
  return (data as { run: ReconciliationRunView }).run;
}

async function fetchExceptions(query: {
  readonly status?: string;
  readonly severity?: string;
}): Promise<readonly ReconciliationExceptionView[]> {
  const data = await unwrap(api.GET("/v1/reconciliation/exceptions", { params: { query } }));
  return (data as { exceptions: readonly ReconciliationExceptionView[] }).exceptions;
}

/** A `YYYY-MM-DD` business day in the tenant's configured date format. */
function businessDay(businessDate: string, numberFormat: string, pattern: string): string {
  return formatBusinessDate(`${businessDate}T00:00:00.000Z`, numberFormat, pattern);
}

function RunDetail(props: {
  readonly run: ReconciliationRunView;
  readonly canRun: boolean;
  readonly currency: string;
  readonly numberFormat: string;
  readonly dateFormat: string;
  readonly timezone: string;
  readonly onDone: () => Promise<void>;
}): ReactElement {
  const summary = checklistSummary(props.run.checklist);
  const canSignOff = props.canRun && props.run.status === "completed";
  const blocked = summary.blockingFailures > 0;

  return (
    <Card
      title={`Checklist · ${businessDay(props.run.businessDate, props.numberFormat, props.dateFormat)} (v${props.run.runSeq})`}
      description={`${summary.passed} of ${summary.total} checks within tolerance; ${summary.failed} outside.`}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge tone={runStatusTone(props.run.status)}>{runStatusLabel(props.run.status)}</Badge>
        <span className="text-xs text-slate-500">
          tolerance {formatMoneyMinor(props.run.toleranceMinor, props.currency, props.numberFormat)}
          {" · "}fee tolerance{" "}
          {formatMoneyMinor(props.run.feeToleranceMinor, props.currency, props.numberFormat)}
        </span>
      </div>

      {props.run.checklist.length === 0 ? (
        <EmptyState message="This run recorded no checklist items." />
      ) : (
        <ul className="space-y-2">
          {props.run.checklist.map((item) => (
            <ChecklistRow
              key={`${item.check}:${item.subjectId ?? "tenant"}`}
              item={item}
              currency={props.currency}
              numberFormat={props.numberFormat}
            />
          ))}
        </ul>
      )}

      {props.run.status === "failed" && props.run.failureReason !== null ? (
        <p className="mt-3 text-sm text-red-600">Run failed: {props.run.failureReason}</p>
      ) : null}

      {props.run.status === "signed_off" ? (
        <div className="mt-3">
          <ReadOnlyNote>
            Signed off
            {props.run.signedOffByUserId === null ? "" : ` by ${props.run.signedOffByUserId}`}
            {props.run.signedOffAt === null
              ? ""
              : ` on ${formatTimestamp(props.run.signedOffAt, props.numberFormat, props.timezone)}`}
            {props.run.signOffNote === null ? "." : ` — ${props.run.signOffNote}`}
          </ReadOnlyNote>
        </div>
      ) : null}

      {canSignOff ? (
        <div className="mt-4">
          <SignOffForm
            runId={props.run.id}
            blocked={blocked}
            blockingFailures={summary.blockingFailures}
            onDone={props.onDone}
          />
        </div>
      ) : null}
    </Card>
  );
}

function ChecklistRow(props: {
  readonly item: ChecklistItemView;
  readonly currency: string;
  readonly numberFormat: string;
}): ReactElement {
  const { item } = props;
  const money = (value: string | null): string =>
    value === null ? "—" : formatMoneyMinor(value, props.currency, props.numberFormat);
  const count = (value: number | null): string => (value === null ? "—" : `${value}`);
  const expected =
    item.expectedMinor !== null ? money(item.expectedMinor) : count(item.expectedCount);
  const actual = item.actualMinor !== null ? money(item.actualMinor) : count(item.actualCount);
  const difference =
    item.differenceMinor !== null ? money(item.differenceMinor) : count(item.differenceCount);

  return (
    <li className="rounded-md border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={severityTone(item.severity)}>{severityLabel(item.severity)}</Badge>
        <span className="text-sm font-medium text-slate-900">{checklistItemLabel(item.check)}</span>
        <Badge
          tone={
            item.withinTolerance === null ? "neutral" : item.withinTolerance ? "positive" : "danger"
          }
        >
          {toleranceLabel(item)}
        </Badge>
      </div>
      {item.subjectType === null ? null : (
        <p className="mt-1 font-mono text-xs text-slate-500">
          {item.subjectType}
          {item.subjectId === null ? "" : ` · ${item.subjectId}`}
        </p>
      )}
      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-xs text-slate-600">
        <dt>Expected</dt>
        <dd>{expected}</dd>
        <dt>Actual</dt>
        <dd>{actual}</dd>
        <dt>Difference</dt>
        <dd>{difference}</dd>
      </dl>
    </li>
  );
}

function SignOffForm(props: {
  readonly runId: string;
  readonly blocked: boolean;
  readonly blockingFailures: number;
  readonly onDone: () => Promise<void>;
}): ReactElement {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (note.trim() === "") {
      pushToast({ kind: "error", message: "A sign-off note is required." });
      return;
    }
    setBusy(true);
    try {
      await unwrap(
        api.POST("/v1/reconciliation/runs/{id}/sign-off", {
          params: { path: { id: props.runId } },
          body: signOffBody(note),
        }),
      );
      pushToast({ kind: "success", message: "Run signed off." });
      await props.onDone();
      setNote("");
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="space-y-3" onSubmit={(event) => void submit(event)}>
      <Field label="Sign-off note" hint="Recorded with your user id in the audit trail; required.">
        <TextInput
          name="signOffNote"
          value={note}
          onValueChange={setNote}
          placeholder="Sign-off note"
        />
      </Field>
      {props.blocked ? (
        <p className="text-xs text-red-600">
          Sign-off is blocked by {props.blockingFailures} failing check(s).
        </p>
      ) : null}
      <Button type="submit" disabled={busy || props.blocked}>
        {busy ? "Signing off…" : "Sign off run"}
      </Button>
    </form>
  );
}

function ExceptionRow(props: {
  readonly exception: ReconciliationExceptionView;
  readonly canRun: boolean;
  readonly currency: string;
  readonly numberFormat: string;
  readonly onDone: () => Promise<void>;
}): ReactElement {
  const { exception } = props;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const currency = exception.currency ?? props.currency;

  const transition = async (action: "resolve" | "waive"): Promise<void> => {
    if (note.trim() === "") {
      pushToast({ kind: "error", message: "A note is required to resolve or waive an exception." });
      return;
    }
    setBusy(true);
    try {
      await unwrap(
        action === "resolve"
          ? api.POST("/v1/reconciliation/exceptions/{id}/resolve", {
              params: { path: { id: exception.id } },
              body: resolutionBody(note),
            })
          : api.POST("/v1/reconciliation/exceptions/{id}/waive", {
              params: { path: { id: exception.id } },
              body: resolutionBody(note),
            }),
      );
      pushToast({
        kind: "success",
        message: action === "resolve" ? "Exception resolved." : "Exception waived.",
      });
      await props.onDone();
      setNote("");
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="border-b border-slate-100 align-top">
      <td className="py-2 pr-4 text-slate-700">{exception.businessDate}</td>
      <td className="py-2 pr-4 font-mono text-xs text-slate-700">{exception.kind}</td>
      <td className="py-2 pr-4">
        <Badge tone={severityTone(exception.severity)}>{severityLabel(exception.severity)}</Badge>
      </td>
      <td className="py-2 pr-4">
        <Badge tone={exceptionStatusTone(exception.status)}>
          {exceptionStatusLabel(exception.status)}
        </Badge>
      </td>
      <td className="py-2 pr-4 text-slate-700">{describeExceptionSubject(exception)}</td>
      <td className="py-2 pr-4 text-slate-900">
        {exception.differenceMinor === null
          ? "—"
          : formatMoneyMinor(exception.differenceMinor, currency, props.numberFormat)}
      </td>
      <td className="py-2">
        {props.canRun && exception.status === "open" ? (
          <div className="flex flex-wrap items-center gap-2">
            <TextInput
              name={`note-${exception.id}`}
              value={note}
              onValueChange={setNote}
              placeholder="Resolution note"
            />
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void transition("resolve");
              }}
            >
              Resolve
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void transition("waive");
              }}
            >
              Waive
            </Button>
          </div>
        ) : (
          <span className="text-xs text-slate-400">{exception.resolutionNote ?? "—"}</span>
        )}
      </td>
    </tr>
  );
}
