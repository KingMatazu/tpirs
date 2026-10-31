import { useCallback, useEffect, useState, type ReactElement } from "react";
import { copy } from "../copy.js";
import { Banner, Card, PrimaryButton, Screen, SecondaryButton } from "../components/ui.js";
import { useSession } from "../session.js";
import { countOutbox, countPaid, listFailedOutbox, readSyncState } from "../offline/store.js";
import type { SyncState } from "../offline/store.js";
import { syncPaidSet } from "../offline/sync.js";
import { flushOutbox } from "../offline/flush.js";
import { isStale } from "../lib/paid-set.js";

/**
 * What the phone is holding, in one place: when the paid list was last fetched,
 * how big it is, what has not uploaded, and the version — so a support call can
 * start with "read me the numbers on the settings screen" instead of a guess.
 */
export function SettingsScreen(props: Readonly<{ onBack: () => void }>): ReactElement {
  const config = useSession((state) => state.config);
  const [sync, setSync] = useState<SyncState | undefined>(undefined);
  const [paidCount, setPaidCount] = useState(0);
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);

  const refresh = useCallback(async (): Promise<void> => {
    setSync(await readSyncState());
    setPaidCount(await countPaid());
    setPending(await countOutbox());
    setFailed((await listFailedOutbox()).length);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (): Promise<void> => {
    setBusy(true);
    setMessage(undefined);
    try {
      const syncOutcome = await syncPaidSet();
      const flushOutcome = await flushOutbox({ refresh: () => useSession.getState().refresh() });
      await refresh();
      setMessage(
        syncOutcome.complete && flushOutcome.sent > 0
          ? copy.settings.synced.replace("{count}", String(flushOutcome.sent))
          : syncOutcome.complete
            ? copy.settings.syncedNothing
            : copy.settings.syncIncomplete,
      );
    } finally {
      setBusy(false);
    }
  };

  const graceHours = config?.field.offlineGraceHours ?? 8;
  const stale = isStale(sync?.lastSyncedAt, graceHours);

  return (
    <Screen title={copy.settings.title} onBack={props.onBack}>
      {stale ? <Banner tone="warning">{copy.settings.staleList}</Banner> : null}
      {message === undefined ? null : <Banner tone="info">{message}</Banner>}

      <Card>
        <dl className="grid grid-cols-2 gap-2 text-base">
          <Row label={copy.settings.businessDate} value={sync?.businessDate ?? "—"} />
          <Row
            label={copy.settings.lastSync}
            value={
              sync?.lastSyncedAt === undefined ? copy.home.syncNever : timeOf(sync.lastSyncedAt)
            }
          />
          <Row label={copy.settings.paidList} value={String(paidCount)} />
          <Row label={copy.settings.waiting} value={String(pending)} />
          <Row label={copy.settings.failed} value={String(failed)} />
          <Row label={copy.settings.state} value={config?.identity.name ?? "—"} />
        </dl>
      </Card>

      <PrimaryButton disabled={busy} onClick={() => void run()}>
        {busy ? copy.home.syncing : copy.home.sync}
      </PrimaryButton>

      <SecondaryButton
        onClick={() => {
          void useSession.getState().logout();
        }}
      >
        {copy.app.signOut}
      </SecondaryButton>

      <p className="mt-2 text-center text-sm text-slate-600">{copy.settings.version}</p>
    </Screen>
  );
}

function Row(props: Readonly<{ label: string; value: string }>): ReactElement {
  return (
    <>
      <dt className="text-slate-600">{props.label}</dt>
      <dd className="text-right font-medium text-slate-900">{props.value}</dd>
    </>
  );
}

function timeOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString([], {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "short",
  });
}
