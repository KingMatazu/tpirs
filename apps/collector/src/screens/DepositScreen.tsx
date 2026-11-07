import { useEffect, useState, type ReactElement } from "react";
import { formatMoneyMinor } from "@tpirs/ui-tokens";
import { Banner, Card, Screen, SecondaryButton } from "../components/ui.js";
import { toBigInt } from "../lib/flow.js";
import { useTenantConfig, useWallet } from "../lib/data.js";

/**
 * Funding the float.
 *
 * Prepaid (ADR 0069): the collector transfers any amount to the terminal's
 * dedicated account; this screen shows the number, a copy button and the credit
 * left, and refreshes while it is open so an arriving transfer appears within
 * seconds. It never invents an amount — the bank transfer is the decision.
 *
 * Postpaid: the same screen explains the cash still open and where to deposit
 * it, which is the Phase 7 flow.
 */
export function DepositScreen(props: Readonly<{ onBack: () => void }>): ReactElement {
  const config = useTenantConfig();
  const wallet = useWallet();
  const view = wallet.data?.wallet;
  const currency = config?.locale.currency ?? "NGN";
  const numberFormat = config?.locale.numberFormat ?? "en-NG";
  const deadlineHours = config?.cashRules.depositDeadlineHours ?? 24;
  const prepaid = view?.model === "prepaid";
  const [copied, setCopied] = useState(false);

  // The webhook credits in the same request that receives it; this poll is what
  // turns that into a number the collector sees while standing there.
  useEffect(() => {
    if (!prepaid) return undefined;
    const timer = setInterval(() => {
      void wallet.refetch();
    }, 5_000);
    return () => {
      clearInterval(timer);
    };
  }, [prepaid, wallet.refetch]);

  const open = toBigInt(view?.openIntakeTotalMinor);
  const oldest = view?.oldestOpenIntakeAt ?? null;
  const dueAt =
    oldest === null ? undefined : new Date(new Date(oldest).getTime() + deadlineHours * 3_600_000);
  const instruction = view?.depositInstruction ?? null;
  const accountNumber = instruction?.accountNumber ?? null;
  const pageUrl = instruction?.pageUrl ?? null;
  const credit = toBigInt(view?.balanceMinor) < 0n ? -toBigInt(view?.balanceMinor) : 0n;

  const copy = async (): Promise<void> => {
    if (accountNumber === null) return;
    try {
      await navigator.clipboard.writeText(accountNumber);
      setCopied(true);
      globalThis.setTimeout(() => {
        setCopied(false);
      }, 2_000);
    } catch {
      // A phone that refuses clipboard access can still read the number.
    }
  };

  return (
    <Screen
      title={prepaid ? "Fund wallet" : "Deposit cash"}
      onBack={props.onBack}
      footer={<SecondaryButton onClick={props.onBack}>Done</SecondaryButton>}
    >
      {prepaid ? (
        <Card>
          <p className="text-sm text-slate-500">Float available</p>
          <p className="text-2xl font-semibold text-slate-900">
            {formatMoneyMinor(toBigInt(view.availableMinor), currency, numberFormat)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Credit held: {formatMoneyMinor(credit, currency, numberFormat)}
            {view.maxBalanceMinor === null || view.maxBalanceMinor === undefined
              ? null
              : ` of a ${formatMoneyMinor(toBigInt(view.maxBalanceMinor), currency, numberFormat)} maximum`}
          </p>
        </Card>
      ) : (
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
      )}

      {instruction === null || view === undefined ? (
        <Banner tone="warning">
          No funding account is provisioned for you yet. Ask finance to set one up before your next
          collection.
        </Banner>
      ) : (
        <Card>
          <p className="text-sm text-slate-500">
            {accountNumber === null ? "Open your payment page" : "Transfer to"}
          </p>
          {instruction.accountName === null || instruction.accountName === undefined ? null : (
            <p className="text-base font-medium text-slate-900">{instruction.accountName}</p>
          )}
          {accountNumber === null ? null : (
            <>
              <p className="mt-1 font-mono text-2xl font-semibold tracking-wide text-slate-900">
                {accountNumber}
              </p>
              {instruction.bank === null || instruction.bank === undefined ? null : (
                <p className="text-sm text-slate-600">{instruction.bank}</p>
              )}
              <button
                type="button"
                onClick={() => {
                  void copy();
                }}
                className="mt-3 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white active:bg-slate-700"
              >
                {copied ? "Copied" : "Copy account number"}
              </button>
            </>
          )}
          {accountNumber === null && pageUrl !== null ? (
            <a
              href={pageUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block text-sm font-medium text-slate-900 underline"
            >
              Open the payment page
            </a>
          ) : null}
          <p className="mt-3 text-xs text-slate-500">
            {prepaid
              ? "Transfer any amount from your bank app. It appears here within a minute and can be used straight away."
              : instruction.kind === "virtual_account"
                ? "Transfers to this account are matched to you automatically."
                : "Quote this reference in the transfer narration so finance can match the deposit."}
          </p>
        </Card>
      )}

      {prepaid ? (
        <Banner tone="info">
          The transfer is credited gross. The gateway fee is the State&apos;s, not yours.
        </Banner>
      ) : (
        <Banner tone="info">
          The cash is settled only when the bank&apos;s record arrives. Finance matches the deposit
          and restores your float.
        </Banner>
      )}
    </Screen>
  );
}
