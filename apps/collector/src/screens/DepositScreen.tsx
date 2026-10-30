import type { ReactElement } from "react";
import { formatMoneyMinor } from "@tpirs/ui-tokens";
import { Banner, Card, Screen, SecondaryButton } from "../components/ui.js";
import { toBigInt } from "../lib/flow.js";
import { useTenantConfig, useWallet } from "../lib/data.js";

/**
 * Deposit: how much of the cash in hand is still open, where to pay it in, and
 * by when. Matching a deposit is finance's job — this screen never pretends the
 * cash is settled, because only the bank's record can say that.
 */
export function DepositScreen(props: Readonly<{ onBack: () => void }>): ReactElement {
  const config = useTenantConfig();
  const wallet = useWallet();
  const view = wallet.data?.wallet;
  const currency = config?.locale.currency ?? "NGN";
  const numberFormat = config?.locale.numberFormat ?? "en-NG";
  const deadlineHours = config?.cashRules.depositDeadlineHours ?? 24;

  const open = toBigInt(view?.openIntakeTotalMinor);
  const oldest = view?.oldestOpenIntakeAt ?? null;
  const dueAt =
    oldest === null ? undefined : new Date(new Date(oldest).getTime() + deadlineHours * 3_600_000);

  return (
    <Screen title="Deposit cash" onBack={props.onBack} footer={<SecondaryButton onClick={props.onBack}>Done</SecondaryButton>}>
      <Card>
        <p className="text-sm text-slate-500">Open cash to deposit</p>
        <p className="text-2xl font-semibold text-slate-900">
          {formatMoneyMinor(open, currency, numberFormat)}
        </p>
        {dueAt === undefined ? (
          <p className="mt-1 text-xs text-slate-500">Nothing is open right now.</p>
        ) : (
          <p className="mt-1 text-xs text-slate-500">
            Deposit by {dueAt.toLocaleString()} ({deadlineHours} hours after the oldest intake).
          </p>
        )}
      </Card>

      {view?.depositInstruction === null || view === undefined ? (
        <Banner tone="warning">
          No deposit account is provisioned for you yet. Ask finance to set one up before your next
          collection.
        </Banner>
      ) : (
        <Card>
          <p className="text-sm text-slate-500">Pay into</p>
          <p className="text-base font-medium text-slate-900">{view.depositInstruction.provider}</p>
          <p className="mt-1 text-sm text-slate-700">
            Reference:{" "}
            <span className="font-mono text-base tracking-wide">
              {view.depositInstruction.reference}
            </span>
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {view.depositInstruction.kind === "virtual_account"
              ? "This reference is your dedicated account: a transfer to it is matched to you automatically."
              : "Quote this reference in the transfer narration so finance can match the deposit."}
          </p>
        </Card>
      )}

      <Banner tone="info">
        The cash is settled only when the bank's record arrives. Finance matches the deposit and
        restores your float.
      </Banner>
    </Screen>
  );
}
