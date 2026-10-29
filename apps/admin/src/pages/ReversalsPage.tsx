import { useState, type FormEvent, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatTimestamp } from "@tpirs/ui-tokens";
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
  DEFAULT_REVERSAL_STATUS,
  REVERSAL_PAGE_SIZE,
  REVERSAL_STATUS_OPTIONS,
  approveBody,
  canApprove,
  describeReversal,
  rejectBody,
  reversalQueryParams,
  reversalStatusLabel,
  reversalStatusTone,
  type ReversalQueryParams,
  type ReversalView,
} from "../lib/reversalsView.js";
import { useTenantConfig } from "../lib/tenantConfig.js";
import { describeError, pushToast } from "../toast.js";
import { useSession } from "../session.js";

/**
 * Step 5: reversal requests with dual approval.
 *
 * A reversal is never an edit: a finance user requests it with a reason and a
 * *different* finance user approves it, which posts mirrored entries (ADR 0013).
 * The queue therefore opens on pending work, and the decision card explains the
 * three states the server enforces: you cannot approve your own request, you
 * need `ledger:approve` at all, and a rejection needs a reason.
 *
 * The screen does not decide anything itself. It hides the controls the server
 * would 403 on, refuses to send a self-approval the server would 409 on, and
 * lets `LedgerService.approveReversal` stay the authority.
 */
