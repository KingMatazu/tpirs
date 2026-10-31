import { openDB } from "idb";
import type { DBSchema, IDBPDatabase } from "idb";
import { normaliseReference } from "../lib/paid-set.js";
import type { PaidSetEntry } from "../lib/paid-set.js";

export interface PaidSetRecord {
  qrPayload: string;
  assetId: string;
  shortCode: string;
  assetTypeKey: string;
  attributes: Record<string, unknown>;
  paid: boolean;
  businessDate: string;
  changedAt: string;
}

export interface AssetCacheEntry {
  assetId: string;
  shortCode: string;
  attributes: Record<string, unknown>;
  photoDataUrl?: string;
  cachedAt: string;
}

export interface OutboxItem {
  id: string;
  kind: "scan" | "dispute";
  payload: unknown;
  createdAt: string;
  attempts: number;
  nextAttemptAt: string;
  /** Absent means pending; `failed` means the server refused it for good. */
  state?: "pending" | "failed";
  lastError?: string;
}

export interface SyncState {
  id: string;
  businessDate?: string;
  cursor?: string;
  lastSyncedAt?: string;
}

/**
 * One scan the officer took, as this phone remembers it.
 *
 * The outbox only holds work that has not uploaded; the log holds everything the
 * officer did today, including what the server confirmed, so the scan list can
 * show pending, synced and failed side by side. `observed` is what the cache said
 * before the upload and `verdict` is what the ledger said after — keeping both is
 * how a correction stays visible instead of silently overwriting the past.
 */
export interface ScanLogEntry {
  id: string;
  scannedAt: string;
  businessDate?: string;
  shortCode?: string;
  reference?: string;
  observed?: string;
  verdict: string;
  recorded: "server" | "queued" | "failed";
  updatedAt: string;
}

export interface FieldSession {
  id: string;
  lastLoginAt?: string;
  principal?: unknown;
  deviceId?: string;
}

interface FieldDB extends DBSchema {
  paidSet: {
    key: string;
    value: PaidSetRecord;
    indexes: { shortCode: string };
  };
  assetCache: {
    key: string;
    value: AssetCacheEntry;
  };
  outbox: {
    key: string;
    value: OutboxItem;
  };
  syncState: {
    key: string;
    value: SyncState;
  };
  fieldSession: {
    key: string;
    value: FieldSession;
  };
  scanLog: {
    key: string;
    value: ScanLogEntry;
  };
}

const SYNC_STATE_ID = "paid";

let dbPromise: Promise<IDBPDatabase<FieldDB>> | undefined;

export function getDb() {
  dbPromise ??= openDB<FieldDB>("tpirs-field", 2, {
    upgrade(db, oldVersion) {
      // Version 1 shipped first; a handset that already has it must not lose its
      // queued scans, so each version only adds what it introduced.
      if (oldVersion < 1) {
        const paidSet = db.createObjectStore("paidSet", { keyPath: "qrPayload" });
        paidSet.createIndex("shortCode", "shortCode");
        db.createObjectStore("assetCache", { keyPath: "assetId" });
        db.createObjectStore("outbox", { keyPath: "id" });
        db.createObjectStore("syncState", { keyPath: "id" });
        db.createObjectStore("fieldSession", { keyPath: "id" });
      }
      if (oldVersion < 2) {
        db.createObjectStore("scanLog", { keyPath: "id" });
      }
    },
  });
  return dbPromise;
}

/**
 * Empties the paid set. Called when the business date changes: yesterday's
 * payments say nothing about today, and keeping them would let a stale entry
 * confirm a payment that does not exist.
 */
export async function clearPaidSetForRollover(): Promise<void> {
  const db = await getDb();
  await db.clear("paidSet");
}

/**
 * Applies a page of the feed in one transaction: paid entries are stored, unpaid
 * ones are removed. A crash mid-page leaves either all of it or none of it, and
 * the cursor is only saved after this resolves, so a replay is idempotent.
 */
export async function applyPaidSetEntries(
  businessDate: string,
  entries: readonly PaidSetEntry[],
): Promise<{ readonly added: number; readonly removed: number }> {
  const db = await getDb();
  const tx = db.transaction("paidSet", "readwrite");
  let added = 0;
  let removed = 0;
  for (const entry of entries) {
    if (entry.paid) {
      const record: PaidSetRecord = {
        qrPayload: entry.qrPayload,
        assetId: entry.assetId,
        shortCode: entry.shortCode,
        assetTypeKey: entry.assetTypeKey,
        attributes: entry.attributes,
        paid: true,
        businessDate,
        changedAt: entry.changedAt,
      };
      await tx.store.put(record);
      added += 1;
    } else {
      await tx.store.delete(entry.qrPayload);
      removed += 1;
    }
  }
  await tx.done;
  return { added, removed };
}

export async function readSyncState(): Promise<SyncState | undefined> {
  const db = await getDb();
  return db.get("syncState", SYNC_STATE_ID);
}

