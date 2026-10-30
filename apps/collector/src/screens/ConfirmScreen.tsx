import { useEffect, useState, type ReactElement } from "react";
import { formatMajorAmountInput, formatMoneyMinor, parseMajorToMinor } from "@tpirs/ui-tokens";
import { api } from "../api/client.js";
import {
  Banner,
  Card,
  Field,
  PrimaryButton,
  Screen,
  SecondaryButton,
  inputClass,
} from "../components/ui.js";
import { decideCollect } from "../lib/flow.js";
import { businessDateFor, resolveFeeMinor, useTenantConfig, useWallet } from "../lib/data.js";
import { plateOf, type FoundAsset } from "./FindScreen.js";

/**
 * Confirm: the amount, today's status, and whether cash may be taken. The
 * decision comes from `decideCollect` so the same rules drive the tests; the
 * server enforces them again on the intake.
 */
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
  const [amount, setAmount] = useState("");
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
      if (fee !== undefined) {
        setAmount(formatMajorAmountInput(fee, currency, numberFormat));
      }
    });
  }, [config, props.asset.assetTypeKey, today, currency, numberFormat]);

  const decision = decideCollect({
    wallet: wallet.data?.wallet,
    paymentStatus: props.asset.paymentStatus,
    feeMinor: feeMinor ?? 0n,
    online,
  });

  // What the button will send: the edited amount when it parses, else the rule.
  const typedMinor = parseMajorToMinor(amount, currency, numberFormat);
  const displayMinor = typedMinor ?? feeMinor ?? 0n;

  const submit = async (): Promise<void> => {
    const minor = parseMajorToMinor(amount, currency, numberFormat);
    if (minor === undefined || minor <= 0n) {
      setError(`Enter the amount as ${currency}, e.g. 200.00.`);
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
          amountMinor: minor.toString(),
          currency,
          // Minted per intake: the server treats it as the idempotency key, so a
          // retry returns the same receipt instead of taking cash twice.
          clientReference: `collector-${collectorUserId}-${crypto.randomUUID()}`,
        },
      });
      if (!result.response.ok) {
        setError("The server refused the intake. Check the amount and try again.");
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
                <span className="rounded bg-emerald-50 px-2 py-0.5 text-emerald-800">Paid today</span>
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
          hint="Pre-filled from the tenant's fee rule. Edit only if the fee is different."
          {...(error === undefined ? {} : { error })}
        >
          <input
            className={inputClass}
            inputMode="text"
            value={amount}
            onChange={(event) => { setAmount(event.currentTarget.value); }}
          />
        </Field>
        {feeMinor === undefined ? (
          <p className="mt-2 text-xs text-amber-900">No fee rule matches this vehicle today.</p>
        ) : (
          <p className="mt-2 text-xs text-slate-500">
            Rule amount: {formatMoneyMinor(feeMinor, currency, numberFormat)}
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
          floatLeft={formatMoneyMinor(decision.floatLeftMinor, currency, numberFormat)}
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
  }>,
): ReactElement {
  if (props.reason === "already_paid") {
    return <Banner tone="success">Already paid today. No cash needed.</Banner>;
  }
  if (props.reason === "frozen") {
    return <Banner tone="danger">Wallet frozen. Finance must unfreeze it.</Banner>;
  }
  if (props.reason === "float_low") {
    return (
      <Banner tone="danger">
        Float too low ({props.floatLeft} in hand). Deposit cash to keep collecting.
        <button type="button" onClick={props.onDeposit} className="mt-2 block underline">
          Deposit cash
        </button>
      </Banner>
    );
  }
  if (props.reason === "offline") {
    return <Banner tone="warning">No connection. Cash cannot be recorded yet.</Banner>;
  }
  return <Banner tone="warning">This vehicle cannot take a payment right now.</Banner>;
}
