import { createHash } from "node:crypto";
import { PortError } from "@tpirs/ports";
import type { ObjectContent, ObjectStorage, PutObjectRequest, StoredObject } from "@tpirs/ports";

interface StoredEntry {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly etag: string;
}

export interface MockObjectStorage extends ObjectStorage {
  /** Keys currently stored (test inspection). */
  keys(): readonly string[];
}

export function createMockObjectStorage(prefix = "mock-bucket"): MockObjectStorage {
  const store = new Map<string, StoredEntry>();

  return {
    put(request: PutObjectRequest): Promise<StoredObject> {
      const body =
        typeof request.body === "string" ? new TextEncoder().encode(request.body) : request.body;
      const etag = createHash("md5").update(body).digest("hex");
      store.set(request.key, { body, contentType: request.contentType, etag });
      return Promise.resolve({ key: request.key, size: body.byteLength, etag });
    },
    get(key): Promise<ObjectContent> {
      const entry = store.get(key);
      if (entry === undefined) {
        return Promise.reject(
          new PortError("ObjectStorage", "not_found", `Object "${key}" does not exist`),
        );
      }
      return Promise.resolve({ body: entry.body, contentType: entry.contentType });
    },
    delete(key) {
      store.delete(key);
      return Promise.resolve();
    },
    presignGet(key, ttlSeconds) {
      return Promise.resolve(`mock-storage://${prefix}/${key}?ttl=${String(ttlSeconds)}`);
    },
    keys() {
      return [...store.keys()];
    },
  };
}
