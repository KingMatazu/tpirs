import { api } from "../api/client.js";
import { isRollover } from "../lib/paid-set.js";
import type { PaidSetDelta } from "../lib/paid-set.js";
import {
  applyPaidSetEntries,
  clearPaidSetForRollover,
  countPaid,
  readSyncState,
  saveSyncState,
} from "./store.js";

/** Why a sync stopped before the feed was exhausted. */
export type SyncStopReason = "offline" | "rate_limited" | "offline_disabled" | "error";

export type PageResult =
  | { readonly ok: true; readonly delta: PaidSetDelta }
  | { readonly ok: false; readonly reason: SyncStopReason };

/** Injected in tests; the app uses the API client. */
export type FetchPage = (since: string | undefined) => Promise<PageResult>;

export interface SyncOutcome {
  readonly businessDate: string | undefined;
  readonly syncedAt: string | undefined;
  readonly added: number;
  readonly removed: number;
  readonly pages: number;
  /** False when the feed was not exhausted (a 429, a dead zone, a page cap). */
  readonly complete: boolean;
  readonly stopReason: SyncStopReason | undefined;
  readonly paidCount: number;
}

/**
 * A page is 500 rows and the route allows 20 requests a minute, so 40 pages is
 * 20,000 assets — more than any single state's daily fleet. The cap exists so a
 * server that keeps saying `hasMore` cannot spin a phone forever.
 */
export const MAX_PAGES = 40;

export const fetchPageFromApi: FetchPage = async (since) => {
  try {
    const result = await api.GET("/v1/sync/paid", {
      params: { query: since === undefined ? {} : { since } },
    });
    if (result.response.status === 429) return { ok: false, reason: "rate_limited" };
    if (result.response.status === 403) return { ok: false, reason: "offline_disabled" };
    if (!result.response.ok) return { ok: false, reason: "error" };
    const delta = result.data as unknown as PaidSetDelta | undefined;
    if (delta === undefined) return { ok: false, reason: "error" };
    return { ok: true, delta };
  } catch {
    // A dead zone surfaces as a rejected fetch, not a status code.
    return { ok: false, reason: "offline" };
  }
};

/**
 * Brings the cached paid set up to date for the current business date.
 *
 * Snapshot vs delta is decided by the server: the first sync of the day (no
 * cursor) returns a snapshot, and later syncs follow the cursor. The cache is
 * cleared when the business date changes, because yesterday's payments say
 * nothing about today.
 *
 * The cursor is saved after each page, so a phone that dies mid-sync resumes
 * instead of starting over.
 */
export async function syncPaidSet(
  options: { readonly fetchPage?: FetchPage } = {},
): Promise<SyncOutcome> {
  const fetchPage = options.fetchPage ?? fetchPageFromApi;
  const state = await readSyncState();

  let businessDate = state?.businessDate;
  let syncedAt = state?.lastSyncedAt;
  let since = state?.cursor;
  let added = 0;
  let removed = 0;
  let pages = 0;
  let complete = false;
  let stopReason: SyncStopReason | undefined;

  for (;;) {
    if (pages >= MAX_PAGES) {
      stopReason = "error";
      break;
    }
    let page: PageResult;
    try {
      page = await fetchPage(since);
    } catch {
      // A rejected fetch is a dead zone, not a bug to surface to an officer.
      stopReason = "offline";
      break;
    }
    if (!page.ok) {
      stopReason = page.reason;
      break;
    }
    const delta = page.delta;

    // A snapshot is authoritative for the whole day; a date change means the
    // cached rows belong to a day that is over. Only the first page can be a
    // snapshot, so a later page never wipes what earlier pages just wrote.
    if (
      pages === 0 &&
      (delta.mode === "snapshot" || isRollover(businessDate, delta.businessDate))
    ) {
      await clearPaidSetForRollover();
      since = undefined;
    }

    const applied = await applyPaidSetEntries(delta.businessDate, delta.entries);
    added += applied.added;
    removed += applied.removed;
    businessDate = delta.businessDate;
    syncedAt = delta.serverTime;
    pages += 1;

    // Saved even on the last page: the next sync can then ask for a delta
    // instead of downloading the day again.
    await saveSyncState({
      businessDate: delta.businessDate,
      cursor: delta.nextCursor ?? since,
      lastSyncedAt: delta.serverTime,
    });

    if (!delta.hasMore) {
      complete = true;
      break;
    }
    since = delta.nextCursor ?? since;
    if (since === undefined) {
      // `hasMore` with no cursor would loop on the same page forever.
      stopReason = "error";
      break;
    }
  }

  return {
    businessDate,
    syncedAt,
    added,
    removed,
    pages,
    complete,
    stopReason,
    paidCount: await countPaid(),
  };
}
