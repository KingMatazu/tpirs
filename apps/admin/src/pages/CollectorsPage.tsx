import { useMemo, useState, type FormEvent, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  formatMajorAmountInput,
  formatMoneyMinor,
  formatTimestamp,
  parseMajorToMinor,
} from "@tpirs/ui-tokens";
import { api } from "../api/client.js";
import { unwrap } from "../api/unwrap.js";
import { Badge, Button, Card, EmptyState, Field, TextInput } from "../components/ui.js";
import {
  assetLabel,
  depositStatusLabel,
  heldHours,
  isOverdue,
  matchCandidates,
  newClientReference,
  prefillAmountMinor,
  walletStatusLabel,
  type AssetLookupRow,
  type CashDepositView,
  type CashIntakeView,
  type CashWalletView,
} from "../lib/collectorsView.js";
import { useTenantConfig } from "../lib/tenantConfig.js";
import { describeError, pushToast } from "../toast.js";
import { useSession } from "../session.js";

const PAGE_SIZE = 50;

/**
 * Step 8: the collector cash screen.
 *
 * Three jobs in one page, because they are one workflow: take cash from a
 * driver (intake), watch what the collector still owes the bank (wallet), and
 * match a suspense deposit to the intake it settles. Every money action goes
 * through the generated client, so the idempotency key is stamped before the
 * request leaves the browser (ADR 0031).
 *
 * Permissions gate each affordance separately: a supervisor freezes but cannot
 * unfreeze, finance does both, and a collector sees only their own wallet (the
 * server enforces the same rule; this only hides what would 403).
 */
export function CollectorsPage(): ReactElement {
  const { config } = useTenantConfig();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const canRead = useSession((state) => state.hasPermission("cash:read"));

  const wallets = useQuery({
    queryKey: ["cash-wallets"],
    queryFn: fetchWallets,
    enabled: canRead,
  });

  if (!canRead) {
    return (
      <p className="text-sm text-slate-600">You do not have permission to view collector cash.</p>
    );
  }
  if (wallets.isLoading)
    return <p className="text-sm text-slate-500">Loading collector wallets…</p>;
  if (wallets.error !== null) {
    return <p className="text-sm text-red-600">Collector wallets could not be loaded.</p>;
  }

  const locale = config?.config.locale;
  const cashRules = config?.config.cashRules;
  const currency = locale?.currency ?? "";
  const numberFormat = locale?.numberFormat ?? "en";
  const timezone = locale?.timezone ?? "UTC";
  const now = new Date();
  const rows = wallets.data ?? [];
  // Overdue wallets float to the top: that is the day's work for a supervisor.
  const sorted = [...rows].sort(
    (left, right) =>
      Number(isOverdue(right, cashRules?.depositDeadlineHours ?? 0, now)) -
      Number(isOverdue(left, cashRules?.depositDeadlineHours ?? 0, now)),
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Collectors</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Cash a collector is holding, how long each intake has been open, and the deposits that
          close the float. The balance is derived from the ledger, never stored.
        </p>
      </div>

      {sorted.length === 0 ? (
        <EmptyState message="No collector wallets exist in this tenant yet." />
      ) : (
        <Card title="Wallets" description="Overdue first, then by collector.">
          <WalletTable
            wallets={sorted}
            currency={currency}
            numberFormat={numberFormat}
            timezone={timezone}
            deadlineHours={cashRules?.depositDeadlineHours}
            now={now}
            selected={selected}
            onSelect={setSelected}
          />
        </Card>
      )}

      {selected === undefined ? null : (
        <WalletDetail
          key={selected}
          collectorUserId={selected}
          currency={currency}
          numberFormat={numberFormat}
          timezone={timezone}
          deadlineHours={cashRules?.depositDeadlineHours}
        />
      )}
    </div>
  );
}

async function fetchWallets(): Promise<readonly CashWalletView[]> {
  const data = await unwrap(api.GET("/v1/cash/wallets"));
  return (data as { wallets: readonly CashWalletView[] }).wallets;
}

