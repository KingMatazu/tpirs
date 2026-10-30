import { useMemo, type ReactElement } from "react";
import { formatMoneyMinor } from "@tpirs/ui-tokens";
import { Banner, Card, PrimaryButton, Screen, SecondaryButton } from "../components/ui.js";
import { floatPercent, toBigInt } from "../lib/flow.js";
import { businessDateFor, useTenantConfig, useWallet } from "../lib/data.js";

/**
 * Home: what the collector needs before knocking on a driver's window — how much
 * cash they are carrying, what they have taken today, and whether the wallet is
 * still allowed to take more.
 */
export function HomeScreen(
  props: Readonly<{
    onCollect: () => void;
    onDeposit: () => void;
    onSignOut: () => void;
  }>,
): ReactElement {
  const config = useTenantConfig();
  const wallet = useWallet();
  const numberFormat = config?.locale.numberFormat ?? "en-NG";
  const currency = config?.locale.currency ?? "NGN";
  const today = businessDateFor(config);

  const todayIntakes = useMemo(
    () => (wallet.data?.intakes ?? []).filter((intake) => intake.businessDate === today),
    [wallet.data, today],
  );
  const collectedToday = todayIntakes.reduce(
    (sum, intake) => sum + toBigInt(intake.amountMinor),
    0n,
  );

  const view = wallet.data?.wallet;
  const percent = floatPercent(view);
  const ceiling = view?.floatCeilingMinor ?? null;
  const frozen = view?.status === "frozen";

  return (
    <Screen
      title={config?.identity.name ?? "Collector"}
      footer={
        <PrimaryButton onClick={props.onCollect} disabled={frozen}>
          Collect fee
        </PrimaryButton>
      }
    >
      {frozen ? (
        <Banner tone="danger">
          Wallet frozen{view.frozenReason === null ? "" : `: ${view.frozenReason}`}. Finance must
          unfreeze it before you take more cash.
        </Banner>
      ) : null}

      <Card>
        <p className="text-sm text-slate-500">Cash in hand</p>
        <p className="text-2xl font-semibold text-slate-900">
          {formatMoneyMinor(toBigInt(view?.balanceMinor), currency, numberFormat)}
          {ceiling === null ? null : (
            <span className="ml-1 text-base font-normal text-slate-500">
              of {formatMoneyMinor(toBigInt(ceiling), currency, numberFormat)}
            </span>
          )}
        </p>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
          <div className="h-2 rounded-full bg-slate-900" style={{ width: `${percent}%` }} />
        </div>
        {view === undefined || view.oldestOpenIntakeAt === null ? null : (
          <p className="mt-2 text-xs text-slate-500">
            Oldest intake still open: {new Date(view.oldestOpenIntakeAt).toLocaleString()}
          </p>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Card>
          <p className="text-sm text-slate-500">Collected today</p>
          <p className="text-lg font-semibold text-slate-900">
            {formatMoneyMinor(collectedToday, currency, numberFormat)}
          </p>
        </Card>
        <Card>
          <p className="text-sm text-slate-500">Drivers today</p>
          <p className="text-lg font-semibold text-slate-900">{todayIntakes.length}</p>
        </Card>
      </div>

      <SecondaryButton onClick={props.onDeposit}>
        Deposit cash
        {toBigInt(view?.openIntakeTotalMinor) > 0n
          ? ` · ${formatMoneyMinor(toBigInt(view?.openIntakeTotalMinor), currency, numberFormat)} open`
          : ""}
      </SecondaryButton>

      <button
        type="button"
        onClick={props.onSignOut}
        className="mt-2 text-sm font-medium text-slate-500 underline"
      >
        Sign out
      </button>
    </Screen>
  );
}
