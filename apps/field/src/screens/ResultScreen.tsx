import type { ReactElement } from "react";
import { copy } from "../copy.js";
import { Banner, Card, PrimaryButton, Screen } from "../components/ui.js";
import type { ScanOutcome } from "../lib/scan.js";

/**
 * The result card.
 *
 * Three states, three colours, and never the word "unpaid". `not_in_offline_list`
 * is neutral on purpose: the phone's cache cannot prove a negative, so the card
 * says what it does not know and hands the officer a way to check.
 */
export function ResultScreen(
  props: Readonly<{
    outcome: ScanOutcome;
    smsKeyword: string | undefined;
    smsSenderId: string | undefined;
    onScanAgain: () => void;
    onBack: () => void;
  }>,
): ReactElement {
  const { outcome } = props;
  const view = describe(outcome.kind);

  return (
    <Screen
      title={copy.result.title}
      onBack={props.onBack}
      footer={<PrimaryButton onClick={props.onScanAgain}>{copy.result.scanAgain}</PrimaryButton>}
    >
      <section
        className={`rounded-xl p-5 text-center ${view.background}`}
        role="status"
        aria-live="polite"
      >
        <p className={`text-2xl font-bold ${view.text}`}>{view.heading}</p>
        <p className={`mt-1 text-base ${view.text}`}>{view.detail}</p>
      </section>

      <Card>
        <dl className="grid grid-cols-2 gap-2 text-base">
          <dt className="text-slate-600">{copy.result.reference}</dt>
          <dd className="text-right font-semibold text-slate-900">
            {outcome.shortCode ?? copy.result.unknownReference}
          </dd>
          {attributeRows(outcome.attributes).map(([label, value]) => (
            <Row key={label} label={label} value={value} />
          ))}
          <dt className="text-slate-600">{copy.result.businessDate}</dt>
          <dd className="text-right font-semibold text-slate-900">
            {outcome.businessDate ?? copy.result.unknownDate}
          </dd>
        </dl>
      </Card>

      {outcome.kind === "not_in_offline_list" ? (
        <Banner tone="info">
          {props.smsKeyword === undefined || props.smsSenderId === undefined
            ? copy.result.smsFallbackNoConfig
            : copy.result.smsFallback
                .replace("{keyword}", props.smsKeyword)
                .replace("{sender}", props.smsSenderId)
                .replace("{reference}", outcome.shortCode ?? copy.result.unknownReference)}
        </Banner>
      ) : null}

      {outcome.kind === "unreadable" ? (
        <Banner tone="warning">{copy.result.unreadableHint}</Banner>
      ) : null}
    </Screen>
  );
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

function describe(kind: ScanOutcome["kind"]): {
  readonly heading: string;
  readonly detail: string;
  readonly background: string;
  readonly text: string;
} {
  switch (kind) {
    case "paid":
      return {
        heading: copy.result.paidHeading,
        detail: copy.result.paidDetail,
        background: "bg-emerald-600",
        text: "text-white",
      };
    case "not_in_offline_list":
      return {
        heading: copy.result.notInListHeading,
        detail: copy.result.notInListDetail,
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
