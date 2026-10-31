import { useCallback, useEffect, useState, type ReactElement } from "react";
import { copy } from "../copy.js";
import { Banner, Card, Screen } from "../components/ui.js";
import { listScanLog } from "../offline/store.js";
import type { ScanLogEntry } from "../offline/store.js";

/**
 * The officer's own record of the shift: what they scanned, what the phone said,
 * what the ledger said, and which scans have not uploaded.
 *
 * This screen exists because of the two ways an officer can be misled by their
 * own device — a cache that is out of date, and a queue that never drained. Both
 * are visible here rather than inferred from a spinner.
 */
export function ScanLogScreen(props: Readonly<{ onBack: () => void }>): ReactElement {
  const [entries, setEntries] = useState<readonly ScanLogEntry[] | undefined>(undefined);

  const load = useCallback(async (): Promise<void> => {
    setEntries(await listScanLog());
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, 10_000);
    return () => {
      clearInterval(timer);
    };
  }, [load]);

  const pending = entries?.filter((entry) => entry.recorded === "queued").length ?? 0;
  const failed = entries?.filter((entry) => entry.recorded === "failed").length ?? 0;

  return (
    <Screen title={copy.log.title} onBack={props.onBack}>
      {entries === undefined ? (
        <p className="text-base text-slate-600">{copy.log.loading}</p>
      ) : entries.length === 0 ? (
        <Banner tone="info">{copy.log.empty}</Banner>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 text-center">
            <Count label={copy.log.count} value={entries.length} />
            <Count label={copy.log.pending} value={pending} />
            <Count label={copy.log.failed} value={failed} />
          </div>

          <ul className="flex flex-col gap-2">
            {entries.map((entry) => (
              <li key={entry.id}>
                <Card>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-lg font-semibold text-slate-900">
                        {entry.shortCode ?? entry.reference ?? copy.result.unknownReference}
                      </p>
                      <p className="text-sm text-slate-600">{timeOf(entry.scannedAt)}</p>
                    </div>
                    <Badge recorded={entry.recorded} />
                  </div>
                  <p className="mt-2 text-base text-slate-800">{describeVerdict(entry.verdict)}</p>
                  {entry.observed !== undefined && entry.observed !== entry.verdict ? (
                    <p className="mt-1 text-sm text-slate-600">
                      {copy.log.cacheSaid.replace("{status}", describeVerdict(entry.observed))}
                    </p>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
    </Screen>
  );
}

function Count(props: Readonly<{ label: string; value: number }>): ReactElement {
  return (
    <div className="rounded-xl bg-white p-3">
      <p className="text-2xl font-bold text-slate-900">{props.value}</p>
      <p className="text-xs text-slate-600">{props.label}</p>
    </div>
  );
}

function Badge(props: Readonly<{ recorded: ScanLogEntry["recorded"] }>): ReactElement {
  const style = {
    server: "bg-emerald-100 text-emerald-900",
    queued: "bg-amber-100 text-amber-950",
    failed: "bg-red-100 text-red-950",
  } as const;
  const label = {
    server: copy.log.synced,
    queued: copy.log.queued,
    failed: copy.log.rejected,
  } as const;
  return (
    <span className={`rounded-lg px-2 py-1 text-sm font-semibold ${style[props.recorded]}`}>
      {label[props.recorded]}
    </span>
  );
}

/**
 * One vocabulary for every status this app can show, so the log cannot drift into
 * saying "unpaid" about a vehicle the cache simply did not know.
 */
function describeVerdict(verdict: string): string {
  switch (verdict) {
    case "paid":
      return copy.log.verdictPaid;
    case "no_payment_recorded":
      return copy.log.verdictNoPayment;
    case "not_in_offline_list":
      return copy.log.verdictNotInList;
    case "unreadable":
      return copy.log.verdictUnreadable;
    default:
      return copy.log.verdictUnknown;
  }
}

function timeOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
