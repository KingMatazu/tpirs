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
}

export interface SyncState {
  id: string;
  businessDate?: string;
  cursor?: string;
  lastSyncedAt?: string;
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
}

const SYNC_STATE_ID = "paid";

let dbPromise: Promise<IDBPDatabase<FieldDB>> | undefined;

export function getDb() {
  dbPromise ??= openDB<FieldDB>("tpirs-field", 1, {
    upgrade(db) {
      const paidSet = db.createObjectStore("paidSet", { keyPath: "qrPayload" });
      paidSet.createIndex("shortCode", "shortCode");
      db.createObjectStore("assetCache", { keyPath: "assetId" });
      db.createObjectStore("outbox", { keyPath: "id" });
      db.createObjectStore("syncState", { keyPath: "id" });
      db.createObjectStore("fieldSession", { keyPath: "id" });
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
