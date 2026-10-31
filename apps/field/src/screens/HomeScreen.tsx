import { useCallback, useEffect, useState, type ReactElement } from "react";
import { formatBusinessDate } from "@tpirs/ui-tokens";
import { useSession } from "../session.js";
import { copy } from "../copy.js";
import { Banner, Card, PrimaryButton, Screen, SecondaryButton } from "../components/ui.js";
import {
  countPaid,
  countPendingOutbox,
  listFailedOutbox,
  readSyncState,
} from "../offline/store.js";
import type { SyncState } from "../offline/store.js";
import { isStale } from "../lib/paid-set.js";
import { syncPaidSet } from "../offline/sync.js";
import { flushOutbox } from "../offline/flush.js";
import type { FlushOutcome } from "../offline/flush.js";
import type { SyncOutcome } from "../offline/sync.js";

/** How often a mounted home screen tries to drain the queue. */
const FLUSH_INTERVAL_MS = 30_000;

/**
 * The officer's start screen: who they are, whether the phone has today's list,
 * and what is still waiting to leave it.
 *
 * Two counters, two different meanings: the paid set is what the phone *knows*,
 * the outbox is what it has not *told* the server. An officer who scans against a
 * day-old list is being lied to by their own phone, and an officer whose scans
 * never leave the device is being lied to about their shift.
 */
export function HomeScreen(props: Readonly<{ onScan: () => void }>): ReactElement {
  const user = useSession((state) => state.user);
  const config = useSession((state) => state.config);

  const [sync, setSync] = useState<SyncState | undefined>(undefined);
  const [paidCount, setPaidCount] = useState(0);
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [syncOutcome, setSyncOutcome] = useState<SyncOutcome | undefined>(undefined);
  const [flushOutcome, setFlushOutcome] = useState<FlushOutcome | undefined>(undefined);

  const refreshCounts = useCallback(async (): Promise<void> => {
    setSync(await readSyncState());
    setPaidCount(await countPaid());
    setPending(await countPendingOutbox());
    setFailed((await listFailedOutbox()).length);
  }, []);

  const drain = useCallback(async (): Promise<void> => {
    const outcome = await flushOutbox({
      refresh: () => useSession.getState().refresh(),
    });
    setFlushOutcome(outcome);
    await refreshCounts();
  }, [refreshCounts]);

  const runSync = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      setSyncOutcome(await syncPaidSet());
      await drain();
    } finally {
      setBusy(false);
    }
  }, [drain]);

  useEffect(() => {
    void refreshCounts();
    void drain();
    void runSync();

    // The queue drains itself: when the radio comes back, and on a slow timer
    // while the screen is open. Both are cheap; a dead zone costs one failed
    // request per interval, and the backoff keeps even that rare.
    const onOnline = (): void => {
      void drain();
    };
    globalThis.addEventListener("online", onOnline);
    const timer = setInterval(() => {
      void drain();
    }, FLUSH_INTERVAL_MS);
    return () => {
      globalThis.removeEventListener("online", onOnline);
      clearInterval(timer);
    };
  }, [drain, refreshCounts, runSync]);

  const graceHours = config?.field.offlineGraceHours ?? 8;
  const stale = isStale(sync?.lastSyncedAt, graceHours);
  const today =
    config === undefined
      ? undefined
      : formatBusinessDate(new Date(), config.locale.numberFormat, "yyyy-MM-dd");

  return (
    <Screen
      title={config?.branding.appName ?? copy.app.title}
      footer={
        <SecondaryButton
          onClick={() => {
            void useSession.getState().logout();
          }}
        >
          {copy.app.signOut}
        </SecondaryButton>
      }
    >
      {stale ? (
        <Banner tone="warning">
          {sync?.lastSyncedAt === undefined
            ? copy.home.neverSynced
            : copy.home.staleList.replace("{hours}", String(graceHours))}
        </Banner>
      ) : null}

      {syncOutcome?.complete === false ? (
        <Banner tone="warning">{describeStop(syncOutcome)}</Banner>
      ) : null}

      {flushOutcome?.stopReason === "auth" ? (
        <Banner tone="warning">{copy.home.flushAuth}</Banner>
      ) : null}

      {failed > 0 ? (
        <Banner tone="warning">{copy.home.flushFailed.replace("{count}", String(failed))}</Banner>
      ) : null}

      <Card>
        <p className="text-base text-slate-600">{copy.home.greeting}</p>
        <p className="text-xl font-semibold text-slate-900">{user?.displayName ?? "Officer"}</p>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-base">
          <dt className="text-slate-600">{copy.home.today}</dt>
          <dd className="text-right font-medium text-slate-900">
            {sync?.businessDate ?? today ?? "—"}
          </dd>
          <dt className="text-slate-600">{copy.home.paidList}</dt>
          <dd className="text-right font-medium text-slate-900">
            {String(paidCount)} {paidCount === 1 ? copy.home.vehicle : copy.home.vehicles}
          </dd>
          <dt className="text-slate-600">{copy.home.lastSync}</dt>
          <dd className="text-right font-medium text-slate-900">
            {sync?.lastSyncedAt === undefined ? copy.home.syncNever : timeOf(sync.lastSyncedAt)}
          </dd>
          <dt className="text-slate-600">{copy.home.waitingToSync}</dt>
          <dd className="text-right font-medium text-slate-900">{String(pending)}</dd>
        </dl>
      </Card>

      <PrimaryButton onClick={props.onScan}>{copy.home.scan}</PrimaryButton>
      <p className="-mt-1 text-center text-sm text-slate-600">{copy.home.scanHint}</p>

      <SecondaryButton
        disabled={busy}
        onClick={() => {
          void runSync();
        }}
      >
        {busy ? copy.home.syncing : copy.home.sync}
      </SecondaryButton>
    </Screen>
  );
}

function timeOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function describeStop(outcome: SyncOutcome): string {
  switch (outcome.stopReason) {
    case "rate_limited":
      return copy.home.syncRateLimited;
    case "offline_disabled":
      return copy.home.syncDisabled;
    case "offline":
      return copy.home.syncOffline;
    default:
      return copy.home.syncFailed;
  }
}
