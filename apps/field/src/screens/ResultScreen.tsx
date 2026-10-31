import type { ReactElement } from "react";
import { copy } from "../copy.js";
import { Banner, Card, PrimaryButton, Screen, SecondaryButton } from "../components/ui.js";
import type { ScanView, Verdict } from "../lib/scan-result.js";

/**
 * The result card.
 *
 * Every state is a statement about the *record*, never about the driver, and the
 * card always says where the answer came from: the ledger ("recorded") or this
 * phone's cache ("will sync"). Under pay-per-use a day without a payment is not a
 * debt, so nothing here may call a vehicle unpaid — a test asserts the word never
 * appears.
 */
export function ResultScreen(
  props: Readonly<{
    view: ScanView;
    smsKeyword: string | undefined;
    smsSenderId: string | undefined;
    onScanAgain: () => void;
    onBack: () => void;
    /** Absent when the tenant has disputes switched off, or there is no vehicle. */
    onDispute?: (() => void) | undefined;
  }>,
): ReactElement {
  const { view } = props;
  const tone = describe(view.verdict);

  return (
    <Screen
      title={copy.result.title}
      onBack={props.onBack}
      footer={<PrimaryButton onClick={props.onScanAgain}>{copy.result.scanAgain}</PrimaryButton>}
    >
      <section
        className={`rounded-xl p-5 text-center ${tone.background}`}
        role="status"
        aria-live="polite"
      >
        <p className={`text-2xl font-bold ${tone.text}`}>{tone.heading}</p>
        <p className={`mt-1 text-base ${tone.text}`}>{tone.detail}</p>
      </section>

      {view.recorded === "queued" ? <Banner tone="info">{copy.result.queued}</Banner> : null}
      {view.corrected ? <Banner tone="warning">{copy.result.corrected}</Banner> : null}

      <Card>
        <dl className="grid grid-cols-2 gap-2 text-base">
          <dt className="text-slate-600">{copy.result.reference}</dt>
          <dd className="text-right font-semibold text-slate-900">
            {view.shortCode ?? copy.result.unknownReference}
          </dd>
          {attributeRows(view.attributes).map(([label, value]) => (
            <Row key={label} label={label} value={value} />
          ))}
          <dt className="text-slate-600">{copy.result.businessDate}</dt>
          <dd className="text-right font-semibold text-slate-900">
            {view.businessDate ?? copy.result.unknownDate}
          </dd>
        </dl>
      </Card>

      {needsSmsCheck(view) ? (
        <Banner tone="info">
          {props.smsKeyword === undefined || props.smsSenderId === undefined
            ? copy.result.smsFallbackNoConfig
            : copy.result.smsFallback
                .replace("{keyword}", props.smsKeyword)
                .replace("{sender}", props.smsSenderId)
                .replace("{reference}", view.shortCode ?? copy.result.unknownReference)}
        </Banner>
      ) : null}

      {view.verdict === "unreadable" ? (
        <Banner tone="warning">{copy.result.unreadableHint}</Banner>
      ) : null}

      {props.onDispute === undefined ? null : (
        <SecondaryButton onClick={props.onDispute}>{copy.result.dispute}</SecondaryButton>
      )}
    </Screen>
  );
}

/** The SMS check is offered whenever the phone is unsure, not when it confirmed. */
function needsSmsCheck(view: ScanView): boolean {
  return view.verdict === "not_in_offline_list" || view.verdict === "unknown";
}

function Row(props: Readonly<{ label: string; value: string }>): ReactElement {
  return (
    <>
      <dt className="text-slate-600">{props.label}</dt>
      <dd className="text-right font-semibold text-slate-900">{props.value}</dd>
    </>
  );
}

/** Tenant attribute keys are snake_case; the officer sees them as words. */
function attributeRows(
  attributes: Readonly<Record<string, unknown>> | undefined,
): readonly (readonly [string, string])[] {
  if (attributes === undefined) return [];
  return Object.entries(attributes)
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .slice(0, 4)
    .map(([key, value]) => [humanise(key), String(value)] as const);
}

function humanise(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function describe(verdict: Verdict): {
  readonly heading: string;
  readonly detail: string;
  readonly background: string;
  readonly text: string;
} {
  switch (verdict) {
    case "paid":
      return {
        heading: copy.result.paidHeading,
        detail: copy.result.paidDetail,
        background: "bg-emerald-600",
        text: "text-white",
      };
    case "no_payment_recorded":
      return {
        heading: copy.result.noPaymentHeading,
        detail: copy.result.noPaymentDetail,
        background: "bg-slate-200",
        text: "text-slate-900",
      };
    case "not_in_offline_list":
      return {
        heading: copy.result.notInListHeading,
        detail: copy.result.notInListDetail,
        background: "bg-slate-200",
        text: "text-slate-900",
      };
    case "unknown":
      return {
        heading: copy.result.unknownHeading,
        detail: copy.result.unknownDetail,
        background: "bg-slate-200",
        text: "text-slate-900",
      };
    case "unreadable":
      return {
        heading: copy.result.unreadableHeading,
        detail: copy.result.unreadableDetail,
        background: "bg-slate-200",
        text: "text-slate-900",
      };
  }
}
