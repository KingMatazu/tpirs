import { useEffect, useState, type ReactElement } from "react";
import { formatMoneyMinor } from "@tpirs/ui-tokens";
import { api } from "../api/client.js";
import { Banner, Card, Field, PrimaryButton, Screen, SecondaryButton } from "../components/ui.js";
import { decideCollect } from "../lib/flow.js";
import { businessDateFor, resolveFeeMinor, useTenantConfig, useWallet } from "../lib/data.js";
import { plateOf, type FoundAsset } from "./FindScreen.js";

/**
 * Confirm: today's fee, today's status, and whether cash may be taken. The
 * decision comes from `decideCollect` so the same rules drive the tests; the
 * server enforces them again on the intake.
 *
 * The amount is **not** a field. The fee is the tenant's, resolved with the same
 * engine the API checks against, and the API refuses any other amount
 * (`amount_mismatch`). An editable box could therefore only produce a rejection
 * with the driver standing at the bike; the state changes a fee by changing its
 * fee rule, not by a collector retyping it.
 */
/**
 * Cash refusals the collector can act on. The API's message is written for an
 * operator ("collector wallet is frozen: unspecified"), so the codes a collector
 * will actually meet get plain words; anything else falls back to the server's
 * sentence rather than hiding it.
 */
function cashMessage(code: string | undefined, message: string | undefined): string {
  switch (code) {
    case "wallet_frozen":
      return "Your wallet is frozen. Speak to your supervisor before taking more cash.";
    case "ceiling_exceeded":
      return "That would take you over your float ceiling. Deposit before taking more cash.";
    case "insufficient_float":
      return "Your wallet float is finished. Fund the wallet before taking more cash.";
    case "already_paid":
      return "This vehicle is already paid for today.";
    case "cash_disabled":
      return "Cash intake is switched off for this state.";
    case "amount_mismatch":
      return "The amount does not match today's fee.";
    default:
      return message ?? "The server refused the intake. Check the amount and try again.";
  }
}

