import { useCallback, useEffect, useState, type ReactElement } from "react";
import { formatBusinessDate } from "@tpirs/ui-tokens";
import { useSession } from "../session.js";
import { copy } from "../copy.js";
import { Banner, Card, PrimaryButton, Screen, SecondaryButton } from "../components/ui.js";
import { countPaid, readSyncState } from "../offline/store.js";
import type { SyncState } from "../offline/store.js";
import { isStale } from "../lib/paid-set.js";
import { syncPaidSet } from "../offline/sync.js";
import type { SyncOutcome } from "../offline/sync.js";

/**
 * The officer's start screen: who they are, whether the phone has today's list,
 * and the one action that matters.
 *
 * The sync line is not decoration. An officer who scans against a day-old list
 * is being lied to by their own phone, so the age of the cache is always visible
 * and a stale one is called out.
 */
export function HomeScreen(props: Readonly<{ onScan: () => void }>): ReactElement {
  const user = useSession((state) => state.user);
  const config = useSession((state) => state.config);

  const [sync, setSync] = useState<SyncState | undefined>(undefined);
  const [paidCount, setPaidCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [outcome, setOutcome] = useState<SyncOutcome | undefined>(undefined);

  const refresh = useCallback(async (): Promise<void> => {
    setSync(await readSyncState());
    setPaidCount(await countPaid());
  }, []);

  const runSync = useCallback(async (): Promise<void> => {
    setSyncing(true);
    try {
      setOutcome(await syncPaidSet());
      await refresh();
    } finally {
      setSyncing(false);
    }
  }, [refresh]);

  useEffect(() => {
    void refresh();
    // The first sync of a shift happens on its own; the officer can still press
    // the button, and a failure is reported rather than retried in a loop.
    void runSync();
  }, [refresh, runSync]);

  const graceHours = config?.field.offlineGraceHours ?? 8;
  const stale = isStale(sync?.lastSyncedAt, graceHours);
  const now = new Date();
  const today =
    config === undefined
      ? undefined
      : formatBusinessDate(now, config.locale.numberFormat, "yyyy-MM-dd");

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

      {outcome?.complete === false ? <Banner tone="warning">{describeStop(outcome)}</Banner> : null}

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
        </dl>
      </Card>

      <PrimaryButton onClick={props.onScan}>{copy.home.scan}</PrimaryButton>
      <p className="-mt-1 text-center text-sm text-slate-600">{copy.home.scanHint}</p>

      <SecondaryButton
        disabled={syncing}
        onClick={() => {
          void runSync();
        }}
      >
        {syncing ? copy.home.syncing : copy.home.sync}
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
