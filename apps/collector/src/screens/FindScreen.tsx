import { useState, type ReactElement } from "react";
import { api } from "../api/client.js";
import { Banner, Field, PrimaryButton, Screen, inputClass } from "../components/ui.js";

export interface FoundAsset {
  readonly assetId: string;
  readonly assetTypeKey: string;
  readonly status: string;
  readonly shortCode: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly paymentStatus: "paid" | "no_payment_recorded" | "unknown";
  readonly businessDate: string;
}

/**
 * Find a vehicle by short code or plate. The search runs on the server and comes
 * back with today's payment status, so the collector sees "already paid" before
 * asking for cash rather than after.
 */
export function FindScreen(
  props: Readonly<{
    onBack: () => void;
    onFound: (asset: FoundAsset) => void;
  }>,
): ReactElement {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [results, setResults] = useState<readonly FoundAsset[]>([]);

  const search = async (): Promise<void> => {
    const trimmed = query.trim();
    if (trimmed === "") {
      setError("Type a short code or plate first.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const response = await api.GET("/v1/verifications/search", {
        params: { query: { q: trimmed } },
      });
      if (!response.response.ok) {
        setError("Search failed. Check the connection and try again.");
        setResults([]);
        return;
      }
      const found = (response.data as { results?: readonly FoundAsset[] } | undefined)?.results ?? [];
      setResults(found);
      if (found.length === 0) setError("No vehicle matches that code or plate.");
    } catch {
      setError("Search failed. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Find vehicle" onBack={props.onBack}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <Field label="Short code or plate" {...(error === undefined ? {} : { error })}>
          <input
            className={inputClass}
            value={query}
            onChange={(event) => { setQuery(event.currentTarget.value); }}
            placeholder="B000001 or MTZ56AA"
            autoFocus
          />
        </Field>
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? "Searching…" : "Find"}
        </PrimaryButton>
      </form>

      {results.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {results.map((asset) => (
            <li key={asset.assetId}>
              <button
                type="button"
                onClick={() => { props.onFound(asset); }}
                className="w-full rounded-xl border border-slate-200 bg-white p-3 text-left active:bg-slate-100"
              >
                <span className="block text-base font-medium text-slate-900">
                  {plateOf(asset) ?? asset.shortCode}
                </span>
                <span className="block text-sm text-slate-500">{asset.shortCode}</span>
                <span className="mt-1 block text-xs">
                  {asset.paymentStatus === "paid" ? (
                    <span className="rounded bg-emerald-50 px-2 py-0.5 text-emerald-800">
                      Paid today
                    </span>
                  ) : (
                    <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-900">
                      No payment recorded today
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Banner tone="info">
        Scan the sticker QR from the dashboard for now; QR scanning arrives with the camera flow.
      </Banner>
    </Screen>
  );
}

export function plateOf(asset: {
  readonly attributes: Readonly<Record<string, unknown>>;
}): string | undefined {
  const plate = asset.attributes["plate_number"] ?? asset.attributes["plateNumber"];
  return typeof plate === "string" && plate.trim() !== "" ? plate : undefined;
}