export async function saveSyncState(state: {
  businessDate: string;
  cursor: string | undefined;
  lastSyncedAt: string;
}): Promise<void> {
  const db = await getDb();
  await db.put("syncState", {
    id: SYNC_STATE_ID,
    businessDate: state.businessDate,
    ...(state.cursor === undefined ? {} : { cursor: state.cursor }),
    lastSyncedAt: state.lastSyncedAt,
  });
}

export async function countPaid(): Promise<number> {
  const db = await getDb();
  return db.count("paidSet");
}

export async function allPaidPayloads(): Promise<Set<string>> {
  const db = await getDb();
  const keys = await db.getAllKeys("paidSet");
  return new Set(keys);
}

export async function findPaidByPayload(payload: string): Promise<PaidSetRecord | undefined> {
  const db = await getDb();
  return db.get("paidSet", payload);
}

/**
 * Manual entry: a short code or a plate. The paid set is small enough (one
 * business day) to scan for an attribute match on submit, which avoids
 * maintaining an index per tenant attribute schema.
 */
export async function findPaidByReference(reference: string): Promise<PaidSetRecord | undefined> {
  const wanted = normaliseReference(reference);
  if (wanted === "") return undefined;
  const db = await getDb();
  const byShortCode = await db.getFromIndex("paidSet", "shortCode", reference.trim());
  if (byShortCode !== undefined) return byShortCode;
  const all = await db.getAll("paidSet");
  return all.find((record) => {
    if (normaliseReference(record.shortCode) === wanted) return true;
    return Object.values(record.attributes).some(
      (value) => typeof value === "string" && normaliseReference(value) === wanted,
    );
  });
}

/**
 * Appends a scan or dispute to the outbox.
 *
 * The item id is the `clientScanId`, so re-queueing the same attempt after a
 * timeout overwrites rather than duplicates it. The cap comes from the tenant
 * (`field.maxQueueItems`): when the phone is full, the officer is told instead of
 * silently losing the scan.
 */
export async function enqueueOutbox(
  item: {
    readonly id: string;
    readonly kind: "scan" | "dispute";
    readonly payload: unknown;
    readonly createdAt: string;
  },
  maxItems: number | undefined,
): Promise<"queued" | "full"> {
  const db = await getDb();
  const existing = await db.get("outbox", item.id);
  if (existing !== undefined) return "queued";
  if (maxItems !== undefined) {
    const count = await db.count("outbox");
    if (count >= maxItems) return "full";
  }
  await db.put("outbox", {
    id: item.id,
    kind: item.kind,
    payload: item.payload,
    createdAt: item.createdAt,
    attempts: 0,
    nextAttemptAt: item.createdAt,
  });
  return "queued";
}

export async function countOutbox(): Promise<number> {
  const db = await getDb();
  return db.count("outbox");
}

export async function listOutbox(): Promise<OutboxItem[]> {
  const db = await getDb();
  const items = await db.getAll("outbox");
  return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** Replaces an item in place (attempt count, backoff, or a terminal failure). */
export async function updateOutboxItem(item: OutboxItem): Promise<void> {
  const db = await getDb();
  await db.put("outbox", item);
}

export async function removeOutbox(id: string): Promise<void> {
  const db = await getDb();
  await db.delete("outbox", id);
}

/** Items still waiting to upload; a failed item is not waiting, it needs a person. */
export async function countPendingOutbox(): Promise<number> {
  const db = await getDb();
  const items = await db.getAll("outbox");
  return items.filter((item) => item.state !== "failed").length;
}

export async function listFailedOutbox(): Promise<OutboxItem[]> {
  const db = await getDb();
  const items = await db.getAll("outbox");
  return items.filter((item) => item.state === "failed");
}

/**
 * Records a scan in the day's log. Called once per attempt, whatever the outcome:
 * a scan the server refused is exactly the one an officer needs to be able to
 * find again.
 */
export async function appendScanLog(entry: ScanLogEntry): Promise<void> {
  const db = await getDb();
  await db.put("scanLog", entry);
}

export async function updateScanLog(
  id: string,
  patch: Partial<Omit<ScanLogEntry, "id">>,
): Promise<void> {
  const db = await getDb();
  const existing = await db.get("scanLog", id);
  if (existing === undefined) return;
  await db.put("scanLog", { ...existing, ...patch });
}

/** Today's scans, newest first. */
export async function listScanLog(limit = 100): Promise<ScanLogEntry[]> {
  const db = await getDb();
  const entries = await db.getAll("scanLog");
  return entries
    .sort((left, right) => right.scannedAt.localeCompare(left.scannedAt))
    .slice(0, limit);
}

/** Drops entries from before the given business date; the log is a day's work, not an archive. */
export async function pruneScanLog(beforeBusinessDate: string): Promise<void> {
  const db = await getDb();
  const entries = await db.getAll("scanLog");
  const tx = db.transaction("scanLog", "readwrite");
  for (const entry of entries) {
    if (entry.businessDate !== undefined && entry.businessDate < beforeBusinessDate) {
      await tx.store.delete(entry.id);
    }
  }
  await tx.done;
}
