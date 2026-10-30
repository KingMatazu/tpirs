import type { ReactElement } from "react";
import { Banner, Card, PrimaryButton, Screen } from "../components/ui.js";

/** Done: one receipt number the driver can quote, and the next driver. */
export function DoneScreen(
  props: Readonly<{
    readonly receiptNumber: string;
    readonly replayed: boolean;
    readonly onNext: () => void;
  }>,
): ReactElement {
  return (
    <Screen
      title="Recorded"
      footer={<PrimaryButton onClick={props.onNext}>Next driver</PrimaryButton>}
    >
      <div className="mt-6 flex flex-col items-center gap-2">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 text-3xl text-emerald-700">
          ✓
        </div>
        <p className="text-lg font-semibold text-slate-900">
          {props.replayed ? "Already recorded" : "Cash recorded"}
        </p>
      </div>

      <Card className="text-center">
        <p className="text-sm text-slate-500">Receipt</p>
        <p className="text-xl font-semibold tracking-wide text-slate-900">
          {props.receiptNumber}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          {props.replayed
            ? "This intake was already on the server, so no second receipt was issued."
            : "An SMS receipt goes to the driver from the worker's outbox."}
        </p>
      </Card>

      {props.replayed ? (
        <Banner tone="info">
          A retried submit returns the original receipt. Nothing was charged twice.
        </Banner>
      ) : null}
    </Screen>
  );
}
