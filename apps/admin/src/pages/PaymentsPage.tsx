import { useState, type FormEvent, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  PAYMENT_STATUS_OPTIONS,
  describePayment,
  formatPaymentAmount,
  formatPaymentBusinessDay,
  formatPaymentDate,
  outboxKindLabel,
  outboxStatusLabel,
  outboxStatusTone,
  outboxSummary,
  paymentQueryParams,
  paymentReference,
  resolveBody,
  statusLabel,
  statusTone,
  suspenseQueryParams,
  type OutboxMessageView,
  type PaymentQueryParams,
  type PaymentStatus,
  type PaymentView,
  type SuspenseQueryParams,
} from "../lib/paymentsView.js";
import { useTenantConfig } from "../lib/tenantConfig.js";
import { describeError, pushToast } from "../toast.js";
import { useSession } from "../session.js";

const PAGE_SIZE = 50;

/**
 * Step 3 of Phase 9: the payments and suspense screen.
 *
 * Two jobs in one page, because they are one workflow: read what the gateway
 * sent and whether the driver's receipt went out, then attribute the money that
 * arrived without an asset. Both lists are read-only views of the ledger; the
 * only mutation is resolving a suspense payment to an asset, and that needs
 * `payment:manage`. An auditor sees the same data with no resolve control at
 * all — the server enforces the same rule, this only hides what would 403.
 *
 * Wording is strict under `pay_per_use`: a business day with no payment has no
 * payment recorded, and the screen never infers a liability from an absence. A
 * vehicle that simply was not used that day is not an anomaly.
 */
