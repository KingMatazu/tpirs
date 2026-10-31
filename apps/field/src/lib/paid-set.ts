/**
 * The paid-set feed, as the app sees it.
 *
 * The server sends one row per obligation period for the current business date,
 * including rows that are *not* paid: a reversal or a withdrawn waiver arrives as
 * `paid: false`, and the app must remove that asset from its cache. Treating
 * presence in the feed as payment would be exactly the false accusation the
 * offline rule forbids.
 */
export interface PaidSetEntry {
  readonly assetId: string;
  readonly qrPayload: string;
  readonly shortCode: string;
  readonly assetTypeKey: string;
  readonly attributes: Record<string, unknown>;
  readonly paid: boolean;
  readonly changedAt: string;
}

export interface PaidSetDelta {
  readonly mode: "snapshot" | "delta";
  readonly businessDate: string;
  readonly entries: readonly PaidSetEntry[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly serverTime: string;
}

/** True when the cache was filled on a different business day. */
export function isRollover(
  cachedBusinessDate: string | undefined,
  serverBusinessDate: string,
): boolean {
  return cachedBusinessDate !== undefined && cachedBusinessDate !== serverBusinessDate;
}

export function paidEntries(delta: PaidSetDelta): readonly PaidSetEntry[] {
  return delta.entries.filter((entry) => entry.paid);
}

/** Entries that must leave the cache: a reversal, or a waiver that was withdrawn. */
export function unpaidEntries(delta: PaidSetDelta): readonly PaidSetEntry[] {
  return delta.entries.filter((entry) => !entry.paid);
}

/**
 * A cache older than the tenant's grace window is announced as stale. It is
 * never silently trusted and never silently discarded: an officer working a dead
 * zone needs to know the list is old, and a scan against it still must not
 * accuse anyone.
 */
export function isStale(
  lastSyncedAt: string | undefined,
  graceHours: number,
  now: Date = new Date(),
): boolean {
  if (lastSyncedAt === undefined) return true;
  const synced = new Date(lastSyncedAt);
  if (Number.isNaN(synced.getTime())) return true;
  return now.getTime() - synced.getTime() > graceHours * 60 * 60 * 1000;
}

/**
 * What an officer types or says: `b 1234`, `B-1234`, `b1234` are the same short
 * code. Plates and short codes are compared case-insensitively with spaces,
 * hyphens and dots removed, because that is how they are read off a sticker.
 */
export function normaliseReference(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s\-.]/g, "");
}