export function ConfirmScreen(
  props: Readonly<{
    readonly asset: FoundAsset;
    readonly onBack: () => void;
    readonly onDone: (receipt: { receiptNumber: string; replayed: boolean }) => void;
    readonly onDeposit: () => void;
  }>,
): ReactElement {
  const config = useTenantConfig();
  const wallet = useWallet();
  const [feeMinor, setFeeMinor] = useState<bigint | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [online, setOnline] = useState(() => globalThis.navigator.onLine);

  const currency = config?.locale.currency ?? "NGN";
  const numberFormat = config?.locale.numberFormat ?? "en-NG";
  const today = businessDateFor(config);

  useEffect(() => {
    const on = (): void => {
      setOnline(true);
    };
    const off = (): void => {
      setOnline(false);
    };
    globalThis.addEventListener("online", on);
    globalThis.addEventListener("offline", off);
    return () => {
      globalThis.removeEventListener("online", on);
      globalThis.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    if (config === undefined) return;
    void resolveFeeMinor(config, props.asset.assetTypeKey, today).then((fee) => {
      setFeeMinor(fee);
    });
  }, [config, props.asset.assetTypeKey, today]);

  const decision = decideCollect({
    wallet: wallet.data?.wallet,
    paymentStatus: props.asset.paymentStatus,
    feeMinor: feeMinor ?? 0n,
    online,
  });

  const displayMinor = feeMinor ?? 0n;

  const submit = async (): Promise<void> => {
    // The decision already refuses a day the tenant has not priced, so this
    // guard only covers a fee that arrived after the render.
    if (feeMinor === undefined || feeMinor <= 0n) {
      setError("No fee is set for this vehicle today, so there is nothing to collect.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const collectorUserId = wallet.data?.wallet.collectorUserId ?? "";
      const result = await api.POST("/v1/cash/intakes", {
        body: {
          collectorUserId,
          assetId: props.asset.assetId,
          amountMinor: feeMinor.toString(),
          currency,
          // Minted per intake: the server treats it as the idempotency key, so a
          // retry returns the same receipt instead of taking cash twice.
          clientReference: `collector-${collectorUserId}-${crypto.randomUUID()}`,
        },
      });
      if (!result.response.ok) {
        // openapi-fetch puts a non-2xx body in `error`. The cash service explains
        // itself with a code ("wallet_frozen", "ceiling_exceeded", "already_paid"),
        // and a collector needs that reason, not "the server refused".
        const body = (result.error ?? result.data) as
          { error?: { code?: string; message?: string } } | undefined;
        setError(cashMessage(body?.error?.code, body?.error?.message));
        return;
      }
      const body = result.data as { receiptNumber?: string; replayed?: boolean } | undefined;
      props.onDone({
        receiptNumber: body?.receiptNumber ?? "—",
        replayed: body?.replayed ?? false,
      });
    } catch {
      setError("No connection. Cash cannot be recorded until the phone is back online.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title="Confirm"
      onBack={props.onBack}
      footer={
        decision.allowed ? (
          <PrimaryButton onClick={() => void submit()} disabled={busy}>
            {busy
              ? "Recording…"
              : `Cash received ${formatMoneyMinor(displayMinor, currency, numberFormat)}`}
          </PrimaryButton>
        ) : (
          <SecondaryButton onClick={props.onBack}>Back</SecondaryButton>
        )
      }
    >
      <Card>
        <div className="flex items-center gap-3">
          <div className="h-14 w-14 rounded-lg bg-slate-200" aria-hidden={true} />
          <div>
            <p className="text-lg font-semibold text-slate-900">
              {plateOf(props.asset) ?? props.asset.shortCode}
            </p>
            <p className="text-sm text-slate-500">{props.asset.assetTypeKey}</p>
            <p className="mt-1 text-xs">
              {props.asset.paymentStatus === "paid" ? (
                <span className="rounded bg-emerald-50 px-2 py-0.5 text-emerald-800">
                  Paid today
                </span>
              ) : (
                <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-900">
                  No payment recorded today
                </span>
              )}
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <Field
          label={`Fee today (${currency})`}
          hint="Set by the state for this vehicle type. It cannot be changed here."
          {...(error === undefined ? {} : { error })}
        >
          <p className="text-2xl font-semibold tracking-wide text-slate-900">
            {feeMinor === undefined ? "—" : formatMoneyMinor(feeMinor, currency, numberFormat)}
          </p>
        </Field>
        {feeMinor === undefined ? (
          <p className="mt-2 text-xs text-amber-900">No fee rule matches this vehicle today.</p>
        ) : (
          <p className="mt-2 text-xs text-slate-500">
            The same amount is checked again by the server when the cash is recorded.
          </p>
        )}
      </Card>

      {decision.allowed ? (
        <>
          <p className="text-center text-sm text-slate-500">The driver gets an SMS receipt.</p>
          <p className="text-center text-xs text-slate-500">
            Cash in hand after this:{" "}
            {formatMoneyMinor(decision.floatLeftMinor + displayMinor, currency, numberFormat)}
          </p>
        </>
      ) : (
        <BlockedBanner
          reason={decision.reason}
          onDeposit={props.onDeposit}
          floatLeft={formatMoneyMinor(decision.availableMinor, currency, numberFormat)}
          prepaid={wallet.data?.wallet.model === "prepaid"}
        />
      )}
    </Screen>
  );
}

function BlockedBanner(
  props: Readonly<{
    reason: ReturnType<typeof decideCollect>["reason"];
    onDeposit: () => void;
    floatLeft: string;
    prepaid: boolean;
  }>,
): ReactElement {
  if (props.reason === "already_paid") {
    return <Banner tone="success">Already paid today. No cash needed.</Banner>;
  }
  if (props.reason === "no_fee") {
    return (
      <Banner tone="warning">
        No fee is set for this vehicle today, so there is nothing to collect.
      </Banner>
    );
  }
  if (props.reason === "frozen") {
    return <Banner tone="danger">Wallet frozen. Finance must unfreeze it.</Banner>;
  }
  if (props.reason === "float_low") {
    return (
      <Banner tone="danger">
        Float too low ({props.floatLeft} available).{" "}
        {props.prepaid ? "Fund the wallet to keep collecting." : "Deposit cash to keep collecting."}
        <button type="button" onClick={props.onDeposit} className="mt-2 block underline">
          {props.prepaid ? "Fund wallet" : "Deposit cash"}
        </button>
      </Banner>
    );
  }
  if (props.reason === "offline") {
    return <Banner tone="warning">No connection. Cash cannot be recorded yet.</Banner>;
  }
  return <Banner tone="warning">This vehicle cannot take a payment right now.</Banner>;
}