export function ReversalsPage(): ReactElement {
  const canRead = useSession((state) => state.hasPermission("ledger:read"));
  const hasApprovalPermission = useSession((state) => state.hasPermission("ledger:approve"));
  const userId = useSession((state) => state.user?.userId);
  const { config } = useTenantConfig();
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<string>(DEFAULT_REVERSAL_STATUS);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  const reversals = useQuery({
    queryKey: ["reversals", status],
    queryFn: async () =>
      await fetchReversals(reversalQueryParams({ status, limit: REVERSAL_PAGE_SIZE })),
    enabled: canRead,
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["reversals"] });
  };

  if (!canRead) {
    return (
      <p className="text-sm text-slate-600">
        You do not have permission to view reversal requests.
      </p>
    );
  }

  const locale = config?.config.locale;
  const numberFormat = locale?.numberFormat ?? "en";
  const timezone = locale?.timezone ?? "UTC";
  const rows = reversals.data ?? [];
  const selected = rows.find((row) => row.id === selectedId);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Reversals</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Corrections are reversing entries, never edits. A finance user requests one with a reason
          and a different finance user approves it; approval posts the mirrored entries.
        </p>
      </div>

      <Card
        title="Reversal requests"
        description="Pending first by default. Select a request to approve or reject it."
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
              {REVERSAL_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {reversals.error !== null ? (
          <p className="text-sm text-red-600">Reversal requests could not be loaded.</p>
        ) : null}
        {reversals.isLoading ? (
          <p className="text-sm text-slate-500">Loading reversal requests…</p>
        ) : null}
        {!reversals.isLoading && rows.length === 0 ? (
          <EmptyState message="No reversal requests match these filters." />
        ) : null}

        {rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 pr-4 font-medium">Requested</th>
                  <th className="py-2 pr-4 font-medium">Original transaction</th>
                  <th className="py-2 pr-4 font-medium">Reason</th>
                  <th className="py-2 pr-4 font-medium">Requester</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((reversal) => (
                  <tr key={reversal.id} className="border-b border-slate-100">
                    <td className="py-2 pr-4 text-slate-600">
                      {formatTimestamp(reversal.createdAt, numberFormat, timezone)}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-slate-700">
                      {reversal.originalTransactionId}
                    </td>
                    <td className="py-2 pr-4 text-slate-700">{reversal.reason}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-slate-500">
                      {reversal.requestedByUserId}
                    </td>
                    <td className="py-2 pr-4">
                      <Badge tone={reversalStatusTone(reversal.status)}>
                        {reversalStatusLabel(reversal.status)}
                      </Badge>
                    </td>
                    <td className="py-2">
                      <button
                        type="button"
                        className="cursor-pointer text-xs underline"
                        onClick={() => {
                          setSelectedId(reversal.id);
                        }}
                      >
                        {selectedId === reversal.id ? "Selected" : "Open"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      {selected === undefined ? null : (
        <ReversalDecision
          key={selected.id}
          reversal={selected}
          hasApprovalPermission={hasApprovalPermission}
          userId={userId}
          numberFormat={numberFormat}
          timezone={timezone}
          onDone={refresh}
        />
      )}
    </div>
  );
}

async function fetchReversals(query: ReversalQueryParams): Promise<readonly ReversalView[]> {
  const data = await unwrap(api.GET("/v1/reversals", { params: { query } }));
  return data.reversals;
}

function ReversalDecision(props: {
  readonly reversal: ReversalView;
  readonly hasApprovalPermission: boolean;
  readonly userId: string | undefined;
  readonly numberFormat: string;
  readonly timezone: string;
  readonly onDone: () => Promise<void>;
}): ReactElement {
  const { reversal } = props;

  if (reversal.status !== "pending") {
    return (
      <Card title="Decision" description={describeReversal(reversal)}>
        <ReadOnlyNote>
          {reversal.status === "approved"
            ? `Approved${byUser(reversal.approvedByUserId)}${onDate(reversal.approvedAt, props)}.${reversingEntry(reversal)}`
            : `Rejected${byUser(reversal.rejectedByUserId)}${onDate(reversal.rejectedAt, props)}.`}
        </ReadOnlyNote>
      </Card>
    );
  }

  if (!props.hasApprovalPermission) {
    return (
      <Card title="Decision" description={describeReversal(reversal)}>
        <ReadOnlyNote>
          Read-only view: approving or rejecting a reversal needs the ledger:approve permission.
        </ReadOnlyNote>
      </Card>
    );
  }

  if (!canApprove(reversal, props.userId)) {
    return (
      <Card title="Decision" description={describeReversal(reversal)}>
        <ReadOnlyNote>
          You requested this reversal; a different finance user must approve or reject it.
        </ReadOnlyNote>
      </Card>
    );
  }

  return (
    <Card title="Decision" description={describeReversal(reversal)}>
      <DecisionForms reversal={reversal} onDone={props.onDone} />
    </Card>
  );
}

/**
 * The approve and reject forms for one pending request.
 *
 * They are separate forms because the bodies differ: approval takes an optional
 * note, rejection a required reason. The guards before each POST are the point
 * of the screen — a self-approval never leaves the browser.
 */
function DecisionForms(props: {
  readonly reversal: ReversalView;
  readonly onDone: () => Promise<void>;
}): ReactElement {
  const userId = useSession((state) => state.user?.userId);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const approve = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canApprove(props.reversal, userId)) return;
    setBusy(true);
    try {
      const result = await unwrap(
        api.POST("/v1/reversals/{id}/approve", {
          params: { path: { id: props.reversal.id } },
          body: approveBody(note),
        }),
      );
      pushToast({
        kind: "success",
        message: `Reversal approved; transaction ${result.transactionId} posted.`,
      });
      await props.onDone();
      setNote("");
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  const reject = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const body = rejectBody(reason);
    if (body === undefined) {
      pushToast({ kind: "error", message: "A reason is required to reject a reversal." });
      return;
    }
    setBusy(true);
    try {
      await unwrap(
        api.POST("/v1/reversals/{id}/reject", {
          params: { path: { id: props.reversal.id } },
          body,
        }),
      );
      pushToast({ kind: "success", message: "Reversal rejected." });
      await props.onDone();
      setReason("");
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <form className="space-y-3" onSubmit={(event) => void approve(event)}>
        <Field
          label="Approval note"
          hint="Optional; recorded with your user id in the audit trail."
        >
          <TextInput
            name="approvalNote"
            value={note}
            onValueChange={setNote}
            placeholder="Approval note"
          />
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? "Approving…" : "Approve reversal"}
        </Button>
      </form>

      <form className="space-y-3" onSubmit={(event) => void reject(event)}>
        <Field label="Rejection reason" hint="Required; the requester sees it on the request.">
          <TextInput
            name="rejectionReason"
            value={reason}
            onValueChange={setReason}
            placeholder="Rejection reason"
          />
        </Field>
        <Button type="submit" variant="ghost" disabled={busy}>
          {busy ? "Rejecting…" : "Reject reversal"}
        </Button>
      </form>
    </div>
  );
}

function byUser(userId: string | null): string {
  return userId === null ? "" : ` by ${userId}`;
}

function onDate(
  iso: string | null,
  props: Readonly<{ readonly numberFormat: string; readonly timezone: string }>,
): string {
  return iso === null ? "" : ` on ${formatTimestamp(iso, props.numberFormat, props.timezone)}`;
}

function reversingEntry(reversal: ReversalView): string {
  return reversal.reversingTransactionId === null
    ? ""
    : ` Reversing transaction ${reversal.reversingTransactionId} was posted.`;
}