function WalletTable(props: {
  readonly wallets: readonly CashWalletView[];
  readonly currency: string;
  readonly numberFormat: string;
  readonly timezone: string;
  readonly deadlineHours: number | undefined;
  readonly now: Date;
  readonly selected: string | undefined;
  readonly onSelect: (collectorUserId: string) => void;
}): ReactElement {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-slate-500">
            <th className="py-2 pr-4 font-medium">Collector</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 pr-4 font-medium">Float held</th>
            <th className="py-2 pr-4 font-medium">Open intakes</th>
            <th className="py-2 pr-4 font-medium">Oldest open</th>
            <th className="py-2 pr-4 font-medium">Last deposit</th>
            <th className="py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {props.wallets.map((wallet) => {
            const overdue =
              props.deadlineHours === undefined
                ? false
                : isOverdue(wallet, props.deadlineHours, props.now);
            return (
              <tr key={wallet.collectorUserId} className="border-b border-slate-100">
                <td className="py-2 pr-4 font-mono text-xs text-slate-700">
                  {wallet.collectorUserId}
                </td>
                <td className="py-2 pr-4">
                  <Badge tone={overdue ? "brand" : "neutral"}>{walletStatusLabel(wallet)}</Badge>
                </td>
                <td className="py-2 pr-4 text-slate-900">
                  {formatMoneyMinor(wallet.balanceMinor, props.currency, props.numberFormat)}
                </td>
                <td className="py-2 pr-4 text-slate-700">
                  {formatMoneyMinor(
                    wallet.openIntakeTotalMinor,
                    props.currency,
                    props.numberFormat,
                  )}
                </td>
                <td className="py-2 pr-4 text-slate-600">
                  {wallet.oldestOpenIntakeAt === null
                    ? "—"
                    : `${String(heldHours(wallet.oldestOpenIntakeAt, props.now))} h`}
                </td>
                <td className="py-2 pr-4 text-slate-600">
                  {wallet.lastDepositAt === null
                    ? "—"
                    : formatTimestamp(wallet.lastDepositAt, props.numberFormat, props.timezone)}
                </td>
                <td className="py-2">
                  <button
                    type="button"
                    className="cursor-pointer text-xs underline"
                    onClick={() => {
                      props.onSelect(wallet.collectorUserId);
                    }}
                  >
                    {props.selected === wallet.collectorUserId ? "Selected" : "Open"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WalletDetail(props: {
  readonly collectorUserId: string;
  readonly currency: string;
  readonly numberFormat: string;
  readonly timezone: string;
  readonly deadlineHours: number | undefined;
}): ReactElement {
  const queryClient = useQueryClient();
  const { collectorUserId } = props;
  const canReadDeposits = useSession((state) => state.hasPermission("cash:deposit:read"));
  const canIntake = useSession((state) => state.hasPermission("cash:intake"));
  const canFreeze = useSession((state) => state.hasPermission("cash:freeze"));
  const canUnfreeze = useSession((state) => state.hasPermission("cash:unfreeze"));
  const canMatch = useSession((state) => state.hasPermission("cash:deposit:match"));

  const detail = useQuery({
    queryKey: ["cash-wallet", collectorUserId],
    queryFn: () => fetchWalletDetail(collectorUserId),
  });
  const deposits = useQuery({
    queryKey: ["cash-deposits", collectorUserId],
    queryFn: () => fetchDeposits(collectorUserId),
    // Deposit listing is its own permission; an intake-only role must not 403.
    enabled: canReadDeposits,
  });

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["cash-wallets"] }),
      queryClient.invalidateQueries({ queryKey: ["cash-wallet", collectorUserId] }),
      queryClient.invalidateQueries({ queryKey: ["cash-deposits", collectorUserId] }),
    ]);
  };

  if (detail.isLoading) return <p className="text-sm text-slate-500">Loading wallet…</p>;
  if (detail.error !== null || detail.data === undefined) {
    return <p className="text-sm text-red-600">This wallet could not be loaded.</p>;
  }

  const wallet = detail.data.wallet;
  const intakes = detail.data.intakes;
  const depositRows = deposits.data ?? [];
  const candidates = matchCandidates(depositRows, intakes);
  const overdue =
    props.deadlineHours === undefined ? false : isOverdue(wallet, props.deadlineHours, new Date());

  return (
    <div className="space-y-4">
      <Card
        title="Wallet"
        description="Freezing stops the next intake; a day already settled stays settled."
      >
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">Collector</dt>
          <dd className="font-mono text-xs text-slate-900">{wallet.collectorUserId}</dd>
          <dt className="text-slate-500">Status</dt>
          <dd>
            <Badge tone={overdue ? "brand" : "neutral"}>{walletStatusLabel(wallet)}</Badge>
            {wallet.frozenReason === null ? null : (
              <span className="ml-2 text-slate-600">reason: {wallet.frozenReason}</span>
            )}
          </dd>
          <dt className="text-slate-500">Float held</dt>
          <dd className="text-slate-900">
            {formatMoneyMinor(wallet.balanceMinor, props.currency, props.numberFormat)}
          </dd>
          <dt className="text-slate-500">Open intakes</dt>
          <dd className="text-slate-900">
            {formatMoneyMinor(wallet.openIntakeTotalMinor, props.currency, props.numberFormat)}
          </dd>
          <dt className="text-slate-500">Overdue since</dt>
          <dd className="text-slate-900">
            {wallet.overdueSince === null
              ? "—"
              : formatTimestamp(wallet.overdueSince, props.numberFormat, props.timezone)}
          </dd>
        </dl>
        {canFreeze || canUnfreeze ? (
          <WalletTransition
            collectorUserId={wallet.collectorUserId}
            frozen={wallet.status === "frozen"}
            onDone={refresh}
          />
        ) : null}
      </Card>

      {canIntake ? (
        <TakeCashForm
          collectorUserId={wallet.collectorUserId}
          currency={props.currency}
          onDone={refresh}
        />
      ) : null}

      <Card title="Intakes" description="Newest first; a matched intake has a deposit behind it.">
        {intakes.length === 0 ? (
          <EmptyState message="This collector has not taken cash yet." />
        ) : (
          <IntakeTable
            intakes={intakes}
            numberFormat={props.numberFormat}
            timezone={props.timezone}
          />
        )}
      </Card>

      {canReadDeposits ? (
        <Card
          title="Deposits"
          description="A deposit only moves the ledger when it covers open intakes."
        >
          {depositRows.length === 0 ? (
            <EmptyState message="No deposits have arrived for this collector." />
          ) : (
            <DepositTable
              deposits={depositRows}
              numberFormat={props.numberFormat}
              timezone={props.timezone}
            />
          )}
          {canMatch ? (
            <MatchDepositForm
              suspense={candidates.suspense}
              open={candidates.open}
              numberFormat={props.numberFormat}
              onDone={refresh}
            />
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

async function fetchWalletDetail(
  collectorUserId: string,
): Promise<{ readonly wallet: CashWalletView; readonly intakes: readonly CashIntakeView[] }> {
  const data = await unwrap(
    api.GET("/v1/cash/wallets/{collectorUserId}", {
      params: { path: { collectorUserId }, query: { limit: String(PAGE_SIZE) } },
    }),
  );
  const payload = data as {
    wallet: CashWalletView;
    intakes: readonly CashIntakeView[];
  };
  return { wallet: payload.wallet, intakes: payload.intakes };
}

async function fetchDeposits(collectorUserId: string): Promise<readonly CashDepositView[]> {
  const data = await unwrap(
    api.GET("/v1/cash/deposits", {
      params: { query: { collectorUserId, limit: String(PAGE_SIZE) } },
    }),
  );
  return (data as { deposits: readonly CashDepositView[] }).deposits;
}

async function fetchAssets(search: string): Promise<readonly AssetLookupRow[]> {
  const data = await unwrap(
    api.GET("/v1/assets", {
      params: { query: { limit: String(PAGE_SIZE), query: search } },
    }),
  );
  return (data as { assets: readonly AssetLookupRow[] }).assets;
}

function IntakeTable(props: {
  readonly intakes: readonly CashIntakeView[];
  readonly numberFormat: string;
  readonly timezone: string;
}): ReactElement {
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-slate-200 text-slate-500">
          <th className="py-2 pr-4 font-medium">Business day</th>
          <th className="py-2 pr-4 font-medium">Amount</th>
          <th className="py-2 pr-4 font-medium">Receipt</th>
          <th className="py-2 pr-4 font-medium">Status</th>
          <th className="py-2 font-medium">Recorded</th>
        </tr>
      </thead>
      <tbody>
        {props.intakes.map((intake) => (
          <tr key={intake.id} className="border-b border-slate-100">
            <td className="py-2 pr-4 text-slate-700">{intake.businessDate}</td>
            <td className="py-2 pr-4 text-slate-900">
              {formatMoneyMinor(intake.amountMinor, intake.currency, props.numberFormat)}
            </td>
            <td className="py-2 pr-4 font-mono text-xs text-slate-600">{intake.receiptNumber}</td>
            <td className="py-2 pr-4 text-slate-700">{intake.status}</td>
            <td className="py-2 text-slate-600">
              {formatTimestamp(intake.recordedAt, props.numberFormat, props.timezone)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DepositTable(props: {
  readonly deposits: readonly CashDepositView[];
  readonly numberFormat: string;
  readonly timezone: string;
}): ReactElement {
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-slate-200 text-slate-500">
          <th className="py-2 pr-4 font-medium">Provider reference</th>
          <th className="py-2 pr-4 font-medium">Amount</th>
          <th className="py-2 pr-4 font-medium">Status</th>
          <th className="py-2 font-medium">Arrived</th>
        </tr>
      </thead>
      <tbody>
        {props.deposits.map((deposit) => (
          <tr key={deposit.id} className="border-b border-slate-100">
            <td className="py-2 pr-4 font-mono text-xs text-slate-700">
              {deposit.providerReference}
            </td>
            <td className="py-2 pr-4 text-slate-900">
              {formatMoneyMinor(deposit.amountMinor, deposit.currency, props.numberFormat)}
            </td>
            <td className="py-2 pr-4 text-slate-700">{depositStatusLabel(deposit.status)}</td>
            <td className="py-2 text-slate-600">
              {formatTimestamp(deposit.createdAt, props.numberFormat, props.timezone)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MatchDepositForm(props: {
  readonly suspense: readonly CashDepositView[];
  readonly open: readonly CashIntakeView[];
  readonly numberFormat: string;
  readonly onDone: () => Promise<void>;
}): ReactElement {
  const [depositId, setDepositId] = useState("");
  const [intakeId, setIntakeId] = useState("");
  const [busy, setBusy] = useState(false);

  if (props.suspense.length === 0 || props.open.length === 0) {
    return (
      <p className="mt-3 text-xs text-slate-500">
        A manual match needs one suspense deposit and one open intake.
      </p>
    );
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (depositId === "" || intakeId === "") {
      pushToast({ kind: "error", message: "Pick a deposit and an intake to match." });
      return;
    }
    setBusy(true);
    try {
      const result = await unwrap(
        api.POST("/v1/cash/deposits/{id}/match", {
          params: { path: { id: depositId } },
          body: { intakeId },
        }),
      );
      pushToast({
        kind: "success",
        message: `Deposit ${result.outcome}; ${formatMoneyMinor(result.allocatedMinor, result.currency, props.numberFormat)} posted.`,
      });
      await props.onDone();
      setDepositId("");
      setIntakeId("");
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="mt-4 space-y-3" onSubmit={(event) => void submit(event)}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Suspense deposit">
          <select
            aria-label="Suspense deposit"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            value={depositId}
            onChange={(event) => {
              setDepositId(event.currentTarget.value);
            }}
          >
            <option value="">Select a deposit…</option>
            {props.suspense.map((deposit) => (
              <option key={deposit.id} value={deposit.id}>
                {deposit.providerReference} ·{" "}
                {formatMoneyMinor(deposit.amountMinor, deposit.currency, props.numberFormat)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Open intake">
          <select
            aria-label="Open intake"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            value={intakeId}
            onChange={(event) => {
              setIntakeId(event.currentTarget.value);
            }}
          >
            <option value="">Select an intake…</option>
            {props.open.map((intake) => (
              <option key={intake.id} value={intake.id}>
                {intake.businessDate} · {intake.receiptNumber} ·{" "}
                {formatMoneyMinor(intake.amountMinor, intake.currency, props.numberFormat)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? "Matching…" : "Match deposit"}
      </Button>
    </form>
  );
}

function TakeCashForm(props: {
  readonly collectorUserId: string;
  readonly currency: string;
  readonly onDone: () => Promise<void>;
}): ReactElement {
  const { config } = useTenantConfig();
  const [assetId, setAssetId] = useState("");
  // The amount is entered and shown in major units (₦200.00), never as minor
  // units: a collector reading "20000" for ₦200 is a mis-charge waiting to
  // happen. It is converted to minor units only on submit.
  const [amount, setAmount] = useState("");
  const [searchText, setSearchText] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  // The client reference is the intake's idempotency key, generated per intake
  // and rotated after each success. It is not a user field: editing it would
  // break the replay guarantee (ADR 0031).
  const [clientReference, setClientReference] = useState(() =>
    newClientReference(props.collectorUserId),
  );
  const [busy, setBusy] = useState(false);

  const tenantConfig = config?.config;
  const numberFormat = tenantConfig?.locale.numberFormat ?? "en-NG";

  // Search runs on the server: a list of every asset is neither useful nor
  // correct once a state has thousands of them.
  const assets = useQuery({
    queryKey: ["cash-asset-search", appliedSearch],
    queryFn: () => fetchAssets(appliedSearch),
    enabled: appliedSearch.trim() !== "",
  });

  const today = new Date().toISOString().slice(0, 10);
  const assetOptions = useMemo(() => assets.data ?? [], [assets.data]);

  const chooseAsset = (id: string): void => {
    setAssetId(id);
    const asset = assetOptions.find((row) => row.id === id);
    if (asset !== undefined && tenantConfig !== undefined) {
      const minor = prefillAmountMinor(tenantConfig, asset.assetTypeKey, today);
      setAmount(
        minor === undefined
          ? ""
          : formatMajorAmountInput(minor, props.currency, tenantConfig.locale.numberFormat),
      );
    }
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (assetId === "") {
      pushToast({ kind: "error", message: "Search for an asset and pick it first." });
      return;
    }
    const amountMinor = parseMajorToMinor(amount, props.currency, numberFormat);
    if (amountMinor === undefined || amountMinor <= 0n) {
      pushToast({ kind: "error", message: `Enter the amount as ${props.currency}, e.g. 200.00.` });
      return;
    }
    setBusy(true);
    try {
      const result = await unwrap(
        api.POST("/v1/cash/intakes", {
          body: {
            collectorUserId: props.collectorUserId,
            clientReference,
            amountMinor: amountMinor.toString(),
            currency: props.currency,
            assetId,
          },
        }),
      );
      pushToast({
        kind: "success",
        message: result.replayed
          ? `Already recorded: receipt ${result.receiptNumber}.`
          : `Cash recorded. Receipt ${result.receiptNumber}.`,
      });
      await props.onDone();
      // A new reference for the next driver: the old one is now a spent key.
      setClientReference(newClientReference(props.collectorUserId));
      setAssetId("");
      setAmount("");
      setSearchText("");
      setAppliedSearch("");
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Take cash"
      description="Search by short code or plate, pick the vehicle, and the fee fills the amount."
    >
      <form className="space-y-3" onSubmit={(event) => void submit(event)}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Find asset">
            <div className="flex gap-2">
              <TextInput
                name="assetSearch"
                value={searchText}
                onValueChange={setSearchText}
                placeholder="Short code or plate"
              />
              <Button
                type="button"
                onClick={() => {
                  setAppliedSearch(searchText);
                  setAssetId("");
                }}
              >
                Search
              </Button>
            </div>
          </Field>
          <Field
            label="Asset"
            {...(appliedSearch.trim() === ""
              ? { hint: "Search first." }
              : assetOptions.length === 0
                ? { hint: "No asset matches that search." }
                : {})}
          >
            <select
              aria-label="Asset"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              value={assetId}
              onChange={(event) => {
                chooseAsset(event.currentTarget.value);
              }}
            >
              <option value="">Select an asset…</option>
              {assetOptions.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.shortCode} · {assetLabel(asset)}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={`Amount (${props.currency})`}
            hint="Pre-filled from the effective fee rule. Edit only if the fee is different."
          >
            <TextInput name="amount" inputMode="text" value={amount} onValueChange={setAmount} />
          </Field>
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? "Recording…" : "Record cash intake"}
        </Button>
      </form>
    </Card>
  );
}

function WalletTransition(props: {
  readonly collectorUserId: string;
  readonly frozen: boolean;
  readonly onDone: () => Promise<void>;
}): ReactElement {
  const canFreeze = useSession((state) => state.hasPermission("cash:freeze"));
  const canUnfreeze = useSession((state) => state.hasPermission("cash:unfreeze"));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // Unfreezing is finance-only; the button is disabled rather than 403ing.
  const allowed = props.frozen ? canUnfreeze : canFreeze;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (reason.trim() === "") {
      pushToast({ kind: "error", message: "A reason is required." });
      return;
    }
    setBusy(true);
    try {
      await unwrap(
        props.frozen
          ? api.POST("/v1/cash/wallets/{collectorUserId}/unfreeze", {
              params: { path: { collectorUserId: props.collectorUserId } },
              body: { reason },
            })
          : api.POST("/v1/cash/wallets/{collectorUserId}/freeze", {
              params: { path: { collectorUserId: props.collectorUserId } },
              body: { reason },
            }),
      );
      pushToast({
        kind: "success",
        message: `Wallet ${props.frozen ? "unfrozen" : "frozen"}.`,
      });
      await props.onDone();
      setReason("");
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={(event) => void submit(event)}>
      <TextInput
        name="reason"
        value={reason}
        onValueChange={setReason}
        placeholder={`Reason to ${props.frozen ? "unfreeze" : "freeze"}`}
      />
      <Button type="submit" variant="ghost" disabled={busy || !allowed}>
        {props.frozen ? "Unfreeze wallet" : "Freeze wallet"}
      </Button>
      {props.frozen && !allowed ? (
        <span className="text-xs text-slate-500">Only finance can unfreeze.</span>
      ) : null}
    </form>
  );
}
