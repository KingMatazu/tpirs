import { useState, type ReactElement } from "react";
import { copy } from "../copy.js";
import { Banner, Field, PrimaryButton, Screen, inputClass } from "../components/ui.js";
import { prepareEvidence } from "../lib/evidence.js";
import type { Evidence } from "../lib/evidence.js";
import { recordDispute } from "../lib/dispute.js";
import type { DisputeOutcome } from "../lib/dispute.js";

export interface DisputeContext {
  readonly reference?: string;
  readonly assetId?: string;
  readonly shortCode?: string;
}

/**
 * Raising a dispute from a result.
 *
 * The reasons are the tenant's (`field.disputeReasons`), not a list in code: a
 * state that cares about different failures can say so in config. The dispute
 * itself follows the same rule as a scan — generated id, queued when offline,
 * never lost — because an officer who is told "saved" and finds nothing on the
 * dashboard tomorrow has been lied to.
 */
export function DisputeScreen(
  props: Readonly<{
    context: DisputeContext;
    reasons: readonly { readonly code: string; readonly label: string }[];
    maxQueueItems?: number;
    onDone: () => void;
    onBack: () => void;
  }>,
): ReactElement {
  const [reason, setReason] = useState<string | undefined>(undefined);
  const [description, setDescription] = useState("");
  const [evidence, setEvidence] = useState<Evidence | undefined>(undefined);
  const [photoDropped, setPhotoDropped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<DisputeOutcome | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = async (): Promise<void> => {
    if (reason === undefined) {
      setError(copy.dispute.needReason);
      return;
    }
    if (description.trim() === "") {
      setError(copy.dispute.needDescription);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await recordDispute({
        clientDisputeId: globalThis.crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        reason,
        description: description.trim(),
        ...(props.context.reference === undefined ? {} : { reference: props.context.reference }),
        ...(props.context.assetId === undefined ? {} : { assetId: props.context.assetId }),
        ...(evidence === undefined ? {} : { evidence }),
        ...(props.maxQueueItems === undefined ? {} : { maxQueueItems: props.maxQueueItems }),
      });
      setOutcome(result);
    } finally {
      setBusy(false);
    }
  };

  if (outcome !== undefined) {
    return (
      <Screen
        title={copy.dispute.title}
        footer={<PrimaryButton onClick={props.onDone}>{copy.dispute.done}</PrimaryButton>}
      >
        <Banner tone={outcome.status === "rejected" ? "danger" : "success"}>
          {describe(outcome)}
        </Banner>
        <p className="text-base text-slate-700">
          {props.context.shortCode ?? props.context.reference ?? copy.result.unknownReference}
        </p>
      </Screen>
    );
  }

  return (
    <Screen
      title={copy.dispute.title}
      onBack={props.onBack}
      footer={
        <PrimaryButton disabled={busy} onClick={() => void submit()}>
          {busy ? copy.dispute.submitting : copy.dispute.submit}
        </PrimaryButton>
      }
    >
      <p className="text-base text-slate-700">
        {copy.dispute.for}{" "}
        <span className="font-semibold">
          {props.context.shortCode ?? props.context.reference ?? copy.result.unknownReference}
        </span>
      </p>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-base font-medium text-slate-800">
          {copy.dispute.reasonLabel}
        </legend>
        {props.reasons.map((option) => (
          <button
            key={option.code}
            type="button"
            onClick={() => {
              setReason(option.code);
              setError(undefined);
            }}
            aria-pressed={reason === option.code}
            className={`min-h-12 rounded-xl px-4 text-left text-base font-medium ${
              reason === option.code
                ? "bg-slate-900 text-white"
                : "border-2 border-slate-400 bg-white text-slate-900"
            }`}
          >
            {option.label}
          </button>
        ))}
      </fieldset>

      <Field label={copy.dispute.descriptionLabel} hint={copy.dispute.descriptionHint}>
        <textarea
          className={`${inputClass} min-h-28`}
          value={description}
          onChange={(event) => {
            setDescription(event.currentTarget.value);
          }}
        />
      </Field>

      <Field label={copy.dispute.photoLabel} hint={copy.dispute.photoHint}>
        <input
          className="block w-full text-base text-slate-700"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file === undefined) return;
            setPhotoDropped(false);
            void prepareEvidence(file).then((prepared) => {
              setEvidence(prepared);
              setPhotoDropped(prepared === undefined);
            });
          }}
        />
      </Field>

      {photoDropped ? <Banner tone="warning">{copy.dispute.photoTooLarge}</Banner> : null}
      {error === undefined ? null : <Banner tone="danger">{error}</Banner>}
    </Screen>
  );
}

function describe(outcome: DisputeOutcome): string {
  switch (outcome.status) {
    case "recorded":
      return copy.dispute.recorded;
    case "queued":
      return copy.dispute.queued;
    case "queue_full":
      return copy.dispute.queueFull;
    case "rejected":
      return copy.dispute.rejected;
  }
}