export function PaymentsPage(): ReactElement {
  const canRead = useSession((state) => state.hasPermission("payment:read"));
  const canManage = useSession((state) => state.hasPermission("payment:manage"));
  const { config } = useTenantConfig();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<PaymentStatus | "">("");
  const [selected, setSelected] = useState<PaymentView | undefined>(undefined);

  const payments = useQuery({
    queryKey: ["payments", status],
    queryFn: async () => await fetchPayments(paymentQueryParams({ status, limit: PAGE_SIZE })),
    enabled: canRead,
  });
  const suspense = useQuery({
    queryKey: ["payments-suspense"],
    queryFn: async () => await fetchSuspense(suspenseQueryParams({ limit: PAGE_SIZE })),
    enabled: canRead,
  });
  const selectedId = selected?.id;
  const outbox = useQuery({
    queryKey: ["payment-outbox", selectedId],
    queryFn: async () => {
      if (selectedId === undefined) throw new Error("no payment selected");
      return await fetchOutbox(selectedId);
    },
    enabled: canRead && selectedId !== undefined,
  });

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["payments"] }),
      queryClient.invalidateQueries({ queryKey: ["payments-suspense"] }),
      queryClient.invalidateQueries({ queryKey: ["payment-outbox"] }),
    ]);
  };

  if (!canRead) {
    return <p className="text-sm text-slate-600">You do not have permission to view payments.</p>;
  }

  const locale = config?.config.locale;
  const currency = locale?.currency ?? "";
  const numberFormat = locale?.numberFormat ?? "en";
  const dateFormat = locale?.dateFormat ?? "yyyy-MM-dd";
  const timezone = locale?.timezone ?? "UTC";
  const paymentRows = payments.data ?? [];
  const suspenseRows = suspense.data ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Payments</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Every gateway payment, the asset it was attributed to, and whether the driver's receipt
          went out. A business day with no payment recorded means only that: no payment was
          recorded. Money that arrived without an asset waits in suspense.
        </p>
      </div>

      <Card
        title="Payments"
        description="Newest first. A credited payment landed in the wallet without settling a business day."
      >
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="Status">
            <select
              aria-label="Status"
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              value={status}
              onChange={(event) => {
                setStatus(event.currentTarget.value as PaymentStatus | "");
              }}
            >
              {PAYMENT_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {payments.error !== null ? (
          <p className="text-sm text-red-600">Payments could not be loaded.</p>
        ) : null}
        {payments.isLoading ? <p className="text-sm text-slate-500">Loading payments…</p> : null}
        {!payments.isLoading && paymentRows.length === 0 ? (
          <EmptyState message="No payments match this filter." />
        ) : null}

        {paymentRows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 pr-4 font-medium">Recorded</th>
                  <th className="py-2 pr-4 font-medium">Business day</th>
                  <th className="py-2 pr-4 font-medium">Provider / reference</th>
                  <th className="py-2 pr-4 font-medium">Amount</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Asset</th>
                  <th className="py-2 pr-4 font-medium">Receipt</th>
                  <th className="py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {paymentRows.map((payment) => (
                  <tr key={payment.id} className="border-b border-slate-100">
                    <td className="py-2 pr-4 text-slate-600">
                      {formatPaymentDate(payment.createdAt, numberFormat, timezone)}
                    </td>
                    <td className="py-2 pr-4 text-slate-700">
                      {payment.businessDate === null
                        ? "—"
                        : formatPaymentBusinessDay(payment.businessDate, numberFormat, dateFormat)}
                    </td>
                    <td className="py-2 pr-4">
                      <span className="text-slate-700">{payment.provider}</span>
                      <span className="ml-2 font-mono text-xs text-slate-500">
                        {paymentReference(payment)}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-slate-900">
                      {formatPaymentAmount(payment, currency, numberFormat)}
                    </td>
                    <td className="py-2 pr-4">
                      <Badge tone={statusTone(payment.status)}>{statusLabel(payment.status)}</Badge>
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-slate-600">
                      {payment.assetId ?? "—"}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-slate-600">
                      {payment.receiptNumber ?? "—"}
                    </td>
                    <td className="py-2">
                      <button
                        type="button"
                        className="cursor-pointer text-xs underline"
                        onClick={() => {
                          setSelected(selected?.id === payment.id ? undefined : payment);
                        }}
                      >
                        {selected?.id === payment.id ? "Hide receipt" : "Receipt status"}
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
        <OutboxPanel
          payment={selected}
          messages={outbox.data ?? []}
          isLoading={outbox.isLoading}
          isError={outbox.error !== null}
          numberFormat={numberFormat}
          timezone={timezone}
        />
      )}

      <Card
        title="Suspense queue"
        description="Money that arrived without a matching asset. Resolving assigns it to an asset; the ledger is never edited."
      >
        {canManage ? null : (
          <ReadOnlyNote>
            Read-only view: resolving a suspense payment needs the payment:manage permission.
          </ReadOnlyNote>
        )}

        {suspense.error !== null ? (
          <p className="mt-3 text-sm text-red-600">The suspense queue could not be loaded.</p>
        ) : null}
        {suspense.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading suspense payments…</p>
        ) : null}
        {!suspense.isLoading && suspenseRows.length === 0 ? (
          <EmptyState message="No payments are waiting in suspense." />
        ) : null}

        {suspenseRows.length > 0 ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 pr-4 font-medium">Recorded</th>
                  <th className="py-2 pr-4 font-medium">Provider / reference</th>
                  <th className="py-2 pr-4 font-medium">Amount</th>
                  <th className="py-2 font-medium">Resolve</th>
                </tr>
              </thead>
              <tbody>
                {suspenseRows.map((payment) => (
                  <tr key={payment.id} className="border-b border-slate-100 align-top">
                    <td className="py-2 pr-4 text-slate-600">
                      {formatPaymentDate(payment.createdAt, numberFormat, timezone)}
                    </td>
                    <td className="py-2 pr-4">
                      <span className="text-slate-700">{payment.provider}</span>
                      <span className="ml-2 font-mono text-xs text-slate-500">
                        {paymentReference(payment)}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-slate-900">
                      {formatPaymentAmount(payment, currency, numberFormat)}
                    </td>
                    <td className="py-2">
                      {canManage ? (
                        <ResolveForm
                          payment={payment}
                          currency={currency}
                          numberFormat={numberFormat}
                          onDone={refresh}
                        />
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

async function fetchPayments(query: PaymentQueryParams): Promise<readonly PaymentView[]> {
  const data = await unwrap(api.GET("/v1/payments", { params: { query } }));
  return data.payments;
}

async function fetchSuspense(query: SuspenseQueryParams): Promise<readonly PaymentView[]> {
  const data = await unwrap(api.GET("/v1/payments/suspense", { params: { query } }));
  return data.payments;
}

async function fetchOutbox(paymentId: string): Promise<readonly OutboxMessageView[]> {
  const data = await unwrap(
    api.GET("/v1/payments/{id}/outbox", { params: { path: { id: paymentId } } }),
  );
  return data.messages;
}

/**
 * The receipt outbox for one payment: whether the driver's SMS is pending, sent
 * or failed. Read-only, so every role holding `payment:read` can see it.
 */
function OutboxPanel(props: {
  readonly payment: PaymentView;
  readonly messages: readonly OutboxMessageView[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly numberFormat: string;
  readonly timezone: string;
}): ReactElement {
  const reference = paymentReference(props.payment);

  return (
    <Card title={`Receipt messages · ${reference}`} description={outboxSummary(props.messages)}>
      {props.isError ? (
        <p className="text-sm text-red-600">Receipt messages could not be loaded.</p>
      ) : null}
      {props.isLoading ? <p className="text-sm text-slate-500">Loading receipt messages…</p> : null}
      {!props.isLoading && !props.isError && props.messages.length === 0 ? (
        <EmptyState message="No message has been queued for this payment yet." />
      ) : null}

      {props.messages.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2 pr-4 font-medium">Kind</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Recipient</th>
                <th className="py-2 pr-4 font-medium">Message</th>
                <th className="py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {props.messages.map((message) => (
                <tr key={message.id} className="border-b border-slate-100 align-top">
                  <td className="py-2 pr-4 text-slate-700">{outboxKindLabel(message.kind)}</td>
                  <td className="py-2 pr-4">
                    <Badge tone={outboxStatusTone(message.status)}>
                      {outboxStatusLabel(message.status)}
                    </Badge>
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-slate-600">
                    {message.recipient}
                  </td>
                  <td className="py-2 pr-4 text-slate-600">{message.body}</td>
                  <td className="py-2 text-slate-600">
                    {formatPaymentDate(message.createdAt, props.numberFormat, props.timezone)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Resolve one suspense payment: the operator types the asset id and reads the
 * confirmation naming the amount and provider reference before submitting. An
 * empty id never leaves the browser; the API would reject it anyway.
 */
function ResolveForm(props: {
  readonly payment: PaymentView;
  readonly currency: string;
  readonly numberFormat: string;
  readonly onDone: () => Promise<void>;
}): ReactElement {
  const [assetId, setAssetId] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const body = resolveBody(assetId);
    if (body === undefined) {
      pushToast({
        kind: "error",
        message: "An asset id is required to resolve a suspense payment.",
      });
      return;
    }
    setBusy(true);
    try {
      await unwrap(
        api.POST("/v1/payments/{id}/resolve", {
          params: { path: { id: props.payment.id } },
          body,
        }),
      );
      pushToast({
        kind: "success",
        message: `Payment ${paymentReference(props.payment)} assigned to asset ${body.assetId}.`,
      });
      await props.onDone();
      setAssetId("");
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="space-y-2" onSubmit={(event) => void submit(event)}>
      <TextInput
        name={`assetId-${props.payment.id}`}
        value={assetId}
        onValueChange={setAssetId}
        placeholder="Asset id"
      />
      <p className="text-xs text-slate-500">
        Assign {describePayment(props.payment, props.currency, props.numberFormat)} to the asset id
        above.
      </p>
      <Button type="submit" variant="ghost" disabled={busy}>
        {busy ? "Resolving…" : "Resolve payment"}
      </Button>
    </form>
  );
}
