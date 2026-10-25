import { openDB } from "idb";
import type { DBSchema, IDBPDatabase } from "idb";

export interface PaidSetEntry {
  qrPayload: string;
  assetId: string;
  shortCode: string;
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
    value: PaidSetEntry;
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

let dbPromise: Promise<IDBPDatabase<FieldDB>> | undefined;

export function getDb() {
  if (dbPromise === undefined) {
    dbPromise = openDB<FieldDB>("tpirs-field", 1, {
      upgrade(db) {
        const paidSet = db.createObjectStore("paidSet", { keyPath: "qrPayload" });
        paidSet.createIndex("shortCode", "shortCode");
        db.createObjectStore("assetCache", { keyPath: "assetId" });
        db.createObjectStore("outbox", { keyPath: "id" });
        db.createObjectStore("syncState", { keyPath: "id" });
        db.createObjectStore("fieldSession", { keyPath: "id" });
      },
    });
  }
  return dbPromise;
}

export async function clearPaidSetForRollover() {
  const db = await getDb();
  await db.clear("paidSet");
}
